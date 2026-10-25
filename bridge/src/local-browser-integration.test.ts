import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';
import { LocalApiServer } from './local-api-server.js';
import { LoopbackPeerServer } from './direct-transport/loopback-server.js';
import { SessionStore } from './session-store.js';
import { SessionController } from './session-controller.js';
import { CentrifugoClient } from './centrifugo-client.js';
import { createCommandHandler } from './command-rpc.js';
import { removeFtownSession } from './remove-ftown-session.js';
import { generateEndpoint, open, seal } from './security/crypto.js';
import { BridgeSecurityService, applicationJson } from './security/bridge/security.js';
import { LOCAL_RECOVERY_AUTHORITY } from './security/bridge/policy.js';
import type { SecureApplication, SecureEnvelope } from './security/protocol.js';
import type { ProcessRunner } from './claude-runner.js';
import type { CommandResponse } from './types.js';

const ORIGIN = 'https://ftown.ia.br';
const BRIDGE = 'integration-bridge';
const OWNER = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'local-browser-integration-'));
  const identity = await generateEndpoint(OWNER, 'bridge');
  const browser = await generateEndpoint(OWNER, 'browser');
  const security = new BridgeSecurityService(identity, BRIDGE, dataDir, { relayUserId: 'local-user',
    relayUrl: 'wss://broker.example.test/connection/websocket', browserOrigin: ORIGIN });
  const store = new SessionStore(dataDir);
  const launched: string[] = []; const stopped: string[] = []; const inputs: Array<[string, string]> = [];
  const runner = { run: (id: string) => launched.push(id), stop: (id: string) => { stopped.push(id); return true; },
    getPreferredRuntime: () => 'direct', isRunning: (id: string) => launched.includes(id) && !stopped.includes(id) } as unknown as ProcessRunner;
  const centrifugo = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '', { disabled: true });
  centrifugo.setSecurity(security);
  const localApi = new LocalApiServer(); localApi.setAuthToken('hook-only');
  localApi.setDependencies(store, runner, centrifugo, 'local-user');
  const port = await localApi.start();
  const factory = { store, runner, centrifugo, userId: 'local-user', bridgeId: BRIDGE, hookPort: port, hookToken: 'hook-only', notifyScriptPath: '', wireTerminalInput: () => {} };
  localApi.setSessionFactory(factory);
  const controller = new SessionController({ store, runner, sessionFactory: factory, publishSessionUpdate: session => centrifugo.publishSessionUpdate('local-user', session),
    removeSession: (id, options) => removeFtownSession({ store, runner, centrifugo, userId: 'local-user' }, id, options) });
  localApi.setSessionController(controller);
  localApi.setSecurity(security, { protocolVersion: 1, ownerId: OWNER, bridgeId: BRIDGE, endpoint: identity.endpoint, relayUserId: 'local-user' }, async message => {
    let response: CommandResponse | undefined;
    await createCommandHandler({ bridgeId: BRIDGE, security, sessionController: controller, publishCommandResponse: async value => { response = value; } })
      (message.application.data as never, message);
    return applicationJson({ type: 'command_response', response });
  });
  const stopPublication = centrifugo.onLocalPublication((channel, data) => localApi.recordPublication(channel, data));
  const loopback = new LoopbackPeerServer({ security, nonce: '', allowedOrigins: [ORIGIN], bridgeId: BRIDGE,
    onInput: (id, value) => inputs.push([id, value]), onResize() {}, onAttach: () => 'PRIVATE local screen' });
  loopback.attach(localApi.getHttpServer()!);
  async function decoded(envelope: SecureEnvelope, channel: string) {
    return JSON.parse(new TextDecoder().decode(await open(browser, identity.endpoint, envelope, { ownerId: OWNER, bridgeId: BRIDGE,
      channel, recipientId: browser.endpoint.id, purpose: envelope.purpose })));
  }
  async function packet(application: SecureApplication, channel: string, id: string = randomUUID()) {
    return seal(browser, identity.endpoint, { type: 'ftown_encrypted', version: 1, senderId: browser.endpoint.id, recipientId: identity.endpoint.id,
      ownerId: OWNER, bridgeId: BRIDGE, channel, purpose: 'application', messageId: id, createdAt: Date.now(), expiresAt: Date.now() + 60000,
      receiverEpoch: security.receiverEpoch }, new TextEncoder().encode(JSON.stringify(application)));
  }
  async function pair() {
    const invitation = await security.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: 'Integration browser' });
    const channel = `local-http:${BRIDGE}`;
    const envelope = await seal(browser, identity.endpoint, { type: 'ftown_encrypted', version: 1, senderId: browser.endpoint.id,
      recipientId: identity.endpoint.id, ownerId: OWNER, bridgeId: BRIDGE, channel, purpose: 'enroll', messageId: randomUUID(),
      createdAt: Date.now(), expiresAt: Date.now() + 60000, receiverEpoch: null }, new TextEncoder().encode(JSON.stringify({ type: 'enroll',
        candidate: browser.endpoint, invitationId: invitation.invitationId, invitationSecret: invitation.secret, label: 'Integration browser' })));
    const response = await fetch(`http://127.0.0.1:${port}/api/security/envelope`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ftown_enrollment', version: 1, candidate: browser.endpoint, envelope }) });
    assert.equal(response.status, 200);
    assert.equal((await decoded(await response.json() as SecureEnvelope, channel)).type, 'enrolled');
  }
  async function request(application: SecureApplication, events = false) {
    const channel = `${events ? 'local-events' : 'local-http'}:${BRIDGE}`;
    const id = application.route.kind === 'command' || application.route.kind === 'http' ? application.route.requestId : randomUUID();
    const envelope = await packet(application, channel, id);
    const response = await fetch(`http://127.0.0.1:${port}/api/security/${events ? 'events' : 'envelope'}`, { method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) });
    assert.equal(response.status, 200);
    return (await decoded(await response.json() as SecureEnvelope, channel)).data;
  }
  const rpc = (type: string, payload: Record<string, unknown> = {}) => { const requestId = randomUUID();
    return request({ type: 'application', route: { kind: 'command', command: type, requestId, sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null },
      data: applicationJson({ type, requestId, payload: { ...payload, bridgeId: BRIDGE } }), mcp: null }); };
  return { port, dataDir, security, identity, browser, inputs, launched, stopped, store, rpc, request, pair, packet, decoded,
    async close() { stopPublication(); loopback.closeAll(); localApi.getHttpServer()?.closeAllConnections(); localApi.stop(); await security.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test('real encrypted enrollment controls sessions and streams local events while cloud is disconnected', { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    await h.pair();
    assert.deepEqual((await h.rpc('list_sessions')).response.data.sessions, []);
    const events = h.request({ type: 'application', route: { kind: 'http', requestId: randomUUID(), method: 'GET', path: '/api/browser/events?after=0' }, data: {}, mcp: null }, true);
    const created = await h.rpc('create_session', { shellType: 'shell', command: 'printf local', name: 'PRIVATE session', workingDir: h.dataDir });
    assert.equal(created.response.success, true);
    const id = created.response.data.session.id;
    assert.ok(h.launched.includes(id)); assert.equal((await h.store.loadSession(id))?.name, 'PRIVATE session');
    const update = await events; assert.equal(update.events[0].channel, 'sessions:updates#local-user');
    assert.equal(update.events[0].data.session.id, id);
    assert.equal((await h.rpc('remove_session', { sessionId: id })).response.success, true);
    assert.equal(await h.store.loadSession(id), null); assert.ok(h.stopped.includes(id));
  } finally { await h.close(); }
});

test('encrypted direct handshake authenticates frames and revocation closes the bound peer', { timeout: 15000 }, async () => {
  const h = await harness(); let ws: WebSocket | undefined;
  try {
    await h.pair(); const pairId = randomUUID(); const channel = `direct:loopback-ws:${BRIDGE}:${pairId}`;
    ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws?pairId=${pairId}`, { origin: ORIGIN }); await once(ws, 'open');
    const challenge = randomUUID();
    const hello = await seal(h.browser, h.identity.endpoint, { type: 'ftown_encrypted', version: 1, senderId: h.browser.endpoint.id,
      recipientId: h.identity.endpoint.id, ownerId: OWNER, bridgeId: BRIDGE, channel, purpose: 'hello', messageId: randomUUID(),
      createdAt: Date.now(), expiresAt: Date.now() + 60000, receiverEpoch: null }, new TextEncoder().encode(JSON.stringify({ type: 'hello', challenge })));
    const welcome = once(ws, 'message'); ws.send(JSON.stringify(hello));
    assert.equal((await h.decoded(JSON.parse(String((await welcome)[0])), channel)).challenge, challenge);
    const attach = await h.packet({ type: 'application', route: { kind: 'terminal', frameType: 'attach', sessionId: 'session', pairId },
      data: { kind: 'attach', sessionId: 'session' }, mcp: null }, channel);
    const screen = once(ws, 'message'); ws.send(JSON.stringify(attach));
    const encrypted = String((await screen)[0]); assert.ok(!encrypted.includes('PRIVATE'));
    assert.equal((await h.decoded(JSON.parse(encrypted), channel)).data.data, 'PRIVATE local screen');
    const input = await h.packet({ type: 'application', route: { kind: 'terminal', frameType: 'input', sessionId: 'session', pairId },
      data: { kind: 'input', sessionId: 'session', data: 'typed' }, mcp: null }, channel);
    ws.send(JSON.stringify(input));
    for (let count = 0; count < 50 && !h.inputs.length; count++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(h.inputs, [['session', 'typed']]);
    const closed = once(ws, 'close'); await h.security.revokeEndpoint(await h.security.policy.principal(h.browser.endpoint.id), h.browser.endpoint.id); await closed;
  } finally { ws?.terminate(); await h.close(); }
});

test('raw hook credential cannot execute business APIs; hostile Host and origins reject secure ingress', async () => {
  const h = await harness();
  try {
    const raw = await fetch(`http://127.0.0.1:${h.port}/api/sessions`, { headers: { Authorization: 'Bearer hook-only' } });
    assert.equal(raw.status, 426);
    const trusted = await fetch(`http://127.0.0.1:${h.port}/api/security/info`, { headers: { Origin: ORIGIN } });
    assert.equal(trusted.status, 200); assert.equal(trusted.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    const broker = await fetch(`http://127.0.0.1:${h.port}/api/security/info`, { headers: { Origin: 'https://broker.example.test' } });
    assert.equal(broker.status, 403, 'broker routing metadata does not authorize a browser origin');
    const origin = await fetch(`http://127.0.0.1:${h.port}/api/security/info`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(origin.status, 403);
    const status = await new Promise<number | undefined>((resolve, reject) => { const request = httpRequest({ hostname: '127.0.0.1', port: h.port,
      path: '/api/security/info', headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); request.end(); });
    assert.equal(status, 421); assert.equal(h.launched.length, 0);
  } finally { await h.close(); }
});
