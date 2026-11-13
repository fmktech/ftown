import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { attentionClock, runSessions } from './sessions-commands.js';
import { secureFixture } from './security/bridge/fixtures.test.js';

interface Request { url: string; method: string; body?: unknown }
async function fixture(run: (requests: Request[], output: string[]) => Promise<void>, reply?: (request: Request) => unknown): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'ftown-sessions-unit-'));
  const previousHome = process.env.HOME;
  const previousSession = process.env.FTOWN_SESSION_ID;
  const previousDataDir = process.env.FTOWN_DATA_DIR;
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const previousError = console.error;
  const requests: Request[] = []; const output: string[] = [];
  mkdirSync(join(home, '.ftown'));
  process.env.HOME = home;
  delete process.env.FTOWN_SESSION_ID;
  // Isolate from inherited FTOWN_DATA_DIR: bridgePointerPath() would otherwise
  // resolve to the production data dir's bridge.json instead of this temp home.
  process.env.FTOWN_DATA_DIR = join(home, '.ftown', 'data');
  const secure = await secureFixture(join(home, '.ftown'), async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    return new Response(JSON.stringify(reply ? reply(requests.at(-1)!) : { session: { id: 'created', name: 'unit', status: 'idle' }, sessions: [], messages: [] }));
  }, 12345);
  writeFileSync(join(home, '.ftown', 'bridge.json'), JSON.stringify(secure.pointer));
  globalThis.fetch = secure.fetch;
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  try { await run(requests, output); }
  finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousSession === undefined) delete process.env.FTOWN_SESSION_ID; else process.env.FTOWN_SESSION_ID = previousSession;
    if (previousDataDir === undefined) delete process.env.FTOWN_DATA_DIR; else process.env.FTOWN_DATA_DIR = previousDataDir;
    await secure.security.close();
    globalThis.fetch = previousFetch; console.log = previousLog; console.error = previousError;
    rmSync(home, { recursive: true, force: true });
  }
}

test('create --help describes options without opening transport or creating a session', async () => fixture(async (requests) => {
  assert.equal(await runSessions(['create', '--help']), 0);
  assert.equal(requests.length, 0, 'help must not POST /api/sessions');
}));

test('generated help and invalid command options finish before any transport access', async () => fixture(async (requests, output) => {
  for (const command of ['list', 'create', 'get', 'screen', 'grep', 'keys', 'tell', 'inbox', 'mail', 'running', 'usage', 'remove', 'archive', 'revive', 'attention', 'attention-status', 'pr']) {
    assert.equal(await runSessions([command, '--help']), 0, command);
  }
  assert.ok(output.some((line) => line.includes('Usage: ftown sessions create')));
  for (const args of [['create', '--unknown'], ['create', '--model'], ['get'], ['grep', 'id'], ['keys', 'id'], ['create', 'unexpected']]) {
    assert.equal(await runSessions(args), 1, args.join(' '));
  }
  assert.equal(requests.length, 0);
}));

