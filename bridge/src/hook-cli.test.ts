import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { runHarness } from './harness-commands.js';
import {
  buildHookArgv,
  buildHookExecArgv,
  buildHookShellCommand,
  parseHookArgs,
  quotePosix,
  runHookCommand,
} from './hook-cli.js';
import type { HookEnvironment, HookWirePayload, PostHookPayload } from './hook-contract.js';
import { buildHookTransportConfig, postHookPayload } from './hook-transport.js';

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

interface FakeBridge {
  port: number;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startBridge(status = 200): Promise<FakeBridge> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: raw ? JSON.parse(raw) : undefined,
      });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake bridge failed to bind');
  return {
    port: address.port,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function makeHome(pointer?: { port: number; token?: string }): string {
  const home = mkdtempSync(join(tmpdir(), 'hook-cli-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  if (pointer) {
    writeFileSync(join(home, '.ftown-bridge.json'), JSON.stringify(pointer));
  }
  return home;
}

function recorder(post: PostHookPayload) {
  const payloads: HookWirePayload[] = [];
  const configs: unknown[] = [];
  const wrapped: PostHookPayload = async (payload, config) => {
    payloads.push(payload);
    configs.push(config);
    return post(payload, config);
  };
  return { post: wrapped, payloads, configs };
}

const okPost: PostHookPayload = async () => ({ ok: true, candidate: { port: 1, source: 'env' } });

describe('parseHookArgs', () => {
  it('accepts a known kind', () => {
    assert.deepEqual(parseHookArgs(['muse-session-start']), { ok: true, kind: 'muse-session-start' });
  });

  it('rejects missing, unknown and extra arguments as usage errors', () => {
    assert.match((parseHookArgs([]) as { message: string }).message, /missing hook kind/);
    assert.match((parseHookArgs(['nope']) as { message: string }).message, /unknown hook kind "nope"/);
    assert.match((parseHookArgs(['grok', 'extra']) as { message: string }).message, /exactly one hook kind/);
  });

  it('reports usage errors on stderr with exit code 2', async () => {
    const stderr: string[] = [];
    const code = await runHookCommand({ args: [], input: '', env: {}, post: okPost, err: (m) => stderr.push(m) });
    assert.equal(code, 2);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /^ftown hook: missing hook kind/);
  });
});

describe('hook command registration and quoting', () => {
  it('builds argv forms for direct-exec harnesses', () => {
    assert.deepEqual([...buildHookArgv('grok')], ['hook', 'grok']);
    assert.deepEqual([...buildHookExecArgv('/opt/ftown/bin/ftown-harness', 'notify')], ['/opt/ftown/bin/ftown-harness', 'hook', 'notify']);
  });

  it('single-quotes a path containing spaces and quotes for POSIX shell commands', () => {
    const executable = "/path with space/f'town-harness";
    const command = buildHookShellCommand(executable, 'muse-stop');
    assert.equal(command, `'/path with space/f'\\''town-harness' 'hook' 'muse-stop'`);
    const roundTrip = execFileSync('/bin/sh', ['-c', `printf '%s' ${quotePosix(executable)}`], { encoding: 'utf8' });
    assert.equal(roundTrip, executable);
  });
});

describe('muse-session-start end to end', () => {
  const env: HookEnvironment = { FTOWN_SESSION_ID: 'session-1' };
  const input = JSON.stringify({ session_id: 'native-1', cwd: '/work', tool_name: 'ignored' });

  it('posts the typed payload and stays silent', async () => {
    const spy = recorder(okPost);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runHookCommand({
      args: ['muse-session-start'], input, env, post: spy.post,
      out: (m) => stdout.push(m), err: (m) => stderr.push(m),
    });
    assert.equal(code, 0);
    assert.deepEqual(spy.payloads, [{
      ftown_session_id: 'session-1',
      ftown_session_source: 'env',
      hook_event_name: 'SessionStart',
      session_id: 'native-1',
      cwd: '/work',
    }]);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, []);
  });

  it('is inert without an owning ftown session', async () => {
    const spy = recorder(okPost);
    const code = await runHookCommand({ args: ['muse-session-start'], input, env: {}, post: spy.post });
    assert.equal(code, 0);
    assert.deepEqual(spy.payloads, []);
  });

  it('coerces missing native fields to empty strings', async () => {
    const spy = recorder(okPost);
    await runHookCommand({ args: ['muse-session-start'], input: '{}', env, post: spy.post });
    assert.deepEqual(spy.payloads, [{
      ftown_session_id: 'session-1',
      ftown_session_source: 'env',
      hook_event_name: 'SessionStart',
      session_id: '',
      cwd: '',
    }]);
  });

  it('reports invalid JSON on stderr instead of exiting silently', async () => {
    const spy = recorder(okPost);
    const stderr: string[] = [];
    const code = await runHookCommand({ args: ['muse-session-start'], input: 'not-json', env, post: spy.post, err: (m) => stderr.push(m) });
    assert.equal(code, 0);
    assert.deepEqual(spy.payloads, []);
    assert.deepEqual(stderr, ['ftown hook: native hook payload is not valid JSON']);
  });

  it('reports an unimplemented kind on stderr without posting', async () => {
    const spy = recorder(okPost);
    const stderr: string[] = [];
    const code = await runHookCommand({ args: ['antigravity'], input, env, post: spy.post, err: (m) => stderr.push(m) });
    assert.equal(code, 0);
    assert.deepEqual(spy.payloads, []);
    assert.match(stderr[0], /not implemented yet/);
  });

  it('reports a preflight stdin error on stderr', async () => {
    const stderr: string[] = [];
    const code = await runHookCommand({
      args: ['muse-session-start'], input: '', env, post: okPost, err: (m) => stderr.push(m),
      stdinError: { kind: 'stdin-error', message: 'could not read hook payload from stdin' },
    });
    assert.equal(code, 0);
    assert.deepEqual(stderr, ['ftown hook: could not read hook payload from stdin']);
  });
});

