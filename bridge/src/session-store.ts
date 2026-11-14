import { readFile, writeFile, mkdir, readdir, appendFile, rm, truncate, stat, open, rename, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

import type { ArchivedSession, Session } from './types.js';
import { isSettledStamp, sameStamp, toFileStamp, type FileStamp } from './file-stamp.js';
import { normalizeShellType } from './harness-registry.js';

/**
 * Drop the legacy preview shape on load: version !== 2 or a preview without a
 * files array means both fields go, so a stale descriptor never reaches the
 * wire. No migration — an old preview is simply no preview.
 */
function dropLegacyPreviewShape(session: Session): void {
  const preview = session.preview as unknown as { files?: unknown } | undefined;
  const previewSource = session.previewSource as unknown as { version?: unknown; files?: unknown } | undefined;
  const legacy = (previewSource !== undefined && previewSource.version !== 2)
    || (preview !== undefined && !Array.isArray(preview.files))
    || (previewSource !== undefined && !Array.isArray(previewSource.files));
  if (legacy) {
    delete session.preview;
    delete session.previewSource;
  }
}

/**
 * A fresh Session parsed from cached session.json text, with the legacy
 * preview shape dropped. Every read path goes through here so the stat-validated
 * cache never serves a legacy preview.
 */
function parseSessionRecord(json: string): Session {
  const session = JSON.parse(json) as Session;
  dropLegacyPreviewShape(session);
  if (session.shellType !== undefined) {
    try {
      session.shellType = normalizeShellType(session.shellType);
    } catch {
      // Tolerate corrupt / unrecognized legacy shellType
    }
  }
  return session;
}

/**
 * Retained tail size for a session's terminal.log. A misbehaving child (e.g. a
 * TUI stuck in a runaway repaint loop) can otherwise stream unbounded output
 * and grow this file without limit — observed in the wild at 2.5 GB and still
 * climbing, which also makes the full-file `loadTerminalLog` read exceed V8's
 * max string length and throw. The on-disk file is only ever consumed as
 * "recent output" (download/search); the live screen is driven by a separate
 * in-memory emulator, so keeping just the tail is lossless for viewers.
 */
const DEFAULT_MAX_TERMINAL_LOG_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * session.json files stat'ed concurrently while listing. Each batch is awaited,
 * so a listing of any size yields to the event loop between batches instead of
 * holding it for the whole directory.
 */
const LIST_STAT_CONCURRENCY = 32;

/**
 * One indexed session.json: the stamp it was read under and its record as
 * compact JSON text. Text rather than a live object so every read hands out a
 * fresh, caller-owned copy (callers mutate and re-save what they load) that is
 * by construction identical to parsing the file again.
 */
interface IndexedRecord extends FileStamp {
  json: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** The file, or a directory on the way to it, is no longer there. */
function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export class SessionStore {
  private readonly sessionsDir: string;
  private readonly archivePath: string;
  private readonly writeLocks: Map<string, Promise<void>> = new Map();
  // Removal is final for this store's lifetime; explicit revival uses a new ID.
  private readonly retiredSessionIds = new Set<string>();
  private readonly maxTerminalLogBytes: number;
  // session.json index, keyed by session id. An entry is served only while a
  // fresh stat of the file still matches its stamp, and is stored only for a
  // file that was already quiet when it was read (see file-stamp.ts), so it can
  // never be stale.
  private readonly recordIndex = new Map<string, IndexedRecord>();
  // Sessions whose directory this process has already created.
  private readonly terminalDirsReady = new Set<string>();
  // terminal.log size in bytes, tracked after one initial stat per session.
  private readonly terminalLogSizes = new Map<string, number>();
  private flushPendingTerminalData: ((sessionId: string) => void) | undefined;

  private readonly now: () => number;

  constructor(dataDir: string, options: { maxTerminalLogBytes?: number; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.sessionsDir = join(dataDir, 'sessions');
    this.archivePath = join(dataDir, 'archive.jsonl');

    const envCap = Number(process.env.FTOWN_MAX_TERMINAL_LOG_BYTES);
    this.maxTerminalLogBytes =
      options.maxTerminalLogBytes ??
      (Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_MAX_TERMINAL_LOG_BYTES);
  }

  /** Per-session data dir (session.json, terminal.log, inbox.jsonl). */
  sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
  }

  private sessionFilePath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'session.json');
  }

  private terminalLogPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'terminal.log');
  }

  /** Serialize all directory mutations, recovering after a failed operation. */
  private async withSessionWrite(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.writeLocks.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task);
    const settled = run.catch(() => undefined);
    this.writeLocks.set(sessionId, settled);
    try {
      await run;
    } finally {
      if (this.writeLocks.get(sessionId) === settled) {
        this.writeLocks.delete(sessionId);
      }
    }
  }

  async saveSession(session: Session): Promise<void> {
    await this.withSessionWrite(session.id, async () => {
      if (this.retiredSessionIds.has(session.id)) return;
      const dir = this.sessionDir(session.id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const filePath = this.sessionFilePath(session.id);
      const tempFilePath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

      try {
        // Publish only complete snapshots. Writing the live path in place lets a
        // concurrent API read observe the truncate/write window and JSON.parse an
        // incomplete document. A same-directory rename is atomic for readers.
        // 0600: session.json carries the env map with provider tokens, the exact
        // field toWireSession strips from the wire. Never world-readable.
        const text = JSON.stringify(session, null, 2);
        const handle = await open(tempFilePath, 'w', 0o600);
        try {
          await handle.writeFile(text, 'utf-8');
        } finally {
          await handle.close();
        }
        await rename(tempFilePath, filePath);
      } catch (error) {
        await rm(tempFilePath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        // A file published just now cannot be validated by its stamp (another
        // writer in the same timestamp tick would leave it unchanged), so the
        // record is read back from disk once it has settled.
        this.recordIndex.delete(session.id);
      }
    });
  }

  /** One stat of a file, reduced to its stamp; undefined when it cannot be stat'ed. */
  private async stampOf(filePath: string): Promise<FileStamp | undefined> {
    try {
      return toFileStamp(await stat(filePath, { bigint: true }));
    } catch {
      return undefined;
    }
  }

  /**
   * session.json content as JSON text for a stamp just taken from disk, or null
   * when the file does not exist — including when it was removed between the
   * stat and the read. Reads and parses only a new or changed file; corrupt
   * files throw and are never indexed.
   */
  private async recordJsonAt(sessionId: string, stamp: FileStamp | undefined): Promise<string | null> {
    if (!stamp) {
      this.recordIndex.delete(sessionId);
      return null;
    }
    const indexed = this.recordIndex.get(sessionId);
    if (indexed && sameStamp(indexed, stamp)) {
      return indexed.json;
    }
    // The stamp was taken BEFORE the read: if the file is replaced meanwhile,
    // the next stat differs from it and the entry is re-read.
    this.recordIndex.delete(sessionId);
    const readStartedAt = this.now();
    let raw: string;
    try {
      raw = await readFile(this.sessionFilePath(sessionId), 'utf-8');
    } catch (error) {
      if (isGone(error)) return null;
      throw error;
    }
    const json = JSON.stringify(JSON.parse(raw));
    if (isSettledStamp(stamp, readStartedAt)) this.recordIndex.set(sessionId, { ...stamp, json });
    return json;
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    const json = await this.recordJsonAt(sessionId, await this.stampOf(this.sessionFilePath(sessionId)));
    return json === null ? null : parseSessionRecord(json);
  }

  async listSessions(): Promise<Session[]> {
    if (!existsSync(this.sessionsDir)) {
      this.recordIndex.clear();
      return [];
    }

    const entries = await readdir(this.sessionsDir, { withFileTypes: true });
    const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const sessions: Session[] = [];

    // Directory order is kept: stats run a batch at a time, records are then
    // resolved one by one in that order.
    for (let start = 0; start < ids.length; start += LIST_STAT_CONCURRENCY) {
      const batch = ids.slice(start, start + LIST_STAT_CONCURRENCY);
      const stamps = await Promise.all(batch.map((id) => this.stampOf(this.sessionFilePath(id))));
      for (let i = 0; i < batch.length; i++) {
        const json = await this.recordJsonAt(batch[i], stamps[i]);
        const session = json === null ? null : parseSessionRecord(json);
        if (session) {
          sessions.push(session);
        }
      }
    }

    const present = new Set(ids);
    for (const sessionId of this.recordIndex.keys()) {
      if (!present.has(sessionId)) this.recordIndex.delete(sessionId);
    }

    return sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Registers the owner of not-yet-persisted terminal output (the pump). It is
   * invoked before terminal.log is read or cleared so no reader can observe a
   * log that is missing bytes still waiting in a coalescing window.
   */
  setPendingTerminalFlush(flush: (sessionId: string) => void): void {
    this.flushPendingTerminalData = flush;
  }

  async appendTerminalData(sessionId: string, data: string): Promise<void> {
    await this.withSessionWrite(sessionId, async () => {
      if (this.retiredSessionIds.has(sessionId)) return;
      const filePath = this.terminalLogPath(sessionId);
      const bytes = Buffer.from(data, 'utf-8');
      try {
        await this.appendTerminalBytes(sessionId, filePath, bytes);
      } catch (error) {
        this.terminalDirsReady.delete(sessionId);
        this.terminalLogSizes.delete(sessionId);
        if (!isMissing(error)) throw error;
        // The directory vanished since it was created: recreate it and retry.
        await this.appendTerminalBytes(sessionId, filePath, bytes);
      }
      await this.trimTerminalLogIfNeeded(sessionId, filePath);
    });
  }

  private async appendTerminalBytes(sessionId: string, filePath: string, bytes: Buffer): Promise<void> {
    if (!this.terminalDirsReady.has(sessionId)) {
      await mkdir(this.sessionDir(sessionId), { recursive: true, mode: 0o700 });
      this.terminalDirsReady.add(sessionId);
    }
    await appendFile(filePath, bytes, { mode: 0o600 });
    const known = this.terminalLogSizes.get(sessionId);
    if (known !== undefined) this.terminalLogSizes.set(sessionId, known + bytes.length);
  }

  /**
   * Cap a terminal.log's on-disk size. Runs inside the per-session write lock,
   * so it never races an append. The file is allowed to grow to 2x the retained
   * size before being rewritten down to the tail — this amortises the rewrite
   * cost while bounding disk use to at most 2x `maxTerminalLogBytes` per session.
   * The partial first line of the retained tail is dropped so consumers never
   * start mid-line (or mid-escape-sequence), and a one-line marker records that
   * older output was discarded. Best-effort: any failure is swallowed so it can
   * never poison the write-lock chain and stall future appends.
   */
  private async trimTerminalLogIfNeeded(sessionId: string, filePath: string): Promise<void> {
    try {
      // The size is tracked in memory after one stat; the file is stat'ed again
      // only when the tracked size says a trim is due (the trim needs the real
      // size) or after an error dropped the tracked value.
      const tracked = this.terminalLogSizes.get(sessionId);
      if (tracked !== undefined && tracked <= this.maxTerminalLogBytes * 2) {
        return;
      }
      this.terminalLogSizes.delete(sessionId);
      const { size } = await stat(filePath);
      if (size <= this.maxTerminalLogBytes * 2) {
        this.terminalLogSizes.set(sessionId, size);
        return;
      }

      const keep = this.maxTerminalLogBytes;
      const fh = await open(filePath, 'r');
      let tail: Buffer;
      try {
        const buf = Buffer.alloc(keep);
        const { bytesRead } = await fh.read(buf, 0, keep, size - keep);
        tail = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }

      // Drop the (almost certainly partial) first line so the retained log
      // begins on a clean line boundary.
      const nl = tail.indexOf(NEWLINE);
      const body = nl >= 0 ? tail.subarray(nl + 1) : tail;
      const marker = Buffer.from(
        `[ftown] terminal.log truncated — retaining last ${keep} bytes\r\n`,
        'utf-8',
      );

      // Rewrite via a temp file + atomic rename so a concurrent full-file reader
      // (loadTerminalLog runs outside the lock) never observes a partial file.
      const tmpPath = `${filePath}.trim-${process.pid}.tmp`;
      await writeFile(tmpPath, Buffer.concat([marker, body]), { mode: 0o600 });
      await rename(tmpPath, filePath);
      this.terminalLogSizes.set(sessionId, marker.length + body.length);
    } catch (err) {
      this.terminalLogSizes.delete(sessionId);
      console.error(`[SessionStore] Failed to trim terminal log ${filePath}:`, err);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.withSessionWrite(sessionId, async () => {
      this.recordIndex.delete(sessionId);
      this.terminalDirsReady.delete(sessionId);
      this.terminalLogSizes.delete(sessionId);
      await rm(this.sessionDir(sessionId), { recursive: true, force: true });
      this.recordIndex.delete(sessionId);
      // Latch only after successful deletion so failures remain retryable.
      this.retiredSessionIds.add(sessionId);
    });
  }

  /** Append a tombstone for a removed session to <dataDir>/archive.jsonl. */
  async archiveSession(session: Session): Promise<void> {
    await mkdir(dirname(this.archivePath), { recursive: true, mode: 0o700 });
    const record: ArchivedSession = { ...session, removedAt: new Date().toISOString() };
    // Tombstones retain session env (API keys); owner-only like session-registry.
    await appendFile(this.archivePath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600 });
  }

  /**
   * Tighten permissions on state created before write-time modes were added.
   * session.json / terminal.log / inbox.jsonl can contain provider tokens and
   * full terminal scrollback, so they must never be world-readable. Best-effort:
   * a chmod failure (e.g. a file owned by another user) must not stop startup.
   */
  async hardenPermissions(): Promise<void> {
    const tighten = async (path: string, mode: number): Promise<void> => {
      try { await chmod(path, mode); } catch { /* best effort */ }
    };
    await tighten(this.sessionsDir, 0o700);
    let entries: string[] = [];
    try { entries = await readdir(this.sessionsDir); } catch { return; }
    for (const id of entries) {
      const dir = this.sessionDir(id);
      await tighten(dir, 0o700);
      await tighten(join(dir, 'session.json'), 0o600);
      await tighten(join(dir, 'terminal.log'), 0o600);
      await tighten(join(dir, 'inbox.jsonl'), 0o600);
    }
    await tighten(this.archivePath, 0o600);
  }

  /** All tombstones, newest last. Missing file and corrupt lines are tolerated. */
  async listArchived(): Promise<ArchivedSession[]> {
    if (!existsSync(this.archivePath)) {
      return [];
    }
    const raw = await readFile(this.archivePath, 'utf-8');
    const archived: ArchivedSession[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as ArchivedSession;
        if (record && typeof record.id === 'string' && typeof record.removedAt === 'string') {
          if (record.shellType !== undefined) {
            try {
              record.shellType = normalizeShellType(record.shellType);
            } catch {
              // Tolerate corrupt / unrecognized legacy shellType
            }
          }
          archived.push(record);
        }
      } catch {
        // Skip corrupt lines (e.g. partial write from a crashed bridge).
      }
    }
    return archived;
  }

  async clearTerminalLog(sessionId: string): Promise<void> {
    // Queue pending output ahead of the truncate so it cannot land afterwards.
    this.flushPendingTerminalData?.(sessionId);
    await this.withSessionWrite(sessionId, async () => {
      if (this.retiredSessionIds.has(sessionId)) return;
      const filePath = this.terminalLogPath(sessionId);
      this.terminalLogSizes.delete(sessionId);
      if (existsSync(filePath)) {
        await truncate(filePath, 0);
        this.terminalLogSizes.set(sessionId, 0);
      }
    });
  }

  async loadTerminalLog(sessionId: string): Promise<string> {
    // Pending output is handed to appendTerminalData synchronously, which joins
    // the session's write chain; waiting for that chain makes the read complete.
    this.flushPendingTerminalData?.(sessionId);
    await this.writeLocks.get(sessionId);
    const filePath = this.terminalLogPath(sessionId);
    if (!existsSync(filePath)) {
      return '';
    }
    return readFile(filePath, 'utf-8');
  }

}
