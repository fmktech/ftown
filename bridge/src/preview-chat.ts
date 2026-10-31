import { randomUUID } from 'node:crypto';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PREVIEW_CHAT_MAX_TURNS, PREVIEW_CHAT_PAGE_BYTES, PREVIEW_CHAT_PAGE_TURNS, PREVIEW_CHAT_STORE_BYTES, PREVIEW_CHAT_TEXT_BYTES } from './preview-chat-protocol.js';
import type { PreviewChatErrorCode, PreviewChatInput, PreviewChatPage, PreviewChatTurn } from './preview-chat-protocol.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const session = /^[A-Za-z0-9_-]{1,200}$/;
export class PreviewChatError extends Error {
  constructor(readonly code: PreviewChatErrorCode, message: string) { super(message); }
}
export function validateChatInput(input: PreviewChatInput): void {
  if (!input || typeof input.id !== 'string' || !uuid.test(input.id) || typeof input.text !== 'string' || !input.text.trim()
    || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(input.text)) throw new PreviewChatError('invalid', 'Invalid conversation message');
  if (Buffer.byteLength(input.text, 'utf8') > PREVIEW_CHAT_TEXT_BYTES) throw new PreviewChatError('too_large', 'Conversation message is too large');
}
const turnSchema = z.object({ id: z.string().regex(uuid), sequence: z.number().int().positive(), text: z.string(), createdAt: z.iso.datetime(),
  role: z.enum(['user', 'agent']), delivery: z.enum(['unconfirmed', 'queued', 'recorded']) }).strict();
const ledgerSchema = z.object({ schema: z.literal(1), turns: z.array(turnSchema).max(PREVIEW_CHAT_MAX_TURNS) }).strict();

/** Caller serializes all methods with the session lifecycle queue. */
export class PreviewChatStore {
  constructor(private readonly sessionDir: (id: string) => string) {}
  private path(id: string): string { return join(this.sessionDir(id), 'preview-chat.json'); }
  private async load(id: string): Promise<PreviewChatTurn[]> {
    if (!session.test(id)) throw new PreviewChatError('invalid', 'Invalid session');
    let raw: string;
    try {
      const file = await open(this.path(id), 'r');
      try {
        if (!(await file.stat()).isFile()) throw new Error('invalid file');
        const buffer = Buffer.alloc(PREVIEW_CHAT_STORE_BYTES + 1); let used = 0;
        while (used < buffer.length) { const { bytesRead } = await file.read(buffer, used, buffer.length - used, used); if (!bytesRead) break; used += bytesRead; }
        if (used > PREVIEW_CHAT_STORE_BYTES) throw new Error('oversize');
        raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
      } finally { await file.close(); }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new PreviewChatError('unavailable', 'Conversation storage unavailable'); }
    try {
      if (Buffer.byteLength(raw) > PREVIEW_CHAT_STORE_BYTES) throw new Error('oversize');
      const value = ledgerSchema.parse(JSON.parse(raw));
      const ids = new Set<string>();
      return value.turns.map((turn, index) => {
        validateChatInput(turn);
        if (turn.sequence !== index + 1 || ids.has(turn.id.toLowerCase()) || (turn.role === 'user' ? turn.delivery === 'recorded' : turn.delivery !== 'recorded')) throw new Error('invalid turn');
        ids.add(turn.id.toLowerCase());
        if (turn.role === 'agent') return { ...turn, role: 'agent' as const, delivery: 'recorded' as const };
        if (turn.delivery === 'unconfirmed' || turn.delivery === 'queued') return { ...turn, role: 'user' as const, delivery: turn.delivery };
        throw new Error('invalid turn');
      });
    } catch { throw new PreviewChatError('unavailable', 'Conversation storage unavailable'); }
  }
  private async save(id: string, turns: PreviewChatTurn[]): Promise<void> {
    const data = JSON.stringify({ schema: 1, turns });
    if (turns.length > PREVIEW_CHAT_MAX_TURNS || Buffer.byteLength(data) > PREVIEW_CHAT_STORE_BYTES) throw new PreviewChatError('capacity_exceeded', 'Conversation is full');
    const path = this.path(id); const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, data, { flag: 'wx', mode: 0o600 }); await rename(temp, path); }
    catch { await rm(temp, { force: true }).catch(() => {}); throw new PreviewChatError('unavailable', 'Conversation storage unavailable'); }
  }
  async find(id: string, input: PreviewChatInput, role: PreviewChatTurn['role']): Promise<PreviewChatTurn | null> {
    validateChatInput(input);
    const found = (await this.load(id)).find(turn => turn.id.toLowerCase() === input.id.toLowerCase());
    if (found && (found.role !== role || found.text !== input.text)) throw new PreviewChatError('conflict', 'Message ID already used');
    return found ?? null;
  }
  async reserve(id: string, input: PreviewChatInput, role: PreviewChatTurn['role']): Promise<PreviewChatTurn> {
    validateChatInput(input);
    const turns = await this.load(id);
    const existing = turns.find(turn => turn.id.toLowerCase() === input.id.toLowerCase());
    if (existing) {
      if (existing.role !== role || existing.text !== input.text) throw new PreviewChatError('conflict', 'Message ID already used');
      return existing;
    }
    const base = { id: input.id, text: input.text, sequence: turns.length + 1, createdAt: new Date().toISOString() };
    const turn: PreviewChatTurn = role === 'user' ? { ...base, role, delivery: 'unconfirmed' } : { ...base, role, delivery: 'recorded' };
    await this.save(id, [...turns, turn]);
    return turn;
  }
  async markQueued(id: string, turnId: string): Promise<PreviewChatTurn> {
    const turns = await this.load(id); const index = turns.findIndex(turn => turn.id.toLowerCase() === turnId.toLowerCase());
    if (index < 0 || turns[index].role !== 'user') throw new PreviewChatError('unavailable', 'Conversation storage unavailable');
    const turn = turns[index]; if (turn.role !== 'user') throw new PreviewChatError('unavailable', 'Conversation storage unavailable');
    const queued = { ...turn, delivery: 'queued' as const }; turns[index] = queued;
    await this.save(id, turns); return queued;
  }
  async list(id: string, cursor?: string): Promise<PreviewChatPage> {
    const turns = await this.load(id);
    const prefix = `${id}:`; let offset = 0;
    if (cursor !== undefined) {
      if (!cursor.startsWith(prefix) || !/^(0|[1-9]\d*)$/.test(cursor.slice(prefix.length))) throw new PreviewChatError('invalid', 'Invalid conversation cursor');
      offset = Number(cursor.slice(prefix.length));
      if (!Number.isSafeInteger(offset) || offset > turns.length) throw new PreviewChatError('invalid', 'Invalid conversation cursor');
    }
    const page: PreviewChatPage = { sessionId: id, turns: [], cursor: `${id}:${offset}`, hasMore: offset < turns.length };
    for (const turn of turns.slice(offset, offset + PREVIEW_CHAT_PAGE_TURNS)) {
      const candidate: PreviewChatPage = { sessionId: id, turns: [...page.turns, turn], cursor: `${id}:${turn.sequence}`, hasMore: turn.sequence < turns.length };
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PREVIEW_CHAT_PAGE_BYTES) break;
      Object.assign(page, candidate);
    }
    if (page.hasMore && !page.turns.length) throw new PreviewChatError('unavailable', 'Conversation page unavailable');
    return page;
  }
}
