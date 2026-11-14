import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Session } from '../types.js';
import { PlanValidationError, type PlanItem, type PlanState, type SessionPlan } from './contract-c.js';
import { orderPlan, type PlanStore } from './plan.js';
import { RouteError, type RouteContext } from './contract-b.js';
import { createPlanRoutes } from './routes-plan.js';

function makeSession(id: string, plan?: SessionPlan): Session {
  const session: Session = {
    id,
    name: `name-${id}`,
    command: 'shell',
    status: 'running',
    bridgeId: 'bridge-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  if (plan) session.plan = plan;
  return session;
}

function item(overrides: Partial<PlanItem> & { id: string }): PlanItem {
  return {
    title: `title-${overrides.id}`,
    after: [],
    priority: 2,
    state: 'todo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface StoreCalls {
  get: Array<string>;
  add: Array<{ id: string; input: unknown }>;
  patch: Array<{ id: string; itemId: string; input: unknown }>;
  remove: Array<{ id: string; itemId: string }>;
}

interface FakeStoreOptions {
  fail?: (method: string) => never | void;
}

/** Fake PlanStore: mutates session.plan in the shared session map like the real store, records calls. */
function makeStore(sessions: Map<string, Session>, options: FakeStoreOptions = {}): { store: PlanStore; calls: StoreCalls } {
  const calls: StoreCalls = { get: [], add: [], patch: [], remove: [] };
  const fail = options.fail;
  const cleanPatch = (input: Record<string, unknown>): Record<string, unknown> => {
    const patch = { ...input };
    if (patch.state === 'todo' || patch.sessionId === null) delete patch.sessionId;
    if (patch.note === null) delete patch.note;
    return patch;
  };
  const store = {
    get: async (id: string) => {
      calls.get.push(id);
      fail?.('get');
      return sessions.get(id)?.plan ?? null;
    },
    add: async (id: string, input: { title: string }) => {
      calls.add.push({ id, input });
      fail?.('add');
      const session = sessions.get(id);
      if (!session) throw new Error('Session not found');
      const seq = (session.plan?.seq ?? 0) + 1;
      const planItem = item({ id: `p${seq}` });
      const saved: Session = { ...session, plan: { items: [...(session.plan?.items ?? []), planItem], seq } };
      sessions.set(id, saved);
      return planItem;
    },
    patch: async (id: string, itemId: string, input: Record<string, unknown>) => {
      calls.patch.push({ id, itemId, input });
      fail?.('patch');
      const session = sessions.get(id);
      const target = session?.plan?.items.find((plan) => plan.id === itemId);
      if (!session?.plan || !target) throw new PlanValidationError(`Plan item ${itemId} does not exist`);
      const next = { ...target, ...cleanPatch(input), updatedAt: '2026-01-02T00:00:00.000Z' } as PlanItem & Record<string, unknown>;
      for (const key of Object.keys(next)) {
        if (next[key] === undefined) delete next[key];
      }
      const items = session.plan.items.map((plan) => (plan.id === itemId ? next as unknown as PlanItem : plan));
      const saved: Session = { ...session, plan: { items, seq: session.plan.seq } };
      sessions.set(id, saved);
      return next as unknown as PlanItem;
    },
    remove: async (id: string, itemId: string) => {
      calls.remove.push({ id, itemId });
      fail?.('remove');
      const session = sessions.get(id);
      const target = session?.plan?.items.find((plan) => plan.id === itemId);
      if (!session?.plan || !target) throw new PlanValidationError(`Plan item ${itemId} does not exist`);
      const items = session.plan.items
        .filter((plan) => plan.id !== itemId)
        .map((plan) => ({ ...plan, after: plan.after.filter((after) => after !== itemId) }));
      const saved: Session = { ...session, plan: { items, seq: session.plan.seq } };
      sessions.set(id, saved);
    },
  };
  return { store: store as unknown as PlanStore, calls };
}

interface jsonResponse { status: number; body: unknown }

function makeCtx(sessions: Map<string, Session>, method: string, path: string, body?: unknown): RouteContext & { responses: jsonResponse[] } {
  const responses: jsonResponse[] = [];
  return {
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    method,
    path,
    query: new URLSearchParams(),
    parseBody: async () => body as Record<string, unknown>,
    json(status, result) { responses.push({ status, body: result }); },
    loadSession: async (id) => sessions.get(id) ?? null,
    saveSession: async () => {},
    publishSession: () => {},
    responses,
  };
}

async function expectRouteError(promise: Promise<unknown>, status: number, message?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RouteError);
    assert.equal(error.status, status);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

test('returns false for non-matching paths', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1')]]);
  const { store } = makeStore(sessions);
  const handle = createPlanRoutes(store);
  for (const path of [
    '/api/sessions/s1/plans',
    '/api/sessions/s1/plan/p1/extra',
    '/api/sessions/s1/brief',
    '/api/plan',
  ]) {
    const ctx = makeCtx(sessions, 'GET', path);
    assert.equal(await handle(ctx), false);
    assert.equal(ctx.responses.length, 0);
  }
});

test('GET returns the ordered PlanView and an empty view when there is no plan', async () => {
  const plan: SessionPlan = {
    items: [
      item({ id: 'p5', state: 'done', updatedAt: '2026-01-03T00:00:00.000Z' }),
      item({ id: 'p2', state: 'todo', priority: 1, createdAt: '2026-01-02T00:00:00.000Z' }),
      item({ id: 'p4', state: 'started' }),
      item({ id: 'p1', state: 'todo', after: ['p2'] }),
      item({ id: 'p3', state: 'todo', priority: 1, createdAt: '2026-01-03T00:00:00.000Z' }),
      item({ id: 'p6', state: 'dropped' }),
    ],
    seq: 6,
  };
  const sessions = new Map<string, Session>([
    ['s1', makeSession('s1', plan)],
    ['s2', makeSession('s2')],
  ]);
  const { store, calls } = makeStore(sessions);
  const handle = createPlanRoutes(store);

  const ctx1 = makeCtx(sessions, 'GET', '/api/sessions/s1/plan');
  assert.equal(await handle(ctx1), true);
  assert.deepEqual(ctx1.responses, [{ status: 200, body: orderPlan(plan.items) }]);
  const body = ctx1.responses[0].body as { items: PlanItem[]; ready: string[] };
  assert.deepEqual(body.items.map((planItem) => planItem.id), ['p2', 'p3', 'p1', 'p4', 'p5', 'p6']);
  assert.deepEqual(body.ready, ['p2', 'p3']);
  assert.deepEqual(calls.get, ['s1']);

  const ctx2 = makeCtx(sessions, 'GET', '/api/sessions/s2/plan');
  assert.equal(await handle(ctx2), true);
  assert.deepEqual(ctx2.responses, [{ status: 200, body: { items: [], ready: [] } }]);
});

test('GET unknown session → 404', async () => {
  const sessions = new Map<string, Session>();
  const { store } = makeStore(sessions);
  const handle = createPlanRoutes(store);
  const ctx = makeCtx(sessions, 'GET', '/api/sessions/missing/plan');
  await expectRouteError(handle(ctx), 404);
});

test('POST adds an item and returns { item }', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1')]]);
  const { store, calls } = makeStore(sessions);
  const handle = createPlanRoutes(store);
  const ctx = makeCtx(sessions, 'POST', '/api/sessions/s1/plan', { title: '  Ship it  ', note: 'today', after: ['p1'], priority: 1 });
  assert.equal(await handle(ctx), true);
  assert.deepEqual(ctx.responses, [{ status: 200, body: { item: item({ id: 'p1' }) } }]);
  assert.deepEqual(calls.add, [{ id: 's1', input: { title: '  Ship it  ', note: 'today', after: ['p1'], priority: 1 } }]);
});

