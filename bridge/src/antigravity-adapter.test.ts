import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { runHarness } from './harness-commands.js';
import { runHookCommand } from './hook-cli.js';
import {
  formatAntigravityMail,
  makeAntigravityAdapter,
  type AntigravityInboxReader,
} from './hook-adapters.js';
import type { HookEnvironment, HookWirePayload, JsonObject, PostHookPayload } from './hook-contract.js';
import { postHookPayload } from './hook-transport.js';

const SESSION_ID = 'ftown-session-antigravity-adapter';
const CONVERSATION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const CWD = '/workspace/antigravity';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function nativeEvent(fields: Record<string, unknown>): string {
  return JSON.stringify({ conversationId: CONVERSATION_ID, cwd: CWD, ...fields });
}

function baseEnv(extra: Partial<HookEnvironment> = {}): HookEnvironment {
  return { FTOWN_SESSION_ID: SESSION_ID, ...extra };
}

const BASE_BODY = {
  ftown_session_id: SESSION_ID,
  ftown_session_source: 'env',
  session_id: CONVERSATION_ID,
  cwd: CWD,
};

/** Drive the adapter directly with an injectable inbox reader (no subprocess). */
function recorder(readInbox: AntigravityInboxReader = async () => undefined) {
  const payloads: HookWirePayload[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  const adapter = makeAntigravityAdapter(readInbox);
  return {
    payloads,
    stderr,
    stdout,
    post: async (payload: HookWirePayload) => { payloads.push(payload); return { ok: true, candidate: { port: 1, source: 'env' } }; },
    async run(input: string, env: HookEnvironment) {
      const result = await adapter({ kind: 'antigravity', input, env, post: this.post });
      if (result.stdout !== undefined) stdout.push(result.stdout);
      if (result.status === 'error') stderr.push(`ftown hook: ${result.error.message}`);
    },
  };
}

function startServer(): Promise<{ port: number; bodies: string[]; authorization: Array<string | undefined>; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const bodies: string[] = [];
    const authorization: Array<string | undefined> = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        authorization.push(req.headers.authorization);
        res.writeHead(200);
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      cleanups.push(() => server.closeAllConnections());
      cleanups.push(() => server.close());
      resolve({
        port: address.port,
        bodies,
        authorization,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('antigravity adapter registration and event mapping', () => {
  it('is dispatched by kind through the shared runner and posts SessionStart with bearer auth', async () => {
    const bridge = await startServer();
    const code = await runHookCommand({
      args: ['antigravity'],
      input: nativeEvent({ hookEventName: 'SessionStart' }),
      env: baseEnv({ FTOWN_HOOK_PORT: String(bridge.port), FTOWN_HOOK_TOKEN: 'antigravity-token' }),
      post: postHookPayload,
    });
    assert.equal(code, 0);
    assert.equal(bridge.bodies.length, 1);
    assert.equal(bridge.authorization[0], 'Bearer antigravity-token');
    assert.deepEqual(JSON.parse(bridge.bodies[0]), { ...BASE_BODY, hook_event_name: 'SessionStart' });
  });

  it('passes PreToolUse / PostToolUse / Stop through unchanged', async () => {
    for (const hookEventName of ['PreToolUse', 'PostToolUse', 'Stop']) {
      const t = recorder();
      await t.run(nativeEvent({ hookEventName }), baseEnv());
      assert.deepEqual(t.payloads, [{ ...BASE_BODY, hook_event_name: hookEventName }], hookEventName);
      assert.deepEqual(t.stdout, []);
      assert.deepEqual(t.stderr, []);
    }
  });

  it('maps PreInvocation with numeric invocationNum 0 to UserPromptSubmit', async () => {
    const t = recorder();
    await t.run(nativeEvent({ hookEventName: 'PreInvocation', invocationNum: 0 }), baseEnv());
    assert.deepEqual(t.payloads, [{ ...BASE_BODY, hook_event_name: 'UserPromptSubmit' }]);
  });

  for (const extra of [{ invocationNum: 1 }, {}, { invocationNum: '0' }, { invocationNum: null }]) {
    it(`does not post PreInvocation with ${JSON.stringify(extra)}`, async () => {
      const t = recorder();
      await t.run(nativeEvent({ hookEventName: 'PreInvocation', ...extra }), baseEnv());
      assert.deepEqual(t.payloads, []);
    });
  }

  it('posts nothing for other native events and for PostInvocation', async () => {
    for (const hookEventName of ['PostInvocation', 'Unknown', '']) {
      const t = recorder();
      await t.run(nativeEvent({ hookEventName }), baseEnv());
      assert.deepEqual(t.payloads, [], hookEventName);
    }
  });

  it('is inert without FTOWN_SESSION_ID', async () => {
    const t = recorder();
    await t.run(nativeEvent({ hookEventName: 'SessionStart' }), {});
    assert.deepEqual(t.payloads, []);
    assert.deepEqual(t.stderr, []);
  });
});

describe('antigravity adapter input coercion', () => {
  it('coerces conversationId and cwd to strings and falls back to env conversation id', async () => {
    const cases: Array<[unknown, string]> = [
      ['conv-1', 'conv-1'],
      [42, '42'],
      [null, ''],
      [undefined, ''],
    ];
    for (const [conversationId, expected] of cases) {
      const t = recorder();
      await t.run(JSON.stringify({ hookEventName: 'SessionStart', conversationId, cwd: 99 }), baseEnv({ ANTIGRAVITY_CONVERSATION_ID: 'env-conv' }));
      assert.equal((t.payloads[0] as JsonObject).session_id, expected || 'env-conv');
      assert.equal((t.payloads[0] as JsonObject).cwd, '99');
    }
  });

  it('uses the payload cwd, never the process working directory', async () => {
    const t = recorder();
    await t.run(JSON.stringify({ hookEventName: 'SessionStart', cwd: '/from/payload' }), baseEnv());
    assert.equal((t.payloads[0] as JsonObject).cwd, '/from/payload');
  });

  for (const input of ['not-json{{{', '', '[1,2]', '42', JSON.stringify({ cwd: CWD })]) {
    it(`posts nothing and stays silent for ${input.slice(0, 24) || 'empty stdin'}`, async () => {
      const t = recorder();
      await t.run(input, baseEnv());
      assert.deepEqual(t.payloads, []);
      assert.deepEqual(t.stdout, []);
      assert.deepEqual(t.stderr, []);
    });
  }
});

describe('antigravity adapter tool fields', () => {
  it('forwards a string name, an object args and a string id', async () => {
    const toolCall = { id: 'tool-7', name: 'run_command', args: { CommandLine: 'echo hi', Nested: { a: [1, 2] } } };
    const t = recorder();
    await t.run(nativeEvent({ hookEventName: 'PreToolUse', toolCall }), baseEnv());
    assert.deepEqual(t.payloads, [{
      ...BASE_BODY,
      hook_event_name: 'PreToolUse',
      tool_name: 'run_command',
      tool_input: toolCall.args,
      tool_use_id: 'tool-7',
    }]);
  });

  for (const [label, args] of [
    ['string', 'echo hi'], ['array', ['echo', 'hi']], ['number', 42], ['null', null],
  ] as const) {
    it(`omits tool_input when toolCall.args is a ${label}`, async () => {
      const t = recorder();
      await t.run(nativeEvent({ hookEventName: 'PreToolUse', toolCall: { id: 'tc-1', name: 'run_command', args } }), baseEnv());
      assert.deepEqual(t.payloads, [{
        ...BASE_BODY, hook_event_name: 'PreToolUse', tool_name: 'run_command', tool_use_id: 'tc-1',
      }]);
    });
  }

  it('sends tool_use_id only when toolCall.id is a string', async () => {
    const t = recorder();
    await t.run(nativeEvent({ hookEventName: 'PostToolUse', toolCall: { id: 17, name: 'run_command', args: {} } }), baseEnv());
    assert.deepEqual(t.payloads, [{
      ...BASE_BODY, hook_event_name: 'PostToolUse', tool_name: 'run_command', tool_input: {},
    }]);
  });

  it('omits tool_name when toolCall.name is null', async () => {
    const t = recorder();
    await t.run(nativeEvent({ hookEventName: 'PreToolUse', toolCall: { name: null, args: {} } }), baseEnv());
    assert.deepEqual(t.payloads, [{ ...BASE_BODY, hook_event_name: 'PreToolUse', tool_input: {} }]);
  });

  it('never puts tool fields on a Stop payload', async () => {
    const t = recorder();
    await t.run(nativeEvent({ hookEventName: 'Stop', toolCall: { id: 'tc-2', name: 'run_command', args: { CommandLine: 'ls' } } }), baseEnv());
    assert.deepEqual(t.payloads, [{ ...BASE_BODY, hook_event_name: 'Stop' }]);
  });
});

const MAIL_READER: AntigravityInboxReader = async (sessionId) => {
  assert.equal(sessionId, SESSION_ID);
  return { messages: [
    { id: '1', ts: '2026-09-23T21:00:00.000Z', from: 'agent-a', fromName: 'Agent A', type: 'message', body: 'hello "there"' },
    { id: '2', ts: '2026-09-23T21:01:00.000Z', from: 'agent-b', type: 'task', body: 'do the thing' },
  ] };
};

const MAIL_DECISION = JSON.stringify({
  decision: 'continue',
  reason:
    '[ftown mail]\n' +
    '[2026-09-23T21:00:00.000Z] Agent A (message): hello "there"\n' +
    '[2026-09-23T21:01:00.000Z] agent-b (task): do the thing',
});

describe('antigravity adapter Stop mail drain', () => {
  it('drains first, prints one continue decision and still posts Stop', async () => {
    const t = recorder(MAIL_READER);
    await t.run(nativeEvent({ hookEventName: 'Stop' }), baseEnv());
    assert.deepEqual(t.stdout, [MAIL_DECISION]);
    assert.deepEqual(t.stderr, []);
    assert.deepEqual(t.payloads, [{ ...BASE_BODY, hook_event_name: 'Stop' }]);
  });

  for (const terminationReason of ['MAX_FORCED_INVOCATIONS', 'USER_CANCELED', 'ERROR']) {
    it(`skips the drain for terminationReason ${terminationReason}`, async () => {
      let drained = false;
      const t = recorder(async () => { drained = true; return { messages: [{ body: 'mail' }] }; });
      await t.run(nativeEvent({ hookEventName: 'Stop', terminationReason }), baseEnv());
      assert.equal(drained, false);
      assert.deepEqual(t.stdout, []);
      assert.deepEqual(t.payloads, [{ ...BASE_BODY, hook_event_name: 'Stop' }]);
    });
  }

  it('posts Stop without a decision for an empty inbox', async () => {
    const t = recorder(async () => ({ messages: [] }));
    await t.run(nativeEvent({ hookEventName: 'Stop' }), baseEnv());
    assert.deepEqual(t.stdout, []);
    assert.deepEqual(t.payloads, [{ ...BASE_BODY, hook_event_name: 'Stop' }]);
  });

  it('does not drain on non-Stop events', async () => {
    let drained = false;
    const t = recorder(async () => { drained = true; return { messages: [{ body: 'mail' }] }; });
    await t.run(nativeEvent({ hookEventName: 'SessionStart' }), baseEnv());
    assert.equal(drained, false);
    assert.deepEqual(t.stdout, []);
  });

  it('formats mail with the documented fallback fields', () => {
    assert.equal(formatAntigravityMail([{ from: 'bob', body: 'hi' }]), '[ftown mail]\n[] bob (message): hi');
  });
});

describe('antigravity adapter failures and CLI wiring', () => {
  it('reports a delivery failure on stderr but exits 0', async () => {
    const stderr: string[] = [];
    const code = await runHookCommand({
      args: ['antigravity'],
      input: nativeEvent({ hookEventName: 'SessionStart' }),
      env: baseEnv(),
      post: async () => ({
        ok: false,
        error: { kind: 'delivery-failed', message: 'bridge delivery failed after 1 attempt(s): port 1: connection refused', attempts: [] },
      }),
      err: (m) => stderr.push(m),
      out: () => { throw new Error('antigravity SessionStart must not write stdout'); },
    });
    assert.equal(code, 0);
    assert.deepEqual(stderr, ['ftown hook: bridge delivery failed after 1 attempt(s): port 1: connection refused']);
  });

  it('delivers a SessionStart event with jq and curl absent from PATH', async () => {
    const bridge = await startServer();
    const emptyBin = mkdtempSync(join(tmpdir(), 'antigravity-no-tools-bin-'));
    cleanups.push(() => rmSync(emptyBin, { recursive: true, force: true }));
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = emptyBin; // no jq, no curl, nothing else
      const code = await runHookCommand({
        args: ['antigravity'],
        input: nativeEvent({ hookEventName: 'SessionStart' }),
        env: baseEnv({ FTOWN_HOOK_PORT: String(bridge.port) }),
        post: postHookPayload,
      });
      assert.equal(code, 0);
      assert.equal(bridge.bodies.length, 1);
      assert.equal((JSON.parse(bridge.bodies[0]) as JsonObject).ftown_session_id, SESSION_ID);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it('dispatches antigravity through the real ftown-harness command', async () => {
    const bridge = await startServer();
    const savedEnv = { ...process.env };
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    const cliHome = mkdtempSync(join(tmpdir(), 'antigravity-adapter-cli-home-'));
    cleanups.push(() => rmSync(cliHome, { recursive: true, force: true }));
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, {
        HOME: cliHome,
        FTOWN_SESSION_ID: 'cli-session',
        FTOWN_HOOK_PORT: String(bridge.port),
      });
      Object.defineProperty(process, 'stdin', {
        configurable: true,
        value: Readable.from([Buffer.from(nativeEvent({ hookEventName: 'SessionStart' }))]),
      });
      const code = await runHarness(['hook', 'antigravity']);
      assert.equal(code, 0);
      assert.equal(bridge.bodies.length, 1);
      assert.deepEqual(JSON.parse(bridge.bodies[0]), {
        ftown_session_id: 'cli-session',
        ftown_session_source: 'env',
        hook_event_name: 'SessionStart',
        session_id: CONVERSATION_ID,
        cwd: CWD,
      });
    } finally {
      if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });
});
