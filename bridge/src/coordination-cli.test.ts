import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCardPatch,
  evaluateWaitCondition,
  parseProgress,
  runBoard,
  runEvents,
  runStatus,
  UsageError,
  type CoordinationCliDeps,
} from './coordination-cli.js';
import type { Board, SessionCard, TreeEvent, TreeEventPage } from './coordination/contract.js';

const SELF = 'self-123';
const NOW = Date.parse('2026-01-01T12:00:00.000Z');

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

type Handler = (call: RecordedCall) => unknown;

function harness(handler: Handler): {
  deps: Partial<CoordinationCliDeps>;
  calls: RecordedCall[];
  out: string[];
  err: string[];
} {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: Partial<CoordinationCliDeps> = {
    api: async (method: string, path: string, body?: unknown) => {
      const call: RecordedCall = { method, path, body };
      calls.push(call);
      return handler(call);
    },
    now: () => NOW,
    env: { FTOWN_SESSION_ID: SELF },
    log: (text: string) => out.push(text),
    errorLog: (text: string) => err.push(text),
  };
  return { deps, calls, out, err };
}

function makeCard(overrides: Partial<SessionCard> = {}): SessionCard {
  return {
    sessionId: SELF,
    name: 'worker-a',
    declared: {
      state: 'working',
      headline: 'Building the CLI',
      progress: { done: 3, total: 7 },
      next: 'Write the tests',
      updatedAt: '2026-01-01T11:59:00.000Z',
    },
    derived: {
      status: 'running',
      activity: 'working',
      openAttention: 0,
      unreadMail: 0,
      previews: [],
    },
    stale: false,
    ...overrides,
  };
}

function childCard(name: string, state: 'done' | 'blocked' | 'working' | null, prState?: 'passed'): SessionCard {
  return {
    sessionId: `id-${name}`,
    name,
    declared:
      state === null
        ? null
        : { state, headline: `${name} headline`, updatedAt: '2026-01-01T11:59:00.000Z' },
    derived: {
      status: 'running',
      activity: 'working',
      openAttention: 0,
      unreadMail: 0,
      previews: [],
      ...(prState ? { pr: { url: 'https://example.invalid/pr/1', state: prState, stale: false, checkedAt: null } } : {}),
    },
    stale: false,
  };
}

function makeBoard(cards: SessionCard[], cursor = 5): Board {
  return {
    rootId: SELF,
    cursor,
    cards,
    rollup: { working: 0, blocked: 0, waiting_review: 0, done: 0, failed: 0, unset: 0 },
  };
}

function makeEvent(seq: number): TreeEvent {
  return {
    seq,
    ts: '2026-01-01T12:00:00.000Z',
    sessionId: 'id-kid',
    sessionName: 'kid',
    kind: 'status',
    summary: `event ${seq}`,
  };
}

function eventFor(card: SessionCard, seq = 1): TreeEvent {
  return { ...makeEvent(seq), sessionId: card.sessionId, sessionName: card.name };
}

function page(events: TreeEvent[], cursor: number, timedOut?: boolean): TreeEventPage {
  return timedOut ? { events, cursor, timedOut: true } : { events, cursor };
}

// ───────────────────────── parseProgress / buildCardPatch ─────────────────────────

test('parseProgress accepts strict done/total and rejects malformed values', () => {
  assert.deepEqual(parseProgress('3/7'), { done: 3, total: 7 });
  assert.deepEqual(parseProgress('0/1'), { done: 0, total: 1 });
  for (const bad of ['3', '3/', '/7', 'a/b', '3.5/7', '-1/7', '3 /7', '8/7', '3/0', '0/10001', '']) {
    assert.throws(() => parseProgress(bad), UsageError, bad);
  }
});

test('buildCardPatch maps flags to a CardPatch', () => {
  assert.deepEqual(
    buildCardPatch({
      state: 'blocked',
      headline: 'Stuck',
      progress: '3/7',
      on: 'session:other-9',
      text: 'waiting on review',
      next: 'Ship it',
    }),
    {
      state: 'blocked',
      headline: 'Stuck',
      progress: { done: 3, total: 7 },
      blockedOn: { kind: 'session', ref: 'other-9', text: 'waiting on review' },
      next: 'Ship it',
    },
  );
  assert.deepEqual(buildCardPatch({ on: 'human', text: 'need input' }), {
    blockedOn: { kind: 'human', text: 'need input' },
  });
  assert.deepEqual(buildCardPatch({ progress: false, next: false }), { progress: null, next: null });
});

