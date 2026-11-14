import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../types.js';
import { PlanValidationError, type PlanItem, type PlanState, type SessionPlan } from './contract-c.js';
import {
  PlanStore,
  applyAdd,
  applyPatch,
  applyRemove,
  newlyReady,
  orderPlan,
  readyIds,
  validatePatch,
} from './plan.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';
const T3 = '2026-01-04T00:00:00.000Z';
const NOW = '2026-01-05T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function item(partial: Partial<PlanItem> & { id: string }): PlanItem {
  return {
    title: `title-${partial.id}`,
    after: [],
    priority: 2,
    state: 'todo',
    createdAt: T0,
    updatedAt: T0,
    ...partial,
  };
}

function ids(entries: readonly PlanItem[]): string[] {
  return entries.map((entry) => entry.id);
}

function expectPlanError(run: () => unknown, message?: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof PlanValidationError);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

function makeSession(id: string, plan?: SessionPlan): Session {
  const session: Session = {
    id,
    name: `name-${id}`,
    command: 'shell',
    status: 'running',
    bridgeId: 'bridge-1',
    createdAt: T0,
    updatedAt: T0,
    workingDir: '/tmp/work',
  };
  if (plan) session.plan = plan;
  return session;
}

interface Harness {
  sessions: Map<string, Session>;
  emitted: Array<{ session: Session; summary: string }>;
  published: Session[];
  stats: { loads: number; saves: number };
  store: PlanStore;
}

function makeHarness(): Harness {
  const sessions = new Map<string, Session>();
  const emitted: Array<{ session: Session; summary: string }> = [];
  const published: Session[] = [];
  const stats = { loads: 0, saves: 0 };
  const store = new PlanStore({
    loadSession: async (id) => {
      stats.loads += 1;
      const session = sessions.get(id);
      return session ? structuredClone(session) : null;
    },
    saveSession: async (session) => {
      stats.saves += 1;
      sessions.set(session.id, structuredClone(session));
    },
    publishSession: (session) => { published.push(session); },
    emit: async (session, summary) => { emitted.push({ session, summary }); },
    now: () => NOW_MS,
  });
  return { sessions, emitted, published, stats, store };
}

test('orderPlan sorts ready, waiting, started, done, dropped and does not mutate input', () => {
  const items = [
    item({ id: 'p40', state: 'done', createdAt: T2, updatedAt: T0 }),
    item({ id: 'p3', priority: 1, createdAt: T1 }),
    item({ id: 'p31', state: 'started', createdAt: T0, updatedAt: T2 }),
    item({ id: 'p9', after: ['p1'] }),
    item({ id: 'p21', state: 'dropped', updatedAt: T2 }),
    item({ id: 'p1' }),
    item({ id: 'p22', state: 'started', createdAt: T2, updatedAt: T1 }),
    item({ id: 'p6', createdAt: T3, after: ['p21'] }),
    item({ id: 'p51', state: 'dropped', updatedAt: T1 }),
    item({ id: 'p8', priority: 1, after: ['p22'] }),
    item({ id: 'p20', state: 'done', createdAt: T3, updatedAt: T1 }),
    item({ id: 'p4' }),
    item({ id: 'p10', createdAt: T1, after: ['p20', 'p22'] }),
    item({ id: 'p2', priority: 1, createdAt: T2, after: ['p20'] }),
    item({ id: 'p50', state: 'dropped' }),
    item({ id: 'p30', state: 'started', createdAt: T3, updatedAt: T0 }),
    item({ id: 'p41', state: 'done', updatedAt: T2 }),
  ];
  const before = ids(items);
  const view = orderPlan(items);

  assert.deepEqual(ids(view.items), [
    'p3', 'p2', 'p1', 'p4', 'p6',
    'p8', 'p9', 'p10',
    'p30', 'p22', 'p31',
    'p41', 'p20', 'p40',
    'p21', 'p51', 'p50',
  ]);
  assert.deepEqual(view.ready, ['p3', 'p2', 'p1', 'p4', 'p6']);
  assert.deepEqual(ids(items), before);

  const tied = orderPlan([
    item({ id: 'p10', state: 'done', updatedAt: T0 }),
    item({ id: 'p2', state: 'done', updatedAt: T0 }),
  ]);
  assert.deepEqual(ids(tied.items), ['p2', 'p10']);
  const readyTie = orderPlan([item({ id: 'p10' }), item({ id: 'p2' })]);
  assert.deepEqual(ids(readyTie.items), ['p2', 'p10']);
  assert.deepEqual(readyTie.ready, ['p2', 'p10']);
  assert.deepEqual(orderPlan([]), { items: [], ready: [] });
});

