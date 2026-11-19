import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanup, PeerConnection } from 'node-datachannel';
import { LocalApiServer } from './local-api-server.js';
import { TRANSFER_LOCAL, TRANSFER_WIRE, TRANSFER_REQUEST_TTL_MS } from './folder-transfer-protocol.js';
import { generateEndpoint } from './security/crypto.js';
import { accountIdOf, ledgerChallenge, ledgerLastIssuedAt, ledgerRevocations, nextTransition, verifyLedger } from './security/ledger/ledger.js';
import { generateAuthKey } from './security/ledger/proof.js';
import type { Ledger, LedgerBridge, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from './security/ledger/protocol.js';
import { createSoftPasskey, type SoftPasskey } from './security/ledger/testing.js';
import type { ApplicationJson, EndpointIdentity, SecureEnvelope, VerifiedApplication } from './security/protocol.js';
import { BridgeLedgerStore } from './security/bridge/ledger-store.js';
import { BridgeSecurityService } from './security/bridge/security.js';
import { executeSecurePacket } from './security/bridge/execute.js';
import { BridgeSecurityError } from './security/bridge/errors.js';
import { PeerControl, PeerTargetError, type PeerTransport } from './peer-control.js';
import { PeerLinks, peerLinkChannel, type LinkDataChannel, type LinkPeerConnection } from './peer-link.js';

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
const T0 = 1_750_000_000_000;
const NOW = T0 + 3_600_000;

interface Chain { ledger: Ledger; accountId: string }
interface Computer { id: string; identity: EndpointIdentity; auth: string; entry: LedgerBridge }

async function signed<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload)) };
}
async function genesis(passkey: SoftPasskey): Promise<Chain> {
  const record = await signed(passkey, {
    type: 'ftown_account_genesis', version: 2, rpId, origins: [origin], handle: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    createdAt: T0, authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'Passkey', addedAt: T0 },
  });
  return { ledger: { genesis: record, transitions: [] }, accountId: await accountIdOf(record.payload) };
}
async function append(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation): Promise<Chain> {
  const last = ledgerLastIssuedAt(chain.ledger);
  const payload = nextTransition(await verifyLedger(chain.ledger, NOW), passkey.credentialId, operation, last + 1000, last);
  return { ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, await signed(passkey, payload)] }, accountId: chain.accountId };
}
async function computer(accountId: string, id: string, label: string): Promise<Computer> {
  const identity = await generateEndpoint(accountId, 'bridge');
  const auth = (await generateAuthKey(false)).publicKey;
  return { id, identity, auth, entry: { bridgeId: id, endpoint: identity.endpoint, authPublicKey: auth, label, approvedAt: T0 } };
}

interface World { passkey: SoftPasskey; root: Chain; studio: Computer; desk: Computer; both: Chain; deskRevokedStudio: Chain }
let built: Promise<World> | null = null;
function world(): Promise<World> {
  built ??= (async () => {
    const passkey = await createSoftPasskey({ rpId, origin });
    const root = await genesis(passkey);
    const studio = await computer(root.accountId, 'studio', 'Studio');
    const desk = await computer(root.accountId, 'desk-0001', 'Desk');
    const both = await append(await append(root, passkey, { type: 'add_bridge', bridge: studio.entry }), passkey, { type: 'add_bridge', bridge: desk.entry });
    const deskRevokedStudio = await append(both, passkey, { type: 'revoke_bridge', bridgeId: studio.id });
    return { passkey, root, studio, desk, both, deskRevokedStudio };
  })();
  return built;
}

