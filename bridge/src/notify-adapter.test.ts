import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runHarness } from './harness-commands.js';
import { runHookCommand } from './hook-cli.js';
import type { HookEnvironment, HookWirePayload, PostHookPayload } from './hook-contract.js';
import { postHookPayload } from './hook-transport.js';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';

const SESSION_ID = 'ftown-session-notify-adapter';

const CLAUDE_STOP = {
  hook_event_name: 'Stop',
  stop_hook_active: false,
  session_id: 'claude-native',
};
const GROK_STOP = { hookEventName: 'stop', hook_event_name: 'Stop', session_id: 'grok-native' };
const GROK_NOTIFICATION = {
  hookEventName: 'notification',
  hook_event_name: 'Notification',
  notification_type: 'permission_prompt',
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function recorder(): {
  post: PostHookPayload;
  payloads: HookWirePayload[];
  stderr: string[];
  stdout: string[];
  code: number | undefined;
  run: (input: string, env: HookEnvironment) => Promise<void>;
} {
  const payloads: HookWirePayload[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  let code: number | undefined;
  return {
    payloads,
    stderr,
    stdout,
    get code() { return code; },
    post: async (payload) => { payloads.push(payload); return { ok: true, candidate: { port: 1, source: 'env' } }; },
    async run(input, env) {
      code = await runHookCommand({
        args: ['notify'], input, env, post: this.post,
        out: (m) => stdout.push(m), err: (m) => stderr.push(m),
      });
    },
  };
}

function baseEnv(extra: Partial<HookEnvironment> = {}): HookEnvironment {
  return { FTOWN_SESSION_ID: SESSION_ID, ...extra };
}

function makeRegistryHome(registry: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'notify-adapter-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  writeRegistryAt(home, registry);
  return home;
}

function writeRegistryAt(home: string, registry: unknown): void {
  mkdirSync(join(home, '.ftown'), { recursive: true });
  writeFileSync(join(home, '.ftown', 'session-registry.json'), JSON.stringify(registry));
}

describe('notify adapter registration and passthrough', () => {
  it('is dispatched by kind and forwards the native object unchanged with identity fields', async () => {
    const t = recorder();
    await t.run(JSON.stringify(CLAUDE_STOP), baseEnv());
    assert.equal(t.code, 0);
    assert.deepEqual(t.payloads, [{
      ...CLAUDE_STOP,
      ftown_session_id: SESSION_ID,
      ftown_session_source: 'env',
    }]);
    assert.deepEqual(t.stdout, []);
    assert.deepEqual(t.stderr, []);
  });

  it('never writes stdout', async () => {
    const t = recorder();
    await t.run(JSON.stringify(CLAUDE_STOP), baseEnv());
    assert.deepEqual(t.stdout, []);
  });

  it('uses the bearer token and wire payload through the real transport', async () => {
    const requests: Array<{ url: string; authorization: string | undefined; body: string }> = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push({
          url: req.url ?? '',
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const code = await runHookCommand({
      args: ['notify'],
      input: JSON.stringify(CLAUDE_STOP),
      env: baseEnv({ FTOWN_HOOK_PORT: String(address.port), FTOWN_HOOK_TOKEN: 'notify-token' }),
      post: postHookPayload,
    });
    assert.equal(code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/hook');
    assert.equal(requests[0].authorization, 'Bearer notify-token');
    assert.deepEqual(JSON.parse(requests[0].body), {
      ...CLAUDE_STOP,
      ftown_session_id: SESSION_ID,
      ftown_session_source: 'env',
    });
  });
});

describe('notify adapter Grok stand-down', () => {
  it('stands down for a Grok non-notification event carrying hookEventName', async () => {
    const t = recorder();
    await t.run(JSON.stringify(GROK_STOP), baseEnv({ GROK_HOOK_EVENT: 'stop' }));
    assert.equal(t.code, 0);
    assert.deepEqual(t.payloads, []);
    assert.deepEqual(t.stdout, []);
    assert.deepEqual(t.stderr, []);
  });

  it('treats an empty GROK_HOOK_EVENT as unset and still posts', async () => {
    const t = recorder();
    await t.run(JSON.stringify(GROK_STOP), baseEnv({ GROK_HOOK_EVENT: '' }));
    assert.equal(t.payloads.length, 1);
    assert.equal((t.payloads[0] as Record<string, unknown>).hookEventName, 'stop');
  });

  it('still posts for a Claude-style payload without hookEventName under GROK_HOOK_EVENT=stop', async () => {
    const t = recorder();
    await t.run(JSON.stringify(CLAUDE_STOP), baseEnv({ GROK_HOOK_EVENT: 'stop' }));
    assert.equal(t.payloads.length, 1);
    assert.equal((t.payloads[0] as Record<string, unknown>).hook_event_name, 'Stop');
  });

  it('forwards Grok Notification events when GROK_HOOK_EVENT=notification', async () => {
    const t = recorder();
    await t.run(JSON.stringify(GROK_NOTIFICATION), baseEnv({ GROK_HOOK_EVENT: 'notification' }));
    assert.equal(t.payloads.length, 1);
    assert.equal((t.payloads[0] as Record<string, unknown>).notification_type, 'permission_prompt');
  });

  it('does not stand down for an empty hookEventName string', async () => {
    const t = recorder();
    await t.run(JSON.stringify({ hookEventName: '', hook_event_name: 'Stop' }), baseEnv({ GROK_HOOK_EVENT: 'stop' }));
    assert.equal(t.payloads.length, 1);
  });

  it('does not stand down when stdin is invalid JSON under GROK_HOOK_EVENT', async () => {
    const plain = recorder();
    await plain.run('{not json', baseEnv());
    const grok = recorder();
    await grok.run('{not json', baseEnv({ GROK_HOOK_EVENT: 'stop' }));
    assert.deepEqual(grok.payloads, plain.payloads);
    assert.deepEqual(grok.stderr, plain.stderr);
  });
});

describe('notify adapter fallback body', () => {
  it('posts a fallback body with hook_event_name from HOOK_EVENT_NAME for invalid JSON', async () => {
    const t = recorder();
    await t.run('{not json', baseEnv({ HOOK_EVENT_NAME: 'PreToolUse' }));
    assert.deepEqual(t.payloads, [{
      ftown_session_id: SESSION_ID,
      ftown_session_source: 'env',
      hook_event_name: 'PreToolUse',
    }]);
    assert.deepEqual(t.stderr, []);
  });

  it('defaults hook_event_name to "hook" when HOOK_EVENT_NAME is absent or empty', async () => {
    const absent = recorder();
    await absent.run('', baseEnv());
    assert.deepEqual(absent.payloads, [{
      ftown_session_id: SESSION_ID,
      ftown_session_source: 'env',
      hook_event_name: 'hook',
    }]);

    const empty = recorder();
    await empty.run('[]', baseEnv({ HOOK_EVENT_NAME: '' }));
    assert.deepEqual(empty.payloads, [{
      ftown_session_id: SESSION_ID,
      ftown_session_source: 'env',
      hook_event_name: 'hook',
    }]);
  });

  it('uses a fallback body for scalar and array stdin', async () => {
    for (const input of ['42', '"text"', '[]', 'null']) {
      const t = recorder();
      await t.run(input, baseEnv({ HOOK_EVENT_NAME: 'Stop' }));
      assert.deepEqual(t.payloads, [{
        ftown_session_id: SESSION_ID,
        ftown_session_source: 'env',
        hook_event_name: 'Stop',
      }]);
    }
  });
});

describe('notify adapter session registry fallback', () => {
  it('resolves byConversation and marks the source', async () => {
    const home = makeRegistryHome({ byConversation: { conv: 'session-from-conv' }, byWorkspace: {} });
    const t = recorder();
    await t.run(JSON.stringify({ conversation_id: 'conv' }), { HOME: home });
    assert.deepEqual(t.payloads, [{
      conversation_id: 'conv',
      ftown_session_id: 'session-from-conv',
      ftown_session_source: 'conversation',
    }]);
  });

  it('resolves byWorkspace from workspace_roots[0] and marks the source', async () => {
    const home = makeRegistryHome({ byConversation: {}, byWorkspace: { '/work': 'session-from-ws' } });
    const t = recorder();
    await t.run(JSON.stringify({ workspace_roots: ['/work', '/other'] }), { HOME: home });
    assert.deepEqual(t.payloads, [{
      workspace_roots: ['/work', '/other'],
      ftown_session_id: 'session-from-ws',
      ftown_session_source: 'workspace',
    }]);
  });

  it('prefers conversation over workspace resolution', async () => {
    const home = makeRegistryHome({
      byConversation: { conv: 'session-from-conv' },
      byWorkspace: { '/work': 'session-from-ws' },
    });
    const t = recorder();
    await t.run(JSON.stringify({ conversation_id: 'conv', workspace_roots: ['/work'] }), { HOME: home });
    assert.equal((t.payloads[0] as Record<string, unknown>).ftown_session_source, 'conversation');
    assert.equal((t.payloads[0] as Record<string, unknown>).ftown_session_id, 'session-from-conv');
  });

  it('prefers an env session over the registry', async () => {
    const home = makeRegistryHome({ byConversation: { conv: 'session-from-conv' }, byWorkspace: {} });
    const t = recorder();
    await t.run(JSON.stringify({ conversation_id: 'conv' }), baseEnv({ HOME: home }));
    assert.equal((t.payloads[0] as Record<string, unknown>).ftown_session_source, 'env');
    assert.equal((t.payloads[0] as Record<string, unknown>).ftown_session_id, SESSION_ID);
  });

  it('is inert with a missing registry or non-string lookup keys', async () => {
    const home = mkdtempSync(join(tmpdir(), 'notify-adapter-empty-home-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    const missing = recorder();
    await missing.run(JSON.stringify({ conversation_id: 'conv' }), { HOME: home });
    assert.deepEqual(missing.payloads, []);

    writeRegistryAt(home, { byConversation: { conv: 'session-from-conv' }, byWorkspace: {} });
    const nonString = recorder();
    await nonString.run(JSON.stringify({ conversation_id: 42, workspace_roots: [null] }), { HOME: home });
    assert.deepEqual(nonString.payloads, []);
  });

  it('is inert without a session or HOME', async () => {
    const t = recorder();
    await t.run(JSON.stringify(CLAUDE_STOP), {});
    assert.deepEqual(t.payloads, []);
    assert.deepEqual(t.stderr, []);
  });
});

describe('notify adapter failures and CLI wiring', () => {
  it('reports a delivery failure on stderr but exits 0 without stdout', async () => {
    const payloads: HookWirePayload[] = [];
    const stderr: string[] = [];
    const code = await runHookCommand({
      args: ['notify'],
      input: JSON.stringify(CLAUDE_STOP),
      env: baseEnv(),
      post: async (payload) => {
        payloads.push(payload);
        return {
          ok: false,
          error: { kind: 'delivery-failed', message: 'bridge delivery failed after 1 attempt(s): port 1: connection refused', attempts: [] },
        };
      },
      err: (m) => stderr.push(m),
      out: () => { throw new Error('notify must not write stdout'); },
    });
    assert.equal(code, 0);
    assert.equal(payloads.length, 1);
    assert.deepEqual(stderr, ['ftown hook: bridge delivery failed after 1 attempt(s): port 1: connection refused']);
  });

  it('delivers an event with jq and curl absent from PATH', async () => {
    const bodies: string[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const savedPath = process.env.PATH;
    const emptyBin = mkdtempSync(join(tmpdir(), 'notify-no-tools-bin-'));
    cleanups.push(() => rmSync(emptyBin, { recursive: true, force: true }));
    try {
      process.env.PATH = emptyBin; // no jq, no curl, nothing else
      const code = await runHookCommand({
        args: ['notify'],
        input: JSON.stringify(CLAUDE_STOP),
        env: baseEnv({ FTOWN_HOOK_PORT: String(address.port) }),
        post: postHookPayload,
      });
      assert.equal(code, 0);
      assert.equal(bodies.length, 1);
      assert.equal((JSON.parse(bodies[0]) as Record<string, unknown>).ftown_session_id, SESSION_ID);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it('dispatches notify through the real ftown-harness command', async () => {
    const bodies: string[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const savedEnv = { ...process.env };
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    const cliHome = mkdtempSync(join(tmpdir(), 'notify-adapter-cli-home-'));
    cleanups.push(() => rmSync(cliHome, { recursive: true, force: true }));
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, {
        HOME: cliHome,
        FTOWN_SESSION_ID: 'cli-session',
        FTOWN_HOOK_PORT: String(address.port),
      });
      Object.defineProperty(process, 'stdin', {
        configurable: true,
        value: Readable.from([Buffer.from(JSON.stringify(CLAUDE_STOP))]),
      });
      const code = await runHarness(['hook', 'notify']);
      assert.equal(code, 0);
      assert.equal(bodies.length, 1);
      assert.deepEqual(JSON.parse(bodies[0]), {
        ...CLAUDE_STOP,
        ftown_session_id: 'cli-session',
        ftown_session_source: 'env',
      });
    } finally {
      if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });
});
