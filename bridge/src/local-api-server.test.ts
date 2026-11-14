import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
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
import type { PushNotice } from './push-notifier.js';
import type { HookEvent } from './local-api-server.js';
import { MailStore } from './mail-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderAuthMissingError, WorkingDirMissingError } from './create-ftown-session.js';
import { buildSessionCommand } from './agent-commands.js';
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
import type { VerifiedApplication } from './security/protocol.js';
import { createCoordination } from './coordination/wiring.js';
import type { Board, SessionCard, TreeEventPage } from './coordination/contract.js';
import { PARENT_UNAVAILABLE_NOTE, WorktreeError } from './coordination/contract-b.js';

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
  it('accepts structured questions on POST attention and rejects invalid ones', async t => {
    const f = await sessionToolsFixture(t);
    const path = `/api/sessions/${f.sample.id}/attention`;
    const questions = [{ question: 'Which database?', options: ['Postgres', { label: 'SQLite', description: 'embedded' }], allowText: true }];
    const ok = await api(f.port, f.token, 'POST', path, { message: 'Pick one', questions });
    assert.equal(ok.status, 200);
    const event = ok.data.event as AttentionItem;
    assert.equal(event.prompt?.channel, 'mail');
    assert.equal(event.prompt?.questions[0].options.length, 2);
    const hook = f.events.find(e => e.data.attentionId === event.id);
    assert.deepEqual(hook?.data.attentionPrompt, event.prompt);
    const bad = await api(f.port, f.token, 'POST', path, { message: 'Pick one', questions: [{ question: '', options: [] }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.code, 'invalid_prompt');
    assert.equal((await api(f.port, f.token, 'POST', path, { message: 'Pick one', questions: 'nope' })).status, 400);
    const plain = await api(f.port, f.token, 'POST', path, { message: 'No questions here' });
    assert.equal((plain.data.event as AttentionItem).prompt, undefined);
    assert.equal(f.events.at(-1)?.data.attentionPrompt, undefined);
  });
  it('serves a single attention item and long-polls until it is answered', async t => {
    const f = await sessionToolsFixture(t);
    const path = `/api/sessions/${f.sample.id}/attention`;
    const created = await api(f.port, f.token, 'POST', path, { message: 'Pick one', questions: [{ question: 'Which?', options: ['A', 'B'] }] });
    const event = created.data.event as AttentionItem;
    const got = await api(f.port, f.token, 'GET', `${path}/${event.id}`);
    assert.equal(got.status, 200);
    assert.equal((got.data.event as AttentionItem).id, event.id);
    assert.equal((await api(f.port, f.token, 'GET', `${path}/missing-id`)).data.code, 'attention_not_found');
    assert.equal((await api(f.port, f.token, 'GET', `${path}/missing-id`)).status, 404);
    assert.equal((await api(f.port, f.token, 'GET', `${path}/${event.id}?waitSeconds=26`)).status, 400);
    assert.equal((await api(f.port, f.token, 'GET', `${path}/${event.id}?waitSeconds=abc`)).status, 400);
    assert.equal((await api(f.port, f.token, 'GET', '/api/sessions/nope/attention/abc')).status, 404);
    const started = Date.now();
    const waiting = api(f.port, f.token, 'GET', `${path}/${event.id}?waitSeconds=10`);
    await new Promise(resolve => setTimeout(resolve, 150));
    await f.attention.answer(f.sample.id, event.id, [{ selected: [1] }]);
    const done = await waiting;
    assert.equal(done.status, 200);
    assert.ok(Date.now() - started < 5000, 'wait returned on answer, not at the deadline');
    assert.equal((done.data.event as AttentionItem).resolution, 'answered');
    assert.deepEqual((done.data.event as AttentionItem).answer?.answers, [{ selected: [1] }]);
  });
  it('rejects fractional/negative waitSeconds and drops the live waiter when the client disconnects', async t => {
    const f = await sessionToolsFixture(t);
    const path = `/api/sessions/${f.sample.id}/attention`;
    const created = await api(f.port, f.token, 'POST', path, { message: 'Pick one', questions: [{ question: 'Which?', options: ['A', 'B'] }] });
    const event = created.data.event as AttentionItem;
    assert.equal((await api(f.port, f.token, 'GET', `${path}/${event.id}?waitSeconds=1.5`)).status, 400);
    assert.equal((await api(f.port, f.token, 'GET', `${path}/${event.id}?waitSeconds=-1`)).status, 400);
    assert.equal(f.attention.hasLiveWaiter(event.id), false);
    const secure = secureFixtures.get(f.port);
    assert.ok(secure);
    const inner = f.server as unknown as { handleApiRoute: (...args: unknown[]) => Promise<void> };
    const original = inner.handleApiRoute.bind(f.server);
    const rejections: unknown[] = [];
    inner.handleApiRoute = (...args: unknown[]) => original(...args).catch((error: unknown) => { rejections.push(error); throw error; });
    const controller = new AbortController();
    const pending = apiResponse(secure.pointer, 'GET', `${path}/${event.id}?waitSeconds=10`, undefined, undefined, controller.signal).then(() => undefined, (error: unknown) => error);
    for (let i = 0; i < 50 && !f.attention.hasLiveWaiter(event.id); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.attention.hasLiveWaiter(event.id), true, 'an in-flight long-poll counts as a live waiter');
    controller.abort();
    await pending;
    for (let i = 0; i < 50 && f.attention.hasLiveWaiter(event.id); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.attention.hasLiveWaiter(event.id), false, 'a disconnected long-poll must not keep the waiter live');
    assert.ok(rejections.some(error => error instanceof AttentionError && error.code === 'cancelled'), 'the handler wait was cancelled');
  });
  it('does not leave a live waiter when the client is already gone before the long-poll attaches', async t => {
    const f = await sessionToolsFixture(t);
    const path = `/api/sessions/${f.sample.id}/attention`;
    const created = await api(f.port, f.token, 'POST', path, { message: 'Pick one', questions: [{ question: 'Which?', options: ['A', 'B'] }] });
    const event = created.data.event as AttentionItem;
    const request = Readable.from([Buffer.from('{}')]) as unknown as IncomingMessage;
    request.method = 'GET'; request.headers = {};
    const response = new EventEmitter() as EventEmitter & { statusCode: number; destroyed: boolean; headersSent: boolean; writeHead: () => void; setHeader: () => void; end: () => void };
    response.statusCode = 200; response.destroyed = true; response.headersSent = false;
    response.writeHead = () => undefined; response.setHeader = () => undefined; response.end = () => undefined;
    const target = new URL(`${path}/${event.id}?waitSeconds=10`, 'http://localhost');
    request.url = target.pathname + target.search;
    const handler = f.server as unknown as { handleApiRoute: (req: IncomingMessage, res: ServerResponse, path: string, url: URL) => Promise<void> };
    const started = Date.now();
    const outcome = await handler.handleApiRoute(request, response as unknown as ServerResponse, target.pathname, target).then(() => undefined, (error: unknown) => error);
    assert.ok(outcome instanceof AttentionError && outcome.code === 'cancelled');
    assert.ok(Date.now() - started < 2000, 'returned immediately instead of waiting');
    assert.equal(f.attention.hasLiveWaiter(event.id), false);
  });
  it('records AskUserQuestion tool input through the ask endpoint and publishes one stamped event', async t => {
    const f = await sessionToolsFixture(t);
    const path = `/api/sessions/${f.sample.id}/attention/ask`;
    const toolInput = { questions: [{ question: 'Which lib?', header: 'Lib', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] };
    const res = await api(f.port, f.token, 'POST', path, { toolName: 'AskUserQuestion', toolUseId: 'toolu_1', toolInput });
    assert.equal(res.status, 200);
    const event = res.data.event as AttentionItem;
    assert.equal(event.prompt?.channel, 'hook');
    assert.equal(event.prompt?.questions[0].options.length, 2);
    assert.equal(f.events.length, 1);
    const ev = f.events[0];
    assert.equal(ev.eventName, 'PreToolUse');
    assert.equal(ev.data.hook_event_name, 'PreToolUse');
    assert.equal(ev.data.tool_name, 'AskUserQuestion');
    assert.equal(ev.data.tool_use_id, 'toolu_1');
    assert.deepEqual(ev.data.tool_input, toolInput);
    assert.equal(ev.data.attentionId, event.id);
    assert.equal(ev.data.attentionSequence, event.sequence);
    assert.equal(ev.data.attentionCreatedAt, event.createdAt);
    const other = await api(f.port, f.token, 'POST', path, { toolName: 'Bash', toolUseId: 'toolu_2', toolInput: { command: 'ls' } });
    assert.equal(other.status, 200);
    assert.equal(other.data.event, null);
    assert.equal(f.events.length, 1, 'non-attention tools publish nothing');
    assert.equal((await api(f.port, f.token, 'POST', path, { toolName: '', toolUseId: 'x', toolInput })).status, 400);
    assert.equal((await api(f.port, f.token, 'POST', path, { toolName: 'AskUserQuestion', toolInput })).status, 400);
    assert.equal((await api(f.port, f.token, 'POST', path, { toolName: 'AskUserQuestion', toolUseId: 'x', toolInput, extra: 1 })).status, 400);
    await f.store.saveSession({ ...f.sample, status: 'stopped' });
    const inactive = await api(f.port, f.token, 'POST', path, { toolName: 'AskUserQuestion', toolUseId: 'x', toolInput });
    assert.equal(inactive.status, 409);
    assert.equal(inactive.data.code, 'session_not_active');
  });
  describe('ask endpoint and ordinary hook interplay', () => {
    const toolInput = { questions: [{ question: 'Which lib?', header: 'Lib', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] };
    const askBody = { toolName: 'AskUserQuestion', toolUseId: 'toolu_x', toolInput };
    const hookBody = (id: string) => ({ ftown_session_id: id, ftown_session_source: 'env', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_x', tool_input: toolInput });
    it('repeating /ask for the same tool_use_id publishes nothing more', async t => {
      const f = await sessionToolsFixture(t);
      const path = `/api/sessions/${f.sample.id}/attention/ask`;
      assert.equal((await api(f.port, f.token, 'POST', path, askBody)).status, 200);
      assert.equal((await api(f.port, f.token, 'POST', path, askBody)).status, 200);
      assert.equal(f.events.length, 1);
      assert.equal((await f.attention.list(f.sample.id)).events.length, 1);
    });
    it('/hook first then /ask publishes only the hook event', async t => {
      const f = await sessionToolsFixture(t);
      assert.equal((await api(f.port, f.token, 'POST', '/hook', hookBody(f.sample.id))).status, 200);
      assert.equal(f.events.length, 1);
      const res = await api(f.port, f.token, 'POST', `/api/sessions/${f.sample.id}/attention/ask`, askBody);
      assert.equal(res.status, 200);
      assert.equal(f.events.length, 1);
      const items = (await f.attention.list(f.sample.id)).events;
      assert.equal(items.length, 1);
      assert.equal(items[0].occurrences, 2);
      assert.ok(items[0].id);
      assert.equal(f.events[0].data.attentionId, items[0].id);
      assert.equal(f.events[0].source, 'env');
    });
    it('/ask publishes with source api', async t => {
      const f = await sessionToolsFixture(t);
      assert.equal((await api(f.port, f.token, 'POST', `/api/sessions/${f.sample.id}/attention/ask`, askBody)).status, 200);
      const items = (await f.attention.list(f.sample.id)).events;
      assert.ok(items[0].id);
      assert.equal(f.events[0].data.attentionId, items[0].id);
      assert.equal(f.events[0].source, 'api');
    });
    it('/ask onto a resolved item publishes nothing', async t => {
      const f = await sessionToolsFixture(t);
      const path = `/api/sessions/${f.sample.id}/attention/ask`;
      assert.equal((await api(f.port, f.token, 'POST', path, askBody)).status, 200);
      assert.equal((await api(f.port, f.token, 'POST', '/hook', { ftown_session_id: f.sample.id, ftown_session_source: 'env', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_x' })).status, 200);
      const before = f.events.length;
      assert.equal((await api(f.port, f.token, 'POST', path, askBody)).status, 200);
      assert.equal(f.events.length, before);
      const items = (await f.attention.list(f.sample.id, { includeResolved: true })).events;
      assert.equal(items.length, 1);
      assert.equal(items[0].resolution, 'tool_complete');
    });
    it('/ask does not mark the agent busy', async t => {
      const f = await sessionToolsFixture(t);
      const mail = (f.server as unknown as { mail: { markAgentBusy: (id: string, event?: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit') => void } }).mail;
      const busy: Array<{ id: string; event?: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' }> = [];
      const original = mail.markAgentBusy.bind(mail);
      mail.markAgentBusy = (id, event) => { busy.push({ id, event }); original(id, event); };
      assert.equal((await api(f.port, f.token, 'POST', `/api/sessions/${f.sample.id}/attention/ask`, askBody)).status, 200);
      assert.deepEqual(busy, []);
      await api(f.port, f.token, 'POST', '/hook', hookBody(f.sample.id));
      await api(f.port, f.token, 'POST', '/hook', { ftown_session_id: f.sample.id, ftown_session_source: 'env', hook_event_name: 'PostToolUse' });
      await api(f.port, f.token, 'POST', '/hook', { ftown_session_id: f.sample.id, ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit' });
      assert.deepEqual(busy, [
        { id: f.sample.id, event: 'PreToolUse' },
        { id: f.sample.id, event: 'PostToolUse' },
        { id: f.sample.id, event: 'UserPromptSubmit' },
      ]);
    });
    it('/ask first then /hook gives one item, two identically stamped events and occurrences 2', async t => {
      const f = await sessionToolsFixture(t);
      assert.equal((await api(f.port, f.token, 'POST', `/api/sessions/${f.sample.id}/attention/ask`, askBody)).status, 200);
      assert.equal((await api(f.port, f.token, 'POST', '/hook', hookBody(f.sample.id))).status, 200);
      const items = (await f.attention.list(f.sample.id)).events;
      assert.equal(items.length, 1);
      assert.equal(items[0].occurrences, 2);
      assert.equal(f.events.length, 2);
      assert.equal(f.events[0].data.attentionId, f.events[1].data.attentionId);
      assert.equal(f.events[0].data.attentionSequence, f.events[1].data.attentionSequence);
      assert.equal(f.events[0].data.attentionCreatedAt, f.events[1].data.attentionCreatedAt);
    });
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
    assert.deepEqual(capabilities.data.capabilities, { attention: { version: 1, request: true, prompt: true }, sessionMetadata: { pullRequest: true, preview: true } });
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

// Revive must carry each harness's native conversation id from the tombstone
// into the new session, and refuse when a live session already owns that id.
describe('LocalApiServer revive native session ids (grok, antigravity)', () => {
  const harnesses = [
    { shellType: 'grok' as const, field: 'grokSessionId' as const },
    { shellType: 'antigravity' as const, field: 'antigravitySessionId' as const },
  ];

  for (const { shellType, field } of harnesses) {
    it(`revives a ${shellType} tombstone with its ${field} and applies the conflict rule`, async () => {
      const home = mkdtempSync(join(tmpdir(), `ftw-revive-${shellType}-`));
      const server = new LocalApiServer();
      const store = new SessionStore(join(home, 'data'));
      const running = new Set<string>();
      const runs: string[] = [];
      const runner = {
        getPreferredRuntime: () => 'direct',
        run: (sessionId: string, command: string) => { running.add(sessionId); runs.push(command); },
        isRunning: (id: string) => running.has(id),
        hasTmuxSession: () => false,
        stop: () => false,
      } as unknown as ProcessRunner;
      const centrifugo = { publishSessionUpdate: async () => {} } as unknown as CentrifugoClient;
      // A builder-generated command, so revive classifies the tombstone as
      // builder-managed (not a verbatim custom command) and may report resume.
      const base = { command: buildSessionCommand({ shellType }), shellType, bridgeId: 'bridge', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
      const tombstone = (id: string, nativeId?: string): Session =>
        ({ ...base, id, name: id, status: 'completed', ...(nativeId ? { [field]: nativeId } : {}) }) as Session;
      const live = (id: string, nativeId: string): Session =>
        ({ ...base, id, name: id, status: 'running', [field]: nativeId }) as Session;

      await store.archiveSession(tombstone('resume-me', 'native-resume'));
      await store.archiveSession(tombstone('equal-id', 'native-owned'));
      await store.archiveSession(tombstone('different-id', 'native-other'));
      await store.archiveSession(tombstone('missing-id'));
      await store.saveSession(live('owner', 'native-owned'));
      running.add('owner');

      server.setAuthToken('token'); server.setDependencies(store, runner, centrifugo, 'user');
      server.setSessionFactory({ store, runner, centrifugo, userId: 'user', bridgeId: 'bridge',
        hookPort: 0, hookToken: 'token', notifyScriptPath: '', wireTerminalInput: () => {} });
      const port = await server.start();
      const revive = (id: string) => api(port, 'token', 'POST', `/api/sessions/${id}/revive`);
      const revivedNativeId = async (response: { data: Record<string, unknown> }) => {
        const revived = await store.loadSession((response.data.session as Session).id);
        return revived?.[field];
      };
      try {
        const resumed = await revive('resume-me');
        assert.equal(resumed.status, 201);
        assert.equal(await revivedNativeId(resumed), 'native-resume');
        assert.equal(resumed.data.resumed, true, 'a tombstone with a native id resumes its conversation');

        const conflict = await revive('equal-id');
        assert.equal(conflict.status, 409);
        assert.match(String(conflict.data.error), /Session owner is already running/);

        const different = await revive('different-id');
        assert.equal(different.status, 201, 'a different native id does not conflict');
        assert.equal(await revivedNativeId(different), 'native-other');

        const missing = await revive('missing-id');
        assert.equal(missing.status, 201, 'a tombstone without a native id never conflicts');
        assert.equal(await revivedNativeId(missing), undefined);
        assert.equal(missing.data.resumed, false, 'a tombstone without a native id starts fresh');

        running.delete('owner');
        await store.saveSession({ ...live('owner', 'native-owned'), status: 'completed' });
        const released = await revive('equal-id');
        assert.equal(released.status, 201, 'an equal id owned by a stopped session does not conflict');
        assert.equal(await revivedNativeId(released), 'native-owned');
      } finally { await server.stop(); rmSync(home, { recursive: true, force: true }); }
    });
  }
});

it('queues browser session replies through the durable mail store without an HTTP listener', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-browser-mail-'));
  const server = new BaseLocalApiServer();
  t.after(() => { server.stop(); rmSync(dir, { recursive: true, force: true }); });
  const session: Session = { id: 'session', name: 'session', command: 'fake', shellType: 'pi', status: 'running', bridgeId: 'bridge', createdAt: '', updatedAt: '' };
  assert.deepEqual(await server.enqueueSessionMessage(session, 'reply'), { ok: false, error: 'Mail store not ready' });
  const store = new SessionStore(dir); await store.saveSession(session);
  const mail = new MailStore(id => store.sessionDir(id));
  const runner = Object.assign(new EventEmitter(), { isRunning: () => true }) as unknown as ProcessRunner;
  server.setDependencies(store, runner, {} as CentrifugoClient, 'user'); server.setMailStore(mail);
  const result = await server.enqueueSessionMessage(session, '  first line\nsecond line  ');
  assert.equal(result.ok, true); if (!result.ok) throw new Error('expected durable mail');
  const messages = await mail.listAll(session.id, 10);
  assert.equal(messages.length, 1);
  assert.deepEqual({ id: messages[0].id, to: messages[0].to, from: messages[0].from, fromName: messages[0].fromName, type: messages[0].type, body: messages[0].body },
    { id: result.id, to: 'session', from: 'browser', fromName: 'You', type: 'message', body: '  first line\nsecond line  ' });
});

it('acceptSessionMail delivers threaded mail and reports an unready mail store', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-accept-mail-'));
  const server = new BaseLocalApiServer();
  t.after(() => { server.stop(); rmSync(dir, { recursive: true, force: true }); });
  const session: Session = { id: 'session', name: 'session', command: 'fake', shellType: 'pi', status: 'running', bridgeId: 'bridge', createdAt: '', updatedAt: '' };
  const body = { from: 'browser', fromName: 'You', type: 'message', threadId: 'attention:abc', body: 'Answer' };
  assert.deepEqual(await server.acceptSessionMail(session, body), { ok: false, error: 'Mail store not ready' });
  const store = new SessionStore(dir); await store.saveSession(session);
  const mail = new MailStore(id => store.sessionDir(id));
  const runner = Object.assign(new EventEmitter(), { isRunning: () => true }) as unknown as ProcessRunner;
  server.setDependencies(store, runner, {} as CentrifugoClient, 'user'); server.setMailStore(mail);
  const result = await server.acceptSessionMail(session, body);
  assert.equal(result.ok, true); if (!result.ok) throw new Error('expected durable mail');
  const messages = await mail.listAll(session.id, 10);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, result.id);
  assert.equal(messages[0].threadId, 'attention:abc');
  assert.equal(messages[0].body, 'Answer');
});

it('child idle emits an idle tree event, sends no mail, and rejects ineligible targets without a listener', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-idle-parent-'));
  const server = new BaseLocalApiServer(); t.after(() => { server.stop(); rmSync(dir, { recursive: true, force: true }); });
  const base = (id: string): Session => ({ id, name: id, command: 'fake', shellType: 'pi', status: 'running', bridgeId: 'bridge', createdAt: '', updatedAt: '' });
  const child = { ...base('child'), name: 'Worker', parentSessionId: 'parent' };
  const parent = base('parent'); const sessions = new Map<string, Session>([['child', child], ['parent', parent]]);
  let reads = 0; let reparentDuringLookup = false; let cancelDuringLookup = false; let current = true;
  const store = {
    listSessions: async () => [],
    saveSession: async () => {},
    sessionDir: (id: string) => join(dir, id),
    loadSession: async (id: string) => {
      reads++; if (reparentDuringLookup && reads === 3) sessions.set('child', { ...child, parentSessionId: 'other' });
      if (cancelDuringLookup && reads === 3) current = false;
      return sessions.get(id) ?? null;
    },
  } as unknown as SessionStore;
  const running = new Set(['child', 'parent']);
  const runner = Object.assign(new EventEmitter(), { isRunning: (id: string) => running.has(id), write: () => { throw new Error('unexpected direct terminal write'); } }) as unknown as ProcessRunner;
  const mail = new MailStore(id => join(dir, id));
  const emitted: Array<{ sessionId: string; kind: string; summary: string }> = [];
  const coord = createCoordination({
    store,
    attention: { list: async () => ({ activity: { state: 'idle' }, openCount: 0 }) },
    prStatus: async () => null,
    mail: { unreadCount: async () => 0 },
    publishSession: () => {},
    now: Date.now,
  });
  const origEmit = coord.emit.bind(coord);
  coord.emit = async (session, kind, summary, ref) => {
    emitted.push({ sessionId: session.id, kind, summary });
    await origEmit(session, kind, summary, ref);
  };
  server.setDependencies(store, runner, {} as CentrifugoClient, 'user'); server.setMailStore(mail);
  server.setCoordination(coord);
  server.setSecurity({} as BridgeSecurityService, { bridgeId: 'bridge' } as Parameters<BaseLocalApiServer['setSecurity']>[1], async () => null);
  const signal = { sessionId: 'child', cycleId: 'cycle-1', startedAt: '2026-10-30T12:00:00Z' };
  const attempt = async () => { reads = 0; await server.notifyIdleParent(signal, () => current); };
  const expectNone = async () => {
    assert.equal((await mail.listAll('parent', 0)).length, 0);
    assert.equal(emitted.length, 0);
  };
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
  await attempt();
  assert.equal((await mail.listAll('parent', 0)).length, 0, 'idle no longer sends mail');
  assert.deepEqual(emitted, [{ sessionId: 'child', kind: 'idle', summary: 'Worker idle for 2m' }]);
  const page = await coord.events.read('parent');
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].kind, 'idle');
  assert.equal(page.events[0].summary, 'Worker idle for 2m');
});

describe('LocalApiServer coordination routes and attention tree events (via dispatchSecure)', () => {
  async function coordFixture(t: { after: (fn: () => void) => void }) {
    const home = mkdtempSync(join(tmpdir(), 'ftown-coord-routes-'));
    const store = new SessionStore(join(home, 'data'));
    const server = new BaseLocalApiServer();
    const published: Session[] = [];
    const pushes: string[] = [];
    const attention = new AttentionStore((id) => store.sessionDir(id), 500, (_id, notice) => {
      pushes.push(notice.eventKey);
    });
    const mail = new MailStore((id) => store.sessionDir(id));
    const runner = { stop: () => false, isRunning: () => true } as unknown as ProcessRunner;
    const centrifugo = {
      publishSessionUpdate: async (_user: string, s: Session) => {
        published.push(structuredClone(s));
      },
    } as unknown as CentrifugoClient;

    server.setDependencies(store, runner, centrifugo, 'user-1');
    server.setAttentionStore(attention);
    server.setMailStore(mail);

    const coordination = createCoordination({
      store,
      attention,
      prStatus: async (url) => ({
        state: url.endsWith('/10') ? 'passed' : 'in_progress',
        stale: false,
        checkedAt: '2026-11-13T12:00:00.000Z',
      }),
      mail: {
        unreadCount: async (id) => (await mail.listUndelivered(id)).length,
      },
      publishSession: (s) => {
        published.push(structuredClone(s));
      },
      now: () => Date.parse('2026-11-13T12:00:00.000Z'),
      onAttentionEscalated: (sessionId, item) => {
        server.publishHumanAttention(sessionId, item);
      },
    });
    server.setCoordination(coordination);
    server.setSecurity(
      { revalidate: async () => {} } as unknown as BridgeSecurityService,
      {
        protocolVersion: 1,
        ownerId: 'owner-1',
        bridgeId: 'bridge-1',
        endpoint: {
          id: 'ep-1',
          ownerId: 'owner-1',
          kind: 'bridge',
          publicKey: '',
          createdAt: 0,
        },
        relayUserId: 'user-1',
      },
      async () => null,
    );

    t.after(() => {
      attention.stopNotifications();
      server.stop();
      rmSync(home, { recursive: true, force: true });
    });

    const call = async (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: string,
      body?: unknown,
      signal?: AbortSignal,
      callerSessionId?: string,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const message = {
        principal: {
          endpoint: {
            id: 'cli-1',
            ownerId: 'owner-1',
            kind: 'local-cli',
            publicKey: '',
            createdAt: 0,
          },
          permission: 'admin',
        },
        envelope: {
          type: 'ftown_encrypted',
          version: 1,
          senderId: 'cli-1',
          recipientId: 'ep-1',
          ownerId: 'owner-1',
          bridgeId: 'bridge-1',
          channel: 'local-http:bridge-1',
          purpose: 'application',
          messageId: 'req-1',
          createdAt: 0,
          expiresAt: 1000,
          receiverEpoch: null,
          nonce: '',
          ciphertext: '',
        },
        application: {
          type: 'application',
          route: { kind: 'http', requestId: 'req-1', method, path },
          data: {
            ...(body !== undefined ? { body } : {}),
            ...(callerSessionId ? { callerSessionId } : {}),
          },
          mcp: null,
        },
      } as unknown as VerifiedApplication;
      return (await server.dispatchSecure(message, signal)) as unknown as {
        status: number;
        body: Record<string, unknown>;
      };
    };

    const root: Session = {
      id: 'root-1',
      name: 'Orchestrator',
      command: 'claude',
      shellType: 'claude',
      status: 'running',
      bridgeId: 'bridge-1',
      createdAt: '2026-11-13T10:00:00.000Z',
      updatedAt: '2026-11-13T10:00:00.000Z',
    };
    const childA: Session = {
      id: 'child-a',
      name: 'Worker A',
      command: 'claude',
      shellType: 'claude',
      status: 'running',
      bridgeId: 'bridge-1',
      parentSessionId: 'root-1',
      pullRequestUrl: 'https://github.com/org/repo/pull/10',
      createdAt: '2026-11-13T10:01:00.000Z',
      updatedAt: '2026-11-13T10:01:00.000Z',
    };
    const childB: Session = {
      id: 'child-b',
      name: 'Worker B',
      command: 'claude',
      shellType: 'claude',
      status: 'running',
      bridgeId: 'bridge-1',
      parentSessionId: 'root-1',
      createdAt: '2026-11-13T10:02:00.000Z',
      updatedAt: '2026-11-13T10:02:00.000Z',
    };
    await store.saveSession(root);
    await store.saveSession(childA);
    await store.saveSession(childB);

    return { store, server, coordination, call, published, root, childA, childB, mail, attention, pushes };
  }

  it('serves GET, PUT, and DELETE /api/sessions/:id/card with strict validation and 404 handling', async (t) => {
    const f = await coordFixture(t);

    // 404 on unknown session
    assert.equal((await f.call('GET', '/api/sessions/missing/card')).status, 404);
    assert.equal(
      (await f.call('PUT', '/api/sessions/missing/card', { state: 'working', headline: 'hi' })).status,
      404,
    );
    assert.equal((await f.call('DELETE', '/api/sessions/missing/card')).status, 404);

    // 400 on unknown query parameter
    assert.equal((await f.call('GET', '/api/sessions/child-a/card?foo=1')).status, 400);
    assert.equal(
      (await f.call('PUT', '/api/sessions/child-a/card?foo=1', { state: 'working', headline: 'hi' })).status,
      400,
    );
    assert.equal((await f.call('DELETE', '/api/sessions/child-a/card?foo=1')).status, 400);

    // 405 on unsupported method
    assert.equal((await f.call('POST', '/api/sessions/child-a/card', {})).status, 405);

    // Initial GET returns declared: null
    const initial = await f.call('GET', '/api/sessions/child-a/card');
    assert.equal(initial.status, 200);
    assert.equal((initial.body as unknown as SessionCard).declared, null);
    assert.equal((initial.body as unknown as SessionCard).derived.pr?.state, 'passed');

    // PUT validation errors -> 400
    assert.equal((await f.call('PUT', '/api/sessions/child-a/card', {})).status, 400);
    assert.equal(
      (await f.call('PUT', '/api/sessions/child-a/card', { state: 'working' })).status,
      400,
    );
    assert.equal(
      (await f.call('PUT', '/api/sessions/child-a/card', {
        state: 'working',
        headline: 'valid',
        unknownKey: true,
      })).status,
      400,
    );
    assert.equal(
      (await f.call('PUT', '/api/sessions/child-a/card', {
        state: 'working',
        headline: 'valid',
        progress: { done: 5, total: 3 },
      })).status,
      400,
    );

    // PUT happy path (create + partial update)
    const created = await f.call('PUT', '/api/sessions/child-a/card', {
      state: 'working',
      headline: 'Building API routes',
      progress: { done: 2, total: 4 },
    });
    assert.equal(created.status, 200);
    const createdCard = created.body as unknown as SessionCard;
    assert.equal(createdCard.declared?.state, 'working');
    assert.equal(createdCard.declared?.headline, 'Building API routes');
    assert.deepEqual(createdCard.declared?.progress, { done: 2, total: 4 });

    const updated = await f.call('PUT', '/api/sessions/child-a/card', {
      state: 'waiting_review',
      progress: null,
    });
    assert.equal(updated.status, 200);
    const updatedCard = updated.body as unknown as SessionCard;
    assert.equal(updatedCard.declared?.state, 'waiting_review');
    assert.equal(updatedCard.declared?.headline, 'Building API routes');
    assert.equal(updatedCard.declared?.progress, undefined);

    // DELETE rejects unexpected body keys, succeeds with empty body
    assert.equal(
      (await f.call('DELETE', '/api/sessions/child-a/card', { unexpected: 1 })).status,
      400,
    );
    const cleared = await f.call('DELETE', '/api/sessions/child-a/card');
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body, { ok: true });

    const afterClear = await f.call('GET', '/api/sessions/child-a/card');
    assert.equal((afterClear.body as unknown as SessionCard).declared, null);
  });

  it('serves GET /api/sessions/:id/board with query filtering and strict parameter validation', async (t) => {
    const f = await coordFixture(t);

    // 404 on missing session
    assert.equal((await f.call('GET', '/api/sessions/missing/board')).status, 404);

    // 405 on non-GET
    assert.equal((await f.call('POST', '/api/sessions/root-1/board')).status, 405);

    // 400 on invalid query params
    for (const bad of [
      'unknown=1',
      'since=-1',
      'since=abc',
      'since=1.5',
      'since=1234567890123',
      'since=1&since=2',
      'ready=2',
      'ready=yes',
      'all=invalid',
    ]) {
      assert.equal(
        (await f.call('GET', `/api/sessions/root-1/board?${bad}`)).status,
        400,
        `expected 400 for ?${bad}`,
      );
    }

    await f.call('PUT', '/api/sessions/child-a/card', {
      state: 'waiting_review',
      headline: 'PR up',
    });

    const boardRes = await f.call('GET', '/api/sessions/root-1/board');
    assert.equal(boardRes.status, 200);
    const board = boardRes.body as unknown as Board;
    assert.equal(board.rootId, 'root-1');
    assert.equal(board.cards.length, 2);
    assert.equal(board.rollup.waiting_review, 1);
    assert.equal(board.rollup.unset, 1);

    const readyRes = await f.call('GET', '/api/sessions/root-1/board?ready=1');
    assert.equal(readyRes.status, 200);
    const readyBoard = readyRes.body as unknown as Board;
    assert.equal(readyBoard.cards.length, 1);
    assert.equal(readyBoard.cards[0].sessionId, 'child-a');

    const sinceFuture = await f.call('GET', `/api/sessions/root-1/board?since=${board.cursor}&all=1`);
    assert.equal(sinceFuture.status, 200);
    assert.equal((sinceFuture.body as unknown as Board).cards.length, 0);
  });

  it('serves GET /api/sessions/:id/events with pagination, long-poll wait, and abort on disconnect', async (t) => {
    const f = await coordFixture(t);

    // 404 on missing session
    assert.equal((await f.call('GET', '/api/sessions/missing/events')).status, 404);

    // 405 on non-GET
    assert.equal((await f.call('POST', '/api/sessions/root-1/events')).status, 405);

    // 400 on invalid query params
    for (const bad of [
      'unknown=1',
      'since=-1',
      'since=abc',
      'since=1234567890123',
      'limit=0',
      'limit=501',
      'limit=abc',
      'waitSeconds=-1',
      'waitSeconds=301',
      'waitSeconds=1.5',
      'waitSeconds=abc',
      'since=1&since=2',
    ]) {
      assert.equal(
        (await f.call('GET', `/api/sessions/root-1/events?${bad}`)).status,
        400,
        `expected 400 for ?${bad}`,
      );
    }

    await f.call('PUT', '/api/sessions/child-a/card', { state: 'working', headline: 'Step 1' });
    await f.call('PUT', '/api/sessions/child-b/card', { state: 'working', headline: 'Step 2' });

    // Reading from child resolves root's log
    const page1 = await f.call('GET', '/api/sessions/child-a/events?since=0&limit=1');
    assert.equal(page1.status, 200);
    const body1 = page1.body as unknown as TreeEventPage;
    assert.equal(body1.events.length, 1);
    assert.equal(body1.cursor, 1);

    // Long-poll wait resolves immediately when new event is appended
    const waitPromise = f.call('GET', '/api/sessions/root-1/events?since=2&waitSeconds=10');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await f.coordination.emit(f.childA, 'result', 'Done with A');
    const waited = await waitPromise;
    assert.equal(waited.status, 200);
    const waitedPage = waited.body as unknown as TreeEventPage;
    assert.equal(waitedPage.events.length, 1);
    assert.equal(waitedPage.events[0].kind, 'result');
    assert.equal(waitedPage.cursor, 3);

    // Long-poll wait aborts promptly when clientGone signal fires
    const abortController = new AbortController();
    const started = Date.now();
    const abortedPromise = f.call(
      'GET',
      '/api/sessions/root-1/events?since=3&waitSeconds=30',
      undefined,
      abortController.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    abortController.abort();
    const abortedRes = await abortedPromise;
    assert.ok(Date.now() - started < 2000, 'wait must abort promptly when request closes');
    assert.equal(abortedRes.status, 200);
    assert.equal((abortedRes.body as unknown as TreeEventPage).timedOut, true);
  });

  it('emits attention tree event on POST /attention and /attention/ask only when session has a parent', async (t) => {
    const f = await coordFixture(t);

    // Root session (no parent) -> does NOT emit attention tree event
    const rootAtt = await f.call('POST', '/api/sessions/root-1/attention', {
      title: 'Root question',
      message: 'Should not emit tree event',
    });
    assert.equal(rootAtt.status, 200);
    assert.equal((await f.coordination.events.read('root-1')).events.length, 0);

    // Child session POST /attention -> emits attention tree event with title and ref = event.id
    const childAtt = await f.call('POST', '/api/sessions/child-a/attention', {
      title: 'Need DB password',
      message: 'Please provide credentials',
    });
    assert.equal(childAtt.status, 200);
    const attEvent = childAtt.body.event as AttentionItem;
    let treeEvents = (await f.coordination.events.read('root-1')).events;
    assert.equal(treeEvents.length, 1);
    assert.equal(treeEvents[0].sessionId, 'child-a');
    assert.equal(treeEvents[0].kind, 'attention');
    assert.equal(treeEvents[0].summary, 'Need DB password');
    assert.equal(treeEvents[0].ref, attEvent.id);

    // Child session POST /attention/ask -> emits attention tree event with title and ref = item.id
    const askRes = await f.call('POST', '/api/sessions/child-b/attention/ask', {
      toolName: 'AskUserQuestion',
      toolUseId: 'toolu_ask_1',
      toolInput: {
        questions: [
          {
            question: 'Which region?',
            header: 'Region',
            multiSelect: false,
            options: [
              { label: 'us-east', description: 'East' },
              { label: 'us-west', description: 'West' },
            ],
          },
        ],
      },
    });
    assert.equal(askRes.status, 200);
    const askEvent = askRes.body.event as AttentionItem;
    treeEvents = (await f.coordination.events.read('root-1')).events;
    assert.equal(treeEvents.length, 2);
    assert.equal(treeEvents[1].sessionId, 'child-b');
    assert.equal(treeEvents[1].kind, 'attention');
    assert.equal(treeEvents[1].summary, askEvent.title);
    assert.equal(treeEvents[1].ref, askEvent.id);
  });

  it('routes new attention to a running parent unless to is human, and skips the notice and push', async (t) => {
    const f = await coordFixture(t);
    const notices: HookEvent[] = [];
    f.server.on('event', (event) => notices.push(event));
    const questions = [{ question: 'Which database?', options: ['Postgres', 'SQLite'], allowText: true }];
    const body = { title: 'Pick DB', message: 'Which database should we use?', questions };

    const parentRouted = await f.call('POST', '/api/sessions/child-a/attention', body);
    assert.equal(parentRouted.status, 200);
    const event = parentRouted.body.event as AttentionItem;
    assert.equal(event.route, 'parent');
    assert.equal(event.routedTo, 'root-1');
    assert.equal(notices.filter((notice) => notice.data.attentionId === event.id).length, 0);
    assert.equal(f.pushes.includes(`question:${event.id}`), false);
    const mailed = await f.mail.listAll('root-1', 10);
    assert.equal(mailed.length, 1);
    assert.equal(mailed[0].type, 'escalation');
    assert.equal(mailed[0].from, 'child-a');
    assert.equal(mailed[0].fromName, 'Worker A');
    assert.equal(mailed[0].threadId, event.id);
    assert.match(mailed[0].body, /^\[ftown question id=.* from=Worker A \(child-a\)\] Pick DB/);

    const repeat = await f.call('POST', '/api/sessions/child-a/attention', body);
    assert.equal((repeat.body.event as AttentionItem).id, event.id);
    assert.equal((repeat.body.event as AttentionItem).occurrences, 2);
    assert.equal((repeat.body.event as AttentionItem).route, 'parent');
    assert.equal((await f.mail.listAll('root-1', 10)).length, 1);
    assert.equal(notices.filter((notice) => notice.data.attentionId === event.id).length, 0);

    const human = await f.call('POST', '/api/sessions/child-b/attention', {
      title: 'Need a secret',
      message: 'Paste the token',
      to: 'human',
    });
    assert.equal(human.status, 200);
    const humanEvent = human.body.event as AttentionItem;
    assert.equal(humanEvent.route, undefined);
    assert.equal(notices.filter((notice) => notice.data.attentionId === humanEvent.id).length, 1);
    assert.equal(f.pushes.includes(`question:${humanEvent.id}`), true);
    assert.equal((await f.mail.listAll('root-1', 10)).filter((message) => message.threadId === humanEvent.id).length, 0);
    assert.equal((await f.call('POST', '/api/sessions/child-b/attention', { message: 'Nope', to: 'parent' })).status, 400);

    const ask = await f.call('POST', '/api/sessions/child-a/attention/ask', {
      toolName: 'AskUserQuestion',
      toolUseId: 'toolu_parent',
      toolInput: {
        questions: [{
          question: 'Which region?',
          header: 'Region',
          multiSelect: false,
          options: [{ label: 'us-east', description: 'East' }, { label: 'us-west', description: 'West' }],
        }],
      },
    });
    assert.equal(ask.status, 200);
    const askEvent = ask.body.event as AttentionItem;
    assert.equal(askEvent.route, 'parent');
    assert.equal(askEvent.routedTo, 'root-1');
    assert.equal(notices.filter((notice) => notice.eventName === 'PreToolUse' && notice.data.attentionId === askEvent.id).length, 0);
    assert.equal(f.pushes.includes(`question:${askEvent.id}`), false);
    assert.equal((await f.mail.listAll('root-1', 10)).filter((message) => message.threadId === askEvent.id).length, 1);

    const askHuman = await f.call('POST', '/api/sessions/child-b/attention/ask', {
      toolName: 'AskUserQuestion',
      toolUseId: 'toolu_human',
      to: 'human',
      toolInput: {
        questions: [{
          question: 'Ship it?',
          header: 'Ship',
          multiSelect: false,
          options: [{ label: 'Yes', description: 'yes' }, { label: 'No', description: 'no' }],
        }],
      },
    });
    assert.equal(askHuman.status, 200);
    const askHumanEvent = askHuman.body.event as AttentionItem;
    assert.equal(askHumanEvent.route, undefined);
    assert.equal(notices.filter((notice) => notice.eventName === 'PreToolUse' && notice.data.attentionId === askHumanEvent.id).length, 1);
    assert.equal(f.pushes.includes(`question:${askHumanEvent.id}`), true);
  });

  it('lets only the parent answer or escalate, and lists that parent\'s routed items', async (t) => {
    const f = await coordFixture(t);
    const notices: HookEvent[] = [];
    f.server.on('event', (event) => notices.push(event));
    const created = await f.call('POST', '/api/sessions/child-a/attention', {
      title: 'Pick DB',
      message: 'Which database?',
      questions: [{ question: 'Which database?', options: ['Postgres', 'SQLite'], allowText: true }],
    });
    const event = created.body.event as AttentionItem;
    const answerPath = `/api/sessions/child-a/attention/${event.id}/answer`;
    const answers = { answers: [{ selected: [1] }] };

    assert.equal((await f.call('POST', answerPath, answers, undefined, 'child-a')).status, 403);
    assert.equal((await f.call('POST', answerPath, answers)).status, 403);
    assert.equal((await f.call('POST', answerPath, { answers: [{ selected: [9] }] }, undefined, 'root-1')).status, 400);

    const answered = await f.call('POST', answerPath, answers, undefined, 'root-1');
    assert.equal(answered.status, 200);
    const answeredEvent = answered.body.event as AttentionItem;
    assert.equal(answeredEvent.resolution, 'answered');
    assert.equal(answeredEvent.answeredBy?.kind, 'session');
    assert.equal(answeredEvent.answeredBy?.sessionId, 'root-1');
    assert.equal(answeredEvent.answeredBy?.name, 'Orchestrator');
    assert.equal((await f.call('POST', answerPath, answers, undefined, 'root-1')).status, 409);
    const childMail = await f.mail.listAll('child-a', 10);
    assert.equal(childMail.length, 1);
    assert.equal(childMail[0].from, 'root-1');
    assert.equal(childMail[0].fromName, 'Orchestrator');
    assert.equal(childMail[0].threadId, `attention:${event.id}`);

    const open = await f.call('POST', '/api/sessions/child-b/attention', {
      title: 'Need a decision',
      message: 'Please choose',
    });
    const openEvent = open.body.event as AttentionItem;
    const escalatePath = `/api/sessions/child-b/attention/${openEvent.id}/escalate`;
    assert.equal((await f.call('POST', escalatePath, { note: 'nope' }, undefined, 'child-b')).status, 403);
    const escalated = await f.call('POST', escalatePath, { note: 'credentials needed' }, undefined, 'root-1');
    assert.equal(escalated.status, 200);
    const escalatedEvent = escalated.body.event as AttentionItem;
    assert.equal(escalatedEvent.route, 'human');
    assert.equal(escalatedEvent.escalationNote, 'credentials needed');
    assert.ok(escalatedEvent.escalatedAt);
    assert.equal(notices.filter((notice) => notice.eventName === 'Notification' && notice.data.attentionId === openEvent.id).length, 1);
    assert.equal(f.pushes.includes(`question:${openEvent.id}`), true);
    assert.equal((await f.call('POST', escalatePath, { note: 'again' }, undefined, 'root-1')).status, 409);

    const hidden = await f.call('GET', '/api/sessions/root-1/attention/routed', undefined, undefined, 'child-a');
    assert.equal(hidden.status, 403);
    const listed = await f.call('GET', '/api/sessions/root-1/attention/routed', undefined, undefined, 'root-1');
    assert.equal(listed.status, 200);
    const items = listed.body.items as Array<{ sessionId: string; event: AttentionItem }>;
    assert.equal(items.some((item) => item.event.id === event.id), false);
    assert.equal(items.some((item) => item.event.id === openEvent.id), false);
  });

  it('lists open parent-routed items and escalates them when the parent exits', async (t) => {
    const f = await coordFixture(t);
    const notices: HookEvent[] = [];
    f.server.on('event', (event) => notices.push(event));
    const created = await f.call('POST', '/api/sessions/child-a/attention', {
      title: 'Still open',
      message: 'Waiting on the parent',
    });
    const event = created.body.event as AttentionItem;
    const listed = await f.call('GET', '/api/sessions/root-1/attention/routed', undefined, undefined, 'root-1');
    const items = listed.body.items as Array<{ sessionId: string; sessionName: string; event: AttentionItem }>;
    assert.equal(items.length, 1);
    assert.equal(items[0].sessionId, 'child-a');
    assert.equal(items[0].sessionName, 'Worker A');
    assert.equal(items[0].event.id, event.id);
    assert.equal(f.pushes.includes(`question:${event.id}`), false);

    await f.store.saveSession({ ...f.root, status: 'completed' });
    await f.coordination.onSessionExit('root-1');
    const page = await f.attention.list('child-a');
    const updated = page.events.find((item) => item.id === event.id);
    assert.ok(updated);
    assert.equal(updated?.route, 'human');
    assert.equal(updated?.escalationNote, PARENT_UNAVAILABLE_NOTE);
    assert.ok(updated?.escalatedAt);
    assert.equal(notices.filter((notice) => notice.eventName === 'Notification' && notice.data.attentionId === event.id).length, 1);
    assert.equal(f.pushes.includes(`question:${event.id}`), true);
    const after = await f.call('GET', '/api/sessions/root-1/attention/routed', undefined, undefined, 'root-1');
    assert.deepEqual(after.body.items, []);
  });

  it('routes directly to the human when the parent is not running', async (t) => {
    const f = await coordFixture(t);
    const notices: HookEvent[] = [];
    f.server.on('event', (event) => notices.push(event));
    await f.store.saveSession({ ...f.root, status: 'completed' });
    const res = await f.call('POST', '/api/sessions/child-a/attention', { title: 'Hi', message: 'Need you' });
    assert.equal(res.status, 200);
    const event = res.body.event as AttentionItem;
    assert.equal(event.route, undefined);
    assert.equal(notices.filter((notice) => notice.data.attentionId === event.id).length, 1);
    assert.equal((await f.mail.listAll('root-1', 10)).length, 0);
    assert.equal(f.pushes.includes(`question:${event.id}`), true);
  });

  it('falls back to the human when parent question mail fails', async (t) => {
    const f = await coordFixture(t);
    const notices: HookEvent[] = [];
    f.server.on('event', (event) => notices.push(event));
    f.server.acceptSessionMail = async () => ({ ok: false, error: 'inbox unavailable' });
    const refused = await f.call('POST', '/api/sessions/child-a/attention', { title: 'Q', message: 'Need you' });
    assert.equal(refused.status, 200);
    const refusedEvent = refused.body.event as AttentionItem;
    assert.equal(refusedEvent.route, 'human');
    assert.equal(refusedEvent.escalationNote, PARENT_UNAVAILABLE_NOTE);
    assert.ok(refusedEvent.escalatedAt);
    assert.equal(notices.filter((notice) => notice.data.attentionId === refusedEvent.id).length, 1);
    assert.equal(f.pushes.filter((key) => key === `question:${refusedEvent.id}`).length, 1);
    assert.equal((await f.mail.listAll('root-1', 10)).length, 0);

    f.server.acceptSessionMail = async () => { throw new Error('mail store down'); };
    const thrown = await f.call('POST', '/api/sessions/child-b/attention', { title: 'Q2', message: 'Need you too' });
    const thrownEvent = thrown.body.event as AttentionItem;
    assert.equal(thrownEvent.route, 'human');
    assert.equal(thrownEvent.escalationNote, PARENT_UNAVAILABLE_NOTE);
    assert.equal(notices.filter((notice) => notice.data.attentionId === thrownEvent.id).length, 1);
    assert.equal(f.pushes.filter((key) => key === `question:${thrownEvent.id}`).length, 1);
  });

  it('suppresses only the new parent-routed item push and still delivers an unrelated one', async (t) => {
    const f = await coordFixture(t);
    const internal = f.attention as unknown as {
      onNotification?: (sessionId: string, notice: PushNotice) => void;
      record: AttentionStore['record'];
    };
    const original = internal.record.bind(f.attention);
    internal.record = async (id, eventName, data, options) => {
      internal.onNotification?.(id, {
        kind: 'question',
        eventKey: 'question:other-item',
        title: 'Other',
        message: 'Unrelated',
        occurredAt: '2026-11-13T12:00:00.000Z',
      });
      return original(id, eventName, data, options);
    };
    const res = await f.call('POST', '/api/sessions/child-a/attention', { title: 'Q', message: 'Need a decision' });
    const event = res.body.event as AttentionItem;
    assert.equal(event.route, 'parent');
    assert.equal(f.pushes.includes('question:other-item'), true);
    assert.equal(f.pushes.includes(`question:${event.id}`), false);
  });

  it('keeps a human-routed repeat on the human path with its notice and push', async (t) => {
    const f = await coordFixture(t);
    const notices: HookEvent[] = [];
    f.server.on('event', (event) => notices.push(event));
    const first = await f.call('POST', '/api/sessions/child-a/attention', {
      title: 'Need a secret',
      message: 'Paste the token',
      to: 'human',
    });
    const event = first.body.event as AttentionItem;
    assert.equal(event.route, undefined);
    assert.equal(notices.filter((notice) => notice.data.attentionId === event.id).length, 1);
    assert.equal(f.pushes.filter((key) => key === `question:${event.id}`).length, 1);

    const repeat = await f.call('POST', '/api/sessions/child-a/attention', {
      title: 'Need a secret',
      message: 'Paste the token',
    });
    const again = repeat.body.event as AttentionItem;
    assert.equal(again.id, event.id);
    assert.equal(again.occurrences, 2);
    assert.equal(again.route, undefined);
    assert.equal(notices.filter((notice) => notice.data.attentionId === event.id).length, 2);
    assert.equal(f.pushes.filter((key) => key === `question:${event.id}`).length, 1);
    assert.equal((await f.mail.listAll('root-1', 10)).length, 0);
  });

  it('publishes one notice when parent escalate races parent exit', async (t) => {
    const f = await coordFixture(t);
    const notices: HookEvent[] = [];
    f.server.on('event', (event) => notices.push(event));
    const created = await f.call('POST', '/api/sessions/child-a/attention', {
      title: 'Race',
      message: 'Pick one',
    });
    const event = created.body.event as AttentionItem;
    await f.store.saveSession({ ...f.root, status: 'completed' });
    const [escalated] = await Promise.all([
      f.call('POST', `/api/sessions/child-a/attention/${event.id}/escalate`, { note: 'I cannot answer' }, undefined, 'root-1'),
      f.coordination.onSessionExit('root-1'),
    ]);
    assert.ok(escalated.status === 200 || escalated.status === 409);
    const stored = (await f.attention.list('child-a')).events.find((item) => item.id === event.id);
    assert.equal(stored?.route, 'human');
    assert.equal(notices.filter((notice) => notice.eventName === 'Notification' && notice.data.attentionId === event.id).length, 1);
    assert.equal(f.pushes.filter((key) => key === `question:${event.id}`).length, 1);
  });

  it('dispatches brief and worktree route modules before per-session routes', async (t) => {
    const f = await coordFixture(t);
    const brief = await f.call('GET', '/api/sessions/child-a/brief');
    assert.equal(brief.status, 200);
    assert.equal(brief.body.brief, null);
    assert.equal((await f.call('GET', '/api/sessions/missing-session/brief')).status, 404);
    const worktrees = await f.call('GET', '/api/worktrees');
    assert.equal(worktrees.status, 200);
    assert.deepEqual(worktrees.body.worktrees, []);
    assert.equal((await f.call('GET', '/api/worktrees?extra=1')).status, 400);
  });

  it('validates DELETE worktree query and returns worktreeOutcome', async (t) => {
    const f = await coordFixture(t);
    const bad = await f.call('DELETE', '/api/sessions/child-a?worktree=maybe');
    assert.equal(bad.status, 400);
    assert.ok(await f.store.loadSession('child-a'));
    assert.equal((await f.call('DELETE', '/api/sessions/child-a?worktree=keep&worktree=force')).status, 400);

    await f.store.saveSession({
      ...f.childB,
      worktree: {
        repoRoot: '/repo',
        path: '/repo/.claude/worktrees/child-b',
        branch: 'ftown/child-b',
        base: 'main',
        createdByBridge: true,
      },
    });
    const keep = await f.call('DELETE', '/api/sessions/child-b?worktree=keep');
    assert.equal(keep.status, 200);
    assert.equal(keep.body.removed, true);
    assert.deepEqual(keep.body.worktreeOutcome, { action: 'retained', reason: 'kept by request' });
    assert.equal(await f.store.loadSession('child-b'), null);

    const plain = await f.call('DELETE', '/api/sessions/child-a');
    assert.equal(plain.status, 200);
    assert.equal(plain.body.removed, true);
    assert.equal(plain.body.worktreeOutcome, undefined);
    assert.equal(await f.store.loadSession('child-a'), null);
  });

  it('routes a child question to the human when the parent is removed', async (t) => {
    const f = await coordFixture(t);
    const notices: HookEvent[] = [];
    f.server.on('event', (event) => notices.push(event));
    const created = await f.call('POST', '/api/sessions/child-a/attention', {
      title: 'Still open',
      message: 'Waiting on the parent',
    });
    const event = created.body.event as AttentionItem;
    assert.equal(event.route, 'parent');
    assert.equal(f.pushes.includes(`question:${event.id}`), false);

    const removed = await f.call('DELETE', '/api/sessions/root-1');
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
    assert.equal(await f.store.loadSession('root-1'), null);

    const updated = (await f.attention.list('child-a')).events.find((item) => item.id === event.id);
    assert.equal(updated?.route, 'human');
    assert.equal(updated?.escalationNote, PARENT_UNAVAILABLE_NOTE);
    assert.ok(updated?.escalatedAt);
    assert.equal(
      notices.filter((notice) => notice.eventName === 'Notification' && notice.data.attentionId === event.id).length,
      1,
    );
    assert.equal(f.pushes.filter((key) => key === `question:${event.id}`).length, 1);
  });

  it('routes a child question to the human when the parent is stopped', async (t) => {
    const f = await coordFixture(t);
    const notices: HookEvent[] = [];
    f.server.on('event', (event) => notices.push(event));
    const created = await f.call('POST', '/api/sessions/child-a/attention', {
      title: 'Still open',
      message: 'Waiting on the parent',
    });
    const event = created.body.event as AttentionItem;
    assert.equal(event.route, 'parent');
    assert.equal(f.pushes.includes(`question:${event.id}`), false);

    f.server.setSessionController(new SessionController({
      store: f.store,
      runner: { stop: () => true },
      publishSessionUpdate: async () => {},
      removeSession: async () => null,
      publishSyntheticStop: () => {},
      withSessionWrite: async (_sessionId, task) => { await task(); },
      unregisterSession: () => {},
      onSessionEnding: (session) => f.coordination.onSessionExit(session.id, session),
    }));

    const stopped = await f.call('POST', '/api/sessions/root-1/stop');
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.stopped, true);
    assert.equal((await f.store.loadSession('root-1'))?.status, 'completed');

    const updated = (await f.attention.list('child-a')).events.find((item) => item.id === event.id);
    assert.equal(updated?.route, 'human');
    assert.equal(updated?.escalationNote, PARENT_UNAVAILABLE_NOTE);
    assert.equal(
      notices.filter((notice) => notice.eventName === 'Notification' && notice.data.attentionId === event.id).length,
      1,
    );
    assert.equal(f.pushes.filter((key) => key === `question:${event.id}`).length, 1);
  });

  it('serves plan routes beside brief and worktrees', async (t) => {
    const f = await coordFixture(t);

    const missing = await f.call('GET', '/api/sessions/missing/plan');
    assert.equal(missing.status, 404);

    const listed = await f.call('GET', '/api/sessions/root-1/plan');
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.body.items));
    assert.ok(Array.isArray(listed.body.ready));

    const created = await f.call('POST', '/api/sessions/root-1/plan', { title: 'Ship the board' });
    assert.equal(created.status, 200);
    const item = created.body.item as { id: string; title: string; state: string };
    assert.equal(item.title, 'Ship the board');
    assert.equal(item.state, 'todo');
    assert.match(item.id, /^p\d+$/);

    const unknownKey = await f.call('POST', '/api/sessions/root-1/plan', { title: 'Nope', extra: true });
    assert.equal(unknownKey.status, 400);

    const wrongMethod = await f.call('PUT', '/api/sessions/root-1/plan', { title: 'Nope' });
    assert.equal(wrongMethod.status, 405);
  });
});

describe('LocalApiServer worktree create', () => {
  it('maps WorktreeError on POST /api/sessions to 400 and creates no session', async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'ftw-worktree-create-'));
    const server = new LocalApiServer();
    const token = 'worktree-token';
    const store = new SessionStore(join(home, 'data'));
    const runner = {
      getPreferredRuntime: () => 'direct',
      run: () => {},
      stop: () => false,
      isRunning: () => false,
    } as unknown as ProcessRunner;
    const centrifugo = { publishSessionUpdate: async () => {} } as unknown as CentrifugoClient;
    server.setAuthToken(token);
    server.setDependencies(store, runner, centrifugo, 'user-1');
    server.setSessionFactory({
      store,
      runner,
      centrifugo,
      userId: 'user-1',
      bridgeId: 'bridge-1',
      hookPort: 4321,
      hookToken: 'hook-token',
      notifyScriptPath: '/tmp/notify.sh',
      wireTerminalInput: () => {},
      worktrees: {
        create: async () => {
          throw new WorktreeError('not_a_repo', 'not a git repository');
        },
        remove: async () => {},
      },
    });
    const port = await server.start();
    t.after(() => {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    });

    const invalid = await api(port, token, 'POST', '/api/sessions', {
      shellType: 'claude',
      prompt: 'build it',
      worktree: { branch: 1 },
    });
    assert.equal(invalid.status, 400);
    assert.match(String(invalid.data.error), /Invalid worktree option/);
    assert.equal((await store.listSessions()).length, 0);

    const failed = await api(port, token, 'POST', '/api/sessions', {
      shellType: 'claude',
      prompt: 'build it',
      worktree: true,
    });
    assert.equal(failed.status, 400);
    assert.equal(failed.data.error, 'not a git repository');
    assert.equal((await store.listSessions()).length, 0);
  });

  it('maps PlanItemError on POST /api/sessions to 400 and creates no session', async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'ftw-plan-item-create-'));
    const server = new LocalApiServer();
    const token = 'plan-item-token';
    const store = new SessionStore(join(home, 'data'));
    const runner = {
      getPreferredRuntime: () => 'direct',
      run: () => { throw new Error('must not launch'); },
      stop: () => false,
      isRunning: () => false,
    } as unknown as ProcessRunner;
    const centrifugo = { publishSessionUpdate: async () => {} } as unknown as CentrifugoClient;
    await store.saveSession({
      id: 'parent-1',
      name: 'Parent',
      command: 'claude',
      status: 'running',
      bridgeId: 'bridge-1',
      createdAt: '2026-11-13T10:00:00.000Z',
      updatedAt: '2026-11-13T10:00:00.000Z',
    });
    server.setAuthToken(token);
    server.setDependencies(store, runner, centrifugo, 'user-1');
    server.setSessionFactory({
      store,
      runner,
      centrifugo,
      userId: 'user-1',
      bridgeId: 'bridge-1',
      hookPort: 4321,
      hookToken: 'hook-token',
      notifyScriptPath: '/tmp/notify.sh',
      wireTerminalInput: () => {},
      planStore: {
        get: async () => ({
          seq: 1,
          items: [{
            id: 'p1',
            title: 'Already going',
            after: [],
            priority: 2,
            state: 'started',
            createdAt: '2026-11-13T10:00:00.000Z',
            updatedAt: '2026-11-13T10:00:00.000Z',
          }],
        }),
        startForChild: async () => { throw new Error('must not start'); },
      },
    });
    const port = await server.start();
    t.after(() => {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    });

    const started = await api(port, token, 'POST', '/api/sessions', {
      shellType: 'claude',
      prompt: 'work',
      parentSessionId: 'parent-1',
      planItem: 'p1',
    });
    assert.equal(started.status, 400);
    assert.match(String(started.data.error), /not todo/);

    const missing = await api(port, token, 'POST', '/api/sessions', {
      shellType: 'claude',
      prompt: 'work',
      parentSessionId: 'parent-1',
      planItem: 'p9',
    });
    assert.equal(missing.status, 400);
    assert.match(String(missing.data.error), /does not exist/);

    const noParent = await api(port, token, 'POST', '/api/sessions', {
      shellType: 'claude',
      prompt: 'work',
      planItem: 'p1',
    });
    assert.equal(noParent.status, 400);
    assert.match(String(noParent.data.error), /requires a parent/);
    assert.deepEqual((await store.listSessions()).map((session) => session.id), ['parent-1']);
  });
});

describe('LocalApiServer shellType alias and validation', () => {
  it('maps shellType agy to canonical antigravity and stores it on POST /api/sessions', async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'ftw-shell-alias-'));
    const server = new LocalApiServer();
    const token = 'alias-token';
    const store = new SessionStore(join(home, 'data'));
    const runs: Array<{ command: string }> = [];
    const runner = {
      getPreferredRuntime: () => 'direct',
      run: (id: string, command: string) => { runs.push({ command }); },
      stop: () => false,
      isRunning: () => false,
    } as unknown as ProcessRunner;
    const centrifugo = { publishSessionUpdate: async () => {} } as unknown as CentrifugoClient;
    server.setAuthToken(token);
    server.setDependencies(store, runner, centrifugo, 'user-1');
    server.setSessionFactory({
      store,
      runner,
      centrifugo,
      userId: 'user-1',
      bridgeId: 'bridge-1',
      hookPort: 4321,
      hookToken: 'hook-token',
      notifyScriptPath: '/tmp/notify.sh',
      wireTerminalInput: () => {},
    });
    const port = await server.start();
    t.after(() => {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    });

    const res = await api(port, token, 'POST', '/api/sessions', {
      shellType: 'agy',
      model: 'gemini-4-hydrogen-medium',
      prompt: 'hello world',
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.session.shellType, 'antigravity');
    const stored = await store.listSessions();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].shellType, 'antigravity');
    assert.match(stored[0].command, /^agy --dangerously-skip-permissions --model 'gemini-4-hydrogen-medium'/);
  });

  it('rejects unknown shellType with 400 listing valid values on POST /api/sessions', async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'ftw-shell-reject-'));
    const server = new LocalApiServer();
    const token = 'reject-token';
    const store = new SessionStore(join(home, 'data'));
    const runner = {
      getPreferredRuntime: () => 'direct',
      run: () => { throw new Error('must not launch'); },
      stop: () => false,
      isRunning: () => false,
    } as unknown as ProcessRunner;
    const centrifugo = { publishSessionUpdate: async () => {} } as unknown as CentrifugoClient;
    server.setAuthToken(token);
    server.setDependencies(store, runner, centrifugo, 'user-1');
    server.setSessionFactory({
      store,
      runner,
      centrifugo,
      userId: 'user-1',
      bridgeId: 'bridge-1',
      hookPort: 4321,
      hookToken: 'hook-token',
      notifyScriptPath: '/tmp/notify.sh',
      wireTerminalInput: () => {},
    });
    const port = await server.start();
    t.after(() => {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    });

    const res = await api(port, token, 'POST', '/api/sessions', {
      shellType: 'bogus-harness',
      prompt: 'hello world',
    });
    assert.equal(res.status, 400);
    assert.match(String(res.data.error), /Invalid shellType "bogus-harness"/);
    assert.match(String(res.data.error), /Valid values:/);
    assert.match(String(res.data.error), /antigravity/);
    assert.match(String(res.data.error), /agy/);
    assert.equal((await store.listSessions()).length, 0);
  });
});
