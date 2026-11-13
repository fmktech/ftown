import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const HOOK_SCRIPT = fileURLToPath(new URL('../hooks/ftown-grok-hook.sh', import.meta.url));

const TOOL_PATHS = { cat: '/bin/cat', jq: '/usr/bin/jq', curl: '/usr/bin/curl' } as const;
const REREAD_POINTER = '[ftown mail truncated: run `ftown sessions inbox --all --peek` to read the full messages]';

const NATIVE_SID ='7c1f3e52-9a4b-4d1e-8f2a-1b2c3d4e5f60';
const CWD = '/private/tmp/grok-hook-probe/proj';

// Grok payloads carry both spellings; the script must read the snake_case keys.
function payload(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: event,
    hookEventName: event.replace(/[A-Z]/g, (c, i: number) => (i === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`)),
    session_id: NATIVE_SID,
    sessionId: NATIVE_SID,
    cwd: CWD,
    ...extra,
  });
}

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface StubBridge {
  port: number;
  requests: RecordedRequest[];
  inboxPayload: { messages: unknown[] };
  close: () => Promise<void>;
}

const openStubs: StubBridge[] = [];
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startStubBridge(): Promise<StubBridge> {
  const requests: RecordedRequest[] = [];
  const inboxPayload: { messages: unknown[] } = { messages: [] };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
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
    inboxPayload,
    close: () => new Promise<void>((resolve, reject) => {
      if (closed) { resolve(); return; }
      closed = true;
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
  stdout: string;
  stderr: string;
  elapsedMs: number;
  /** What the hook sent to the stubbed `ftown security proxy` (absent when never invoked). */
  proxyRequest?: { method: string; path: string; timeoutMs: number };
}

function runScript(stdin: string, env: Record<string, string | undefined>): Promise<ScriptResult> {
  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...env, PATH: env.PATH ?? '/usr/bin:/bin' })) {
    if (value !== undefined) cleanEnv[key] = value;
  }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [HOOK_SCRIPT], { env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      clearTimeout(killer);
      const proxyFile = cleanEnv.FTOWN_TEST_PROXY_REQUEST;
      resolve({
        exitCode,
        stdout,
        stderr,
        elapsedMs: Date.now() - started,
        ...(proxyFile && existsSync(proxyFile)
          ? { proxyRequest: JSON.parse(readFileSync(proxyFile, 'utf8')) as ScriptResult['proxyRequest'] }
          : {}),
      });
    });
    child.stdin.end(stdin);
  });
}

/**
 * Environment for a run. The inbox is read through `ftown security proxy`
 * (never plain HTTP), so like muse-plugin.test.ts we stub only that local CLI
 * at ~/.ftown/bin/ftown: it records the request it receives on stdin and
 * replies with the stub bridge's current inbox.
 */
function scriptEnv(stub: StubBridge, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const home = extra.HOME ?? tempDir('ftown-grok-home-');
  const bin = join(home, '.ftown', 'bin');
  mkdirSync(bin, { recursive: true });
  const response = join(home, 'proxy-response.json');
  const request = join(home, 'proxy-request.json');
  writeFileSync(response, JSON.stringify({ status: 200, body: stub.inboxPayload }));
  writeFileSync(
    join(bin, 'ftown'),
    '#!/bin/sh\n[ "$1" = security ] && [ "$2" = proxy ] || exit 1\ncat > "$FTOWN_TEST_PROXY_REQUEST"\ncat "$FTOWN_TEST_PROXY_RESPONSE"\n',
    { mode: 0o700 },
  );
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

/** Rewrite the stubbed proxy response after mutating stub.inboxPayload. */
function refreshInbox(env: Record<string, string | undefined>, stub: StubBridge): void {
  writeFileSync(env.FTOWN_TEST_PROXY_RESPONSE as string, JSON.stringify({ status: 200, body: stub.inboxPayload }));
}

function posts(stub: StubBridge): RecordedRequest[] {
  return stub.requests.filter((request) => request.method === 'POST' && request.url === '/hook');
}

describe('grok hook script file', () => {
  it('is an executable regular file (mode 0755), not a symlink', () => {
    const stat = lstatSync(HOOK_SCRIPT);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o755);
  });
});

describe('grok hook script', () => {
  it('is inert without FTOWN_SESSION_ID: exit 0, no output, no network', async () => {
    const stub = await startStubBridge();
    for (const sid of [undefined, '']) {
      const result = await runScript(payload('Stop', { reason: 'end_turn' }), scriptEnv(stub, { FTOWN_SESSION_ID: sid }));
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(result.proxyRequest, undefined);
    }
    assert.equal(stub.requests.length, 0);
  });

  for (const [missing, present] of [['curl', ['cat', 'jq']], ['jq', ['cat', 'curl']]] as const) {
    it(`is inert when ${missing} is missing (${present.join(' + ')} present)`, async () => {
      const stub = await startStubBridge();
      const binDir = tempDir('ftown-grok-bin-');
      for (const tool of present) symlinkSync(TOOL_PATHS[tool], join(binDir, tool));
      const env = scriptEnv(stub, { PATH: binDir });
      refreshInbox(env, stub);
      const result = await runScript(payload('Stop', { reason: 'end_turn' }), env);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(result.proxyRequest, undefined);
      assert.equal(stub.requests.length, 0);
    });
  }

  it('SessionStart posts the wire format with bearer auth and prints nothing', async () => {
    const stub = await startStubBridge();
    const result = await runScript(payload('SessionStart', { source: 'startup' }), scriptEnv(stub));

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(stub.requests.length, 1);
    const [post] = stub.requests;
    assert.equal(post.method, 'POST');
    assert.equal(post.url, '/hook');
    assert.equal(post.authorization, 'Bearer test-token');
    assert.equal(post.contentType, 'application/json');
    assert.deepEqual(JSON.parse(post.body), {
      ftown_session_id: 'ftown-sid-1',
      ftown_session_source: 'env',
      hook_event_name: 'SessionStart',
      session_id: NATIVE_SID,
      cwd: CWD,
    });
    assert.equal(result.proxyRequest, undefined);
  });

  it('PreToolUse includes tool_name, tool_use_id and tool_input as an object', async () => {
    const stub = await startStubBridge();
    const toolInput = { command: 'echo "hi" && ls', nested: { n: 1, list: ['a', 'b'] } };
    const result = await runScript(
      payload('PreToolUse', { tool_name: 'run_terminal_cmd', tool_input: toolInput, tool_use_id: 'call_42' }),
      scriptEnv(stub),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(stub.requests.length, 1);
    assert.deepEqual(JSON.parse(stub.requests[0].body), {
      ftown_session_id: 'ftown-sid-1',
      ftown_session_source: 'env',
      hook_event_name: 'PreToolUse',
      session_id: NATIVE_SID,
      cwd: CWD,
      tool_name: 'run_terminal_cmd',
      tool_input: toolInput,
      tool_use_id: 'call_42',
    });
  });

  it('UserPromptSubmit, PostToolUse and SessionEnd post only and print nothing', async () => {
    const stub = await startStubBridge();
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'SessionEnd', 'SomethingNew']) {
      const result = await runScript(payload(event), scriptEnv(stub));
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.proxyRequest, undefined);
    }
    assert.deepEqual(
      posts(stub).map((post) => (JSON.parse(post.body) as { hook_event_name: string }).hook_event_name),
      ['UserPromptSubmit', 'PostToolUse', 'SessionEnd', 'SomethingNew'],
    );
  });

  it('falls back to GROK_SESSION_ID when the payload has no session_id', async () => {
    const stub = await startStubBridge();
    const body = JSON.stringify({ hook_event_name: 'SessionStart', cwd: CWD });
    const result = await runScript(body, scriptEnv(stub, { GROK_SESSION_ID: 'env-grok-sid' }));

    assert.equal(result.exitCode, 0);
    assert.equal(stub.requests.length, 1);
    assert.equal((JSON.parse(stub.requests[0].body) as { session_id: string }).session_id, 'env-grok-sid');
  });

  it('Stop end_turn with mail posts, drains via the proxy and prints one block decision', async () => {
    const stub = await startStubBridge();
    stub.inboxPayload.messages = [
      { id: '1', ts: '2026-09-23T21:00:00.000Z', from: 'agent-a', fromName: 'Agent A', to: 'me', type: 'message', body: 'hello "quoted"' },
      { id: '2', ts: '2026-09-23T21:01:00.000Z', from: 'agent-b', to: 'me', type: 'task', body: 'do the thing' },
    ];
    const env = scriptEnv(stub);
    refreshInbox(env, stub);

    const result = await runScript(payload('Stop', { reason: 'end_turn' }), env);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    // A2.1: mail was delivered, grok keeps working, so Stop must NOT be posted.
    assert.equal(stub.requests.length, 0, 'no /hook POST (and no plaintext inbox request)');
    assert.deepEqual(result.proxyRequest, {
      method: 'GET',
      path: '/api/sessions/ftown-sid-1/inbox?wait=0',
      timeoutMs: 2000,
    });
    const lines = result.stdout.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 1, 'exactly one line of JSON on stdout');
    assert.deepEqual(JSON.parse(lines[0]), {
      decision: 'block',
      reason:
        '[ftown mail]\n' +
        '[2026-09-23T21:00:00.000Z] Agent A (message): hello "quoted"\n' +
        '[2026-09-23T21:01:00.000Z] agent-b (task): do the thing',
    });
    assert.equal(result.stdout.includes('ftown mail truncated'), false, 'no re-read pointer under the cap');
  });

  it('caps long mail at 9,500 characters and ends with the re-read pointer', async () => {
    const stub = await startStubBridge();
    stub.inboxPayload.messages = [1, 2, 3].map((n) => ({
      id: String(n), ts: `2026-09-23T21:0${n}:00.000Z`, from: `agent-${n}`, type: 'message', body: String(n).repeat(5000),
    }));
    const env = scriptEnv(stub);
    refreshInbox(env, stub);

    const result = await runScript(payload('Stop', { reason: 'end_turn' }), env);

    assert.equal(result.exitCode, 0);
    assert.equal(posts(stub).length, 0, 'mail delivered: no Stop POST');
    const lines = result.stdout.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 1, 'exactly one line of JSON on stdout');
    const out =JSON.parse(lines[0]) as { decision: string; reason: string };
    assert.equal(out.decision, 'block');
    assert.ok(out.reason.length <= 10000, `reason is ${out.reason.length} chars; grok clips at 10,000`);
    assert.ok(out.reason.startsWith('[ftown mail]\n[2026-09-23T21:01:00.000Z] agent-1 (message): 111'));
    assert.ok(out.reason.endsWith(`\n${REREAD_POINTER}`));
    assert.equal(out.reason.length, 9500 + 1 + REREAD_POINTER.length);
  });

  it('Stop end_turn with an empty inbox drains, then posts Stop and prints nothing', async () => {
    const stub = await startStubBridge();
    const result = await runScript(payload('Stop', { reason: 'end_turn' }), scriptEnv(stub));

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.proxyRequest?.path, '/api/sessions/ftown-sid-1/inbox?wait=0');
    assert.equal(posts(stub).length, 1);
    assert.deepEqual(JSON.parse(posts(stub)[0].body), {
      ftown_session_id: 'ftown-sid-1',
      ftown_session_source: 'env',
      hook_event_name: 'Stop',
      session_id: NATIVE_SID,
      cwd: CWD,
    });
  });

  it('Stop end_turn posts Stop when the proxy fails', async () => {
    const stub = await startStubBridge();
    const env = scriptEnv(stub);
    writeFileSync(env.FTOWN_TEST_PROXY_RESPONSE as string, JSON.stringify({ status: 502, body: { error: 'down' } }));

    const result = await runScript(payload('Stop', { reason: 'end_turn' }), env);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(posts(stub).length, 1);
    assert.equal((JSON.parse(posts(stub)[0].body) as { hook_event_name: string }).hook_event_name, 'Stop');
  });

  for (const reason of ['shutdown', 'channel_closed']) {
    it(`Stop ${reason} does nothing: no POST, no inbox read, no output`, async () => {
      const stub = await startStubBridge();
      stub.inboxPayload.messages = [{ id: '1', ts: 't', from: 'a', type: 'message', body: 'must stay queued' }];
      const env = scriptEnv(stub);
      refreshInbox(env, stub);

      const result = await runScript(payload('Stop', { reason }), env);

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(stub.requests.length, 0);
      assert.equal(result.proxyRequest, undefined);
    });
  }

  it('Stop with another or missing reason posts but never reads the inbox', async () => {
    const stub = await startStubBridge();
    stub.inboxPayload.messages = [{ id: '1', ts: 't', from: 'a', type: 'message', body: 'must stay queued' }];
    const env = scriptEnv(stub);
    refreshInbox(env, stub);

    for (const extra of [{ reason: 'something_else' }, {}]) {
      const result = await runScript(payload('Stop', extra), env);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.proxyRequest, undefined);
    }
    assert.equal(posts(stub).length, 2);
  });

  it('invalid JSON or a missing hook_event_name exits 0 silently with nothing sent', async () => {
    const stub = await startStubBridge();
    for (const stdin of ['not-json{{{', '', '42', JSON.stringify({ session_id: NATIVE_SID, cwd: CWD })]) {
      const result = await runScript(stdin, scriptEnv(stub));
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(result.proxyRequest, undefined);
    }
    assert.equal(stub.requests.length, 0);
  });

  it('exits 0 quickly with no output when the bridge is unreachable', async () => {
    const stub = await startStubBridge();
    const env = scriptEnv(stub);
    await stub.close();

    const result = await runScript(payload('SessionStart'), env);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.ok(result.elapsedMs < 9000, `hook took ${result.elapsedMs}ms; budget is 10s`);
  });

  it('falls back to the ~/.ftown/bridge.json pointer when FTOWN_HOOK_PORT is unset', async () => {
    const stub = await startStubBridge();
    const home = tempDir('ftown-grok-home-');
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(join(home, '.ftown', 'bridge.json'), JSON.stringify({ port: stub.port, token: 'file-token' }));
    const env = scriptEnv(stub, { HOME: home, FTOWN_HOOK_PORT: undefined, FTOWN_HOOK_TOKEN: undefined });

    const result = await runScript(payload('SessionStart'), env);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].authorization, 'Bearer file-token');
    assert.deepEqual(JSON.parse(stub.requests[0].body), {
      ftown_session_id: 'ftown-sid-1',
      ftown_session_source: 'env',
      hook_event_name: 'SessionStart',
      session_id: NATIVE_SID,
      cwd: CWD,
    });
  });

  it('delivers via the pointer file when the env port refuses connections', async () => {
    const dead = await startStubBridge();
    const deadPort = dead.port;
    await dead.close();
    const stub = await startStubBridge();
    const home = tempDir('ftown-grok-home-');
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(join(home, '.ftown', 'bridge.json'), JSON.stringify({ port: stub.port, token: 'file-token' }));
    const env = scriptEnv(stub, { HOME: home, FTOWN_HOOK_PORT: String(deadPort), FTOWN_HOOK_TOKEN: 'stale-token' });

    const result = await runScript(payload('UserPromptSubmit'), env);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].authorization, 'Bearer file-token');
    assert.equal((JSON.parse(stub.requests[0].body) as { hook_event_name: string }).hook_event_name, 'UserPromptSubmit');
  });

  it('Stop end_turn posts Stop and stays silent when no ftown CLI exists anywhere', async () => {
    const stub = await startStubBridge();
    stub.inboxPayload.messages = [{ id: '1', ts: 't', from: 'a', type: 'message', body: 'unreachable mail' }];
    const env = scriptEnv(stub);
    refreshInbox(env, stub);
    rmSync(join(env.HOME as string, '.ftown', 'bin', 'ftown'));

    const result = await runScript(payload('Stop', { reason: 'end_turn' }), env);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(posts(stub).length, 1);
    assert.equal((JSON.parse(posts(stub)[0].body) as { hook_event_name: string }).hook_event_name, 'Stop');
    assert.equal(result.proxyRequest, undefined);
  });

  it('delivers a ~2 MB tool_input intact (body is not passed through argv)', async () => {
    const stub = await startStubBridge();
    const big = 'x'.repeat(2 * 1024 * 1024);
    const result = await runScript(
      payload('PreToolUse', { tool_name: 'write', tool_input: { content: big }, tool_use_id: 'call_big' }),
      scriptEnv(stub),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(posts(stub).length, 1);
    const body = JSON.parse(posts(stub)[0].body) as { tool_input: { content: string }; tool_use_id: string };
    assert.equal(body.tool_input.content, big);
    assert.equal(body.tool_use_id, 'call_big');
  });

  it('reads a 5 MB payload quickly', async () => {
    const stub = await startStubBridge();
    const huge = 'y'.repeat(5 * 1024 * 1024);
    const result = await runScript(payload('PostToolUse', { tool_name: 'read', tool_input: { content: huge } }), scriptEnv(stub));

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(posts(stub).length, 1);
    assert.ok(result.elapsedMs < 3000, `5 MB payload took ${result.elapsedMs}ms`);
  });
});
