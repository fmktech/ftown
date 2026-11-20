import { runBridges } from './peers-cli.js';
import { setPeerTarget } from './cli-client.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Readable, Writable } from 'node:stream';
import { attentionClock, runSessions } from './sessions-commands.js';
import { secureFixture } from './security/bridge/fixtures.test.js';

interface Request { url: string; method: string; body?: unknown }
function lastPost(requests: Request[]): Request | undefined {
  return [...requests].reverse().find((request) => request.method === 'POST');
}
async function fixture(run: (requests: Request[], output: string[]) => Promise<void>, reply?: (request: Request) => unknown,
  writeOutput?: (callback: (error?: Error | null) => void) => void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'ftown-sessions-unit-'));
  const previousHome = process.env.HOME;
  const previousSession = process.env.FTOWN_SESSION_ID;
  const previousDataDir = process.env.FTOWN_DATA_DIR;
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const previousError = console.error;
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
  const requests: Request[] = []; const output: string[] = [];
  mkdirSync(join(home, '.ftown'));
  process.env.HOME = home;
  delete process.env.FTOWN_SESSION_ID;
  // Isolate from inherited FTOWN_DATA_DIR: bridgePointerPath() would otherwise
  // resolve to the production data dir's bridge.json instead of this temp home.
  process.env.FTOWN_DATA_DIR = join(home, '.ftown', 'data');
  const secure = await secureFixture(join(home, '.ftown'), async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    const response = reply ? await reply(requests.at(-1)!) : { session: { id: 'created', name: 'unit', status: 'running' }, sessions: [], messages: [] };
    return response instanceof Response ? response : new Response(JSON.stringify(response));
  }, 12345);
  writeFileSync(join(home, '.ftown', 'bridge.json'), JSON.stringify(secure.pointer));
  globalThis.fetch = secure.fetch;
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  Object.defineProperty(process, 'stdout', { configurable: true, value: new Writable({ write(chunk, _encoding, callback) {
    output.push(chunk.toString().trimEnd());
    if (writeOutput) writeOutput(callback); else callback();
  } }) });
  try { await run(requests, output); }
  finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousSession === undefined) delete process.env.FTOWN_SESSION_ID; else process.env.FTOWN_SESSION_ID = previousSession;
    if (previousDataDir === undefined) delete process.env.FTOWN_DATA_DIR; else process.env.FTOWN_DATA_DIR = previousDataDir;
    await secure.security.close();
    globalThis.fetch = previousFetch; console.log = previousLog; console.error = previousError;
    if (stdoutDescriptor) Object.defineProperty(process, 'stdout', stdoutDescriptor);
    rmSync(home, { recursive: true, force: true });
  }
}

test('create --help describes options without opening transport or creating a session', async () => fixture(async (requests) => {
  assert.equal(await runSessions(['create', '--help']), 0);
  assert.equal(requests.length, 0, 'help must not POST /api/sessions');
}));

test('generated help and invalid command options finish before any transport access', async () => fixture(async (requests, output) => {
  for (const command of ['list', 'create', 'get', 'screen', 'grep', 'keys', 'tell', 'inbox', 'mail', 'running', 'usage', 'remove', 'archive', 'revive', 'attention', 'attention-status', 'pr', 'handoff']) {
    assert.equal(await runSessions([command, '--help']), 0, command);
  }
  assert.ok(output.some((line) => line.includes('Usage: ftown sessions create')));
  for (const args of [['create', '--unknown'], ['create', '--model'], ['get'], ['grep', 'id'], ['keys', 'id'], ['create', 'unexpected']]) {
    assert.equal(await runSessions(args), 1, args.join(' '));
  }
  assert.equal(requests.length, 0);
}));