test('create preserves option payload and accepts the no-op orchestrator compatibility flag', async () => fixture(async (requests) => {
  assert.equal(await runSessions(['create', '--shell', 'codex', '--prompt', 'hello', '--workdir', '/tmp/work', '--create-workdir',
    '--name', 'agent', '--command', 'custom', '--model', 'model', '--parent', '--parent-id', 'parent-id', '--orchestrator']), 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST'); assert.ok(requests[0].url.endsWith('/api/sessions'));
  assert.deepEqual(requests[0].body, { shellType: 'codex', prompt: 'hello', workingDir: '/tmp/work', createMissingWorkingDir: true,
    name: 'agent', command: 'custom', model: 'model', parentSessionId: 'parent-id' });
}));

test('terminal and mail commands preserve their legacy requests and inbox alias', async () => fixture(async (requests, output) => {
  assert.equal(await runSessions(['grep', 'session', '--pattern', 'question', '--offset', '2', '--limit', '7']), 0);
  assert.deepEqual(requests.at(-1)?.body, { pattern: 'question', offset: 2, limit: 7 });
  assert.equal(await runSessions(['keys', 'session', 'hello', 'world']), 0);
  assert.deepEqual(requests.at(-1)?.body, { keys: 'hello world' });
  assert.equal(await runSessions(['tell', 'target', 'hello', 'world', '--type', 'task', '--thread', 'thread']), 0);
  assert.deepEqual(requests.at(-1)?.body, { body: 'hello world', type: 'task', threadId: 'thread' });
  assert.ok(requests.at(-1)?.url.endsWith('/api/sessions/target/inbox'));
  assert.equal(await runSessions(['tell', 'target', 'text', '--keys']), 0);
  assert.deepEqual(requests.at(-1)?.body, { text: 'text' });
  process.env.FTOWN_SESSION_ID = 'self';
  assert.equal(await runSessions(['mail', '--peek', '--all', '--limit', '3', '--json']), 0);
  assert.ok(requests.at(-1)?.url.endsWith('/api/sessions/self/inbox?wait=0&peek=1&limit=3&all=1'));
  assert.deepEqual(JSON.parse(output.at(-1) ?? ''), { messages: [] });
}));

test('fanout without message fails before resolving any target session', async () => fixture(async (requests) => {
  process.env.FTOWN_SESSION_ID = 'self';
  for (const mode of ['--parent', '--children', '--siblings']) assert.equal(await runSessions(['tell', mode]), 1);
  assert.equal(requests.length, 0, 'missing message must not fetch sessions for fanout');
}));

const newCapabilities = { capabilities: { attention: { version: 1, request: true }, sessionMetadata: { pullRequest: true } } };

test('preview probes capability before registering and clearing; old bridges never mutate', async () => fixture(async (requests) => {
  process.env.FTOWN_SESSION_ID = 'self-id';
  assert.equal(await runSessions(['preview', 'index.html']), 0);
  assert.equal(requests[0].method, 'GET'); assert.equal(requests[1].method, 'PUT');
  assert.deepEqual(requests[1].body, { paths: [new URL('index.html', `file://${process.cwd()}/`).pathname], mode: 'replace' });
  assert.equal(await runSessions(['preview', '--clear']), 0);
  assert.equal(requests[2].method, 'GET'); assert.equal(requests[3].method, 'DELETE');
}, request => request.method === 'GET' ? { capabilities: { sessionMetadata: { preview: true } } } : { session: { id: 'self-id' } }));

test('preview replaces, adds and removes files; flags are mutually exclusive', async () => fixture(async (requests, output) => {
  process.env.FTOWN_SESSION_ID = 'self-id';
  assert.equal(await runSessions(['preview', 'a.html', 'notes.md']), 0);
  assert.deepEqual(requests[1].body, { paths: [new URL('a.html', `file://${process.cwd()}/`).pathname, new URL('notes.md', `file://${process.cwd()}/`).pathname], mode: 'replace' });
  assert.equal(await runSessions(['preview', '--add', 'c.html']), 0);
  assert.deepEqual(requests[3].body, { paths: [new URL('c.html', `file://${process.cwd()}/`).pathname], mode: 'add' });
  assert.equal(await runSessions(['preview', '--remove', 'notes.md']), 0);
  assert.equal(requests[5].method, 'DELETE');
  assert.deepEqual(requests[5].body, { names: ['notes.md'] });
  assert.equal(await runSessions(['preview', '--remove', 'a.html', 'c.html']), 0);
  assert.deepEqual(requests[7].body, { names: ['a.html', 'c.html'] });
  assert.equal(await runSessions(['preview', '--add', 'a.html', '--remove', 'notes.md']), 1);
  assert.equal(await runSessions(['preview', '--add', 'a.html', '--clear']), 1);
  assert.equal(await runSessions(['preview', '--remove', 'a.html', '--clear']), 1);
  assert.equal(await runSessions(['preview', 'a.html', '--add', 'b.html']), 1);
  assert.equal(await runSessions(['preview', 'a.html', '--remove', 'b.html']), 1);
  assert.ok(output.some(line => line.includes('only one of --add, --remove or --clear')));
}, request => request.method === 'GET' ? { capabilities: { sessionMetadata: { preview: true } } } : { session: { id: 'self-id' } }));

test('preview rejects missing or contradictory arguments and missing capability without mutation', async () => fixture(async (requests, output) => {
  process.env.FTOWN_SESSION_ID = 'self-id';
  assert.equal(await runSessions(['preview']), 1);
  assert.equal(await runSessions(['preview', 'index.html', '--clear']), 1);
  assert.equal(requests.length, 0);
  assert.equal(await runSessions(['preview', 'index.html']), 1);
  assert.equal(requests.length, 1); assert.equal(requests[0].method, 'GET');
  assert.ok(output.some(line => line.includes('bridge_upgrade_required')));
}, () => ({ capabilities: { sessionMetadata: { pullRequest: true } } })));

test('preview reply uses self, stable IDs and bounded UTF-8 file input', async () => fixture(async (requests, output) => {
  process.env.FTOWN_SESSION_ID = 'self-id';
  const messageId = '12345678-1234-4234-8234-123456789abc';
  assert.equal(await runSessions(['preview-reply', '--message', 'hello\nworld', '--id', messageId]), 0);
  assert.ok(requests.at(-1)?.url.endsWith('/api/sessions/self-id/preview-chat/reply'));
  assert.deepEqual(requests.at(-1)?.body, { id: messageId, text: 'hello\nworld' });
  const file = join(process.env.HOME!, 'reply.txt'); writeFileSync(file, 'line one\nline two');
  assert.equal(await runSessions(['preview-reply', '--message-file', file, '--session-id', 'other', '--id', messageId]), 0);
  assert.deepEqual(requests.at(-1)?.body, { id: messageId, text: 'line one\nline two' });
  assert.ok(requests.at(-1)?.url.endsWith('/api/sessions/other/preview-chat/reply'));
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  try {
    Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([Buffer.from('stdin\nreply')]) });
    assert.equal(await runSessions(['preview-reply', '--message-file', '-', '--id', messageId]), 0);
    assert.deepEqual(requests.at(-1)?.body, { id: messageId, text: 'stdin\nreply' });
  } finally { if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor); }
  const before = requests.length;
  assert.equal(await runSessions(['preview-reply', '--message', 'a', '--message-file', file]), 1);
  writeFileSync(file, 'x'.repeat(4097));
  assert.equal(await runSessions(['preview-reply', '--message-file', file]), 1);
  assert.equal(requests.length, before);
  assert.ok(output.some(line => line.includes('too large')));
}, request => ({ sessionId: 'self-id', turn: { id: (request.body as { id: string }).id } })));

