import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);

const BUNDLE_DIR = fileURLToPath(new URL('../muse-plugin', import.meta.url));
const SESSION_START_SCRIPT = join(BUNDLE_DIR, 'hooks', 'ftown-session-start.sh');
const STOP_SCRIPT = join(BUNDLE_DIR, 'hooks', 'ftown-stop.sh');

// Stdin shapes copied from /tmp/muse-hook-probe2/fire-baseline.log.
const SESSION_START_STDIN = JSON.stringify({
  hook_event_name: 'SessionStart',
  source: 'startup',
  session_id: '01a0d03f-c337-7b60-92c8-0c4278a7360b',
  cwd: '/private/tmp/muse-hook-probe2/proj',
  transcript_path: null,
  model: 'unknown',
  permission_mode: 'default',
});
const STOP_STDIN = JSON.stringify({
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'echo: say hi',
  session_id: '01a0d03f-c337-7b60-92c8-0c4278a7360b',
  turn_id: 'aff45d96-77d2-4664-9888-0a72114f148e',
  cwd: '/private/tmp/muse-hook-probe2/proj',
  transcript_path: null,
  model: 'unknown',
  permission_mode: 'default',
});

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
      if (req.method === 'GET' && req.url?.includes('/api/sessions/') && req.url.includes('/inbox')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(inboxPayload));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub bridge failed to bind');
  const stub: StubBridge = {
    port: address.port,
    requests,
    inboxPayload,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
  openStubs.push(stub);
  return stub;
}

afterEach(async () => {
  while (openStubs.length > 0) {
    await openStubs.pop()?.close();
  }
});

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runScript(
  script: string,
  stdin: string,
  env: Record<string, string | undefined>,
): Promise<ScriptResult> {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', [script], {
      env: { ...env, PATH: env.PATH ?? '/usr/bin:/bin' },
      input: stdin,
      timeout: 10000,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : String(err),
    };
  }
}

function scriptEnv(stub: StubBridge, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    HOME: mkdtempSync(join(tmpdir(), 'ftown-muse-home-')),
    MUSE_PLUGIN_ROOT: BUNDLE_DIR,
    FTOWN_SESSION_ID: 'ftown-sid-1',
    FTOWN_HOOK_PORT: String(stub.port),
    FTOWN_HOOK_TOKEN: 'test-token',
    ...extra,
  };
}

describe('muse plugin bundle', () => {
  it('declares SessionStart + Stop hooks only, with argv commands and 5s timeouts', () => {
    const manifest = JSON.parse(
      readFileSync(join(BUNDLE_DIR, '.muse-plugin', 'plugin.json'), 'utf8'),
    ) as {
      id: string;
      schemaVersion: number;
      capabilities: { hooks: Array<{ id: string; event: string; command: string[]; timeoutMs: number }> };
    };
    assert.equal(manifest.id, 'ftown');
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(
      manifest.capabilities.hooks.map((hook) => [hook.event, hook.command, hook.timeoutMs]),
      [
        ['SessionStart', ['sh', 'hooks/ftown-session-start.sh'], 5000],
        ['Stop', ['sh', 'hooks/ftown-stop.sh'], 5000],
      ],
    );
    const scripts = manifest.capabilities.hooks.map((hook) => hook.command[1]);
    assert.equal(new Set(scripts).size, scripts.length);
  });

  it('ships unique executable scripts, never symlinks', () => {
    for (const script of [SESSION_START_SCRIPT, STOP_SCRIPT, join(BUNDLE_DIR, 'lib', 'ftown-hook.sh')]) {
      const stat = lstatSync(script);
      assert.equal(stat.isSymbolicLink(), false, `${script} must not be a symlink`);
      assert.equal(stat.isFile(), true);
      assert.ok((stat.mode & 0o111) !== 0, `${script} must be executable`);
    }
  });
});

