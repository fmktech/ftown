import { readFile, writeFile, mkdir, readdir, appendFile, rm, truncate, stat, open, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

import type { ArchivedSession, Session } from './types.js';

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

export class SessionStore {
  private readonly sessionsDir: string;
  private readonly archivePath: string;
  private readonly writeLocks: Map<string, Promise<void>> = new Map();
  private readonly maxTerminalLogBytes: number;

  constructor(dataDir: string, options: { maxTerminalLogBytes?: number } = {}) {
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

  async saveSession(session: Session): Promise<void> {
    const dir = this.sessionDir(session.id);
    await mkdir(dir, { recursive: true });
    await writeFile(this.sessionFilePath(session.id), JSON.stringify(session, null, 2), 'utf-8');
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    const filePath = this.sessionFilePath(sessionId);
    if (!existsSync(filePath)) {
      return null;
    }
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data) as Session;
  }

  async listSessions(): Promise<Session[]> {
    if (!existsSync(this.sessionsDir)) {
      return [];
    }

    const entries = await readdir(this.sessionsDir, { withFileTypes: true });
    const sessions: Session[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const session = await this.loadSession(entry.name);
        if (session) {
          sessions.push(session);
        }
      }
    }

    return sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async appendTerminalData(sessionId: string, data: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });

    const filePath = this.terminalLogPath(sessionId);

    const prevLock = this.writeLocks.get(sessionId) ?? Promise.resolve();
    const newLock = prevLock
      .then(() => appendFile(filePath, data, 'utf-8'))
      .then(() => this.trimTerminalLogIfNeeded(filePath));
    this.writeLocks.set(sessionId, newLock);
    await newLock;
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
  private async trimTerminalLogIfNeeded(filePath: string): Promise<void> {
    try {
      const { size } = await stat(filePath);
      if (size <= this.maxTerminalLogBytes * 2) {
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
      await writeFile(tmpPath, Buffer.concat([marker, body]));
      await rename(tmpPath, filePath);
    } catch (err) {
      console.error(`[SessionStore] Failed to trim terminal log ${filePath}:`, err);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Append a tombstone for a removed session to <dataDir>/archive.jsonl. */
  async archiveSession(session: Session): Promise<void> {
    await mkdir(dirname(this.archivePath), { recursive: true });
    const record: ArchivedSession = { ...session, removedAt: new Date().toISOString() };
    // Tombstones retain session env (API keys); owner-only like session-registry.
    await appendFile(this.archivePath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600 });
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
          archived.push(record);
        }
      } catch {
        // Skip corrupt lines (e.g. partial write from a crashed bridge).
      }
    }
    return archived;
  }

  async clearTerminalLog(sessionId: string): Promise<void> {
    const filePath = this.terminalLogPath(sessionId);
    if (existsSync(filePath)) {
      const prevLock = this.writeLocks.get(sessionId) ?? Promise.resolve();
      const newLock = prevLock.then(() => truncate(filePath, 0));
      this.writeLocks.set(sessionId, newLock);
      await newLock;
    }
  }

  async loadTerminalLog(sessionId: string): Promise<string> {
    const filePath = this.terminalLogPath(sessionId);
    if (!existsSync(filePath)) {
      return '';
    }
    return readFile(filePath, 'utf-8');
  }

}