test('attention uses trimmed self identity, probes support and returns the exact sanitized result', async () => fixture(async (requests, output) => {
  process.env.FTOWN_SESSION_ID = '  self-id  ';
  assert.equal(await runSessions(['attention', '--message', ' Please check API_KEY=secret ', '--title', ' Review requested ']), 0);
  assert.deepEqual(requests.map(({ method, url }) => [method, new URL(url).pathname]), [
    ['GET', '/api/sessions/self-id'], ['POST', '/api/sessions/self-id/attention'],
  ]);
  assert.deepEqual(requests[1].body, { message: 'Please check API_KEY=[redacted]', title: 'Review requested' });
  assert.deepEqual(JSON.parse(output.at(-1) ?? ''), { event: { id: 'exact-event', occurrences: 2 } });
}, (request) => request.method === 'GET' ? newCapabilities : { event: { id: 'exact-event', occurrences: 2 } }));

test('explicit self-action target overrides env; PR attach, replace and clear preserve HTTP envelopes', async () => fixture(async (requests, output) => {
  process.env.FTOWN_SESSION_ID = 'invalid/env';
  for (const [input, expected] of [
    [' https://github.com/fmktech/ftown/pull/128/?view=1#discussion ', 'https://github.com/fmktech/ftown/pull/128'],
    ['https://github.com/other/repo/pull/5', 'https://github.com/other/repo/pull/5'],
  ]) {
    assert.equal(await runSessions(['pr', input, '--session-id', ' explicit-id ']), 0);
    assert.equal(requests.at(-1)?.method, 'PATCH');
    assert.ok(requests.at(-1)?.url.endsWith('/api/sessions/explicit-id'));
    assert.deepEqual(requests.at(-1)?.body, { pullRequestUrl: expected });
    assert.deepEqual(JSON.parse(output.at(-1) ?? ''), { session: { id: 'explicit-id', pullRequestUrl: expected } });
  }
  assert.equal(await runSessions(['pr', '--clear', '--session-id', 'explicit-id', '--plain']), 0);
  assert.deepEqual(requests.at(-1)?.body, { pullRequestUrl: null });
  assert.equal(output.at(-1), 'pull request cleared for explicit-id');
  assert.equal(await runSessions(['attention', '--message', 'Check this', '--session-id', 'explicit-id']), 0);
  assert.deepEqual(requests.at(-1)?.body, { message: 'Check this' });
}, (request) => request.method === 'GET' ? newCapabilities : { session: { id: 'explicit-id', ...(request.body as object) } }));

