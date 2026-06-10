import { readFile, writeFile, mkdir, readdir, appendFile, rm, truncate } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

import type { ArchivedSession, Session } from './types.js';

export class SessionStore {
  private readonly sessionsDir: string;
  private readonly archivePath: string;
  private readonly writeLocks: Map<string, Promise<void>> = new Map();

  constructor(dataDir: string) {
    this.sessionsDir = join(dataDir, 'sessions');
    this.archivePath = join(dataDir, 'archive.jsonl');
  }

  private sessionDir(sessionId: string): string {
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
    const newLock = prevLock.then(() => appendFile(filePath, data, 'utf-8'));
    this.writeLocks.set(sessionId, newLock);
    await newLock;
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
