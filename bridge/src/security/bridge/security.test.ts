import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { AttentionStore, AttentionError } from '../../attention-store.js';
import type { ProcessRunner } from '../../claude-runner.js';
import { EncryptedPeerChannel } from './direct.js';
import type { DirectMessage } from '../../direct-transport/contract.js';

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
    unread: async () => [{ id: 'opaque', body: 'PRIVATE MAIL' }] };
  const payload = { hook_event_name: 'FtownNativeWake', ftown_session_id: 'ftown', session_id: 'native', adapter: 'claude-mod' };
  assert.deepEqual(await nativeWake(payload, deps), { messages: [{ id: 'opaque' }] });
  assert.equal(leases, 1);
  await nativeWake({ ...payload, registerWake: false }, deps); assert.equal(leases, 1);
  await assert.rejects(nativeWake({ ...payload, session_id: 'other-native' }, deps), { code: 'wrong_context' });
  await assert.rejects(nativeWake({ ...payload, path: '/api/sessions', consume: true }, deps));
});

test('read-only MCP authorization follows actual operation semantics and bridge audit records denial without args', async t => {
  const f = await fixture(t); const mcp = await generateEndpoint(owner, 'mcp');
  await f.security.policy.approveMcp(await f.security.policy.principal(f.client.endpoint.id), { requestId: 'consent', grantId: 'grant',
    endpoint: mcp.endpoint, permissions: ['read'], expiresAt: new Date(Date.now() + 300000).toISOString(),
    activeExpiresAt: new Date(Date.now() + 86400000).toISOString() });
  await f.security.activateMcp(await f.security.policy.principal(mcp.endpoint.id, true), 'grant');
  const context = { actionId: 'action-search', parentActionId: null, clientId: 'client', grantId: 'grant', tool: 'chats_search', operation: 'claimed_read' };
  let dispatches = 0;
  const search = await f.packet({ type: 'application', route: { kind: 'http', method: 'POST', path: '/api/sessions/session/grep', requestId: randomUUID() },
    data: { body: { pattern: 'PRIVATE SEARCH CONTENT' } }, mcp: context }, f.route, mcp);
  await executeSecurePacket(f.security, search, f.route, async () => { dispatches++; return { status: 200, body: {} }; });
  const consumingRead = await f.packet({ type: 'application', route: { kind: 'http', method: 'GET', path: '/api/sessions/session/inbox', requestId: randomUUID() },
    data: {}, mcp: { ...context, actionId: 'action-consume', tool: 'messages_read' } }, f.route, mcp);
  await executeSecurePacket(f.security, consumingRead, f.route, async () => { dispatches++; return { status: 200, body: {} }; });
  assert.equal(dispatches, 1);
  const evidence = await f.security.audit.list();
  assert.deepEqual(evidence.events.map(event => [event.actionId, event.status, event.mutating]),
    [['action-consume', 'rejected', true], ['action-search', 'succeeded', false]]);
  assert.ok(!JSON.stringify(evidence).includes('PRIVATE SEARCH CONTENT'));
  assert.equal(evidence.events[1].operation, 'history_search');
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

test('direct read permission cannot execute input disguised under command or HTTP routes; terminal scopes remain enforced', async t => {
  const f = await fixture(t);
  const mcp = await generateEndpoint(owner, 'mcp');
  await f.security.policy.approveMcp(await f.security.policy.principal(f.client.endpoint.id), { requestId: 'direct-consent', grantId: 'direct-grant',
    endpoint: mcp.endpoint, permissions: ['read'], expiresAt: new Date(Date.now() + 300000).toISOString(),
    activeExpiresAt: new Date(Date.now() + 86400000).toISOString() });
  await f.security.activateMcp(await f.security.policy.principal(mcp.endpoint.id, true), 'direct-grant');
  const context = { actionId: 'action', parentActionId: null, clientId: 'client', grantId: 'direct-grant', tool: 'sessions_list', operation: null };
  const deliveries: DirectMessage[] = [];
  let closures = 0;
  const peer = async (sender: EndpointIdentity) => {
    const route: InboundTransportContext = { transport: 'webrtc', bridgeId: 'bridge', pairId: randomUUID(), channel: '' };
    route.channel = `direct:webrtc:bridge:${route.pairId}`;
    let authorized = 0;
    const channel = new EncryptedPeerChannel(f.security, route, () => {}, frame => deliveries.push(frame), () => { authorized++; }, () => { closures++; });
    t.after(async () => channel.close());
    const hello = await seal(sender, f.identity.endpoint, { type: 'ftown_encrypted', version: 1, senderId: sender.endpoint.id,
      recipientId: f.identity.endpoint.id, ownerId: owner, bridgeId: 'bridge', channel: route.channel, purpose: 'hello', messageId: randomUUID(),
      createdAt: Date.now(), expiresAt: Date.now() + 60000, receiverEpoch: null }, new TextEncoder().encode(JSON.stringify({ type: 'hello', challenge: randomUUID() })));
    await channel.receive(JSON.stringify(hello)); assert.equal(authorized, 1);
    return { channel, route, send: async (app: SecureApplication) => channel.receive(JSON.stringify(await f.packet(app, route, sender))) };
  };
  for (const kind of ['command', 'http'] as const) {
    const p = await peer(mcp); const requestId = randomUUID();
    await p.send({ type: 'application', route: kind === 'command' ? { kind, requestId, command: 'list_sessions', sessionId: null }
      : { kind, requestId, method: 'GET', path: '/api/sessions' },
      data: { type: 'list_sessions', requestId, payload: { bridgeId: 'bridge' }, kind: 'input', sessionId: 'victim', data: 'PRIVATE-MARKER' },
      mcp: { ...context, actionId: `cross-${kind}` } });
  }
  assert.deepEqual(deliveries, []); assert.equal(closures, 2);
  const readPeer = await peer(mcp);
  await readPeer.send({ type: 'application', route: { kind: 'terminal', sessionId: 'victim', frameType: 'attach', pairId: readPeer.route.pairId },
    data: { kind: 'attach', sessionId: 'victim' }, mcp: { ...context, actionId: 'read-attach' } });
  assert.deepEqual(deliveries, [{ kind: 'attach', sessionId: 'victim' }]);
  await readPeer.send({ type: 'application', route: { kind: 'terminal', sessionId: 'victim', frameType: 'input', pairId: readPeer.route.pairId },
    data: { kind: 'input', sessionId: 'victim', data: 'PRIVATE-MARKER' }, mcp: { ...context, actionId: 'read-input' } });
  assert.equal(deliveries.length, 1); assert.equal(closures, 3);
  const controlPeer = await peer(f.client);
  await controlPeer.send({ type: 'application', route: { kind: 'terminal', sessionId: 'victim', frameType: 'input', pairId: controlPeer.route.pairId },
    data: { kind: 'input', sessionId: 'victim', data: 'authorized' }, mcp: null });
  assert.deepEqual(deliveries[1], { kind: 'input', sessionId: 'victim', data: 'authorized' });
  const evidence = await f.security.audit.list();
  assert.equal(evidence.events.filter(event => event.status === 'rejected').length, 3);
  assert.ok(!JSON.stringify(evidence).includes('PRIVATE-MARKER'));
});

test('self-revocation releases only its fixed correlated receipt after durable removal and completion', async t => {
  const f = await fixture(t); const requestId = randomUUID();
  const application: SecureApplication = { type: 'application', route: { kind: 'command', command: 'security_revoke', requestId, sessionId: null },
    data: { type: 'security_revoke', requestId, payload: { bridgeId: 'bridge', endpointId: f.client.endpoint.id } }, mcp: null };
  let closures = 0;
  f.security.onRevoked(id => { assert.equal(id, f.client.endpoint.id); closures++; });
  const complete = f.security.complete.bind(f.security);
  t.mock.method(f.security, 'complete', async (...args: Parameters<typeof complete>) => {
    await assert.rejects(f.security.policy.principal(f.client.endpoint.id), { code: 'approval_required' });
    return complete(...args);
  });
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

test('self-revocation completion failure withholds the prepared receipt after policy removal', async t => {
  const f = await fixture(t); const requestId = randomUUID();
  const application: SecureApplication = { type: 'application', route: { kind: 'command', command: 'security_revoke', requestId, sessionId: null },
    data: { type: 'security_revoke', requestId, payload: { bridgeId: 'bridge', endpointId: f.client.endpoint.id } }, mcp: null };
  t.mock.method(f.security, 'complete', async () => { throw new Error('Required completion failed'); });
  await assert.rejects(executeSecurePacket(f.security, await f.packet(application), f.route, async () => null), { code: 'approval_required' });
  await assert.rejects(f.security.policy.principal(f.client.endpoint.id), { code: 'approval_required' });
});
