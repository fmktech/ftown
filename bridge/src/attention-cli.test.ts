import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AttentionApiError,
  buildAnswers,
  formatRoutedItem,
  runAttention,
  UsageError,
  type AttentionCliDeps,
  type RoutedItem,
} from './attention-cli.js';
import type { AttentionItem } from './attention-events.js';
import type { AttentionPrompt } from './attention-prompt-protocol.js';

const SELF = 'parent-1';
const CHILD = 'child-1';
const EVENT = 'evt-1';

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = (call: RecordedCall) => unknown;

function harness(handler: Handler): {
  deps: Partial<AttentionCliDeps>;
  calls: RecordedCall[];
  out: string[];
  err: string[];
} {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: Partial<AttentionCliDeps> = {
    api: async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
      const call: RecordedCall = { method, path, body, headers };
      calls.push(call);
      return handler(call);
    },
    env: { FTOWN_SESSION_ID: SELF },
    log: (text: string) => out.push(text),
    errorLog: (text: string) => err.push(text),
  };
  return { deps, calls, out, err };
}

const singlePrompt: AttentionPrompt = {
  channel: 'mail',
  questions: [
    {
      question: 'Pick a database',
      options: [{ label: 'Postgres' }, { label: 'SQLite' }],
      multiSelect: false,
      allowText: true,
    },
  ],
};

const multiPrompt: AttentionPrompt = {
  channel: 'mail',
  questions: [
    { question: 'Pick a database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false, allowText: false },
    { question: 'Pick a cache', options: [{ label: 'Redis' }, { label: 'None' }], multiSelect: true, allowText: true },
  ],
};

function makeItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: EVENT,
    sequence: 1,
    type: 'question',
    title: 'Pick a database',
    message: 'Which database should I use?',
    createdAt: '2026-01-01T12:00:00.000Z',
    lastSeenAt: '2026-01-01T12:00:00.000Z',
    occurrences: 1,
    route: 'parent',
    routedTo: SELF,
    prompt: singlePrompt,
    ...overrides,
  };
}

function routedItem(overrides: Partial<AttentionItem> = {}): RoutedItem {
  return { sessionId: CHILD, sessionName: 'kid-a', event: makeItem(overrides) };
}

/** Handler serving GET item, then the given POST result (or throwing it). */
function itemThen(postResult: unknown): Handler {
  return (call) => {
    if (call.method === 'GET') return { event: makeItem() };
    if (postResult instanceof Error) throw postResult;
    return postResult;
  };
}

// ───────────────────────── buildAnswers ─────────────────────────

test('buildAnswers maps 1-based indexes and exact labels to 0-based selected', () => {
  assert.deepEqual(buildAnswers(singlePrompt, { options: ['2'] }), [{ selected: [1] }]);
  assert.deepEqual(buildAnswers(singlePrompt, { options: ['Postgres'] }), [{ selected: [0] }]);
  assert.deepEqual(buildAnswers(singlePrompt, { text: 'Use both' }), [{ selected: [], text: 'Use both' }]);
});

test('buildAnswers sorts and dedupes multi-select choices', () => {
  const prompt: AttentionPrompt = {
    channel: 'mail',
    questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true, allowText: false }],
  };
  assert.deepEqual(buildAnswers(prompt, { options: ['3', '1', '3'] }), [{ selected: [0, 2] }]);
});

test('buildAnswers validates --answers-json against the prompt', () => {
  assert.deepEqual(
    buildAnswers(multiPrompt, { answersJson: '[{"selected":[1]},{"selected":[0,1],"text":"both"}]' }),
    [{ selected: [1] }, { selected: [0, 1], text: 'both' }],
  );
  assert.deepEqual(buildAnswers(multiPrompt, { answersJson: '{"answers":[{"selected":[0]},{"selected":[]}]}' }), [
    { selected: [0] },
    { selected: [] },
  ]);
  assert.throws(() => buildAnswers(multiPrompt, { answersJson: 'not json' }), UsageError);
  assert.throws(() => buildAnswers(multiPrompt, { answersJson: '[{"selected":[0]}]' }), UsageError);
  assert.throws(() => buildAnswers(multiPrompt, { answersJson: '[{"selected":[9]},{"selected":[]}]' }), UsageError);
  assert.throws(() => buildAnswers(multiPrompt, { answersJson: '[{"selected":[-1]},{"selected":[]}]' }), UsageError);
});

