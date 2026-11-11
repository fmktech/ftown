import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createCommandHandler } from '../../command-rpc.js';
import { createAccountRelay, createLedgerServer } from '../../ledger-relay.js';
import { createLedgerReoffer } from '../../ledger-reoffer.js';
import { LocalApiServer } from '../../local-api-server.js';
import type { SessionController } from '../../session-controller.js';
import type { CommandResponse } from '../../types.js';
import { generateEndpoint, seal } from '../crypto.js';
import {
  chooseLedger, ledgerChallenge, ledgerLastIssuedAt, ledgerRevocations, nextTransition, resolutionPlan, resolveForkTransition, verifyLedger, accountIdOf,
} from '../ledger/ledger.js';
import { generateAuthKey } from '../ledger/proof.js';
import { LEDGER_LIMITS } from '../ledger/protocol.js';
import type { Ledger, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from '../ledger/protocol.js';
import { createSoftPasskey } from '../ledger/testing.js';
import type { SoftPasskey } from '../ledger/testing.js';
import type { EndpointIdentity, InboundTransportContext, SecureApplication, VerifiedApplication, VerifiedPrincipal } from '../protocol.js';
import { BridgeLedgerStore } from './ledger-store.js';
import type { LedgerSource } from './ledger-store.js';
import { LEDGER_CHAIN_PAGE_BYTES } from './ledger-rpc.js';
import { classifyCommand } from './permissions.js';
import { LOCAL_RECOVERY_AUTHORITY } from './policy.js';
import { BridgeSecurityService } from './security.js';

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
const T0 = 1_750_000_000_000;
const START = T0 + 3_600_000;
const GRACE = LEDGER_LIMITS.offlineGraceMs;
const BRIDGE = 'studio';

interface Chain { ledger: Ledger; accountId: string }
interface Browser { identity: EndpointIdentity; device: LedgerDevice }

async function signed<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload)) };
}
async function genesis(passkey: SoftPasskey): Promise<Chain> {
  const record = await signed(passkey, {
    type: 'ftown_account_genesis', version: 2, rpId, origins: [origin], handle: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    createdAt: T0, authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'iCloud Keychain', addedAt: T0 },
  });
  return { ledger: { genesis: record, transitions: [] }, accountId: await accountIdOf(record.payload) };
}
async function append(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation): Promise<Chain> {
  const last = ledgerLastIssuedAt(chain.ledger);
  const payload = nextTransition(await verifyLedger(chain.ledger, START), passkey.credentialId, operation, last + 1000, last);
  return { ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, await signed(passkey, payload)] }, accountId: chain.accountId };
}
/** Appends many records quickly: each step verifies only the new record (chooseLedger with the previous checkpoint as its cache). */
async function grow(chain: Chain, passkey: SoftPasskey, operations: LedgerOperation[]): Promise<Chain> {
  let ledger = chain.ledger;
  let checkpoint = await verifyLedger(ledger, START);
  for (const operation of operations) {
    const last = ledgerLastIssuedAt(ledger);
    const payload = nextTransition(checkpoint, passkey.credentialId, operation, last + 1000, last);
    const next: Ledger = { genesis: ledger.genesis, transitions: [...ledger.transitions, await signed(passkey, payload)] };
    const choice = await chooseLedger(ledger, next, START, { head: checkpoint.head, checkpoint });
    assert.equal(choice.decision, 'adopt');
    checkpoint = choice.checkpoint;
    ledger = choice.ledger;
  }
  return { ledger, accountId: chain.accountId };
}
async function browser(accountId: string, label: string): Promise<Browser> {
  const identity = await generateEndpoint(accountId, 'browser');
  return { identity, device: { endpoint: identity.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label, approvedAt: T0 } };
}

/**
 * base: genesis + add_device laptop + add_bridge studio. withPhone: base + phone. revokeLaptop: withPhone + revoke_device laptop.
 * longer: withPhone + tablet (4 records). Histories that DIVERGE from withPhone/longer at revision 3: revokeBridgeFork (base + revoke_bridge
 * studio), dropLaptopFork (base + revoke_device laptop), deskFork (base + tablet + desk, 4 records: longer than withPhone, without phone).
 * Extensions: revokeBridgeAhead (longer + revoke_bridge studio), revokePhoneThenBridge (revokePhone + revoke_bridge studio).
 * notListed: genesis + laptop. wrongKey: notListed + studio under another endpoint and auth key. wrongAuth: notListed + studio with this
 * endpoint but another auth key. foreign: another account that lists this bridge's exact keys.
 */
interface World {
  accountId: string; bridge: EndpointIdentity; bridgeAuth: string; cli: EndpointIdentity; laptop: Browser; phone: Browser; tablet: Browser; desk: Browser;
  passkey: SoftPasskey;
  base: Chain; withPhone: Chain; revokeLaptop: Chain; revokePhone: Chain; revokeBoth: Chain; longer: Chain; revokeBridgeFork: Chain;
  dropLaptopFork: Chain; deskFork: Chain; revokeBridgeAhead: Chain; revokePhoneThenBridge: Chain;
  notListed: Chain; wrongKey: Chain; wrongAuth: Chain; foreign: Chain;
}
let built: Promise<World> | null = null;
function world(): Promise<World> {
  built ??= (async () => {
    const passkey = await createSoftPasskey({ rpId, origin });
    const root = await genesis(passkey);
    const accountId = root.accountId;
    const bridge = await generateEndpoint(accountId, 'bridge');
    const bridgeAuth = (await generateAuthKey(false)).publicKey;
    const cli = await generateEndpoint(accountId, 'local-cli');
    const [laptop, phone, tablet, desk] = await Promise.all(['Laptop', 'Phone', 'Tablet', 'Desk'].map(label => browser(accountId, label)));
    const studio = { bridgeId: BRIDGE, endpoint: bridge.endpoint, authPublicKey: bridgeAuth, label: 'Studio', approvedAt: T0 };
    const notListed = await append(root, passkey, { type: 'add_device', device: laptop.device });
    const base = await append(notListed, passkey, { type: 'add_bridge', bridge: studio });
    const withPhone = await append(base, passkey, { type: 'add_device', device: phone.device });
    const revokeLaptop = await append(withPhone, passkey, { type: 'revoke_device', endpointId: laptop.identity.endpoint.id });
    const revokePhone = await append(withPhone, passkey, { type: 'revoke_device', endpointId: phone.identity.endpoint.id });
    const revokeBoth = await append(revokePhone, passkey, { type: 'revoke_device', endpointId: laptop.identity.endpoint.id });
    const longer = await append(withPhone, passkey, { type: 'add_device', device: tablet.device });
    const revokeBridgeFork = await append(base, passkey, { type: 'revoke_bridge', bridgeId: BRIDGE });
    const dropLaptopFork = await append(base, passkey, { type: 'revoke_device', endpointId: laptop.identity.endpoint.id });
    const deskFork = await append(await append(base, passkey, { type: 'add_device', device: tablet.device }), passkey, { type: 'add_device', device: desk.device });
    const revokeBridgeAhead = await append(longer, passkey, { type: 'revoke_bridge', bridgeId: BRIDGE });
    const revokePhoneThenBridge = await append(revokePhone, passkey, { type: 'revoke_bridge', bridgeId: BRIDGE });
    const impostor = await generateEndpoint(accountId, 'bridge');
    const wrongKey = await append(notListed, passkey, { type: 'add_bridge',
      bridge: { ...studio, endpoint: impostor.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey } });
    const wrongAuth = await append(notListed, passkey, { type: 'add_bridge', bridge: { ...studio, authPublicKey: (await generateAuthKey(false)).publicKey } });
    const otherPasskey = await createSoftPasskey({ rpId, origin });
    const otherRoot = await genesis(otherPasskey);
    const foreign = await append(otherRoot, otherPasskey, { type: 'add_bridge', bridge: { ...studio, endpoint: { ...bridge.endpoint, ownerId: otherRoot.accountId } } });
    return { accountId, bridge, bridgeAuth, cli, laptop, phone, tablet, desk, passkey, base, withPhone, revokeLaptop, revokePhone, revokeBoth, longer, revokeBridgeFork, dropLaptopFork,
      deskFork, revokeBridgeAhead, revokePhoneThenBridge, notListed, wrongKey, wrongAuth, foreign };
  })();
  return built;
}

