import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEndpoint } from '../crypto.js';
import { createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from '../account-crypto.js';
import type { AccountCheckpoint, AccountHistory, AccountOperation } from '../account-protocol.js';
import type { EndpointPublic } from '../protocol.js';
import { BridgeSecurityService } from './security.js';
import { LOCAL_RECOVERY_AUTHORITY, readPinnedAccountCheckpoint } from './policy.js';
import { BridgeSecurityError } from './errors.js';
import { AccountBridgeRevoked } from './revocation.js';

const ownerId = '0f6b3c2a-9d4e-4f1a-8b7c-2e5d6a7f8b9c';
const minute = 60_000, h1 = 60 * minute;

interface Chain { history: AccountHistory; checkpoint: AccountCheckpoint }

// genesis(0), add 'bridge'(1), add 'other'(2) = base; revokeOwn, revokeOther and addThird each extend base to revision 3.
async function signedAccount(bridgeEndpoint: EndpointPublic) {
  const wall = Date.now();
  const first = await generateEndpoint(ownerId, 'browser');
  const signing = await generateAccountSigningIdentity();
  const genesis: AccountHistory = { genesis: await createAccountGenesis(ownerId, first.endpoint, signing, 'First', wall), transitions: [] };
  const extend = async (from: Chain, operation: AccountOperation): Promise<Chain> => {
    const at = wall + from.history.transitions.length + 1;
    const record = await signAccountTransition(from.checkpoint, first.endpoint.id, signing, operation, at);
    const history = { ...from.history, transitions: [...from.history.transitions, record] };
    return { history, checkpoint: await verifyAccountHistory(history, from.checkpoint, at) };
  };
  const addBridge = (bridgeId: string, endpoint: EndpointPublic): AccountOperation =>
    ({ type: 'add_bridge', bridge: { bridgeId, endpoint, label: bridgeId, approvedAt: new Date(wall).toISOString() } });
  const revokeOwnOp: AccountOperation = { type: 'revoke_bridge', bridgeId: 'bridge' };
  const rev1 = await extend({ history: genesis, checkpoint: await verifyAccountHistory(genesis, null, wall) }, addBridge('bridge', bridgeEndpoint));
  const base = await extend(rev1, addBridge('other', (await generateEndpoint(ownerId, 'bridge')).endpoint));
  // A non-roster key impersonating the roster device: well-formed, correctly chained, but signed by the wrong key.
  const intruder = await generateAccountSigningIdentity();
  const impostor: AccountCheckpoint = { ...base.checkpoint, devices: base.checkpoint.devices.map(device =>
    device.endpoint.id === first.endpoint.id ? { ...device, signingPublicKey: intruder.publicKey } : device) };
  const nonRoster: AccountHistory = { ...base.history,
    transitions: [...base.history.transitions, await signAccountTransition(impostor, first.endpoint.id, intruder, revokeOwnOp, wall + 3)] };
  return { first, base, revokeOwn: await extend(base, revokeOwnOp),
    revokeOther: await extend(base, { type: 'revoke_bridge', bridgeId: 'other' }),
    addThird: await extend(base, addBridge('third', (await generateEndpoint(ownerId, 'bridge')).endpoint)),
    nonRoster, forkBelow: (await extend(rev1, revokeOwnOp)).history };
}
const headOf = (chain: Chain) => ({ rootId: chain.checkpoint.rootId, revision: chain.checkpoint.revision, head: chain.checkpoint.head });
function tamper(history: AccountHistory): AccountHistory {
  const copy = JSON.parse(JSON.stringify(history)) as AccountHistory;
  const last = copy.transitions[copy.transitions.length - 1];
  last.signature = (last.signature[0] === 'A' ? 'B' : 'A') + last.signature.slice(1);
  return copy;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ftown-bridge-revoked-'));
  const bridge = await generateEndpoint(ownerId, 'bridge');
  const account = await signedAccount(bridge.endpoint);
  // Same owner and same bridge endpoint, but an independent genesis: a forged account that "revokes" this bridge.
  const forged = await signedAccount(bridge.endpoint);
  const state = { reads: 0, respond: async (): Promise<AccountHistory> => account.base.history };
  const readAccountHistory = async (): Promise<AccountHistory> => { state.reads++; return state.respond(); };
  const services: BridgeSecurityService[] = [];
  const make = () => {
    const service = new BridgeSecurityService(bridge, 'bridge', directory, { relayUserId: 'owner@example.test', now: () => Date.now(),
      random: () => 0.5, readAccountHistory });
    services.push(service);
    return service;
  };
  const security = make();
  t.after(async () => { mock.timers.reset(); for (const service of services) await service.close(); await rm(directory, { recursive: true, force: true }); });
  const invite = await security.policy.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: 'Legacy' });
  await security.policy.consumeInvitation({ type: 'enroll', candidate: account.first.endpoint, invitationId: invite.invitationId,
    invitationSecret: invite.secret, label: 'Legacy' });
  const actor = await security.policy.principal(account.first.endpoint.id);
  return { directory, securityDir: join(directory, 'security'), account, forged, state, security, make, actor };
}
function listen(security: BridgeSecurityService) {
  const fired = { count: 0 };
  security.onBridgeRevoked(() => { fired.count++; });
  return fired;
}
// Deterministic quiescence: only microtasks and the (awaited) in-flight refresh are involved; timers are faked.
async function settle(security: BridgeSecurityService) {
  for (;;) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const inflight = Reflect.get(security, 'accountRefresh') as Promise<void> | null;
    if (!inflight) return;
    await inflight.catch(() => undefined);
  }
}
async function started(t: TestContext) {
  const f = await fixture(t);
  await f.security.adoptAccount(f.actor, headOf(f.account.base));
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() });
  const fired = listen(f.security);
  f.security.setAccountPushHealthy(true);
  await f.security.startAccount();
  f.state.reads = 0;
  const block = t.mock.method(f.security.policy, 'blockAccount');
  const advance = async (ms: number, security = f.security) => { mock.timers.tick(ms); await settle(security); };
  return { ...f, fired, block, advance };
}
const pinnedRevokesOwn = (securityDir: string) => readPinnedAccountCheckpoint(securityDir)?.revokedBridgeIds.includes('bridge') ?? false;