/** One account-mode bridge with its own data dir, seeded with `chain` as its trusted ledger. */
async function bridge(t: TestContext, w: World, who: Computer, chain: Chain): Promise<BridgeSecurityService> {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-peer-control-'));
  await mkdir(join(dir, 'security'), { recursive: true });
  await writeFile(join(dir, 'security', 'ledger.json'), JSON.stringify({ version: 1, ledger: chain.ledger,
    checkpoint: await verifyLedger(chain.ledger, NOW), sticky: ledgerRevocations(chain.ledger), lastServerReadAt: NOW }));
  const store = new BridgeLedgerStore(dir, { accountId: w.root.accountId, now: () => NOW, log: () => undefined, bridgeId: who.id });
  const service = new BridgeSecurityService(who.identity, who.id, dir, { relayUserId: w.root.accountId, now: () => NOW,
    ledger: { store, bridgeId: who.id, authPublicKey: who.auth, now: () => NOW, monotonic: () => 1_000, fetchLedger: async () => chain.ledger } });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  await service.startLedger();
  return service;
}

const CHANNEL = (w: World) => `commands:rpc#${w.root.accountId}`;

/** An in-memory relay: a packet published for `target` is executed there exactly like CentrifugoClient's commands subscription does. */
function relay(w: World, target: BridgeSecurityService, dispatch: (message: VerifiedApplication) => Promise<ApplicationJson>): PeerTransport & { sent: number; online: boolean } {
  const transport = {
    sent: 0,
    online: true,
    peerChannel: () => CHANNEL(w),
    async peerExchange(packet: SecureEnvelope, peerEndpointId: string): Promise<SecureEnvelope> {
      transport.sent++;
      if (!transport.online || packet.recipientId !== target.endpoint.id || peerEndpointId !== target.endpoint.id) throw new BridgeSecurityError('bridge_offline');
      return executeSecurePacket(target, packet, { transport: 'cloud', channel: CHANNEL(w), bridgeId: target.bridgeId, pairId: null }, dispatch);
    },
  };
  return transport;
}

const echo = async (message: VerifiedApplication): Promise<ApplicationJson> => {
  const route = message.application.route;
  if (route.kind !== 'http') return { type: 'command_response', response: { requestId: 'x', success: true } };
  return { status: 200, body: { method: route.method, path: route.path, sender: message.principal.endpoint.kind,
    permissions: [...message.principal.permissions], body: (message.application.data as { body?: ApplicationJson }).body ?? null } };
};

test('a bridge lists the other bridges of its account, never itself', async t => {
  const w = await world();
  const studio = await bridge(t, w, w.studio, w.both);
  assert.deepEqual(studio.peerBridges().map(peer => peer.bridgeId), ['desk-0001']);
  const peers = new PeerControl(studio, relay(w, studio, echo));
  assert.deepEqual((await peers.list()).map(peer => [peer.bridgeId, peer.label]), [['desk-0001', 'Desk']]);
});

test('a peer bridge drives another bridge\'s local API over the sealed relay as a read + control principal', async t => {
  const w = await world();
  const studio = await bridge(t, w, w.studio, w.both);
  const desk = await bridge(t, w, w.desk, w.both);
  const transport = relay(w, desk, echo);
  const peers = new PeerControl(studio, transport);

  const listed = await peers.http('Desk', 'GET', '/api/sessions');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { method: 'GET', path: '/api/sessions', sender: 'bridge', permissions: ['read', 'control'], body: null });

  const created = await peers.http('desk-0001', 'POST', '/api/sessions', { shellType: 'claude', prompt: 'hi' });
  assert.deepEqual((created.body as { body: ApplicationJson }).body, { shellType: 'claude', prompt: 'hi' });
  // One handshake, then reuse of the learned receiver epoch: hello + 2 requests.
  assert.equal(transport.sent, 3);

  // Resolution by id prefix too.
  assert.equal((await peers.http('desk', 'GET', '/api/archive')).status, 200);
});

test('a peer restart (new receiver epoch) is retried once with a fresh handshake', async t => {
  const w = await world();
  const studio = await bridge(t, w, w.studio, w.both);
  const first = await bridge(t, w, w.desk, w.both);
  let target = first;
  const transport: PeerTransport = {
    peerChannel: () => CHANNEL(w),
    peerExchange: packet => executeSecurePacket(target, packet, { transport: 'cloud', channel: CHANNEL(w), bridgeId: target.bridgeId, pairId: null }, echo),
  };
  const peers = new PeerControl(studio, transport);
  assert.equal((await peers.http('Desk', 'GET', '/api/sessions')).status, 200);
  target = await bridge(t, w, w.desk, w.both); // same keys, new process: new receiverEpoch
  assert.notEqual(target.receiverEpoch, first.receiverEpoch);
  assert.equal((await peers.http('Desk', 'GET', '/api/sessions')).status, 200);
});

