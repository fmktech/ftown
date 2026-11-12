import type { ProcessRunner } from './claude-runner.js';
import type { SessionStore } from './session-store.js';
import type { TerminalManager } from './terminal-manager.js';
import type { Session, SessionUsage } from './types.js';

export type SyntheticStopReason = 'complete' | 'error' | 'stopped';

export interface TerminalPumpDeps {
  store: Pick<SessionStore, 'appendTerminalData' | 'loadSession' | 'saveSession' | 'loadTerminalLog'>;
  terminalManager: Pick<TerminalManager, 'write' | 'destroy'>;
  publishTerminalData: (sessionId: string, data: string) => void;
  publishSessionUpdate: (session: Session) => Promise<void>;
  publishHookEvent: (sessionId: string, event: Record<string, unknown>) => Promise<void>;
  unregisterSession: (sessionId: string) => void;
  /**
   * Optional (injectable for tests): extract token/cost usage from the
   * session's harness-native transcript. Fired-and-forgotten after the
   * terminal status persist on complete/error; a null result never clobbers
   * previously persisted usage.
   */
  collectUsage?: (session: Session) => Promise<SessionUsage | null>;
  /**
   * Whether anyone is receiving this session's live output right now (a direct
   * peer or an unexpired remote watcher). Unwatched sessions coalesce output in
   * a longer window. Whoever makes a session watched must call `flush` before
   * producing the attach snapshot. Defaults to "always watched".
   */
  isWatched?: (sessionId: string) => boolean;
  /** Test seams; production uses the defaults. */
  flushIntervalMs?: number;
  maxBufferBytes?: number;
  unwatchedFlushIntervalMs?: number;
  unwatchedMaxBufferBytes?: number;
}

const FLUSH_INTERVAL_MS = 16;
const MAX_BUFFER_BYTES = 32_000;
const UNWATCHED_FLUSH_INTERVAL_MS = 250;
const UNWATCHED_MAX_BUFFER_BYTES = 256 * 1024;

/** Output of one session waiting for its next flush. */
interface PendingOutput {
  data: string;
  /** UTF-8 size of `data`. */
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  /** The armed timer is the long unwatched window. */
  unwatchedTimer: boolean;
}

/** Raw terminal chars considered for the errorReason tail (pre-sanitize). */
const ERROR_TAIL_RAW_CHARS = 1200;
/** Max sanitized tail chars kept in errorReason. */
const ERROR_TAIL_MAX_CHARS = 300;
/** Hard cap on the whole errorReason string. */
const ERROR_REASON_MAX_CHARS = 400;

// CSI (\x1b[...X), OSC (\x1b]...BEL/ST), and any leftover lone ESC sequences.
const ANSI_ESCAPE_RE = new RegExp(
  '\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?|\\x1b[@-_]?',
  'g',
);

/** Strip ANSI escapes and collapse all whitespace/control runs to single spaces. */
function sanitizeTerminalTail(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/[\s\u0000-\u001f\u007f]+/g, ' ')
    .trim();
}

/**
 * Terminal output pump: buffers runner PTY output per session (coalescing into
 * ≤16ms / ≤32KB flushes to the store + transports while the session is watched,
 * ≤250ms / ≤256KiB while nobody is), and owns the runner lifecycle handlers
 * ('complete'/'error') that persist final session statuses. The live emulator
 * (terminalManager) is fed immediately and never waits for a flush.
 */
export class TerminalPump {
  private readonly pending = new Map<string, PendingOutput>();
  private readonly pendingAppends = new Set<Promise<void>>();
  // Per-session write queue so concurrent load/modify/save flows (hooks,
  // runner exit handlers, stop_session) cannot interleave and resurrect a
  // stale status.
  private readonly sessionWrites = new Map<string, Promise<void>>();
  private readonly pendingAsync = new Set<Promise<unknown>>();
  private track<T>(work: Promise<T>): Promise<T> {
    this.pendingAsync.add(work);
    void work.then(() => this.pendingAsync.delete(work), () => this.pendingAsync.delete(work));
    return work;
  }
  isIdle(): boolean {
    return this.pending.size === 0 && this.sessionWrites.size === 0 && this.pendingAsync.size === 0;
  }
  private readonly flushIntervalMs: number;
  private readonly maxBufferBytes: number;
  private readonly unwatchedFlushIntervalMs: number;
  private readonly unwatchedMaxBufferBytes: number;