test('a safety read whose history revokes this bridge emits once, adopts it and stops every later read', async t => {
  const f = await started(t);
  f.state.respond = async () => f.account.revokeOwn.history;
  await f.advance(h1);
  assert.equal(f.state.reads, 1);
  assert.equal(f.fired.count, 1);
  assert.equal(pinnedRevokesOwn(f.securityDir), true);
  assert.equal(Reflect.get(f.security, 'accountTimer'), null);
  await f.advance(6 * h1);
  f.security.requestAccountRefresh(); await settle(f.security);
  assert.equal(f.state.reads, 1);
  assert.equal(f.fired.count, 1);
});

test('a nudge read with a revoking history still emits when adoption throws, and blocking is unchanged', async t => {
  const f = await started(t);
  t.mock.method(f.security.policy, 'applyAccountRead', async () => { throw new BridgeSecurityError('storage_unavailable'); });
  f.state.respond = async () => f.account.revokeOwn.history;
  f.security.requestAccountRefresh(); await settle(f.security);
  assert.equal(f.state.reads, 1);
  assert.equal(f.fired.count, 1);
  assert.equal(pinnedRevokesOwn(f.securityDir), false, 'the failed adoption left the pin untouched');
  assert.deepEqual(f.block.mock.calls.map(call => call.arguments[0]), ['storage_unavailable']);
  await f.advance(6 * h1);
  assert.equal(f.state.reads, 1);
});