test('orderPlan matches the route fixture: ready by priority then createdAt, waiting after', () => {
  const items = [
    item({ id: 'p5', state: 'done', updatedAt: T2 }),
    item({ id: 'p2', priority: 1, createdAt: T1 }),
    item({ id: 'p4', state: 'started' }),
    item({ id: 'p1', after: ['p2'] }),
    item({ id: 'p3', priority: 1, createdAt: T2 }),
    item({ id: 'p6', state: 'dropped' }),
  ];
  const view = orderPlan(items);
  assert.deepEqual(ids(view.items), ['p2', 'p3', 'p1', 'p4', 'p5', 'p6']);
  assert.deepEqual(view.ready, ['p2', 'p3']);
  assert.deepEqual(readyIds(items), ['p2', 'p3']);
});

test('newlyReady lists only ids that became ready, in the new precedence order', () => {
  const before = [
    item({ id: 'p1' }),
    item({ id: 'p2', after: ['p3'] }),
    item({ id: 'p3', state: 'started' }),
    item({ id: 'p4', priority: 1, after: ['p3'] }),
  ];
  const done = before.map((entry) => (entry.id === 'p3' ? { ...entry, state: 'done' as PlanState } : entry));
  assert.deepEqual(newlyReady(before, done), ['p4', 'p2']);
  assert.deepEqual(newlyReady(before, before), []);

  const added = [...before, item({ id: 'p5', priority: 1 })];
  assert.deepEqual(newlyReady(before, added), ['p5']);

  const unready = [
    item({ id: 'p1', after: ['p2'] }),
    item({ id: 'p2', state: 'started' }),
  ];
  assert.deepEqual(newlyReady([item({ id: 'p1' }), item({ id: 'p2' })], unready), []);

  const blocked = [item({ id: 'p1' }), item({ id: 'p2', after: ['p1'] })];
  assert.deepEqual(newlyReady(blocked, [item({ id: 'p2' })]), ['p2']);

  const waitingOnStarted = [
    item({ id: 'p1', state: 'started' }),
    item({ id: 'p2', after: ['p1'] }),
  ];
  const dropped = waitingOnStarted.map((entry) => (
    entry.id === 'p1' ? { ...entry, state: 'dropped' as PlanState } : entry
  ));
  assert.deepEqual(newlyReady(waitingOnStarted, dropped), ['p2']);
  const removed = applyRemove({ items: waitingOnStarted, seq: 3 }, 'p1', NOW);
  assert.deepEqual(newlyReady(waitingOnStarted, removed.items), ['p2']);
});

test('applyAdd allocates p<seq>, cleans text, and leaves the input plan untouched', () => {
  const first = applyAdd(undefined, { title: '  Ship\nit  ' }, T0);
  assert.equal(first.seq, 2);
  assert.deepEqual(first.items, [item({
    id: 'p1',
    title: 'Ship it',
    createdAt: T0,
    updatedAt: T0,
  })]);

  const kept = item({ id: 'p1', title: 'Keep', state: 'done' });
  const plan: SessionPlan = { items: [kept], seq: 2 };
  const after = ['p1'];
  const second = applyAdd(plan, { title: 'Hello\u0000world', note: ' a\tb  c ', after, priority: 1 }, T1);
  after.push('p9');
  second.items[0].title = 'Changed';

  assert.equal(plan.seq, 2);
  assert.equal(plan.items.length, 1);
  assert.equal(kept.title, 'Keep');
  assert.deepEqual(after, ['p1', 'p9']);
  assert.equal(second.seq, 3);
  assert.equal(second.items[0].title, 'Changed');
  assert.equal(second.items[1].id, 'p2');
  assert.equal(second.items[1].title, 'Hello world');
  assert.equal(second.items[1].note, 'a b c');
  assert.deepEqual(second.items[1].after, ['p1']);
  assert.equal(second.items[1].priority, 1);
  assert.equal(second.items[1].state, 'todo');
  assert.equal(second.items[1].createdAt, T1);
  assert.equal(second.items[1].updatedAt, T1);
  assert.equal(second.items[1].sessionId, undefined);

  const edge = applyAdd({ items: [], seq: 999_999 }, { title: 'Last' }, NOW);
  assert.equal(edge.items[0].id, 'p999999');
  assert.equal(edge.seq, 1_000_000);
});