test('admin (security) operations are refused to peer bridges', async t => {
  const w = await world();
  const desk = await bridge(t, w, w.desk, w.both);
  const principal = await desk.policy.principal(w.studio.identity.endpoint.id);
  assert.deepEqual(principal.permissions, ['read', 'control']);
  await assert.rejects(desk.listDevices(principal), (error: unknown) => error instanceof BridgeSecurityError && error.code === 'permission_denied');
});

test('a bridge revoked in the ledger can no longer drive its former peers', async t => {
  const w = await world();
  const studio = await bridge(t, w, w.studio, w.both);
  const desk = await bridge(t, w, w.desk, w.deskRevokedStudio);
  const peers = new PeerControl(studio, relay(w, desk, echo));
  await assert.rejects(peers.http('Desk', 'GET', '/api/sessions'));
  // And the revoked bridge sees no peers of its own once it holds that ledger.
  const revoked = await bridge(t, w, w.studio, w.deskRevokedStudio);
  assert.deepEqual(revoked.peerBridges(), []);
});

test('targets are validated before anything is sent', async t => {
  const w = await world();
  const studio = await bridge(t, w, w.studio, w.both);
  const transport = relay(w, studio, echo);
  const peers = new PeerControl(studio, transport);
  const status = (expected: number) => (error: unknown) => error instanceof PeerTargetError && error.status === expected;
  await assert.rejects(peers.http('nope', 'GET', '/api/sessions'), status(404));
  await assert.rejects(peers.http('studio', 'GET', '/api/sessions'), status(400));
  await assert.rejects(peers.http('Desk', 'GET', '/api/peers'), status(400));
  await assert.rejects(peers.http('Desk', 'GET', 'https://evil.example/api'), status(400));
  await assert.rejects(peers.http('Desk', 'TRACE', '/api/sessions'), status(400));
  assert.equal(transport.sent, 0);
});

test('an unreachable peer is reported as such (504) and probed as offline', async t => {
  const w = await world();
  const studio = await bridge(t, w, w.studio, w.both);
  const desk = await bridge(t, w, w.desk, w.both);
  const transport = relay(w, desk, echo);
  transport.online = false;
  const peers = new PeerControl(studio, transport);
  await assert.rejects(peers.http('Desk', 'GET', '/api/sessions'), (error: unknown) => error instanceof PeerTargetError && error.status === 504);
  assert.deepEqual((await peers.list(true)).map(peer => peer.online), [false]);
  transport.online = true;
  assert.deepEqual((await peers.list(true)).map(peer => peer.online), [true]);
});

// ---- Direct bridge-to-bridge links ----