test('self-action local validation rejects invalid identity and arguments without opening transport', async () => fixture(async (requests) => {
  for (const env of [undefined, ' ', '../session', 'session/id']) {
    if (env === undefined) delete process.env.FTOWN_SESSION_ID; else process.env.FTOWN_SESSION_ID = env;
    assert.equal(await runSessions(['attention', '--message', 'Review']), 1);
    assert.equal(await runSessions(['pr', '--clear']), 1);
  }
  process.env.FTOWN_SESSION_ID = 'self';
  const invalid = [
    ['attention'], ['attention', '--message', ' '], ['attention', '--message', '\x1b[31m'],
    ['attention', '--message', 'x'.repeat(2001)], ['attention', '--message', 'ok', '--title', ' '],
    ['attention', '--message', 'ok', '--title', 'x'.repeat(201)], ['attention', '--message', 'ok', 'extra'],
    ['attention', '--message', 'ok', '--session-id', '../bad'], ['pr'], ['pr', '--clear', '--session-id', ' '],
    ['pr', 'https://github.com/o/r/pull/1', '--clear'], ['pr', 'https://github.com/o/r/pull/1', 'extra'],
    ...['', 'http://github.com/o/r/pull/1', 'https://evil.example/o/r/pull/1', 'https://u@github.com/o/r/pull/1',
      'https://github.com:444/o/r/pull/1', 'https://github.com/o/r/pull/0', 'https://github.com/o/r/pull/9007199254740992',
      'https://github.com/o%2Fr/r/pull/1', 'https://github.com/o/r/pull/1/files'].map((url) => ['pr', url]),
  ];
  for (const args of invalid) assert.equal(await runSessions(args), 1, args.join(' '));
  assert.equal(requests.length, 0, 'no pointer/fetch access is needed for invalid self actions');
}));

test('new self-actions fail closed on old, false or mismatched capabilities before mutation', async () => {
  for (const capabilities of [{}, { attention: { version: 1 } }, { attention: { version: 2, request: true } },
    { attention: { version: 1, request: false }, sessionMetadata: { pullRequest: false } }]) {
    await fixture(async (requests, output) => {
      process.env.FTOWN_SESSION_ID = 'self';
      assert.equal(await runSessions(['attention', '--message', 'Review']), 1);
      assert.equal(await runSessions(['pr', '--clear']), 1);
      assert.deepEqual(requests.map((r) => r.method), ['GET', 'GET']);
      assert.ok(output.every((line) => line.includes('bridge_upgrade_required')));
    }, () => ({ capabilities }));
  }
});

const promptCapabilities = { capabilities: { attention: { version: 1, request: true, prompt: true } } };
const askedPrompt = { channel: 'mail', questions: [{ question: 'Which?', options: [{ label: 'Alpha' }, { label: 'Beta' }], multiSelect: false, allowText: true }] };
const answeredItem = { id: 'evt-1', resolvedAt: 'now', resolution: 'answered', prompt: askedPrompt, answer: { answers: [{ selected: [1] }], answeredAt: 'now' } };

async function withFakeClock(run: (sleeps: number[], advance: (ms: number) => void) => Promise<void>): Promise<void> {
  const original = { ...attentionClock };
  let now = 1_000_000; const sleeps: number[] = [];
  attentionClock.now = () => now;
  attentionClock.sleep = async (ms) => { sleeps.push(ms); now += ms; };
  try { await run(sleeps, (ms) => { now += ms; }); } finally { Object.assign(attentionClock, original); }
}

