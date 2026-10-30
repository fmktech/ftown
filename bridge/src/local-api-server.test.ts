import { request as httpRequest } from 'node:http';
import { loadOrCreateIdentity } from './security/bridge/identity.js';
import { BridgeSecurityService } from './security/bridge/security.js';
import { apiResponse } from './cli-client.js';
import type { BridgePointer } from './wire-types.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MailDeliveryService } from './mail-delivery.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { AttentionStore, AttentionError } from './attention-store.js';
import type { AttentionItem } from './attention-events.js';
import type { HookEvent } from './local-api-server.js';
import { MailStore } from './mail-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderAuthMissingError, WorkingDirMissingError } from './create-ftown-session.js';
import {
  LocalApiServer as BaseLocalApiServer,
  archivedSessionWasResumed,
  providerAuthMissingResponse,
  workingDirMissingResponse,
} from './local-api-server.js';
import { SessionStore } from './session-store.js';
import { SessionController } from './session-controller.js';
import { PreviewChatStore } from './preview-chat.js';
import type { CentrifugoClient } from './centrifugo-client.js';
import type { CreateFtownSessionDeps } from './create-ftown-session.js';
import type { ProcessRunner } from './claude-runner.js';
import type { Session } from './types.js';

// Tests exercise the real encrypted adapter. Raw requests remain raw in explicit boundary tests.
const secureFixtures = new Map<number, { pointer: BridgePointer; token: string }>();
class LocalApiServer extends BaseLocalApiServer {
  private testToken = '';
  private testPort = 0;
  private testSecurity?: BridgeSecurityService;
  private testDirectory?: string;
  override setAuthToken(token: string): void { this.testToken = token; super.setAuthToken(token); }
  override async start(preferred = 0): Promise<number> {
    const ownerId = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
    const dataDir = mkdtempSync(join(tmpdir(), 'ftown-secure-api-fixture-')); this.testDirectory = dataDir;
    const identity = await loadOrCreateIdentity(dataDir, ownerId, 'bridge');
    const client = await loadOrCreateIdentity(dataDir, ownerId, 'local-cli');
    const security = new BridgeSecurityService(identity, 'bridge-1', dataDir, { relayUserId: 'user-1' }); this.testSecurity = security;
    await security.policy.provisionLocalEndpoint(client.endpoint);
    this.setSecurity(security, { protocolVersion: 1, ownerId, bridgeId: 'bridge-1', endpoint: identity.endpoint, relayUserId: 'user-1' }, async () => null);
    const port = await super.start(preferred); this.testPort = port;
    secureFixtures.set(port, { token: this.testToken, pointer: { port, token: this.testToken, dataDir, ownerId, endpoint: identity.endpoint, bridgeId: 'bridge-1' } });
    return port;
  }
  override stop(): void {
    secureFixtures.delete(this.testPort); super.stop();
    const dir = this.testDirectory;
    void this.testSecurity?.close().finally(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  }
}

describe('LocalApiServer mail recovery wiring (no HTTP listener)', () => {
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  const session = (id: string): Session => ({ id, name: id, command: 'fake', shellType: 'grok',
    status: 'running', bridgeId: 'bridge', createdAt: '', updatedAt: '' });
  function fixture() {
    const server = new LocalApiServer();
    const calls: string[] = [];
    const mail = new MailDeliveryService();
    mail.recoverPendingMail = async id => { calls.push(id); };
    (server as unknown as { mail: MailDeliveryService }).mail = mail;
    const runner = Object.assign(new EventEmitter(), { isRunning: () => true }) as unknown as ProcessRunner;
    const store = { listSessions: async () => [session('attached')] } as unknown as SessionStore;
    const mailStore = {} as MailStore;
    const centrifugo = {} as CentrifugoClient;
    return { server, calls, runner, store, mailStore, centrifugo, mail };
  }

  for (const order of ['dependencies-first', 'mail-first'] as const) {
    it(`runs one initial pass only after all dependencies (${order})`, async () => {
      const { server, calls, runner, store, mailStore, centrifugo } = fixture();
      if (order === 'dependencies-first') server.setDependencies(store, runner, centrifugo, 'user');
      else server.setMailStore(mailStore);
      await flush(); assert.deepEqual(calls, []);
      if (order === 'dependencies-first') server.setMailStore(mailStore);
      else server.setDependencies(store, runner, centrifugo, 'user');
      await flush(); assert.deepEqual(calls, ['attached']);
      server.setDependencies(store, runner, centrifugo, 'user');
      server.setMailStore(mailStore);
      await flush(); assert.deepEqual(calls, ['attached']);
      assert.equal(runner.listenerCount('ready'), 1);
      runner.emit('ready', 'retried'); await flush();
      assert.deepEqual(calls, ['attached', 'retried']);
      server.stop();
      assert.equal(runner.listenerCount('ready'), 0);
      runner.emit('ready', 'stopped'); await flush();
      assert.deepEqual(calls, ['attached', 'retried']);
    });
  }

  it('unbinds the old runner and fences an awaited initial listing on replacement/stop', async () => {
    const { server, calls, runner, store, mailStore, centrifugo } = fixture();
    let finish!: (sessions: Session[]) => void;
    store.listSessions = () => new Promise(resolve => { finish = resolve; });
    server.setDependencies(store, runner, centrifugo, 'user'); server.setMailStore(mailStore);
    const nextRunner = Object.assign(new EventEmitter(), { isRunning: () => true }) as unknown as ProcessRunner;
    const nextStore = { listSessions: async () => [session('new')] } as unknown as SessionStore;
    server.setDependencies(nextStore, nextRunner, centrifugo, 'user');
    assert.equal(runner.listenerCount('ready'), 0);
    assert.equal(nextRunner.listenerCount('ready'), 1);
    finish([session('stale')]); runner.emit('ready', 'old');
    await flush(); assert.deepEqual(calls, ['new']);
    let stoppedFinish!: (sessions: Session[]) => void;
    nextStore.listSessions = () => new Promise(resolve => { stoppedFinish = resolve; });
    server.setMailStore({} as MailStore);
    server.stop(); stoppedFinish([session('after-stop')]);
    await flush(); assert.deepEqual(calls, ['new']);
    assert.equal(nextRunner.listenerCount('ready'), 0);
  });

  it('isolates one corrupt inbox and skips nonrunning receivers in the initial pass', async () => {
    const { server, calls, runner, store, mailStore, centrifugo, mail } = fixture();
    store.listSessions = async () => [session('broken'), { ...session('stopped'), status: 'completed' }, session('healthy')];
    mail.recoverPendingMail = async id => { if (id === 'broken') throw new Error('expected corrupt inbox'); calls.push(id); };
    server.setDependencies(store, runner, centrifugo, 'user'); server.setMailStore(mailStore);
    await flush(); assert.deepEqual(calls, ['healthy']);
    server.stop();
  });
});

async function api(
  port: number,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const secure = secureFixtures.get(port);
  if (path.startsWith('/api/') && secure && token === secure.token && !Object.keys(extraHeaders ?? {}).some(key => key.toLowerCase() === 'origin')) {
    const normalized = Object.fromEntries(Object.entries(extraHeaders ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const response = await apiResponse(secure.pointer, method, path, body, normalized);
    return { status: response.status, data: response.body as Record<string, unknown> };
  }
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
    class BrokenStore extends AttentionStore { override async record(): Promise<undefined> { throw new AttentionError('attention_storage_error', 'Attention history could not be persisted', 500); } }
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

async function sessionToolsFixture(t: { after: (fn: () => void) => void }, withAttention = true) {
  const home = mkdtempSync(join(tmpdir(), 'ftown-session-tools-'));
  const store = new SessionStore(join(home, 'data'));
  const server = new LocalApiServer();
  const token = 'session-tools-token';
  const pushes: string[] = [];
  const published: Session[] = [];
  const events: HookEvent[] = [];
  const sample: Session = { id: 'tools-session', name: 'Tools worker', command: 'test', status: 'running',
    bridgeId: 'machine-a', createdAt: '2026-10-23T12:00:00Z', updatedAt: '2026-10-23T12:00:00Z' };
  await store.saveSession(sample);
  const attention = new AttentionStore((id) => store.sessionDir(id), 500, (_id, event) => { pushes.push(event.eventKey); });
  server.setAuthToken(token);
  server.setDependencies(store, { stop: () => false } as unknown as ProcessRunner, {
    publishSessionUpdate: async (_user: string, session: Session) => { published.push({ ...session }); },
  } as unknown as CentrifugoClient, 'user-a');
  if (withAttention) server.setAttentionStore(attention);
  server.on('event', (event) => {
    // A live notification must refer to an already committed exact record.
    const ledger = JSON.parse(readFileSync(join(store.sessionDir(event.sessionId), 'attention.json'), 'utf8')) as { events: AttentionItem[] };
    if (event.data.attentionId) assert.ok(ledger.events.some((item) => item.id === event.data.attentionId));
    events.push(event);
  });
  const port = await server.start();
  t.after(() => { attention.stopNotifications(); server.getHttpServer()?.closeAllConnections(); server.stop(); rmSync(home, { recursive: true, force: true }); });
  return { store, server, token, sample, attention, port, events, pushes, published };
}

describe('LocalApiServer explicit session attention and PR metadata', () => {
  it('routes encrypted preview chat requests through the shared controller', async t => {
    const f = await sessionToolsFixture(t); await f.store.saveSession({ ...f.sample, shellType: 'codex' });
    let count = 0;
    f.server.setSessionController(new SessionController({ store: f.store, runner: { stop: () => false }, previewChat: new PreviewChatStore(id => f.store.sessionDir(id)),
      previewChatBridgeId: 'machine-a', previewChatRunning: () => true, enqueuePreviewChat: async () => { count++; return { ok: true, id: 'mail' }; },
      publishSessionUpdate: async () => {}, removeSession: async () => null }));
    const root = `/api/sessions/${f.sample.id}/preview-chat`; const id = '12345678-1234-4234-8234-123456789abc';
    const one = await api(f.port, f.token, 'POST', `${root}/send`, { id, text: 'hello\nworld' });
    assert.equal(one.status, 200); assert.equal((one.data.turn as { delivery: string }).delivery, 'queued');
    assert.equal((await api(f.port, f.token, 'POST', `${root}/send`, { id, text: 'hello\nworld' })).status, 200); assert.equal(count, 1);
    assert.equal((await api(f.port, f.token, 'POST', `${root}/send`, { id, text: 'different' })).status, 409);
    assert.equal((await api(f.port, f.token, 'POST', `${root}/reply`, { id: '12345678-1234-4234-8234-123456789abd', text: 'reply' })).status, 200);
    const page = await api(f.port, f.token, 'GET', root); assert.equal(page.status, 200); assert.equal((page.data.turns as unknown[]).length, 2);
    assert.equal((await api(f.port, f.token, 'GET', `${root}?cursor=other%3A0`)).status, 400);
  });
  it('stamps native notifications with committed identity and ignores caller-supplied ledger metadata', async t => {
    const f = await sessionToolsFixture(t);
    const response = await api(f.port, f.token, 'POST', '/hook', { ftown_session_id: f.sample.id, hook_event_name: 'Notification',
      notification_type: 'agent_needs_input', notification_id: 'harness-source', message: 'Native request',
      attentionId: 'forged', attentionSequence: 999, attentionCreatedAt: 'forged' });
    assert.equal(response.status, 200);
    const item = (await f.attention.list(f.sample.id)).events[0];
    assert.equal(f.events[0].data.attentionId, item.id);
    assert.equal(f.events[0].data.attentionSequence, item.sequence);
    assert.equal(f.events[0].data.attentionCreatedAt, item.createdAt);
    assert.notEqual(item.id, 'harness-source');
    assert.notEqual(item.id, 'forged');
  });
  it('returns exact committed sanitized attention events, deduplicates pushes and allows recurrence', async (t) => {
    const f = await sessionToolsFixture(t);
    const path = `/api/sessions/${f.sample.id}/attention`;
    const capabilities = await api(f.port, f.token, 'GET', `/api/sessions/${f.sample.id}`);
    assert.deepEqual(capabilities.data.capabilities, { attention: { version: 1, request: true }, sessionMetadata: { pullRequest: true, preview: true } });
    const body = { title: '  Review requested  ', message: '\x1b[31mApprove API_KEY=secret-value before proceeding\x1b[0m' };
    const first = await api(f.port, f.token, 'POST', path, body);
    assert.equal(first.status, 200);
    const event = first.data.event as AttentionItem;
    assert.equal(event.title, 'Review requested');
    assert.equal(event.message, 'Approve API_KEY=[redacted] before proceeding');
    assert.equal(event.type, 'agent_needs_input');
    assert.deepEqual(f.events[0], { sessionId: f.sample.id, eventName: 'Notification', source: 'api', data: {
      notification_type: 'agent_needs_input', title: event.title, message: event.message, notification_id: event.id,
      attentionId: event.id, attentionSequence: event.sequence, attentionCreatedAt: event.createdAt,
    } });
    const duplicate = await api(f.port, f.token, 'POST', path, body);
    assert.equal((duplicate.data.event as AttentionItem).id, event.id);
    assert.equal((duplicate.data.event as AttentionItem).occurrences, 2);
    assert.equal(f.pushes.length, 1);
    assert.equal(f.events.length, 2, 'the live per-session notice may repeat');
    const requests = await Promise.all([
      api(f.port, f.token, 'POST', path, { message: 'First concurrent question' }),
      api(f.port, f.token, 'POST', path, { message: 'Second concurrent question' }),
    ]);
    assert.ok(requests.every((response) => response.status === 200));
    assert.deepEqual(requests.map((response) => (response.data.event as AttentionItem).message), ['First concurrent question', 'Second concurrent question']);
    assert.equal((requests[0].data.event as AttentionItem).title, 'Session needs your input');
    assert.notEqual((requests[0].data.event as AttentionItem).id, (requests[1].data.event as AttentionItem).id);
    const reloaded = new AttentionStore((id) => f.store.sessionDir(id));
    assert.equal((await reloaded.list(f.sample.id)).events.length, 3);
    const resolved = await api(f.port, f.token, 'POST', `${path}/resolve`, { eventIds: [event.id] });
    assert.equal(resolved.status, 200);
    const recurring = await api(f.port, f.token, 'POST', path, body);
    assert.notEqual((recurring.data.event as AttentionItem).id, event.id);
    assert.equal(f.pushes.length, 4);
  });

  it('rejects invalid input, inactive/unknown targets and unauthorized requests before recording', async (t) => {
    const f = await sessionToolsFixture(t);
    const path = `/api/sessions/${f.sample.id}/attention`;
    for (const body of [null, [], {}, { message: '' }, { message: '  ' }, { message: 4 },
      { message: 'x'.repeat(2001) }, { message: 'valid', title: '' }, { message: 'valid', title: false },
      { message: 'valid', title: 'x'.repeat(201) }, { message: '\x1b[31m\x1b[0m' },
      { message: 'valid', title: '\x1b[31m\x1b[0m' }, { message: 'valid', arbitrary: 'secret' }]) {
      assert.equal((await api(f.port, f.token, 'POST', path, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await api(f.port, 'wrong', 'POST', path, { message: 'valid' })).status, 426);
    assert.equal((await api(f.port, f.token, 'POST', path, { message: 'valid' }, { Origin: 'https://evil.test' })).status, 426);
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: f.port, path, method: 'POST',
        headers: { Host: `foreign.example:${f.port}`, Authorization: `Bearer ${f.token}` } },
      (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(hostileHostStatus, 421);
    const missing = await api(f.port, f.token, 'POST', '/api/sessions/missing/attention', { message: 'valid' });
    assert.equal(missing.status, 404); assert.equal(missing.data.code, 'unknown_session');
    for (const status of ['completed', 'error'] as const) {
      await f.store.saveSession({ ...f.sample, status });
      const inactive = await api(f.port, f.token, 'POST', path, { message: 'valid' });
      assert.equal(inactive.status, 409); assert.equal(inactive.data.code, 'session_not_active');
    }
    assert.equal(f.events.length, 0); assert.equal(f.pushes.length, 0);
    assert.equal(existsSync(join(f.store.sessionDir(f.sample.id), 'attention.json')), false);
    await f.store.saveSession({ ...f.sample, status: 'pending' });
    assert.equal((await api(f.port, f.token, 'POST', path, { message: 'Pending session request' })).status, 200);
    assert.equal(f.events.length, 1);
  });

  it('reports optional attention readiness and storage failure without publishing success', async (t) => {
    const f = await sessionToolsFixture(t, false);
    const path = `/api/sessions/${f.sample.id}/attention`;
    const capabilities = await api(f.port, f.token, 'GET', `/api/sessions/${f.sample.id}`);
    assert.deepEqual(capabilities.data.capabilities, { sessionMetadata: { pullRequest: true, preview: true } });
    const unavailable = await api(f.port, f.token, 'POST', path, { message: 'valid' });
    assert.equal(unavailable.status, 503); assert.equal(unavailable.data.code, 'attention_not_ready');
    class BrokenStore extends AttentionStore {
      override async record(): Promise<undefined> { throw new AttentionError('attention_storage_error', 'Attention history could not be persisted', 500); }
    }
    f.server.setAttentionStore(new BrokenStore((id) => f.store.sessionDir(id)));
    const failure = await api(f.port, f.token, 'POST', path, { message: 'valid' });
    assert.equal(failure.status, 500); assert.equal(failure.data.code, 'attention_storage_error');
    assert.equal(f.events.length, 0); assert.equal(f.pushes.length, 0);
    assert.equal(existsSync(join(f.store.sessionDir(f.sample.id), 'attention.json')), false);
  });

  it('attaches, replaces, reloads and clears PR metadata through the existing PATCH path', async (t) => {
    const f = await sessionToolsFixture(t);
    const path = `/api/sessions/${f.sample.id}`;
    const attached = await api(f.port, f.token, 'PATCH', path, { pullRequestUrl: ' https://github.com/fmktech/ftown/pull/128/?tab=files#review ' });
    assert.equal(attached.status, 200);
    assert.equal((attached.data.session as Session).pullRequestUrl, 'https://github.com/fmktech/ftown/pull/128');
    assert.equal(f.published.at(-1)?.pullRequestUrl, 'https://github.com/fmktech/ftown/pull/128');
    assert.equal((await new SessionStore(join(f.store.sessionDir(f.sample.id), '../..')).loadSession(f.sample.id))?.pullRequestUrl, 'https://github.com/fmktech/ftown/pull/128');
    const before = await f.store.loadSession(f.sample.id);
    for (const body of [
      { name: 'must not change', pullRequestUrl: 'https://evil.test/owner/repo/pull/1' },
      { pullRequestUrl: '' }, { pullRequestUrl: 7 },
      { name: 'must not change', parentSessionId: 'missing', pullRequestUrl: 'https://github.com/owner/repo/pull/2' },
    ]) assert.equal((await api(f.port, f.token, 'PATCH', path, body)).status, 400);
    assert.deepEqual(await f.store.loadSession(f.sample.id), before);
    assert.equal(f.published.length, 1);
    assert.equal((await api(f.port, f.token, 'PATCH', path, { name: 'Renamed' })).status, 200);
    assert.equal((await f.store.loadSession(f.sample.id))?.pullRequestUrl, 'https://github.com/fmktech/ftown/pull/128');
    await api(f.port, f.token, 'PATCH', path, { pullRequestUrl: 'https://github.com/fmktech/ftown/pull/129' });
    const listed = await api(f.port, f.token, 'GET', '/api/sessions');
    assert.equal((listed.data.sessions as Session[]).find((session) => session.id === f.sample.id)?.pullRequestUrl, 'https://github.com/fmktech/ftown/pull/129');
    assert.equal((await api(f.port, f.token, 'PATCH', path, { pullRequestUrl: null })).status, 200);
    const cleared = await api(f.port, f.token, 'GET', path);
    assert.equal(Object.hasOwn(cleared.data.session as Session, 'pullRequestUrl'), false);
    assert.equal(Object.hasOwn(f.published.at(-1)!, 'pullRequestUrl'), false);
    assert.equal((await api(f.port, f.token, 'PATCH', '/api/sessions/missing', { pullRequestUrl: null })).status, 404);
  });
});

// Run by the main assistant with the other listener-backed tests.
describe('retired automation HTTP compatibility', () => {
  it('authenticates first and rejects every legacy subtree method before readiness, body parsing or storage', async () => {
    const server = new LocalApiServer();
    server.setAuthToken('retirement-token');
    const port = await server.start();
    try {
      assert.equal((await api(port, 'wrong', 'GET', '/api/loops')).status, 426);
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
          assert.equal(response.status, 426, `${method} ${path}: raw bearer never reaches application dispatch`);
          assert.deepEqual(await response.json(), { code: 'upgrade_required', error: 'upgrade_required' });
        }
      }
      for (const path of ['/api/loops', '/api/loops/id', '/api/loops/id/run-now', '/api/loops/id/runs']) {
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
          const response = await api(port, 'retirement-token', method, path, method === 'GET' ? undefined : {});
          assert.equal(response.status, 410, `${method} ${path}: encrypted retired operations stay inert`);
          assert.deepEqual(response.data, { code: 'automation_removed', error: 'Recurring loops and factory automation have been removed' });
        }
      }
      assert.equal((await api(port, 'retirement-token', 'GET', '/api/loops-other')).status, 403, 'unknown application routes deny before readiness');
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
      assert.equal((await api(port, 'wrong', 'GET', '/api/sessions/claude/inbox' + query('claude-mod', 'native-claude'))).status, 426);
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

it('child idle queues one ordinary durable parent message and rejects ineligible targets without a listener', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-idle-parent-'));
  const server = new BaseLocalApiServer(); t.after(() => { server.stop(); rmSync(dir, { recursive: true, force: true }); });
  const base = (id: string): Session => ({ id, name: id, command: 'fake', shellType: 'pi', status: 'running', bridgeId: 'bridge', createdAt: '', updatedAt: '' });
  const child = { ...base('child'), name: 'Worker', parentSessionId: 'parent' };
  const parent = base('parent'); const sessions = new Map<string, Session>([['child', child], ['parent', parent]]);
  let reads = 0; let reparentDuringLookup = false; let cancelDuringLookup = false; let current = true;
  const store = { listSessions: async () => [], loadSession: async (id: string) => {
    reads++; if (reparentDuringLookup && reads === 3) sessions.set('child', { ...child, parentSessionId: 'other' });
    if (cancelDuringLookup && reads === 3) current = false;
    return sessions.get(id) ?? null;
  } } as unknown as SessionStore;
  const running = new Set(['child', 'parent']);
  const runner = Object.assign(new EventEmitter(), { isRunning: (id: string) => running.has(id), write: () => { throw new Error('unexpected direct terminal write'); } }) as unknown as ProcessRunner;
  const mail = new MailStore(id => join(dir, id));
  server.setDependencies(store, runner, {} as CentrifugoClient, 'user'); server.setMailStore(mail);
  server.setSecurity({} as BridgeSecurityService, { bridgeId: 'bridge' } as Parameters<BaseLocalApiServer['setSecurity']>[1], async () => null);
  const signal = { sessionId: 'child', cycleId: 'cycle-1', startedAt: '2026-10-30T12:00:00Z' };
  const attempt = async () => { reads = 0; await server.notifyIdleParent(signal, () => current); };
  const expectNone = async () => assert.equal((await mail.listAll('parent', 0)).length, 0);
  for (const invalid of [undefined, { ...child, parentSessionId: undefined }, { ...child, parentSessionId: 'child' }, { ...child, bridgeId: 'other' }, { ...child, status: 'completed' as const }, { ...child, shellType: 'shell' as const }]) {
    if (invalid) sessions.set('child', invalid); else sessions.delete('child');
    await attempt(); await expectNone();
  }
  sessions.set('child', child);
  for (const invalid of [undefined, { ...parent, bridgeId: 'other' }, { ...parent, status: 'completed' as const }, { ...parent, shellType: 'shell' as const }]) {
    if (invalid) sessions.set('parent', invalid); else sessions.delete('parent');
    await attempt(); await expectNone();
  }
  sessions.set('parent', parent);
  running.delete('child'); await attempt(); await expectNone(); running.add('child');
  running.delete('parent'); await attempt(); await expectNone(); running.add('parent');
  current = false; await attempt(); await expectNone(); current = true;
  cancelDuringLookup = true; await attempt(); await expectNone(); cancelDuringLookup = false; current = true;
  reparentDuringLookup = true; await attempt(); await expectNone(); reparentDuringLookup = false; sessions.set('child', child);
  await attempt(); const messages = await mail.listAll('parent', 0); assert.equal(messages.length, 1);
  assert.deepEqual({ from: messages[0].from, fromName: messages[0].fromName, to: messages[0].to, type: messages[0].type, threadId: messages[0].threadId, body: messages[0].body },
    { from: 'child', fromName: 'Worker', to: 'parent', type: 'message', threadId: 'cycle-1', body: 'Child session Worker (child) has been idle for 120 seconds. Check its status before assigning more work.' });
});