test('applyAdd and applyPatch reject limits, bad fields, and unknown keys', () => {
  const full: SessionPlan = {
    items: Array.from({ length: 200 }, (_, index) => item({ id: `p${index + 1}` })),
    seq: 201,
  };
  expectPlanError(() => applyAdd(full, { title: 'Overflow' }, NOW), 'plan is limited to 200 items');
  expectPlanError(() => applyAdd({ items: [], seq: 1_000_000 }, { title: 'X' }, NOW), 'plan sequence is exhausted');
  expectPlanError(() => applyAdd({ items: [item({ id: 'p1' })], seq: 1 }, { title: 'X' }, NOW), 'plan id p1 already exists');
  expectPlanError(() => applyAdd(undefined, {}, NOW), 'title is required');
  expectPlanError(() => applyAdd(undefined, { title: '   ' }, NOW), 'title must not be empty');
  expectPlanError(() => applyAdd(undefined, { title: 'x'.repeat(141) }, NOW), 'title must be at most 140 characters');
  expectPlanError(() => applyAdd(undefined, { title: 5 }, NOW), 'title must be a string');
  const blankNote = applyAdd(undefined, { title: 'Ok', note: ' \n\t ' }, NOW);
  assert.equal(blankNote.items[0].note, undefined);
  assert.equal('note' in blankNote.items[0], false);
  const maxText = applyAdd(undefined, { title: 't'.repeat(140), note: 'n'.repeat(500) }, NOW);
  assert.equal(maxText.items[0].title.length, 140);
  assert.equal(maxText.items[0].note?.length, 500);
  expectPlanError(() => applyAdd(undefined, { title: 'Ok', note: 'n'.repeat(501) }, NOW), 'note must be at most 500 characters');
  expectPlanError(() => applyPatch(blankNote, { id: 'p1', note: ' ' }, NOW), 'note must not be empty');
  expectPlanError(() => applyAdd(undefined, { title: 'Ok', priority: 4 }, NOW), 'priority must be 1, 2 or 3');
  expectPlanError(() => applyAdd(undefined, { title: 'Ok', priority: '1' }, NOW), 'priority must be 1, 2 or 3');
  expectPlanError(() => applyAdd(undefined, { title: 'Ok', state: 'done' }, NOW), 'Unknown plan field: state');
  expectPlanError(() => applyAdd(undefined, { title: 'Ok', after: 'p1' }, NOW), 'after must be an array of item ids');
  expectPlanError(() => applyAdd(undefined, { title: '👍'.repeat(141) }, NOW), 'title must be at most 140 characters');
  const wide = applyAdd(undefined, { title: '👍'.repeat(140) }, NOW);
  assert.equal([...wide.items[0].title].length, 140);

  const deps = Array.from({ length: 20 }, (_, index) => item({ id: `p${index + 1}`, state: 'done' as PlanState }));
  const room: SessionPlan = { items: deps, seq: 21 };
  const accepted = applyAdd(room, { title: 'Child', after: deps.map((entry) => entry.id) }, NOW);
  assert.equal(accepted.items.at(-1)?.after.length, 20);
  expectPlanError(
    () => applyAdd(room, { title: 'Child', after: [...deps.map((entry) => entry.id), 'p1'] }, NOW),
    'after must list at most 20 items',
  );

  const plan = applyAdd(undefined, { title: 'A', note: 'keep' }, T0);
  expectPlanError(() => applyPatch(plan, { id: 'p1' }, T1), 'Empty plan update');
  expectPlanError(() => applyPatch(plan, { id: 'p1', nope: true }, T1), 'Unknown plan field: nope');
  expectPlanError(() => applyPatch(plan, { id: 'p9', title: 'Z' }, T1), 'Plan item p9 does not exist');
  expectPlanError(() => applyPatch(plan, { id: 'nope', title: 'Z' }, T1), 'plan item id is invalid');
  expectPlanError(() => applyPatch(plan, { id: 'p1', state: 'finished' }, T1), 'state must be one of: todo, started, done, dropped');
  expectPlanError(() => applyPatch(plan, { id: 'p1', sessionId: 'bad id' }, T1), 'sessionId is invalid');
  expectPlanError(() => applyPatch(plan, { id: 'p1', sessionId: 7 }, T1), 'sessionId must be a string');
  expectPlanError(() => applyPatch(plan, { id: 'p1', title: 'Ok' }, 'not-a-date'), 'now must be an ISO timestamp');
  expectPlanError(() => applyAdd(null, { title: 'Ok' }, ''), 'now must be an ISO timestamp');
});

