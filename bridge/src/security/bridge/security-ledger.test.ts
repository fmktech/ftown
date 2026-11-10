import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createCommandHandler } from '../../command-rpc.js';
import type { SessionController } from '../../session-controller.js';
import type { CommandResponse } from '../../types.js';
import { generateEndpoint, seal } from '../crypto.js';
import { ledgerChallenge, ledgerLastIssuedAt, ledgerRevocations, nextTransition, verifyLedger, accountIdOf } from '../ledger/ledger.js';
import { generateAuthKey } from '../ledger/proof.js';
import { LEDGER_LIMITS } from '../ledger/protocol.js';
import type { Ledger, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from '../ledger/protocol.js';
import { createSoftPasskey } from '../ledger/testing.js';
import type { SoftPasskey } from '../ledger/testing.js';
import type { EndpointIdentity, InboundTransportContext, SecureApplication, VerifiedApplication, VerifiedPrincipal } from '../protocol.js';
import { BridgeLedgerStore } from './ledger-store.js';
import type { LedgerSource } from './ledger-store.js';
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
async function browser(accountId: string, label: string): Promise<Browser> {
  const identity = await generateEndpoint(accountId, 'browser');
  return { identity, device: { endpoint: identity.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label, approvedAt: T0 } };
}

/**
 * base: genesis + add_device laptop + add_bridge studio. withPhone: base + phone. revokeLaptop: withPhone + revoke_device laptop.
 * longer: withPhone + tablet (4 records). Losing forks of `longer` (3 records each): revokeBridgeFork (base + revoke_bridge studio)
 * and dropLaptopFork (base + revoke_device laptop). deskFork: base + tablet + desk (4 records), which beats withPhone and drops phone
 * WITHOUT revoking it. notListed: genesis + laptop. wrongKey: notListed + studio under another endpoint and auth key. wrongAuth:
 * notListed + studio with this endpoint but another auth key. foreign: another account that lists this bridge's exact keys.
 */
interface World {
  accountId: string; bridge: EndpointIdentity; bridgeAuth: string; cli: EndpointIdentity; laptop: Browser; phone: Browser; tablet: Browser; desk: Browser;
  base: Chain; withPhone: Chain; revokeLaptop: Chain; revokePhone: Chain; revokeBoth: Chain; longer: Chain; revokeBridgeFork: Chain;
  dropLaptopFork: Chain; deskFork: Chain;
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
    const impostor = await generateEndpoint(accountId, 'bridge');
    const wrongKey = await append(notListed, passkey, { type: 'add_bridge',
      bridge: { ...studio, endpoint: impostor.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey } });
    const wrongAuth = await append(notListed, passkey, { type: 'add_bridge', bridge: { ...studio, authPublicKey: (await generateAuthKey(false)).publicKey } });
    const otherPasskey = await createSoftPasskey({ rpId, origin });
    const otherRoot = await genesis(otherPasskey);
    const foreign = await append(otherRoot, otherPasskey, { type: 'add_bridge', bridge: { ...studio, endpoint: { ...bridge.endpoint, ownerId: otherRoot.accountId } } });
    return { accountId, bridge, bridgeAuth, cli, laptop, phone, tablet, desk, base, withPhone, revokeLaptop, revokePhone, revokeBoth, longer, revokeBridgeFork, dropLaptopFork,
      deskFork, notListed, wrongKey, wrongAuth, foreign };
  })();
  return built;
}

