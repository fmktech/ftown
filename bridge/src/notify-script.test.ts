import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const NOTIFY_SCRIPT = fileURLToPath(new URL('../hooks/notify.sh', import.meta.url));
const SESSION_ID = 'ftown-session-notify-test';
const HOOK_TOKEN = 'notify-test-token';

// Claude-style Stop payload: no hookEventName, so the Grok guard must not apply.
const CLAUDE_STOP_PAYLOAD = {
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'all done',
  session_id: 'claude-session-notify-test',
  cwd: '/tmp/notify-test-project',
  transcript_path: null,
};

// Grok-style Stop payload: Grok sends the camelCase hookEventName alongside snake_case keys.
const GROK_STOP_PAYLOAD = {
  hookEventName: 'stop',
  hook_event_name: 'Stop',
  last_assistant_message: 'all done',
  session_id: 'grok-session-notify-test',
  cwd: '/tmp/notify-test-project',
};

const GROK_NOTIFICATION_PAYLOAD = {
  hookEventName: 'notification',
  hook_event_name: 'Notification',
  notification_type: 'permission_prompt',
  message: 'Grok needs permission',
  session_id: 'grok-session-notify-test',
  cwd: '/tmp/notify-test-project',
};

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface FakeBridge {
  port: number;
  requests: RecordedRequest[];
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdinError: NodeJS.ErrnoException | undefined;
  elapsedMs: number;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'notify-script-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

async function startFakeBridge(): Promise<FakeBridge> {
  const requests: RecordedRequest[] = [];
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake bridge failed to bind');
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));
  return { port: address.port, requests };
}

function runNotify(home: string, env: Record<string, string>, stdin: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    // Environment is built from scratch so a real FTOWN_* bridge in the parent env cannot leak in.
    const child = spawn('/bin/bash', [NOTIFY_SCRIPT], {
      env: { HOME: home, PATH: '/usr/bin:/bin', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdinError: NodeJS.ErrnoException | undefined;
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', (err: NodeJS.ErrnoException) => { stdinError = err; });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (exitCode) => {
      clearTimeout(killTimer);
      resolve({ exitCode, stdout, stderr, stdinError, elapsedMs: Date.now() - started });
    });
    child.stdin.end(stdin);
  });
}

function ftownEnv(port: number): Record<string, string> {
  return {
    FTOWN_HOOK_PORT: String(port),
    FTOWN_SESSION_ID: SESSION_ID,
    FTOWN_HOOK_TOKEN: HOOK_TOKEN,
  };
}

describe('bridge/hooks/notify.sh', () => {
  it('posts the Stop payload with ftown session fields and bearer token when GROK_HOOK_EVENT is unset', async () => {
    const bridge = await startFakeBridge();
    const home = makeHome();

    const result = await runNotify(home, ftownEnv(bridge.port), JSON.stringify(CLAUDE_STOP_PAYLOAD));

    assert.equal(result.exitCode, 0);
    assert.equal(bridge.requests.length, 1);
    const [request] = bridge.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/hook');
    assert.equal(request.authorization, `Bearer ${HOOK_TOKEN}`);
    assert.equal(request.contentType, 'application/json');
    assert.deepEqual(JSON.parse(request.body), {
      ...CLAUDE_STOP_PAYLOAD,
      ftown_session_id: SESSION_ID,
      ftown_session_source: 'env',
    });
  });

  it('exits silently without any network call when GROK_HOOK_EVENT=stop and the payload has hookEventName', async () => {
    const bridge = await startFakeBridge();
    const home = makeHome();

    const result = await runNotify(home, { ...ftownEnv(bridge.port), GROK_HOOK_EVENT: 'stop' }, JSON.stringify(GROK_STOP_PAYLOAD));

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(result.stdinError, undefined);
    assert.deepEqual(bridge.requests, []);
  });

  it('treats an empty GROK_HOOK_EVENT as unset and still posts', async () => {
    const bridge = await startFakeBridge();
    const home = makeHome();

    const result = await runNotify(home, { ...ftownEnv(bridge.port), GROK_HOOK_EVENT: '' }, JSON.stringify(GROK_STOP_PAYLOAD));

    assert.equal(result.exitCode, 0);
    assert.equal(bridge.requests.length, 1);
    assert.equal(bridge.requests[0].authorization, `Bearer ${HOOK_TOKEN}`);
  });

  it('fully consumes a 1 MB Grok stdin without a broken pipe and sends nothing', async () => {
    const bridge = await startFakeBridge();
    const home = makeHome();
    const largePayload = JSON.stringify({
      ...GROK_STOP_PAYLOAD,
      last_assistant_message: 'x'.repeat(1024 * 1024),
    });

    const result = await runNotify(home, { ...ftownEnv(bridge.port), GROK_HOOK_EVENT: 'stop' }, largePayload);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdinError, undefined);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.ok(result.elapsedMs < 5000, `expected prompt exit, took ${result.elapsedMs}ms`);
    assert.deepEqual(bridge.requests, []);
  });

  it('still posts when GROK_HOOK_EVENT=stop is inherited by a Claude-style payload without hookEventName', async () => {
    const bridge = await startFakeBridge();
    const home = makeHome();

    const result = await runNotify(home, { ...ftownEnv(bridge.port), GROK_HOOK_EVENT: 'stop' }, JSON.stringify(CLAUDE_STOP_PAYLOAD));

    assert.equal(result.exitCode, 0);
    assert.equal(bridge.requests.length, 1);
    assert.equal(bridge.requests[0].authorization, `Bearer ${HOOK_TOKEN}`);
    assert.deepEqual(JSON.parse(bridge.requests[0].body), {
      ...CLAUDE_STOP_PAYLOAD,
      ftown_session_id: SESSION_ID,
      ftown_session_source: 'env',
    });
  });

  it('still forwards Grok Notification events when GROK_HOOK_EVENT=notification', async () => {
    const bridge = await startFakeBridge();
    const home = makeHome();

    const result = await runNotify(home, { ...ftownEnv(bridge.port), GROK_HOOK_EVENT: 'notification' }, JSON.stringify(GROK_NOTIFICATION_PAYLOAD));

    assert.equal(result.exitCode, 0);
    assert.equal(bridge.requests.length, 1);
    const body = JSON.parse(bridge.requests[0].body) as Record<string, unknown>;
    assert.equal(body.notification_type, 'permission_prompt');
    assert.equal(body.ftown_session_id, SESSION_ID);
    assert.equal(body.ftown_session_source, 'env');
  });

  it('behaves on invalid JSON under GROK_HOOK_EVENT exactly as it does without the variable', async () => {
    const invalidStdin = '{not json';
    const plainBridge = await startFakeBridge();
    const plain = await runNotify(makeHome(), ftownEnv(plainBridge.port), invalidStdin);
    const grokBridge = await startFakeBridge();
    const grok = await runNotify(makeHome(), { ...ftownEnv(grokBridge.port), GROK_HOOK_EVENT: 'stop' }, invalidStdin);

    assert.equal(grok.exitCode, plain.exitCode);
    assert.equal(grok.stdout, plain.stdout);
    assert.equal(grok.stderr, plain.stderr);
    assert.deepEqual(grokBridge.requests, plainBridge.requests);
  });
});
