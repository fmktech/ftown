import type { Session } from '../types.js';
import {
  BLOCKED_ON_KINDS,
  CARD_LIMITS,
  CARD_STATES,
  CardValidationError,
  type CardBlockedOn,
  type CardPatch,
  type CardProgress,
  type CardState,
  type CardStoreApi,
  type CardStoreDeps,
  type SessionCardDeclared,
} from './contract.js';

const ALLOWED_PATCH_KEYS = new Set(['state', 'headline', 'progress', 'blockedOn', 'next']);
const SESSION_REF_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

interface ParsedPatch {
  hasState: boolean;
  state?: CardState;
  hasHeadline: boolean;
  headline?: string;
  hasProgress: boolean;
  progress?: CardProgress | null;
  hasBlockedOn: boolean;
  blockedOn?: CardBlockedOn | null;
  hasNext: boolean;
  next?: string | null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function cleanText(value: unknown, field: string, minLength: number, maxLength: number): string {
  if (typeof value !== 'string') throw new CardValidationError(`${field} must be a string`);
  const withoutControls = [...value].map((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? ' ' : char;
  }).join('');
  const cleaned = withoutControls.replace(/\s+/g, ' ').trim();
  const cleanedLength = [...cleaned].length;
  if (cleanedLength < minLength) throw new CardValidationError(`${field} must not be empty`);
  if (cleanedLength > maxLength) throw new CardValidationError(`${field} must be at most ${maxLength} characters`);
  return cleaned;
}

function parseProgress(value: unknown): CardProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CardValidationError('Progress must be an object');
  }
  const record = value as Record<string, unknown>;
  const done = record.done;
  const total = record.total;
  if (typeof done !== 'number' || typeof total !== 'number' || !Number.isInteger(done) || !Number.isInteger(total)) {
    throw new CardValidationError('Progress done and total must be integers');
  }
  if (total < 1 || total > CARD_LIMITS.progressTotal) {
    throw new CardValidationError(`Progress total must be between 1 and ${CARD_LIMITS.progressTotal}`);
  }
  if (done < 0 || done > total) {
    throw new CardValidationError('Progress done must be between 0 and total');
  }
  return { done, total };
}

function parseBlockedOn(value: unknown): CardBlockedOn {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CardValidationError('Blocked-on must be an object');
  }
  const record = value as Record<string, unknown>;
  const kind = BLOCKED_ON_KINDS.find((candidate) => candidate === record.kind);
  if (!kind) throw new CardValidationError('Blocked-on kind is invalid');
  const text = cleanText(record.text, 'Blocked-on text', 1, CARD_LIMITS.blockedText);
  if (kind === 'session') {
    const ref = record.ref;
    if (typeof ref !== 'string' || !SESSION_REF_PATTERN.test(ref)) {
      throw new CardValidationError('Blocked-on session ref is invalid');
    }
    return { kind, ref, text };
  }
  if (hasOwn(record, 'ref') && record.ref !== undefined && record.ref !== null) {
    throw new CardValidationError('Blocked-on ref is only allowed when kind is session');
  }
  return { kind, text };
}

function parsePatch(patch: CardPatch): ParsedPatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new CardValidationError('Card update must be an object');
  }
  const record = patch as unknown as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined);
  if (keys.length === 0) throw new CardValidationError('Empty card update');
  for (const key of keys) {
    if (!ALLOWED_PATCH_KEYS.has(key)) throw new CardValidationError(`Unknown card field: ${key}`);
  }

  const parsed: ParsedPatch = {
    hasState: keys.includes('state'),
    hasHeadline: keys.includes('headline'),
    hasProgress: keys.includes('progress'),
    hasBlockedOn: keys.includes('blockedOn'),
    hasNext: keys.includes('next'),
  };

  if (parsed.hasState) {
    const state = CARD_STATES.find((candidate) => candidate === record.state);
    if (!state) throw new CardValidationError('Card state is invalid');
    parsed.state = state;
  }
  if (parsed.hasHeadline) {
    parsed.headline = cleanText(record.headline, 'Headline', 1, CARD_LIMITS.headline);
  }
  if (parsed.hasProgress) {
    parsed.progress = record.progress === null ? null : parseProgress(record.progress);
  }
  if (parsed.hasBlockedOn) {
    parsed.blockedOn = record.blockedOn === null ? null : parseBlockedOn(record.blockedOn);
  }
  if (parsed.hasNext) {
    if (record.next === null) {
      parsed.next = null;
    } else {
      const cleanedNext = cleanText(record.next, 'Next', 0, CARD_LIMITS.next);
      parsed.next = cleanedNext === '' ? null : cleanedNext;
    }
  }
  return parsed;
}

function applyParsed(existing: SessionCardDeclared | null, parsed: ParsedPatch, updatedAt: string): SessionCardDeclared {
  if (!existing && (!parsed.hasState || !parsed.hasHeadline)) {
    throw new CardValidationError('First card update must include state and headline');
  }

  let state = existing?.state;
  let headline = existing?.headline;
  let progress = existing?.progress;
  let blockedOn = existing?.blockedOn;
  let next = existing?.next;

  if (parsed.hasState) state = parsed.state;
  if (parsed.hasHeadline) headline = parsed.headline;
  if (parsed.hasProgress) progress = parsed.progress === null ? undefined : parsed.progress;
  if (parsed.hasBlockedOn) blockedOn = parsed.blockedOn === null ? undefined : parsed.blockedOn;
  if (parsed.hasNext) next = parsed.next === null ? undefined : parsed.next;

  if (state !== 'blocked' && !parsed.hasBlockedOn) blockedOn = undefined;

  if (state === undefined || headline === undefined) {
    throw new CardValidationError('First card update must include state and headline');
  }

  const card: SessionCardDeclared = { state, headline, updatedAt };
  if (progress !== undefined) card.progress = progress;
  if (blockedOn !== undefined) card.blockedOn = blockedOn;
  if (next !== undefined) card.next = next;
  return card;
}

export class CardStore implements CardStoreApi {
  private readonly deps: CardStoreDeps;

  constructor(deps: CardStoreDeps) {
    this.deps = deps;
  }

  async get(sessionId: string): Promise<SessionCardDeclared | null> {
    const session = await this.deps.loadSession(sessionId);
    return session?.card ?? null;
  }

  async set(sessionId: string, patch: CardPatch): Promise<SessionCardDeclared> {
    const session = await this.deps.loadSession(sessionId);
    if (!session) throw new Error('Session not found');
    const parsed = parsePatch(patch);
    const updatedAt = new Date(this.deps.now()).toISOString();

    const fresh = await this.deps.loadSession(sessionId);
    if (!fresh) throw new Error('Session not found');
    const previousCard = fresh.card ?? null;
    const card = applyParsed(previousCard, parsed, updatedAt);
    const savedSession: Session = { ...fresh, card };
    await this.deps.saveSession(savedSession);
    await this.notify(savedSession, previousCard);
    return card;
  }

  async clear(sessionId: string): Promise<void> {
    const session = await this.deps.loadSession(sessionId);
    if (!session || !session.card) return;

    const fresh = await this.deps.loadSession(sessionId);
    if (!fresh || !fresh.card) return;
    const previousCard = fresh.card;
    const savedSession: Session = { ...fresh };
    delete savedSession.card;
    await this.deps.saveSession(savedSession);
    await this.notify(savedSession, previousCard);
  }

  private async notify(session: Session, previous: SessionCardDeclared | null): Promise<void> {
    if (!this.deps.onChange) return;
    try {
      await this.deps.onChange(session, previous);
    } catch (error) {
      console.warn('CardStore onChange failed', error);
    }
  }
}