test('create preserves option payload and accepts the no-op orchestrator compatibility flag', async () => withFakeClock(async () => fixture(async (requests) => {
  assert.equal(await runSessions(['create', '--shell', 'codex', '--prompt', 'hello', '--workdir', '/tmp/work', '--create-workdir',
    '--name', 'agent', '--command', 'custom', '--model', 'model', '--parent', '--parent-id', 'parent-id', '--orchestrator']), 0);
  const posts = requests.filter((request) => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].method, 'POST'); assert.ok(posts[0].url.endsWith('/api/sessions'));
  assert.deepEqual(posts[0].body, { shellType: 'codex', prompt: 'hello', workingDir: '/tmp/work', createMissingWorkingDir: true,
    name: 'agent', command: 'custom', model: 'model', parentSessionId: 'parent-id' });
  assert.ok(requests.some((request) => request.method === 'GET' && request.url.endsWith('/api/sessions/created')));
})));

test('create --shell resolves alias agy to canonical antigravity in request body', async () => withFakeClock(async () => fixture(async (requests) => {
  assert.equal(await runSessions(['create', '--shell', 'agy', '--model', 'gemini-4-hydrogen-medium', '--prompt', 'hello']), 0);
  const posts = requests.filter((request) => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].method, 'POST');
  assert.deepEqual(posts[0].body, { shellType: 'antigravity', model: 'gemini-4-hydrogen-medium', prompt: 'hello' });
})));