test('buildAnswers rejects usage errors', () => {
  assert.throws(() => buildAnswers(singlePrompt, { options: ['3'] }), UsageError);
  assert.throws(() => buildAnswers(singlePrompt, { options: ['MySQL'] }), UsageError);
  assert.throws(() => buildAnswers(singlePrompt, { options: ['1', '2'] }), /single choice/);
  assert.throws(() => buildAnswers(multiPrompt, { options: ['1'] }), /--answers-json/);
  assert.throws(() => buildAnswers(multiPrompt, { text: 'x' }), /--answers-json/);
  assert.throws(() => buildAnswers(singlePrompt, { text: '   ' }), UsageError);
  assert.throws(() => buildAnswers(undefined, { options: ['1'] }), UsageError);
  assert.deepEqual(buildAnswers(undefined, { text: 'free reply' }), [{ selected: [], text: 'free reply' }]);
  const noText: AttentionPrompt = {
    channel: 'mail',
    questions: [{ question: 'Pick', options: [{ label: 'A' }], multiSelect: false, allowText: false }],
  };
  assert.throws(() => buildAnswers(noText, { text: 'x' }), /does not accept free text/);
});

// ───────────────────────── formatRoutedItem ─────────────────────────

test('formatRoutedItem prints child, event id, title and numbered options', () => {
  assert.deepEqual(formatRoutedItem(routedItem()), [
    'kid-a evt-1 Pick a database',
    '  1) Postgres  2) SQLite',
  ]);
  assert.deepEqual(formatRoutedItem(routedItem({ prompt: multiPrompt })), [
    'kid-a evt-1 Pick a database',
    '  Q1: Pick a database',
    '    1) Postgres  2) SQLite',
    '  Q2: Pick a cache',
    '    1) Redis  2) None',
  ]);
});

// ───────────────────────── list ─────────────────────────

test('list maps to GET routed with the caller header and prints plain lines', async () => {
  const { deps, calls, out } = harness(() => ({ items: [routedItem()] }));
  assert.equal(await runAttention(['list'], deps), 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`GET /api/sessions/${SELF}/attention/routed`]);
  assert.equal(calls[0].headers?.['X-Ftown-Session-Id'], SELF);
  assert.deepEqual(out, ['kid-a evt-1 Pick a database', '  1) Postgres  2) SQLite']);
});

test('list --json prints the response and empty lists print a placeholder', async () => {
  const payload = { items: [routedItem()] };
  const jsonRun = harness(() => payload);
  assert.equal(await runAttention(['list', '--json'], jsonRun.deps), 0);
  assert.deepEqual(JSON.parse(jsonRun.out.join('\n')), payload);

  const emptyRun = harness(() => ({ items: [] }));
  assert.equal(await runAttention(['list'], emptyRun.deps), 0);
  assert.deepEqual(emptyRun.out, ['no routed questions']);
});

// ───────────────────────── answer ─────────────────────────

test('answer resolves an --option index via the fetched item and POSTs answers', async () => {
  const { deps, calls, out } = harness(itemThen({ event: makeItem() }));
  assert.equal(await runAttention(['answer', CHILD, EVENT, '--option', '2'], deps), 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    `GET /api/sessions/${CHILD}/attention/${EVENT}`,
    `POST /api/sessions/${CHILD}/attention/${EVENT}/answer`,
  ]);
  assert.deepEqual(calls[1].body, { answers: [{ selected: [1] }] });
  assert.equal(calls[1].headers?.['X-Ftown-Session-Id'], SELF);
  assert.equal(out[0], `answer recorded for ${CHILD} (${EVENT})`);
});

test('answer maps --text and --answers-json to the POST body', async () => {
  const textRun = harness(itemThen({ event: makeItem() }));
  assert.equal(await runAttention(['answer', CHILD, EVENT, '--text', 'Use Postgres'], textRun.deps), 0);
  assert.deepEqual(textRun.calls[1].body, { answers: [{ selected: [], text: 'Use Postgres' }] });

  const jsonRun = harness((call) => {
    if (call.method === 'GET') return { event: makeItem({ prompt: multiPrompt }) };
    return { event: makeItem({ prompt: multiPrompt }) };
  });
  assert.equal(
    await runAttention(['answer', CHILD, EVENT, '--answers-json', '[{"selected":[0]},{"selected":[1]}]'], jsonRun.deps),
    0,
  );
  assert.deepEqual(jsonRun.calls[1].body, { answers: [{ selected: [0] }, { selected: [1] }] });
});

