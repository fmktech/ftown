import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { generateEndpoint, open, seal } from '../crypto.js';
import type { ApplicationJson, EndpointIdentity, InboundTransportContext, LocalEventPage, SecureApplication, SecureEnvelope } from '../protocol.js';
import { BridgeSecurityService } from './security.js';
import { executeSecurePacket } from './execute.js';
import { CentrifugoClient } from '../../centrifugo-client.js';
import { nativeWake } from './native-wake.js';
import type { Session } from '../../types.js';
import { LocalApiServer } from '../../local-api-server.js';
import { SessionStore } from '../../session-store.js';
import { SessionController } from '../../session-controller.js';
import { AttentionStore, AttentionError } from '../../attention-store.js';
import type { ProcessRunner } from '../../claude-runner.js';
import { EncryptedPeerChannel } from './direct.js';
import type { DirectMessage } from '../../direct-transport/contract.js';
import { createAccountRelay } from '../../ledger-relay.js';
import { HEAD_ANNOUNCE_MAX_AGE_MS, signHeadAnnouncement, verifyHeadAnnouncement, type HeadAnnouncement } from '../ledger/announce.js';
import { accountIdOf, ledgerChallenge, ledgerHeads, ledgerLastIssuedAt, ledgerRevocations, nextTransition, verifyLedger } from '../ledger/ledger.js';
import { generateAuthKey } from '../ledger/proof.js';
import type { Ledger, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from '../ledger/protocol.js';
import { createSoftPasskey, type SoftPasskey } from '../ledger/testing.js';
import { BridgeLedgerStore } from './ledger-store.js';

const owner = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-security-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const identity = await generateEndpoint(owner, 'bridge');
  const client = await generateEndpoint(owner, 'local-cli');
  const security = new BridgeSecurityService(identity, 'bridge', dir, { relayUserId: 'owner@example.test' });
  await security.policy.provisionLocalEndpoint(client.endpoint);
  const route: InboundTransportContext = { transport: 'cloud', bridgeId: 'bridge', channel: 'commands:rpc#owner@example.test', pairId: null };
  const packet = async (application: SecureApplication, context = route, sender = client, epoch: string = security.receiverEpoch) => {
    const requestId = application.route.kind === 'http' || application.route.kind === 'command' || application.route.kind === 'response' ? application.route.requestId : randomUUID();
    return seal(sender, identity.endpoint, { type: 'ftown_encrypted', version: 1, senderId: sender.endpoint.id, recipientId: identity.endpoint.id,
      ownerId: owner, bridgeId: 'bridge', channel: context.channel, purpose: 'application', messageId: requestId,
      createdAt: Date.now(), expiresAt: Date.now() + 60000, receiverEpoch: epoch }, new TextEncoder().encode(JSON.stringify(application)));
  };
  return { dir, identity, client, security, route, packet };
}

test('browser control cannot register preview through encrypted HTTP and causes no session mutation', async t => {
  const f = await fixture(t);
  const browser = await generateEndpoint(owner, 'browser');
  const invite = await f.security.policy.createInvitation(await f.security.policy.principal(f.client.endpoint.id), { label: 'browser' });
  await f.security.policy.consumeInvitation({ type: 'enroll', candidate: browser.endpoint, invitationId: invite.invitationId, invitationSecret: invite.secret, label: 'browser' });
  const store = new SessionStore(join(f.dir, 'sessions'));
  await store.saveSession({ id: 'session', name: 'test', command: '', status: 'running', bridgeId: 'bridge', createdAt: '', updatedAt: '', workingDir: f.dir });
  let publications = 0;
  const controller = new SessionController({ store, runner: { stop: () => true }, publishSessionUpdate: async () => { publications++; }, removeSession: async () => null });
  const api = new LocalApiServer(); api.setSessionController(controller);
  api.setSecurity(f.security, { protocolVersion: 1, ownerId: owner, bridgeId: 'bridge', endpoint: f.identity.endpoint, relayUserId: 'owner@example.test' }, async () => null);
  const requestId = randomUUID();
  const app: SecureApplication = { type: 'application', route: { kind: 'http', requestId, method: 'PUT', path: '/api/sessions/session/preview' }, data: { body: { path: join(f.dir, 'private.html') } }, mcp: null };
  const packet = await f.packet(app, f.route, browser);
  const reply = await executeSecurePacket(f.security, packet, f.route, message => api.dispatchSecure(message));
  const plaintext = await open(browser, f.identity.endpoint, reply, { ownerId: owner, bridgeId: 'bridge', channel: f.route.channel, recipientId: browser.endpoint.id, purpose: 'application' });
  const value = JSON.parse(new TextDecoder().decode(plaintext));
  assert.equal(value.data.status, 403); assert.equal(value.data.body.code, 'permission_denied');
  assert.equal((await store.loadSession('session'))?.preview, undefined); assert.equal(publications, 0);
  await f.security.close();
});