test('a startup read whose history revokes this bridge emits and schedules no safety read', async t => {
  const f = await fixture(t);
  await f.security.adoptAccount(f.actor, headOf(f.account.base));
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() });
  const fired = listen(f.security);
  f.state.reads = 0;
  f.state.respond = async () => f.account.revokeOwn.history;
  await f.security.startAccount();
  assert.equal(f.state.reads, 1);
  assert.equal(fired.count, 1);
  assert.equal(Reflect.get(f.security, 'accountTimer'), null);
  mock.timers.tick(6 * h1); await settle(f.security);
  assert.equal(f.state.reads, 1);
});

test('adoptAccount: a fetched revoking history emits even though adoption refuses it', async t => {
  const f = await started(t);
  const actor = await f.security.policy.principal(f.account.first.endpoint.id);
  f.state.respond = async () => f.account.revokeOwn.history;
  await assert.rejects(f.security.adoptAccount(actor, headOf(f.account.revokeOwn)), { code: 'wrong_context' });
  assert.equal(f.fired.count, 1);
});

test('adoptAccount: AccountBridgeRevoked maps to account_storage_unavailable unless confirmed, and never blocks', async t => {
  const f = await started(t);
  const actor = await f.security.policy.principal(f.account.first.endpoint.id);
  f.state.respond = async () => { throw new AccountBridgeRevoked(f.forged.revokeOwn.history); };
  await assert.rejects(f.security.adoptAccount(actor, headOf(f.account.base)), { code: 'account_storage_unavailable' });
  assert.equal(f.fired.count, 0);
  f.state.respond = async () => { throw new AccountBridgeRevoked(f.account.revokeOwn.history); };
  await assert.rejects(f.security.adoptAccount(actor, headOf(f.account.base)), { code: 'account_bridge_revoked' });
  assert.equal(f.fired.count, 1);
  assert.equal(f.block.mock.callCount(), 0);
});