/** In-memory WebRTC: an offerer and an answerer are joined once each holds the other's description. */
class FakeChannel implements LinkDataChannel {
  other?: FakeChannel; open = false; sent = 0; drop = false;
  private handlers = { open: [] as (() => void)[], closed: [] as (() => void)[], message: [] as ((msg: string) => void)[] };
  sendMessage(msg: string): boolean {
    if (!this.open) return false;
    this.sent++;
    if (!this.drop) queueMicrotask(() => { if (this.other?.open) for (const cb of this.other.handlers.message) cb(msg); });
    return true;
  }
  isOpen(): boolean { return this.open; }
  close(): void {
    if (!this.open) return;
    this.open = false; for (const cb of this.handlers.closed) cb();
    this.other?.close();
  }
  onOpen(cb: () => void): void { this.handlers.open.push(cb); }
  onClosed(cb: () => void): void { this.handlers.closed.push(cb); }
  onError(): void { /* never errors */ }
  onMessage(cb: (msg: string) => void): void { this.handlers.message.push(cb); }
  becomeOpen(): void { this.open = true; for (const cb of this.handlers.open) cb(); }
}
class FakeConnection implements LinkPeerConnection {
  static byDescription = new Map<string, FakeConnection>();
  static count = 0;
  private readonly id = ++FakeConnection.count;
  private local: { sdp: string; type: string } | null = null;
  private gathering: ((state: string) => void)[] = [];
  private incoming: ((dc: LinkDataChannel) => void)[] = [];
  channel?: FakeChannel;
  private offerer?: FakeConnection;
  private describe(type: string): void {
    this.local = { type, sdp: `${type}:${this.id}` };
    FakeConnection.byDescription.set(this.local.sdp, this);
    queueMicrotask(() => { for (const cb of this.gathering) cb('complete'); });
  }
  createDataChannel(): LinkDataChannel { this.channel = new FakeChannel(); this.describe('offer'); return this.channel; }
  setRemoteDescription(sdp: string, type: string): void {
    const remote = FakeConnection.byDescription.get(sdp);
    if (!remote) throw new Error('Unknown description');
    if (type === 'offer') { this.offerer = remote; this.describe('answer'); return; }
    // The answer reached the offerer: both ends are described, so the channel opens on both.
    const answerer = remote;
    if (answerer.offerer !== this || !this.channel) throw new Error('Mismatched answer');
    answerer.channel = new FakeChannel();
    answerer.channel.other = this.channel; this.channel.other = answerer.channel;
    for (const cb of answerer.incoming) cb(answerer.channel);
    queueMicrotask(() => { answerer.channel!.becomeOpen(); this.channel!.becomeOpen(); });
  }
  localDescription(): { sdp: string; type: string } | null { return this.local; }
  gatheringState(): string { return 'new'; }
  onGatheringStateChange(cb: (state: string) => void): void { this.gathering.push(cb); }
  onLocalCandidate(): void { /* completion is reported instead */ }
  onStateChange(): void { /* driven through the channel in these tests */ }
  onDataChannel(cb: (dc: LinkDataChannel) => void): void { this.incoming.push(cb); }
  close(): void { this.channel?.close(); }
}

interface Linked { peers: PeerControl; transport: ReturnType<typeof relay>; studioLinks: PeerLinks; deskLinks: PeerLinks; connections: FakeConnection[];
  studio: BridgeSecurityService; desk: BridgeSecurityService; settle: () => Promise<void> }

/** Studio drives Desk. Desk serves `echo`, plus the link offer endpoint exactly as the local API server does (peer bridges only). */
async function linked(t: TestContext, w: World, deskChain: Chain = w.both): Promise<Linked> {
  const studio = await bridge(t, w, w.studio, w.both);
  const desk = await bridge(t, w, w.desk, deskChain);
  const connections: FakeConnection[] = [];
  const factory = () => { const pc = new FakeConnection(); connections.push(pc); return pc; };
  const serve = async (message: VerifiedApplication): Promise<ApplicationJson> => {
    const route = message.application.route;
    if (route.kind === 'http' && route.path === '/api/peers/link') {
      const peer = desk.peerBridges().find(item => item.endpoint.id === message.principal.endpoint.id);
      if (message.principal.endpoint.kind !== 'bridge' || !peer) return { status: 403, body: { error: 'permission_denied' } };
      const offer = (message.application.data as { body: { pairId: string; sdp: string } }).body;
      return { status: 200, body: await deskLinks.accept(peer, offer.pairId, offer.sdp) };
    }
    return echo(message);
  };
  const quiet = { log: () => undefined, factory };
  const deskLinks: PeerLinks = new PeerLinks({ ...quiet, bridgeId: desk.bridgeId, endpointId: desk.endpoint.id, peers: () => desk.peerBridges(),
    onRevoked: listener => desk.onRevoked(listener), execute: (packet, route) => executeSecurePacket(desk, packet, route, serve) });
  const studioLinks = new PeerLinks({ ...quiet, bridgeId: studio.bridgeId, endpointId: studio.endpoint.id, peers: () => studio.peerBridges(),
    execute: (packet, route) => executeSecurePacket(studio, packet, route, echo) });
  t.after(() => { studioLinks.closeAll(); deskLinks.closeAll(); });
  const transport = relay(w, desk, serve);
  const peers = new PeerControl(studio, transport, studioLinks);
  // The link is opened beside the first request; wait for that attempt itself to finish.
  const settle = async () => { await peers.linked('Desk').catch(() => false); };
  return { peers, transport, studioLinks, deskLinks, connections, studio, desk, settle };
}