test('after must exist, must not be self or duplicated, and must not cycle', () => {
  expectPlanError(
    () => applyAdd(undefined, { title: 'A', after: ['p1'] }, T0),
    'plan item cannot depend on itself',
  );
  expectPlanError(
    () => applyAdd(applyAdd(undefined, { title: 'A' }, T0), { title: 'B', after: ['p9'] }, T1),
    'after id p9 does not exist',
  );
  expectPlanError(
    () => applyAdd(applyAdd(undefined, { title: 'A' }, T0), { title: 'B', after: ['p1', 'p1'] }, T1),
    'duplicate after id p1',
  );
  expectPlanError(
    () => applyAdd(applyAdd(undefined, { title: 'A' }, T0), { title: 'B', after: ['nope'] }, T1),
    'after id nope is invalid',
  );

  const linear = applyAdd(applyAdd(undefined, { title: 'A' }, T0), { title: 'B', after: ['p1'] }, T1);
  const snapshot = structuredClone(linear);
  expectPlanError(() => applyPatch(linear, { id: 'p1', after: ['p2'] }, T2), 'plan after contains a cycle');
  expectPlanError(() => applyPatch(linear, { id: 'p1', after: ['p1'] }, T2), 'plan item cannot depend on itself');
  assert.deepEqual(linear, snapshot);

  const chain = applyAdd(linear, { title: 'C', after: ['p2'] }, T2);
  expectPlanError(() => applyPatch(chain, { id: 'p1', after: ['p3'] }, T3), 'plan after contains a cycle');

  const diamond = applyAdd(
    applyAdd(
      applyAdd(applyAdd(undefined, { title: 'A' }, T0), { title: 'B', after: ['p1'] }, T1),
      { title: 'C', after: ['p1'] },
      T2,
    ),
    { title: 'D', after: ['p2', 'p3'] },
    T3,
  );
  assert.deepEqual(diamond.items.at(-1)?.after, ['p2', 'p3']);
  assert.deepEqual(validatePatch(linear, { id: 'p2', title: 'Renamed' }, T2), applyPatch(linear, { id: 'p2', title: 'Renamed' }, T2));
});