test('buildCardPatch rejects usage errors', () => {
  assert.throws(() => buildCardPatch({}), UsageError);
  assert.throws(() => buildCardPatch({ state: 'nope' }), UsageError);
  assert.throws(() => buildCardPatch({ on: 'human' }), /--on requires --text/);
  assert.throws(() => buildCardPatch({ text: 'orphan' }), /--text requires --on/);
  assert.throws(() => buildCardPatch({ on: 'session:', text: 'x' }), UsageError);
  assert.throws(() => buildCardPatch({ on: 'bogus', text: 'x' }), UsageError);
  assert.throws(() => buildCardPatch({ progress: '1/2/3' }), UsageError);
});

// ───────────────────────── evaluateWaitCondition ─────────────────────────

test('evaluateWaitCondition covers all five conditions', () => {
  const doneKid = childCard('a', 'done');
  const blockedKid = childCard('b', 'blocked');
  const readyKid = childCard('c', 'working', 'passed');
  const workingKid = childCard('d', 'working');
  const unsetKid = childCard('e', null);
  const oneEvent = [makeEvent(1)];

  assert.equal(evaluateWaitCondition('any-change', makeBoard([]), oneEvent), true);
  assert.equal(evaluateWaitCondition('any-change', makeBoard([doneKid]), []), false);

  assert.equal(evaluateWaitCondition('any-done', makeBoard([doneKid]), []), false);
  assert.equal(evaluateWaitCondition('any-done', makeBoard([doneKid]), [eventFor(doneKid)]), true);
  assert.equal(evaluateWaitCondition('any-done', makeBoard([doneKid, workingKid]), [eventFor(workingKid)]), false);
  assert.equal(evaluateWaitCondition('any-done', makeBoard([workingKid]), [eventFor(workingKid)]), false);

  assert.equal(evaluateWaitCondition('any-blocked', makeBoard([blockedKid]), []), false);
  assert.equal(evaluateWaitCondition('any-blocked', makeBoard([blockedKid]), [eventFor(blockedKid)]), true);
  assert.equal(evaluateWaitCondition('any-blocked', makeBoard([blockedKid, workingKid]), [eventFor(workingKid)]), false);

  assert.equal(evaluateWaitCondition('all-done', makeBoard([doneKid, doneKid]), []), true);
  assert.equal(evaluateWaitCondition('all-done', makeBoard([doneKid, workingKid]), []), false);
  assert.equal(evaluateWaitCondition('all-done', makeBoard([doneKid, unsetKid]), []), false);
  assert.equal(evaluateWaitCondition('all-done', makeBoard([]), []), false);
  assert.equal(evaluateWaitCondition('all-done', makeBoard([doneKid]), [eventFor(workingKid)]), true);

  const doneWithPr = childCard('f', 'done', 'passed');
  assert.equal(evaluateWaitCondition('any-ready', makeBoard([readyKid]), []), false);
  assert.equal(evaluateWaitCondition('any-ready', makeBoard([readyKid]), [eventFor(readyKid)]), true);
  assert.equal(evaluateWaitCondition('any-ready', makeBoard([doneWithPr]), [eventFor(doneWithPr)]), false);
  assert.equal(evaluateWaitCondition('any-ready', makeBoard([readyKid, workingKid]), [eventFor(workingKid)]), false);
});

// ───────────────────────── status ─────────────────────────

test('status prints the plain row plus next line and maps to GET card', async () => {
  const { deps, calls, out } = harness(() => makeCard());
  assert.equal(await runStatus([], deps), 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`GET /api/sessions/${SELF}/card`]);
  assert.match(out[0], /^worker-a working working {2}Building the CLI {2}3\/7$/);
  assert.equal(out[1], 'next: Write the tests');
});