test('encrypted archive response omits preview source paths', async t => {
  const f = await fixture(t);
  const store = new SessionStore(join(f.dir, 'archive-data'));
  const path = join(f.dir, 'private.html');
  await store.archiveSession({ id: 'session', name: 'test', command: '', status: 'completed', bridgeId: 'bridge', createdAt: '', updatedAt: '',
    preview: { id: randomUUID(), fileName: 'private.html' }, previewSource: { version: 1, id: randomUUID(), root: f.dir, filePath: path } });
  const api = new LocalApiServer();
  const runner = new EventEmitter() as ProcessRunner;
  const cloud = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '');
  api.setDependencies(store, runner, cloud, 'owner@example.test');
  api.setSecurity(f.security, { protocolVersion: 1, ownerId: owner, bridgeId: 'bridge', endpoint: f.identity.endpoint, relayUserId: 'owner@example.test' }, async () => null);
  const requestId = randomUUID();
  const app: SecureApplication = { type: 'application', route: { kind: 'http', requestId, method: 'GET', path: '/api/archive' }, data: {}, mcp: null };
  const reply = await executeSecurePacket(f.security, await f.packet(app), f.route, message => api.dispatchSecure(message));
  const plaintext = await open(f.client, f.identity.endpoint, reply, { ownerId: owner, bridgeId: 'bridge', channel: f.route.channel, recipientId: f.client.endpoint.id, purpose: 'application' });
  const value = new TextDecoder().decode(plaintext);
  assert.ok(!value.includes('previewSource')); assert.ok(!value.includes(path)); assert.ok(value.includes('private.html'));
  api.stop(); await f.security.close();
});

test('authenticated application admission rejects replay, wrong epoch/context and tampering before dispatch', async t => {
  const f = await fixture(t);
  const app: SecureApplication = { type: 'application', route: { kind: 'http', method: 'GET', path: '/api/sessions', requestId: randomUUID() }, data: {}, mcp: null };
  const packet = await f.packet(app);
  let dispatched = 0;
  const run = () => executeSecurePacket(f.security, packet, f.route, async () => { dispatched++; return { status: 200, body: { sessions: [] } }; });
  await run(); await run();
  assert.equal(dispatched, 1);
  const stale = await f.packet({ ...app, route: { kind: 'http', method: 'GET', path: '/api/sessions', requestId: randomUUID() } }, f.route, f.client, 'old-boot');
  await executeSecurePacket(f.security, stale, f.route, async () => { dispatched++; return null; });
  assert.equal(dispatched, 1);
  await assert.rejects(f.security.acceptApplication(await f.packet(app), { ...f.route, channel: 'terminal-input:session#owner@example.test' }), { code: 'wrong_context' });
  const tampered = Buffer.from(packet.ciphertext, 'base64url'); tampered[0] ^= 1;
  await assert.rejects(executeSecurePacket(f.security, { ...packet, ciphertext: tampered.toString('base64url') }, f.route,
    async () => { dispatched++; return null; }));
  assert.equal(dispatched, 1);
});

test('held cloud read dispatch does not block an unrelated terminal input or control operation', async t => {
  const f = await fixture(t);
  const subscriptions = new Map<string, EventEmitter>();
  const publications: unknown[] = [];
  const wire = { state: 'connected', newSubscription: (channel: string) => {
    const sub = Object.assign(new EventEmitter(), { subscribe() {}, unsubscribe() {} }); subscriptions.set(channel, sub); return sub;
  }, publish: async (_channel: string, packet: unknown) => { publications.push(packet); } };
  const cloud = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '');
  Object.defineProperty(cloud, 'client', { value: wire }); cloud.setSecurity(f.security);
  let release!: () => void; let readStarted!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  let controls = 0; let keys = '';
  cloud.subscribeSecureCommands('owner@example.test', async message => {
    if (message.application.route.kind === 'http' && message.application.route.method === 'GET') { readStarted(); await held; }
    else controls++;
    return { status: 200, body: {} };
  });
  cloud.subscribeToTerminalInput('owner@example.test', 'session', (_id, data) => { keys += data; }, () => {});
  const read = await f.packet({ type: 'application', route: { kind: 'http', requestId: randomUUID(), method: 'GET',
    path: '/api/sessions/session/inbox?peek=1&wait=30' }, data: {}, mcp: null });
  subscriptions.get(f.route.channel)!.emit('publication', { info: { user: 'owner@example.test' }, data: read });
  await started;
  const control = await f.packet({ type: 'application', route: { kind: 'http', requestId: randomUUID(), method: 'POST',
    path: '/api/sessions/session/stop' }, data: {}, mcp: null });
  subscriptions.get(f.route.channel)!.emit('publication', { info: { user: 'owner@example.test' }, data: control });
  const terminalRoute = { ...f.route, channel: 'terminal-input:session#owner@example.test' };
  const input = await f.packet({ type: 'application', route: { kind: 'terminal', frameType: 'input', sessionId: 'session', pairId: null },
    data: { kind: 'input', sessionId: 'session', data: 'typed' }, mcp: null }, terminalRoute);
  subscriptions.get(terminalRoute.channel)!.emit('publication', { info: { user: 'owner@example.test' }, data: input });
  for (let attempt = 0; attempt < 100 && (keys !== 'typed' || controls !== 1); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controls, 1); assert.equal(keys, 'typed');
  release(); await f.security.close();
});

test('native wake IPC returns unread IDs only, never consumes mail or accepts another native target', async () => {
  const session = { id: 'ftown', claudeSessionId: 'native' } as Session;
  let leases = 0;
  const deps = { getSession: async () => session, register: () => { leases++; },
    unread: async () => [{ id: 'opaque', body: 'PRIVATE MAIL' }], busy: () => false };
  const payload = { hook_event_name: 'FtownNativeWake', ftown_session_id: 'ftown', session_id: 'native', adapter: 'claude-mod' };
  assert.deepEqual(await nativeWake(payload, deps), { messages: [{ id: 'opaque' }] });
  assert.equal(leases, 1);
  await nativeWake({ ...payload, registerWake: false }, deps); assert.equal(leases, 1);
  await assert.rejects(nativeWake({ ...payload, session_id: 'other-native' }, deps), { code: 'wrong_context' });
  await assert.rejects(nativeWake({ ...payload, path: '/api/sessions', consume: true }, deps));
});

