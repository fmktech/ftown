/**
 * Plan list: precedence ordering, pure edits, and the session-backed store.
 * Ordering follows PLAN_ORDER_RULE. Ids are `p<seq>` allocated from SessionPlan.seq
 * and then incremented, so a removed id is never reused. A plan that does not exist
 * yet starts at seq 1 (first item `p1`).
 */
import type { Session } from '../types.js';
import {
  PLAN_LIMITS,
  PLAN_STATES,
  PlanValidationError,
  type PlanItem,
  type PlanPriority,
  type PlanState,
  type PlanView,
  type SessionPlan,
} from './contract-c.js';

const ITEM_ID_RE = /^p(\d{1,6})$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const ADD_KEYS = new Set(['title', 'note', 'after', 'priority']);
const PATCH_KEYS = new Set(['id', 'title', 'note', 'after', 'priority', 'state', 'sessionId']);

export interface PlanAddInput {
  title: string;
  note?: string;
  after?: string[];
  priority?: PlanPriority;
}

export interface PlanPatchInput {
  title?: string;
  note?: string | null;
  after?: string[];
  priority?: PlanPriority;
  state?: PlanState;
  sessionId?: string | null;
}

export interface PlanStoreDeps {
  loadSession(id: string): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  publishSession(session: Session): void | Promise<void>;
  emit(parent: Session, summary: string): Promise<void>;
  now(): number;
}

interface ParsedPatch {
  id: string;
  hasTitle: boolean;
  title?: string;
  hasNote: boolean;
  note?: string | null;
  hasAfter: boolean;
  after?: string[];
  hasPriority: boolean;
  priority?: PlanPriority;
  state?: PlanState;
  hasState: boolean;
  hasSessionId: boolean;
  sessionId?: string | null;
}

