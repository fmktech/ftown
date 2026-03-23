import { readFile, writeFile, mkdir, readdir, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import type { Session } from './types.js';

export class SessionStore {
  private readonly sessionsDir: string;
  private readonly writeLocks: Map<string, Promise<void>> = new Map();

  constructor(dataDir: string) {
    this.sessionsDir = join(dataDir, 'sessions');
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

  private diffPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'changes.diff');
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

  async loadTerminalLog(sessionId: string): Promise<string> {
    const filePath = this.terminalLogPath(sessionId);
    if (!existsSync(filePath)) {
      return '';
    }
    return readFile(filePath, 'utf-8');
  }

  async saveDiff(sessionId: string, diff: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(this.diffPath(sessionId), diff, 'utf-8');
  }

  async loadDiff(sessionId: string): Promise<string> {
    const filePath = this.diffPath(sessionId);
    if (!existsSync(filePath)) {
      return '';
    }
    return readFile(filePath, 'utf-8');
  }
}