test('native wake reports a mid-turn session as busy and still renews its lease', async () => {
  const session = { id: 'ftown', claudeSessionId: 'native' } as Session;
  let leases = 0;
  const deps = { getSession: async () => session, register: () => { leases++; },
    unread: async () => [{ id: 'opaque', body: 'PRIVATE MAIL' }], busy: () => true };
  const payload = { hook_event_name: 'FtownNativeWake', ftown_session_id: 'ftown', session_id: 'native', adapter: 'claude-mod' };
  assert.deepEqual(await nativeWake(payload, deps), { messages: [{ id: 'opaque' }], busy: true });
  assert.equal(leases, 1);
});

test('native wake omits the busy key when the session is idle', async () => {
  const session = { id: 'ftown', claudeSessionId: 'native' } as Session;
  const deps = { getSession: async () => session, register: () => {},
    unread: async () => [{ id: 'opaque', body: 'PRIVATE MAIL' }], busy: () => false };
  const payload = { hook_event_name: 'FtownNativeWake', ftown_session_id: 'ftown', session_id: 'native', adapter: 'claude-mod' };
  const result = await nativeWake(payload, deps);
  assert.deepEqual(result, { messages: [{ id: 'opaque' }] });
  assert.equal('busy' in result, false);
});

test('native wake asks busy about the FTown session id, not the native id', async () => {
  const session = { id: 'ftown', claudeSessionId: 'native' } as Session;
  const asked: string[] = [];
  const deps = { getSession: async () => session, register: () => {},
    unread: async () => [], busy: (id: string) => { asked.push(id); return false; } };
  const payload = { hook_event_name: 'FtownNativeWake', ftown_session_id: 'ftown', session_id: 'native', adapter: 'claude-mod' };
  await nativeWake(payload, deps);
  assert.deepEqual(asked, ['ftown']);
});

test('local event pages advance past oversized events and signal a resync without truncating payloads', async t => {
  const f = await fixture(t);
  const server = new LocalApiServer();
  server.setSecurity(f.security, { protocolVersion: 1, ownerId: owner, bridgeId: 'bridge', endpoint: f.identity.endpoint,
    relayUserId: 'owner@example.test' }, async () => null);
  const read = async (after: number) => {
    const application: SecureApplication = { type: 'application', route: { kind: 'http', method: 'GET',
      path: `/api/browser/events?after=${after}`, requestId: randomUUID() }, data: {}, mcp: null };
    const verified = await f.security.acceptApplication(await f.packet(application), f.route);
    return await server.dispatchSecure(verified) as unknown as LocalEventPage;
  };
  server.recordPublication('session-output', 'x'.repeat(260000));
  const skipped = await read(0);
  assert.deepEqual(skipped, { events: [], cursor: 1, reset: true });
  server.recordPublication('session-update', { id: 'session' });
  const next = await read(skipped.cursor);
  assert.deepEqual(next, { events: [{ channel: 'session-update', data: { id: 'session' }, cursor: 2 }], cursor: 2, reset: false });
});

test('encrypted local POST bodies parse as bytes and preserve validation and attention storage errors without a listener', async t => {
  const f = await fixture(t);
  const server = new LocalApiServer();
  const store = new SessionStore(join(f.dir, 'sessions'));
  await store.saveSession({ id: 'session', name: 'Session', command: 'test', status: 'running', bridgeId: 'bridge', createdAt: '', updatedAt: '' });
  server.setDependencies(store, {} as ProcessRunner, {} as CentrifugoClient, 'owner@example.test');
  server.setAttentionStore(new AttentionStore(id => store.sessionDir(id)));
  server.setSecurity(f.security, { protocolVersion: 1, ownerId: owner, bridgeId: 'bridge', endpoint: f.identity.endpoint,
    relayUserId: 'owner@example.test' }, async () => null);
  let publications = 0;
  server.on('event', () => { publications++; });
  const post = async (body: ApplicationJson) => {
    const application: SecureApplication = { type: 'application', route: { kind: 'http', method: 'POST',
      path: '/api/sessions/session/attention', requestId: randomUUID() }, data: { body }, mcp: null };
    const reply = await executeSecurePacket(f.security, await f.packet(application), f.route, message => server.dispatchSecure(message));
    return JSON.parse(new TextDecoder().decode(await open(f.client, f.identity.endpoint, reply,
      { ownerId: owner, bridgeId: 'bridge', channel: f.route.channel, recipientId: f.client.endpoint.id, purpose: 'application' }))) as {
      data: { status: number; body: { event?: { message: string }; code?: string } } };
  };
  const accepted = await post({ message: 'A concrete encrypted request' });
  assert.equal(accepted.data.status, 200);
  assert.equal(accepted.data.body.event?.message, 'A concrete encrypted request');
  assert.equal(publications, 1);
  assert.equal((await post({ message: '' })).data.status, 400);
  class BrokenStore extends AttentionStore { override async record(): Promise<undefined> {
    throw new AttentionError('attention_storage_error', 'Attention history could not be persisted', 500);
  } }
  server.setAttentionStore(new BrokenStore(id => store.sessionDir(id)));
  const failed = await post({ message: 'Must not publish' });
  assert.equal(failed.data.status, 500); assert.equal(failed.data.body.code, 'attention_storage_error');
  assert.equal(publications, 1);
  server.stop();
});

