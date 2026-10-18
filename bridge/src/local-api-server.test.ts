import { request as httpRequest } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { AttentionStore, AttentionError } from './attention-store.js';
import { MailStore } from './mail-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderAuthMissingError, WorkingDirMissingError } from './create-ftown-session.js';
import {
  LocalApiServer,
  archivedSessionWasResumed,
  providerAuthMissingResponse,
  workingDirMissingResponse,
} from './local-api-server.js';
import { SessionStore } from './session-store.js';
import type { CentrifugoClient } from './centrifugo-client.js';
import type { CreateFtownSessionDeps } from './create-ftown-session.js';
import type { ProcessRunner } from './claude-runner.js';
import type { Session } from './types.js';

async function api(
  port: number,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

describe('LocalApiServer session harness inheritance', () => {
  it('inherits the caller harness when omitted and preserves an explicit override', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ftw-session-harness-api-'));
    const server = new LocalApiServer();
    const token = 'test-token';
    const store = new SessionStore(join(home, 'data'));
    const runs: Array<{ command: string }> = [];
    const runner = {
      getPreferredRuntime: () => 'direct',
      run: (_sessionId: string, command: string) => {
        runs.push({ command });
      },
      stop: () => false,
    } as unknown as ProcessRunner;
    const centrifugo = {
      publishSessionUpdate: async () => {},
    } as unknown as CentrifugoClient;
    const caller: Session = {
      id: 'pi-parent',
      name: 'Pi parent',
      command: 'pi',
      shellType: 'pi',
      status: 'running',
      bridgeId: 'bridge-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await store.saveSession(caller);

    const sessionFactory: CreateFtownSessionDeps = {
      store,
      runner,
      centrifugo,
      userId: 'user-1',
      bridgeId: 'bridge-1',
      hookPort: 4321,
      hookToken: 'hook-token',
      notifyScriptPath: '/tmp/notify.sh',
      wireTerminalInput: () => {},
    };
    server.setAuthToken(token);
    server.setDependencies(store, runner, centrifugo, 'user-1');
    server.setSessionFactory(sessionFactory);

    const port = await server.start();
    try {
      const inherited = await api(
        port,
        token,
        'POST',
        '/api/sessions',
        { prompt: 'Use my harness', parentSessionId: true },
        { 'X-Ftown-Session-Id': caller.id },
      );
      assert.strictEqual(inherited.status, 201);
      assert.strictEqual((inherited.data.session as Session).shellType, 'pi');
      assert.strictEqual((inherited.data.session as Session).parentSessionId, caller.id);

      const explicit = await api(
        port,
        token,
        'POST',
        '/api/sessions',
        { shellType: 'claude', prompt: 'Use Claude', parentSessionId: true },
        { 'X-Ftown-Session-Id': caller.id },
      );
      assert.strictEqual(explicit.status, 201);
      assert.strictEqual((explicit.data.session as Session).shellType, 'claude');
      assert.match(runs[0].command, /pi/);
      assert.match(runs[1].command, /claude/);
    } finally {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// A blocked provider create/revive must surface as a 422 carrying the provider,
// the env-var KEY-bearing message, and the `ftown env set` fix — and NEVER the
// secret token itself. providerAuthMissingResponse builds that body once so both
// the create and revive catch branches stay identical.
describe('providerAuthMissingResponse', () => {
  it('maps a ProviderAuthMissingError to a 422 with {error, provider, fix}', () => {
    const err = new ProviderAuthMissingError('zai', 'ZAI_API_TOKEN', 'ftown env set zai <token>');
    const response = providerAuthMissingResponse(err);

    assert.strictEqual(response.status, 422);
    assert.strictEqual(response.body.error, err.message);
    assert.strictEqual(response.body.provider, 'zai');
    assert.strictEqual(response.body.fix, 'ftown env set zai <token>');
  });

  it('carries only the env-var KEY and fix, never a token value', () => {
    const secret = 'sk-super-secret-token-value-1234';
    const err = new ProviderAuthMissingError('kimi', 'KIMI_API_TOKEN', 'ftown env set kimi <token>');
    const response = providerAuthMissingResponse(err);

    const serialized = JSON.stringify(response.body);
    assert.ok(serialized.includes('KIMI_API_TOKEN'), 'body should name the env-var KEY');
    assert.ok(!serialized.includes(secret), 'body must not contain any token value');
    assert.strictEqual(response.body.provider, 'kimi');
    assert.strictEqual(response.body.fix, 'ftown env set kimi <token>');
  });

  it('echoes the provider flavor verbatim for each mapped flavor', () => {
    for (const provider of ['zai', 'fireworks', 'kimi', 'deepseek']) {
      const err = new ProviderAuthMissingError(
        provider,
        `${provider.toUpperCase()}_API_TOKEN`,
        `ftown env set ${provider} <token>`,
      );
      const response = providerAuthMissingResponse(err);
      assert.strictEqual(response.status, 422);
      assert.strictEqual(response.body.provider, provider);
      assert.strictEqual(response.body.fix, `ftown env set ${provider} <token>`);
    }
  });
});

describe('workingDirMissingResponse', () => {
  it('maps a WorkingDirMissingError to a 422 with a createable code and path', () => {
    const err = new WorkingDirMissingError('/tmp/missing-project');
    const response = workingDirMissingResponse(err);

    assert.strictEqual(response.status, 422);
    assert.strictEqual(response.body.error, err.message);
    assert.strictEqual(response.body.code, 'working_dir_missing');
    assert.strictEqual(response.body.workingDir, '/tmp/missing-project');
    assert.strictEqual(response.body.canCreate, true);
  });
});

describe('archivedSessionWasResumed', () => {
  it('reports Pi workdir/native continuation as resumed, but not a custom command', () => {
    const piSession = { shellType: 'pi' as const };

    assert.equal(archivedSessionWasResumed(piSession, false), true);
    assert.equal(archivedSessionWasResumed(piSession, true), false);
  });
});

describe('LocalApiServer session parent route', () => {
  it('moves and detaches a session through PATCH without allowing a parent cycle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ftw-session-parent-api-'));
    const server = new LocalApiServer();
    const token = 'test-token';
    const store = new SessionStore(join(home, 'data'));
    const published: Session[] = [];
    const runner = { stop: () => false } as unknown as ProcessRunner;
    const centrifugo = {
      publishSessionUpdate: async (_userId: string, session: Session) => {
        published.push(session);
      },
    } as unknown as CentrifugoClient;

    const makeSession = (id: string, parentSessionId?: string): Session => ({
      id,
      name: id,
      command: 'claude',
      status: 'running',
      bridgeId: 'bridge-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      parentSessionId,
    });

    await store.saveSession(makeSession('parent-a'));
    await store.saveSession(makeSession('parent-b'));
    await store.saveSession(makeSession('child', 'parent-a'));
    await store.saveSession({ ...makeSession('foreign-parent'), bridgeId: 'bridge-2' });
    server.setAuthToken(token);
    server.setDependencies(store, runner, centrifugo, 'user-1');

    const port = await server.start();
    try {
      const response = await api(port, token, 'PATCH', '/api/sessions/child', {
        parentSessionId: 'parent-b',
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual((response.data.session as Session).parentSessionId, 'parent-b');
      assert.strictEqual((await store.loadSession('child'))?.parentSessionId, 'parent-b');
      assert.strictEqual(published.at(-1)?.parentSessionId, 'parent-b');

      const cycle = await api(port, token, 'PATCH', '/api/sessions/parent-b', {
        parentSessionId: 'child',
      });
      assert.strictEqual(cycle.status, 400);
      assert.strictEqual(cycle.data.error, 'Session cannot be parented under its own descendant');

      const detached = await api(port, token, 'PATCH', '/api/sessions/child', {
        parentSessionId: null,
      });
      assert.strictEqual(detached.status, 200);
      assert.strictEqual((detached.data.session as Session).parentSessionId, undefined);
      assert.strictEqual((await store.loadSession('child'))?.parentSessionId, undefined);
      assert.strictEqual(published.at(-1)?.parentSessionId, undefined);

      const crossBridge = await api(port, token, 'PATCH', '/api/sessions/child', {
        parentSessionId: 'foreign-parent',
      });
      assert.strictEqual(crossBridge.status, 400);
      assert.strictEqual(crossBridge.data.error, 'Parent session belongs to another bridge');
    } finally {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('LocalApiServer durable attention ingress', () => {
  it('persists before hook success/publication and rejects workspace/unknown attribution', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ftw-attention-api-'));
    const store = new SessionStore(join(home, 'data'));
    const server = new LocalApiServer();
    const token = 'attention-hook-token';
    const sample: Session = { id: 'attention-session', name: 'Attention worker', command: 'test', status: 'running', bridgeId: 'machine-a', createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z' };
    await store.saveSession(sample);
    const attention = new AttentionStore((id) => store.sessionDir(id));
    server.setAuthToken(token);
    server.setDependencies(store, {} as ProcessRunner, {} as CentrifugoClient, 'user-a');
    server.setAttentionStore(attention);
    let published = 0;
    server.on('event', () => {
      published++;
      assert.match(readFileSync(join(store.sessionDir(sample.id), 'attention.json'), 'utf8'), /Question one/);
    });
    const port = await server.start();
    try {
      const payload = { ftown_session_id: sample.id, ftown_session_source: 'env', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Question one', env: { KEY: 'never-forward' } };
      assert.equal((await api(port, 'wrong', 'POST', '/hook', payload)).status, 401);
      assert.equal((await api(port, token, 'POST', '/hook', payload)).status, 200);
      assert.equal(published, 1);
      const read = await api(port, token, 'GET', `/api/sessions/${sample.id}/attention`);
      assert.equal(read.status, 200);
      assert.ok(!JSON.stringify(read.data).includes('never-forward'));
      const events = read.data.events as { id: string; acknowledgedAt?: string }[];
      assert.equal(events.length, 1);
      assert.equal((await api(port, token, 'POST', '/hook', { ...payload, message: 'workspace question', ftown_session_source: 'workspace' })).status, 200);
      assert.equal((await attention.list(sample.id)).events.length, 1);
      assert.equal((await api(port, token, 'POST', '/hook', { ...payload, ftown_session_id: 'missing' })).status, 200);
      assert.equal(existsSync(store.sessionDir('missing')), false);
      assert.equal((await api(port, token, 'GET', '/api/sessions/missing/attention')).status, 404);
      assert.equal((await api(port, token, 'POST', `/api/sessions/${sample.id}/attention/ack`, { eventIds: [events[0].id, 'unknown'] })).status, 400);
      assert.equal((await attention.list(sample.id)).events[0].acknowledgedAt, undefined);
      const ack = await api(port, token, 'POST', `/api/sessions/${sample.id}/attention/ack`, { eventIds: [events[0].id] });
      assert.equal(ack.status, 200);
      const resolved = await api(port, token, 'POST', `/api/sessions/${sample.id}/attention/resolve`, { eventIds: [events[0].id] });
      assert.equal(resolved.status, 200);
      assert.equal((await attention.list(sample.id)).events.length, 0);
      await store.deleteSession(sample.id);
      assert.equal(existsSync(join(store.sessionDir(sample.id), 'attention.json')), false);
      assert.equal((await api(port, token, 'GET', `/api/sessions/${sample.id}/attention`)).status, 404);
    } finally { server.getHttpServer()?.closeAllConnections(); server.stop(); rmSync(home, { recursive: true, force: true }); }
  });

  it('storage failures fail the hook before success or publication', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ftw-attention-failure-'));
    const store = new SessionStore(join(home, 'data'));
    const server = new LocalApiServer();
    await store.saveSession({ id: 's', name: 'S', command: 'test', status: 'running', bridgeId: 'machine-a', createdAt: '', updatedAt: '' });
    class BrokenStore extends AttentionStore { override async record(): Promise<void> { throw new AttentionError('attention_storage_error', 'Attention history could not be persisted', 500); } }
    server.setDependencies(store, {} as ProcessRunner, {} as CentrifugoClient, 'user-a');
    server.setAttentionStore(new BrokenStore((id) => store.sessionDir(id)));
    server.setAuthToken('token');
    let published = false; server.on('event', () => { published = true; });
    const port = await server.start();
    try {
      const response = await api(port, 'token', 'POST', '/hook', { ftown_session_id: 's', hook_event_name: 'Notification', notification_type: 'permission_prompt' });
      assert.equal(response.status, 500); assert.equal(published, false);
      assert.equal(response.data.code, 'attention_storage_error');
    } finally { server.getHttpServer()?.closeAllConnections(); server.stop(); rmSync(home, { recursive: true, force: true }); }
  });
});

// Run by the main assistant with the other listener-backed tests.
describe('retired automation HTTP compatibility', () => {
  it('authenticates first and rejects every legacy subtree method before readiness, body parsing or storage', async () => {
    const server = new LocalApiServer();
    server.setAuthToken('retirement-token');
    const port = await server.start();
    try {
      assert.equal((await api(port, 'wrong', 'GET', '/api/loops')).status, 401);
      const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port, path: '/api/loops',
          headers: { Host: `foreign.example:${port}`, Authorization: 'Bearer retirement-token' } },
        (response) => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject); request.end();
      });
      assert.equal(hostileHostStatus, 421);
      for (const path of ['/api/loops', '/api/loops/', '/api/loops/id', '/api/loops/id/run-now', '/api/loops/id/runs', '/api/loops/unknown/nested']) {
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
          const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method, headers: { Authorization: 'Bearer retirement-token', 'Content-Type': 'application/json' },
            ...(method === 'POST' || method === 'PATCH' ? { body: '{malformed' } : {}),
          });
          assert.equal(response.status, 410, `${method} ${path}`);
          assert.deepEqual(await response.json(), { code: 'automation_removed',
            error: 'Recurring loops and factory automation have been removed' });
        }
      }
      assert.equal((await api(port, 'retirement-token', 'GET', '/api/loops-other')).status, 503);
    } finally { server.stop(); }
  });

  it('preserves history and archive provenance while rejecting retry and revive', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ftw-retired-api-'));
    const server = new LocalApiServer();
    const store = new SessionStore(join(home, 'data'));
    const record = { id: 'old-run', name: 'run', command: 'dispatch', status: 'error', bridgeId: 'bridge',
      loopId: 'old-loop', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as Session;
    await store.saveSession(record); await store.appendTerminalData(record.id, 'preserved output');
    await store.archiveSession(record);
    const archiveBefore = readFileSync(join(home, 'data', 'archive.jsonl'), 'utf8');
    const runner = { run: () => { throw new Error('must not launch'); }, stop: () => false } as unknown as ProcessRunner;
    const centrifugo = { publishSessionUpdate: async () => {} } as unknown as CentrifugoClient;
    server.setAuthToken('token'); server.setDependencies(store, runner, centrifugo, 'user');
    server.setSessionFactory({ store, runner, centrifugo, userId: 'user', bridgeId: 'bridge',
      hookPort: 0, hookToken: 'token', notifyScriptPath: '', wireTerminalInput: () => {} });
    const port = await server.start();
    try {
      for (const action of ['retry', 'revive']) {
        const response = await api(port, 'token', 'POST', `/api/sessions/old-run/${action}`);
        assert.equal(response.status, 410);
        assert.equal(response.data.code, 'automation_removed');
      }
      const history = await api(port, 'token', 'GET', '/api/sessions/old-run');
      assert.equal((history.data.session as Session).loopId, 'old-loop');
      assert.equal(await store.loadTerminalLog(record.id), 'preserved output');
      assert.equal(readFileSync(join(home, 'data', 'archive.jsonl'), 'utf8'), archiveBefore);
      assert.deepEqual(await store.loadSession(record.id), record);
    } finally { server.stop(); rmSync(home, { recursive: true, force: true }); }
  });
});


// Root executes listener-backed tests; implementation workers only author them.
describe('LocalApiServer native wake heartbeats', () => {
  it('authenticates peeks, validates native identity/harness/runtime and never drains inboxes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ftown-native-heartbeat-'));
    const store = new SessionStore(join(home, 'data')); const server = new LocalApiServer();
    const running = new Set(['claude', 'opencode', 'alias']);
    const runner = { isRunning: (id: string) => running.has(id) } as unknown as ProcessRunner;
    const base = { command: 'test', status: 'running' as const, bridgeId: 'machine', createdAt: '', updatedAt: '' };
    for (const session of [
      { ...base, id: 'claude', name: 'Claude', shellType: 'claude' as const, claudeSessionId: 'native-claude' },
      { ...base, id: 'opencode', name: 'OpenCode', shellType: 'opencode' as const, opencodeSessionId: 'ses_native' },
      { ...base, id: 'alias', name: 'Alias', shellType: 'fireworks' as const, claudeSessionId: 'native-alias' },
    ]) await store.saveSession(session);
    const mail = new MailStore(id => store.sessionDir(id));
    server.setAuthToken('token'); server.setDependencies(store, runner, {} as CentrifugoClient, 'user'); server.setMailStore(mail);
    const port = await server.start();
    const query = (adapter: string, id: string) => `?peek=1&wait=0&adapter=${adapter}&nativeSessionId=${id}`;
    try {
      await api(port, 'token', 'POST', '/api/sessions/claude/inbox', { body: 'still unread' });
      assert.equal((await api(port, 'wrong', 'GET', '/api/sessions/claude/inbox' + query('claude-mod', 'native-claude'))).status, 401);
      assert.equal((await api(port, 'token', 'GET', '/api/sessions/claude/inbox?adapter=claude-mod')).status, 400);
      assert.equal((await api(port, 'token', 'GET', '/api/sessions/claude/inbox?peek=0&wait=0&adapter=claude-mod&nativeSessionId=native-claude')).status, 400);
      assert.equal((await api(port, 'token', 'GET', '/api/sessions/claude/inbox' + query('opencode', 'native-claude'))).status, 409);
      assert.equal((await api(port, 'token', 'GET', '/api/sessions/claude/inbox' + query('claude-mod', 'wrong'))).status, 409);
      assert.equal((await api(port, 'token', 'GET', '/api/sessions/opencode/inbox' + query('opencode', 'ses_native'))).status, 200);
      assert.equal((await api(port, 'token', 'GET', '/api/sessions/alias/inbox' + query('claude-mod', 'native-alias'))).status, 200);
      const peek = await api(port, 'token', 'GET', '/api/sessions/claude/inbox' + query('claude-mod', 'native-claude'));
      assert.equal(peek.status, 200); assert.equal((peek.data.messages as unknown[]).length, 1);
      assert.equal((await mail.listUndelivered('claude')).length, 1);
      running.delete('claude');
      assert.equal((await api(port, 'token', 'GET', '/api/sessions/claude/inbox' + query('claude-mod', 'native-claude'))).status, 409);
      assert.equal((await mail.listUndelivered('claude')).length, 1);
      const ordinary = await api(port, 'token', 'GET', '/api/sessions/claude/inbox?peek=1');
      assert.equal(ordinary.status, 200); assert.equal((ordinary.data.messages as unknown[]).length, 1);
    } finally { server.getHttpServer()?.closeAllConnections(); server.stop(); rmSync(home, { recursive: true, force: true }); }
  });
});