test('status --json prints the card JSON and honours --session-id', async () => {
  const card = makeCard();
  const { deps, calls, out } = harness(() => card);
  assert.equal(await runStatus(['--json', '--session-id', 'other-1'], deps), 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /api/sessions/other-1/card']);
  assert.deepEqual(JSON.parse(out.join('\n')), card);
});

test('status without a declared card prints no next line', async () => {
  const { deps, out } = harness(() => makeCard({ declared: null }));
  assert.equal(await runStatus([], deps), 0);
  assert.equal(out.length, 1);
  assert.match(out[0], /^worker-a - working {2}-$/);
});

test('status set sends the built patch and prints the resulting card', async () => {
  const updated = makeCard({
    declared: {
      state: 'blocked',
      headline: 'Stuck',
      blockedOn: { kind: 'human', text: 'need input' },
      next: 'Ship it',
      updatedAt: '2026-01-01T12:00:00.000Z',
    },
  });
  const { deps, calls, out } = harness(() => updated);
  const code = await runStatus(
    ['set', '--state', 'blocked', '--headline', 'Stuck', '--on', 'human', '--text', 'need input', '--next', 'Ship it', '--no-progress'],
    deps,
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, `/api/sessions/${SELF}/card`);
  assert.deepEqual(calls[0].body, {
    state: 'blocked',
    headline: 'Stuck',
    progress: null,
    blockedOn: { kind: 'human', text: 'need input' },
    next: 'Ship it',
  });
  assert.match(out[0], /^worker-a blocked /);
  assert.equal(out[1], 'next: Ship it');
});

test('status set --on session:<id> sets the blockedOn ref', async () => {
  const { deps, calls } = harness(() => makeCard());
  assert.equal(await runStatus(['set', '--on', 'session:other-9', '--text', 'waiting'], deps), 0);
  assert.deepEqual(calls[0].body, { blockedOn: { kind: 'session', ref: 'other-9', text: 'waiting' } });
});

test('status set --state blocked without --on exits 2 when the card is not already blocked', async () => {
  const { deps, calls, err } = harness(() => makeCard());
  assert.equal(await runStatus(['set', '--state', 'blocked'], deps), 2);
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
  assert.match(err.join('\n'), /--state blocked needs --on <human\|parent\|external\|session:id> and --text/);
});

test('status set --state blocked without --on is allowed when the card is already blocked', async () => {
  const blocked = makeCard({
    declared: {
      state: 'blocked',
      headline: 'Stuck',
      blockedOn: { kind: 'human', text: 'need input' },
      updatedAt: '2026-01-01T11:59:00.000Z',
    },
  });
  const { deps, calls } = harness((call) => (call.method === 'GET' ? blocked : blocked));
  assert.equal(await runStatus(['set', '--state', 'blocked', '--headline', 'Still stuck'], deps), 0);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PUT']);
  assert.deepEqual(calls[1].body, { state: 'blocked', headline: 'Still stuck' });
});

test('status set with no flags exits 2 and makes no request', async () => {
  const { deps, calls, err } = harness(() => makeCard());
  assert.equal(await runStatus(['set'], deps), 2);
  assert.equal(calls.length, 0);
  assert.match(err.join('\n'), /Nothing to set/);
});

test('status set usage errors exit 2 and make no request', async () => {
  const cases: string[][] = [
    ['set', '--progress', 'three/seven'],
    ['set', '--progress', '9/7'],
    ['set', '--on', 'human'],
    ['set', '--text', 'orphan'],
    ['set', '--on', 'bogus', '--text', 'x'],
    ['set', '--state', 'bogus'],
    ['set', '--bogus-flag'],
    ['bogus-subcommand'],
  ];
  for (const argv of cases) {
    const { deps, calls } = harness(() => makeCard());
    assert.equal(await runStatus(argv, deps), 2, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});

test('status clear sends DELETE', async () => {
  const { deps, calls, out } = harness(() => ({ ok: true }));
  assert.equal(await runStatus(['clear'], deps), 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`DELETE /api/sessions/${SELF}/card`]);
  assert.equal(out[0], `card cleared for ${SELF}`);
});

test('missing session id exits 2 for status, board and events', async () => {
  for (const run of [runStatus, runBoard, runEvents]) {
    const { deps, calls, err } = harness(() => makeCard());
    deps.env = {};
    assert.equal(await run([], deps), 2);
    assert.equal(calls.length, 0);
    assert.match(err.join('\n'), /FTOWN_SESSION_ID/);
  }
});

test('HTTP errors exit 1 with the server message', async () => {
  const { deps, err } = harness(() => {
    throw new Error('Session not found');
  });
  assert.equal(await runStatus([], deps), 1);
  assert.match(err.join('\n'), /Session not found/);
});

// ───────────────────────── board ─────────────────────────

test('board maps since/ready/all to the query and prints formatBoard plus cursor', async () => {
  const board = makeBoard([childCard('kid', 'working')], 42);
  const { deps, calls, out } = harness(() => board);
  assert.equal(await runBoard(['--since', '3', '--ready', '--all'], deps), 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    `GET /api/sessions/${SELF}/board?since=3&ready=1&all=1`,
  ]);
  assert.match(out.join('\n'), /kid working/);
  assert.equal(out[out.length - 1], 'cursor 42');
});

test('board --json prints the board JSON without the cursor line', async () => {
  const board = makeBoard([childCard('kid', 'done')], 7);
  const { deps, out } = harness(() => board);
  assert.equal(await runBoard(['--json'], deps), 0);
  assert.deepEqual(JSON.parse(out.join('\n')), board);
});

test('board rejects invalid since, until and timeout values with exit 2', async () => {
  const cases: string[][] = [
    ['--since', '-1'],
    ['--since', 'abc'],
    ['--wait'],
    ['--until', 'any-done'],
    ['--wait', '--until', 'bogus'],
    ['--wait', '--until', 'any-done', '--timeout', '0'],
    ['--wait', '--until', 'any-done', '--timeout', '301'],
    ['--wait', '--until', 'any-done', '--timeout', '1.5'],
    ['--timeout', '10'],
  ];
  for (const argv of cases) {
    const { deps, calls } = harness(() => makeBoard([]));
    assert.equal(await runBoard(argv, deps), 2, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});

test('board --wait exits 0 when an arriving event makes a child done', async () => {
  let boardCalls = 0;
  const { deps, out } = harness((call) => {
    if (call.path.includes('/board')) {
      boardCalls += 1;
      return boardCalls === 1 ? makeBoard([childCard('kid', 'working')], 5) : makeBoard([childCard('kid', 'done')], 6);
    }
    return page([makeEvent(6)], 6);
  });
  assert.equal(await runBoard(['--wait', '--until', 'any-done', '--timeout', '30'], deps), 0);
  assert.equal(out[out.length - 1], 'cursor 6');
});

test('board --wait any-done ignores an already-done child when a different child changes', async () => {
  let polls = 0;
  const done = childCard('done-kid', 'done');
  const other = childCard('other', 'working');
  const { deps, out } = harness((call) => {
    if (call.path.includes('/board')) return makeBoard([done, other], 5);
    polls += 1;
    if (polls === 1) return page([eventFor(other, 6)], 6);
    return page([], 6, true);
  });
  assert.equal(await runBoard(['--wait', '--until', 'any-done', '--timeout', '1'], deps), 3);
  assert.equal(polls, 2);
  assert.match(out.join('\n'), /done-kid done/);
});

test('board --wait any-done accepts a child whose event arrived after the cursor even if a later event is unrelated', async () => {
  let boardCalls = 0;
  let polls = 0;
  const done = childCard('done-kid', 'done');
  const workingSame = childCard('done-kid', 'working');
  const other = childCard('other', 'working');
  const { deps } = harness((call) => {
    if (call.path.includes('/board')) {
      boardCalls += 1;
      if (boardCalls < 3) return makeBoard([workingSame, other], boardCalls === 1 ? 5 : 6);
      return makeBoard([done, other], 7);
    }
    polls += 1;
    if (polls === 1) return page([eventFor(workingSame, 6)], 6);
    if (polls === 2) return page([eventFor(other, 7)], 7);
    return page([], 7, true);
  });
  assert.equal(await runBoard(['--wait', '--until', 'any-done', '--timeout', '30'], deps), 0);
  assert.equal(polls, 2);
});

test('board --wait does not pre-check: an already-done child still waits for new events', async () => {
  const { deps, calls } = harness((call) => {
    if (call.path.includes('/board')) return makeBoard([childCard('kid', 'done')], 5);
    return page([], 5, true);
  });
  assert.equal(await runBoard(['--wait', '--until', 'any-done', '--timeout', '1'], deps), 3);
  assert.ok(calls.some((c) => c.path.includes('/events')), 'must poll events past the starting cursor');
});

test('board --wait evaluates on the unfiltered board but prints the filtered board', async () => {
  let unfilteredCalls = 0;
  const { deps, out } = harness((call) => {
    if (call.path.includes('ready=1')) return makeBoard([childCard('ready-kid', 'working', 'passed')], 9);
    if (call.path.includes('/board')) {
      unfilteredCalls += 1;
      return unfilteredCalls === 1
        ? makeBoard([childCard('kid', 'working')], 5)
        : makeBoard([childCard('kid', 'done')], 6);
    }
    return page([makeEvent(6)], 6);
  });
  assert.equal(await runBoard(['--wait', '--until', 'any-done', '--ready', '--timeout', '30'], deps), 0);
  assert.match(out.join('\n'), /ready-kid/);
  assert.equal(out[out.length - 1], 'cursor 9');
});

test('board --wait any-change exits 0 on the first event', async () => {
  let boardCalls = 0;
  const { deps } = harness((call) => {
    if (call.path.includes('/board')) {
      boardCalls += 1;
      return makeBoard([childCard('kid', 'working')], boardCalls === 1 ? 5 : 6);
    }
    return page([makeEvent(6)], 6);
  });
  assert.equal(await runBoard(['--wait', '--until', 'any-change', '--timeout', '30'], deps), 0);
});

test('board --wait times out with exit 3 and still prints the board', async () => {
  const { deps, out, calls } = harness((call) => {
    if (call.path.includes('/board')) return makeBoard([childCard('kid', 'working')], 5);
    assert.match(call.path, /waitSeconds=1/);
    return page([], 5, true);
  });
  assert.equal(await runBoard(['--wait', '--until', 'any-done', '--timeout', '1'], deps), 3);
  assert.equal(out[out.length - 1], 'cursor 5');
  assert.ok(calls.some((c) => c.path.includes('/events')));
});

// ───────────────────────── events ─────────────────────────

test('events maps since/limit and prints one line per event plus cursor', async () => {
  const { deps, calls, out } = harness(() => page([makeEvent(2), makeEvent(3)], 3));
  assert.equal(await runEvents(['--since', '1', '--limit', '10'], deps), 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    `GET /api/sessions/${SELF}/events?since=1&limit=10`,
  ]);
  assert.equal(out.length, 3);
  assert.match(out[0], /^#2 .* kid status: event 2$/);
  assert.match(out[1], /^#3 .* kid status: event 3$/);
  assert.equal(out[2], 'cursor 3');
});

test('events --json prints the page JSON', async () => {
  const expected = page([makeEvent(1)], 1);
  const { deps, out } = harness(() => expected);
  assert.equal(await runEvents(['--json'], deps), 0);
  assert.deepEqual(JSON.parse(out.join('\n')), expected);
});

test('events rejects invalid values with exit 2', async () => {
  const cases: string[][] = [
    ['--since', 'x'],
    ['--limit', '0'],
    ['--limit', '501'],
    ['--limit', 'x'],
    ['--timeout', '10'],
    ['--wait', '--timeout', '0'],
    ['--wait', '--timeout', '301'],
  ];
  for (const argv of cases) {
    const { deps, calls } = harness(() => page([], 0));
    assert.equal(await runEvents(argv, deps), 2, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});

test('events --wait prints arriving events and exits 0', async () => {
  const { deps, out } = harness((call) => {
    if (call.path.includes('/board')) return makeBoard([], 0);
    assert.match(call.path, /waitSeconds=/);
    return page([makeEvent(1)], 1);
  });
  assert.equal(await runEvents(['--wait', '--timeout', '30'], deps), 0);
  assert.match(out[0], /^#1 /);
  assert.equal(out[1], 'cursor 1');
});

test('events --wait without --since starts from the current head, not 0', async () => {
  const { deps, calls, out } = harness((call) => {
    if (call.path.includes('/board')) return makeBoard([], 9);
    assert.match(call.path, /since=9&/);
    return page([makeEvent(10)], 10);
  });
  assert.equal(await runEvents(['--wait', '--timeout', '30'], deps), 0);
  assert.equal(calls[0].path, `/api/sessions/${SELF}/board`);
  assert.match(calls[1].path, /\/events\?since=9&waitSeconds=30$/);
  assert.match(out[0], /^#10 /);
  assert.equal(out[1], 'cursor 10');
});

test('events --wait with no events times out with exit 3', async () => {
  const { deps, out, calls } = harness(() => page([], 4, true));
  assert.equal(await runEvents(['--wait', '--since', '4', '--timeout', '1'], deps), 3);
  assert.deepEqual(out, ['cursor 4']);
  assert.ok(calls.length >= 1);
});

test('events HTTP errors exit 1 with the server message', async () => {
  const { deps, err } = harness(() => {
    throw new Error('boom');
  });
  assert.equal(await runEvents([], deps), 1);
  assert.match(err.join('\n'), /boom/);
});