test('answer usage errors exit 2 before any POST', async () => {
  const cases: string[][] = [
    ['answer', CHILD, EVENT],
    ['answer', CHILD, EVENT, '--option', '1', '--text', 'x'],
    ['answer', CHILD, EVENT, '--option', '9'],
    ['answer', CHILD, EVENT, '--option', 'MySQL'],
    ['answer', CHILD, EVENT, '--answers-json', '{bad'],
    ['answer', CHILD],
    ['answer', CHILD, EVENT, '--bogus'],
  ];
  for (const argv of cases) {
    const { deps, calls } = harness(itemThen({ event: makeItem() }));
    assert.equal(await runAttention(argv, deps), 2, argv.join(' '));
    assert.ok(calls.every((c) => c.method === 'GET'), argv.join(' '));
  }
});

test('answer to an already-resolved item exits 5 without POSTing', async () => {
  const { deps, calls, err } = harness((call) => {
    if (call.method === 'GET') return { event: makeItem({ resolvedAt: '2026-01-01T12:05:00.000Z' }) };
    throw new Error('must not POST');
  });
  assert.equal(await runAttention(['answer', CHILD, EVENT, '--option', '1'], deps), 5);
  assert.equal(calls.length, 1);
  assert.match(err.join('\n'), /already resolved/);
});

// ───────────────────────── escalate ─────────────────────────

test('escalate POSTs the note and prints a confirmation', async () => {
  const { deps, calls, out } = harness(() => ({ event: makeItem({ route: 'human' }) }));
  assert.equal(await runAttention(['escalate', CHILD, EVENT, '--note', 'Needs a human call'], deps), 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    `POST /api/sessions/${CHILD}/attention/${EVENT}/escalate`,
  ]);
  assert.deepEqual(calls[0].body, { note: 'Needs a human call' });
  assert.equal(calls[0].headers?.['X-Ftown-Session-Id'], SELF);
  assert.equal(out[0], `escalated ${EVENT} for ${CHILD} to the human`);
});

test('escalate without --note sends an empty body and over-long notes exit 2', async () => {
  const bare = harness(() => ({ event: makeItem() }));
  assert.equal(await runAttention(['escalate', CHILD, EVENT], bare.deps), 0);
  assert.deepEqual(bare.calls[0].body, {});

  const long = harness(() => ({ event: makeItem() }));
  assert.equal(await runAttention(['escalate', CHILD, EVENT, '--note', 'x'.repeat(501)], long.deps), 2);
  assert.equal(long.calls.length, 0);
});

// ───────────────────────── exit-code mapping ─────────────────────────

test('HTTP 403 maps to exit 4 and 409 to exit 5', async () => {
  const forbidden = harness(() => {
    throw new AttentionApiError(403, 'Caller is not the parent of this session');
  });
  assert.equal(await runAttention(['escalate', CHILD, EVENT], forbidden.deps), 4);
  assert.match(forbidden.err.join('\n'), /not the parent/);

  const conflict = harness(itemThen(new AttentionApiError(409, 'Attention item already escalated')));
  assert.equal(await runAttention(['answer', CHILD, EVENT, '--option', '1'], conflict.deps), 5);

  const conflictEscalate = harness(() => {
    throw new AttentionApiError(409, 'Attention item already routed to the human');
  });
  assert.equal(await runAttention(['escalate', CHILD, EVENT], conflictEscalate.deps), 5);
});

test('other HTTP errors exit 1 and a missing session id exits 2', async () => {
  const failing = harness(() => {
    throw new AttentionApiError(404, 'Session not found');
  });
  assert.equal(await runAttention(['list'], failing.deps), 1);
  assert.match(failing.err.join('\n'), /Session not found/);

  const noSelf = harness(() => ({ items: [] }));
  noSelf.deps.env = {};
  assert.equal(await runAttention(['list'], noSelf.deps), 2);
  assert.equal(noSelf.calls.length, 0);
  assert.match(noSelf.err.join('\n'), /FTOWN_SESSION_ID/);
});