test('applyPatch allows every state transition, clears sessionId on todo, and keeps storage order', () => {
  let plan = applyAdd(undefined, { title: 'Work', note: 'today' }, T0);
  plan = applyPatch(plan, { id: 'p1', state: 'started', sessionId: 'child-1' }, T1);
  assert.equal(plan.items[0].state, 'started');
  assert.equal(plan.items[0].sessionId, 'child-1');
  assert.equal(plan.items[0].createdAt, T0);
  assert.equal(plan.items[0].updatedAt, T1);
  assert.equal(plan.items[0].note, 'today');

  plan = applyPatch(plan, { id: 'p1', state: 'done' }, T2);
  assert.equal(plan.items[0].state, 'done');
  assert.equal(plan.items[0].sessionId, 'child-1');

  plan = applyPatch(plan, { id: 'p1', state: 'dropped' }, T3);
  assert.equal(plan.items[0].state, 'dropped');
  assert.equal(plan.items[0].sessionId, 'child-1');

  plan = applyPatch(plan, { id: 'p1', state: 'todo', sessionId: 'child-2' }, NOW);
  assert.equal(plan.items[0].state, 'todo');
  assert.equal(plan.items[0].sessionId, undefined);
  assert.equal('sessionId' in plan.items[0], false);

  plan = applyPatch(plan, { id: 'p1', sessionId: 'child-3' }, NOW);
  assert.equal(plan.items[0].state, 'todo');
  assert.equal(plan.items[0].sessionId, 'child-3');

  plan = applyPatch(plan, { id: 'p1', state: 'started' }, NOW);
  plan = applyPatch(plan, { id: 'p1', sessionId: null, note: null }, NOW);
  assert.equal(plan.items[0].state, 'started');
  assert.equal(plan.items[0].sessionId, undefined);
  assert.equal('note' in plan.items[0], false);
  assert.deepEqual(ids(plan.items), ['p1']);
});

test('applyRemove drops the id from other after lists, keeps seq, and does not reuse the id', () => {
  let plan = applyAdd(undefined, { title: 'A' }, T0);
  plan = applyAdd(plan, { title: 'B', after: ['p1'] }, T1);
  plan = applyAdd(plan, { title: 'C', after: ['p1', 'p2'] }, T2);
  const originalAfter = plan.items[1].after;
  const removed = applyRemove(plan, 'p1', T3);

  assert.deepEqual(ids(removed.items), ['p2', 'p3']);
  assert.deepEqual(removed.items[0].after, []);
  assert.deepEqual(removed.items[1].after, ['p2']);
  assert.equal(removed.items[0].updatedAt, T1);
  assert.equal(removed.items[0].title, 'B');
  assert.equal(removed.seq, 4);
  assert.deepEqual(originalAfter, ['p1']);
  assert.deepEqual(plan.items.map((entry) => entry.id), ['p1', 'p2', 'p3']);

  const next = applyAdd(removed, { title: 'D' }, NOW);
  assert.deepEqual(ids(next.items), ['p2', 'p3', 'p4']);
  assert.equal(next.seq, 5);

  const byObject = applyRemove(next, { id: 'p3' }, NOW);
  assert.deepEqual(ids(byObject.items), ['p2', 'p4']);
  expectPlanError(() => applyRemove(next, 'p9', NOW), 'Plan item p9 does not exist');
  expectPlanError(() => applyRemove(next, 'nope', NOW), 'plan item id is invalid');
});