test('attention builds questions from --option flags and prints the event id', async () => fixture(async (requests, output) => {
  process.env.FTOWN_SESSION_ID = 'self-id';
  assert.equal(await runSessions(['attention', '--message', 'Which?', '--option', 'Alpha', '--option', 'Beta', '--multi', '--no-text']), 0);
  assert.deepEqual(requests[1].body, { message: 'Which?', questions: [{ question: 'Which?', options: ['Alpha', 'Beta'], multiSelect: true, allowText: false }] });
  assert.ok(output.some((line) => line.includes('attention-status evt-1')));
  assert.deepEqual(JSON.parse(output.find((line) => line.startsWith('{')) ?? ''), { event: { id: 'evt-1' } });
  assert.equal(await runSessions(['attention', '--message', 'Which?', '--option', 'Alpha']), 0);
  assert.deepEqual(requests.at(-1)?.body, { message: 'Which?', questions: [{ question: 'Which?', options: ['Alpha'], multiSelect: false, allowText: true }] });
}, (request) => request.method === 'GET' ? promptCapabilities : { event: { id: 'evt-1' } }));

test('attention --questions-json accepts an array or an object and passes it through', async () => fixture(async (requests) => {
  process.env.FTOWN_SESSION_ID = 'self-id';
  const questions = [{ question: 'Q?', options: ['a', 'b'] }];
  assert.equal(await runSessions(['attention', '--message', 'Q', '--questions-json', JSON.stringify(questions)]), 0);
  assert.deepEqual(requests.at(-1)?.body, { message: 'Q', questions });
  assert.equal(await runSessions(['attention', '--message', 'Q', '--questions-json', JSON.stringify({ questions })]), 0);
  assert.deepEqual(requests.at(-1)?.body, { message: 'Q', questions });
}, (request) => request.method === 'GET' ? promptCapabilities : { event: { id: 'evt-1' } }));

test('attention question flag validation fails before any transport access', async () => fixture(async (requests, output) => {
  process.env.FTOWN_SESSION_ID = 'self-id';
  const base = ['attention', '--message', 'Q'];
  for (const extra of [['--multi'], ['--no-text'], ['--timeout', '5'], ['--wait'], ['--questions-json', '[]'], ['--questions-json', '{nope'],
    ['--questions-json', '[{"question":"a"}]', '--option', 'x'], ['--questions-json', '[{"question":"a"}]', '--multi'],
    ['--option', 'x', '--wait', '--timeout', '0'], ['--option', 'x', '--wait', '--timeout', '86401'], ['--option', 'x', '--wait', '--timeout', 'abc']]) {
    assert.equal(await runSessions([...base, ...extra]), 1, extra.join(' '));
  }
  assert.equal(requests.length, 0);
  assert.ok(output.some((line) => line.includes('--questions-json is not valid JSON')));
}));

test('attention with questions requires the prompt capability', async () => fixture(async (requests, output) => {
  process.env.FTOWN_SESSION_ID = 'self-id';
  assert.equal(await runSessions(['attention', '--message', 'Q', '--option', 'x']), 1);
  assert.deepEqual(requests.map(({ method }) => method), ['GET']);
  assert.ok(output.some((line) => line.includes('bridge_upgrade_required')));
  assert.equal(await runSessions(['attention', '--message', 'plain']), 0);
}, (request) => request.method === 'GET' ? newCapabilities : { event: { id: 'evt-1' } }));

test('attention --wait polls until answered and prints the formatted answer', async () => withFakeClock(async () => {
  let polls = 0;
  await fixture(async (requests, output) => {
    process.env.FTOWN_SESSION_ID = 'self-id';
    assert.equal(await runSessions(['attention', '--message', 'Which?', '--option', 'Alpha', '--option', 'Beta', '--wait', '--timeout', '100']), 0);
    const polled = requests.filter(({ url }) => url.includes('/attention/evt-1'));
    assert.equal(polled.length, 2);
    assert.ok(polled[0].url.endsWith('/api/sessions/self-id/attention/evt-1?waitSeconds=25'));
    assert.ok(output.includes('Waiting for an answer (attention evt-1)...'));
    assert.ok((output.at(-1) ?? '').includes('Beta'), output.at(-1));
    assert.ok(!output.some((line) => line.includes('"event"')), 'POST response is not printed with --wait');
  }, (request) => {
    if (request.method === 'POST') return { event: { id: 'evt-1' } };
    if (!request.url.includes('/attention/evt-1')) return promptCapabilities;
    polls += 1;
    return { event: polls < 2 ? { id: 'evt-1' } : answeredItem };
  });
}));

