import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAddBody,
  buildEditPatch,
  formatPlanItem,
  formatPlanList,
  parsePlanAfter,
  parsePlanItemId,
  parsePlanPriority,
  parseSessionNames,
  runPlan,
  type PlanCliDeps,
} from './plan-cli.js';
import { UsageError } from './coordination-cli.js';
import type { PlanItem, PlanView } from './coordination/contract-c.js';

const SELF = 'mgr-1';

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

type Handler = (call: RecordedCall) => unknown;

function harness(handler: Handler): {
  deps: Partial<PlanCliDeps>;
  calls: RecordedCall[];
  out: string[];
  err: string[];
} {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: Partial<PlanCliDeps> = {
    api: async (method: string, path: string, body?: unknown) => {
      const call: RecordedCall = { method, path, body };
      calls.push(call);
      return handler(call);
    },
    env: { FTOWN_SESSION_ID: SELF },
    log: (text: string) => out.push(text),
    errorLog: (text: string) => err.push(text),
  };
  return { deps, calls, out, err };
}

function makeItem(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'p1',
    title: 'Write the plan CLI',
    after: [],
    priority: 2,
    state: 'todo',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Handler for a mutation followed by its fresh PlanView + sessions confirmation GETs. */
function mutationHandler(
  item: PlanItem,
  view: PlanView,
  sessions: Array<{ id: string; name: string }> = [],
): Handler {
  return (call) => {
    if (call.method === 'GET' && call.path === '/api/sessions') return { sessions };
    if (call.method === 'GET') return view;
    return { item };
  };
}

function confirmCalls(mutation: RecordedCall, sessionId: string = SELF): RecordedCall[] {
  return [
    mutation,
    { method: 'GET', path: `/api/sessions/${sessionId}/plan`, body: undefined },
    { method: 'GET', path: '/api/sessions', body: undefined },
  ];
}

function makeView(): PlanView {
  return {
    items: [
      makeItem({ id: 'p2', title: 'Ready task', priority: 1, state: 'todo', after: [] }),
      makeItem({ id: 'p3', title: 'Waiting task', priority: 2, state: 'todo', after: ['p1', 'p2'] }),
      makeItem({ id: 'p4', title: 'Started task', priority: 3, state: 'started', sessionId: 'child-9', after: ['p1'] }),
      makeItem({ id: 'p5', title: 'Done task', priority: 2, state: 'done' }),
      makeItem({ id: 'p6', title: 'Dropped task', priority: 2, state: 'dropped' }),
      makeItem({ id: 'p7', title: 'Both suffixes', priority: 1, state: 'started', sessionId: 'child-2', after: ['p1', 'p2'] }),
    ],
    ready: ['p2'],
  };
}

// ───────────────────────── pure parsers / builders ─────────────────────────

test('parsePlanItemId accepts p<n> and rejects other shapes', () => {
  assert.equal(parsePlanItemId('p1'), 'p1');
  assert.equal(parsePlanItemId('p123456'), 'p123456');
  for (const bad of ['p', 'p1234567', 'x1', 'P1', 'p-1', ' p1x', '']) {
    assert.throws(() => parsePlanItemId(bad), UsageError, bad);
  }
});

test('parsePlanPriority accepts 1..3 only', () => {
  assert.equal(parsePlanPriority('1'), 1);
  assert.equal(parsePlanPriority('2'), 2);
  assert.equal(parsePlanPriority('3'), 3);
  for (const bad of ['0', '4', 'high', '1.5', '']) {
    assert.throws(() => parsePlanPriority(bad), UsageError, bad);
  }
});

test('parsePlanAfter splits, trims and validates ids and the limit', () => {
  assert.deepEqual(parsePlanAfter('p1,p2'), ['p1', 'p2']);
  assert.deepEqual(parsePlanAfter('p1, p2 ,p3'), ['p1', 'p2', 'p3']);
  assert.deepEqual(parsePlanAfter('p9'), ['p9']);
  for (const bad of ['', 'p1,,p2', 'p1,', ',p1', 'nope', 'p1,bogus']) {
    assert.throws(() => parsePlanAfter(bad), UsageError, bad);
  }
  const tooMany = Array.from({ length: 21 }, (_, i) => `p${i + 1}`).join(',');
  assert.throws(() => parsePlanAfter(tooMany), UsageError);
});

test('buildAddBody joins the title and includes only supplied fields', () => {
  assert.deepEqual(buildAddBody(['Fix', 'the', 'thing'], {}), { title: 'Fix the thing' });
  assert.deepEqual(
    buildAddBody(['Fix'], { note: 'details', after: 'p1,p2', priority: '1' }),
    { title: 'Fix', note: 'details', after: ['p1', 'p2'], priority: 1 },
  );
  assert.throws(() => buildAddBody([], {}), UsageError);
  assert.throws(() => buildAddBody(['x'], { priority: '9' }), UsageError);
  assert.throws(() => buildAddBody(['x'], { after: 'bogus' }), UsageError);
});

test('buildEditPatch maps fields, clears and rejects an empty patch', () => {
  assert.deepEqual(buildEditPatch({ title: 'New' }), { title: 'New' });
  assert.deepEqual(buildEditPatch({ note: 'n' }), { note: 'n' });
  assert.deepEqual(buildEditPatch({ note: false }), { note: null });
  assert.deepEqual(buildEditPatch({ after: 'p1,p2' }), { after: ['p1', 'p2'] });
  assert.deepEqual(buildEditPatch({ after: false }), { after: [] });
  assert.deepEqual(buildEditPatch({ priority: '3' }), { priority: 3 });
  assert.deepEqual(
    buildEditPatch({ title: 'T', note: false, after: false, priority: '1' }),
    { title: 'T', note: null, after: [], priority: 1 },
  );
  assert.throws(() => buildEditPatch({}), UsageError);
  assert.throws(() => buildEditPatch({ title: '  ' }), UsageError);
  assert.throws(() => buildEditPatch({ priority: '0' }), UsageError);
  assert.throws(() => buildEditPatch({ after: 'zz' }), UsageError);
});

test('formatPlanItem renders marks, priority, after and child suffixes', () => {
  const ready = new Set(['p2']);
  assert.equal(formatPlanItem(makeItem({ id: 'p2', title: 'Ready task', priority: 1 }), ready), '→ p2 [P1] Ready task');
  assert.equal(
    formatPlanItem(makeItem({ id: 'p3', title: 'Waiting task', after: ['p1', 'p2'] }), ready),
    '· p3 [P2] Waiting task  (after p1,p2)',
  );
  assert.equal(
    formatPlanItem(makeItem({ id: 'p4', title: 'Started', state: 'started', sessionId: 'child-9' }), ready),
    '▸ p4 [P2] Started  (→ child-9)',
  );
  assert.equal(formatPlanItem(makeItem({ id: 'p5', title: 'Done', state: 'done' }), ready), '✓ p5 [P2] Done');
  assert.equal(formatPlanItem(makeItem({ id: 'p6', title: 'Dropped', state: 'dropped' }), ready), '✗ p6 [P2] Dropped');
  assert.equal(
    formatPlanItem(
      makeItem({ id: 'p7', title: 'Both', state: 'started', sessionId: 'child-2', after: ['p1', 'p2'] }),
      ready,
    ),
    '▸ p7 [P2] Both  (after p1,p2 | → child-2)',
  );
  // Readiness comes only from the server ready ids, never from `after`:
  // an item whose predecessors are all done is ready when the server says so,
  // and an item with an empty `after` is waiting when the server omits it.
  assert.equal(
    formatPlanItem(makeItem({ id: 'p8', title: 'Deps done', after: ['p1'] }), new Set(['p8'])),
    '→ p8 [P2] Deps done  (after p1)',
  );
  assert.equal(
    formatPlanItem(makeItem({ id: 'p9', title: 'Solo but not ready', after: [] }), new Set<string>()),
    '· p9 [P2] Solo but not ready',
  );
  assert.equal(
    formatPlanItem(
      makeItem({ id: 'p10', title: 'Named child', state: 'started', sessionId: 'child-9' }),
      ready,
      new Map([['child-9', 'worker-nine']]),
    ),
    '▸ p10 [P2] Named child  (→ worker-nine)',
  );
});

test('parseSessionNames builds an id to name map and ignores malformed entries', () => {
  assert.deepEqual(
    parseSessionNames({
      sessions: [
        { id: 'child-9', name: 'worker-nine' },
        { id: 'mgr-1', name: 'manager' },
        { id: 42, name: 'bad id' },
        { id: 'no-name' },
        { name: 'no id' },
        'junk',
        null,
      ],
    }),
    new Map([
      ['child-9', 'worker-nine'],
      ['mgr-1', 'manager'],
    ]),
  );
  assert.deepEqual(parseSessionNames({ sessions: [] }), new Map());
  assert.deepEqual(parseSessionNames(null), new Map());
  assert.deepEqual(parseSessionNames({}), new Map());
});

test('formatPlanList keeps API order and uses the view ready set', () => {
  assert.deepEqual(formatPlanList(makeView()), [
    '→ p2 [P1] Ready task',
    '· p3 [P2] Waiting task  (after p1,p2)',
    '▸ p4 [P3] Started task  (after p1 | → child-9)',
    '✓ p5 [P2] Done task',
    '✗ p6 [P2] Dropped task',
    '▸ p7 [P1] Both suffixes  (after p1,p2 | → child-2)',
  ]);
  assert.deepEqual(formatPlanList({ items: [], ready: [] }), []);
  // A todo item whose after-items are all done is ready per the server list,
  // and a todo item with an empty after that the server omits stays waiting.
  assert.deepEqual(
    formatPlanList({
      items: [
        makeItem({ id: 'p8', title: 'Deps done', after: ['p5'] }),
        makeItem({ id: 'p9', title: 'Not declared ready', after: [] }),
      ],
      ready: ['p8'],
    }),
    ['→ p8 [P2] Deps done  (after p5)', '· p9 [P2] Not declared ready'],
  );
  // Child names replace ids when a name map is supplied.
  assert.deepEqual(
    formatPlanList(makeView(), new Map([['child-9', 'worker-nine']])),
    [
      '→ p2 [P1] Ready task',
      '· p3 [P2] Waiting task  (after p1,p2)',
      '▸ p4 [P3] Started task  (after p1 | → worker-nine)',
      '✓ p5 [P2] Done task',
      '✗ p6 [P2] Dropped task',
      '▸ p7 [P1] Both suffixes  (after p1,p2 | → child-2)',
    ],
  );
});

// ───────────────────────── list ─────────────────────────

test('list maps to GET plan and prints one plain row per item', async () => {
  const view = makeView();
  const { deps, calls, out } = harness(() => view);
  assert.equal(await runPlan([], deps), 0);
  assert.deepEqual(calls, [
    { method: 'GET', path: `/api/sessions/${SELF}/plan`, body: undefined },
    { method: 'GET', path: '/api/sessions', body: undefined },
  ]);
  assert.deepEqual(out, formatPlanList(view));
});

test('list resolves child names via one GET /api/sessions call and falls back to the id', async () => {
  const view: PlanView = {
    items: [
      makeItem({ id: 'p4', title: 'Started task', state: 'started', sessionId: 'child-9', after: ['p1'] }),
      makeItem({ id: 'p7', title: 'Unknown child task', state: 'started', sessionId: 'child-gone', after: [] }),
      makeItem({ id: 'p8', title: 'Second known task', state: 'started', sessionId: 'child-9', after: [] }),
    ],
    ready: [],
  };
  const { deps, calls, out } = harness((call) =>
    call.path === '/api/sessions'
      ? {
          sessions: [
            { id: 'child-9', name: 'worker-nine' },
            { id: SELF, name: 'manager' },
          ],
        }
      : view,
  );
  assert.equal(await runPlan([], deps), 0);
  assert.deepEqual(calls, [
    { method: 'GET', path: `/api/sessions/${SELF}/plan`, body: undefined },
    { method: 'GET', path: '/api/sessions', body: undefined },
  ]);
  assert.equal(calls.filter((call) => call.path === '/api/sessions').length, 1);
  assert.deepEqual(out, [
    '▸ p4 [P2] Started task  (after p1 | → worker-nine)',
    '▸ p7 [P2] Unknown child task  (→ child-gone)',
    '▸ p8 [P2] Second known task  (→ worker-nine)',
  ]);
});

test('list marks ready only from PlanView.ready, never from an empty after', async () => {
  const view: PlanView = {
    items: [
      makeItem({ id: 'p8', title: 'Deps done', state: 'todo', after: ['p1'] }),
      makeItem({ id: 'p9', title: 'Solo waiting', state: 'todo', after: [] }),
    ],
    ready: ['p8'],
  };
  const { deps, calls, out } = harness((call) => (call.path === '/api/sessions' ? { sessions: [] } : view));
  assert.equal(await runPlan([], deps), 0);
  assert.deepEqual(calls.map((call) => call.path), [`/api/sessions/${SELF}/plan`, '/api/sessions']);
  assert.deepEqual(out, ['→ p8 [P2] Deps done  (after p1)', '· p9 [P2] Solo waiting']);
});

test('list --json passes the API payload through and --session-id overrides the env default', async () => {
  const view = makeView();
  const { deps, calls, out } = harness(() => view);
  assert.equal(await runPlan(['--json', '--session-id', 'other-7'], deps), 0);
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/sessions/other-7/plan', body: undefined }]);
  assert.deepEqual(JSON.parse(out.join('\n')), view);
});

test('list --plain behaves like the default plain output', async () => {
  const { deps, out } = harness(() => ({ items: [makeItem()], ready: ['p1'] }));
  assert.equal(await runPlan(['--plain'], deps), 0);
  assert.deepEqual(out, ['→ p1 [P2] Write the plan CLI']);
});

test('list with no items prints the empty message; --json still passes through', async () => {
  const plain = harness(() => ({ items: [], ready: [] }));
  assert.equal(await runPlan([], plain.deps), 0);
  assert.deepEqual(plain.out, ['no plan items']);

  const json = harness(() => ({ items: [], ready: [] }));
  assert.equal(await runPlan(['--json'], json.deps), 0);
  assert.deepEqual(JSON.parse(json.out.join('\n')), { items: [], ready: [] });
});

// ───────────────────────── add ─────────────────────────

test('add joins the title, POSTs supplied fields and prints the created item', async () => {
  const created = makeItem({ id: 'p7', title: 'Fix the thing', note: 'details', after: ['p1'], priority: 1 });
  const { deps, calls, out } = harness(mutationHandler(created, { items: [created], ready: [] }));
  const code = await runPlan(['add', 'Fix', 'the', 'thing', '--note', 'details', '--after', 'p1', '--priority', '1'], deps);
  assert.equal(code, 0);
  assert.deepEqual(
    calls,
    confirmCalls({
      method: 'POST',
      path: `/api/sessions/${SELF}/plan`,
      body: { title: 'Fix the thing', note: 'details', after: ['p1'], priority: 1 },
    }),
  );
  assert.deepEqual(out, ['· p7 [P1] Fix the thing  (after p1)']);
});

test('add with only a title sends no optional keys', async () => {
  const solo = makeItem({ id: 'p2', title: 'Solo task' });
  const { deps, calls, out } = harness(mutationHandler(solo, { items: [solo], ready: ['p2'] }));
  assert.equal(await runPlan(['add', 'Solo task'], deps), 0);
  assert.deepEqual(
    calls,
    confirmCalls({ method: 'POST', path: `/api/sessions/${SELF}/plan`, body: { title: 'Solo task' } }),
  );
  // Readiness comes from the fresh PlanView, not the single-item response.
  assert.deepEqual(out, ['→ p2 [P2] Solo task']);
});

test('add --json passes the created payload through and honours --session-id', async () => {
  const payload = { item: makeItem({ id: 'p3', title: 'Other' }) };
  const { deps, calls, out } = harness(() => payload);
  assert.equal(await runPlan(['add', 'Other', '--json', '--session-id', 'other-7'], deps), 0);
  assert.deepEqual(calls, [{ method: 'POST', path: '/api/sessions/other-7/plan', body: { title: 'Other' } }]);
  assert.deepEqual(JSON.parse(out.join('\n')), payload);
});

test('add usage errors exit 2 and make no request', async () => {
  const cases: string[][] = [
    ['add'],
    ['add', 'Title', '--priority', '0'],
    ['add', 'Title', '--priority', '4'],
    ['add', 'Title', '--priority', 'high'],
    ['add', 'Title', '--after', 'bogus'],
    ['add', 'Title', '--after', 'p1,,p2'],
    ['add', 'Title', '--after', ''],
    ['add', 'Title', '--bogus-flag'],
  ];
  for (const argv of cases) {
    const { deps, calls } = harness(() => ({ item: makeItem() }));
    assert.equal(await runPlan(argv, deps), 2, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});

// ───────────────────────── start / state verbs ─────────────────────────

test('start PATCHes state started with the child session id', async () => {
  const started = makeItem({ state: 'started', sessionId: 'child-9' });
  const { deps, calls, out } = harness(
    mutationHandler(started, { items: [started], ready: [] }, [{ id: 'child-9', name: 'worker-nine' }]),
  );
  assert.equal(await runPlan(['start', 'p1', '--session', 'child-9'], deps), 0);
  assert.deepEqual(
    calls,
    confirmCalls({
      method: 'PATCH',
      path: `/api/sessions/${SELF}/plan/p1`,
      body: { state: 'started', sessionId: 'child-9' },
    }),
  );
  assert.deepEqual(out, ['▸ p1 [P2] Write the plan CLI  (→ worker-nine)']);
});

test('start requires --session and valid ids (usage exit 2, no request)', async () => {
  const cases: string[][] = [
    ['start', 'p1'],
    ['start', 'p1', '--session', ''],
    ['start', 'p1', '--session', 'bad id!'],
    ['start', 'bogus', '--session', 'child-9'],
    ['start'],
    ['start', 'p1', '--session', 'child-9', 'extra'],
  ];
  for (const argv of cases) {
    const { deps, calls } = harness(() => ({ item: makeItem() }));
    assert.equal(await runPlan(argv, deps), 2, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});

test('done, drop and todo PATCH the mapped state and print the item', async () => {
  const cases: Array<{ argv: string[]; state: PlanItem['state']; ready: string[]; line: string }> = [
    { argv: ['done', 'p1'], state: 'done', ready: [], line: '✓ p1 [P2] Write the plan CLI' },
    { argv: ['drop', 'p1'], state: 'dropped', ready: [], line: '✗ p1 [P2] Write the plan CLI' },
    { argv: ['todo', 'p1'], state: 'todo', ready: ['p1'], line: '→ p1 [P2] Write the plan CLI' },
  ];
  for (const { argv, state, ready, line } of cases) {
    const item = makeItem({ state });
    const { deps, calls, out } = harness(mutationHandler(item, { items: [item], ready }));
    assert.equal(await runPlan(argv, deps), 0, argv.join(' '));
    assert.deepEqual(
      calls,
      confirmCalls({ method: 'PATCH', path: `/api/sessions/${SELF}/plan/p1`, body: { state } }),
      argv.join(' '),
    );
    assert.deepEqual(out, [line], argv.join(' '));
  }
});

test('state verbs reject invalid item ids with exit 2 and no request', async () => {
  for (const argv of [['done', 'nope'], ['drop', 'x9'], ['todo', 'p1234567'], ['done'], ['rm', 'nope']]) {
    const { deps, calls } = harness(() => ({ item: makeItem() }));
    assert.equal(await runPlan(argv, deps), 2, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});

test('state verbs --json passes the payload through', async () => {
  const payload = { item: makeItem({ state: 'done' }) };
  const { deps, calls, out } = harness(() => payload);
  assert.equal(await runPlan(['done', 'p1', '--json'], deps), 0);
  assert.deepEqual(calls, [
    { method: 'PATCH', path: `/api/sessions/${SELF}/plan/p1`, body: { state: 'done' } },
  ]);
  assert.deepEqual(JSON.parse(out.join('\n')), payload);
});

test('mutation confirmation uses the fresh PlanView item and child names', async () => {
  // Mutation payload is stale; the fresh view carries the authoritative title/session.
  const stale = makeItem({ id: 'p1', title: 'Stale title', state: 'started', sessionId: 'child-9' });
  const fresh = makeItem({ id: 'p1', title: 'Fresh title', state: 'started', sessionId: 'child-9' });
  const view: PlanView = { items: [fresh], ready: [] };
  const { deps, calls, out } = harness(
    mutationHandler(stale, view, [{ id: 'child-9', name: 'worker-nine' }]),
  );
  assert.equal(await runPlan(['start', 'p1', '--session', 'child-9'], deps), 0);
  assert.equal(calls.filter((call) => call.method === 'GET' && call.path.endsWith('/plan')).length, 1);
  assert.equal(calls.filter((call) => call.path === '/api/sessions').length, 1);
  assert.deepEqual(out, ['▸ p1 [P2] Fresh title  (→ worker-nine)']);
});

test('mutation confirmation falls back to the child id for an unknown session', async () => {
  const started = makeItem({ id: 'p1', state: 'started', sessionId: 'child-gone' });
  const { deps, out } = harness(mutationHandler(started, { items: [started], ready: [] }, []));
  assert.equal(await runPlan(['start', 'p1', '--session', 'child-gone'], deps), 0);
  assert.deepEqual(out, ['▸ p1 [P2] Write the plan CLI  (→ child-gone)']);
});

test('mutation succeeds even when both confirmation GETs fail: prints payload, warns, exit 0', async () => {
  const started = makeItem({ id: 'p1', state: 'started', sessionId: 'child-9' });
  const { deps, calls, out, err } = harness((call) => {
    if (call.method === 'GET') throw new Error('bridge unreachable');
    return { item: started };
  });
  assert.equal(await runPlan(['start', 'p1', '--session', 'child-9'], deps), 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(out, ['▸ p1 [P2] Write the plan CLI  (→ child-9)']);
  assert.match(err.join('\n'), /warning/);
  assert.match(err.join('\n'), /bridge unreachable/);
});

test('mutation confirmation is best-effort per GET: plan fails, names still resolve', async () => {
  const started = makeItem({ id: 'p1', state: 'started', sessionId: 'child-9' });
  const { deps, out, err } = harness((call) => {
    if (call.method === 'GET' && call.path === '/api/sessions') {
      return { sessions: [{ id: 'child-9', name: 'worker-nine' }] };
    }
    if (call.method === 'GET') throw new Error('plan read failed');
    return { item: started };
  });
  assert.equal(await runPlan(['start', 'p1', '--session', 'child-9'], deps), 0);
  assert.deepEqual(out, ['▸ p1 [P2] Write the plan CLI  (→ worker-nine)']);
  assert.match(err.join('\n'), /warning/);
});

test('mutation confirmation is best-effort per GET: sessions fails, ready mark still applies', async () => {
  const todo = makeItem({ id: 'p1', state: 'todo' });
  const { deps, out, err } = harness((call) => {
    if (call.method === 'GET' && call.path === '/api/sessions') throw new Error('sessions read failed');
    if (call.method === 'GET') return { items: [todo], ready: ['p1'] };
    return { item: todo };
  });
  assert.equal(await runPlan(['todo', 'p1'], deps), 0);
  assert.deepEqual(out, ['→ p1 [P2] Write the plan CLI']);
  assert.match(err.join('\n'), /warning/);
});

// ───────────────────────── edit ─────────────────────────

test('edit PATCHes only the supplied fields', async () => {
  const edited = makeItem({ title: 'New title', priority: 1 });
  const { deps, calls, out } = harness(mutationHandler(edited, { items: [edited], ready: ['p1'] }));
  assert.equal(await runPlan(['edit', 'p1', '--title', 'New title', '--priority', '1'], deps), 0);
  assert.deepEqual(
    calls,
    confirmCalls({
      method: 'PATCH',
      path: `/api/sessions/${SELF}/plan/p1`,
      body: { title: 'New title', priority: 1 },
    }),
  );
  assert.deepEqual(out, ['→ p1 [P1] New title']);
});

test('edit --no-note and --no-after clear via null and empty list', async () => {
  const item = makeItem();
  const { deps, calls } = harness(mutationHandler(item, { items: [item], ready: [] }));
  assert.equal(await runPlan(['edit', 'p1', '--no-note', '--no-after'], deps), 0);
  assert.deepEqual(
    calls,
    confirmCalls({
      method: 'PATCH',
      path: `/api/sessions/${SELF}/plan/p1`,
      body: { note: null, after: [] },
    }),
  );
});

test('edit --note and --after set values; combined patch is exact', async () => {
  const item = makeItem({ after: ['p2'] });
  const { deps, calls } = harness(mutationHandler(item, { items: [item], ready: [] }));
  assert.equal(
    await runPlan(['edit', 'p1', '--note', 'fresh note', '--after', 'p2,p3', '--session-id', 'other-7'], deps),
    0,
  );
  assert.deepEqual(
    calls,
    confirmCalls(
      { method: 'PATCH', path: '/api/sessions/other-7/plan/p1', body: { note: 'fresh note', after: ['p2', 'p3'] } },
      'other-7',
    ),
  );
});

test('edit with nothing to change or bad values exits 2 and makes no request', async () => {
  const cases: string[][] = [
    ['edit', 'p1'],
    ['edit', 'p1', '--title', '   '],
    ['edit', 'p1', '--priority', '7'],
    ['edit', 'p1', '--after', 'bogus'],
    ['edit', 'bogus', '--title', 'x'],
    ['edit'],
  ];
  for (const argv of cases) {
    const { deps, calls } = harness(() => ({ item: makeItem() }));
    assert.equal(await runPlan(argv, deps), 2, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});

test('edit --json passes the payload through', async () => {
  const payload = { item: makeItem({ title: 'Renamed' }) };
  const { deps, calls, out } = harness(() => payload);
  assert.equal(await runPlan(['edit', 'p1', '--title', 'Renamed', '--json'], deps), 0);
  assert.deepEqual(calls, [
    { method: 'PATCH', path: `/api/sessions/${SELF}/plan/p1`, body: { title: 'Renamed' } },
  ]);
  assert.deepEqual(JSON.parse(out.join('\n')), payload);
});

// ───────────────────────── rm ─────────────────────────

test('rm DELETEs the item and prints removed <id>', async () => {
  const { deps, calls, out } = harness(() => ({ ok: true }));
  assert.equal(await runPlan(['rm', 'p1'], deps), 0);
  assert.deepEqual(calls, [{ method: 'DELETE', path: `/api/sessions/${SELF}/plan/p1`, body: undefined }]);
  assert.deepEqual(out, ['removed p1']);
});

test('rm --json passes the payload through and honours --session-id', async () => {
  const { deps, calls, out } = harness(() => ({ ok: true }));
  assert.equal(await runPlan(['rm', 'p12', '--json', '--session-id', 'other-7'], deps), 0);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/api/sessions/other-7/plan/p12', body: undefined }]);
  assert.deepEqual(JSON.parse(out.join('\n')), { ok: true });
});

// ───────────────────────── errors / session / help ─────────────────────────

test('missing session id exits 2 with no request for list and mutations', async () => {
  for (const argv of [[], ['add', 'Title'], ['done', 'p1'], ['rm', 'p1'], ['start', 'p1', '--session', 'child-1']]) {
    const { deps, calls, err } = harness(() => ({ item: makeItem() }));
    deps.env = {};
    assert.equal(await runPlan(argv, deps), 2, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
    assert.match(err.join('\n'), /FTOWN_SESSION_ID/);
  }
});

test('invalid --session-id exits 2 with no request', async () => {
  const { deps, calls } = harness(() => ({ items: [], ready: [] }));
  assert.equal(await runPlan(['--session-id', 'bad id!'], deps), 2);
  assert.equal(calls.length, 0);
});

test('API errors exit 1 with the server message', async () => {
  for (const argv of [[], ['add', 'Title'], ['done', 'p1'], ['rm', 'p1']]) {
    const { deps, err } = harness(() => {
      throw new Error('Session not found');
    });
    assert.equal(await runPlan(argv, deps), 1, argv.join(' '));
    assert.match(err.join('\n'), /Session not found/);
  }
});

test('an invalid plan response on a mutation exits 1', async () => {
  const { deps, err } = harness(() => ({ unexpected: true }));
  assert.equal(await runPlan(['done', 'p1'], deps), 1);
  assert.match(err.join('\n'), /Invalid plan response/);
});

test('unknown subcommands, flags and extra positionals exit 2 with no request', async () => {
  const cases: string[][] = [
    ['bogus'],
    ['list'],
    ['--bogus-flag'],
    ['done', 'p1', 'extra'],
    ['rm', 'p1', '--bogus-flag'],
    ['add', 'Title', '--priority'],
  ];
  for (const argv of cases) {
    const { deps, calls } = harness(() => ({ items: [], ready: [] }));
    assert.equal(await runPlan(argv, deps), 2, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});

test('help exits 0 for the group and every subcommand', async () => {
  const cases: string[][] = [
    ['--help'],
    ['-h'],
    ['add', '--help'],
    ['start', '--help'],
    ['done', '--help'],
    ['drop', '--help'],
    ['todo', '--help'],
    ['edit', '--help'],
    ['rm', '--help'],
  ];
  for (const argv of cases) {
    const { deps, calls } = harness(() => ({ items: [], ready: [] }));
    assert.equal(await runPlan(argv, deps), 0, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});