test('POST strict body: unknown keys, missing title and bad types → 400', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1')]]);
  const { store } = makeStore(sessions);
  const handle = createPlanRoutes(store);
  await expectRouteError(handle(makeCtx(sessions, 'POST', '/api/sessions/s1/plan', { title: 'x', note: 'y', state: 'done' })), 400, 'Unknown body key: state');
  await expectRouteError(handle(makeCtx(sessions, 'POST', '/api/sessions/s1/plan', {})), 400, 'title is required');
  await expectRouteError(handle(makeCtx(sessions, 'POST', '/api/sessions/s1/plan', { title: 5 })), 400, 'title must be a string');
  await expectRouteError(handle(makeCtx(sessions, 'POST', '/api/sessions/s1/plan', { title: 'x', after: 'p1' })), 400, 'after must be an array of item ids');
  await expectRouteError(handle(makeCtx(sessions, 'POST', '/api/sessions/s1/plan', { title: 'x', after: [1] })), 400, 'after must be an array of item ids');
  await expectRouteError(handle(makeCtx(sessions, 'POST', '/api/sessions/s1/plan', { title: 'x', priority: 4 })), 400, 'priority must be 1, 2 or 3');
  await expectRouteError(handle(makeCtx(sessions, 'POST', '/api/sessions/s1/plan', { title: 'x', note: null })), 400, 'note must be a string');
});

test('POST unknown session → 404', async () => {
  const sessions = new Map<string, Session>();
  const { store } = makeStore(sessions);
  const handle = createPlanRoutes(store);
  await expectRouteError(handle(makeCtx(sessions, 'POST', '/api/sessions/missing/plan', { title: 'x' })), 404);
});

test('POST PlanValidationError from the store → 400 with the message', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1')]]);
  const { store } = makeStore(sessions, { fail: (method) => { if (method === 'add') throw new PlanValidationError('title must not be empty'); } });
  const handle = createPlanRoutes(store);
  await expectRouteError(handle(makeCtx(sessions, 'POST', '/api/sessions/s1/plan', { title: '   ' })), 400, 'title must not be empty');
});