interface Harness {
  dir: string; store: BridgeLedgerStore; security: BridgeSecurityService; fetches: { count: number }; revoked: string[]; fired: { count: number };
  serve: (next: () => Promise<unknown>) => void; restart: () => BridgeSecurityService;
  /** Sets the wall clock only (a clock step); `elapse` moves wall and monotonic time together (real time passing). */
  setClock: (value: number) => void; elapse: (ms: number) => void;
  cli: () => Promise<VerifiedPrincipal>; principal: (who: Browser) => Promise<VerifiedPrincipal>; ids: () => Promise<string[]>;
  policyText: () => Promise<string>; ledgerText: () => Promise<string>;
}
async function seed(dir: string, chain: Chain, lastServerReadAt: number | null): Promise<void> {
  await mkdir(join(dir, 'security'), { recursive: true });
  await writeFile(join(dir, 'security', 'ledger.json'), JSON.stringify({ version: 1, ledger: chain.ledger,
    checkpoint: await verifyLedger(chain.ledger, START), sticky: ledgerRevocations(chain.ledger), lastServerReadAt }));
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
  const store = new BridgeLedgerStore(dir, { accountId: w.accountId, now: () => clock });
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
    dir, store, security, fetches, revoked, fired,
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

test('projection makes the account devices exactly the trusted roster and emits onRevoked for each removal', async t => {
  const w = await world();
  const h = await harness(t, w, w.base, START - 1000);
  h.serve(async () => w.withPhone.ledger);
  await h.security.startLedger();
  assert.equal(h.fetches.count, 1);
  assert.deepEqual(h.security.ledgerStatus(), { accountId: w.accountId, revision: 3, head: await chainHead(w.withPhone), own: 'active' });
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

test('a revoke_device on a losing fork still removes the device: projection uses trusted, not the raw checkpoint', async t => {
  const w = await world();
  const h = await harness(t, w, w.longer);
  await h.security.startLedger();
  await h.principal(w.laptop);
  assert.equal(await h.security.offerLedger(w.dropLaptopFork.ledger, 'relay'), 'keep');
  assert.ok((await h.store.read())!.checkpoint.devices.some(device => device.endpoint.id === w.laptop.identity.endpoint.id), 'the raw winner still lists it');
  assert.deepEqual(h.revoked, [w.laptop.identity.endpoint.id]);
  await assert.rejects(h.principal(w.laptop), code('account_device_revoked'));
  assert.deepEqual(await h.ids(), ids(w.cli, w.phone, w.tablet));
  await h.principal(w.phone); await h.principal(w.tablet);
  // The sticky revocation survives a restart.
  await h.security.close();
  h.security = h.restart();
  await h.security.startLedger();
  await assert.rejects(h.principal(w.laptop), code('account_device_revoked'));
  assert.deepEqual(await h.ids(), ids(w.cli, w.phone, w.tablet));
});

test('a device dropped by a winning fork is refused even when the policy write fails, and own revocation still emits', async t => {
  const w = await world();
  const h = await harness(t, w, w.withPhone);
  await h.security.startLedger();
  await h.principal(w.phone);
  const errors = t.mock.method(console, 'error', () => undefined);
  const snapshot: { transact: () => Promise<unknown> } = Reflect.get(h.security.policy, 'snapshot');
  const broken = t.mock.method(snapshot, 'transact', async () => { throw new Error('disk full'); });
  // deskFork outranks withPhone: phone is discarded, not revoked, so only the trusted roster can refuse it.
  assert.equal(await h.security.offerLedger(w.deskFork.ledger, 'relay'), 'adopt');
  assert.ok(!(await h.store.read())!.trusted.revokedDeviceIds.includes(w.phone.identity.endpoint.id));
  await assert.rejects(h.principal(w.phone), code('account_device_revoked'));
  assert.deepEqual(h.revoked, []);
  broken.mock.restore();
  assert.equal(await h.security.offerLedger(w.deskFork.ledger, 'relay'), 'keep');
  assert.deepEqual(h.revoked, [w.phone.identity.endpoint.id]);
  assert.deepEqual(await h.ids(), ids(w.cli, w.laptop, w.tablet, w.desk));
  await h.principal(w.desk);
  t.mock.method(snapshot, 'transact', async () => { throw new Error('disk full'); });
  assert.equal(await h.security.offerLedger(w.revokeBridgeFork.ledger, 'relay'), 'keep');
  assert.equal(h.fired.count, 1);
  await assert.rejects(h.principal(w.desk), code('account_bridge_revoked'));
  assert.equal(errors.mock.callCount(), 2);
});

test('own revocation emits once, also from a losing fork, and closes every account device; the local CLI is untouched', async t => {
  const w = await world();
  const h = await harness(t, w, w.longer);
  await h.security.startLedger();
  await h.principal(w.phone);
  assert.equal(await h.security.offerLedger(w.revokeBridgeFork.ledger, 'relay'), 'keep');
  assert.equal(h.fired.count, 1);
  assert.equal(h.security.ledgerStatus().own, 'revoked');
  await assert.rejects(h.principal(w.phone), code('account_bridge_revoked'));
  await h.cli();
  assert.equal(await h.security.offerLedger(w.revokeBridgeFork.ledger, 'server'), 'keep');
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
  assert.deepEqual(h.security.ledgerStatus(), { accountId: null, revision: null, head: null, own: 'unpaired' });
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
  assert.equal(await h.security.offerLedger(w.revokeLaptop.ledger, 'relay'), 'keep');
  assert.equal(await h.security.offerLedger(w.dropLaptopFork.ledger, 'server'), 'keep');
  assert.equal(offers.mock.callCount(), 4);
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
  assert.deepEqual(solo.ledgerStatus(), { accountId: null, revision: null, head: null, own: 'unpaired' });
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
  assert.equal(await h.security.offerLedger(w.revokeBridgeFork.ledger, 'relay'), 'keep');
  await microtasks();
  assert.deepEqual(order, ['throws', 'rejects', 'ok']);
  assert.equal(h.fired.count, 1);
  assert.equal(errors.mock.callCount(), 2);
});