test('handoff posts the chosen harness and prints the new session id', async () => fixture(async (requests, output) => {
  assert.equal(await runSessions(['handoff', 'old-id', '--shell', 'shell', '--model', 'plain', '--name', 'next', '--plain']), 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.ok(requests[0].url.endsWith('/api/sessions/old-id/handoff'));
  assert.deepEqual(requests[0].body, { shellType: 'shell', model: 'plain', name: 'next' });
  assert.equal(output.at(-1), 'created');
}, () => ({ session: { id: 'created', name: 'next', status: 'pending' } })));

test('handoff --shell rejects an unknown harness before any request', async () => fixture(async (requests, output) => {
  assert.equal(await runSessions(['handoff', 'old-id', '--shell', 'bogus-shell']), 1);
  assert.equal(requests.length, 0);
  assert.ok(output.some((line) => line.includes('Invalid shellType') && line.includes('Valid values:')));
}));

test('create --shell rejects invalid shellType without calling the API', async () => fixture(async (requests, output) => {
  assert.equal(await runSessions(['create', '--shell', 'bogus-shell', '--prompt', 'hello']), 1);
  assert.equal(requests.length, 0);
  assert.ok(output.some((line) => line.includes('Invalid shellType') && line.includes('Valid values:')));
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
  assert.deepEqual(JSON.parse(output.at(-1) ?? ''), { messages: [], moreAvailable: false, nextOffset: null, oversizedMessages: [] });
}));

for (const command of ['inbox', 'mail']) {
  test(`sessions ${command} waits for output before acknowledging only displayed unread rows`, async () => {
    let release!: (error?: Error | null) => void;
    let entered!: () => void;
    const outputStarted = new Promise<void>(resolve => { entered = resolve; });
    await fixture(async (requests, output) => {
      process.env.FTOWN_SESSION_ID = 'self';
      const reading = runSessions([command, '--all', '--offset', '2', '--limit', '1', '--json']);
      await outputStarted;
      assert.equal(requests.length, 1, 'output callback must complete before the ack request');
      assert.ok(requests[0].url.endsWith('inbox?wait=0&peek=1&limit=1&all=1&offset=2'));
      assert.match(output.at(-1) ?? '', /queued/);
      release();
      assert.equal(await reading, 0);
      assert.deepEqual(requests[1].body, { ids: ['unread'] });
      assert.ok(requests[1].url.endsWith('/inbox/ack'));
      assert.equal(JSON.parse(output[0]).nextOffset, 3);
    }, request => request.method === 'POST' ? { acknowledgedIds: ['unread'] } : {
      messages: [{ id: 'unread', body: 'queued', from: 'parent', to: 'self', ts: '', type: 'task' },
        { id: 'history', body: 'displayed history', deliveredAt: 'previously', from: 'parent', to: 'self', ts: '', type: 'task' }],
      moreAvailable: true, nextOffset: 3, oversizedMessages: [],
    }, callback => { release = callback; entered(); });
  });
}

test('sessions inbox peek and output failures never acknowledge a page', async () => {
  for (const fail of [false, true]) {
    await fixture(async (requests, output) => {
      process.env.FTOWN_SESSION_ID = 'self';
      assert.equal(await runSessions(['inbox', ...(fail ? [] : ['--peek']), '--json']), fail ? 1 : 0);
      assert.equal(requests.length, 1);
      if (fail) assert.ok(output.some(line => line.includes('stdout failed')));
    }, () => ({ messages: [{ id: 'unread', body: 'queued', from: 'parent', to: 'self', ts: '', type: 'task' }], moreAvailable: false }),
    callback => callback(fail ? new Error('stdout failed') : undefined));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
});

test('sessions inbox fetch failure and invalid page arguments do not acknowledge mail', async () => {
  await fixture(async requests => {
    process.env.FTOWN_SESSION_ID = 'self';
    assert.equal(await runSessions(['inbox', '--json']), 1);
    assert.equal(requests.length, 1);
    for (const args of [['--limit', '0'], ['--limit', '1.5'], ['--offset', '1'], ['--all', '--offset', '-1']]) {
      assert.equal(await runSessions(['inbox', ...args]), 1);
    }
    assert.equal(requests.length, 1);
  }, () => new Response(JSON.stringify({ error: 'fetch failed' }), { status: 503 }));
});

for (const command of ['inbox', 'mail']) {
  test(`sessions ${command} follows opaque cursors and acknowledges only after final output with its token`, async () => {
    const body = '\0'.repeat(65536);
    const metadata = JSON.stringify({ id: 'large', from: 'parent', fromName: '\0'.repeat(12000), threadId: 'thread'.repeat(3000), to: 'self', type: 'task', ts: '' });
    const tickets = new Map<string, { body: number; metadata: number; complete: boolean }>(); let sequence = 0;
    await fixture(async (requests, output) => {
      process.env.FTOWN_SESSION_ID = 'self';
      assert.equal(await runSessions([command, '--message-id', 'large', '--body-offset', '65536', '--metadata-offset', String(metadata.length)]), 1);
      assert.equal(requests.length, 0, 'numeric end-offset bypass must be rejected before transport');
      let cursor: string | undefined;
      const bodies: string[] = []; const metas: string[] = [];
      for (;;) {
        assert.equal(await runSessions([command, '--message-id', 'large', ...(cursor ? ['--cursor', cursor] : []), '--json']), 0);
        const text = output.at(-1)!; assert.ok(Buffer.byteLength(text) < 100000);
        const displayed = JSON.parse(text); bodies.push(displayed.body.chunk); metas.push(displayed.metadata.chunk);
        if (displayed.complete) { assert.equal(displayed.continuation, null); break; }
        assert.equal(requests.some(request => request.method === 'POST'), false);
        assert.ok(displayed.continuation.includes(`--cursor ${displayed.nextCursor}`));
        cursor = displayed.nextCursor;
      }
      assert.equal(bodies.join(''), body); assert.equal(metas.join(''), metadata);
      assert.equal(requests.filter(request => request.method === 'POST').length, 1);
      const ack = requests.at(-1)?.body as { ids: string[]; completionToken: string };
      assert.deepEqual(ack.ids, ['large']); assert.equal(ack.completionToken.length, 43);
    }, request => {
      if (request.method === 'POST') {
        const ack = request.body as { completionToken: string };
        assert.equal(tickets.get(ack.completionToken)?.complete, true); tickets.delete(ack.completionToken);
        return { acknowledgedIds: ['large'] };
      }
      const url = new URL(request.url); const cursor = url.searchParams.get('cursor');
      const progress = cursor ? tickets.get(cursor) : { body: 0, metadata: 0, complete: false };
      if (!progress || progress.complete) return new Response(JSON.stringify({ error: 'invalid cursor' }), { status: 400 });
      if (cursor) tickets.delete(cursor);
      const part = (content: string, offset: number) => {
        const end = Math.min(offset + 7000, content.length);
        return { offset, chunk: content.slice(offset, end), totalChars: content.length, nextOffset: end < content.length ? end : null };
      };
      const bodyPart = part(body, progress.body); const metadataPart = part(metadata, progress.metadata);
      const complete = bodyPart.nextOffset === null && metadataPart.nextOffset === null;
      const token = String(++sequence).padStart(43, 'c');
      tickets.set(token, { body: bodyPart.nextOffset ?? body.length, metadata: metadataPart.nextOffset ?? metadata.length, complete });
      return { messageId: 'large', body: bodyPart, metadata: metadataPart, nextCursor: complete ? null : token, completionToken: complete ? token : null };
    });
  });

  test(`sessions ${command} chunk failure prevents partial page output and acknowledgment`, async () => {
    await fixture(async (requests, output) => {
      process.env.FTOWN_SESSION_ID = 'self';
      assert.equal(await runSessions([command, '--message-id', 'large', '--json']), 1);
      assert.equal(requests.some(request => request.method === 'POST'), false);
      assert.equal(output.some(line => line.includes('"messages"')), false);
      assert.ok(output.some(line => line.includes('chunk failed')));
    }, request => request.url.includes('/chunk')
      ? new Response(JSON.stringify({ error: 'chunk failed' }), { status: 503 })
      : { messages: [], oversizedMessages: [{ id: 'large', serializedBytes: 393400, index: 0 }], moreAvailable: false });
  });

  test(`sessions ${command} displays 50 oversized descriptors without reconstruction or acknowledgment`, async () => {
    await fixture(async (requests, output) => {
      process.env.FTOWN_SESSION_ID = 'self';
      assert.equal(await runSessions([command, '--json']), 0);
      assert.ok(Buffer.byteLength(output[0]) < 100000);
      assert.equal(JSON.parse(output[0]).oversizedMessages.length, 50);
      assert.equal(requests.length, 1);
    }, () => ({ messages: [], moreAvailable: false, nextOffset: null,
      oversizedMessages: Array.from({ length: 50 }, (_, index) => ({ id: `large-${index}`, serializedBytes: 393400, index })) }));
  });

  test(`sessions ${command} traverses unread peek pages without acknowledging and prints a valid continuation`, async () => {
    await fixture(async (requests, output) => {
      process.env.FTOWN_SESSION_ID = 'self';
      assert.equal(await runSessions([command, '--peek', '--limit', '1', '--offset', '1']), 0);
      assert.ok(output[0].includes('ftown sessions inbox --peek --limit 1 --offset 2'));
      assert.equal(await runSessions([command, '--peek', '--limit', '1', '--offset', '2', '--json']), 0);
      const last = JSON.parse(output.at(-1)!);
      assert.equal(last.messages[0].id, 'third'); assert.equal(last.moreAvailable, false);
      assert.equal(requests.some(request => request.method === 'POST'), false);
    }, request => {
      const offset = Number(new URL(request.url).searchParams.get('offset'));
      return { messages: [{ id: offset === 1 ? 'second' : 'third', body: offset === 1 ? 'second task' : 'third task', ts: '', from: 'parent', to: 'self', type: 'task' }],
        oversizedMessages: [], moreAvailable: offset === 1, nextOffset: offset === 1 ? 2 : null };
    });
  });
}

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
  attentionClock.monotonicNow = () => now;
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

test('create --worktree maps worktree, --branch and --base to POST body and rejects --branch/--base without --worktree', async () => withFakeClock(async () => fixture(async (requests, output) => {
  assert.equal(await runSessions(['create', '--branch', 'feat/x']), 1);
  assert.equal(await runSessions(['create', '--base', 'main']), 1);
  assert.equal(requests.length, 0);
  assert.ok(output.some((line) => line.includes('--branch and --base require --worktree')));

  assert.equal(await runSessions(['create', '--prompt', 'work', '--worktree']), 0);
  assert.deepEqual(lastPost(requests)?.body, { prompt: 'work', worktree: true });

  assert.equal(await runSessions(['create', '--prompt', 'work', '--worktree', '--branch', 'feat/a']), 0);
  assert.deepEqual(lastPost(requests)?.body, { prompt: 'work', worktree: { branch: 'feat/a' } });

  assert.equal(await runSessions(['create', '--prompt', 'work', '--worktree', '--base', 'main']), 0);
  assert.deepEqual(lastPost(requests)?.body, { prompt: 'work', worktree: { base: 'main' } });

  assert.equal(await runSessions(['create', '--prompt', 'work', '--worktree', '--branch', 'feat/a', '--base', 'main']), 0);
  assert.deepEqual(lastPost(requests)?.body, { prompt: 'work', worktree: { branch: 'feat/a', base: 'main' } });
})));

test('remove maps --keep-worktree and --force-worktree query params and prints worktreeOutcome', async () => {
  let currentOutcome: { action: string; reason?: string } | undefined;
  await fixture(async (requests, output) => {
    assert.equal(await runSessions(['remove', 'sess-1', '--keep-worktree', '--force-worktree']), 1);
    assert.equal(requests.length, 0);

    currentOutcome = { action: 'removed' };
    assert.equal(await runSessions(['remove', 'sess-1', '--force-worktree']), 0);
    assert.equal(requests.at(-1)?.method, 'DELETE');
    assert.ok(requests.at(-1)?.url.endsWith('/api/sessions/sess-1?worktree=force'));
    assert.ok(output.some((line) => line.includes('worktree removed')));

    output.length = 0;
    currentOutcome = { action: 'retained', reason: '2 unpushed commits' };
    assert.equal(await runSessions(['remove', 'sess-2', '--keep-worktree', '--plain']), 0);
    assert.equal(requests.at(-1)?.method, 'DELETE');
    assert.ok(requests.at(-1)?.url.endsWith('/api/sessions/sess-2?worktree=keep'));
    assert.ok(output.some((line) => line.includes('worktree retained: 2 unpushed commits')));

    output.length = 0;
    currentOutcome = { action: 'retained', reason: 'uncommitted changes' };
    assert.equal(await runSessions(['remove', 'sess-3']), 0);
    assert.ok(requests.at(-1)?.url.endsWith('/api/sessions/sess-3'));
    assert.ok(output.some((line) => line.includes('worktree retained: uncommitted changes')));
  }, () => ({ removed: true, ...(currentOutcome ? { worktreeOutcome: currentOutcome } : {}) }));
});

test('attention --to human sends to:"human" in request body and rejects invalid --to targets', async () => fixture(async (requests, output) => {
  process.env.FTOWN_SESSION_ID = 'self-id';
  assert.equal(await runSessions(['attention', '--message', 'Need token', '--to', 'parent']), 1);
  assert.equal(requests.length, 0);
  assert.ok(output.some((line) => line.includes('--to only accepts "human"')));

  assert.equal(await runSessions(['attention', '--message', 'Need token', '--to', 'human']), 0);
  assert.equal(requests.at(-1)?.method, 'POST');
  assert.deepEqual(requests.at(-1)?.body, { message: 'Need token', to: 'human' });
}, (request) => request.method === 'GET' ? newCapabilities : { event: { id: 'evt-human' } }));

test('create --plan-item maps to body.planItem and requires --parent/--parent-id', async () => withFakeClock(async () => fixture(async (requests, output) => {
  assert.equal(await runSessions(['create', '--prompt', 'work', '--plan-item', 'p3']), 1);
  assert.equal(requests.length, 0, 'no POST without a parent');
  assert.ok(output.some((line) => line.includes('--plan-item requires --parent or --parent-id')));

  assert.equal(await runSessions(['create', '--prompt', 'work', '--plan-item', 'item3', '--parent-id', 'p-uuid']), 1);
  assert.equal(requests.length, 0, 'no POST for a malformed item id');
  assert.ok(output.some((line) => line.includes('--plan-item must be a plan item id')));

  assert.equal(await runSessions(['create', '--prompt', 'work', '--parent-id', 'p-uuid', '--plan-item', 'p3']), 0);
  assert.equal(lastPost(requests)?.method, 'POST');
  assert.deepEqual(lastPost(requests)?.body, { parentSessionId: 'p-uuid', prompt: 'work', planItem: 'p3' });
}, (request) => ({ session: { id: 'child', name: 'child', status: 'running' } }))));

test('create --require-green-pr maps to body.requireGreenPr', async () => withFakeClock(async () => fixture(async (requests) => {
  assert.equal(await runSessions(['create', '--prompt', 'work', '--parent-id', 'p-uuid', '--require-green-pr']), 0);
  assert.equal(lastPost(requests)?.method, 'POST');
  assert.deepEqual(lastPost(requests)?.body, { parentSessionId: 'p-uuid', prompt: 'work', requireGreenPr: true });
}, () => ({ session: { id: 'child', name: 'child', status: 'running' } }))));

test('create exits non-zero when the child dies during startup', async () => fixture(async (requests, output) => {
  assert.equal(await runSessions(['create', '--shell', 'opencode', '--prompt', 'hello']), 1);
  assert.equal(requests[0]?.method, 'POST');
  assert.ok(requests.some((request) => request.method === 'GET' && request.url.endsWith('/api/sessions/child')));
  assert.ok(output.some((line) => line.includes('child child failed during startup: process exited with code 1')));
  assert.ok(output.every((line) => !line.startsWith('created ')));
}, (request) => request.method === 'POST'
  ? { session: { id: 'child', name: 'unit', status: 'pending' } }
  : { session: { id: 'child', name: 'unit', status: 'error', errorReason: 'process exited with code 1', lastError: 'process exited with code 1\nbad flag' } }));

test('attention wait budget ignores wall-clock jumps', async () => {
  for (const jump of [-600_000, 600_000]) {
    await withFakeClock(async (_sleeps, advance) => {
      let wall = 1_000_000; let polls = 0; attentionClock.now = () => wall;
      await fixture(async (requests) => {
        process.env.FTOWN_SESSION_ID = 'self-id';
        assert.equal(await runSessions(['attention', '--message', 'Q', '--option', 'x', '--wait', '--timeout', '30']), 124);
        assert.deepEqual(requests.filter(r => r.url.includes('waitSeconds')).map(r => new URL(r.url).searchParams.get('waitSeconds')), ['25', '5']);
      }, request => {
        if (request.method === 'POST') return { event: { id: 'evt-1' } };
        if (!request.url.includes('/attention/evt-1')) return promptCapabilities;
        if (++polls > 6) throw new Error('poll sentinel');
        wall += jump; advance(25_000); return { event: { id: 'evt-1' } };
      });
    });
  }
});

test('remote create with --parent forwards the caller ID and its owning bridge', async () => withFakeClock(async () => fixture(async requests => {
  setPeerTarget('destination');
  process.env.FTOWN_SESSION_ID = 'nested-caller';
  try {
    assert.equal(await runSessions(['create', '--parent', '--shell', 'shell']), 0);
    const forwarded = requests[0].body as { bridge: string; path: string; body: unknown };
    assert.equal(forwarded.bridge, 'destination');
    assert.equal(forwarded.path, '/api/sessions');
    assert.deepEqual(forwarded.body, { shellType: 'shell', parentSessionId: 'nested-caller', parentBridgeId: 'bridge' });
  } finally { setPeerTarget(null); }
})));

test('remembered list reads the local bridge cache', async () => fixture(async requests => {
  assert.equal(await runSessions(['list', '--remembered']), 0);
  assert.ok(requests[0].url.endsWith('/api/peers/sessions'));
}));

test('sessions can compare capacity using ftown bridges --resources --json', async () => {
  const resources = { sampledAt: 123, cpuPercent: 18, freeRamBytes: 2 ** 30, totalRamBytes: 2 ** 31, freeDiskBytes: 2 ** 32 };
  const report = { bridgeId: 'local', resources, peers: [{ bridgeId: 'peer', resources: null }] };
  await fixture(async (requests, output) => {
    assert.equal(await runBridges(['--resources', '--json']), 0);
    assert.ok(requests[0].url.endsWith('/api/peers?resources=1'));
    assert.deepEqual(JSON.parse(output.at(-1)!), report);
  }, () => report);
});