test('the first request opens a direct link and later requests bypass the relay', async t => {
  const w = await world();
  const { peers, transport, studioLinks, deskLinks, settle } = await linked(t, w);

  assert.equal((await peers.list())[0].direct, false);
  assert.equal((await peers.http('Desk', 'GET', '/api/sessions')).status, 200);
  await settle();
  assert.deepEqual(studioLinks.status().map(link => link.bridgeId), ['desk-0001']);
  assert.deepEqual(deskLinks.status().map(link => link.bridgeId), ['studio']);
  assert.equal((await peers.list())[0].direct, true);

  const relayed = transport.sent;
  const listed = await peers.http('Desk', 'GET', '/api/sessions?archived=1');
  assert.deepEqual(listed.body, { method: 'GET', path: '/api/sessions?archived=1', sender: 'bridge', permissions: ['read', 'control'], body: null });
  const created = await peers.http('Desk', 'POST', '/api/sessions', { prompt: 'x'.repeat(100_000) });
  assert.equal(((created.body as { body: { prompt: string } }).body.prompt).length, 100_000);
  assert.equal(transport.sent, relayed, 'nothing more went through the relay');
});

test('a link accepts only envelopes sealed for it, only cross-bridge requests, and only from a bridge', async t => {
  const w = await world();
  const { peers, studio, desk, studioLinks, settle } = await linked(t, w);
  await peers.http('Desk', 'GET', '/api/sessions'); await settle();
  const pairId = studioLinks.status()[0].pairId;
  const channel = peerLinkChannel(desk.bridgeId, pairId);
  const route = { transport: 'bridge-link' as const, channel, bridgeId: desk.bridgeId, pairId };
  const deskEntry = studio.peerBridges()[0];
  const hello = await studio.sealToPeer(deskEntry, 'hello', { type: 'hello', challenge: 'c'.repeat(32) }, channel, crypto.randomUUID(), null);
  const welcome = await studio.openFromPeer(deskEntry, await desk.handleHandshake(hello, route), 'welcome', channel) as { receiverEpoch: string };
  const seal = (application: unknown, sealedFor: string, id: string) => studio.sealToPeer(deskEntry, 'application', application, sealedFor, id, welcome.receiverEpoch);

  const ok = crypto.randomUUID();
  await desk.acceptApplication(await seal({ type: 'application', route: { kind: 'http', requestId: ok, method: 'GET', path: '/api/sessions' }, data: {}, mcp: null }, channel, ok), route);

  // Sealed for the relay channel: not acceptable on the link.
  const relayed = crypto.randomUUID();
  await assert.rejects(desk.acceptApplication(await seal({ type: 'application', route: { kind: 'http', requestId: relayed, method: 'GET', path: '/api/sessions' },
    data: {}, mcp: null }, CHANNEL(w), relayed), route));
  // Sealed for the link: not acceptable on the relay.
  const direct = crypto.randomUUID();
  await assert.rejects(desk.acceptApplication(await seal({ type: 'application', route: { kind: 'http', requestId: direct, method: 'GET', path: '/api/sessions' },
    data: {}, mcp: null }, channel, direct), { transport: 'cloud', channel: CHANNEL(w), bridgeId: desk.bridgeId, pairId: null }));
  // A command (the browser surface) is never served on a link.
  const command = crypto.randomUUID();
  await assert.rejects(desk.acceptApplication(await seal({ type: 'application', route: { kind: 'command', requestId: command, command: 'list_sessions', sessionId: null },
    data: { type: 'list_sessions', requestId: command, payload: { bridgeId: desk.bridgeId } }, mcp: null }, channel, command), route),
    (error: unknown) => error instanceof BridgeSecurityError && error.code === 'wrong_context');
});

