import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { MailMessage } from './types.js';

/** Rewrites cap the inbox file at the newest N messages. */
const MAX_STORED_MESSAGES = 500;

export interface MailMessageInput {
  from: string;
  fromName?: string;
  to: string;
  type: MailMessage['type'];
  threadId?: string;
  body: string;
}

export function createMailMessage(input: MailMessageInput): MailMessage {
  return {
    id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    ts: new Date().toISOString(),
    ...input,
  };
}

/**
 * Per-session append-only inbox (inbox.jsonl in the session's data dir).
 * Delivery marking rewrites the file atomically (tmp+rename); files are small.
 */
export class MailStore {
  private readonly resolveDir: (sessionId: string) => string;
  private readonly locks: Map<string, Promise<unknown>> = new Map();

  constructor(resolveDir: (sessionId: string) => string) {
    this.resolveDir = resolveDir;
  }

  private inboxPath(sessionId: string): string {
    return join(this.resolveDir(sessionId), 'inbox.jsonl');
  }

  /** Serialize file operations per session so appends never race rewrites. */
  private withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(sessionId, next.catch(() => undefined));
    return next;
  }

  /** All messages, oldest first. Missing file and corrupt lines are tolerated. */
  private async readAll(sessionId: string): Promise<MailMessage[]> {
    const filePath = this.inboxPath(sessionId);
    if (!existsSync(filePath)) {
      return [];
    }
    const raw = await readFile(filePath, 'utf-8');
    const messages: MailMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as MailMessage;
        if (msg && typeof msg.id === 'string' && typeof msg.body === 'string') {
          messages.push(msg);
        }
      } catch {
        // Skip corrupt lines (e.g. partial write from a crashed bridge).
      }
    }
    return messages;
  }

  async append(msg: MailMessage): Promise<void> {
    await this.withLock(msg.to, async () => {
      const dir = this.resolveDir(msg.to);
      await mkdir(dir, { recursive: true });
      // Mail can carry task details; owner-only like the session registry.
      await appendFile(this.inboxPath(msg.to), `${JSON.stringify(msg)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });
    });
  }

  async listUndelivered(sessionId: string): Promise<MailMessage[]> {
    return this.withLock(sessionId, async () =>
      (await this.readAll(sessionId)).filter((m) => !m.deliveredAt),
    );
  }

  async listAll(sessionId: string, limit: number): Promise<MailMessage[]> {
    return this.withLock(sessionId, async () => {
      const all = await this.readAll(sessionId);
      return limit > 0 ? all.slice(-limit) : all;
    });
  }

  /** Mark the given undelivered ids delivered now; returns the marked messages. */
  async markDelivered(
    sessionId: string,
    ids: string[],
    via: NonNullable<MailMessage['deliveredVia']>,
  ): Promise<MailMessage[]> {
    return this.withLock(sessionId, async () => {
      if (ids.length === 0) {
        return [];
      }
      const all = await this.readAll(sessionId);
      const wanted = new Set(ids);
      const now = new Date().toISOString();
      const marked: MailMessage[] = [];
      for (const msg of all) {
        if (wanted.has(msg.id) && !msg.deliveredAt) {
          msg.deliveredAt = now;
          msg.deliveredVia = via;
          marked.push(msg);
        }
      }
      if (marked.length === 0) {
        return [];
      }
      // Cap drops oldest DELIVERED messages only — undelivered mail must survive
      // until a session reads it, even if the file temporarily exceeds the cap.
      let toDrop = all.length - MAX_STORED_MESSAGES;
      const kept = all.filter((m) => {
        if (toDrop > 0 && m.deliveredAt) {
          toDrop--;
          return false;
        }
        return true;
      });
      const filePath = this.inboxPath(sessionId);
      const tmp = `${filePath}.tmp`;
      const payload = kept.map((m) => JSON.stringify(m)).join('\n') + '\n';
      await writeFile(tmp, payload, { encoding: 'utf-8', mode: 0o600 });
      await rename(tmp, filePath);
      return marked;
    });
  }
}