test('self-revocation releases only its fixed correlated receipt after durable removal', async t => {
  const f = await fixture(t); const requestId = randomUUID();
  const application: SecureApplication = { type: 'application', route: { kind: 'command', command: 'security_revoke', requestId, sessionId: null },
    data: { type: 'security_revoke', requestId, payload: { bridgeId: 'bridge', endpointId: f.client.endpoint.id } }, mcp: null };
  let closures = 0;
  f.security.onRevoked(id => { assert.equal(id, f.client.endpoint.id); closures++; });
  const request = await f.packet(application);
  const response = await executeSecurePacket(f.security, request, f.route, async () => { throw new Error('Self-revoke must not dispatch arbitrary results'); });
  assert.equal(response.messageId, requestId); assert.equal(closures, 1);
  const receipt = JSON.parse(new TextDecoder().decode(await open(f.client, f.identity.endpoint, response,
    { ownerId: owner, bridgeId: 'bridge', channel: f.route.channel, recipientId: f.client.endpoint.id, purpose: 'application' })));
  assert.deepEqual(receipt, { type: 'application', route: { kind: 'response', requestId }, mcp: null,
    data: { type: 'command_response', response: { requestId, success: true, data: { endpointId: f.client.endpoint.id, revoked: true } } } });
  await assert.rejects(f.security.sealTo(f.client.endpoint.id, { type: 'application', route: { kind: 'publication' }, data: { private: 'must never deliver' }, mcp: null }, f.route), { code: 'approval_required' });
  await assert.rejects(executeSecurePacket(f.security, request, f.route, async () => { throw new Error('Must not execute replay'); }), { code: 'approval_required' });
  const restarted = new BridgeSecurityService(f.identity, 'bridge', f.dir, { relayUserId: 'owner@example.test' });
  await assert.rejects(restarted.policy.principal(f.client.endpoint.id), { code: 'approval_required' });
  await restarted.close();
});

test('failed self-revocation commit never returns a success receipt and leaves existing authority intact', async t => {
  const f = await fixture(t); const requestId = randomUUID();
  const application: SecureApplication = { type: 'application', route: { kind: 'command', command: 'security_revoke', requestId, sessionId: null },
    data: { type: 'security_revoke', requestId, payload: { bridgeId: 'bridge', endpointId: f.client.endpoint.id } }, mcp: null };
  t.mock.method(f.security.policy, 'revoke', async () => { throw new Error('Simulated durable commit failure'); });
  const response = await executeSecurePacket(f.security, await f.packet(application), f.route, async () => { throw new Error('Must not dispatch'); });
  const result = JSON.parse(new TextDecoder().decode(await open(f.client, f.identity.endpoint, response,
    { ownerId: owner, bridgeId: 'bridge', channel: f.route.channel, recipientId: f.client.endpoint.id, purpose: 'application' })));
  assert.equal(result.data.status, 403); assert.equal(result.data.response, undefined);
  assert.equal((await f.security.policy.principal(f.client.endpoint.id)).endpoint.id, f.client.endpoint.id);
});

test('an application carrying an MCP action context is never dispatched', async t => {
  const f = await fixture(t); let dispatches = 0;
  const context = { actionId: 'a', parentActionId: null, clientId: 'c', grantId: 'g', tool: 'sessions_list', operation: null };
  const request = await f.packet({ type: 'application', route: { kind: 'http', method: 'GET', path: '/api/sessions', requestId: randomUUID() },
    data: {}, mcp: context } as unknown as SecureApplication);
  await assert.rejects(executeSecurePacket(f.security, request, f.route, async () => { dispatches++; return { status: 200, body: {} }; }), { name: 'ZodError' });
  assert.equal(dispatches, 0);
  const control = await f.packet({ type: 'application', route: { kind: 'http', method: 'GET', path: '/api/sessions', requestId: randomUUID() },
    data: {}, mcp: null });
  await executeSecurePacket(f.security, control, f.route, async () => { dispatches++; return { status: 200, body: {} }; });
  assert.equal(dispatches, 1);
});

