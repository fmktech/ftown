import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PullRequestObservation } from './pull-request-status.js';

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

type PrCheckpoint = { _ftown: 'pr-event-checkpoint'; version: 1; linkId: string; headOid?: string; state: 'in_progress' | 'failed' | 'passed' | 'merged'; ordinal: number };
type Inbox = { messages: MailMessage[]; checkpoint?: PrCheckpoint };

function checkpoint(value: Record<string, unknown>): PrCheckpoint {
  if (value.version !== 1 || typeof value.linkId !== 'string' || !value.linkId || !['in_progress', 'failed', 'passed', 'merged'].includes(String(value.state)) || !Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 0 || (value.state !== 'merged' && (typeof value.headOid !== 'string' || !value.headOid)) || (value.headOid !== undefined && typeof value.headOid !== 'string')) throw new Error('Invalid PR event checkpoint');
  return value as PrCheckpoint;
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

  /** Old malformed message lines remain ignored; recognized checkpoints fail closed. */
  private async readInbox(sessionId: string): Promise<Inbox> {
    const filePath = this.inboxPath(sessionId);
    if (!existsSync(filePath)) return { messages: [] };
    const raw = await readFile(filePath, 'utf-8');
    const messages: MailMessage[] = [];
    let state: PrCheckpoint | undefined;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch {
        // A broken recognizable metadata record must not silently reset deduplication.
        if (line.includes('pr-event-checkpoint')) throw new Error('Invalid PR event checkpoint');
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      if (item._ftown === 'pr-event-checkpoint') {
        if (state) throw new Error('Duplicate PR event checkpoint');
        state = checkpoint(item);
      } else if (typeof item.id === 'string' && typeof item.body === 'string') messages.push(item as unknown as MailMessage);
    }
    return { messages, checkpoint: state };
  }

  private async readAll(sessionId: string): Promise<MailMessage[]> {
    return (await this.readInbox(sessionId)).messages;
  }

  private async replaceInbox(sessionId: string, inbox: Inbox): Promise<void> {
    const filePath = this.inboxPath(sessionId);
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const lines = [...(inbox.checkpoint ? [JSON.stringify(inbox.checkpoint)] : []), ...inbox.messages.map(message => JSON.stringify(message))];
    try {
      await writeFile(tmp, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
      await rename(tmp, filePath);
    } catch (error) { await import('node:fs/promises').then(fs => fs.rm(tmp, { force: true })).catch(() => {}); throw error; }
  }

  /** Caller fences the link under the session mutation lock; never creates its directory. */
  async commitPullRequestObservation(sessionId: string, linkId: string, observation: PullRequestObservation): Promise<{ enqueued: boolean; messageId?: string }> {
    if (observation.stale || !observation.checkedAt || observation.reason || !['in_progress', 'failed', 'passed', 'merged'].includes(observation.state) || (observation.state !== 'merged' && !observation.headOid)) return { enqueued: false };
    return this.withLock(sessionId, async () => {
      const inbox = await this.readInbox(sessionId);
      const old = inbox.checkpoint?.linkId === linkId ? inbox.checkpoint : undefined;
      if (old?.state === 'merged' || (old && old.state === observation.state && old.headOid === observation.headOid)) return { enqueued: false };
      const ordinal = (old?.ordinal ?? 0) + 1;
      const state = observation.state as PrCheckpoint['state'];
      inbox.checkpoint = { _ftown: 'pr-event-checkpoint', version: 1, linkId, state, ordinal, ...(observation.headOid ? { headOid: observation.headOid } : {}) };
      let messageId: string | undefined;
      if (state !== 'in_progress') {
        messageId = `pr-${createHash('sha256').update(JSON.stringify([linkId, ordinal, state, observation.headOid ?? 'merged'])).digest('hex')}`;
        const heading = state === 'merged' ? 'Pull request merged.' : state === 'failed' ? 'GitHub rollup checks failed.' : 'GitHub rollup checks passed.';
        const advice = state === 'failed' ? 'Inspect the checks and reproduce failures before fixing them within your existing task authorization.' : 'Follow your existing task and user instructions; this notification does not authorize merging or other actions.';
        inbox.messages.push({ id: messageId, ts: new Date().toISOString(), from: 'external', fromName: 'FTown PR updates', to: sessionId, type: 'message', body: `${heading}\nPR: ${observation.url}\nChecks: ${observation.url}/checks\n${observation.headOid ? `Observed head: ${observation.headOid}\n` : ''}Observed at: ${observation.checkedAt}\n${advice}` });
      }
      await this.replaceInbox(sessionId, inbox);
      return { enqueued: !!messageId, ...(messageId ? { messageId } : {}) };
    });
  }

  async append(msg: MailMessage): Promise<void> {
    await this.withLock(msg.to, async () => {
      const dir = this.resolveDir(msg.to);
      await mkdir(dir, { recursive: true });
      await this.readInbox(msg.to);
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
      const inbox = await this.readInbox(sessionId);
      const all = inbox.messages;
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
      await this.replaceInbox(sessionId, { ...inbox, messages: kept });
      return marked;
    });
  }
}