  constructor(private readonly deps: TerminalPumpDeps) {
    this.flushIntervalMs = deps.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.maxBufferBytes = deps.maxBufferBytes ?? MAX_BUFFER_BYTES;
    this.unwatchedFlushIntervalMs = deps.unwatchedFlushIntervalMs ?? UNWATCHED_FLUSH_INTERVAL_MS;
    this.unwatchedMaxBufferBytes = deps.unwatchedMaxBufferBytes ?? UNWATCHED_MAX_BUFFER_BYTES;
  }

  /** Wire the pump onto the runner's data/lifecycle events. */
  attach(runner: Pick<ProcessRunner, 'on'>): void {
    runner.on('data', (sessionId, data) => this.handleData(sessionId, data));
    runner.on('complete', (sessionId) => this.handleComplete(sessionId));
    runner.on('error', (sessionId, error) => this.handleError(sessionId, error));
  }

  handleData(sessionId: string, data: string): void {
    this.deps.terminalManager.write(sessionId, data);

    let pending = this.pending.get(sessionId);
    if (!pending) {
      pending = { data: '', bytes: 0, unwatchedTimer: false };
      this.pending.set(sessionId, pending);
    }
    pending.data += data;
    pending.bytes += Buffer.byteLength(data, 'utf-8');

    if (this.deps.isWatched?.(sessionId) ?? true) {
      // A buffer still riding the long window means a watcher appeared without
      // an explicit flush: deliver now instead of making it wait.
      if (pending.data.length >= this.maxBufferBytes || pending.unwatchedTimer) {
        this.flush(sessionId);
      } else if (!pending.timer) {
        pending.timer = setTimeout(() => this.flush(sessionId), this.flushIntervalMs);
      }
    } else if (pending.bytes > this.unwatchedMaxBufferBytes) {
      this.flush(sessionId);
    } else if (!pending.timer) {
      pending.timer = setTimeout(() => this.flush(sessionId), this.unwatchedFlushIntervalMs);
      pending.unwatchedTimer = true;
    }
  }

  /**
   * Hand a session's pending output to the store and the transports now. Must
   * run before anything reads state derived from flushed output: an attach
   * snapshot / screen dump for a new watcher (else the bytes arrive again after
   * the snapshot that already contains them), terminal.log readers, session
   * exit, and shutdown.
   */
  flush(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    this.pending.delete(sessionId);
    if (pending.timer) clearTimeout(pending.timer);
    const append = this.track(this.deps.store.appendTerminalData(sessionId, pending.data)).catch((err) => {
      console.error(`[Bridge] Failed to store terminal data for ${sessionId}:`, err);
    });
    this.pendingAppends.add(append);
    void append.then(() => this.pendingAppends.delete(append));
    this.deps.publishTerminalData(sessionId, pending.data);
  }

  /** Flush every session and wait until the store has taken all of it (shutdown). */
  async drain(): Promise<void> {
    for (const sessionId of [...this.pending.keys()]) this.flush(sessionId);
    while (this.pendingAppends.size > 0) {
      await Promise.all([...this.pendingAppends]);
    }
  }

  withSessionWrite(sessionId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.sessionWrites.get(sessionId) ?? Promise.resolve();
    const run = prev.then(task);
    const settled = run.catch(() => undefined);
    this.sessionWrites.set(sessionId, settled);
    void settled.finally(() => {
      if (this.sessionWrites.get(sessionId) === settled) {
        this.sessionWrites.delete(sessionId);
      }
    });
    return run;
  }

  // Synthetic activity reset: some stop paths never produce a real Stop/stop
  // hook (Claude's Stop hook doesn't fire on user interrupt, SessionEnd may be
  // absent, runner exits/crashes). Publishing a synthetic Stop event guarantees
  // every dashboard clears its "thinking"/"tool_use" indicator. Idle is
  // idempotent, so an extra synthetic Stop after a real one is harmless.
  publishSyntheticStop(sessionId: string, reason: SyntheticStopReason): void {
    this.deps.publishHookEvent(sessionId, {
      type: 'hook_event',
      eventName: 'Stop',
      data: { synthetic: true, reason },
    }).catch((err) => {
      console.error(`[Bridge] Failed to publish synthetic stop for ${sessionId}:`, err);
    });
  }