test('direct peers reject non-terminal routes and read-only peers cannot deliver input; control input is delivered', async t => {
  const f = await fixture(t);
  const browser = await generateEndpoint(owner, 'browser');
  const invite = await f.security.policy.createInvitation(await f.security.policy.principal(f.client.endpoint.id), { label: 'browser' });
  await f.security.policy.consumeInvitation({ type: 'enroll', candidate: browser.endpoint, invitationId: invite.invitationId, invitationSecret: invite.secret, label: 'browser' });
  await f.security.close();
  const file = join(f.dir, 'security', 'policy.json');
  const state = JSON.parse(await readFile(file, 'utf8')) as { devices: Array<{ endpoint: { id: string }; permissions: string[] }> };
  state.devices.find(device => device.endpoint.id === browser.endpoint.id)!.permissions = ['read'];
  await writeFile(file, JSON.stringify(state));
  const security = new BridgeSecurityService(f.identity, 'bridge', f.dir, { relayUserId: 'owner@example.test' });
  t.after(() => security.close());
  const deliveries: DirectMessage[] = [];
  let closures = 0;
  const peer = async (sender: EndpointIdentity) => {
    const route: InboundTransportContext = { transport: 'webrtc', bridgeId: 'bridge', pairId: randomUUID(), channel: '' };
    route.channel = `direct:webrtc:bridge:${route.pairId}`;
    let authorized = 0;
    const channel = new EncryptedPeerChannel(security, route, () => {}, frame => deliveries.push(frame), () => { authorized++; }, () => { closures++; });
    t.after(async () => channel.close());
    const hello = await seal(sender, f.identity.endpoint, { type: 'ftown_encrypted', version: 1, senderId: sender.endpoint.id,
      recipientId: f.identity.endpoint.id, ownerId: owner, bridgeId: 'bridge', channel: route.channel, purpose: 'hello', messageId: randomUUID(),
      createdAt: Date.now(), expiresAt: Date.now() + 60000, receiverEpoch: null }, new TextEncoder().encode(JSON.stringify({ type: 'hello', challenge: randomUUID() })));
    await channel.receive(JSON.stringify(hello)); assert.equal(authorized, 1);
    const send = async (app: SecureApplication) => {
      const id = app.route.kind === 'http' || app.route.kind === 'command' ? app.route.requestId : randomUUID();
      const packet = await seal(sender, f.identity.endpoint, { type: 'ftown_encrypted', version: 1, senderId: sender.endpoint.id, recipientId: f.identity.endpoint.id,
        ownerId: owner, bridgeId: 'bridge', channel: route.channel, purpose: 'application', messageId: id, createdAt: Date.now(),
        expiresAt: Date.now() + 60000, receiverEpoch: security.receiverEpoch }, new TextEncoder().encode(JSON.stringify(app)));
      return channel.receive(JSON.stringify(packet));
    };
    return { route, send };
  };
  for (const kind of ['command', 'http'] as const) {
    const p = await peer(f.client); const requestId = randomUUID();
    await p.send({ type: 'application', route: kind === 'command' ? { kind, requestId, command: 'list_sessions', sessionId: null }
      : { kind, requestId, method: 'GET', path: '/api/sessions' },
      data: kind === 'command' ? { type: 'list_sessions', requestId, payload: { bridgeId: 'bridge' } } : {}, mcp: null });
  }
  assert.deepEqual(deliveries, []); assert.equal(closures, 2);
  const reader = await peer(browser);
  await reader.send({ type: 'application', route: { kind: 'terminal', sessionId: 'victim', frameType: 'attach', pairId: reader.route.pairId },
    data: { kind: 'attach', sessionId: 'victim' }, mcp: null });
  assert.deepEqual(deliveries, [{ kind: 'attach', sessionId: 'victim' }]);
  await reader.send({ type: 'application', route: { kind: 'terminal', sessionId: 'victim', frameType: 'input', pairId: reader.route.pairId },
    data: { kind: 'input', sessionId: 'victim', data: 'PRIVATE-MARKER' }, mcp: null });
  assert.equal(deliveries.length, 1); assert.equal(closures, 3);
  const controller = await peer(f.client);
  await controller.send({ type: 'application', route: { kind: 'terminal', sessionId: 'victim', frameType: 'input', pairId: controller.route.pairId },
    data: { kind: 'input', sessionId: 'victim', data: 'authorized' }, mcp: null });
  assert.deepEqual(deliveries[1], { kind: 'input', sessionId: 'victim', data: 'authorized' });
});

// ---- Head announcements (CONTRACT §10/§13): verified against the trusted checkpoint, counted, paced. ----
const A_RP = 'ftown.example';
const A_ORIGIN = 'https://ftown.example';
const A_T0 = 1_750_000_000_000;
const A_START = A_T0 + 3_600_000;

