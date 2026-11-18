import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
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
