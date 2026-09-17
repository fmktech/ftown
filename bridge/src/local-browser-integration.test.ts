import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';
import { BrowserAccess } from './browser-access.js';
import { LocalApiServer } from './local-api-server.js';
import { LoopbackPeerServer } from './direct-transport/loopback-server.js';
import { DIRECT_PROTOCOL_VERSION } from './direct-transport/contract.js';
import { SessionStore } from './session-store.js';
import { SessionController } from './session-controller.js';
import { LoopController } from './loop-controller.js';
import { CentrifugoClient } from './centrifugo-client.js';
import { createCommandHandler } from './command-rpc.js';
import { removeFtownSession } from './remove-ftown-session.js';
import type { ProcessRunner } from './claude-runner.js';
import type { Command, CommandResponse } from './types.js';

const ORIGIN = 'https://ftown.ia.br';
const BRIDGE = 'integration-bridge';
const ADMIN = 'integration-admin-token';
async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'local-browser-integration-'));
  const store = new SessionStore(dataDir);
  const launched: Array<{ id: string; command: string }> = [];
  const stopped: string[] = [];
  const inputs: Array<[string, string]> = [];
  const runner = {
    run: (id: string, command: string) => { launched.push({ id, command }); },
    stop: (id: string) => { stopped.push(id); return true; },
    getPreferredRuntime: () => 'pty',
    isRunning: (id: string) => launched.some(s => s.id === id) && !stopped.includes(id),
  } as unknown as ProcessRunner;
  // Real client stays disconnected throughout; never call connect or rely on Fly.
  const centrifugo = new CentrifugoClient('ws://127.0.0.1:1/connection/websocket', '', async () => '');
  const localApi = new LocalApiServer();
  localApi.setAuthToken(ADMIN);
  localApi.setDependencies(store, runner, centrifugo, 'local-user');
  const port = await localApi.start();
  const factory = { store, runner, centrifugo, userId: 'local-user', bridgeId: BRIDGE, hookPort: port, hookToken: ADMIN, notifyScriptPath: '', wireTerminalInput: () => {} };
  localApi.setSessionFactory(factory);
  const sessionController = new SessionController({ store, runner, sessionFactory: factory,
    publishSessionUpdate: session => centrifugo.publishSessionUpdate('local-user', session),
    removeSession: (id, options) => removeFtownSession({ store, runner, centrifugo, userId: 'local-user' }, id, options),
  });
  const loopController = new LoopController({ bridgeId: BRIDGE, scheduler: { kick() {}, onLoopDeleted() {} }, isSessionRunning: id => runner.isRunning(id), publishLoopUpdate: loop => centrifugo.publishLoopUpdate('local-user', loop), publishLoopRemoved: id => centrifugo.publishLoopRemoved('local-user', id), listWireSessions: () => store.listSessions(), loadTerminalLog: id => store.loadTerminalLog(id) });
  let loopback: LoopbackPeerServer;
  const access = new BrowserAccess({ dataDir, allowedOrigins: [ORIGIN],
    bootstrap: () => ({ version: 1, userId: 'local-user', bridgeId: BRIDGE, hostname: 'integration', localPort: port, localNonce: 'legacy-nonce' }),
    execute: async command => {
      let response: CommandResponse | undefined;
      await createCommandHandler({ bridgeId: BRIDGE, sessionController, loopController, publishCommandResponse: async value => { response = value; } })(command);
      if (!response) throw new Error('RPC did not respond');
      return response;
    },
    onRevoke: () => loopback.disconnectPeers(),
  });
  localApi.setBrowserAccess(access);
  const unpublish = centrifugo.onLocalPublication((channel, data) => access.publish(channel, data));
  loopback = new LoopbackPeerServer({ nonce: 'legacy-nonce', allowedOrigins: [ORIGIN], bridgeId: BRIDGE, authorize: (token, origin) => access.authorize(token, origin), onInput: (id, input) => inputs.push([id, input]), onResize() {}, onAttach: () => 'local screen' });
  loopback.attach(localApi.getHttpServer()!);
  async function request(path: string, method = 'GET', body?: unknown, token = '', origin = ORIGIN, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function pair() {
    assert.equal((await request('/api/browser/window', 'POST', {}, ADMIN, '')).status, 200);
    const pending = await request('/api/browser/pairings', 'POST', { remember: true });
    assert.equal(pending.status, 201);
    const listed = await request('/api/browser/pairings', 'GET', undefined, ADMIN, '');
    assert.equal(listed.body.pairings[0].code, pending.body.code);
    assert.equal((await request(`/api/browser/pairings/${pending.body.id}/decision`, 'POST', { approve: true }, ADMIN, '')).status, 200);
    const approved = await request(`/api/browser/pairings/${pending.body.id}`, 'GET', undefined, pending.body.pollToken);
    return approved.body.credential as string;
  }
  const rpc = (token: string, type: Command['type'], payload: Command['payload'] = {}) => request('/api/browser/commands', 'POST', { type, payload, requestId: randomUUID() }, token);
  return { port, dataDir, store, access, localApi, loopback, inputs, launched, stopped, request, pair, rpc,
    close() { unpublish(); access.close(); loopback.closeAll(); localApi.getHttpServer()?.closeAllConnections(); localApi.stop(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

function connect(port: number, nonce: string, origin = ORIGIN): Promise<{ socket?: WebSocket; status?: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?nonce=${encodeURIComponent(nonce)}`, { origin });
    socket.once('open', () => resolve({ socket }));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => { response.resume(); socket.removeListener('error', reject); socket.on('error', () => {}); socket.terminate(); resolve({ status: response.statusCode }); });
  });
}

test('local consent controls real session store/controllers and streams updates while cloud is disconnected', { timeout: 10_000 }, async () => {
  const h = await harness();
  try {
    const token = await h.pair();
    const bootstrap = await h.request('/api/browser/bootstrap', 'POST', {}, token);
    assert.equal(bootstrap.body.bridgeId, BRIDGE); assert.equal(bootstrap.body.localNonce, token);
    assert.equal((await h.rpc(token, 'list_sessions')).body.data.sessions.length, 0);
    const events = h.request('/api/browser/events?cursor=0', 'GET', undefined, token);
    const created = await h.rpc(token, 'create_session', { shellType: 'shell', command: 'printf local', name: 'Local integration session', workingDir: h.dataDir, bridgeId: BRIDGE });
    assert.equal(created.status, 200); assert.equal(created.body.success, true);
    const id = created.body.data.session.id as string;
    assert.equal(h.launched[0].id, id); assert.equal(h.launched[0].command, 'printf local');
    assert.equal((await h.store.loadSession(id))?.name, 'Local integration session');
    const update = await events;
    assert.equal(update.body.events[0].channel, 'sessions:updates#local-user');
    assert.equal(update.body.events[0].data.session.id, id);
    assert.equal((await h.rpc(token, 'list_sessions')).body.data.sessions[0].id, id);
    // Same controller/store behavior remains exposed to CLI admin endpoints.
    const cliList = await h.request('/api/sessions', 'GET', undefined, ADMIN, '');
    assert.equal(cliList.status, 200); assert.equal(cliList.body.sessions[0].id, id);
    const removalEvents = h.request(`/api/browser/events?cursor=${update.body.cursor}`, 'GET', undefined, token);
    assert.equal((await h.rpc(token, 'remove_session', { sessionId: id })).body.success, true);
    assert.equal(await h.store.loadSession(id), null); assert.ok(h.stopped.includes(id));
    assert.equal((await removalEvents).body.events[0].data.session.status, 'removed');
    assert.equal((await h.rpc(token, 'list_sessions')).body.data.sessions.length, 0);
  } finally { h.close(); }
});

test('approved terminal upgrades work, revocation closes peers and prevents reconnection', { timeout: 10_000 }, async () => {
  const h = await harness(); let socket: WebSocket | undefined;
  try {
    const token = await h.pair();
    assert.equal((await connect(h.port, 'wrong-token')).status, 403);
    assert.equal((await connect(h.port, token, 'https://unrelated.example')).status, 403);
    socket = (await connect(h.port, token)).socket;
    assert.ok(socket);
    const hello = once(socket, 'message');
    socket.send(JSON.stringify({ kind: 'hello', clientId: 'integration-browser', protocolVersion: DIRECT_PROTOCOL_VERSION }));
    assert.equal(JSON.parse(String((await hello)[0])).kind, 'hello_ack');
    const screen = once(socket, 'message'); socket.send(JSON.stringify({ kind: 'attach', sessionId: 's' }));
    assert.equal(JSON.parse(String((await screen)[0])).kind, 'screen');
    socket.send(JSON.stringify({ kind: 'input', sessionId: 's', data: 'echo test\n' }));
    // A later ordered frame response proves the preceding input was processed.
    const ordered = once(socket, 'message'); socket.send(JSON.stringify({ kind: 'attach', sessionId: 's' })); await ordered;
    assert.deepEqual(h.inputs, [['s', 'echo test\n']]);
    const devices = await h.request('/api/browser/devices', 'GET', undefined, ADMIN, '');
    const closed = once(socket, 'close');
    assert.equal((await h.request(`/api/browser/devices/${devices.body.devices[0].id}`, 'DELETE', undefined, ADMIN, '')).status, 200);
    await closed;
    assert.equal((await connect(h.port, token)).status, 403);
    assert.equal((await h.rpc(token, 'list_sessions')).status, 401);
    const replacementToken = await h.pair();
    socket = (await connect(h.port, replacementToken)).socket;
    assert.ok(socket, 'revocation must preserve the upgrade listener for newly approved browsers');
    const replacementHello = once(socket, 'message');
    socket.send(JSON.stringify({ kind: 'hello', clientId: 'replacement-browser', protocolVersion: DIRECT_PROTOCOL_VERSION }));
    assert.equal(JSON.parse(String((await replacementHello)[0])).kind, 'hello_ack');
  } finally { socket?.terminate(); h.close(); }
});

test('hosted origins cannot access legacy admin routes and spoofed Host cannot reach browser routes', async () => {
  const h = await harness();
  try {
    const token = await h.pair();
    assert.equal((await h.request('/api/sessions', 'GET', undefined, ADMIN)).status, 403);
    assert.equal((await h.request('/api/sessions', 'POST', { command: 'printf should-not-run', shellType: 'shell' }, token)).status, 403);
    assert.equal((await h.request('/api/browser/window', 'POST', {}, ADMIN)).status, 401);
    const spoofedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: h.port, path: '/api/browser/bootstrap', method: 'POST', headers: { Host: `evil.example:${h.port}`, Origin: ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(spoofedStatus, 421);
    const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: h.port, path: '/api/browser/bootstrap', method: 'POST', headers: { Host: `127.0.0.1:${h.port}abc`, Origin: ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(malformedStatus, 421);
    assert.equal((await h.request('/api/browser/bootstrap', 'POST', {}, token)).status, 200, 'malformed Host must not crash the listener');
    assert.equal(h.launched.length, 0);
  } finally { h.close(); }
});

test('local API uses remembered port after restart and falls back when occupied', async () => {
  const first = new LocalApiServer(); const second = new LocalApiServer(); const restarted = new LocalApiServer();
  try {
    const preferred = await first.start();
    const fallback = await second.start(preferred);
    assert.notEqual(fallback, preferred);
    const http = first.getHttpServer()!;
    const closed = once(http, 'close'); first.stop(); await closed;
    assert.equal(await restarted.start(preferred), preferred);
  } finally { first.stop(); second.stop(); restarted.stop(); }
});