interface Change {
  plan: SessionPlan;
  summary: string;
  item?: PlanItem;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function emptyPlan(): SessionPlan {
  return { items: [], seq: 1 };
}

function requireNow(now: string): string {
  if (typeof now !== 'string' || now.trim() === '' || Number.isNaN(Date.parse(now))) {
    throw new PlanValidationError('now must be an ISO timestamp');
  }
  return now;
}

function asRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PlanValidationError(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function asPlan(plan: SessionPlan | null | undefined): SessionPlan {
  if (plan == null) return emptyPlan();
  if (typeof plan !== 'object' || !Array.isArray(plan.items) || !Number.isInteger(plan.seq)) {
    throw new PlanValidationError('plan is invalid');
  }
  return plan;
}

/** Control characters become spaces, then whitespace runs collapse. Length is in code points. */
function cleanText(value: unknown, field: string, minLength: number, maxLength: number): string {
  if (typeof value !== 'string') throw new PlanValidationError(`${field} must be a string`);
  const withoutControls = [...value].map((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? ' ' : char;
  }).join('');
  const cleaned = withoutControls.replace(/\s+/g, ' ').trim();
  const cleanedLength = [...cleaned].length;
  if (cleanedLength < minLength) throw new PlanValidationError(`${field} must not be empty`);
  if (cleanedLength > maxLength) throw new PlanValidationError(`${field} must be at most ${maxLength} characters`);
  return cleaned;
}

function cloneItem(item: PlanItem): PlanItem {
  const copy: PlanItem = {
    id: item.id,
    title: item.title,
    after: [...item.after],
    priority: item.priority,
    state: item.state,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (item.note !== undefined) copy.note = item.note;
  if (item.sessionId !== undefined) copy.sessionId = item.sessionId;
  return copy;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareId(left: string, right: string): number {
  const leftMatch = ITEM_ID_RE.exec(left);
  const rightMatch = ITEM_ID_RE.exec(right);
  if (leftMatch && rightMatch) {
    const delta = Number(leftMatch[1]) - Number(rightMatch[1]);
    if (delta !== 0) return delta;
  }
  return compareText(left, right);
}

function comparePrecedence(left: PlanItem, right: PlanItem): number {
  return left.priority - right.priority || compareText(left.createdAt, right.createdAt) || compareId(left.id, right.id);
}

function compareUpdatedAsc(left: PlanItem, right: PlanItem): number {
  return compareText(left.updatedAt, right.updatedAt) || compareId(left.id, right.id);
}

function compareUpdatedDesc(left: PlanItem, right: PlanItem): number {
  return compareText(right.updatedAt, left.updatedAt) || compareId(left.id, right.id);
}

function isSatisfied(item: PlanItem | undefined): boolean {
  return item?.state === 'done' || item?.state === 'dropped';
}

function isReady(item: PlanItem, byId: ReadonlyMap<string, PlanItem>): boolean {
  for (const id of item.after) {
    if (!isSatisfied(byId.get(id))) return false;
  }
  return true;
}

function partition(items: readonly PlanItem[]): {
  ready: PlanItem[];
  waiting: PlanItem[];
  started: PlanItem[];
  done: PlanItem[];
  dropped: PlanItem[];
} {
  const byId = new Map(items.map((item) => [item.id, item]));
  const groups = {
    ready: [] as PlanItem[],
    waiting: [] as PlanItem[],
    started: [] as PlanItem[],
    done: [] as PlanItem[],
    dropped: [] as PlanItem[],
  };
  for (const item of items) {
    if (item.state === 'todo') groups[isReady(item, byId) ? 'ready' : 'waiting'].push(item);
    else groups[item.state].push(item);
  }
  groups.ready.sort(comparePrecedence);
  groups.waiting.sort(comparePrecedence);
  groups.started.sort(compareUpdatedAsc);
  groups.done.sort(compareUpdatedDesc);
  groups.dropped.sort(compareUpdatedDesc);
  return groups;
}

/**
 * Ready, then waiting, then started, then done, then dropped.
 * Ready and waiting: priority ascending, then createdAt ascending.
 * Started: updatedAt ascending. Done and dropped: updatedAt descending.
 * Id number breaks remaining ties.
 */
export function orderPlan(items: readonly PlanItem[]): PlanView {
  const groups = partition(items);
  return {
    items: [...groups.ready, ...groups.waiting, ...groups.started, ...groups.done, ...groups.dropped],
    ready: groups.ready.map((item) => item.id),
  };
}

/** Ids of todo items whose every `after` dependency is done or dropped, in plan order. */
export function readyIds(items: readonly PlanItem[]): string[] {
  return orderPlan(items).ready;
}

/** Ids that are ready in `after` and were not ready in `before`, in the new ready order. */
export function newlyReady(before: readonly PlanItem[], after: readonly PlanItem[]): string[] {
  const previous = new Set(readyIds(before));
  return readyIds(after).filter((id) => !previous.has(id));
}

function eventSummary(item: Pick<PlanItem, 'id' | 'state' | 'title'>, before: readonly PlanItem[], after: readonly PlanItem[]): string {
  const base = `${item.id} ${item.state}: ${item.title}`;
  const ready = newlyReady(before, after);
  if (ready.length === 0) return base;
  return `${base} → ready: ${ready.join(', ')}`;
}

function rejectUnknown(record: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  const keys = Object.keys(record).filter((key) => record[key] !== undefined);
  for (const key of keys) {
    if (!allowed.has(key)) throw new PlanValidationError(`Unknown plan field: ${key}`);
  }
  return keys;
}

function parsePriority(value: unknown): PlanPriority {
  if (value !== 1 && value !== 2 && value !== 3) throw new PlanValidationError('priority must be 1, 2 or 3');
  return value;
}

function parseState(value: unknown): PlanState {
  if (typeof value !== 'string' || !(PLAN_STATES as readonly string[]).includes(value)) {
    throw new PlanValidationError(`state must be one of: ${PLAN_STATES.join(', ')}`);
  }
  return value as PlanState;
}

function parseSessionId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new PlanValidationError('sessionId must be a string');
  if (!SESSION_ID_RE.test(value)) throw new PlanValidationError('sessionId is invalid');
  return value;
}

function parseItemId(value: unknown): string {
  if (typeof value !== 'string' || !ITEM_ID_RE.test(value)) throw new PlanValidationError('plan item id is invalid');
  return value;
}

/**
 * `selfId`, when set, is the item being edited (or the id about to be allocated).
 * Existence is checked against `items`, which does not include an item still being added.
 */
function parseAfter(value: unknown, items: readonly PlanItem[], selfId: string | null): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new PlanValidationError('after must be an array of item ids');
  }
  const ids = value as string[];
  if (ids.length > PLAN_LIMITS.after) {
    throw new PlanValidationError(`after must list at most ${PLAN_LIMITS.after} items`);
  }
  const known = new Set(items.map((item) => item.id));
  const seen = new Set<string>();
  for (const id of ids) {
    if (!ITEM_ID_RE.test(id)) throw new PlanValidationError(`after id ${id} is invalid`);
    if (seen.has(id)) throw new PlanValidationError(`duplicate after id ${id}`);
    seen.add(id);
    if (selfId !== null && id === selfId) throw new PlanValidationError('plan item cannot depend on itself');
    if (!known.has(id)) throw new PlanValidationError(`after id ${id} does not exist`);
  }
  return [...ids];
}

/** Depth-first search from the edited item. A back-edge to a visiting node is a cycle. */
function assertNoCycle(items: readonly PlanItem[], startId: string): void {
  const edges = new Map(items.map((item) => [item.id, item.after]));
  const color = new Map<string, 1 | 2>();
  const stack = [startId];
  const nextIndex = [0];
  color.set(startId, 1);
  while (stack.length > 0) {
    const depth = stack.length - 1;
    const id = stack[depth];
    const after = id === undefined ? [] : edges.get(id) ?? [];
    const index = nextIndex[depth] ?? 0;
    if (id === undefined || index >= after.length) {
      if (id !== undefined) color.set(id, 2);
      stack.pop();
      nextIndex.pop();
      continue;
    }
    nextIndex[depth] = index + 1;
    const next = after[index];
    if (next === undefined) continue;
    const mark = color.get(next);
    if (mark === 1) throw new PlanValidationError('plan after contains a cycle');
    if (mark === 2 || !edges.has(next)) continue;
    color.set(next, 1);
    stack.push(next);
    nextIndex.push(0);
  }
}

function buildItem(fields: PlanItem): PlanItem {
  const item: PlanItem = {
    id: fields.id,
    title: fields.title,
    after: fields.after,
    priority: fields.priority,
    state: fields.state,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
  };
  if (fields.note !== undefined) item.note = fields.note;
  if (fields.sessionId !== undefined) item.sessionId = fields.sessionId;
  return item;
}

export function applyAdd(plan: SessionPlan | null | undefined, input: unknown, now: string): SessionPlan {
  const stamp = requireNow(now);
  const current = asPlan(plan);
  const record = asRecord(input, 'plan add');
  const keys = rejectUnknown(record, ADD_KEYS);
  if (!keys.includes('title')) throw new PlanValidationError('title is required');
  if (current.items.length >= PLAN_LIMITS.items) {
    throw new PlanValidationError(`plan is limited to ${PLAN_LIMITS.items} items`);
  }
  const id = `p${current.seq}`;
  if (!ITEM_ID_RE.test(id)) throw new PlanValidationError('plan sequence is exhausted');
  if (current.items.some((item) => item.id === id)) throw new PlanValidationError(`plan id ${id} already exists`);

  const title = cleanText(record.title, 'title', 1, PLAN_LIMITS.title);
  // A note that cleans to nothing is omitted. Patch still rejects an empty note; null clears there.
  let note: string | undefined;
  if (keys.includes('note')) {
    const cleaned = cleanText(record.note, 'note', 0, PLAN_LIMITS.note);
    if (cleaned !== '') note = cleaned;
  }
  const after = keys.includes('after') ? parseAfter(record.after, current.items, id) : [];
  const priority = keys.includes('priority') ? parsePriority(record.priority) : 2;
  const created: PlanItem = buildItem({
    id,
    title,
    after,
    priority,
    state: 'todo',
    ...(note !== undefined ? { note } : {}),
    createdAt: stamp,
    updatedAt: stamp,
  });
  const items = [...current.items.map(cloneItem), created];
  assertNoCycle(items, id);
  return { seq: current.seq + 1, items };
}

function parsePatch(input: unknown): ParsedPatch {
  const record = asRecord(input, 'plan update');
  const keys = rejectUnknown(record, PATCH_KEYS);
  if (!keys.includes('id')) throw new PlanValidationError('plan item id is invalid');
  const parsed: ParsedPatch = {
    id: parseItemId(record.id),
    hasTitle: keys.includes('title'),
    hasNote: keys.includes('note'),
    hasAfter: keys.includes('after'),
    hasPriority: keys.includes('priority'),
    hasState: keys.includes('state'),
    hasSessionId: keys.includes('sessionId'),
  };
  if (!parsed.hasTitle && !parsed.hasNote && !parsed.hasAfter && !parsed.hasPriority && !parsed.hasState && !parsed.hasSessionId) {
    throw new PlanValidationError('Empty plan update');
  }
  if (parsed.hasTitle) parsed.title = cleanText(record.title, 'title', 1, PLAN_LIMITS.title);
  if (parsed.hasNote) {
    parsed.note = record.note === null ? null : cleanText(record.note, 'note', 1, PLAN_LIMITS.note);
  }
  if (parsed.hasPriority) parsed.priority = parsePriority(record.priority);
  // Any state may follow any other state. There is no transition table.
  if (parsed.hasState) parsed.state = parseState(record.state);
  if (parsed.hasSessionId) parsed.sessionId = parseSessionId(record.sessionId);
  return parsed;
}

/** Validates a patch and returns the updated plan. `applyPatch` delegates here. */
export function validatePatch(plan: SessionPlan | null | undefined, input: unknown, now: string): SessionPlan {
  const stamp = requireNow(now);
  const current = asPlan(plan);
  const parsed = parsePatch(input);
  // `after` existence uses the pre-edit items. Parse before replacing the target.
  const existing = current.items.find((item) => item.id === parsed.id);
  if (!existing) throw new PlanValidationError(`Plan item ${parsed.id} does not exist`);
  if (parsed.hasAfter) parsed.after = parseAfter(recordAfter(input), current.items, parsed.id);

  const title = parsed.hasTitle ? parsed.title ?? existing.title : existing.title;
  let note = existing.note;
  if (parsed.hasNote) note = parsed.note === null ? undefined : parsed.note;
  const after = parsed.hasAfter ? parsed.after ?? [] : [...existing.after];
  const priority = parsed.hasPriority ? parsed.priority ?? existing.priority : existing.priority;
  const state = parsed.hasState ? parsed.state ?? existing.state : existing.state;
  let sessionId = existing.sessionId;
  if (parsed.hasSessionId) sessionId = parsed.sessionId === null ? undefined : parsed.sessionId;
  // Setting state to todo drops the child link. An explicit sessionId in the same patch does not keep it.
  if (parsed.hasState && parsed.state === 'todo') sessionId = undefined;

  const updated = buildItem({
    id: existing.id,
    title,
    after,
    priority,
    state,
    ...(note !== undefined ? { note } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    createdAt: existing.createdAt,
    updatedAt: stamp,
  });
  const items = current.items.map((item) => (item.id === existing.id ? updated : cloneItem(item)));
  if (parsed.hasAfter) assertNoCycle(items, existing.id);
  return { seq: current.seq, items };
}

function recordAfter(input: unknown): unknown {
  const record = asRecord(input, 'plan update');
  return record.after;
}

export function applyPatch(plan: SessionPlan | null | undefined, input: unknown, now: string): SessionPlan {
  return validatePatch(plan, input, now);
}

export function applyRemove(plan: SessionPlan | null | undefined, input: unknown, now: string): SessionPlan {
  requireNow(now);
  const current = asPlan(plan);
  const id = typeof input === 'string' || input == null || typeof input !== 'object'
    ? parseItemId(input)
    : parseItemId(asRecord(input, 'plan remove').id);
  if (!current.items.some((item) => item.id === id)) throw new PlanValidationError(`Plan item ${id} does not exist`);
  // Survivors keep their timestamps. Only the dependency edge is removed, so a pure
  // unlink does not reshuffle started/done/dropped order.
  const items = current.items
    .filter((item) => item.id !== id)
    .map((item) => cloneItem({ ...item, after: item.after.filter((afterId) => afterId !== id) }));
  return { seq: current.seq, items };
}

/**
 * Reloads the parent before every save. Each successful change publishes the saved
 * session, then emits one `plan` summary — `<id> <state>: <title>`, plus
 * ` → ready: <id>, <id>` when items became ready. An emit failure is warned and
 * does not undo the publish.
 */
export class PlanStore {
  constructor(private readonly deps: PlanStoreDeps) {}

  async get(parentId: string): Promise<SessionPlan | null> {
    const session = await this.deps.loadSession(parentId);
    if (!session?.plan || !Array.isArray(session.plan.items)) return null;
    return { seq: session.plan.seq, items: session.plan.items.map(cloneItem) };
  }

  async add(parentId: string, input: PlanAddInput): Promise<PlanItem> {
    const change = await this.change(parentId, (plan) => {
      const next = applyAdd(plan, input, this.stamp());
      const created = next.items.find((item) => !plan.items.some((existing) => existing.id === item.id));
      if (!created) throw new PlanValidationError('plan item was not created');
      return { plan: next, summary: eventSummary(created, plan.items, next.items), item: created };
    });
    if (!change.item) throw new PlanValidationError('plan item was not created');
    return change.item;
  }

  async patch(parentId: string, itemId: string, input: PlanPatchInput): Promise<PlanItem> {
    const change = await this.change(parentId, (plan) => {
      const next = validatePatch(plan, { ...input, id: itemId }, this.stamp());
      const updated = next.items.find((item) => item.id === itemId);
      if (!updated) throw new PlanValidationError(`Plan item ${itemId} does not exist`);
      return { plan: next, summary: eventSummary(updated, plan.items, next.items), item: updated };
    });
    if (!change.item) throw new PlanValidationError(`Plan item ${itemId} does not exist`);
    return change.item;
  }

  async remove(parentId: string, itemId: string): Promise<void> {
    await this.change(parentId, (plan) => {
      const existing = plan.items.find((item) => item.id === itemId);
      if (!existing) throw new PlanValidationError(`Plan item ${itemId} does not exist`);
      const next = applyRemove(plan, itemId, this.stamp());
      return { plan: next, summary: eventSummary(existing, plan.items, next.items) };
    });
  }

  /** Binds a todo item to a child: state `started`, sessionId = childId. */
  async startForChild(parentId: string, itemId: string, childId: string): Promise<void> {
    await this.change(parentId, (plan) => {
      const current = plan.items.find((item) => item.id === itemId);
      if (!current) throw new PlanValidationError(`Plan item ${itemId} does not exist`);
      if (current.state !== 'todo') throw new PlanValidationError(`Plan item ${itemId} is ${current.state}, not todo`);
      const next = applyPatch(plan, { id: itemId, state: 'started', sessionId: childId }, this.stamp());
      const updated = next.items.find((item) => item.id === itemId);
      if (!updated) throw new PlanValidationError(`Plan item ${itemId} does not exist`);
      return { plan: next, summary: eventSummary(updated, plan.items, next.items), item: updated };
    });
  }

  /**
   * Marks every item with this child and state `started` as `done`.
   * No match, or a missing parent, is a no-op: a failed card stays `started` for the manager.
   */
  async completeForChild(parentId: string, childId: string): Promise<void> {
    const seen = await this.deps.loadSession(parentId);
    if (!seen) return;
    const fresh = await this.deps.loadSession(parentId);
    if (!fresh?.plan) return;
    const matches = fresh.plan.items.filter((item) => item.sessionId === childId && item.state === 'started');
    if (matches.length === 0) return;
    const stamp = this.stamp();
    let next = fresh.plan;
    for (const match of matches) {
      next = applyPatch(next, { id: match.id, state: 'done' }, stamp);
    }
    const primary = next.items.find((item) => item.id === matches[0]?.id);
    if (!primary) return;
    await this.persist(fresh, { plan: next, summary: eventSummary(primary, fresh.plan.items, next.items), item: primary });
  }

  private stamp(): string {
    return new Date(this.deps.now()).toISOString();
  }

  private async change(parentId: string, mutate: (plan: SessionPlan) => Change): Promise<Change> {
    const seen = await this.deps.loadSession(parentId);
    if (!seen) throw new Error('Session not found');
    const fresh = await this.deps.loadSession(parentId);
    if (!fresh) throw new Error('Session not found');
    const result = mutate(fresh.plan ?? emptyPlan());
    await this.persist(fresh, result);
    return result;
  }

  private async persist(fresh: Session, result: Change): Promise<void> {
    const saved: Session = { ...fresh, plan: result.plan };
    await this.deps.saveSession(saved);
    await this.deps.publishSession(saved);
    try {
      await this.deps.emit(saved, result.summary);
    } catch (error) {
      console.warn('PlanStore emit failed', error);
    }
  }
}
