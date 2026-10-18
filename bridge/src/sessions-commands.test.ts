import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSessions } from './sessions-commands.js';

interface Request { url: string; method: string; body?: unknown }
async function fixture(run: (requests: Request[], output: string[]) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'ftown-sessions-unit-'));
  const previousHome = process.env.HOME;
  const previousSession = process.env.FTOWN_SESSION_ID;
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const previousError = console.error;
  const requests: Request[] = []; const output: string[] = [];
  mkdirSync(join(home, '.ftown'));
  writeFileSync(join(home, '.ftown', 'bridge.json'), '{"port":12345,"token":"unit-only"}');
  process.env.HOME = home;
  delete process.env.FTOWN_SESSION_ID;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    return new Response(JSON.stringify({ session: { id: 'created', name: 'unit', status: 'idle' }, sessions: [], messages: [] }));
  };
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  try { await run(requests, output); }
  finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousSession === undefined) delete process.env.FTOWN_SESSION_ID; else process.env.FTOWN_SESSION_ID = previousSession;
    globalThis.fetch = previousFetch; console.log = previousLog; console.error = previousError;
    rmSync(home, { recursive: true, force: true });
  }
}

test('create --help describes options without opening transport or creating a session', async () => fixture(async (requests) => {
  assert.equal(await runSessions(['create', '--help']), 0);
  assert.equal(requests.length, 0, 'help must not POST /api/sessions');
}));

test('generated help and invalid command options finish before any transport access', async () => fixture(async (requests, output) => {
  for (const command of ['list', 'create', 'get', 'screen', 'grep', 'keys', 'tell', 'inbox', 'mail', 'running', 'usage', 'remove', 'archive', 'revive']) {
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