test('store emits and publishes once per change and keeps the rest of the session', async () => {
  const { sessions, emitted, published, store, stats } = makeHarness();
  sessions.set('s1', makeSession('s1'));
  assert.equal(await store.get('missing'), null);
  assert.equal(await store.get('s1'), null);

  const loadsBeforeAdd = stats.loads;
  const created = await store.add('s1', { title: '  Ship\nit  ' });
  assert.equal(created.id, 'p1');
  assert.equal(created.title, 'Ship it');
  assert.equal(created.updatedAt, NOW);
  assert.equal(emitted.length, 1);
  assert.equal(published.length, 1);
  assert.equal(stats.saves, 1);
  assert.equal(stats.loads - loadsBeforeAdd, 2);
  assert.equal(emitted[0].summary, 'p1 todo: Ship it → ready: p1');
  assert.equal(emitted[0].session.workingDir, '/tmp/work');
  assert.equal(emitted[0].session.name, 'name-s1');
  assert.deepEqual(published[0].plan?.items[0], created);

  const viewed = await store.get('s1');
  assert.equal(viewed?.items[0].title, 'Ship it');
  viewed!.items[0].title = 'hacked';
  assert.equal(sessions.get('s1')?.plan?.items[0].title, 'Ship it');

  const renamed = await store.patch('s1', 'p1', { title: 'Renamed' });
  assert.equal(renamed.title, 'Renamed');
  assert.equal(renamed.createdAt, NOW);
  assert.equal(emitted.length, 2);
  assert.equal(published.length, 2);
  assert.equal(emitted[1].summary, 'p1 todo: Renamed');

  await store.add('s1', { title: 'Later', after: ['p1'] });
  assert.equal(emitted.length, 3);
  assert.equal(published.length, 3);
  assert.equal(emitted[2].summary, 'p2 todo: Later');

  await store.patch('s1', 'p1', { state: 'done' });
  assert.equal(emitted.length, 4);
  assert.equal(emitted[3].summary, 'p1 done: Renamed → ready: p2');

  await store.remove('s1', 'p1');
  assert.equal(emitted.length, 5);
  assert.equal(published.length, 5);
  assert.equal(emitted[4].summary, 'p1 done: Renamed');
  const saved = sessions.get('s1')?.plan;
  assert.deepEqual(saved?.items.map((entry) => entry.id), ['p2']);
  assert.deepEqual(saved?.items[0].after, []);
  assert.equal(saved?.seq, 3);
  assert.equal(sessions.get('s1')?.workingDir, '/tmp/work');

  const third = await store.add('s1', { title: 'Third' });
  assert.equal(third.id, 'p3');
  assert.equal(emitted.length, 6);
  assert.equal(emitted[5].summary, 'p3 todo: Third → ready: p3');
});

test('store reload uses the second snapshot, and a rejected edit does not save or emit', async () => {
  const sessions = new Map<string, Session>();
  sessions.set('s1', makeSession('s1'));
  let calls = 0;
  const emitted: string[] = [];
  const store = new PlanStore({
    loadSession: async (id) => {
      calls += 1;
      const current = sessions.get(id);
      if (!current) return null;
      if (calls === 1) {
        const concurrent = applyAdd({ items: [], seq: 1 }, { title: 'First' }, T0);
        sessions.set(id, { ...current, plan: concurrent });
        return structuredClone(current);
      }
      const latest = sessions.get(id);
      return latest ? structuredClone(latest) : null;
    },
    saveSession: async (session) => { sessions.set(session.id, structuredClone(session)); },
    publishSession: () => {},
    emit: async (_session, summary) => { emitted.push(summary); },
    now: () => NOW_MS,
  });

  const created = await store.add('s1', { title: 'Second' });
  assert.equal(created.id, 'p2');
  assert.deepEqual(sessions.get('s1')?.plan?.items.map((entry) => entry.title), ['First', 'Second']);
  assert.deepEqual(emitted, ['p2 todo: Second → ready: p2']);

  const { sessions: quietSessions, emitted: quietEmitted, published, store: quiet, stats } = makeHarness();
  quietSessions.set('s1', makeSession('s1'));
  await assert.rejects(quiet.add('missing', { title: 'X' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof PlanValidationError, false);
    assert.equal(error.message, 'Session not found');
    return true;
  });
  await assert.rejects(quiet.add('s1', { title: '   ' }), PlanValidationError);
  await assert.rejects(quiet.remove('s1', 'p1'), /Plan item p1 does not exist/);
  assert.equal(quietEmitted.length, 0);
  assert.equal(published.length, 0);
  assert.equal(stats.saves, 0);
  assert.equal(quietSessions.get('s1')?.plan, undefined);
});