  /**
   * Fire-and-forget usage collection after a terminal status persist. Runs
   * OUTSIDE the caller's write (the collect can take seconds on huge
   * transcripts); the persist itself is serialized via withSessionWrite.
   * Guard: a null collection result never clobbers previously saved usage.
   */
  private collectAndPersistUsage(sessionId: string): void {
    const collect = this.deps.collectUsage;
    if (!collect) return;
    void this.track((async () => {
      const session = await this.deps.store.loadSession(sessionId);
      if (!session) return;
      const usage = await collect(session);
      if (!usage) return;
      await this.withSessionWrite(sessionId, async () => {
        const fresh = await this.deps.store.loadSession(sessionId);
        if (!fresh) return;
        fresh.usage = usage;
        fresh.updatedAt = new Date().toISOString();
        await this.deps.store.saveSession(fresh);
        await this.deps.publishSessionUpdate(fresh);
      });
    })()).catch((err) => {
      console.error(`[Bridge] Failed to collect usage for session ${sessionId}:`, err);
    });
  }

  private handleComplete(sessionId: string): void {
    this.flush(sessionId);
    this.publishSyntheticStop(sessionId, 'complete');
    void this.track(this.withSessionWrite(sessionId, async () => {
      const session = await this.deps.store.loadSession(sessionId);
      if (session) {
        session.status = 'completed';
        session.updatedAt = new Date().toISOString();
        await this.deps.store.saveSession(session);
        await this.deps.publishSessionUpdate(session);
      }
      console.log(`[Bridge] Session ${sessionId} completed`);
    }).catch((err) => {
      console.error(`[Bridge] Failed to handle completion for session ${sessionId}:`, err);
    }).finally(() => {
      this.collectAndPersistUsage(sessionId);
      this.deps.unregisterSession(sessionId);
    }));
  }

  /**
   * `<error message> — <recent terminal tail>` (ANSI-stripped, whitespace
   * collapsed, capped at ~400 chars) so a startup crash's cause is readable
   * straight off the session record. The tail comes from the flushed terminal
   * log; flush() fires its append without awaiting, so the chunk buffered at
   * error time is re-appended if it hasn't landed on disk yet.
   */
  private async buildErrorReason(
    sessionId: string,
    error: Error,
    pendingAtError: string,
  ): Promise<string> {
    let log = '';
    try {
      log = await this.deps.store.loadTerminalLog(sessionId);
    } catch {
      // Tail is best-effort — fall back to whatever was buffered at error time.
    }
    const source = pendingAtError && !log.endsWith(pendingAtError)
      ? log + pendingAtError
      : log;
    const tail = sanitizeTerminalTail(source.slice(-ERROR_TAIL_RAW_CHARS))
      .slice(-ERROR_TAIL_MAX_CHARS);
    const reason = tail ? `${error.message} — ${tail}` : error.message;
    return reason.slice(0, ERROR_REASON_MAX_CHARS);
  }

  private handleError(sessionId: string, error: Error): void {
    // Capture what's still buffered BEFORE flush drains it — the errorReason
    // tail needs it if the (unawaited) flush append hasn't hit the store yet.
    const pendingAtError = this.pending.get(sessionId)?.data ?? '';
    this.flush(sessionId);
    this.publishSyntheticStop(sessionId, 'error');
    void this.track(this.withSessionWrite(sessionId, async () => {
      const session = await this.deps.store.loadSession(sessionId);
      if (session) {
        session.status = 'error';
        session.errorReason = await this.buildErrorReason(sessionId, error, pendingAtError);
        session.updatedAt = new Date().toISOString();
        await this.deps.store.saveSession(session);
        await this.deps.publishSessionUpdate(session);
      }
      console.error(`[Bridge] Session ${sessionId} error:`, error.message);
    }).catch((err) => {
      console.error(`[Bridge] Failed to handle error for session ${sessionId}:`, err);
    }).finally(() => {
      this.collectAndPersistUsage(sessionId);
      this.deps.unregisterSession(sessionId);
      this.deps.terminalManager.destroy(sessionId);
    }));
  }
}