interface Harness {
  dir: string; store: BridgeLedgerStore; security: BridgeSecurityService; fetches: { count: number }; revoked: string[]; fired: { count: number };
  /** The store's `[ledger]` lines. */
  lines: string[];
  serve: (next: () => Promise<unknown>) => void; restart: () => BridgeSecurityService;
  /** Sets the wall clock only (a clock step); `elapse` moves wall and monotonic time together (real time passing). */
  setClock: (value: number) => void; elapse: (ms: number) => void;
  cli: () => Promise<VerifiedPrincipal>; principal: (who: Browser) => Promise<VerifiedPrincipal>; ids: () => Promise<string[]>;
  policyText: () => Promise<string>; ledgerText: () => Promise<string>;
}
async function seed(dir: string, chain: Chain, lastServerReadAt: number | null, extra: { deviceIds: string[]; bridgeIds: string[] } = { deviceIds: [], bridgeIds: [] }): Promise<void> {
  await mkdir(join(dir, 'security'), { recursive: true });
  const own = ledgerRevocations(chain.ledger);
  await writeFile(join(dir, 'security', 'ledger.json'), JSON.stringify({ version: 1, ledger: chain.ledger,
    checkpoint: await verifyLedger(chain.ledger, START),
    sticky: { deviceIds: [...own.deviceIds, ...extra.deviceIds], bridgeIds: [...own.bridgeIds, ...extra.bridgeIds] }, lastServerReadAt }));
}
/** A real BridgeLedgerStore in a temp dir, optionally seeded with `chain`; the server serves `null` (rejected) unless `serve` replaces it. */
async function harness(t: TestContext, w: World, chain: Chain | null, lastServerReadAt: number | null = START): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-ledger-security-'));
  // Closing persists the clock high-water, so every service closes before the directory goes.
  const services: BridgeSecurityService[] = [];
  t.after(async () => {
    for (const service of services) await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  if (chain) await seed(dir, chain, lastServerReadAt);
  let clock = START;
  let monotonic = 1_000;
  const fetches = { count: 0 };
  let fetcher: () => Promise<unknown> = async () => null;
  const lines: string[] = [];
  const store = new BridgeLedgerStore(dir, { accountId: w.accountId, now: () => clock, log: line => lines.push(line), bridgeId: BRIDGE });
  const revoked: string[] = [];
  const fired = { count: 0 };
  const make = (): BridgeSecurityService => {
    const service = new BridgeSecurityService(w.bridge, BRIDGE, dir, { relayUserId: w.accountId, now: () => clock,
      ledger: { store, bridgeId: BRIDGE, authPublicKey: w.bridgeAuth, now: () => clock, monotonic: () => monotonic,
        fetchLedger: () => { fetches.count++; return fetcher(); } } });
    service.onRevoked(id => { revoked.push(id); });
    service.onBridgeRevoked(() => { fired.count++; });
    services.push(service);
    return service;
  };
  const security = make();
  await security.policy.provisionLocalEndpoint(w.cli.endpoint);
  const h: Harness = {
    dir, store, security, fetches, revoked, fired, lines,
    serve: next => { fetcher = next; }, restart: make,
    setClock: value => { clock = value; }, elapse: ms => { clock += ms; monotonic += ms; },
    cli: () => h.security.policy.principal(w.cli.endpoint.id),
    principal: who => h.security.policy.principal(who.identity.endpoint.id),
    ids: async () => (await h.security.listDevices(await h.cli())).map(device => device.endpoint.id).sort(),
    policyText: () => readFile(join(dir, 'security', 'policy.json'), 'utf8'),
    ledgerText: () => readFile(join(dir, 'security', 'ledger.json'), 'utf8'),
  };
  return h;
}
const ids = (...items: (Browser | EndpointIdentity)[]): string[] => items.map(item => 'identity' in item ? item.identity.endpoint.id : item.endpoint.id).sort();
const code = (expected: string) => (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
const microtasks = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const chainHead = (chain: Chain): Promise<string> => verifyLedger(chain.ledger, START).then(checkpoint => checkpoint.head);
/** This bridge's own keys for store.ownBridgeStatus. */
const ownKeys = (w: World) => ({ bridgeId: BRIDGE, endpointId: w.bridge.endpoint.id, endpointPublicKey: w.bridge.endpoint.publicKey, authPublicKey: w.bridgeAuth });

test('projection makes the account devices exactly the trusted roster and emits onRevoked for each removal', async t => {
  const w = await world();
  const h = await harness(t, w, w.base, START - 1000);
  h.serve(async () => w.withPhone.ledger);
  await h.security.startLedger();
  assert.equal(h.fetches.count, 1);
  assert.deepEqual(h.security.ledgerStatus(), { accountId: w.accountId, revision: 3, head: await chainHead(w.withPhone), own: 'active', divergence: null, serverBehind: false, removedOnOtherHistory: false, announcements: { accepted: 0, dropped: 0 } });
  assert.deepEqual(await h.ids(), ids(w.cli, w.laptop, w.phone));
  const listed = await h.security.listDevices(await h.cli());
  assert.deepEqual(listed.filter(device => device.source === 'account').map(device => device.endpoint.id).sort(), ids(w.laptop, w.phone));
  const laptop = await h.principal(w.laptop);
  await h.principal(w.phone);
  // The accepted startup read is server contact, persisted for the next start.
  assert.equal((await h.store.read())?.lastServerReadAt, START);

  assert.equal(await h.security.offerLedger(w.revokeLaptop.ledger, 'relay'), 'adopt');
  assert.deepEqual(h.revoked, [w.laptop.identity.endpoint.id]);
  await assert.rejects(h.principal(w.laptop), code('account_device_revoked'));
  await assert.rejects(h.security.revalidate(laptop));
  assert.deepEqual(await h.ids(), ids(w.cli, w.phone));
  assert.equal(await h.security.offerLedger(w.revokeLaptop.ledger, 'relay'), 'keep');
  assert.equal(await h.security.offerLedger(w.withPhone.ledger, 'server'), 'keep');
  assert.deepEqual(h.revoked, [w.laptop.identity.endpoint.id], 'a kept chain never re-adds or re-emits');
  assert.equal(h.fired.count, 0);
});

test('ledger changes invalidate only the removed device: other principals, in-flight work and the local CLI keep working', async t => {
  const w = await world();
  const h = await harness(t, w, w.base);
  await h.security.startLedger();
  const cli = await h.cli();
  const laptop = await h.principal(w.laptop);
  // Adding a device disturbs no existing principal: no re-handshake, no endpoint_revoked.
  assert.equal(await h.security.offerLedger(w.withPhone.ledger, 'relay'), 'adopt');
  await h.security.revalidate(laptop);
  await h.security.policy.revalidate(laptop, 'control');
  await h.security.listDevices(laptop);
  await h.security.revalidate(cli);
  const phone = await h.principal(w.phone);
  // A chain that leaves every device in place disturbs nothing either.
  assert.equal(await h.security.offerLedger(w.longer.ledger, 'relay'), 'adopt');
  await h.security.revalidate(laptop); await h.security.revalidate(phone);
  // Removing phone refuses phone only.
  const fresh = await harness(t, w, w.withPhone);
  await fresh.security.startLedger();
  const a = await fresh.principal(w.laptop);
  const b = await fresh.principal(w.phone);
  const local = await fresh.cli();
  assert.equal(await fresh.security.offerLedger(w.revokePhone.ledger, 'relay'), 'adopt');
  await assert.rejects(fresh.security.revalidate(b), code('account_device_revoked'));
  await assert.rejects(fresh.principal(w.phone), code('account_device_revoked'));
  await fresh.security.revalidate(a);
  await fresh.security.listDevices(a);
  await fresh.security.revalidate(local);
  assert.deepEqual(fresh.revoked, [w.phone.identity.endpoint.id]);
  // Removing laptop refuses laptop.
  assert.equal(await fresh.security.offerLedger(w.revokeBoth.ledger, 'relay'), 'adopt');
  await assert.rejects(fresh.security.revalidate(a), code('account_device_revoked'));
  await assert.rejects(fresh.security.listDevices(a), code('account_device_revoked'));
  await fresh.security.revalidate(local);
  assert.deepEqual(fresh.revoked, [w.phone.identity.endpoint.id, w.laptop.identity.endpoint.id]);
});

test('P1: a browser removed on a VALID diverged history is refused right after the read that showed it, and still after a restart', async t => {
  const w = await world();
  const h = await harness(t, w, w.longer);
  const laptop = await (async () => { await h.security.startLedger(); return h.principal(w.laptop); })();
  await h.security.policy.revalidate(laptop, 'control');
  // The server's history (base + revoke laptop) diverges from ours: refused, but its removal of laptop is enforced here at once.
  h.serve(async () => w.dropLaptopFork.ledger);
  await h.security.refreshLedger();
  assert.equal(h.security.ledgerStatus().divergence?.source, 'server');
  assert.equal(h.security.ledgerStatus().head, await chainHead(w.longer), 'our chain is unchanged');
  assert.deepEqual(h.revoked, [w.laptop.identity.endpoint.id]);
  await assert.rejects(h.security.policy.revalidate(laptop, 'control'), code('account_device_revoked'));
  await assert.rejects(h.principal(w.laptop), code('account_device_revoked'));
  await h.principal(w.phone);
  assert.deepEqual(await h.ids(), ids(w.cli, w.phone, w.tablet));
  // Its raw checkpoint still lists laptop: only the sticky set (local enforcement) removes it.
  const state = (await h.store.read())!;
  assert.ok(state.checkpoint.devices.some(device => device.endpoint.id === w.laptop.identity.endpoint.id));
  assert.deepEqual(state.sticky, { deviceIds: [w.laptop.identity.endpoint.id], bridgeIds: [] });
  // 46 h later the laptop is still refused (offline grace is irrelevant to it), and so after a restart.
  h.elapse(46 * 3_600_000);
  h.security.noteServerContact();
  await assert.rejects(h.principal(w.laptop), code('account_device_revoked'));
  await h.security.close();
  h.security = h.restart();
  await h.security.startLedger();
  await assert.rejects(h.principal(w.laptop), code('account_device_revoked'));
  await h.principal(w.phone);
  // The ledger RPCs' membership check uses the same trusted view.
  await assert.rejects(h.security.memberHead(laptop), (error: unknown) => error instanceof Error);
  assert.equal(h.fired.count, 0);
});

test('a LONGER diverged chain from the server is never adopted and the trusted members are unchanged', async t => {
  const w = await world();
  const h = await harness(t, w, w.withPhone);
  await h.security.startLedger();
  const phone = await h.principal(w.phone);
  // deskFork (4 records) is longer than withPhone (3) and drops phone; it is valid, but not an extension of ours.
  assert.equal(await h.security.offerLedger(w.deskFork.ledger, 'server'), 'keep');
  assert.equal(h.security.ledgerStatus().head, await chainHead(w.withPhone));
  await h.security.revalidate(phone);
  await assert.rejects(h.principal(w.desk), code('approval_required'));
  assert.deepEqual(await h.ids(), ids(w.cli, w.laptop, w.phone));
  assert.deepEqual(h.revoked, []);
  assert.equal(h.fired.count, 0);
});

test('a device removed by an adopted chain is refused even when the policy write fails, and own revocation still emits', async t => {
  const w = await world();
  const h = await harness(t, w, w.withPhone);
  await h.security.startLedger();
  await h.principal(w.phone);
  const errors = t.mock.method(console, 'error', () => undefined);
  const snapshot: { transact: () => Promise<unknown> } = Reflect.get(h.security.policy, 'snapshot');
  const broken = t.mock.method(snapshot, 'transact', async () => { throw new Error('disk full'); });
  assert.equal(await h.security.offerLedger(w.revokePhone.ledger, 'relay'), 'adopt');
  await assert.rejects(h.principal(w.phone), code('account_device_revoked'));
  assert.deepEqual(h.revoked, []);
  broken.mock.restore();
  // The projection lands with the next decision (a relay echo of the stored chain goes through the store once more).
  assert.equal(await h.security.offerLedger(w.revokePhone.ledger, 'server'), 'keep');
  assert.equal(await h.security.offerLedger(w.withPhone.ledger, 'server'), 'keep');
  t.mock.method(snapshot, 'transact', async () => { throw new Error('disk full'); });
  assert.equal(await h.security.offerLedger(w.revokePhoneThenBridge.ledger, 'relay'), 'adopt');
  assert.equal(h.fired.count, 1);
  await assert.rejects(h.principal(w.laptop), code('account_bridge_revoked'));
  assert.ok(errors.mock.callCount() >= 2);
});

test('own revocation: an AHEAD chain that revokes this bridge emits once and closes every account device; the local CLI is untouched', async t => {
  const w = await world();
  const h = await harness(t, w, w.longer);
  await h.security.startLedger();
  await h.principal(w.phone);
  assert.equal(await h.security.offerLedger(w.revokeBridgeAhead.ledger, 'relay'), 'adopt');
  assert.equal(h.fired.count, 1);
  assert.equal(h.security.ledgerStatus().own, 'revoked');
  await assert.rejects(h.principal(w.phone), code('account_bridge_revoked'));
  await h.cli();
  assert.equal(await h.security.offerLedger(w.revokeBridgeAhead.ledger, 'server'), 'keep');
  assert.equal(await h.security.offerLedger(w.longer.ledger, 'relay'), 'keep');
  await microtasks();
  assert.equal(h.fired.count, 1, 'at most once per instance');
  const late = { count: 0 };
  const dropped = { count: 0 };
  h.security.onBridgeRevoked(() => { late.count++; });
  h.security.onBridgeRevoked(() => { dropped.count++; })();
  assert.equal(late.count, 0, 'a late listener is never invoked synchronously');
  await microtasks();
  assert.equal(late.count, 1);
  assert.equal(dropped.count, 0, 'unsubscribing before the microtask cancels the late delivery');
});

test('own removal: a DIVERGED chain that revokes this bridge is not evidence (no emission, no identity reset); it is recorded instead', async t => {
  const w = await world();
  const h = await harness(t, w, w.longer);
  await h.security.startLedger();
  const phone = await h.principal(w.phone);
  for (const source of ['relay', 'server'] as const) {
    const outcome = await h.security.offerLedgerResult(w.revokeBridgeFork.ledger, source);
    assert.deepEqual([outcome.decision, outcome.relation], ['keep', 'diverged']);
  }
  await microtasks();
  assert.equal(h.fired.count, 0);
  assert.equal(h.security.ledgerStatus().own, 'active');
  await h.security.revalidate(phone);
  assert.equal(await h.store.ownBridgeStatus(ownKeys(w)), 'active', 'the startup check after a restart agrees');
  assert.deepEqual((await h.store.read())!.sticky, { deviceIds: [], bridgeIds: [] });
  assert.deepEqual(h.security.ledgerStatus().divergence, {
    source: 'server', otherHead: (await chainHead(w.revokeBridgeFork)).slice(0, 8), otherRevision: 3, ourRevision: 4, firstSeen: START,
    forkRevision: 2, removedOnOtherHistory: true,
  });
  assert.equal(h.security.ledgerStatus().removedOnOtherHistory, true);
  const refused = h.lines.filter(line => line.includes('REFUSED'));
  assert.equal(refused.length, 1, 'one line per distinct other head');
  assert.match(refused[0], /; that history removes this computer$/);
  // Our own id never enters the sticky set, so neither the running check nor the startup check can ever reset on it.
  assert.deepEqual((await h.store.read())!.sticky.bridgeIds, []);
});

test('a stored chain that already revokes this bridge emits at startup without reading the server', async t => {
  const w = await world();
  const h = await harness(t, w, w.revokeBridgeFork);
  h.serve(async () => w.longer.ledger);
  await h.security.startLedger();
  assert.equal(h.fired.count, 1);
  assert.equal(h.fetches.count, 0);
  await assert.rejects(h.principal(w.laptop), code('account_bridge_revoked'));
});

test('absent (not listed, or listed with other keys, or another account) fails closed, logs once and never emits', async t => {
  const w = await world();
  const warn = t.mock.method(console, 'warn', () => undefined);
  for (const chain of [w.notListed, w.wrongKey, w.wrongAuth]) {
    const h = await harness(t, w, chain);
    const before = warn.mock.callCount();
    await h.security.startLedger();
    assert.equal(h.security.ledgerStatus().own, 'absent');
    await assert.rejects(h.principal(w.laptop), code('account_bridge_revoked'));
    assert.equal(await h.security.offerLedger(chain.ledger, 'relay'), 'keep');
    await microtasks();
    assert.equal(h.fired.count, 0);
    assert.equal(warn.mock.callCount() - before, 1, 'one line for entering absent');
    await h.cli();
  }
  const h = await harness(t, w, null);
  h.serve(async () => w.foreign.ledger);
  await h.security.startLedger();
  assert.equal(h.fired.count, 0);
  assert.deepEqual(h.security.ledgerStatus(), { accountId: null, revision: null, head: null, own: 'unpaired', divergence: null, serverBehind: false, removedOnOtherHistory: false, announcements: { accepted: 0, dropped: 0 } });
});

test('offline grace: a lapsed or missing server contact fails closed until noteServerContact renews it', async t => {
  const w = await world();
  const warn = t.mock.method(console, 'warn', () => undefined);
  const h = await harness(t, w, w.withPhone, START - GRACE - 1);
  // A rejected server read is not contact, and a failed one is logged, not fatal.
  h.serve(async () => w.foreign.ledger);
  await h.security.startLedger();
  assert.equal(h.fetches.count, 1);
  await assert.rejects(h.principal(w.laptop), code('account_offline_expired'));
  h.serve(async () => { throw new Error('offline'); });
  const failed = h.restart();
  await failed.startLedger();
  assert.equal(warn.mock.callCount(), 1);
  await failed.close();
  await assert.rejects(h.principal(w.laptop), code('account_offline_expired'));
  await h.cli();
  h.security.noteServerContact();
  await h.principal(w.laptop);
  assert.equal((await h.store.read())?.lastServerReadAt, START);
  h.elapse(GRACE);
  await h.principal(w.laptop);
  h.elapse(1);
  await assert.rejects(h.principal(w.laptop), code('account_offline_expired'));
  h.security.noteServerContact();
  await h.principal(w.laptop);
  h.security.noteServerContact(Number.NaN);
  await h.principal(w.laptop);
  // Persisted: a restart resumes from the last contact.
  assert.equal((await h.store.read())?.lastServerReadAt, START + GRACE + 1);
  await h.security.close();
  h.security = h.restart();
  await h.security.startLedger();
  await h.principal(w.laptop);
  const never = await harness(t, w, w.withPhone, null);
  await never.security.startLedger();
  await assert.rejects(never.principal(w.laptop), code('account_offline_expired'));
});

test('offline grace survives clock steps: rollback (also across a restart), a forward jump then correction, and a frozen clock', async t => {
  const w = await world();
  const DAY = 86_400_000;
  // Rolled back 30 days before the first check: below the last contact.
  const rolled = await harness(t, w, w.withPhone);
  rolled.setClock(START - 30 * DAY);
  await rolled.security.startLedger();
  await assert.rejects(rolled.principal(w.laptop), code('account_offline_expired'));
  rolled.setClock(START);
  await rolled.principal(w.laptop);

  // Rolled back across a restart: below the persisted observed high-water, though still after the last contact.
  const h = await harness(t, w, w.withPhone);
  await h.security.startLedger();
  h.elapse(20 * 3_600_000);
  await h.principal(w.laptop);
  await h.security.close();
  h.setClock(START + 3_600_000);
  h.security = h.restart();
  await h.security.startLedger();
  await assert.rejects(h.principal(w.laptop), code('account_offline_expired'));
  // A contact re-anchors the grace but never lowers the high-water: still closed until the clock is past it again.
  h.security.noteServerContact();
  await assert.rejects(h.principal(w.laptop), code('account_offline_expired'));
  h.setClock(START + 20 * 3_600_000);
  await h.principal(w.laptop);

  // A contact stamped during a forward jump does not outlive the correction, nor a real day without contact.
  const jump = await harness(t, w, w.withPhone);
  await jump.security.startLedger();
  jump.security.noteServerContact();
  jump.setClock(START + 10 * DAY);
  jump.security.noteServerContact();
  await jump.principal(w.laptop);
  jump.setClock(START + 60_000);
  await assert.rejects(jump.principal(w.laptop), code('account_offline_expired'));
  jump.elapse(GRACE + 1);
  await assert.rejects(jump.principal(w.laptop), code('account_offline_expired'));

  // A wall clock held back while real time passes: the in-process monotonic bound closes it.
  const frozen = await harness(t, w, w.withPhone);
  await frozen.security.startLedger();
  frozen.security.noteServerContact();
  frozen.elapse(GRACE + 1);
  frozen.setClock(START + 3_600_000);
  await assert.rejects(frozen.principal(w.laptop), code('account_offline_expired'));
  frozen.security.noteServerContact();
  await frozen.principal(w.laptop);
});

test('a relay adopt is not server contact: lapsed grace stays closed and lastServerReadAt is unchanged', async t => {
  const w = await world();
  const h = await harness(t, w, w.withPhone, START - GRACE - 1);
  await h.security.startLedger();
  await assert.rejects(h.principal(w.phone), code('account_offline_expired'));
  assert.equal(await h.security.offerLedger(w.longer.ledger, 'relay'), 'adopt');
  await assert.rejects(h.principal(w.tablet), code('account_offline_expired'));
  assert.equal((await h.store.read())?.lastServerReadAt, START - GRACE - 1);
});

test('a service without a ledger never authorizes a projected account device', async t => {
  const w = await world();
  const h = await harness(t, w, w.withPhone);
  await h.security.startLedger();
  await h.principal(w.laptop);
  await h.security.close();
  const plain = new BridgeSecurityService(w.bridge, BRIDGE, h.dir, { relayUserId: w.accountId, now: () => START });
  t.after(() => plain.close());
  await assert.rejects(plain.policy.principal(w.laptop.identity.endpoint.id), code('approval_required'));
  assert.ok(!(await plain.policy.recipients()).some(device => device.endpoint.id === w.phone.identity.endpoint.id));
  await plain.policy.principal(w.cli.endpoint.id);
});

test('refreshLedger: one read in flight plus one trailing; a non-rejected answer (even a repeated one) is contact; failures are logged', async t => {
  const w = await world();
  const warn = t.mock.method(console, 'warn', () => undefined);
  const h = await harness(t, w, w.base, START - GRACE - 1);
  await h.security.startLedger();
  assert.equal(h.fetches.count, 1);
  await assert.rejects(h.principal(w.laptop), code('account_offline_expired'));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  h.serve(async () => { await held; return w.withPhone.ledger; });
  const calls = [h.security.refreshLedger(), h.security.refreshLedger(), h.security.refreshLedger()];
  assert.equal(calls[1], calls[2], 'calls during a read share one trailing read');
  release();
  await Promise.all(calls);
  assert.equal(h.fetches.count, 3);
  assert.equal(h.security.ledgerStatus().head, await chainHead(w.withPhone));
  await h.principal(w.phone);
  assert.equal((await h.store.read())?.lastServerReadAt, START);
  const offers = t.mock.method(h.store, 'offer');
  h.elapse(1000);
  await h.security.refreshLedger();
  assert.equal(offers.mock.callCount(), 0, 'a chain already evaluated is not verified again');
  assert.equal((await h.store.read())?.lastServerReadAt, START + 1000);
  h.serve(async () => { throw new Error('offline'); });
  await h.security.refreshLedger();
  assert.equal(warn.mock.callCount(), 1);
});

test('offers: one in flight plus the latest pending per source; seen verified chains skip verification; rejected ones are never remembered', async t => {
  const w = await world();
  const h = await harness(t, w, w.withPhone);
  await h.security.startLedger();
  const original = h.store.offer.bind(h.store);
  let gate: Promise<void> | null = null;
  let entered: () => void = () => undefined;
  const offers = t.mock.method(h.store, 'offer', async (candidate: unknown, source: LedgerSource) => {
    if (gate) { entered(); await gate; }
    return original(candidate, source);
  });
  const last = w.revokeLaptop.ledger.transitions[w.revokeLaptop.ledger.transitions.length - 1];
  const forged = { genesis: w.revokeLaptop.ledger.genesis, transitions: [...w.withPhone.ledger.transitions,
    { payload: last.payload, signature: w.withPhone.ledger.transitions[0].signature }] };
  assert.equal(await h.security.offerLedger(forged, 'relay'), 'reject');
  assert.equal(await h.security.offerLedger(forged, 'relay'), 'reject');
  assert.equal(offers.mock.callCount(), 2, 'a rejected chain is evaluated every time');
  assert.equal(await h.security.offerLedger(w.withPhone.ledger, 'relay'), 'keep');
  assert.equal(offers.mock.callCount(), 2, 'the stored chain is known');

  let release: () => void = () => undefined;
  gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const inFlight = h.security.offerLedger(w.revokeLaptop.ledger, 'relay');
  await reached;
  gate = null;
  const replaced = h.security.offerLedger(w.longer.ledger, 'relay');
  const latest = h.security.offerLedger(w.dropLaptopFork.ledger, 'relay');
  release();
  assert.equal(await inFlight, 'adopt');
  assert.deepEqual([await replaced, await latest], ['keep', 'keep']);
  const offered = offers.mock.calls.map(call => call.arguments[0]);
  assert.equal(offered.length, 4);
  assert.ok(!offered.includes(w.longer.ledger), 'a replaced pending candidate is never evaluated');
  // Same and behind are answered from record heads; a refused history is judged by the store every time, and while a source has a
  // recorded divergence even its echo of our chain goes to the store (which clears the entry).
  assert.equal(await h.security.offerLedger(w.withPhone.ledger, 'server'), 'keep');
  assert.equal(offers.mock.callCount(), 4);
  assert.equal(await h.security.offerLedger(w.revokeLaptop.ledger, 'relay'), 'keep');
  assert.equal(offers.mock.callCount(), 5);
  assert.equal(await h.security.offerLedger(w.revokeLaptop.ledger, 'relay'), 'keep');
  assert.equal(offers.mock.callCount(), 5);
  assert.equal(await h.security.offerLedger(w.dropLaptopFork.ledger, 'server'), 'keep');
  assert.equal(offers.mock.callCount(), 6);
  assert.deepEqual(h.revoked, [w.laptop.identity.endpoint.id]);
});

test('an invalid candidate is rejected with no state change; without a ledger every entry point is inert', async t => {
  const w = await world();
  const errors = t.mock.method(console, 'error', () => undefined);
  const h = await harness(t, w, w.withPhone);
  await h.security.startLedger();
  const policy = await h.policyText();
  const ledger = await h.ledgerText();
  const status = h.security.ledgerStatus();
  const last = w.revokeLaptop.ledger.transitions[w.revokeLaptop.ledger.transitions.length - 1];
  const forged = { genesis: w.revokeLaptop.ledger.genesis, transitions: [...w.withPhone.ledger.transitions,
    { payload: last.payload, signature: w.withPhone.ledger.transitions[0].signature }] };
  for (const candidate of [null, 'garbage', {}, { genesis: w.withPhone.ledger.genesis }, w.foreign.ledger, forged]) {
    assert.equal(await h.security.offerLedger(candidate, 'relay'), 'reject');
  }
  assert.equal(await h.security.offerLedger(w.revokeLaptop.ledger, 'pairing' as 'relay'), 'reject');
  assert.equal(await h.policyText(), policy);
  assert.equal(await h.ledgerText(), ledger);
  assert.deepEqual(h.security.ledgerStatus(), status);
  assert.deepEqual(h.revoked, []);
  await h.principal(w.laptop);
  // A corrupted replica is a local failure: still 'reject', never thrown, never reset.
  await writeFile(join(h.dir, 'security', 'ledger.json'), '{broken');
  assert.equal(await h.security.offerLedger(w.revokeLaptop.ledger, 'relay'), 'reject');
  assert.equal(await h.ledgerText(), '{broken');
  assert.ok(errors.mock.callCount() >= 1);
  await assert.rejects(h.restart().startLedger(), code('ledger_store_corrupt'));

  const dir = await mkdtemp(join(tmpdir(), 'ftown-solo-security-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const solo = new BridgeSecurityService(w.bridge, BRIDGE, dir, { relayUserId: w.accountId });
  t.after(() => solo.close());
  await solo.startLedger();
  assert.equal(await solo.offerLedger(w.withPhone.ledger, 'relay'), 'reject');
  solo.noteServerContact(START);
  assert.deepEqual(solo.ledgerStatus(), { accountId: null, revision: null, head: null, own: 'unpaired', divergence: null, serverBehind: false, removedOnOtherHistory: false, announcements: { accepted: 0, dropped: 0 } });
  await solo.refreshLedger();
  await solo.policy.provisionLocalEndpoint(w.cli.endpoint);
  const cli = await solo.policy.principal(w.cli.endpoint.id);
  const invitation = await solo.createInvitation(cli, { label: 'Solo browser' });
  await solo.policy.consumeInvitation({ type: 'enroll', candidate: w.laptop.identity.endpoint, invitationId: invitation.invitationId,
    invitationSecret: invitation.secret, label: 'Solo browser' });
  await solo.policy.principal(w.laptop.identity.endpoint.id);
});

test('account mode refuses invitations, enrollment and bridge-side removal of ledger devices with account_managed', async t => {
  const w = await world();
  const h = await harness(t, w, w.withPhone);
  await h.security.startLedger();
  const cli = await h.cli();
  const laptop = await h.principal(w.laptop);
  for (const actor of [LOCAL_RECOVERY_AUTHORITY, cli, laptop]) {
    await assert.rejects(h.security.createInvitation(actor, { label: 'Another browser' }), code('account_managed'));
  }
  await assert.rejects(h.security.policy.consumeInvitation({ type: 'enroll', candidate: w.tablet.identity.endpoint, invitationId: randomUUID(),
    invitationSecret: 'A'.repeat(43), label: 'Tablet' }), code('account_managed'));
  await assert.rejects(h.security.revokeEndpoint(cli, w.laptop.identity.endpoint.id), code('account_managed'));
  await assert.rejects(h.security.revokeEndpoint(laptop, w.laptop.identity.endpoint.id), code('account_managed'));
  assert.deepEqual(h.revoked, []);
  await h.principal(w.laptop);

  const responses: CommandResponse[] = [];
  const handler = createCommandHandler({ bridgeId: BRIDGE, security: h.security, sessionController: {} as SessionController,
    publishCommandResponse: async response => { responses.push(response); } });
  const verified = { principal: laptop } as VerifiedApplication;
  await handler({ type: 'security_invite', requestId: 'invite', payload: { bridgeId: BRIDGE, label: 'x' } }, verified);
  assert.equal(responses.at(-1)?.success, false);
  assert.deepEqual(responses.at(-1)?.data, { code: 'account_managed' });
  await handler({ type: 'security_revoke', requestId: 'revoke', payload: { bridgeId: BRIDGE, endpointId: w.phone.identity.endpoint.id } }, verified);
  assert.deepEqual(responses.at(-1)?.data, { code: 'account_managed' });
  // The v1 command no longer exists, even as a type: a peer can still send its name.
  const removedCommand: string = 'security_account_adopt';
  await handler({ type: removedCommand as Parameters<typeof handler>[0]['type'], requestId: 'adopt', payload: { bridgeId: BRIDGE, head: {} } }, verified);
  assert.equal(responses.at(-1)?.success, false);
  assert.equal(responses.at(-1)?.error, 'Unknown command type: security_account_adopt');
  await handler({ type: 'security_devices', requestId: 'devices', payload: { bridgeId: BRIDGE } }, verified);
  assert.equal(responses.at(-1)?.success, true);
});

test('projection never touches legacy or local-cli devices, and account mode authorizes only ledger browsers', async t => {
  const w = await world();
  const h = await harness(t, w, null);
  // An invitation-enrolled browser from before account mode, in the same policy file.
  await h.security.close();
  const legacy = await browser(w.accountId, 'Legacy');
  const plain = new BridgeSecurityService(w.bridge, BRIDGE, h.dir, { relayUserId: w.accountId, now: () => START });
  const invitation = await plain.createInvitation(await plain.policy.principal(w.cli.endpoint.id), { label: 'Legacy' });
  await plain.policy.consumeInvitation({ type: 'enroll', candidate: legacy.identity.endpoint, invitationId: invitation.invitationId,
    invitationSecret: invitation.secret, label: 'Legacy' });
  await plain.close();
  await seed(h.dir, w.withPhone, START);
  h.security = h.restart();
  await h.security.startLedger();
  assert.deepEqual(await h.ids(), ids(w.cli, legacy, w.laptop, w.phone));
  await assert.rejects(h.principal(legacy), code('approval_required'));
  assert.equal(await h.security.offerLedger(w.revokeLaptop.ledger, 'relay'), 'adopt');
  assert.deepEqual(await h.ids(), ids(w.cli, legacy, w.phone));
  assert.deepEqual(h.revoked, [w.laptop.identity.endpoint.id]);
  const devices = await h.security.listDevices(await h.cli());
  assert.equal(devices.find(device => device.endpoint.id === legacy.identity.endpoint.id)?.source, undefined);
  assert.equal(devices.find(device => device.endpoint.id === w.cli.endpoint.id)?.source, 'local');
  // A non-null v1 account section is never reinterpreted: the policy fails closed.
  await h.security.close();
  const file = join(h.dir, 'security', 'policy.json');
  await writeFile(file, JSON.stringify({ ...JSON.parse(await h.policyText()), account: { checkpoint: {} } }));
  h.security = h.restart();
  await assert.rejects(h.cli(), code('storage_unavailable'));
});

test('an account device application is admitted while it is in the trusted roster and refused once revoked', async t => {
  const w = await world();
  const h = await harness(t, w, w.withPhone);
  await h.security.startLedger();
  const route: InboundTransportContext = { transport: 'cloud', bridgeId: BRIDGE, channel: `commands:rpc#${w.accountId}`, pairId: null };
  const packet = async () => {
    const requestId = randomUUID();
    const application: SecureApplication = { type: 'application', route: { kind: 'http', requestId, method: 'GET', path: '/api/sessions' }, data: {}, mcp: null };
    return seal(w.laptop.identity, w.bridge.endpoint, { type: 'ftown_encrypted', version: 1, senderId: w.laptop.identity.endpoint.id,
      recipientId: w.bridge.endpoint.id, ownerId: w.accountId, bridgeId: BRIDGE, channel: route.channel, purpose: 'application', messageId: requestId,
      createdAt: START, expiresAt: START + 60_000, receiverEpoch: h.security.receiverEpoch }, new TextEncoder().encode(JSON.stringify(application)));
  };
  const accepted = await h.security.acceptApplication(await packet(), route);
  assert.equal(accepted.principal.endpoint.id, w.laptop.identity.endpoint.id);
  assert.equal(await h.security.offerLedger(w.revokeLaptop.ledger, 'relay'), 'adopt');
  await assert.rejects(h.security.acceptApplication(await packet(), route), code('account_device_revoked'));
  await assert.rejects(h.security.revalidate(accepted.principal));
});

test('onApprovalRequired: only for an endpoint unknown to the trusted ledger, spaced per endpoint, never revoked, never Solo', async t => {
  const w = await world();
  const errors = t.mock.method(console, 'error', () => undefined);
  const route: InboundTransportContext = { transport: 'cloud', bridgeId: BRIDGE, channel: `commands:rpc#${w.accountId}`, pairId: null };
  const hello = (from: EndpointIdentity, to: EndpointIdentity, at: number) => seal(from, to.endpoint, { type: 'ftown_encrypted', version: 1,
    senderId: from.endpoint.id, recipientId: to.endpoint.id, ownerId: w.accountId, bridgeId: BRIDGE, channel: route.channel, purpose: 'hello',
    messageId: randomUUID(), createdAt: at, expiresAt: at + 60_000, receiverEpoch: null }, new TextEncoder().encode(JSON.stringify({ type: 'hello', challenge: 'c' })));
  const h = await harness(t, w, w.withPhone);
  await h.security.startLedger();
  const seen: string[] = [];
  h.security.onApprovalRequired(() => { throw new Error('listener boom'); });
  const stop = h.security.onApprovalRequired(id => { seen.push(id); });
  // tablet is not in the trusted ledger (yet): the refusal is unchanged and the hook fires once per 2 s.
  await assert.rejects(h.security.handleHandshake(await hello(w.tablet.identity, w.bridge, START), route), code('approval_required'));
  await assert.rejects(h.security.handleHandshake(await hello(w.tablet.identity, w.bridge, START), route), code('approval_required'));
  assert.deepEqual(seen, [w.tablet.identity.endpoint.id]);
  assert.equal(errors.mock.callCount(), 1);
  h.elapse(2000);
  await assert.rejects(h.security.handleHandshake(await hello(w.tablet.identity, w.bridge, START), route), code('approval_required'));
  assert.deepEqual(seen, [w.tablet.identity.endpoint.id, w.tablet.identity.endpoint.id]);
  // Known members and the local CLI are not refused; a revoked endpoint is refused without the hook.
  await h.security.handleHandshake(await hello(w.laptop.identity, w.bridge, START), route);
  await h.security.handleHandshake(await hello(w.cli, w.bridge, START), route);
  assert.equal(await h.security.offerLedger(w.revokeLaptop.ledger, 'relay'), 'adopt');
  h.elapse(2000);
  await assert.rejects(h.security.handleHandshake(await hello(w.laptop.identity, w.bridge, START), route), code('account_device_revoked'));
  assert.equal(seen.length, 2);
  stop();
  h.elapse(2000);
  await assert.rejects(h.security.handleHandshake(await hello(w.desk.identity, w.bridge, START), route), code('approval_required'));
  assert.equal(seen.length, 2);
  // A member whose projection has not landed (policy write failed) is known to the ledger: refused, but no hook.
  const pending = await harness(t, w, w.withPhone);
  await pending.security.startLedger();
  const pendingSeen: string[] = [];
  pending.security.onApprovalRequired(id => { pendingSeen.push(id); });
  const snapshot: { transact: () => Promise<unknown> } = Reflect.get(pending.security.policy, 'snapshot');
  const broken = t.mock.method(snapshot, 'transact', async () => { throw new Error('disk full'); });
  assert.equal(await pending.security.offerLedger(w.longer.ledger, 'relay'), 'adopt');
  broken.mock.restore();
  await assert.rejects(pending.security.handleHandshake(await hello(w.tablet.identity, w.bridge, START), route), code('approval_required'));
  assert.deepEqual(pendingSeen, []);

  const dir = await mkdtemp(join(tmpdir(), 'ftown-solo-approval-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const solo = new BridgeSecurityService(w.bridge, BRIDGE, dir, { relayUserId: w.accountId });
  t.after(() => solo.close());
  const soloSeen: string[] = [];
  solo.onApprovalRequired(id => { soloSeen.push(id); });
  await assert.rejects(solo.handleHandshake(await hello(w.tablet.identity, w.bridge, Date.now()), route), code('approval_required'));
  assert.deepEqual(soloSeen, []);
});

test('a throwing or rejecting bridgeRevoked listener is logged and does not stop the others', async t => {
  const w = await world();
  const errors = t.mock.method(console, 'error', () => undefined);
  const h = await harness(t, w, w.longer);
  const order: string[] = [];
  h.security.onBridgeRevoked(() => { order.push('throws'); throw new Error('boom'); });
  h.security.onBridgeRevoked(async () => { order.push('rejects'); throw new Error('async boom'); });
  h.security.onBridgeRevoked(() => { order.push('ok'); });
  await h.security.startLedger();
  assert.equal(await h.security.offerLedger(w.revokeBridgeAhead.ledger, 'relay'), 'adopt');
  await microtasks();
  assert.deepEqual(order, ['throws', 'rejects', 'ok']);
  assert.equal(h.fired.count, 1);
  assert.equal(errors.mock.callCount(), 2);
});

test('ledgerStatus: divergence (the server first, heads cut to 8 characters) and serverBehind, as plain JSON', async t => {
  const w = await world();
  const h = await harness(t, w, w.longer);
  // The server holds withPhone, a strict prefix of ours (a rolled-back server).
  h.serve(async () => w.withPhone.ledger);
  await h.security.startLedger();
  assert.equal(h.security.ledgerStatus().serverBehind, true);
  assert.deepEqual(await h.security.readServerLedger(), { kind: 'read', outcome: { decision: 'keep', relation: 'behind', head: await chainHead(w.withPhone), revision: 3 } });
  // A relay publisher holds another history.
  await h.security.offerLedgerResult(w.dropLaptopFork.ledger, 'relay');
  assert.deepEqual(h.security.ledgerStatus().divergence, {
    source: 'relay', otherHead: (await chainHead(w.dropLaptopFork)).slice(0, 8), otherRevision: 3, ourRevision: 4, firstSeen: START,
    forkRevision: 2, removedOnOtherHistory: false,
  });
  // The server now holds another history too: it is the one shown, and it is not "behind".
  h.serve(async () => w.deskFork.ledger);
  h.elapse(5000);
  await h.security.refreshLedger();
  assert.deepEqual(JSON.parse(JSON.stringify(h.security.ledgerStatus())), {
    accountId: w.accountId, revision: 4, head: await chainHead(w.longer), own: 'active',
    divergence: { source: 'server', otherHead: (await chainHead(w.deskFork)).slice(0, 8), otherRevision: 4, ourRevision: 4, firstSeen: START + 5000,
      forkRevision: 2, removedOnOtherHistory: false },
    serverBehind: false, removedOnOtherHistory: false,
    announcements: { accepted: 0, dropped: 0 },
  });
  // The server agrees again: its entry is cleared, the relay's remains.
  h.serve(async () => w.longer.ledger);
  await h.security.refreshLedger();
  assert.equal(h.security.ledgerStatus().divergence?.source, 'relay');
  // A token answer without a chain: the head it carries (or the one we sent) against our record heads.
  assert.equal(h.security.noteServerHead({ head: await chainHead(w.withPhone), revision: null }), 'behind');
  assert.equal(h.security.ledgerStatus().serverBehind, true);
  assert.equal(h.security.noteServerHead({ head: await chainHead(w.longer), revision: 4 }), 'same');
  assert.equal(h.security.ledgerStatus().serverBehind, false);
  assert.equal(h.security.noteServerHead({ head: await chainHead(w.deskFork), revision: 4 }), 'unknown');
  assert.equal(h.security.noteServerHead({ head: null, revision: null }), null);
  assert.equal(h.security.ledgerStatus().serverBehind, false);
  // A 404 read is "unknown account", never a chain.
  h.serve(async () => { throw Object.assign(new Error('Ledger read failed (404)'), { status: 404 }); });
  assert.deepEqual(await h.security.readServerLedger(), { kind: 'unknown_account', reason: 'Ledger read failed (404)' });

  // The local API status the dashboard reads: GET /api/security/info -> .ledger.{divergence, serverBehind}.
  const api = new LocalApiServer();
  api.setSecurity(h.security, { protocolVersion: 1, ownerId: w.accountId, bridgeId: BRIDGE, endpoint: w.bridge.endpoint, relayUserId: w.accountId }, async () => null);
  const port = await api.start();
  t.after(() => api.stop());
  const info = await (await fetch(`http://127.0.0.1:${port}/api/security/info`)).json() as Record<string, unknown>;
  assert.deepEqual(info.ledger, { divergence: h.security.ledgerStatus().divergence, serverBehind: false, removedOnOtherHistory: false });
  assert.equal(info.bridgeId, BRIDGE);
});

test('the 401 key_revoked evidence goes through the same append-only decision: a diverged revoking chain resets nothing, an ahead one does', async t => {
  const w = await world();
  const authPrivateKey = (await generateAuthKey(false)).privateKey;
  for (const [evidence, fired] of [[w.revokeBridgeFork, 0], [w.revokeBridgeAhead, 1]] as const) {
    const h = await harness(t, w, w.longer);
    await h.security.startLedger();
    const posts: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/auth/nonce') return new Response(JSON.stringify({ nonce: 'n'.repeat(43), expiresAt: 1 }), { status: 200 });
      if (path === '/api/auth/relay-token') return new Response(JSON.stringify({ error: 'key_revoked', ledger: evidence.ledger }), { status: 401 });
      posts.push(`${init?.method} ${path}`);
      return new Response(null, { status: 500 });
    };
    const relay = createAccountRelay({
      apiUrl: 'https://ftown.example', accountId: w.accountId, bridgeId: BRIDGE, authPrivateKey, security: h.security, store: h.store,
      server: createLedgerServer({ apiUrl: 'https://ftown.example', fetchImpl }), hostname: () => 'studio', localPort: () => undefined, fetchImpl,
      schedule: () => () => undefined, log: () => undefined,
    });
    t.after(() => relay.stop());
    await assert.rejects(relay.tokens.getToken());
    await microtasks();
    assert.equal(h.fired.count, fired, 'onBridgeRevoked starts the identity reset (index.ts revokedRestart)');
    assert.equal(h.security.ledgerStatus().own, fired ? 'revoked' : 'active');
    assert.equal(await h.store.ownBridgeStatus(ownKeys(w)), fired ? 'revoked' : 'active');
    if (!fired) assert.equal(h.security.ledgerStatus().divergence?.source, 'server');
    assert.deepEqual(posts, [], 'evidence is never answered with a POST');
  }
});

test('ledger RPCs: a member browser reads the head and the whole chain in pages; anyone else gets the usual refusal', async t => {
  const w = await world();
  assert.deepEqual(classifyCommand('ledger_head', { bridgeId: BRIDGE }), { permission: 'read', mutating: false, operation: 'ledger_head', sessionId: null });
  assert.deepEqual(classifyCommand('ledger_chain', { bridgeId: BRIDGE }), { permission: 'read', mutating: false, operation: 'ledger_chain', sessionId: null });
  // A chain larger than one page: 100 more devices with long labels (about 1 KB per record).
  const extra = await Promise.all(Array.from({ length: 100 }, (_, index) => browser(w.accountId, `Device ${index} ${'x'.repeat(180)}`)));
  const big = await grow(w.withPhone, w.passkey, extra.map(item => ({ type: 'add_device', device: item.device })));
  const h = await harness(t, w, big);
  await h.security.startLedger();
  const before = await h.ledgerText();
  const responses: CommandResponse[] = [];
  const handler = createCommandHandler({ bridgeId: BRIDGE, security: h.security, sessionController: {} as SessionController,
    publishCommandResponse: async response => { responses.push(response); } });
  const ask = async (who: VerifiedPrincipal, type: 'ledger_head' | 'ledger_chain', payload: Record<string, unknown>): Promise<CommandResponse> => {
    const requestId = randomUUID();
    await handler({ type, requestId, payload }, { principal: who } as VerifiedApplication);
    const response = responses.at(-1)!;
    assert.equal(response.requestId, requestId);
    return response;
  };
  const laptop = await h.principal(w.laptop);
  const head = await chainHead(big);
  assert.deepEqual(await ask(laptop, 'ledger_head', { bridgeId: BRIDGE }), { requestId: responses.at(-1)!.requestId, success: true, data: { accountId: w.accountId, head, revision: 103 } });

  const records: unknown[] = [];
  let pages = 0;
  for (let more = true; more;) {
    const page = await ask(laptop, 'ledger_chain', { bridgeId: BRIDGE, fromRevision: records.length });
    assert.equal(page.success, true);
    const data = page.data as { accountId: string; head: string; revision: number; fromRevision: number; records: unknown[]; more: boolean };
    assert.deepEqual([data.accountId, data.head, data.revision, data.fromRevision], [w.accountId, head, 103, records.length]);
    assert.ok(data.records.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(data.records)) <= LEDGER_CHAIN_PAGE_BYTES + 2, 'a page fits the frame budget');
    records.push(...data.records);
    more = data.more;
    pages++;
  }
  assert.ok(pages >= 2, `the chain needs more than one page (${pages})`);
  assert.deepEqual({ genesis: records[0], transitions: records.slice(1) }, big.ledger, 'the pages rebuild the stored chain exactly, genesis first');
  const tail = await ask(laptop, 'ledger_chain', { bridgeId: BRIDGE, fromRevision: 102, limit: 5 });
  assert.deepEqual((tail.data as { records: unknown[]; more: boolean }).records, big.ledger.transitions.slice(101));
  assert.equal((tail.data as { more: boolean }).more, false);
  const one = await ask(laptop, 'ledger_chain', { bridgeId: BRIDGE, limit: 1 });
  assert.deepEqual((one.data as { records: unknown[]; more: boolean }).records, [big.ledger.genesis]);
  assert.equal((one.data as { more: boolean }).more, true);
  const past = await ask(laptop, 'ledger_chain', { bridgeId: BRIDGE, fromRevision: 500 });
  assert.deepEqual([(past.data as { records: unknown[] }).records, (past.data as { more: boolean }).more], [[], false]);

  const invalid = { success: false, error: 'Invalid ledger request', data: { code: 'invalid' } };
  for (const [type, payload] of [
    ['ledger_head', { bridgeId: BRIDGE, extra: 1 }], ['ledger_chain', { bridgeId: BRIDGE, extra: 1 }], ['ledger_chain', { bridgeId: BRIDGE, fromRevision: -1 }],
    ['ledger_chain', { bridgeId: BRIDGE, fromRevision: 1.5 }], ['ledger_chain', { bridgeId: BRIDGE, fromRevision: '0' }], ['ledger_chain', { bridgeId: BRIDGE, fromRevision: 1025 }],
    ['ledger_chain', { bridgeId: BRIDGE, limit: 0 }], ['ledger_chain', { bridgeId: BRIDGE, limit: 1026 }], ['ledger_chain', { bridgeId: BRIDGE, limit: null }],
  ] as const) {
    const { requestId: _requestId, ...refusal } = await ask(laptop, type, payload);
    assert.deepEqual(refusal, invalid, JSON.stringify(payload));
  }
  // Not a member: the local CLI (trusted by the policy, but not a browser of the chain).
  for (const type of ['ledger_head', 'ledger_chain'] as const) {
    const refused = await ask(await h.cli(), type, { bridgeId: BRIDGE });
    assert.deepEqual([refused.success, refused.data], [false, { code: 'permission_denied' }], type);
  }
  // A removed member is refused like on every other command.
  const removed = await grow(big, w.passkey, [{ type: 'revoke_device', endpointId: w.laptop.identity.endpoint.id }]);
  assert.equal(await h.security.offerLedger(removed.ledger, 'relay'), 'adopt');
  for (const type of ['ledger_head', 'ledger_chain'] as const) {
    const refused = await ask(laptop, type, { bridgeId: BRIDGE });
    assert.deepEqual([refused.success, refused.data], [false, { code: 'account_device_revoked' }], type);
  }
  const phone = await h.principal(w.phone);
  assert.equal((await ask(phone, 'ledger_head', { bridgeId: BRIDGE })).success, true);
  // Read-only: only the adopted chain changed the file.
  assert.notEqual(await h.ledgerText(), before);
  const afterAdopt = await h.ledgerText();
  await ask(phone, 'ledger_chain', { bridgeId: BRIDGE });
  assert.equal(await h.ledgerText(), afterAdopt);

  // Solo / --local: no ledger, no answer.
  const dir = await mkdtemp(join(tmpdir(), 'ftown-solo-rpc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const solo = new BridgeSecurityService(w.bridge, BRIDGE, dir, { relayUserId: w.accountId });
  t.after(() => solo.close());
  await assert.rejects(solo.memberLedger(phone), code('permission_denied'));
});

test('own removal needs membership: a tombstone of our id, or a removal of our id listed with other keys, never resets this bridge', async t => {
  const w = await world();
  // Not listed (absent), then an AHEAD chain that tombstones our id: still absent, no emission, and the startup check agrees.
  const absent = await harness(t, w, w.notListed);
  await absent.security.startLedger();
  assert.equal(absent.security.ledgerStatus().own, 'absent');
  const tombstone = await append(w.notListed, w.passkey, { type: 'revoke_bridge', bridgeId: BRIDGE });
  assert.equal(await absent.security.offerLedger(tombstone.ledger, 'server'), 'adopt');
  await microtasks();
  assert.equal(absent.fired.count, 0);
  assert.equal(absent.security.ledgerStatus().own, 'absent');
  assert.equal(await absent.store.ownBridgeStatus(ownKeys(w)), 'absent');
  // A stored chain holding that tombstone at startup: no emission either.
  const stored = await harness(t, w, tombstone);
  await stored.security.startLedger();
  await microtasks();
  assert.equal(stored.fired.count, 0);
  assert.equal(stored.security.ledgerStatus().own, 'absent');
  // Our id listed with ANOTHER auth key (wrongAuth), then removed: that member was not us.
  const other = await harness(t, w, w.wrongAuth);
  await other.security.startLedger();
  const removed = await append(w.wrongAuth, w.passkey, { type: 'revoke_bridge', bridgeId: BRIDGE });
  assert.equal(await other.security.offerLedger(removed.ledger, 'relay'), 'adopt');
  await microtasks();
  assert.equal(other.fired.count, 0);
  assert.equal(await other.store.ownBridgeStatus(ownKeys(w)), 'absent');
  // The same removal of OUR membership is evidence, from a running bridge and from the stored chain at startup.
  const ours = await harness(t, w, w.base);
  await ours.security.startLedger();
  assert.equal(await ours.security.offerLedger(w.revokeBridgeFork.ledger, 'relay'), 'adopt');
  assert.equal(ours.fired.count, 1);
  assert.equal(await ours.store.ownBridgeStatus(ownKeys(w)), 'revoked');
});

test('own removal: an owner-chosen history that only tombstones our id (it never added us) leaves us absent: no reset, like the startup check', async t => {
  const w = await world();
  const h = await harness(t, w, w.base);
  await h.security.startLedger();
  assert.equal(h.security.ledgerStatus().own, 'active');
  // The other branch (genesis + laptop + tablet + revoke_bridge studio) never added this bridge; the owner chose it over ours.
  let chosen = await append(await append(w.notListed, w.passkey, { type: 'add_device', device: w.tablet.device }), w.passkey, { type: 'revoke_bridge', bridgeId: BRIDGE });
  for (const operation of (await resolutionPlan(chosen.ledger, w.base.ledger)).carry) chosen = await append(chosen, w.passkey, operation);
  const last = ledgerLastIssuedAt(chosen.ledger);
  const payload = await resolveForkTransition(chosen.ledger, w.base.ledger, w.passkey.credentialId, last + 1000);
  chosen = { ledger: { genesis: chosen.ledger.genesis, transitions: [...chosen.ledger.transitions, await signed(w.passkey, payload)] }, accountId: chosen.accountId };
  const outcome = await h.security.offerLedgerResult(chosen.ledger, 'server');
  assert.deepEqual([outcome.decision, outcome.relation], ['adopt', 'diverged']);
  await microtasks();
  // The raw chain never added this bridge, so its revoke_bridge is a tombstone: absent (refused, fails closed), never a reset, on the
  // running bridge exactly as at startup (no "it was active before" shortcut: that one could fire on a sticky-only id).
  assert.equal(h.fired.count, 0);
  assert.equal(h.security.ledgerStatus().own, 'absent');
  assert.equal(await h.store.ownBridgeStatus(ownKeys(w)), 'absent');
  assert.ok(h.lines.some(line => line.startsWith('[ledger] adopted an owner-chosen history: fork at revision 1, discarded 1 of our records')));
});

test('a sticky-only entry for our own id (e.g. left by 0.21) never resets the identity: absent, fail closed, on start and while running', async t => {
  const w = await world();
  const h = await harness(t, w, null);
  await seed(h.dir, w.longer, START, { deviceIds: [], bridgeIds: [BRIDGE] });
  await h.security.startLedger();
  await microtasks();
  assert.equal(h.fired.count, 0);
  assert.equal(h.security.ledgerStatus().own, 'absent');
  assert.equal(await h.store.ownBridgeStatus(ownKeys(w)), 'absent');
  // An extension that does not revoke us changes nothing about that.
  const more = await append(w.longer, w.passkey, { type: 'add_device', device: w.desk.device });
  assert.equal(await h.security.offerLedger(more.ledger, 'relay'), 'adopt');
  await microtasks();
  assert.equal(h.fired.count, 0);
  assert.equal(h.security.ledgerStatus().own, 'absent');
});

/** The owner keeps `chosen` over `other`: carried records, then resolve_fork, each signed (production builders). */
async function keepHistory(chosen: Chain, other: Chain, passkey: SoftPasskey): Promise<Chain> {
  let chain = chosen;
  for (const operation of (await resolutionPlan(chosen.ledger, other.ledger)).carry) chain = await append(chain, passkey, operation);
  const last = ledgerLastIssuedAt(chain.ledger);
  const payload = await resolveForkTransition(chain.ledger, other.ledger, passkey.credentialId, last + 1000);
  return { ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, await signed(passkey, payload)] }, accountId: chain.accountId };
}

test('E2E scenario E at the service: keeping OUR side, adopted through the relay, clears the server divergence; a replay of the discarded chain is behind our decision', async t => {
  const w = await world();
  // M1 holds dropLaptopFork (base + a removal); the rolled-back server holds withPhone (base + phone).
  const h = await harness(t, w, w.dropLaptopFork);
  h.serve(async () => w.withPhone.ledger);
  await h.security.startLedger();
  const refusedLines = () => h.lines.filter(line => line.includes('REFUSED')).length;
  assert.equal(h.security.ledgerStatus().divergence?.source, 'server');
  assert.equal(refusedLines(), 1);
  // The owner keeps M1's side; the server stores it and publishes it on the relay, where M1 adopts it at once.
  const chosen = await keepHistory(w.dropLaptopFork, w.withPhone, w.passkey);
  const adopted = await h.security.offerLedgerResult(chosen.ledger, 'relay');
  assert.deepEqual([adopted.decision, adopted.relation], ['adopt', 'ahead']);
  const status = h.security.ledgerStatus();
  assert.equal(status.divergence, null, 'the server entry named exactly the tip our resolve_fork discards');
  assert.equal(status.removedOnOtherHistory, false);
  assert.equal(status.head, await chainHead(chosen));
  // A server that replays the discarded chain is behind our decision: no REFUSED line, no divergence, and our chain is re-offered.
  const outcome = await h.security.readServerLedger();
  assert.deepEqual(outcome.kind === 'read' ? [outcome.outcome.decision, outcome.outcome.relation, outcome.outcome.head] : outcome,
    ['keep', 'behind', await chainHead(w.withPhone)]);
  assert.equal(h.security.ledgerStatus().divergence, null);
  assert.equal(h.security.ledgerStatus().serverBehind, true);
  assert.equal(refusedLines(), 1);
  assert.equal(h.fired.count, 0);
  const posts: Array<{ ledger: unknown; expectHead: string }> = [];
  const reoffer = createLedgerReoffer({
    read: () => h.security.readServerLedger(),
    local: async () => { const state = await h.store.read(); return state === null ? null : { ledger: state.ledger, head: state.checkpoint.head }; },
    post: async (ledger, expectHead) => { posts.push({ ledger, expectHead }); return { status: 200, body: null, retryAfterMs: null }; },
    offer: ledger => h.security.offerLedgerResult(ledger, 'server'),
    now: () => 0, random: () => 0.5, schedule: () => () => undefined, log: () => undefined,
  });
  assert.equal(await reoffer.check(), 'posted');
  assert.deepEqual(posts, [{ ledger: chosen.ledger, expectHead: await chainHead(w.withPhone) }]);
});