async function aSigned<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload)) };
}
async function aAppend(ledger: Ledger, passkey: SoftPasskey, operation: LedgerOperation): Promise<Ledger> {
  const last = ledgerLastIssuedAt(ledger);
  const payload = nextTransition(await verifyLedger(ledger, A_START), passkey.credentialId, operation, last + 1000, last);
  return { genesis: ledger.genesis, transitions: [...ledger.transitions, await aSigned(passkey, payload)] };
}
interface AMember { kind: 'device' | 'bridge'; keyId: string; key: CryptoKey }
/** base: genesis + laptop + studio (this bridge) + phone + mini (another bridge) + revoke phone. longer: base + tablet. */
let announceWorld: Promise<{
  accountId: string; bridge: EndpointIdentity; bridgeAuth: string; bridgeKey: CryptoKey; laptop: AMember; phone: AMember; mini: AMember; outsider: AMember;
  base: Ledger; longer: Ledger; baseHeads: string[]; longerHead: string;
}> | null = null;
function aWorld() {
  announceWorld ??= (async () => {
    const passkey = await createSoftPasskey({ rpId: A_RP, origin: A_ORIGIN });
    const genesisRecord = await aSigned(passkey, {
      type: 'ftown_account_genesis', version: 2, rpId: A_RP, origins: [A_ORIGIN], handle: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
      createdAt: A_T0, authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'Keychain', addedAt: A_T0 },
    } satisfies LedgerGenesis);
    const accountId = await accountIdOf(genesisRecord.payload);
    const device = async (label: string) => {
      const identity = await generateEndpoint(accountId, 'browser');
      const auth = await generateAuthKey(false);
      return { member: { kind: 'device' as const, keyId: identity.endpoint.id, key: auth.privateKey },
        device: { endpoint: identity.endpoint, authPublicKey: auth.publicKey, label, approvedAt: A_T0 } };
    };
    const [laptop, phone, tablet, outsider] = await Promise.all(['Laptop', 'Phone', 'Tablet', 'Outsider'].map(device));
    const bridge = await generateEndpoint(accountId, 'bridge');
    const bridgeAuth = await generateAuthKey(false);
    const miniEndpoint = await generateEndpoint(accountId, 'bridge');
    const miniAuth = await generateAuthKey(false);
    let base: Ledger = { genesis: genesisRecord, transitions: [] };
    base = await aAppend(base, passkey, { type: 'add_device', device: laptop.device });
    base = await aAppend(base, passkey, { type: 'add_bridge', bridge: { bridgeId: 'studio', endpoint: bridge.endpoint, authPublicKey: bridgeAuth.publicKey, label: 'Studio', approvedAt: A_T0 } });
    base = await aAppend(base, passkey, { type: 'add_device', device: phone.device });
    base = await aAppend(base, passkey, { type: 'add_bridge', bridge: { bridgeId: 'mini', endpoint: miniEndpoint.endpoint, authPublicKey: miniAuth.publicKey, label: 'Mini', approvedAt: A_T0 } });
    base = await aAppend(base, passkey, { type: 'revoke_device', endpointId: phone.member.keyId });
    const longer = await aAppend(base, passkey, { type: 'add_device', device: tablet.device });
    return {
      accountId, bridge, bridgeAuth: bridgeAuth.publicKey, bridgeKey: bridgeAuth.privateKey, laptop: laptop.member, phone: phone.member,
      mini: { kind: 'bridge' as const, keyId: 'mini', key: miniAuth.privateKey }, outsider: outsider.member,
      base, longer, baseHeads: await ledgerHeads(base), longerHead: (await ledgerHeads(longer))[6],
    };
  })();
  return announceWorld;
}
/** A real ledger-mode service holding `base`; the server serves `served()` (counted). Wall clock fixed at A_START. */
async function announceHarness(t: { after(fn: () => Promise<void>): void }, stickyDevices: string[] = []) {
  const w = await aWorld();
  const dir = await mkdtemp(join(tmpdir(), 'ftown-announce-'));
  await mkdir(join(dir, 'security'), { recursive: true });
  await writeFile(join(dir, 'security', 'ledger.json'), JSON.stringify({ version: 1, ledger: w.base, checkpoint: await verifyLedger(w.base, A_START),
    sticky: { ...ledgerRevocations(w.base), deviceIds: [...ledgerRevocations(w.base).deviceIds, ...stickyDevices] }, lastServerReadAt: A_START }));
  const fetches = { count: 0 };
  let served: Ledger = w.base;
  const store = new BridgeLedgerStore(dir, { accountId: w.accountId, now: () => A_START, log: () => undefined });
  const security = new BridgeSecurityService(w.bridge, 'studio', dir, { relayUserId: w.accountId, now: () => A_START,
    ledger: { store, bridgeId: 'studio', authPublicKey: w.bridgeAuth, now: () => A_START, monotonic: () => 1_000,
      fetchLedger: async () => { fetches.count++; return structuredClone(served); } } });
  t.after(async () => { await security.close(); await rm(dir, { recursive: true, force: true }); });
  await security.startLedger();
  assert.equal(security.ledgerStatus().own, 'active');
  fetches.count = 0;
  return { w, security, fetches, serve: (ledger: Ledger) => { served = ledger; } };
}
/** Counts ECDSA verifications (WebCrypto) while installed. */
function countVerifications(t: { after(fn: () => void | Promise<void>): void }): { count: number } {
  const counter = { count: 0 };
  const subtle = crypto.subtle as SubtleCrypto & { verify: SubtleCrypto['verify'] };
  const original = subtle.verify;
  Object.defineProperty(subtle, 'verify', { configurable: true, writable: true, value: function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto['verify']>) {
    if ((args[0] as { name?: string }).name === 'ECDSA') counter.count++;
    return original.apply(this, args);
  } });
  t.after(() => { delete (subtle as { verify?: unknown }).verify; });
  return counter;
}
const announceFrom = (accountId: string, member: AMember, head: string, revision: number, at = A_START) =>
  signHeadAnnouncement(member.key, { accountId, kind: member.kind, keyId: member.keyId, head, revision, at });