describe('ftown-harness hook command wiring', () => {
  it('delivers muse-session-start through the real CLI entry point', async () => {
    const bridge = await startBridge();
    cleanups.push(bridge.close);
    const home = makeHome({ port: bridge.port, token: 'integration-token' });
    const pointerPath = join(home, '.ftown-bridge.json');
    const savedEnv = { ...process.env };
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, {
        HOME: home,
        FTOWN_SESSION_ID: 'integration-session',
        FTOWN_BRIDGE_POINTER: pointerPath,
      });
      Object.defineProperty(process, 'stdin', {
        configurable: true,
        value: Readable.from([Buffer.from(JSON.stringify({ session_id: 'native-1', cwd: '/work' }))]),
      });

      const code = await runHarness(['hook', 'muse-session-start']);
      assert.equal(code, 0);
      assert.equal(bridge.requests.length, 1);
      assert.equal(bridge.requests[0].authorization, 'Bearer integration-token');
      assert.deepEqual(bridge.requests[0].body, {
        ftown_session_id: 'integration-session',
        ftown_session_source: 'env',
        hook_event_name: 'SessionStart',
        session_id: 'native-1',
        cwd: '/work',
      });
    } finally {
      if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });

  it('returns exit code 2 for a usage error through the real CLI entry point', async () => {
    assert.equal(await runHarness(['hook']), 2);
    assert.equal(await runHarness(['hook', 'not-a-kind']), 2);
  });
});