test('a read rejected with valid AccountBridgeRevoked evidence emits, never blocks, and stops every later read', async t => {
  const f = await started(t);
  f.state.respond = async () => { throw new AccountBridgeRevoked(f.account.revokeOwn.history); };
  await f.advance(h1);
  assert.equal(f.state.reads, 1);
  assert.equal(f.fired.count, 1);
  assert.equal(f.block.mock.callCount(), 0);
  assert.equal(await f.security.policy.accountAvailable(), true, 'unverified-by-adoption evidence does not change local fail-closed state');
  await f.advance(6 * h1);
  f.security.requestAccountRefresh(); await settle(f.security);
  assert.equal(f.state.reads, 1);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
for (const [name, served, code] of [
  ['signed by a non-roster key', (f: Fixture) => f.account.nonRoster, 'invalid_account_trust'],
  ['with a tampered signature', (f: Fixture) => tamper(f.account.revokeOwn.history), 'invalid_account_trust'],
  ['forked from below the pin', (f: Fixture) => f.account.forkBelow, 'account_trust_rollback'],
] as const) {
  test(`a 200 read serving a revoking history ${name}: no emit, blocked exactly as before`, async t => {
    const f = await started(t);
    const history = served(f);
    f.state.respond = async () => history;
    f.security.requestAccountRefresh(); await settle(f.security);
    assert.equal(f.state.reads, 1);
    assert.equal(f.fired.count, 0);
    assert.deepEqual(f.block.mock.calls.map(call => call.arguments[0]), [code]);
    assert.equal(pinnedRevokesOwn(f.securityDir), false);
    await f.advance(60_000); assert.equal(f.state.reads, 2, 'reads continue on the failure backoff');
    assert.equal(f.fired.count, 0);
  });
  test(`adoptAccount serving a revoking history ${name}: no emit, refused exactly as before`, async t => {
    const f = await started(t);
    const actor = await f.security.policy.principal(f.account.first.endpoint.id);
    const history = served(f);
    f.state.respond = async () => history;
    await assert.rejects(f.security.adoptAccount(actor, headOf(f.account.revokeOwn)), { code });
    assert.equal(f.fired.count, 0);
    assert.equal(f.block.mock.callCount(), 0);
    assert.equal(pinnedRevokesOwn(f.securityDir), false);
  });
}

test('a fork from the pin held before the read never confirms once a concurrent adoption advanced the pin', async t => {
  const f = await started(t);
  let entered!: () => void; const readStarted = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  f.state.respond = async () => {
    if (++calls > 1) return f.account.addThird.history;
    entered(); await gate;
    return f.account.revokeOwn.history; // extends the old pin (rev 2) but forks from the advanced one (rev 3)
  };
  f.security.requestAccountRefresh(); await readStarted;
  const actor = await f.security.policy.principal(f.account.first.endpoint.id);
  await f.security.adoptAccount(actor, headOf(f.account.addThird));
  assert.deepEqual(readPinnedAccountCheckpoint(f.securityDir), f.account.addThird.checkpoint);
  release(); await settle(f.security);
  assert.equal(f.state.reads, 2);
  assert.equal(f.fired.count, 0);
  assert.deepEqual(f.block.mock.calls.map(call => call.arguments[0]), ['account_trust_rollback']);
  assert.equal(pinnedRevokesOwn(f.securityDir), false);
});

test('adoptAccount after emission refuses with account_bridge_revoked without reading', async t => {
  const f = await started(t);
  const actor = await f.security.policy.principal(f.account.first.endpoint.id);
  assert.equal(await f.security.confirmRevocationEvidence(f.account.revokeOwn.history), true);
  await assert.rejects(f.security.adoptAccount(actor, headOf(f.account.base)), { code: 'account_bridge_revoked' });
  assert.equal(f.state.reads, 0);
  assert.equal(f.fired.count, 1);
});

for (const [name, evidence] of [
  ['revokes another bridge', (f: Fixture) => f.account.revokeOther.history],
  ['is a forged account history', (f: Fixture) => f.forged.revokeOwn.history],
  ['carries a tampered signature', (f: Fixture) => tamper(f.account.revokeOwn.history)],
] as const) {
  test(`AccountBridgeRevoked evidence that ${name}: no emit, no block, counted as a failed read with 60 s backoff`, async t => {
    const f = await started(t);
    const rejected = evidence(f);
    f.state.respond = async () => { throw new AccountBridgeRevoked(rejected); };
    await f.advance(h1); assert.equal(f.state.reads, 1);
    await f.advance(60_000 - 1); assert.equal(f.state.reads, 1);
    await f.advance(1); assert.equal(f.state.reads, 2);
    await f.advance(120_000 - 1); assert.equal(f.state.reads, 2);
    await f.advance(1); assert.equal(f.state.reads, 3);
    assert.equal(f.fired.count, 0);
    assert.equal(f.block.mock.callCount(), 0);
    assert.equal(await f.security.policy.accountAvailable(), true);
  });
}

test('startAccount with an already revoked pin emits before any read; a late listener still hears it', async t => {
  const f = await started(t);
  f.state.respond = async () => f.account.revokeOwn.history;
  await f.advance(h1);
  assert.equal(f.fired.count, 1);
  await f.security.close();
  f.state.reads = 0;
  const restarted = f.make();
  const early = listen(restarted);
  await restarted.startAccount();
  assert.equal(early.count, 1);
  assert.equal(f.state.reads, 0);
  const late = listen(restarted);
  const dropped = { count: 0 };
  restarted.onBridgeRevoked(() => { dropped.count++; })();
  assert.equal(late.count, 0, 'a late listener is never invoked synchronously');
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(late.count, 1);
  assert.equal(dropped.count, 0, 'unsubscribing before the microtask cancels the late delivery');
  assert.equal(early.count, 1);
  assert.equal(Reflect.get(restarted, 'accountTimer'), null);
  await f.advance(6 * h1, restarted);
  restarted.requestAccountRefresh(); await settle(restarted);
  assert.equal(f.state.reads, 0);
});

test('multiple triggers emit once to every listener', async t => {
  const f = await started(t);
  const shared = { count: 0 };
  const listener = () => { shared.count++; };
  f.security.onBridgeRevoked(listener); f.security.onBridgeRevoked(listener);
  f.state.respond = async () => f.account.revokeOwn.history;
  f.security.requestAccountRefresh(); await settle(f.security);
  assert.equal(await f.security.confirmRevocationEvidence(f.account.revokeOwn.history), true);
  assert.equal(await f.security.confirmRevocationEvidence(f.account.revokeOwn.history), true);
  await f.security.startAccount();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(f.fired.count, 1);
  assert.equal(shared.count, 1);
  assert.equal(f.state.reads, 1);
});

test('a throwing or rejecting listener is logged and does not stop the others', async t => {
  const f = await started(t);
  const errors = t.mock.method(console, 'error', () => undefined);
  const order: string[] = [];
  f.security.onBridgeRevoked(() => { order.push('throws'); throw new Error('boom'); });
  f.security.onBridgeRevoked(async () => { order.push('rejects'); throw new Error('async boom'); });
  f.security.onBridgeRevoked(() => { order.push('ok'); });
  assert.equal(await f.security.confirmRevocationEvidence(f.account.revokeOwn.history), true);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(order, ['throws', 'rejects', 'ok']);
  assert.equal(f.fired.count, 1);
  assert.equal(errors.mock.callCount(), 2);
});

test('confirmRevocationEvidence: true only for signed evidence that extends the pin and revokes this bridge', async t => {
  const unpinned = await fixture(t);
  const unpinnedFired = listen(unpinned.security);
  assert.equal(await unpinned.security.confirmRevocationEvidence(unpinned.account.revokeOwn.history), false, 'no pin, no proof');
  assert.equal(unpinnedFired.count, 0);
  const f = await started(t);
  assert.equal(await f.security.confirmRevocationEvidence(f.account.revokeOther.history), false);
  assert.equal(await f.security.confirmRevocationEvidence(f.forged.revokeOwn.history), false);
  assert.equal(await f.security.confirmRevocationEvidence(tamper(f.account.revokeOwn.history)), false);
  assert.equal(await f.security.confirmRevocationEvidence(f.account.base.history), false);
  assert.equal(f.fired.count, 0);
  assert.equal(await f.security.confirmRevocationEvidence(f.account.revokeOwn.history), true);
  assert.equal(f.fired.count, 1);
  assert.equal(pinnedRevokesOwn(f.securityDir), false, 'confirmation never rewrites the pin');
});

test('readPinnedAccountCheckpoint returns the pin, null otherwise, and never writes', async t => {
  const f = await fixture(t);
  const listing = async (dir: string) => (await readdir(dir)).sort();
  const before = await listing(f.securityDir);
  assert.equal(readPinnedAccountCheckpoint(f.securityDir), null, 'policy without an account section');
  assert.deepEqual(await listing(f.securityDir), before);
  await f.security.adoptAccount(f.actor, headOf(f.account.base));
  const pinned = await listing(f.securityDir);
  const checkpoint = readPinnedAccountCheckpoint(f.securityDir);
  assert.deepEqual(checkpoint, (await f.security.policy.accountTrust())?.checkpoint);
  assert.equal(checkpoint?.revision, 2);
  assert.deepEqual(await listing(f.securityDir), pinned);

  const scratch = join(f.directory, 'scratch');
  await mkdir(scratch);
  assert.equal(readPinnedAccountCheckpoint(scratch), null, 'missing file');
  assert.equal(readPinnedAccountCheckpoint(join(scratch, 'absent')), null, 'missing directory');
  assert.deepEqual(await listing(scratch), []);
  await writeFile(join(scratch, 'policy.json'), 'not json');
  assert.equal(readPinnedAccountCheckpoint(scratch), null, 'invalid JSON');
  const valid = JSON.parse(await readFile(join(f.securityDir, 'policy.json'), 'utf8')) as { account: { checkpoint: { rootId: string } } };
  valid.account.checkpoint.rootId = 'not-a-root';
  await writeFile(join(scratch, 'policy.json'), JSON.stringify(valid));
  assert.equal(readPinnedAccountCheckpoint(scratch), null, 'schema failure');
  assert.deepEqual(await listing(scratch), ['policy.json']);
});