test('PATCH forwards fields incl. nulls, validates state, returns { item }', async () => {
  const plan: SessionPlan = { items: [item({ id: 'p1' })], seq: 1 };
  const sessions = new Map<string, Session>([['s1', makeSession('s1', plan)]]);
  const { store, calls } = makeStore(sessions);
  const handle = createPlanRoutes(store);

  const ctx = makeCtx(sessions, 'PATCH', '/api/sessions/s1/plan/p1', { state: 'done', note: null, sessionId: null, priority: 3 });
  assert.equal(await handle(ctx), true);
  assert.deepEqual(ctx.responses, [{ status: 200, body: { item: item({ id: 'p1', state: 'done', priority: 3, updatedAt: '2026-01-02T00:00:00.000Z' }) } }]);
  assert.deepEqual(calls.patch, [{ id: 's1', itemId: 'p1', input: { state: 'done', note: null, sessionId: null, priority: 3 } }]);

  await expectRouteError(handle(makeCtx(sessions, 'PATCH', '/api/sessions/s1/plan/p1', { nope: 1 })), 400, 'Unknown body key: nope');
  await expectRouteError(handle(makeCtx(sessions, 'PATCH', '/api/sessions/s1/plan/p1', { state: 'finished' })), 400, 'state must be one of: todo, started, done, dropped');
  await expectRouteError(handle(makeCtx(sessions, 'PATCH', '/api/sessions/s1/plan/p1', { sessionId: 7 })), 400, 'sessionId must be a string');
});

test('PATCH unknown session or item → 404', async () => {
  const plan: SessionPlan = { items: [item({ id: 'p1' })], seq: 1 };
  const sessions = new Map<string, Session>([['s1', makeSession('s1', plan)]]);
  const { store } = makeStore(sessions);
  const handle = createPlanRoutes(store);
  await expectRouteError(handle(makeCtx(new Map(), 'PATCH', '/api/sessions/missing/plan/p1', {})), 404);
  await expectRouteError(handle(makeCtx(sessions, 'PATCH', '/api/sessions/s1/plan/p9', {})), 404);
});

test('DELETE removes the item and returns { ok: true }', async () => {
  const plan: SessionPlan = { items: [item({ id: 'p1' })], seq: 1 };
  const sessions = new Map<string, Session>([['s1', makeSession('s1', plan)]]);
  const { store, calls } = makeStore(sessions);
  const handle = createPlanRoutes(store);
  const ctx = makeCtx(sessions, 'DELETE', '/api/sessions/s1/plan/p1');
  assert.equal(await handle(ctx), true);
  assert.deepEqual(ctx.responses, [{ status: 200, body: { ok: true } }]);
  assert.deepEqual(calls.remove, [{ id: 's1', itemId: 'p1' }]);
  await expectRouteError(handle(makeCtx(sessions, 'DELETE', '/api/sessions/s1/plan/p1')), 404);
});

test('non-matching item ids fall through (returns false)', async () => {
  const plan: SessionPlan = { items: [item({ id: 'p1' })], seq: 1 };
  const sessions = new Map<string, Session>([['s1', makeSession('s1', plan)]]);
  const { store } = makeStore(sessions);
  const handle = createPlanRoutes(store);
  for (const path of ['/api/sessions/s1/plan/xyz', '/api/sessions/s1/plan/p1234567', '/api/sessions/s1/plan/P1']) {
    const ctx = makeCtx(sessions, 'DELETE', path);
    assert.equal(await handle(ctx), false);
    assert.equal(ctx.responses.length, 0);
  }
});

test('store reporting a missing item or session after the pre-check → 404', async () => {
  const plan: SessionPlan = { items: [item({ id: 'p1' })], seq: 1 };
  const sessions = new Map<string, Session>([['s1', makeSession('s1', plan)]]);
  const { store } = makeStore(sessions, {
    fail: (method) => {
      if (method === 'patch') throw new PlanValidationError('Plan item p1 does not exist');
      if (method === 'remove') throw new Error('Session not found');
    },
  });
  const handle = createPlanRoutes(store);
  await expectRouteError(handle(makeCtx(sessions, 'PATCH', '/api/sessions/s1/plan/p1', { state: 'done' })), 404, 'Plan item p1 does not exist');
  await expectRouteError(handle(makeCtx(sessions, 'DELETE', '/api/sessions/s1/plan/p1')), 404, 'Session not found');
});

test('wrong methods → 405', async () => {
  const plan: SessionPlan = { items: [item({ id: 'p1' })], seq: 1 };
  const sessions = new Map<string, Session>([['s1', makeSession('s1', plan)]]);
  const { store } = makeStore(sessions);
  const handle = createPlanRoutes(store);
  await expectRouteError(handle(makeCtx(sessions, 'PUT', '/api/sessions/s1/plan', { title: 'x' })), 405);
  await expectRouteError(handle(makeCtx(sessions, 'GET', '/api/sessions/s1/plan/p1')), 405);
  await expectRouteError(handle(makeCtx(sessions, 'POST', '/api/sessions/s1/plan/p1', { title: 'x' })), 405);
});