describe('loopback transport', () => {
  it('posts to the env endpoint with the token and wire body', async () => {
    const bridge = await startBridge();
    cleanups.push(bridge.close);
    const env: HookEnvironment = {
      FTOWN_SESSION_ID: 'session-1',
      FTOWN_HOOK_PORT: String(bridge.port),
      FTOWN_HOOK_TOKEN: 'env-token-should-not-leak',
    };
    const stderr: string[] = [];
    const code = await runHookCommand({
      args: ['muse-session-start'], input: '{"session_id":"native-1","cwd":"/work"}', env,
      post: postHookPayload, err: (m) => stderr.push(m),
    });
    assert.equal(code, 0);
    assert.deepEqual(stderr, []);
    assert.equal(bridge.requests.length, 1);
    assert.equal(bridge.requests[0].method, 'POST');
    assert.equal(bridge.requests[0].url, '/hook');
    assert.equal(bridge.requests[0].authorization, 'Bearer env-token-should-not-leak');
    assert.match(bridge.requests[0].contentType ?? '', /application\/json/);
    assert.deepEqual(bridge.requests[0].body, {
      ftown_session_id: 'session-1',
      ftown_session_source: 'env',
      hook_event_name: 'SessionStart',
      session_id: 'native-1',
      cwd: '/work',
    });
  });

  it('falls back to the bridge pointer when the env endpoint rejects the POST', async () => {
    const stale = await startBridge(500);
    const live = await startBridge(200);
    cleanups.push(stale.close, live.close);
    const home = makeHome({ port: live.port, token: 'pointer-token-should-not-leak' });
    const env: HookEnvironment = {
      FTOWN_SESSION_ID: 'session-1',
      FTOWN_HOOK_PORT: String(stale.port),
      FTOWN_HOOK_TOKEN: 'env-token-should-not-leak',
      FTOWN_BRIDGE_POINTER: join(home, '.ftown-bridge.json'),
    };
    const stderr: string[] = [];
    const code = await runHookCommand({
      args: ['muse-session-start'], input: '{}', env, post: postHookPayload, err: (m) => stderr.push(m),
    });
    assert.equal(code, 0);
    assert.deepEqual(stderr, []);
    assert.equal(stale.requests.length, 1);
    assert.equal(live.requests.length, 1);
    assert.equal(stale.requests[0].authorization, 'Bearer env-token-should-not-leak');
    assert.equal(live.requests[0].authorization, 'Bearer pointer-token-should-not-leak');
  });

  it('reports a delivery failure visibly without leaking the token', async () => {
    const bridge = await startBridge(401);
    cleanups.push(bridge.close);
    const env: HookEnvironment = {
      FTOWN_SESSION_ID: 'session-1',
      FTOWN_HOOK_PORT: String(bridge.port),
      FTOWN_HOOK_TOKEN: 'secret-token-should-not-leak',
    };
    const stderr: string[] = [];
    const code = await runHookCommand({
      args: ['muse-session-start'], input: '{}', env, post: postHookPayload, err: (m) => stderr.push(m),
    });
    assert.equal(code, 0);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /bridge delivery failed after 1 attempt\(s\)/);
    assert.match(stderr[0], /HTTP 401/);
    assert.doesNotMatch(stderr[0], /secret-token-should-not-leak/);
  });

  it('reports a missing endpoint visibly', async () => {
    const env: HookEnvironment = { FTOWN_SESSION_ID: 'session-1', HOME: makeHome() };
    const stderr: string[] = [];
    const code = await runHookCommand({
      args: ['muse-session-start'], input: '{}', env, post: postHookPayload, err: (m) => stderr.push(m),
    });
    assert.equal(code, 0);
    assert.deepEqual(stderr, ['ftown hook: no bridge endpoint configured']);
  });

  it('drops an exact duplicate endpoint from the pointer', () => {
    const home = makeHome({ port: 43210, token: 'same-token' });
    const config = buildHookTransportConfig({
      FTOWN_HOOK_PORT: '43210',
      FTOWN_HOOK_TOKEN: 'same-token',
      FTOWN_BRIDGE_POINTER: join(home, '.ftown-bridge.json'),
    });
    assert.equal(config.candidates.length, 1);
    assert.equal(config.candidates[0].source, 'env');
  });
});
