import type { BriefNote, SessionBrief } from './contract-b.js';
import { BRIEF_LIMITS, RouteError, type RouteContext } from './contract-b.js';
import type { Session } from '../types.js';

const BRIEF_PATTERN = /^\/api\/sessions\/([^/]+)\/brief$/;
const NOTES_PATTERN = /^\/api\/sessions\/([^/]+)\/brief\/notes$/;

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Strips control characters except \n and \t (C0, DEL, and C1 U+0080–U+009F). */
function stripControlChars(value: string): string {
  return [...value].map((char) => {
    const code = char.codePointAt(0) ?? 0;
    const isControl = (code <= 31 && code !== 9 && code !== 10)
      || code === 127
      || (code >= 0x80 && code <= 0x9f);
    return isControl ? '' : char;
  }).join('');
}

function requireOnlyKeys(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new RouteError(400, `Unknown body key: ${key}`);
  }
}

/** Cleans markdown brief text; keeps newlines/tabs; over-limit → 400. Blank-after-cleaning clears the text. */
function parseBriefText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new RouteError(400, 'text must be a string or null');
  const cleaned = stripControlChars(value);
  if ([...cleaned].length > BRIEF_LIMITS.text) {
    throw new RouteError(400, `text must be at most ${BRIEF_LIMITS.text} characters`);
  }
  return cleaned.trim() === '' ? null : cleaned;
}

/** Cleans a single note: control chars stripped, single line, 1..BRIEF_LIMITS.note characters. */
function parseNoteText(value: unknown): string {
  if (typeof value !== 'string') throw new RouteError(400, 'text must be a string');
  const cleaned = stripControlChars(value).replace(/\s+/g, ' ').trim();
  const length = [...cleaned].length;
  if (length < 1) throw new RouteError(400, 'text must not be empty');
  if (length > BRIEF_LIMITS.note) {
    throw new RouteError(400, `text must be at most ${BRIEF_LIMITS.note} characters`);
  }
  return cleaned;
}

function parseBodyText(body: Record<string, unknown>): unknown {
  requireOnlyKeys(body, ['text']);
  const hasText = hasOwn(body, 'text') && body.text !== undefined;
  if (!hasText) throw new RouteError(400, 'text is required');
  return body.text;
}

function buildBrief(existing: SessionBrief | undefined, text: string | null): SessionBrief {
  const brief: SessionBrief = { notes: existing?.notes ?? [], updatedAt: new Date().toISOString() };
  if (text !== null) brief.text = text;
  return brief;
}

function appendNote(existing: SessionBrief | undefined, note: BriefNote): SessionBrief {
  const brief: SessionBrief = { notes: [...(existing?.notes ?? []), note], updatedAt: new Date().toISOString() };
  if (existing?.text !== undefined) brief.text = existing.text;
  // Newest last, capped by dropping the oldest.
  brief.notes = brief.notes.slice(-BRIEF_LIMITS.notes);
  return brief;
}

async function loadSessionOr404(ctx: RouteContext, id: string): Promise<Session> {
  const session = await ctx.loadSession(id);
  if (!session) throw new RouteError(404, 'Session not found');
  return session;
}

/**
 * Reloads the session just before saving and derives the next brief from it via `mutate`,
 * so concurrent writers never lose each other's changes. undefined removes the brief.
 */
async function mutateBrief(
  ctx: RouteContext,
  id: string,
  mutate: (existing: SessionBrief | undefined) => SessionBrief | undefined,
): Promise<SessionBrief | undefined> {
  const fresh = await ctx.loadSession(id);
  if (!fresh) throw new RouteError(404, 'Session not found');
  const next = mutate(fresh.brief);
  const saved: Session = { ...fresh };
  if (next === undefined) {
    delete saved.brief;
  } else {
    saved.brief = next;
  }
  await ctx.saveSession(saved);
  ctx.publishSession(saved);
  return next;
}

/**
 * Route module for BRIEF_ROUTES:
 *   GET    /api/sessions/:id/brief       → { brief: SessionBrief | null }
 *   PUT    /api/sessions/:id/brief       → { brief }   (body { text: string | null })
 *   DELETE /api/sessions/:id/brief       → { ok: true }
 *   POST   /api/sessions/:id/brief/notes → { brief }   (body { text: string })
 * Returns false when the path does not match. Throws RouteError for HTTP errors.
 */
export async function handleBriefRoutes(ctx: RouteContext): Promise<boolean> {
  const briefMatch = BRIEF_PATTERN.exec(ctx.path);
  if (briefMatch) {
    const id = briefMatch[1];
    if (ctx.method === 'GET') {
      const session = await loadSessionOr404(ctx, id);
      ctx.json(200, { brief: session.brief ?? null });
      return true;
    }
    if (ctx.method === 'PUT') {
      await loadSessionOr404(ctx, id);
      const text = parseBodyText(await ctx.parseBody());
      const parsed = parseBriefText(text);
      const next = await mutateBrief(ctx, id, (existing) => {
        const brief = buildBrief(existing, parsed);
        return brief.text === undefined && brief.notes.length === 0 ? undefined : brief;
      });
      ctx.json(200, { brief: next ?? null });
      return true;
    }
    if (ctx.method === 'DELETE') {
      await loadSessionOr404(ctx, id);
      await mutateBrief(ctx, id, () => undefined);
      ctx.json(200, { ok: true });
      return true;
    }
    throw new RouteError(405, 'Method not allowed');
  }

  const notesMatch = NOTES_PATTERN.exec(ctx.path);
  if (notesMatch) {
    const id = notesMatch[1];
    if (ctx.method === 'POST') {
      await loadSessionOr404(ctx, id);
      const text = parseBodyText(await ctx.parseBody());
      const noteText = parseNoteText(text);
      const next = await mutateBrief(ctx, id, (existing) => {
        const note: BriefNote = { ts: new Date().toISOString(), text: noteText };
        return appendNote(existing, note);
      });
      ctx.json(200, { brief: next });
      return true;
    }
    throw new RouteError(405, 'Method not allowed');
  }

  return false;
}
