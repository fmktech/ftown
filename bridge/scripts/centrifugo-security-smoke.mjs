// ROOT EXECUTION ONLY after the combined bridge build. Starts only a scratch
// loopback Centrifugo child; no UI/database/provider/cloud deployment is used.
// Optional: --archive /absolute/path/to/official-platform-archive.tar.gz
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureHubBinary, writeHubConfig, startHub, stopHub } from '../dist/solo/hub-manager.js';
import { CENTRIFUGO_VERSION, HUB_JWT_AUDIENCE } from '../dist/solo/contract.js';
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
let cleaning;
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    abort.abort();
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
async function subscribe(client, channel) {
  const subscription = client.newSubscription(channel);
  const ready = new Promise((done, fail) => { subscription.once('subscribed', done); subscription.once('error', context => fail(new Error(`subscribe rejected ${context.error.code}`))); subscription.once('unsubscribed', context => fail(new Error(`subscribe rejected ${context.code}`))); });
  subscription.subscribe(); await bounded(ready, 'subscription timeout');
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
  const exited = new Promise(done => hub.child.once('exit', done));
  await stopHub(dataDir);
  await bounded(exited, 'owned hub did not exit');
  console.log(JSON.stringify({ result: 'PASS', version: CENTRIFUGO_VERSION, verifiedArchiveAndCache: true, config0600: true,
    jwtAudience: true, ownerIsolation: true, publishHistoryReconnect: true, apiAdminDisabled: true, loopbackOnly: true }));
} finally {
  clearTimeout(deadline);
  await cleanup();
}
