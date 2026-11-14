import { PLAN_STATES, PlanValidationError, type PlanPriority, type PlanState } from './contract-c.js';
import { orderPlan, type PlanAddInput, type PlanPatchInput, type PlanStore } from './plan.js';
import { RouteError, type RouteContext, type RouteModule } from './contract-b.js';

const PLAN_PATTERN = /^\/api\/sessions\/([^/]+)\/plan$/;
const ITEM_PATTERN = /^\/api\/sessions\/([^/]+)\/plan\/(p\d{1,6})$/;

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requireOnlyKeys(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new RouteError(400, `Unknown body key: ${key}`);
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new RouteError(400, `${key} must be a string`);
  return value;
}

function parseOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  if (!hasOwn(body, key) || body[key] === undefined) return undefined;
  return requireString(body, key);
}

function parseNullableString(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!hasOwn(body, key) || body[key] === undefined) return undefined;
  if (body[key] === null) return null;
  return requireString(body, key);
}

function parseOptionalAfter(body: Record<string, unknown>): string[] | undefined {
  if (!hasOwn(body, 'after') || body.after === undefined) return undefined;
  const value = body.after;
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new RouteError(400, 'after must be an array of item ids');
  }
  return value as string[];
}

function parseOptionalPriority(body: Record<string, unknown>): PlanPriority | undefined {
  if (!hasOwn(body, 'priority') || body.priority === undefined) return undefined;
  const value = body.priority;
  if (value !== 1 && value !== 2 && value !== 3) throw new RouteError(400, 'priority must be 1, 2 or 3');
  return value;
}

function parseOptionalState(body: Record<string, unknown>): PlanState | undefined {
  if (!hasOwn(body, 'state') || body.state === undefined) return undefined;
  const value = body.state;
  if (typeof value !== 'string' || !(PLAN_STATES as readonly string[]).includes(value)) {
    throw new RouteError(400, `state must be one of: ${PLAN_STATES.join(', ')}`);
  }
  return value as PlanState;
}

function parseAddBody(body: Record<string, unknown>): PlanAddInput {
  requireOnlyKeys(body, ['title', 'note', 'after', 'priority']);
  if (!hasOwn(body, 'title') || body.title === undefined) throw new RouteError(400, 'title is required');
  const input: PlanAddInput = { title: requireString(body, 'title') };
  const note = parseOptionalString(body, 'note');
  if (note !== undefined) input.note = note;
  const after = parseOptionalAfter(body);
  if (after !== undefined) input.after = after;
  const priority = parseOptionalPriority(body);
  if (priority !== undefined) input.priority = priority;
  return input;
}

function parsePatchBody(body: Record<string, unknown>): PlanPatchInput {
  requireOnlyKeys(body, ['title', 'note', 'after', 'priority', 'state', 'sessionId']);
  const input: PlanPatchInput = {};
  const title = parseOptionalString(body, 'title');
  if (title !== undefined) input.title = title;
  const note = parseNullableString(body, 'note');
  if (note !== undefined) input.note = note;
  const after = parseOptionalAfter(body);
  if (after !== undefined) input.after = after;
  const priority = parseOptionalPriority(body);
  if (priority !== undefined) input.priority = priority;
  const state = parseOptionalState(body);
  if (state !== undefined) input.state = state;
  const sessionId = parseNullableString(body, 'sessionId');
  if (sessionId !== undefined) input.sessionId = sessionId;
  return input;
}

/**
 * Maps the store's errors to HTTP statuses: a vanished item or session → 404,
 * any other PlanValidationError → 400, everything else untouched.
 */
async function storeCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof PlanValidationError) {
      if (/does not exist/.test(error.message)) throw new RouteError(404, error.message);
      throw new RouteError(400, error.message);
    }
    if (error instanceof Error && error.message === 'Session not found') {
      throw new RouteError(404, 'Session not found');
    }
    throw error;
  }
}

async function loadSessionOr404(ctx: RouteContext, id: string) {
  const session = await ctx.loadSession(id);
  if (!session) throw new RouteError(404, 'Session not found');
  return session;
}

function requireItemOr404(session: { plan?: { items: Array<{ id: string }> } | null }, itemId: string): void {
  if (!session.plan?.items.some((item) => item.id === itemId)) {
    throw new RouteError(404, 'Plan item not found');
  }
}

/**
 * Route module factory for PLAN_ROUTES:
 *   GET    /api/sessions/:id/plan            → PlanView (ordered via orderPlan)
 *   POST   /api/sessions/:id/plan            → { item }  (body { title, note?, after?, priority? })
 *   PATCH  /api/sessions/:id/plan/:itemId    → { item }  (body { title?, note?: string|null, after?, priority?, state?, sessionId?: string|null })
 *   DELETE /api/sessions/:id/plan/:itemId    → { ok: true }
 * Strict bodies (unknown keys → 400), PlanValidationError → 400 (a store-reported missing
 * item or session → 404), unknown session/item → 404, wrong method → 405.
 * Item ids must match p\d{1,6}; other paths fall through (returns false).
 */
export function createPlanRoutes(store: PlanStore): RouteModule {
  return async (ctx: RouteContext): Promise<boolean> => {
    const planMatch = PLAN_PATTERN.exec(ctx.path);
    if (planMatch) {
      const id = planMatch[1];
      if (ctx.method === 'GET') {
        await loadSessionOr404(ctx, id);
        const plan = await store.get(id);
        ctx.json(200, orderPlan(plan?.items ?? []));
        return true;
      }
      if (ctx.method === 'POST') {
        await loadSessionOr404(ctx, id);
        const input = parseAddBody(await ctx.parseBody());
        const item = await storeCall(() => store.add(id, input));
        ctx.json(200, { item });
        return true;
      }
      throw new RouteError(405, 'Method not allowed');
    }

    const itemMatch = ITEM_PATTERN.exec(ctx.path);
    if (itemMatch) {
      const [id, itemId] = [itemMatch[1], itemMatch[2]];
      if (ctx.method === 'PATCH') {
        const session = await loadSessionOr404(ctx, id);
        requireItemOr404(session, itemId);
        const input = parsePatchBody(await ctx.parseBody());
        const item = await storeCall(() => store.patch(id, itemId, input));
        ctx.json(200, { item });
        return true;
      }
      if (ctx.method === 'DELETE') {
        const session = await loadSessionOr404(ctx, id);
        requireItemOr404(session, itemId);
        await storeCall(() => store.remove(id, itemId));
        ctx.json(200, { ok: true });
        return true;
      }
      throw new RouteError(405, 'Method not allowed');
    }

    return false;
  };
}
