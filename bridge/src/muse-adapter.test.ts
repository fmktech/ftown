import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { runHarness } from './harness-commands.js';
import { runHookCommand } from './hook-cli.js';
import type { HookEnvironment, HookKind, HookWirePayload, PostHookPayload } from './hook-contract.js';
import { postHookPayload } from './hook-transport.js';

const SESSION_ID = 'ftown-session-muse-adapter';

const NATIVE = {
  session_id: 'muse-native-1',
  cwd: '/work/muse',
  prompt: 'say hi',
  tool_name: 'Bash',
  tool_use_id: 'toolu_1',
  tool_input: { command: 'ls -la' },
  tool_response: 'secret-output',
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
  run: (kind: HookKind, input: string, env?: HookEnvironment) => Promise<void>;
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
    async run(kind, input, env = baseEnv()) {
      code = await runHookCommand({
        args: [kind], input, env, post: this.post,
        out: (m) => stdout.push(m), err: (m) => stderr.push(m),
      });
    },
  };
}

function baseEnv(extra: Partial<HookEnvironment> = {}): HookEnvironment {
  return { FTOWN_SESSION_ID: SESSION_ID, ...extra };
}

/** Stub `ftown security proxy` in an isolated HOME, mirroring the production CLI. */
function secureCliHome(messages: unknown[]): { home: string; requestFile: string } {
  const home = mkdtempSync(join(tmpdir(), 'muse-adapter-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, '.ftown', 'bin');
  mkdirSync(bin, { recursive: true });
  const requestFile = join(home, 'proxy-request.json');
  writeFileSync(
    join(bin, 'ftown'),
    '#!/bin/sh\n[ "$1" = security ] && [ "$2" = proxy ] || exit 1\ncat > "$FTOWN_TEST_PROXY_REQUEST"\ncat "$FTOWN_TEST_PROXY_RESPONSE"\n',
    { mode: 0o700 },
  );
  writeFileSync(join(home, 'proxy-response.json'), JSON.stringify({ status: 200, body: { messages } }));
  return { home, requestFile };
}

function probeEnv(home: string, requestFile: string): HookEnvironment {
  return {
    FTOWN_SESSION_ID: SESSION_ID,
    HOME: home,
    FTOWN_TEST_PROXY_REQUEST: requestFile,
    FTOWN_TEST_PROXY_RESPONSE: join(home, 'proxy-response.json'),
  } as HookEnvironment;
}

describe('muse adapters registration and payloads', () => {
  it('dispatches all five native kinds and posts their typed payloads', async () => {
    const cases: Array<[HookKind, Record<string, unknown>]> = [
      ['muse-session-start', {
        ftown_session_id: SESSION_ID, ftown_session_source: 'env', hook_event_name: 'SessionStart',
        session_id: NATIVE.session_id, cwd: NATIVE.cwd,
      }],
      ['muse-user-prompt-submit', {
        ftown_session_id: SESSION_ID, ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit',
        session_id: NATIVE.session_id, cwd: NATIVE.cwd, prompt: NATIVE.prompt,
      }],
      ['muse-pre-tool-use', {
        ftown_session_id: SESSION_ID, hook_event_name: 'PreToolUse',
        tool_name: NATIVE.tool_name, tool_use_id: NATIVE.tool_use_id,
      }],
      ['muse-post-tool-use', {
        ftown_session_id: SESSION_ID, hook_event_name: 'PostToolUse',
        tool_name: NATIVE.tool_name, tool_use_id: NATIVE.tool_use_id,
      }],
      ['muse-stop', {
        ftown_session_id: SESSION_ID, ftown_session_source: 'env', hook_event_name: 'Stop',
        session_id: NATIVE.session_id, cwd: NATIVE.cwd,
      }],
    ];
    for (const [kind, expected] of cases) {
      const t = recorder();
      await t.run(kind, JSON.stringify(NATIVE));
      assert.equal(t.code, 0, `${kind} exit`);
      assert.deepEqual(t.payloads, [expected], `${kind} payload`);
      assert.deepEqual(t.stdout, [], `${kind} stdout`);
      assert.deepEqual(t.stderr, [], `${kind} stderr`);
    }
  });

  it('is inert without an owning ftown session for every kind', async () => {
    for (const kind of ['muse-session-start', 'muse-user-prompt-submit', 'muse-pre-tool-use', 'muse-post-tool-use', 'muse-stop'] as const) {
      const t = recorder();
      await t.run(kind, JSON.stringify(NATIVE), {});
      assert.deepEqual(t.payloads, [], `${kind} posts`);
      assert.deepEqual(t.stderr, [], `${kind} stderr`);
    }
  });

  it('reports invalid JSON and non-object stdin without posting', async () => {
    for (const kind of ['muse-session-start', 'muse-user-prompt-submit', 'muse-pre-tool-use', 'muse-post-tool-use', 'muse-stop'] as const) {
      for (const input of ['not-json', '[]', 'null', '42']) {
        const t = recorder();
        await t.run(kind, input);
        assert.equal(t.code, 0);
        assert.deepEqual(t.payloads, [], `${kind} posted for ${input}`);
        assert.equal(t.stderr.length, 1, `${kind} stderr for ${input}`);
        assert.match(t.stderr[0], /native hook payload/);
      }
    }
  });

  it('coerces missing native fields to empty strings for envelope events', async () => {
    for (const kind of ['muse-session-start', 'muse-user-prompt-submit', 'muse-stop'] as const) {
      const t = recorder();
      await t.run(kind, JSON.stringify({ session_id: 7, cwd: null }));
      const payload = t.payloads[0] as Record<string, unknown>;
      assert.equal(payload.session_id, '');
      assert.equal(payload.cwd, '');
    }
  });
});

describe('muse adapter field rules', () => {
  it('includes prompt only when it is a string', async () => {
    const withPrompt = recorder();
    await withPrompt.run('muse-user-prompt-submit', JSON.stringify({ prompt: 'real prompt' }));
    assert.equal((withPrompt.payloads[0] as Record<string, unknown>).prompt, 'real prompt');

    for (const prompt of [42, null, ['a'], { text: 'a' }]) {
      const t = recorder();
      await t.run('muse-user-prompt-submit', JSON.stringify({ prompt }));
      assert.equal('prompt' in (t.payloads[0] as Record<string, unknown>), false);
    }
  });

  it('omits tool arguments, results, cwd, native id and source from tool events', async () => {
    for (const kind of ['muse-pre-tool-use', 'muse-post-tool-use'] as const) {
      const t = recorder();
      await t.run(kind, JSON.stringify(NATIVE));
      const payload = t.payloads[0] as Record<string, unknown>;
      assert.deepEqual(Object.keys(payload).sort(), ['ftown_session_id', 'hook_event_name', 'tool_name', 'tool_use_id']);
      const raw = JSON.stringify(payload);
      for (const secret of ['ls -la', 'secret-output', 'muse-native-1', '/work/muse', 'say hi']) {
        assert.equal(raw.includes(secret), false, `${kind} leaked ${secret}`);
      }
    }
  });

  it('omits tool name and call id when they are not strings', async () => {
    const t = recorder();
    await t.run('muse-pre-tool-use', JSON.stringify({ tool_name: 7, tool_use_id: { id: 'x' } }));
    assert.deepEqual(t.payloads, [{ ftown_session_id: SESSION_ID, hook_event_name: 'PreToolUse' }]);
  });
});

describe('muse Stop mail drain', () => {
  const MAIL = [
    { id: '1', ts: '2026-09-23T21:00:00.000Z', from: 'agent-a', fromName: 'Agent A', type: 'message', body: 'hello' },
    { id: '2', ts: '2026-09-23T21:01:00.000Z', from: 'agent-b', type: 'task', body: 'do the thing' },
  ];

  it('posts first, then drains the inbox and emits mail as additionalContext', async () => {
    const { home, requestFile } = secureCliHome(MAIL);
    const t = recorder();
    await t.run('muse-stop', JSON.stringify(NATIVE), probeEnv(home, requestFile));

    assert.deepEqual(t.payloads, [{
      ftown_session_id: SESSION_ID, ftown_session_source: 'env', hook_event_name: 'Stop',
      session_id: NATIVE.session_id, cwd: NATIVE.cwd,
    }]);
    const request = JSON.parse(readFileSync(requestFile, 'utf8')) as { method: string; path: string; timeoutMs: number };
    assert.equal(request.method, 'GET');
    assert.equal(request.path, `/api/sessions/${SESSION_ID}/inbox?wait=0`);
    assert.equal(request.timeoutMs, 2000);
    assert.equal(t.stdout.length, 1);
    assert.deepEqual(JSON.parse(t.stdout[0]), {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: '[ftown mail]\n'
          + '[2026-09-23T21:00:00.000Z] Agent A (message): hello\n'
          + '[2026-09-23T21:01:00.000Z] agent-b (task): do the thing',
      },
    });
    assert.deepEqual(t.stderr, []);
  });

  it('stays silent for an empty inbox', async () => {
    const { home, requestFile } = secureCliHome([]);
    const t = recorder();
    await t.run('muse-stop', JSON.stringify(NATIVE), probeEnv(home, requestFile));
    assert.equal(t.payloads.length, 1);
    assert.deepEqual(t.stdout, []);
    assert.deepEqual(t.stderr, []);
  });

  it('never turns a mail drain failure into a hook error', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'muse-adapter-empty-home-'));
    cleanups.push(() => rmSync(emptyHome, { recursive: true, force: true }));
    const t = recorder();
    await t.run('muse-stop', JSON.stringify(NATIVE), { FTOWN_SESSION_ID: SESSION_ID, HOME: emptyHome });
    assert.equal(t.payloads.length, 1);
    assert.deepEqual(t.stdout, []);
    assert.deepEqual(t.stderr, []);
  });
});