test('startForChild and completeForChild transition the linked item and emit once', async () => {
  const { sessions, emitted, published, store } = makeHarness();
  sessions.set('s1', makeSession('s1'));
  await store.add('s1', { title: 'Blocker' });
  await store.add('s1', { title: 'Next', after: ['p1'], priority: 2 });
  await store.add('s1', { title: 'Soon', after: ['p1'], priority: 1 });

  await store.startForChild('s1', 'p1', 'child-1');
  const started = sessions.get('s1')?.plan?.items.find((entry) => entry.id === 'p1');
  assert.equal(started?.state, 'started');
  assert.equal(started?.sessionId, 'child-1');
  assert.equal(emitted.at(-1)?.summary, 'p1 started: Blocker');
  assert.equal(published.length, emitted.length);

  const afterStart = emitted.length;
  await assert.rejects(
    store.startForChild('s1', 'p1', 'child-9'),
    (error: unknown) => {
      assert.ok(error instanceof PlanValidationError);
      assert.equal(error.message, 'Plan item p1 is started, not todo');
      return true;
    },
  );
  await assert.rejects(store.startForChild('s1', 'p9', 'child-9'), /Plan item p9 does not exist/);
  await assert.rejects(store.startForChild('missing', 'p1', 'child-1'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof PlanValidationError, false);
    assert.equal(error.message, 'Session not found');
    return true;
  });
  assert.equal(emitted.length, afterStart);

  await store.patch('s1', 'p2', { sessionId: 'child-2' });
  const beforeTodo = emitted.length;
  await store.completeForChild('s1', 'child-2');
  await store.completeForChild('missing', 'child-1');
  await store.completeForChild('s1', 'nobody');
  assert.equal(emitted.length, beforeTodo);
  assert.equal(sessions.get('s1')?.plan?.items.find((entry) => entry.id === 'p2')?.state, 'todo');

  await store.completeForChild('s1', 'child-1');
  assert.equal(emitted.length, beforeTodo + 1);
  assert.equal(published.length, emitted.length);
  assert.equal(emitted.at(-1)?.summary, 'p1 done: Blocker → ready: p3, p2');
  const done = sessions.get('s1')?.plan?.items.find((entry) => entry.id === 'p1');
  assert.equal(done?.state, 'done');
  assert.equal(done?.sessionId, 'child-1');
  assert.equal(sessions.get('s1')?.plan?.items.find((entry) => entry.id === 'p3')?.state, 'todo');

  const afterDone = emitted.length;
  await store.completeForChild('s1', 'child-1');
  assert.equal(emitted.length, afterDone);

  await store.patch('s1', 'p2', { state: 'started', sessionId: 'child-9' });
  await store.patch('s1', 'p3', { state: 'started', sessionId: 'child-9' });
  const beforeBoth = emitted.length;
  await store.completeForChild('s1', 'child-9');
  assert.equal(emitted.length, beforeBoth + 1);
  assert.equal(emitted.at(-1)?.summary, 'p2 done: Next');
  const states = sessions.get('s1')?.plan?.items.map((entry) => [entry.id, entry.state]);
  assert.deepEqual(states, [['p1', 'done'], ['p2', 'done'], ['p3', 'done']]);
});

test('a 200-item after chain is acyclic, and patching it shut is a cycle', () => {
  const chain: PlanItem[] = [item({ id: 'p1' })];
  for (let n = 2; n <= 200; n += 1) chain.push(item({ id: `p${n}`, after: [`p${n - 1}`] }));
  const plan: SessionPlan = { items: chain, seq: 201 };

  const walked = applyPatch(plan, { id: 'p200', after: ['p199'] }, NOW);
  assert.equal(walked.items.length, 200);
  assert.deepEqual(walked.items[199].after, ['p199']);
  assert.deepEqual(plan.items[0].after, []);

  expectPlanError(() => applyPatch(plan, { id: 'p1', after: ['p200'] }, NOW), 'plan after contains a cycle');
  assert.deepEqual(plan.items[0].after, []);
  assert.equal(plan.items.length, 200);
});

test('note null clears, and a blank note on add is omitted', () => {
  let plan = applyAdd(undefined, { title: 'Work', note: '' }, T0);
  assert.equal(plan.items[0].note, undefined);
  plan = applyAdd(plan, { title: 'Next', note: '  keep  ' }, T1);
  assert.equal(plan.items[1].note, 'keep');
  plan = applyPatch(plan, { id: 'p2', note: null }, T2);
  assert.equal(plan.items[1].note, undefined);
  assert.equal('note' in plan.items[1], false);
  assert.equal(plan.items[1].title, 'Next');
});