test('attention --wait exits 2 when dismissed and 124 on timeout with a shrinking poll window', async () => withFakeClock(async (_sleeps, advance) => {
  let dismissed = true;
  await fixture(async (requests, output) => {
    process.env.FTOWN_SESSION_ID = 'self-id';
    assert.equal(await runSessions(['attention', '--message', 'Q', '--option', 'x', '--wait']), 2);
    assert.ok(output.includes('Attention request evt-1 was resolved (manual) without an answer.'));
    dismissed = false;
    const before = requests.length;
    assert.equal(await runSessions(['attention', '--message', 'Q', '--option', 'x', '--wait', '--timeout', '30']), 124);
    const waits = requests.slice(before).filter(({ url }) => url.includes('waitSeconds')).map(({ url }) => new URL(url).searchParams.get('waitSeconds'));
    assert.deepEqual(waits, ['25', '5']);
    assert.ok(output.includes('Timed out waiting for an answer. Check later: ftown sessions attention-status evt-1 --wait'));
  }, (request) => {
    if (request.method === 'POST') return { event: { id: 'evt-1' } };
    if (!request.url.includes('/attention/evt-1')) return promptCapabilities;
    advance(25_000);
    return { event: dismissed ? { id: 'evt-1', resolvedAt: 'now', resolution: 'manual' } : { id: 'evt-1' } };
  });
}));

test('attention-status covers answered, dismissed, pending and --wait', async () => withFakeClock(async (_sleeps, advance) => {
  let item: Record<string, unknown> = {};
  await fixture(async (requests, output) => {
    process.env.FTOWN_SESSION_ID = 'self-id';
    item = { ...answeredItem, id: 'evt-9', answer: { answers: [{ selected: [0] }], answeredAt: 'now' } };
    assert.equal(await runSessions(['attention-status', 'evt-9']), 0);
    assert.ok((output.at(-1) ?? '').includes('Alpha'));
    assert.ok(requests.at(-1)?.url.endsWith('/api/sessions/self-id/attention/evt-9'));
    item = { id: 'evt-9', resolvedAt: 'now', resolution: 'session_end' };
    assert.equal(await runSessions(['attention-status', 'evt-9', '--session-id', 'other']), 2);
    assert.ok(requests.at(-1)?.url.endsWith('/api/sessions/other/attention/evt-9'));
    item = { id: 'evt-9' };
    assert.equal(await runSessions(['attention-status', 'evt-9']), 3);
    assert.equal(output.at(-1), 'Pending: no answer yet.');
    assert.equal(await runSessions(['attention-status', 'evt-9', '--wait', '--timeout', '1']), 124);
    assert.equal(await runSessions(['attention-status', 'evt-9', '--timeout', '1']), 1);
  }, () => { advance(25_000); return { event: item }; });
}));

test('attention --wait retries transient poll failures three times then fails', async () => withFakeClock(async (sleeps) => {
  let failing = 0;
  await fixture(async () => {
    process.env.FTOWN_SESSION_ID = 'self-id';
    failing = 2;
    assert.equal(await runSessions(['attention-status', 'evt-1', '--wait']), 0);
    assert.deepEqual(sleeps, [1000, 1000]);
    failing = 99;
    assert.equal(await runSessions(['attention-status', 'evt-1', '--wait']), 1);
    assert.equal(sleeps.length, 5);
  }, (request) => {
    if (request.url.includes('waitSeconds')) {
      if (failing > 0) { failing -= 1; throw new Error('boom'); }
      return { event: answeredItem };
    }
    return { event: { id: 'evt-1' } };
  });
}));
