import { appendFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TREE_EVENTS_COMPACT_AT, TREE_EVENTS_FILE, TREE_EVENTS_MAX_WAIT_MS, TREE_EVENTS_RETAIN,
  TREE_EVENT_KINDS, TREE_EVENT_SUMMARY_MAX,
  type TreeEvent, type TreeEventInput, type TreeEventKind, type TreeEventLogApi,
  type TreeEventLogDeps, type TreeEventPage,
} from './contract.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const SESSION_NAME_MAX = 200;
const REF_MAX = 500;
const READ_LIMIT_DEFAULT = 100;
const READ_LIMIT_MAX = 500;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Replaces control characters and whitespace with spaces, then collapses runs of spaces. */
function cleanLine(text: string): string {
  return (typeof text === 'string' ? text : '')
    .replace(/[\u0000-\u001f\u007f\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hard-truncates to `max` characters total, marking the cut with an ellipsis. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Accepts only lines that parse to a well-formed tree event; anything else (truncated tail included) is skipped. */
function parseEvent(line: string): TreeEvent | null {
  if (!line.trim()) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { seq, ts, sessionId, sessionName, kind, summary, ref } = record;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null;
  if (typeof ts !== 'string' || typeof sessionId !== 'string' || typeof sessionName !== 'string' || typeof summary !== 'string') return null;
  if (typeof kind !== 'string' || !(TREE_EVENT_KINDS as readonly string[]).includes(kind)) return null;
  if (ref !== undefined && typeof ref !== 'string') return null;
  return { seq, ts, sessionId, sessionName, kind: kind as TreeEventKind, summary, ...(ref !== undefined ? { ref } : {}) };
}

/** Per-root JSONL log of tree events (one JSON object per line, seq survives compaction). */
export class TreeEventLog implements TreeEventLogApi {
  private locks = new Map<string, Promise<unknown>>();
  /** Highest seq seen per root, cached after the first file read. */
  private heads = new Map<string, number>();
  /** Valid event lines per root, cached alongside the head to trigger compaction without recounting. */
  private counts = new Map<string, number>();
  /** Wake callbacks of long-poll waiters, keyed by root. */
  private waiters = new Map<string, Set<() => void>>();

  constructor(private deps: TreeEventLogDeps) {}

  private file(rootId: string): string {
    return join(this.deps.sessionDir(rootId), TREE_EVENTS_FILE);
  }

  private requireValidId(rootId: string): void {
    if (!ID_PATTERN.test(rootId)) throw new Error('Invalid session id');
  }

  private withLock<T>(rootId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(rootId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(rootId, settled);
    void settled.then(() => { if (this.locks.get(rootId) === settled) this.locks.delete(rootId); });
    return next;
  }

  /** Parses the log, keeping only well-formed events; a truncated/corrupt tail is tolerated. */
  private async events(rootId: string): Promise<TreeEvent[]> {
    let content: string;
    try { content = await readFile(this.file(rootId), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const events: TreeEvent[] = [];
    for (const line of content.split('\n')) {
      const event = parseEvent(line);
      if (event) events.push(event);
    }
    return events;
  }

  /** Cold-fills the head cache. Must run while holding the per-root lock, so it can never
   *  overwrite a newer head written by a concurrent append. */
  private async stateLocked(rootId: string): Promise<{ head: number; count: number }> {
    const cachedHead = this.heads.get(rootId);
    const cachedCount = this.counts.get(rootId);
    if (cachedHead !== undefined && cachedCount !== undefined) return { head: cachedHead, count: cachedCount };
    const events = await this.events(rootId);
    const head = events.reduce((max, event) => Math.max(max, event.seq), 0);
    this.heads.set(rootId, head);
    this.counts.set(rootId, events.length);
    return { head, count: events.length };
  }

  private cleaned(input: TreeEventInput): Omit<TreeEvent, 'seq' | 'ts'> {
    if (!ID_PATTERN.test(input.sessionId)) throw new Error('Invalid session id');
    if (typeof input.kind !== 'string' || !(TREE_EVENT_KINDS as readonly string[]).includes(input.kind)) {
      throw new Error('Invalid event kind');
    }
    const summary = truncate(cleanLine(input.summary), TREE_EVENT_SUMMARY_MAX);
    const sessionName = cleanLine(input.sessionName).slice(0, SESSION_NAME_MAX);
    const ref = input.ref === undefined ? undefined : cleanLine(input.ref);
    return { sessionId: input.sessionId, sessionName, kind: input.kind, summary, ...(ref ? { ref: ref.slice(0, REF_MAX) } : {}) };
  }

  async append(rootId: string, input: TreeEventInput): Promise<TreeEvent> {
    this.requireValidId(rootId);
    const fields = this.cleaned(input);
    const event: TreeEvent = { seq: 0, ts: new Date(this.deps.now()).toISOString(), ...fields };
    await this.withLock(rootId, async () => {
      const { head, count } = await this.stateLocked(rootId);
      event.seq = head + 1;
      const dir = this.deps.sessionDir(rootId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await appendFile(this.file(rootId), `${JSON.stringify(event)}\n`, { mode: 0o600 });
      this.heads.set(rootId, event.seq);
      this.counts.set(rootId, count + 1);
      if (count + 1 > TREE_EVENTS_COMPACT_AT) {
        // The event is already durable: a failed compaction must not fail the append.
        // The count stays above the threshold, so the next append retries compaction.
        await this.compact(rootId).catch((error: unknown) => {
          console.warn(`[Bridge] Tree event compaction failed for session ${rootId}:`, error);
        });
      }
    });
    for (const wake of Array.from(this.waiters.get(rootId) ?? [])) wake();
    return event;
  }

  /** Rewrites the log down to the newest TREE_EVENTS_RETAIN events via tmp file + rename. Seqs are preserved. */
  private async compact(rootId: string): Promise<void> {
    const retained = (await this.events(rootId)).sort((a, b) => a.seq - b.seq).slice(-TREE_EVENTS_RETAIN);
    const file = this.file(rootId);
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(retained.map((event) => JSON.stringify(event)).join('\n') + (retained.length ? '\n' : ''), 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.counts.set(rootId, retained.length);
  }

  async read(rootId: string, opts: { since?: number; limit?: number } = {}): Promise<TreeEventPage> {
    this.requireValidId(rootId);
    const since = clampInt(opts.since, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(opts.limit, READ_LIMIT_DEFAULT, 1, READ_LIMIT_MAX);
    const matching = (await this.events(rootId)).filter((event) => event.seq > since).sort((a, b) => a.seq - b.seq);
    const events = matching.slice(0, limit);
    return { events, cursor: events.length ? events[events.length - 1].seq : since };
  }

  async wait(rootId: string, since: number, timeoutMs: number, signal?: AbortSignal): Promise<TreeEventPage> {
    this.requireValidId(rootId);
    const start = clampInt(since, 0, 0, Number.MAX_SAFE_INTEGER);
    const ms = clampInt(timeoutMs, 0, 0, TREE_EVENTS_MAX_WAIT_MS);
    // The wake callback is registered and armed before the first read, so an append
    // committing while that read is in flight cannot be lost.
    let wake: (() => void) | undefined;
    const waiters = this.waiters.get(rootId) ?? new Set<() => void>();
    const waiter = () => wake?.();
    waiters.add(waiter);
    this.waiters.set(rootId, waiters);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { events: [], cursor: start, timedOut: true };
      const settled = new Promise<boolean>((resolve) => {
        wake = () => resolve(false);
        timer = setTimeout(() => resolve(true), ms);
        timer.unref?.();
        if (signal) {
          const onAbort = () => resolve(true);
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbort = () => signal.removeEventListener('abort', onAbort);
        }
      });
      const immediate = await this.read(rootId, { since: start });
      if (immediate.events.length) return immediate;
      const timedOut = await settled;
      if (timedOut) return { events: [], cursor: start, timedOut: true };
      // Woken by an append: return the page as of now (empty if the append was for an already-seen seq).
      return await this.read(rootId, { since: start });
    } finally {
      if (timer) clearTimeout(timer);
      removeAbort?.();
      waiters.delete(waiter);
      if (!waiters.size) this.waiters.delete(rootId);
    }
  }

  async head(rootId: string): Promise<number> {
    this.requireValidId(rootId);
    return this.withLock(rootId, async () => (await this.stateLocked(rootId)).head);
  }
}
