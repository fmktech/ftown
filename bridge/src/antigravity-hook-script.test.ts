import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT = fileURLToPath(new URL('../hooks/ftown-antigravity-hook.sh', import.meta.url));
const HOOK_CLI = fileURLToPath(new URL('../src/hook-cli.ts', import.meta.url));
// Absolute so a test that narrows PATH or changes cwd cannot break tsx loading.
const TSX_LOADER = fileURLToPath(import.meta.resolve('tsx'));
const CONVERSATION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const PAYLOAD_CWD = '/private/tmp/agy-probe/workspace';

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface StubOptions {
  /** HTTP status answered on POST /hook (default 200). */
  hookStatus?: number;
  /** Never answer POST /hook (simulates a hung bridge). */
  hang?: boolean;
}

interface StubBridge {
  port: number;
  requests: RecordedRequest[];
  /** Resolves when the first request has started arriving. */
  firstRequest: Promise<void>;
  close: () => Promise<void>;
}

const openStubs: StubBridge[] = [];
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startStubBridge(options: StubOptions = {}): Promise<StubBridge> {
  const requests: RecordedRequest[] = [];
  let markFirst: () => void = () => {};
  const firstRequest = new Promise<void>((resolve) => { markFirst = resolve; });
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    markFirst();
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.method === 'POST' && req.url === '/hook') {
        if (options.hang) return;
        res.writeHead(options.hookStatus ?? 200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub bridge failed to bind');
  let closed = false;
  const stub: StubBridge = {
    port: address.port,
    requests,
    firstRequest,
    close: () => new Promise<void>((resolve, reject) => {
      if (closed) { resolve(); return; }
      closed = true;
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
  openStubs.push(stub);
  return stub;
}

afterEach(async () => {
  while (openStubs.length > 0) await openStubs.pop()?.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

interface ScriptResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  endedAt: number;
  proxyRequest?: { method: string; path: string; timeoutMs: number };
}

interface RunOptions {
  cwd?: string;
  /** Called once the child is spawned (e.g. to signal it). */
  onSpawn?: (child: ReturnType<typeof spawn>) => void;
  /** Close the read end of the child's stdout right away. */
  closeStdout?: boolean;
}

/**
 * Stand-in for the installed `ftown-harness` CLI. It dispatches the real Node
 * hook entry point via tsx. The wrapper's PATH is limited to this directory,
 * proving the hook needs no jq or curl to translate and deliver an event.
 */
function makeHarnessBin(): { bin: string; harness: string } {
  const bin = tempDir('ftown-antigravity-harness-bin-');
  const entry = join(bin, 'hook-entry.mjs');
  writeFileSync(
    entry,
    `import { runHookCli } from ${JSON.stringify(HOOK_CLI)};\nprocess.exit(await runHookCli(process.argv.slice(3)));\n`,
  );
  const harness = join(bin, 'ftown-harness');
  writeFileSync(
    harness,
    [
      '#!/bin/bash',
      '# Answer the wrapper capability probe without paying tsx startup twice.',
      'if [ "${1:-}" = hook ] && [ "${2:-}" = "--help" ]; then echo "hook help"; exit 0; fi',
      `exec ${process.execPath} --import ${JSON.stringify(TSX_LOADER)} ${JSON.stringify(entry)} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(harness, 0o755);
  return { bin, harness };
}

/** Spawns the wrapper with bash, writes the payload and explicitly ends stdin. */
function runHook(stdin: string, env: Record<string, string | undefined>, options: RunOptions = {}): Promise<ScriptResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const { bin, harness } = makeHarnessBin();
    // Prepend the fake harness dir: any PATH the test sets stays after it, so a
    // jq/curl-absent PATH remains absent while the harness is still discoverable.
    const path = env.PATH ? `${bin}:${env.PATH}` : bin;
    const child = spawn('/bin/bash', [SCRIPT], {
      env: { ...env, PATH: path, FTOWN_HARNESS: env.FTOWN_HARNESS ?? harness },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
    let stdout = '';
    let stderr = '';
    if (options.closeStdout) child.stdout.destroy();
    else child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      const proxyFile = env.FTOWN_TEST_PROXY_REQUEST;
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        elapsedMs: Date.now() - started,
        endedAt: Date.now(),
        ...(proxyFile && existsSync(proxyFile) ? { proxyRequest: JSON.parse(readFileSync(proxyFile, 'utf8')) } : {}),
      });
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(stdin);
    options.onSpawn?.(child);
  });
}

/** Environment with a stubbed `ftown security proxy` CLI that serves `inbox`. */
function hookEnv(
  stub: StubBridge,
  extra: Record<string, string | undefined> = {},
  inbox: { messages: unknown[] } = { messages: [] },
  withCli = true,
): Record<string, string | undefined> {
  const home = tempDir('ftown-agy-home-');
  const bin = join(home, '.ftown', 'bin');
  mkdirSync(bin, { recursive: true });
  const response = join(home, 'proxy-response.json');
  const request = join(home, 'proxy-request.json');
  writeFileSync(response, JSON.stringify({ status: 200, body: inbox }));
  if (withCli) {
    writeFileSync(
      join(bin, 'ftown'),
      '#!/bin/sh\n[ "$1" = security ] && [ "$2" = proxy ] || exit 1\n/bin/cat > "$FTOWN_TEST_PROXY_REQUEST"\n/bin/cat "$FTOWN_TEST_PROXY_RESPONSE"\n',
      { mode: 0o700 },
    );
  }
  return {
    HOME: home,
    FTOWN_SESSION_ID: 'ftown-sid-1',
    FTOWN_HOOK_PORT: String(stub.port),
    FTOWN_HOOK_TOKEN: 'test-token',
    FTOWN_TEST_PROXY_REQUEST: request,
    FTOWN_TEST_PROXY_RESPONSE: response,
    ...extra,
  };
}

function payload(fields: Record<string, unknown>): string {
  return JSON.stringify({ conversationId: CONVERSATION_ID, cwd: PAYLOAD_CWD, ...fields });
}

const BASE_BODY = {
  ftown_session_id: 'ftown-sid-1',
  ftown_session_source: 'env',
  session_id: CONVERSATION_ID,
  cwd: PAYLOAD_CWD,
};

const MAIL = {
  messages: [
    { id: '1', ts: '2026-09-23T21:00:00.000Z', from: 'agent-a', fromName: 'Agent A', to: 'me', type: 'message', body: 'hello "there"' },
    { id: '2', ts: '2026-09-23T21:01:00.000Z', from: 'agent-b', to: 'me', type: 'task', body: 'do the thing' },
  ],
};
const MAIL_TEXT =
  '[ftown mail]\n' +
  '[2026-09-23T21:00:00.000Z] Agent A (message): hello "there"\n' +
  '[2026-09-23T21:01:00.000Z] agent-b (task): do the thing';

function posts(stub: StubBridge): RecordedRequest[] {
  return stub.requests.filter((request) => request.method === 'POST' && request.url === '/hook');
}

function assertStopPostedSilently(stub: StubBridge, result: ScriptResult): void {
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(posts(stub).length, 1);
  assert.deepEqual(JSON.parse(posts(stub)[0].body), { ...BASE_BODY, hook_event_name: 'Stop' });
}

function assertMailDelivered(stub: StubBridge, result: ScriptResult): void {
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  // Mail delivered: the continue decision is printed AND one Stop POST follows
  // so the bridge clears the busy marker (the drain marks the mail delivered).
  assert.equal(posts(stub).length, 1, 'mail delivered: exactly one Stop POST clears the busy marker');
  assert.deepEqual(JSON.parse(posts(stub)[0].body), { ...BASE_BODY, hook_event_name: 'Stop' });
  assert.deepEqual(result.proxyRequest, { method: 'GET', path: '/api/sessions/ftown-sid-1/inbox?wait=0', timeoutMs: 2000 });
  const lines = result.stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { decision: 'continue', reason: MAIL_TEXT });
}

describe('antigravity hook script file', () => {
  it('is a regular executable file with a bash shebang', () => {
    const stat = lstatSync(SCRIPT);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o755);
    assert.match(readFileSync(SCRIPT, 'utf8'), /^#!\/usr\/bin\/env bash\n/);
  });
});

describe('antigravity hook script events', () => {
  it('is inert without FTOWN_SESSION_ID', async () => {
    const stub = await startStubBridge();
    const result = await runHook(payload({ hookEventName: 'SessionStart' }), hookEnv(stub, { FTOWN_SESSION_ID: undefined }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(stub.requests.length, 0);
  });

  it('SessionStart posts the wire format with bearer auth and prints nothing', async () => {
    const stub = await startStubBridge();
    const result = await runHook(payload({ hookEventName: 'SessionStart' }), hookEnv(stub));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(stub.requests.length, 1);
    const [post] = stub.requests;
    assert.equal(post.method, 'POST');
    assert.equal(post.url, '/hook');
    assert.equal(post.authorization, 'Bearer test-token');
    assert.equal(post.contentType, 'application/json');
    assert.deepEqual(JSON.parse(post.body), { ...BASE_BODY, hook_event_name: 'SessionStart' });
  });

  it('PreInvocation with invocationNum 0 posts UserPromptSubmit', async () => {
    const stub = await startStubBridge();
    const result = await runHook(payload({ hookEventName: 'PreInvocation', invocationNum: 0 }), hookEnv(stub));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(posts(stub).length, 1);
    assert.deepEqual(JSON.parse(posts(stub)[0].body), { ...BASE_BODY, hook_event_name: 'UserPromptSubmit' });
  });

  for (const [label, extra] of [
    ['invocationNum 1', { invocationNum: 1 }],
    ['no invocationNum', {}],
    ['string invocationNum "0"', { invocationNum: '0' }],
  ] as const) {
    it(`PreInvocation with ${label} is not posted`, async () => {
      const stub = await startStubBridge();
      const result = await runHook(payload({ hookEventName: 'PreInvocation', ...extra }), hookEnv(stub));
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(stub.requests.length, 0);
    });
  }

  it('PostInvocation is not posted', async () => {
    const stub = await startStubBridge();
    const result = await runHook(payload({ hookEventName: 'PostInvocation', invocationNum: 0 }), hookEnv(stub));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(stub.requests.length, 0);
  });

  it('falls back to ANTIGRAVITY_CONVERSATION_ID when conversationId is absent', async () => {
    const stub = await startStubBridge();
    const result = await runHook(
      JSON.stringify({ hookEventName: 'SessionStart', cwd: PAYLOAD_CWD }),
      hookEnv(stub, { ANTIGRAVITY_CONVERSATION_ID: 'env-conv-9' }),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(posts(stub).length, 1);
    assert.deepEqual(JSON.parse(posts(stub)[0].body), { ...BASE_BODY, session_id: 'env-conv-9', hook_event_name: 'SessionStart' });
  });

  it('uses the payload cwd, not the process working directory', async () => {
    const stub = await startStubBridge();
    const otherDir = tempDir('ftown-agy-hooks-dir-');
    const result = await runHook(payload({ hookEventName: 'SessionStart' }), hookEnv(stub), { cwd: otherDir });
    assert.equal(result.exitCode, 0);
    assert.equal(posts(stub).length, 1);
    assert.equal(JSON.parse(posts(stub)[0].body).cwd, PAYLOAD_CWD);
  });
});

describe('antigravity hook script tool fields', () => {
  it('PreToolUse forwards toolCall name, args object and id', async () => {
    const stub = await startStubBridge();
    const toolCall = { id: 'tool-call-7', name: 'run_command', args: { CommandLine: 'echo hi', Cwd: '/x', Nested: { a: [1, 2] } } };
    const result = await runHook(payload({ hookEventName: 'PreToolUse', toolCall }), hookEnv(stub));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(posts(stub).length, 1);
    assert.deepEqual(JSON.parse(posts(stub)[0].body), {
      ...BASE_BODY,
      hook_event_name: 'PreToolUse',
      tool_name: 'run_command',
      tool_input: toolCall.args,
      tool_use_id: 'tool-call-7',
    });
  });

  it('PostToolUse forwards tool fields, omitting absent ones', async () => {
    const stub = await startStubBridge();
    const result = await runHook(
      payload({ hookEventName: 'PostToolUse', toolCall: { name: 'view_file', args: { AbsolutePath: '/a/b.ts' } } }),
      hookEnv(stub),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(posts(stub).length, 1);
    assert.deepEqual(JSON.parse(posts(stub)[0].body), {
      ...BASE_BODY,
      hook_event_name: 'PostToolUse',
      tool_name: 'view_file',
      tool_input: { AbsolutePath: '/a/b.ts' },
    });
  });

  for (const [label, args] of [
    ['string', 'echo hi'],
    ['array', ['echo', 'hi']],
    ['number', 42],
    ['null', null],
  ] as const) {
    it(`omits tool_input when toolCall.args is a ${label}`, async () => {
      const stub = await startStubBridge();
      const result = await runHook(
        payload({ hookEventName: 'PreToolUse', toolCall: { id: 'tc-1', name: 'run_command', args } }),
        hookEnv(stub),
      );
      assert.equal(result.exitCode, 0);
      assert.equal(posts(stub).length, 1);
      assert.deepEqual(JSON.parse(posts(stub)[0].body), {
        ...BASE_BODY,
        hook_event_name: 'PreToolUse',
        tool_name: 'run_command',
        tool_use_id: 'tc-1',
      });
    });
  }

  it('sends tool_use_id only when toolCall.id is a string', async () => {
    const stub = await startStubBridge();
    const result = await runHook(
      payload({ hookEventName: 'PostToolUse', toolCall: { id: 17, name: 'run_command', args: {} } }),
      hookEnv(stub),
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(posts(stub)[0].body), {
      ...BASE_BODY,
      hook_event_name: 'PostToolUse',
      tool_name: 'run_command',
      tool_input: {},
    });
  });

  it('never puts tool fields on a Stop body, even when the payload has a toolCall', async () => {
    const stub = await startStubBridge();
    const result = await runHook(
      payload({ hookEventName: 'Stop', toolCall: { id: 'tc-2', name: 'run_command', args: { CommandLine: 'ls' } } }),
      hookEnv(stub),
    );
    assertStopPostedSilently(stub, result);
  });

  it('delivers a ~3 MB toolCall.args intact (body sent on curl stdin)', async () => {
    const stub = await startStubBridge();
    const args = { CommandLine: 'x'.repeat(3 * 1024 * 1024), Tail: 'end' };
    const result = await runHook(payload({ hookEventName: 'PreToolUse', toolCall: { id: 'big', name: 'run_command', args } }), hookEnv(stub));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(posts(stub).length, 1);
    assert.deepEqual(JSON.parse(posts(stub)[0].body).tool_input, args);
  });
});

describe('antigravity hook script Stop and mail', () => {
  it('Stop with mail prints one continue decision and posts nothing', async () => {
    const stub = await startStubBridge();
    const result = await runHook(payload({ hookEventName: 'Stop', continuationActive: true }), hookEnv(stub, {}, MAIL));
    assertMailDelivered(stub, result);
  });

  it('Stop with terminationReason NO_TOOL_CALL drains normally', async () => {
    const stub = await startStubBridge();
    const result = await runHook(payload({ hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL' }), hookEnv(stub, {}, MAIL));
    assertMailDelivered(stub, result);
  });

  for (const reason of ['MAX_FORCED_INVOCATIONS', 'USER_CANCELED', 'ERROR']) {
    it(`Stop with terminationReason ${reason} never reads the inbox and posts Stop`, async () => {
      const stub = await startStubBridge();
      const result = await runHook(payload({ hookEventName: 'Stop', terminationReason: reason }), hookEnv(stub, {}, MAIL));
      assertStopPostedSilently(stub, result);
      assert.equal(result.proxyRequest, undefined, 'inbox must not be read');
    });
  }

  it('Stop with an empty inbox posts Stop and prints nothing', async () => {
    const stub = await startStubBridge();
    const result = await runHook(payload({ hookEventName: 'Stop' }), hookEnv(stub));
    assertStopPostedSilently(stub, result);
    assert.equal(result.proxyRequest?.path, '/api/sessions/ftown-sid-1/inbox?wait=0');
    assert.equal(stub.requests.some((request) => request.method === 'GET'), false, 'no plaintext inbox request');
  });

  it('Stop without the ftown CLI posts Stop and prints nothing', async () => {
    const stub = await startStubBridge();
    const result = await runHook(payload({ hookEventName: 'Stop' }), hookEnv(stub, {}, MAIL, false));
    assertStopPostedSilently(stub, result);
    assert.equal(result.proxyRequest, undefined);
  });

  it('does not drain the inbox on non-Stop events', async () => {
    const stub = await startStubBridge();
    const result = await runHook(
      payload({ hookEventName: 'PostToolUse', toolCall: { id: 't', name: 'x', args: {} } }),
      hookEnv(stub, {}, MAIL),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.proxyRequest, undefined);
  });

  it('exits 0 with no stderr when the stdout reader closes early on a mail Stop', async () => {
    const stub = await startStubBridge();
    const result = await runHook(payload({ hookEventName: 'Stop' }), hookEnv(stub, {}, MAIL), { closeStdout: true });
    assert.equal(result.signal, null);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    // The decision line cannot be read, but Stop is still posted so the bridge
    // clears the busy marker — the contract does not drop it on a broken pipe.
    assert.equal(posts(stub).length, 1);
  });
});

describe('antigravity hook script robustness', () => {
  for (const [label, stdin] of [
    ['invalid JSON', 'not-json{{{'],
    ['empty stdin', ''],
    ['a JSON array', '[1,2]'],
    ['an object without hookEventName', JSON.stringify({ conversationId: CONVERSATION_ID, cwd: PAYLOAD_CWD })],
  ] as const) {
    it(`${label} on stdin sends nothing and exits 0`, async () => {
      const stub = await startStubBridge();
      const result = await runHook(stdin, hookEnv(stub));
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(stub.requests.length, 0);
    });
  }

  it('delivers a 5 MB payload intact without a wall-clock assertion', async () => {
    const stub = await startStubBridge();
    const codeContent = 'y'.repeat(5 * 1024 * 1024);
    const result = await runHook(
      payload({ hookEventName: 'PostToolUse', toolCall: { id: 'big', name: 'write_to_file', args: { CodeContent: codeContent } } }),
      hookEnv(stub),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(posts(stub).length, 1);
    // Load-independent: the whole payload must survive stdin, mapping and the
    // POST byte-for-byte. No assertion on elapsed time (CI load varies wildly).
    const delivered = JSON.parse(posts(stub)[0].body) as Record<string, unknown>;
    assert.equal(Buffer.byteLength(posts(stub)[0].body) > 5 * 1024 * 1024, true);
    assert.deepEqual(delivered.tool_input, { CodeContent: codeContent });
  });

  it('exits 0 with one visible stderr line when the bridge is unreachable', async () => {
    const stub = await startStubBridge();
    const closedPort = stub.port;
    await stub.close();
    const result = await runHook(
      payload({ hookEventName: 'PreToolUse', toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'ls' } } }),
      hookEnv(stub, { FTOWN_HOOK_PORT: String(closedPort) }),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ftown hook: bridge delivery failed/);
  });

  it('exits 0 promptly on SIGTERM while waiting on a hung bridge', async () => {
    const stub = await startStubBridge({ hang: true });
    let killedAt = 0;
    const result = await runHook(
      payload({ hookEventName: 'PreToolUse', toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'ls' } } }),
      hookEnv(stub),
      {
        onSpawn: (child) => {
          void stub.firstRequest.then(() => {
            setTimeout(() => { killedAt = Date.now(); child.kill('SIGTERM'); }, 100);
          });
        },
      },
    );
    assert.ok(killedAt > 0, 'SIGTERM was sent while the POST was in flight');
    // The Node entry point either exits 0 or is terminated by the signal; both
    // end the hook promptly. What matters is that a signalled PreToolUse hook
    // cannot hang the agent for the full bridge timeout.
    assert.ok(result.exitCode === 0 || result.signal === 'SIGTERM', `unexpected exit: code=${result.exitCode} signal=${result.signal}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    const afterKill = result.endedAt - killedAt;
    assert.ok(afterKill < 1000, `exited ${afterKill}ms after SIGTERM`);
  });

  it('delivers with neither jq nor curl on PATH', async () => {
    const stub = await startStubBridge();
    const binDir = tempDir('ftown-agy-bin-');
    // No jq and no curl symlinks: the Node adapter needs neither tool.
    symlinkSync('/bin/bash', join(binDir, 'bash'));
    const result = await runHook(payload({ hookEventName: 'SessionStart' }), hookEnv(stub, { PATH: binDir }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(posts(stub).length, 1);
    assert.deepEqual(JSON.parse(posts(stub)[0].body), { ...BASE_BODY, hook_event_name: 'SessionStart' });
  });

  it('falls back to the ~/.ftown/bridge.json pointer when env has no port', async () => {
    const stub = await startStubBridge();
    const env = hookEnv(stub, { FTOWN_HOOK_PORT: undefined, FTOWN_HOOK_TOKEN: undefined });
    writeFileSync(join(env.HOME as string, '.ftown', 'bridge.json'), JSON.stringify({ port: stub.port, token: 'file-token' }));
    const result = await runHook(payload({ hookEventName: 'SessionStart' }), env);
    assert.equal(result.exitCode, 0);
    assert.equal(posts(stub).length, 1);
    assert.equal(posts(stub)[0].authorization, 'Bearer file-token');
  });

  it('tries the pointer-file candidate when the env candidate answers non-2xx', async () => {
    const failing = await startStubBridge({ hookStatus: 503 });
    const healthy = await startStubBridge();
    const env = hookEnv(failing);
    writeFileSync(join(env.HOME as string, '.ftown', 'bridge.json'), JSON.stringify({ port: healthy.port, token: 'file-token' }));
    const result = await runHook(payload({ hookEventName: 'SessionStart' }), env);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(posts(failing).length, 1);
    assert.equal(posts(healthy).length, 1);
    assert.equal(posts(healthy)[0].authorization, 'Bearer file-token');
    assert.deepEqual(JSON.parse(posts(healthy)[0].body), { ...BASE_BODY, hook_event_name: 'SessionStart' });
  });
});

describe('antigravity wrapper stale installs', () => {
  it('logs visibly and exits 0 when ftown-harness is missing', async () => {
    const stub = await startStubBridge();
    const bin = tempDir('ftown-antigravity-missing-harness-');
    const result = await runHook(payload({ hookEventName: 'SessionStart' }), hookEnv(stub, {
      FTOWN_HARNESS: join(bin, 'missing-ftown-harness'),
    }));
    assert.equal(result.exitCode, 0);
    assert.equal(stub.requests.length, 0);
    assert.match(result.stderr, /ftown-harness is missing/);
    assert.match(result.stderr, /antigravity event not delivered/);
  });

  it('logs visibly and exits 0 when ftown-harness has no hook command', async () => {
    const stub = await startStubBridge();
    const bin = tempDir('ftown-antigravity-old-harness-');
    const old = join(bin, 'old-ftown-harness');
    writeFileSync(
      old,
      '#!/bin/bash\nif [ "${1:-}" = hook ] && [ "${2:-}" = "--help" ]; then echo "error: unknown command \'hook\'" >&2; exit 1; fi\nexit 0\n',
      { mode: 0o755 },
    );
    chmodSync(old, 0o755);
    const result = await runHook(payload({ hookEventName: 'SessionStart' }), hookEnv(stub, { FTOWN_HARNESS: old }));
    assert.equal(result.exitCode, 0);
    assert.equal(stub.requests.length, 0);
    assert.match(result.stderr, /no 'hook' command/);
    assert.match(result.stderr, /antigravity event not delivered/);
  });
});