test('a dropped link falls back to the relay; an unanswered change is reported, never repeated', async t => {
  const w = await world();
  const { peers, transport, connections, studioLinks, settle } = await linked(t, w);
  await peers.http('Desk', 'GET', '/api/sessions'); await settle();
  assert.equal(studioLinks.status().length, 1);

  // The peer stops answering on the link: the change is in doubt, so it is not sent again over the relay.
  const before = transport.sent;
  connections[0].channel!.drop = true;
  const pending = peers.http('Desk', 'POST', '/api/sessions', { prompt: 'once' }, 50);
  await assert.rejects(pending, /Direct link lost/);
  assert.equal(transport.sent, before);
  assert.equal(studioLinks.status().length, 0, 'the unanswered link is closed');

  // With no link, the next request travels over the relay again.
  assert.equal((await peers.http('Desk', 'GET', '/api/sessions')).status, 200);
  assert.ok(transport.sent > before);
});

test('a read that goes unanswered on the link is retried over the relay', async t => {
  const w = await world();
  const { peers, transport, connections, settle } = await linked(t, w);
  await peers.http('Desk', 'GET', '/api/sessions'); await settle();
  const before = transport.sent;
  connections[0].channel!.drop = true;
  assert.equal((await peers.http('Desk', 'GET', '/api/sessions', undefined, 50)).status, 200);
  assert.ok(transport.sent > before);
});

test('a bridge revoked in the ledger gets no link', async t => {
  const w = await world();
  // Desk already holds the ledger that revokes Studio: the offer is never answered.
  const refused = await linked(t, w, w.deskRevokedStudio);
  await assert.rejects(refused.peers.http('Desk', 'GET', '/api/sessions'));
  await refused.settle();
  assert.equal(refused.studioLinks.status().length, 0);
  assert.equal(refused.deskLinks.status().length, 0);

  // An offer for a bridge that is not a peer is refused outright.
  await assert.rejects(refused.deskLinks.accept(w.studio.entry, crypto.randomUUID(), 'offer:0'), /Unknown peer/);
});

test('a failed link attempt backs off instead of retrying on every request', async t => {
  const w = await world();
  const studio = await bridge(t, w, w.studio, w.both);
  const desk = await bridge(t, w, w.desk, w.both);
  // Desk runs an ftown without direct links: the offer path is unknown there.
  let offers = 0;
  const serve = async (message: VerifiedApplication): Promise<ApplicationJson> => {
    const route = message.application.route;
    if (route.kind === 'http' && route.path === '/api/peers/link') { offers++; return { status: 403, body: { error: 'permission_denied' } }; }
    return echo(message);
  };
  const logged: string[] = [];
  const links = new PeerLinks({ log: line => { logged.push(line); }, factory: () => new FakeConnection(), bridgeId: studio.bridgeId, endpointId: studio.endpoint.id,
    peers: () => studio.peerBridges(), execute: (packet, route) => executeSecurePacket(studio, packet, route, echo) });
  t.after(() => links.closeAll());
  const peers = new PeerControl(studio, relay(w, desk, serve), links);
  for (let i = 0; i < 3; i++) {
    assert.equal((await peers.http('Desk', 'GET', '/api/sessions')).status, 200);
    assert.equal(await peers.linked('Desk'), false);
  }
  assert.equal(offers, 1);
  // The one attempt says why it failed: nothing else reports it, the request itself succeeded over the relay.
  assert.deepEqual(logged, ['[Peers] Direct link to Desk not opened: Link refused (403)']);
});

after(() => cleanup());