test('judgeHeadAnnouncement verifies against the trusted checkpoint, relates the head, and counts accepted/dropped', async t => {
  const h = await announceHarness(t);
  const { w, security } = h;
  const verifications = countVerifications(t);
  assert.deepEqual(security.ledgerStatus().announcements, { accepted: 0, dropped: 0 });
  const tip = w.baseHeads[5];
  assert.equal(await security.judgeHeadAnnouncement(await announceFrom(w.accountId, w.laptop, tip, 5)), 'same');
  assert.equal(await security.judgeHeadAnnouncement(await announceFrom(w.accountId, w.laptop, w.baseHeads[3], 3)), 'behind');
  assert.equal(await security.judgeHeadAnnouncement(await announceFrom(w.accountId, w.mini, w.longerHead, 6)), 'unknown');
  assert.equal(await security.judgeHeadAnnouncement(await announceFrom(w.accountId, w.laptop, tip, 4)), 'unknown', 'a head at another revision is not ours');
  assert.deepEqual(security.ledgerStatus().announcements, { accepted: 4, dropped: 0 });
  assert.equal(verifications.count, 4, 'one signature check each');
  verifications.count = 0;
  const dropped = [
    // Forged: the laptop's id, another key.
    { ...(await announceFrom(w.accountId, { ...w.laptop, key: w.outsider.key }, w.longerHead, 6)) },
    // Revoked (sticky): the phone still holds a valid key.
    await announceFrom(w.accountId, w.phone, w.longerHead, 6),
    // Not a member.
    await announceFrom(w.accountId, w.outsider, w.longerHead, 6),
    // Stale and future, one ms past the bound.
    await announceFrom(w.accountId, w.laptop, w.longerHead, 6, A_START - HEAD_ANNOUNCE_MAX_AGE_MS - 1),
    await announceFrom(w.accountId, w.laptop, w.longerHead, 6, A_START + HEAD_ANNOUNCE_MAX_AGE_MS + 1),
    // Another account's announcement.
    await announceFrom(Buffer.alloc(32, 1).toString('base64url'), w.laptop, w.longerHead, 6),
    // Tampered after signing.
    { ...(await announceFrom(w.accountId, w.laptop, w.baseHeads[5], 5)), head: w.longerHead, revision: 6 },
  ];
  for (const announcement of dropped) assert.equal(await security.judgeHeadAnnouncement(announcement), null);
  assert.deepEqual(security.ledgerStatus().announcements, { accepted: 4, dropped: 7 });
  assert.ok(verifications.count <= 2, `only the forged and tampered ones reach the signature check (${verifications.count})`);
  // Our own echo: neither verified nor counted.
  verifications.count = 0;
  const own = await signHeadAnnouncement(w.bridgeKey, { accountId: w.accountId, kind: 'bridge', keyId: 'studio', head: tip, revision: 5, at: A_START });
  assert.equal(await security.judgeHeadAnnouncement(own), null);
  assert.equal(verifications.count, 0);
  assert.deepEqual(security.ledgerStatus().announcements, { accepted: 4, dropped: 7 });
  assert.equal(h.fetches.count, 0, 'judging never reads the server');
  // Accept-at-boundary: exactly HEAD_ANNOUNCE_MAX_AGE_MS old is fine.
  assert.equal(await security.judgeHeadAnnouncement(await announceFrom(w.accountId, w.laptop, tip, 5, A_START - HEAD_ANNOUNCE_MAX_AGE_MS)), 'same');
});

test('onLedgerHead fires after an adopt and not after an unchanged read', async t => {
  const h = await announceHarness(t);
  let fired = 0;
  const stop = h.security.onLedgerHead(() => { fired++; });
  await h.security.refreshLedger();
  assert.equal(fired, 0, 'same chain: nothing changed');
  h.serve(h.w.longer);
  await h.security.refreshLedger();
  assert.equal(fired, 1);
  assert.equal(h.security.ledgerStatus().revision, 6);
  stop();
  await h.security.refreshLedger();
  assert.equal(fired, 1);
});