describe('muse adapter failures and wiring', () => {
  it('reports a delivery failure on stderr but exits 0 without stdout', async () => {
    const stderr: string[] = [];
    const code = await runHookCommand({
      args: ['muse-user-prompt-submit'],
      input: JSON.stringify(NATIVE),
      env: baseEnv(),
      post: async () => ({
        ok: false,
        error: { kind: 'delivery-failed', message: 'bridge delivery failed after 1 attempt(s): port 1: connection refused', attempts: [] },
      }),
      err: (m) => stderr.push(m),
      out: () => { throw new Error('muse must not write stdout here'); },
    });
    assert.equal(code, 0);
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
    const emptyBin = mkdtempSync(join(tmpdir(), 'muse-no-tools-bin-'));
    cleanups.push(() => rmSync(emptyBin, { recursive: true, force: true }));
    try {
      process.env.PATH = emptyBin;
      const code = await runHookCommand({
        args: ['muse-pre-tool-use'],
        input: JSON.stringify(NATIVE),
        env: baseEnv({ FTOWN_HOOK_PORT: String(address.port) }),
        post: postHookPayload,
      });
      assert.equal(code, 0);
      assert.equal(bodies.length, 1);
      assert.deepEqual(JSON.parse(bodies[0]), {
        ftown_session_id: SESSION_ID, hook_event_name: 'PreToolUse',
        tool_name: NATIVE.tool_name, tool_use_id: NATIVE.tool_use_id,
      });
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it('dispatches a Muse event through the real ftown-harness command', async () => {
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
    const cliHome = mkdtempSync(join(tmpdir(), 'muse-adapter-cli-home-'));
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
        value: Readable.from([Buffer.from(JSON.stringify(NATIVE))]),
      });
      const code = await runHarness(['hook', 'muse-user-prompt-submit']);
      assert.equal(code, 0);
      assert.equal(bodies.length, 1);
      assert.deepEqual(JSON.parse(bodies[0]), {
        ftown_session_id: 'cli-session', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit',
        session_id: NATIVE.session_id, cwd: NATIVE.cwd, prompt: NATIVE.prompt,
      });
    } finally {
      if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });
});