test('store publishes before emit, and an emit failure still leaves the plan published', async () => {
  const sessions = new Map<string, Session>();
  sessions.set('s1', makeSession('s1'));
  const order: string[] = [];
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const store = new PlanStore({
      loadSession: async (id) => {
        const session = sessions.get(id);
        return session ? structuredClone(session) : null;
      },
      saveSession: async (session) => { sessions.set(session.id, structuredClone(session)); },
      publishSession: () => { order.push('publish'); },
      emit: async () => {
        order.push('emit');
        throw new Error('log down');
      },
      now: () => NOW_MS,
    });
    const created = await store.add('s1', { title: 'Ship' });
    assert.equal(created.id, 'p1');
    assert.equal(created.title, 'Ship');
    assert.deepEqual(order, ['publish', 'emit']);
    assert.equal(sessions.get('s1')?.plan?.items[0].title, 'Ship');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'PlanStore emit failed');
  } finally {
    console.warn = originalWarn;
  }
});

test('store does not reuse a removed id when the next item is added', async () => {
  const { sessions, store } = makeHarness();
  sessions.set('s1', makeSession('s1'));
  await store.add('s1', { title: 'A' });
  await store.remove('s1', 'p1');
  const again = await store.add('s1', { title: 'B' });
  assert.equal(again.id, 'p2');
  assert.equal(sessions.get('s1')?.plan?.seq, 3);
  assert.deepEqual(sessions.get('s1')?.plan?.items.map((entry) => entry.id), ['p2']);
});

test('startForChild rejects an unknown item and a non-todo item without saving', async () => {
  const { sessions, emitted, published, store, stats } = makeHarness();
  sessions.set('s1', makeSession('s1'));
  await store.add('s1', { title: 'Work' });
  await store.patch('s1', 'p1', { state: 'dropped' });
  const saves = stats.saves;
  const events = emitted.length;
  await assert.rejects(store.startForChild('s1', 'p9', 'child-1'), /Plan item p9 does not exist/);
  await assert.rejects(
    store.startForChild('s1', 'p1', 'child-1'),
    (error: unknown) => {
      assert.ok(error instanceof PlanValidationError);
      assert.equal(error.message, 'Plan item p1 is dropped, not todo');
      return true;
    },
  );
  assert.equal(stats.saves, saves);
  assert.equal(emitted.length, events);
  assert.equal(published.length, events);
  assert.equal(sessions.get('s1')?.plan?.items[0].state, 'dropped');
  assert.equal(sessions.get('s1')?.plan?.items[0].sessionId, undefined);
});

test('completeForChild ignores other children and non-started items, and several matches emit once', async () => {
  const { sessions, emitted, published, store, stats } = makeHarness();
  sessions.set('s1', makeSession('s1', {
    seq: 5,
    items: [
      item({ id: 'p1', title: 'Mine', state: 'started', sessionId: 'child-a' }),
      item({ id: 'p2', title: 'Other', state: 'started', sessionId: 'child-b' }),
      item({ id: 'p3', title: 'Waiting', state: 'todo', sessionId: 'child-a' }),
      item({ id: 'p4', title: 'Also mine', state: 'started', sessionId: 'child-a' }),
    ],
  }));

  await store.completeForChild('s1', 'child-z');
  assert.equal(stats.saves, 0);
  assert.equal(emitted.length, 0);
  assert.equal(published.length, 0);
  assert.equal(sessions.get('s1')?.plan?.items[1].state, 'started');

  await store.completeForChild('s1', 'child-a');
  assert.equal(stats.saves, 1);
  assert.equal(emitted.length, 1);
  assert.equal(published.length, 1);
  assert.equal(emitted[0].summary, 'p1 done: Mine');
  const saved = sessions.get('s1')?.plan?.items ?? [];
  assert.deepEqual(saved.map((entry) => [entry.id, entry.state, entry.sessionId]), [
    ['p1', 'done', 'child-a'],
    ['p2', 'started', 'child-b'],
    ['p3', 'todo', 'child-a'],
    ['p4', 'done', 'child-a'],
  ]);
});
