// ROOT EXECUTION ONLY after the combined bridge build. Starts only a scratch
// loopback Centrifugo child; no UI/database/provider/cloud deployment is used.
// Optional: --archive /absolute/path/to/official-platform-archive.tar.gz
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureHubBinary, writeHubConfig, startHub, stopHub } from '../dist/solo/hub-manager.js';
import { CENTRIFUGO_VERSION, HUB_JWT_AUDIENCE } from '../dist/solo/contract.js';
import { CentrifugoClient } from '../dist/centrifugo-client.js';
import { BridgeSecurityService } from '../dist/security/bridge/security.js';
import { generateEndpoint, open, seal } from '../dist/security/crypto.js';
const require = createRequire(new URL('../package.json', import.meta.url));
const { Centrifuge } = require('centrifuge');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const args = process.argv.slice(2);
assert.ok(!args.length || (args.length === 2 && args[0] === '--archive'), 'Use --archive /path/to/official-platform-archive.tar.gz');
const archive = args.length ? await readFile(resolve(args[1])) : null;
const temporary = await mkdtemp(join(tmpdir(), 'ftown-centrifugo-security-'));
const home = join(temporary, 'home'), dataDir = join(temporary, 'data'), configPath = join(temporary, 'hub.json');
await mkdir(home);
const oldEnv = { ...process.env };
// Centrifugo honors environment overrides. Do not inherit a real deployment's
// bind/secret/proxy settings or any user's HOME into this isolated child.
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, { HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin', TMPDIR: temporary });
const clients = new Set();
const abort = new AbortController();
let hub;
let bridgeCloud;
let bridgeSecurity;
let cleaning;
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    abort.abort();
    bridgeCloud?.disconnect();
    await bridgeSecurity?.close();
    for (const client of clients) client.disconnect();
    await stopHub(dataDir);
    await rm(temporary, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  })();
  return cleaning;
}
const deadline = setTimeout(() => {
  console.error('Centrifugo security smoke exceeded 90 seconds');
  void cleanup().finally(() => process.exit(1));
}, 90_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
function bounded(promise, label, milliseconds = 8000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]).finally(() => clearTimeout(timer));
}
async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
  return port;
}
const secret = randomBytes(32).toString('hex');
function clientFor(port, owner, audience = HUB_JWT_AUDIENCE) {
  const token = jwt.sign({ sub: owner }, secret, { audience, expiresIn: '1m' });
  const client = new Centrifuge(`ws://127.0.0.1:${port}/connection/websocket`, { token, websocket: WebSocket });
  clients.add(client);
  return client;
}
async function connect(client) {
  const ready = new Promise((done, fail) => { client.once('connected', done); client.once('disconnected', context => fail(new Error(`connect rejected ${context.code}`))); });
  client.connect(); await bounded(ready, 'connection timeout');
}
const subscriptionContexts = new WeakMap();
async function subscribe(client, channel, options = {}) {
  const subscription = client.newSubscription(channel, options);
  const ready = new Promise((done, fail) => { subscription.once('subscribed', done); subscription.once('error', context => fail(new Error(`subscribe rejected ${context.error.code}`))); subscription.once('unsubscribed', context => fail(new Error(`subscribe rejected ${context.code}`))); });
  subscription.subscribe();
  try { subscriptionContexts.set(subscription, await bounded(ready, 'subscription timeout')); }
  catch (error) { subscription.unsubscribe(); client.removeSubscription(subscription); throw error; }
  return subscription;
}
try {
  assert.equal(CENTRIFUGO_VERSION, 'v6.10.2');
  const binary = await bounded(ensureHubBinary({ dataDir, fetchImpl: archive
    ? async () => new Response(archive)
    : (url, init) => fetch(url, { ...init, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) }),
  }), 'verified binary download/extraction timeout', 40_000);
  assert.equal(await ensureHubBinary({ dataDir, fetchImpl: async () => { throw new Error('cache unexpectedly downloaded'); } }), binary, 'verified cache is reusable');
  const port = await freePort();
  await writeHubConfig(configPath, { port, secret });
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  hub = await startHub({ dataDir, configPath, binPath: binary, healthDeadlineMs: 10_000, healthIntervalMs: 100 });
  assert.equal(hub.port, port);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).status, 200);
  for (const path of ['/api', '/admin']) assert.equal((await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) })).status, 404);

  const owner = clientFor(port, 'owner'); await connect(owner);
  const foreign = clientFor(port, 'foreign'); await connect(foreign);
  const invalid = clientFor(port, 'owner', 'wrong-audience');
  const refused = new Promise(done => invalid.once('disconnected', done));
  invalid.connect();
  await bounded(refused, 'wrong-audience token was not rejected');
  invalid.disconnect();
  const channel = 'terminal:security-fixture#owner';
  const subscription = await subscribe(owner, channel);
  await assert.rejects(subscribe(foreign, channel), /subscribe rejected/, 'foreign user must not subscribe to owner channel');
  const payload = { type: 'fixture', text: 'owned realtime publication' };
  const publication = new Promise(done => subscription.once('publication', done));
  await bounded(owner.publish(channel, payload), 'owner publish timeout');
  assert.deepEqual((await bounded(publication, 'publication timeout')).data, payload);
  const history = await bounded(subscription.history({ limit: 10 }), 'history timeout');
  assert.ok(history.publications.some(item => item.data.text === payload.text));
  owner.disconnect();
  await connect(owner);
  await bounded(subscription.ready(8000), 'resubscription timeout');
  assert.ok((await bounded(subscription.history({ limit: 10 }), 'post-reconnect history timeout')).publications.some(item => item.data.text === payload.text));

  const publisher = clientFor(port, 'owner'); await connect(publisher);
  for (const channel of ['sessions:updates#owner', 'session-board:updates#owner']) {
    const sub = await subscribe(owner, channel, { recoverable: true, positioned: true });
    assert.equal(subscriptionContexts.get(sub).recoverable, true);
    assert.equal(subscriptionContexts.get(sub).positioned, true);
    await assert.rejects(subscribe(foreign, channel), /subscribe rejected/, 'foreign account must not subscribe to dashboard channels');
    const first = new Promise(done => sub.once('publication', done));
    await bounded(publisher.publish(channel, { type: 'fixture', revision: 1 }), 'dashboard publish timeout');
    const before = await bounded(first, 'first dashboard publication timeout');
    assert.ok(before.offset > 0);
    owner.disconnect();
    await bounded(publisher.publish(channel, { type: 'fixture', revision: 2 }), 'disconnected dashboard publish timeout');
    const subscribed = new Promise(done => sub.once('subscribed', done));
    const replay = new Promise(done => sub.once('publication', done));
    await connect(owner);
    const recovery = await bounded(subscribed, 'dashboard recovery timeout');
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.wasRecovering, true);
    const recovered = await bounded(replay, 'recovered dashboard publication timeout');
    assert.equal(recovered.data.revision, 2);
    assert.ok(recovered.offset > before.offset);
  }

  // Raw publish-only namespaces retain their existing relay permissions. The
  // application boundary additionally authenticates owner context and E2EE.
  const endpointOwner = randomUUID();
  const identity = await generateEndpoint(endpointOwner, 'bridge');
  const local = await generateEndpoint(endpointOwner, 'local-cli');
  const browser = await generateEndpoint(endpointOwner, 'browser');
  bridgeSecurity = new BridgeSecurityService(identity, 'smoke-bridge', dataDir, { relayUserId: 'owner' });
  await bridgeSecurity.policy.provisionLocalEndpoint(local.endpoint);
  const invitation = await bridgeSecurity.policy.createInvitation(await bridgeSecurity.policy.principal(local.endpoint.id), { label: 'smoke' });
  await bridgeSecurity.policy.consumeInvitation({ type: 'enroll', candidate: browser.endpoint, invitationId: invitation.invitationId, invitationSecret: invitation.secret, label: 'smoke' });
  const token = jwt.sign({ sub: 'owner' }, secret, { audience: HUB_JWT_AUDIENCE, expiresIn: '1m' });
  bridgeCloud = new CentrifugoClient(`ws://127.0.0.1:${port}/connection/websocket`, token, async () => token);
  bridgeCloud.setSecurity(bridgeSecurity);
  const dispatched = [];
  const commandWaiters = new Map();
  const acknowledgedCommands = new Set();
  const acknowledgementWaiters = new Map();
  bridgeCloud.subscribeSecureCommands('owner', async message => {
    const id = message.application.route.requestId;
    dispatched.push(id); commandWaiters.get(id)?.();
    return { type: 'command_response', response: { requestId: id, success: true } };
  }, {
    admitted() {}, sealed() {},
    delivered(id) { acknowledgedCommands.add(id); acknowledgementWaiters.get(id)?.resolve(); },
    failed(id) { acknowledgementWaiters.get(id)?.reject(new Error('Authenticated command response failed')); },
  });
  bridgeCloud.connect();
  await bridgeCloud.waitUntilSecureCommandsReady(8000);
  const commandChannel = 'commands:rpc#owner';
  const responses = await subscribe(publisher, commandChannel);
  const deliveredResponses = new Map();
  responses.on('publication', context => {
    const packet = context.data;
    if (context.info?.user !== 'owner' || packet?.senderId !== identity.endpoint.id || packet?.recipientId !== browser.endpoint.id) return;
    const receipt = open(browser, identity.endpoint, packet, { ownerId: endpointOwner, bridgeId: 'smoke-bridge', channel: commandChannel,
      recipientId: browser.endpoint.id, purpose: 'application' }).then(bytes => {
        const application = JSON.parse(new TextDecoder().decode(bytes));
        assert.equal(application.data.response.success, true);
        return application.data.response.requestId;
      });
    deliveredResponses.set(packet.messageId, receipt);
    // Attach a rejection observer immediately; the matching gate below still
    // awaits and reports the decryption/assertion failure.
    void receipt.catch(() => {});
  });
  async function commandPacket(id) {
    const application = { type: 'application', route: { kind: 'command', requestId: id, command: 'list_sessions', sessionId: null },
      data: { type: 'list_sessions', requestId: id, payload: { bridgeId: 'smoke-bridge' } }, mcp: null };
    return seal(browser, identity.endpoint, { type: 'ftown_encrypted', version: 1, senderId: browser.endpoint.id, recipientId: identity.endpoint.id,
      ownerId: endpointOwner, bridgeId: 'smoke-bridge', channel: commandChannel, purpose: 'application', messageId: id,
      createdAt: Date.now(), expiresAt: Date.now() + 60_000, receiverEpoch: bridgeSecurity.receiverEpoch }, new TextEncoder().encode(JSON.stringify(application)));
  }
  const authenticatedId = randomUUID(), barrierId = randomUUID();
  const authenticated = await commandPacket(authenticatedId);
  // A stricter broker may refuse it; if accepted, it must not consume replay
  // state or dispatch before the authenticated owner's ordered barrier.
  try { await bounded(foreign.publish(commandChannel, authenticated), 'foreign publish timeout'); }
  catch (error) { assert.equal(error.code, 103); }
  await bounded(publisher.publish(commandChannel, { type: 'list_sessions', requestId: randomUUID(), payload: { bridgeId: 'smoke-bridge' } }), 'plaintext publication timeout');
  const barrier = new Promise(done => commandWaiters.set(barrierId, done));
  await bounded(publisher.publish(commandChannel, await commandPacket(barrierId)), 'barrier publish timeout');
  await bounded(barrier, 'authenticated barrier timeout');
  assert.deepEqual(dispatched, [barrierId]);
  const authenticatedDispatch = new Promise(done => commandWaiters.set(authenticatedId, done));
  await bounded(publisher.publish(commandChannel, authenticated), 'authenticated command publish timeout');
  await bounded(authenticatedDispatch, 'authenticated command timeout');
  assert.deepEqual(dispatched, [barrierId, authenticatedId]);
  // Dispatch happens before sealing/publishing the reply. An ordered response
  // receipt is the teardown gate, so shutdown cannot cancel an in-flight reply.
  const finalReply = new Promise((done, fail) => {
    const inspect = context => {
      if (context.data?.messageId !== authenticatedId || context.data?.recipientId !== browser.endpoint.id) return;
      responses.removeListener('publication', inspect);
      Promise.resolve(deliveredResponses.get(authenticatedId)).then(done, fail);
    };
    if (deliveredResponses.has(authenticatedId)) Promise.resolve(deliveredResponses.get(authenticatedId)).then(done, fail);
    else responses.on('publication', inspect);
  });
  assert.equal(await bounded(finalReply, 'authenticated command response timeout'), authenticatedId);
  const acknowledged = new Promise((resolve, reject) => {
    if (acknowledgedCommands.has(authenticatedId)) resolve();
    else acknowledgementWaiters.set(authenticatedId, { resolve, reject });
  });
  await bounded(acknowledged, 'authenticated command response acknowledgement timeout');
  bridgeCloud.disconnect();
  const exited = new Promise(done => hub.child.once('exit', done));
  await stopHub(dataDir);
  await bounded(exited, 'owned hub did not exit');
  console.log(JSON.stringify({ result: 'PASS', version: CENTRIFUGO_VERSION, verifiedArchiveAndCache: true, config0600: true,
    jwtAudience: true, ownerIsolation: true, publishHistoryReconnect: true, dashboardPositionedRecovery: true,
    authenticatedApplicationBoundary: true, apiAdminDisabled: true, loopbackOnly: true }));
} finally {
  clearTimeout(deadline);
  await cleanup();
}