test('ledger channel to relay to replica: owner filter first, one verification per message, one paced read for an unknown head, own head announced', async t => {
  const h = await announceHarness(t);
  const { w, security } = h;
  const verifications = countVerifications(t);
  // Manual monotonic clock and timers for the relay.
  const clock = { t: 10_000 };
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const schedule = (run: () => void, ms: number) => { const timer = { at: clock.t + ms, run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; };
  const fireAll = async () => {
    for (let guard = 0; guard < 50; guard++) {
      const next = timers.filter(timer => !timer.cancelled).sort((a, b) => a.at - b.at)[0];
      if (!next) return;
      next.cancelled = true; clock.t = Math.max(clock.t, next.at); next.run();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const posts: string[] = [];
  const relay = createAccountRelay({
    apiUrl: 'https://ftown.example', accountId: w.accountId, bridgeId: 'studio', authPrivateKey: w.bridgeKey, security,
    store: { read: async () => null },
    // Any direct request from the relay (a POST, or a fetch "from the announcer") fails this test.
    server: { fetchLedger: async () => { posts.push('GET'); throw new Error('unexpected'); }, postLedger: async () => { posts.push('POST'); throw new Error('unexpected'); } },
    fetchImpl: async () => { posts.push('fetch'); throw new Error('unexpected'); },
    hostname: () => 'h', localPort: () => undefined, now: () => clock.t, wallClock: () => A_START, schedule, log: () => undefined,
  });
  t.after(() => relay.stop());
  // A CentrifugoClient on a fake transport, wired like index.ts.
  const subscriptions = new Map<string, EventEmitter & { state: string }>();
  const published: Array<{ channel: string; data: unknown }> = [];
  const transport = Object.assign(new EventEmitter(), { state: 'connected', removeSubscription: () => {},
    publish: async (channel: string, data: unknown) => { published.push({ channel, data }); },
    newSubscription: (channel: string) => {
      const sub = Object.assign(new EventEmitter(), { state: 'unsubscribed', subscribe() { this.state = 'subscribed'; this.emit('subscribed'); }, unsubscribe() { this.state = 'unsubscribed'; } });
      subscriptions.set(channel, sub); return sub;
    } });
  const client = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '', {
    onLedgerMessage: message => relay.onLedgerMessage(message), onLedgerSubscribed: () => relay.onLedgerSubscribed() });
  Object.defineProperty(client, 'client', { value: transport });
  relay.setLedgerPublisher(announcement => client.publishLedgerAnnouncement(w.accountId, announcement));
  client.joinBridgesChannel(w.accountId, 'studio');
  const channel = `bridges:ledger#${w.accountId}`;
  const sub = subscriptions.get(channel)!;
  const wait = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  // Subscribed: the paced read ran once, and this bridge announced its head (signed with its auth key, verifiable by any member).
  await wait(() => published.length === 1 && h.fetches.count === 1);
  assert.equal(h.fetches.count, 1);
  assert.equal(published.length, 1);
  const mine = published[0].data as HeadAnnouncement;
  assert.equal(published[0].channel, channel);
  assert.deepEqual([mine.kind, mine.keyId, mine.head, mine.revision, mine.at], ['bridge', 'studio', w.baseHeads[5], 5, A_START]);
  assert.equal(await verifyHeadAnnouncement(await verifyLedger(w.base, A_START), mine, A_START), true);
  await fireAll();
  h.fetches.count = 0;
  verifications.count = 0;

  // Our own announcement echoed back by the relay: ignored, no verification.
  sub.emit('publication', { info: { user: w.accountId }, data: mine });
  // A VALID announcement of an unknown head, but published by another account's client: dropped before any signature work.
  const valid = await announceFrom(w.accountId, w.laptop, w.longerHead, 6);
  for (const info of [{ user: 'someone-else' }, { user: '' }, undefined]) sub.emit('publication', { info, data: valid });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(verifications.count, 0);
  assert.deepEqual(security.ledgerStatus().announcements, { accepted: 0, dropped: 0 });

  // 200 forged announcements (the laptop's id, an outsider's key, unknown heads) in a burst: at most one verification each, no read.
  const forged = await Promise.all(Array.from({ length: 200 }, (_, i) =>
    announceFrom(w.accountId, { ...w.laptop, key: w.outsider.key }, Buffer.alloc(32, i % 256).toString('base64url'), 6 + (i % 100))));
  for (const data of forged) sub.emit('publication', { info: { user: w.accountId }, data });
  await wait(() => security.ledgerStatus().announcements.dropped === 200);
  assert.deepEqual(security.ledgerStatus().announcements, { accepted: 0, dropped: 200 });
  assert.ok(verifications.count <= 200, `${verifications.count} verifications`);
  await fireAll();
  assert.equal(h.fetches.count, 0, 'forged announcements never read the server');

  // Revoked member and stale announcement: dropped, no read.
  sub.emit('publication', { info: { user: w.accountId }, data: await announceFrom(w.accountId, w.phone, w.longerHead, 6) });
  sub.emit('publication', { info: { user: w.accountId }, data: await announceFrom(w.accountId, w.laptop, w.longerHead, 6, A_START - HEAD_ANNOUNCE_MAX_AGE_MS - 1) });
  await wait(() => security.ledgerStatus().announcements.dropped === 202);
  await fireAll();
  assert.equal(h.fetches.count, 0);

  // Same and behind from a member: accepted, nothing read.
  sub.emit('publication', { info: { user: w.accountId }, data: await announceFrom(w.accountId, w.laptop, w.baseHeads[5], 5) });
  sub.emit('publication', { info: { user: w.accountId }, data: await announceFrom(w.accountId, w.mini, w.baseHeads[2], 2) });
  await wait(() => security.ledgerStatus().announcements.accepted === 2);
  await fireAll();
  assert.equal(h.fetches.count, 0);

  // A valid unknown head: exactly one paced server read (the server holds `longer`: adopted through fork choice), then our new head is announced.
  h.serve(w.longer);
  published.length = 0;
  sub.emit('publication', { info: { user: w.accountId }, data: valid });
  await wait(() => security.ledgerStatus().announcements.accepted === 3);
  // The relay spacing (1 s after the last relay-triggered read) still applies: the read runs when its timer fires.
  await fireAll();
  await wait(() => h.fetches.count === 1 && security.ledgerStatus().revision === 6);
  assert.equal(h.fetches.count, 1);
  assert.equal(security.ledgerStatus().revision, 6);
  await fireAll();
  await wait(() => published.length === 1);
  assert.equal(h.fetches.count, 1, 'exactly one read');
  assert.deepEqual(published.map(item => [(item.data as HeadAnnouncement).head, (item.data as HeadAnnouncement).revision]), [[w.longerHead, 6]]);

  // A member spamming 50 unknown heads: at most one read now and one trailing read after the spacing.
  h.fetches.count = 0;
  verifications.count = 0;
  const spam = await Promise.all(Array.from({ length: 50 }, (_, i) => announceFrom(w.accountId, w.laptop, Buffer.alloc(32, 200 + i).toString('base64url'), 7)));
  for (const data of spam) sub.emit('publication', { info: { user: w.accountId }, data });
  await wait(() => security.ledgerStatus().announcements.accepted === 2 + 1 + 50);
  assert.equal(verifications.count, 50);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(h.fetches.count <= 1, `${h.fetches.count} reads before the spacing`);
  await fireAll();
  assert.ok(h.fetches.count <= 2, `${h.fetches.count} reads in all`);
  assert.deepEqual(posts, [], 'never a POST, never a request of the relay itself');
});

test('announcements are judged against the TRUSTED checkpoint: a sticky-only revocation refuses that member', async t => {
  const w = await aWorld();
  const h = await announceHarness(t, [w.laptop.keyId]);
  assert.equal(await h.security.judgeHeadAnnouncement(await announceFrom(w.accountId, w.laptop, w.longerHead, 6)), null);
  assert.equal(await h.security.judgeHeadAnnouncement(await announceFrom(w.accountId, w.mini, w.longerHead, 6)), 'unknown');
  assert.deepEqual(h.security.ledgerStatus().announcements, { accepted: 1, dropped: 1 });
});