describe('muse hook scripts', () => {
  it('exit 0 silently when FTOWN_SESSION_ID is unset (no network)', async () => {
    const stub = await startStubBridge();
    for (const [script, stdin] of [[SESSION_START_SCRIPT, SESSION_START_STDIN], [STOP_SCRIPT, STOP_STDIN]] as const) {
      const result = await runScript(script, stdin, scriptEnv(stub, { FTOWN_SESSION_ID: undefined }));
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
    assert.equal(stub.requests.length, 0);
  });

  it('SessionStart posts native session_id + cwd + ftown ids to /hook', async () => {
    const stub = await startStubBridge();
    const result = await runScript(SESSION_START_SCRIPT, SESSION_START_STDIN, scriptEnv(stub));

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
      session_id: '01a0d03f-c337-7b60-92c8-0c4278a7360b',
      cwd: '/private/tmp/muse-hook-probe2/proj',
    });
  });

  it('falls back to the ~/.ftown/bridge.json pointer when env has no port', async () => {
    const stub = await startStubBridge();
    const home = mkdtempSync(join(tmpdir(), 'ftown-muse-home-'));
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(join(home, '.ftown', 'bridge.json'), JSON.stringify({ port: stub.port, token: 'file-token' }));
    const env = scriptEnv(stub, { HOME: home, FTOWN_HOOK_PORT: undefined, FTOWN_HOOK_TOKEN: undefined });

    const result = await runScript(SESSION_START_SCRIPT, SESSION_START_STDIN, env);

    assert.equal(result.exitCode, 0);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].authorization, 'Bearer file-token');
    assert.deepEqual(JSON.parse(stub.requests[0].body), {
      ftown_session_id: 'ftown-sid-1',
      ftown_session_source: 'env',
      hook_event_name: 'SessionStart',
      session_id: '01a0d03f-c337-7b60-92c8-0c4278a7360b',
      cwd: '/private/tmp/muse-hook-probe2/proj',
    });
  });

  it('Stop drains the inbox and emits mail as hookSpecificOutput.additionalContext', async () => {
    const stub = await startStubBridge();
    stub.inboxPayload.messages = [
      { id: '1', ts: '2026-09-23T21:00:00.000Z', from: 'agent-a', fromName: 'Agent A', to: 'me', type: 'message', body: 'hello' },
      { id: '2', ts: '2026-09-23T21:01:00.000Z', from: 'agent-b', to: 'me', type: 'task', body: 'do the thing' },
    ];

    const result = await runScript(STOP_SCRIPT, STOP_STDIN, scriptEnv(stub));

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    const post = stub.requests.find((request) => request.method === 'POST');
    assert.ok(post);
    assert.deepEqual(JSON.parse(post.body), {
      ftown_session_id: 'ftown-sid-1',
      ftown_session_source: 'env',
      hook_event_name: 'Stop',
      session_id: '01a0d03f-c337-7b60-92c8-0c4278a7360b',
      cwd: '/private/tmp/muse-hook-probe2/proj',
    });
    const drain = stub.requests.find((request) => request.method === 'GET');
    assert.ok(drain);
    assert.equal(drain.url, '/api/sessions/ftown-sid-1/inbox?wait=0');
    assert.equal(drain.authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(result.stdout), {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext:
          '[ftown mail]\n' +
          '[2026-09-23T21:00:00.000Z] Agent A (message): hello\n' +
          '[2026-09-23T21:01:00.000Z] agent-b (task): do the thing',
      },
    });
  });

  it('Stop stays silent when the inbox is empty', async () => {
    const stub = await startStubBridge();
    const result = await runScript(STOP_SCRIPT, STOP_STDIN, scriptEnv(stub));

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(stub.requests.filter((request) => request.method === 'POST').length, 1);
    assert.equal(stub.requests.filter((request) => request.method === 'GET').length, 1);
  });

  it('exits 0 fast when the bridge is unreachable', async () => {
    const stub = await startStubBridge();
    const closedPort = stub.port;
    await stub.close();
    openStubs.pop();
    const started = Date.now();
    const result = await runScript(
      STOP_SCRIPT,
      STOP_STDIN,
      scriptEnv(stub, { FTOWN_HOOK_PORT: String(closedPort) }),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.ok(Date.now() - started < 9000, 'hook must respect the 5s budget');
  });

  it('exits 0 when curl/jq are unavailable', async () => {
    const stub = await startStubBridge();
    const binDir = mkdtempSync(join(tmpdir(), 'ftown-muse-bin-'));
    symlinkSync('/bin/sh', join(binDir, 'sh'));
    const result = await runScript(
      SESSION_START_SCRIPT,
      SESSION_START_STDIN,
      scriptEnv(stub, { PATH: binDir }),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(stub.requests.length, 0);
  });

  it('still posts (empty session fields) when stdin is malformed', async () => {
    const stub = await startStubBridge();
    const result = await runScript(SESSION_START_SCRIPT, 'not-json{{{', scriptEnv(stub));

    assert.equal(result.exitCode, 0);
    assert.equal(stub.requests.length, 1);
    assert.deepEqual(JSON.parse(stub.requests[0].body), {
      ftown_session_id: 'ftown-sid-1',
      ftown_session_source: 'env',
      hook_event_name: 'SessionStart',
      session_id: '',
      cwd: '',
    });
  });
});