test('two paired bridges copy a multi-MiB snapshot over native WebRTC and never send bulk via the relay', { timeout: 60_000 }, async t => {
  const w = await world();
  const sender = await bridge(t, w, w.studio, w.both);
  const recipient = await bridge(t, w, w.desk, w.both);
  const sourceApi = new LocalApiServer();
  const targetApi = new LocalApiServer();
  const dir = await mkdtemp(join(tmpdir(), 'ftown-folder-loopback-'));
  const source = join(dir, 'source');
  const target = join(dir, 'target');
  await mkdir(join(source, 'sub', 'empty'), { recursive: true });
  const file = join(source, 'sub', 'fixture');
  const fixtureMiB = 64;
  const fixture = randomBytes(fixtureMiB * 1024 ** 2);
  const expected = createHash('sha256').update(fixture).digest('hex');
  await writeFile(file, fixture);
  await chmod(file, 0o754);
  await writeFile(join(source, 'empty-file'), '');
  await chmod(dir, 0o2700);

  const setup = async (security: BridgeSecurityService, api: LocalApiServer) => {
    api.setSecurity(security, { protocolVersion: 1, ownerId: w.root.accountId, bridgeId: security.bridgeId,
      endpoint: security.endpoint, relayUserId: w.root.accountId }, async () => null);
    const cli = await generateEndpoint(w.root.accountId, 'local-cli');
    await security.policy.provisionLocalEndpoint(cli.endpoint);
    const principal = await security.policy.principal(cli.endpoint.id);
    return async (body: unknown) => {
      const answer = await api.dispatchSecure({
        principal, application: { route: { kind: 'http', method: 'POST', path: TRANSFER_LOCAL }, data: { body } },
      } as VerifiedApplication) as { status: number; body: { id: string; state: string; error?: string; bytes: number; entries?: number } };
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body;
    };
  };
  const sourceCLI = await setup(sender, sourceApi);
  const targetCLI = await setup(recipient, targetApi);
  let highWater = 0;
  function links(security: BridgeSecurityService, api: LocalApiServer): PeerLinks {
    return new PeerLinks({
      bridgeId: security.bridgeId, endpointId: security.endpoint.id, peers: () => security.peerBridges(),
      log: message => t.diagnostic(message),
      factory: name => {
        const pc = new PeerConnection(name, { iceServers: [] });
        return {
          setRemoteDescription: (sdp, type) => pc.setRemoteDescription(sdp, type as 'offer' | 'answer'),
          localDescription: () => pc.localDescription(),
          createDataChannel: label => {
            const channel = pc.createDataChannel(label);
            return {
              sendMessage(message) {
                const sent = channel.sendMessage(message);
                highWater = Math.max(highWater, channel.bufferedAmount());
                return sent;
              },
              sendMessageBinary(message) {
                const sent = channel.sendMessageBinary(message);
                highWater = Math.max(highWater, channel.bufferedAmount());
                return sent;
              },
              bufferedAmount: () => channel.bufferedAmount(),
              isOpen: () => channel.isOpen(),
              close: () => channel.close(),
              onOpen: cb => channel.onOpen(cb),
              onClosed: cb => channel.onClosed(cb),
              onError: cb => channel.onError(cb),
              onMessage: cb => channel.onMessage(cb),
            };
          },
          gatheringState: () => pc.gatheringState(),
          onGatheringStateChange: cb => pc.onGatheringStateChange(cb),
          onLocalCandidate: cb => pc.onLocalCandidate(cb),
          onStateChange: cb => pc.onStateChange(cb),
          onDataChannel: cb => pc.onDataChannel(cb),
          close: () => pc.close(),
        };
      },
      execute: (packet, route) => executeSecurePacket(security, packet, route, message => api.dispatchSecure(message)),
    });
  }
  const sourceLinks = links(sender, sourceApi);
  const targetLinks = links(recipient, targetApi);
  t.after(async () => {
    await Promise.all([sourceApi.closeTransfers(), targetApi.closeTransfers()]);
    sourceLinks.closeAll();
    targetLinks.closeAll();
    await rm(dir, { recursive: true, force: true });
  });
  const toTarget = relay(w, recipient, message => targetApi.dispatchSecure(message));
  const toSource = relay(w, sender, message => sourceApi.dispatchSecure(message));
  const peers = new PeerControl(sender, toTarget, sourceLinks);
  sourceApi.setPeerControl(peers, sourceLinks, join(dir, 'sender-journal'));
  targetApi.setPeerControl(new PeerControl(recipient, toSource, targetLinks), targetLinks, join(dir, 'recipient-journal'));

  await assert.rejects(peers.http('Desk', 'POST', TRANSFER_WIRE, { chunk: 'fixture' }), /dedicated direct/);
  assert.equal(toTarget.sent, 0);
  const invitation = await targetCLI({ action: 'receive', bridge: 'Studio', path: target });
  const started = performance.now();
  const initial = await sourceCLI({ action: 'send', bridge: 'Desk', path: source, id: invitation.id });
  assert.equal(initial.state, 'connecting');
  let last = initial;
  for (;;) {
    last = await sourceCLI({ action: 'status', id: invitation.id });
    if (!['connecting', 'copying', 'verifying', 'installing'].includes(last.state)) break;
    await delay(15, undefined, { signal: t.signal });
  }
  const elapsed = (performance.now() - started) / 1000;
  assert.equal(last.state, 'installed', last.error);
  assert.equal(last.entries, 4);
  assert.equal((await targetCLI({ action: 'status', id: invitation.id })).bytes, last.bytes);
  assert.equal(toTarget.sent, 2, 'relay carried only hello and link signaling');
  assert.equal(toSource.sent, 0);
  assert.equal(createHash('sha256').update(await readFile(join(target, 'sub', 'fixture'))).digest('hex'), expected);
  assert.deepEqual((await readdir(target)).sort(), ['empty-file', 'sub']);
  assert.deepEqual(await readdir(join(target, 'sub', 'empty')), []);
  assert.equal((await stat(join(target, 'sub', 'fixture'))).mode & 0o7777, 0o600);
  assert.equal((await stat(target)).mode & 0o7777, 0o700);
  assert.equal((await stat(join(target, 'sub'))).mode & 0o7777, 0o700);
  assert.deepEqual(await readdir(join(dir, 'recipient-journal')), []);
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('.ftown-transfer-')));
  t.diagnostic(`${fixtureMiB} MiB in ${elapsed.toFixed(2)} s (${(fixtureMiB / elapsed).toFixed(2)} MiB/s), sender DataChannel buffered high-water ${highWater} bytes`);

  const cancelledTarget = join(dir, 'cancelled');
  const second = await targetCLI({ action: 'receive', bridge: 'Studio', path: cancelledTarget });
  await sourceCLI({ action: 'send', bridge: 'Desk', path: source, id: second.id });
  await sourceCLI({ action: 'cancel', id: second.id });
  for (;;) {
    const status = await sourceCLI({ action: 'status', id: second.id });
    if (status.state === 'cancelled') break;
    assert.ok(['connecting', 'copying'].includes(status.state), JSON.stringify(status));
    await delay(15, undefined, { signal: t.signal });
  }
  assert.equal((await targetCLI({ action: 'status', id: second.id })).state, 'cancelled');
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('.ftown-transfer-')));
  assert.equal(toTarget.sent, 2, 'a second transfer reused the direct link');
});

test('the encrypted relay cannot admit a folder transfer request', async t => {
  const w = await world();
  const sender = await bridge(t, w, w.studio, w.both);
  const recipient = await bridge(t, w, w.desk, w.both);
  const peer = sender.peerBridges()[0];
  const channel = CHANNEL(w);
  const route = { transport: 'cloud' as const, channel, bridgeId: recipient.bridgeId, pairId: null };
  const id = crypto.randomUUID();
  for (const path of [TRANSFER_WIRE, TRANSFER_LOCAL]) {
    const packet = await sender.sealToPeer(peer, 'application',
      { type: 'application', route: { kind: 'http', method: 'POST', path, requestId: id }, data: {}, mcp: null },
      channel, id, recipient.receiverEpoch, TRANSFER_REQUEST_TTL_MS);
    await assert.rejects(recipient.acceptApplication(packet, route), (error: unknown) =>
      error instanceof BridgeSecurityError && error.code === 'wrong_context');
  }
});
