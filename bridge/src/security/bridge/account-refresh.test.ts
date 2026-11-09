import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { setTimeout as realSleep } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEndpoint } from '../crypto.js';
import { createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from '../account-crypto.js';
import type { AccountHistory } from '../account-protocol.js';
import { BridgeSecurityService } from './security.js';
import { LOCAL_RECOVERY_AUTHORITY } from './policy.js';
import { AccountReadUnavailable } from './account-client.js';

const ownerId = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
const minute = 60_000;

async function fixture(t: { after(fn: () => Promise<void>): void }, withReader = true, random: () => number = () => 0.5) {
  const directory = await mkdtemp(join(tmpdir(), 'ftown-account-refresh-'));
  const bridge = await generateEndpoint(ownerId, 'bridge');
  const first = await generateEndpoint(ownerId, 'browser');
  const signing = await generateAccountSigningIdentity();
  const wall = Date.now();
  let history: AccountHistory = { genesis: await createAccountGenesis(ownerId, first.endpoint, signing, 'First', wall), transitions: [] };
  let checkpoint = await verifyAccountHistory(history, null, wall);
  const record = await signAccountTransition(checkpoint, first.endpoint.id, signing,
    { type: 'add_bridge', bridge: { bridgeId: 'bridge', endpoint: bridge.endpoint, label: 'Computer', approvedAt: new Date(wall).toISOString() } }, wall);
  history = { ...history, transitions: [record] };
  checkpoint = await verifyAccountHistory(history, checkpoint, wall);
  const state = { reads: 0, times: [] as number[], t0: 0, fail: false, gate: null as Promise<void> | null, waiters: [] as Array<() => void> };
  const readAccountHistory = async (): Promise<AccountHistory> => {
    state.reads++; state.times.push(Date.now() - state.t0);
    for (const wake of state.waiters.splice(0)) wake();
    if (state.gate) await state.gate;
    if (state.fail) throw new AccountReadUnavailable();
    return history;
  };
  const security = new BridgeSecurityService(bridge, 'bridge', directory, { relayUserId: 'owner@example.test', now: () => Date.now(), random,
    ...(withReader ? { readAccountHistory } : {}) });
  t.after(async () => { mock.timers.reset(); await security.close(); await rm(directory, { recursive: true, force: true }); });
  const invite = await security.policy.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: 'Legacy' });
  await security.policy.consumeInvitation({ type: 'enroll', candidate: first.endpoint, invitationId: invite.invitationId,
    invitationSecret: invite.secret, label: 'Legacy' });
  const actor = await security.policy.principal(first.endpoint.id);
  const hold = () => { let release!: () => void; state.gate = new Promise<void>(r => { release = () => { state.gate = null; r(); }; }); return { release }; };
  // The timeout only bounds a failing run; a passing run is resolved by the reader itself.
  const entered = () => Promise.race([new Promise<void>(resolve => { state.waiters.push(resolve); }),
    realSleep(5000).then(() => { throw new Error('read never started'); })]);
  return { security, state, hold, entered, adopt: () => security.adoptAccount(actor, { rootId: checkpoint.rootId, revision: checkpoint.revision, head: checkpoint.head }) };
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
const spy = { scheduled: 0, fired: 0 };

async function started(t: { after(fn: () => Promise<void>): void }, opts: { reader?: boolean; healthy?: boolean; failStartup?: boolean; random?: () => number } = {}) {
  const { reader = true, healthy = true, failStartup = false, random } = opts;
  const f = await fixture(t, reader, random);
  if (reader) await f.adopt();
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() });
  const mocked = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { spy.scheduled++; return mocked(() => { spy.fired++; fn(); }, ms); }) as typeof setTimeout;
  if (failStartup) f.state.fail = true;
  if (reader) { f.security.setAccountPushHealthy(healthy); await f.security.startAccount(); }
  f.state.reads = 0; f.state.times = []; f.state.t0 = Date.now(); spy.scheduled = 0; spy.fired = 0;
  const advance = async (ms: number) => { mock.timers.tick(ms); await settle(f.security); };
  return { ...f, advance, times: () => f.state.times.slice() };
}
const m10 = 600_000, h1 = 60 * minute;

test('healthy push and successful reads: safety reads are 1 h apart (59/60 min regression)', async t => {
  const f = await started(t);
  await f.advance(59 * minute); assert.deepEqual(f.times(), []);
  await f.advance(minute); assert.deepEqual(f.times(), [h1]);
  await f.advance(59 * minute); assert.deepEqual(f.times(), [h1]);
  await f.advance(minute); assert.deepEqual(f.times(), [h1, 2 * h1]);
});

test('unhealthy push keeps the 10 min cadence', async t => {
  const f = await started(t, { healthy: false });
  await f.advance(599_000); assert.deepEqual(f.times(), []);
  await f.advance(1000); assert.deepEqual(f.times(), [m10]);
  await f.advance(m10); assert.deepEqual(f.times(), [m10, 2 * m10]);
});

test('a failed read is retried in 60 s even when push is healthy', async t => {
  const f = await started(t);
  f.state.fail = true;
  await f.advance(h1); assert.deepEqual(f.times(), [h1]);
  f.state.fail = false;
  await f.advance(59_000); assert.deepEqual(f.times(), [h1]);
  await f.advance(1000); assert.deepEqual(f.times(), [h1, h1 + minute]);
  await f.advance(59 * minute); assert.equal(f.state.reads, 2);
  await f.advance(minute); assert.deepEqual(f.times(), [h1, h1 + minute, 2 * h1 + minute]);
});

test('consecutive failed safety reads back off 60 s to 30 min and then stay at 30 min', async t => {
  const f = await started(t);
  f.state.fail = true;
  await f.advance(h1); assert.equal(f.state.reads, 1);
  for (const [i, delay] of [60, 120, 240, 480, 960, 1800, 1800].entries()) {
    await f.advance(delay * 1000 - 1); assert.equal(f.state.reads, i + 1, `no read before ${delay} s`);
    await f.advance(1); assert.equal(f.state.reads, i + 2, `one read at ${delay} s`);
  }
});

test('a success after failures resets the backoff: 1 h with healthy push', async t => {
  const f = await started(t);
  f.state.fail = true;
  await f.advance(h1); await f.advance(minute); await f.advance(2 * minute);
  assert.equal(f.state.reads, 3);
  f.state.fail = false;
  await f.advance(4 * minute); assert.equal(f.state.reads, 4);
  await f.advance(h1 - 1000); assert.equal(f.state.reads, 4);
  await f.advance(1000); assert.equal(f.state.reads, 5);
});

test('a success after failures resets the backoff: 10 min with unhealthy push', async t => {
  const f = await started(t, { healthy: false });
  f.state.fail = true;
  await f.advance(m10); await f.advance(minute);
  assert.equal(f.state.reads, 2);
  f.state.fail = false;
  await f.advance(2 * minute); assert.equal(f.state.reads, 3);
  await f.advance(m10 - 1000); assert.equal(f.state.reads, 3);
  await f.advance(1000); assert.equal(f.state.reads, 4);
});

test('a nudge-triggered failure counts toward the backoff and a later nudge success resets it', async t => {
  const f = await started(t);
  f.state.fail = true;
  f.security.requestAccountRefresh(); await settle(f.security);
  assert.equal(f.state.reads, 1);
  await f.advance(1000);
  f.security.requestAccountRefresh(); await settle(f.security);
  assert.equal(f.state.reads, 2);
  await f.advance(120_000 - 1); assert.equal(f.state.reads, 2);
  await f.advance(1); assert.equal(f.state.reads, 3);
  f.state.fail = false;
  await f.advance(1000);
  f.security.requestAccountRefresh(); await settle(f.security);
  assert.equal(f.state.reads, 4);
  await f.advance(h1 - 1000); assert.equal(f.state.reads, 4);
  await f.advance(1000); assert.equal(f.state.reads, 5);
});

test('a startup read failure counts as the first failure', async t => {
  const f = await started(t, { failStartup: true });
  await f.advance(59_000); assert.equal(f.state.reads, 0);
  await f.advance(1000); assert.equal(f.state.reads, 1);
  await f.advance(120_000 - 1); assert.equal(f.state.reads, 1);
  await f.advance(1); assert.equal(f.state.reads, 2);
});

test('push loss pulls a later backoff timer in to 10 min', async t => {
  const f = await started(t);
  f.state.fail = true;
  await f.advance(h1);
  for (const delay of [60, 120, 240, 480]) await f.advance(delay * 1000);
  assert.equal(f.state.reads, 5);
  f.security.setAccountPushHealthy(false);
  await f.advance(m10 - 1000); assert.equal(f.state.reads, 5);
  await f.advance(1000); assert.equal(f.state.reads, 6);
});

test('push loss does not push an earlier backoff timer out', async t => {
  const f = await started(t);
  f.state.fail = true;
  await f.advance(h1); assert.equal(f.state.reads, 1);
  f.security.setAccountPushHealthy(false);
  await f.advance(60_000); assert.equal(f.state.reads, 2);
});

test('retry delay is jittered 0.8x to 1.2x: lower bound', async t => {
  const f = await started(t, { random: () => 0 });
  f.state.fail = true;
  await f.advance(h1); assert.equal(f.state.reads, 1);
  await f.advance(47_900); assert.equal(f.state.reads, 1);
  await f.advance(100); assert.equal(f.state.reads, 2);
});

test('retry delay is jittered 0.8x to 1.2x: upper bound', async t => {
  const f = await started(t, { random: () => 0.999999 });
  f.state.fail = true;
  await f.advance(h1); assert.equal(f.state.reads, 1);
  await f.advance(71_900); assert.equal(f.state.reads, 1);
  await f.advance(100); assert.equal(f.state.reads, 2);
});

test('outage simulation: 6 h of failing reads with healthy push stays at 15 reads or fewer', async t => {
  const f = await started(t);
  f.state.fail = true;
  for (let elapsed = 0; elapsed < 6 * h1; elapsed += 30_000) await f.advance(30_000);
  assert.equal(f.state.reads, 14);
});

test('losing push health pulls the next read within 10 min', async t => {
  const f = await started(t);
  await f.advance(10 * minute); assert.deepEqual(f.times(), []);
  f.security.setAccountPushHealthy(false);
  await f.advance(m10); assert.deepEqual(f.times(), [10 * minute + m10]);
});

test('a request during an in-flight nudge read causes exactly one fresh read after it settles', async t => {
  const f = await started(t);
  const gate = f.hold();
  const first = f.entered();
  f.security.requestAccountRefresh(); await first;
  assert.equal(f.state.reads, 1);
  f.security.requestAccountRefresh(); f.security.requestAccountRefresh(); f.security.requestAccountRefresh();
  gate.release(); await settle(f.security);
  assert.equal(f.state.reads, 1);
  await f.advance(1000); assert.deepEqual(f.times(), [0, 1000]);
  await f.advance(5000); assert.equal(f.state.reads, 2);
});

test('a nudge during an in-flight timer-initiated read gets its own fresh read', async t => {
  const f = await started(t, { healthy: false });
  const gate = f.hold();
  const first = f.entered();
  mock.timers.tick(m10); await first;
  assert.equal(f.state.reads, 1);
  f.security.requestAccountRefresh();
  gate.release(); await settle(f.security);
  assert.deepEqual(f.times(), [m10, m10]);
  assert.equal(f.state.reads, 2);
});

test('burst of requests: first read is immediate, the rest collapse into one trailing read at 1 s spacing', async t => {
  const f = await started(t);
  for (let i = 0; i < 10; i++) f.security.requestAccountRefresh();
  await settle(f.security); assert.deepEqual(f.times(), [0]);
  await f.advance(999); assert.equal(f.state.reads, 1);
  await f.advance(1); assert.deepEqual(f.times(), [0, 1000]);
  await f.advance(10_000); assert.equal(f.state.reads, 2);
});

test('close cancels the pending safety timer and no reads follow', async t => {
  const f = await started(t, { healthy: false });
  await f.security.close();
  f.security.requestAccountRefresh();
  await f.advance(2 * h1);
  assert.equal(f.state.reads, 0);
  assert.equal(spy.fired, 0);
});

test('a read settling after close does not schedule another safety timer', async t => {
  const f = await started(t, { healthy: false });
  const gate = f.hold();
  const first = f.entered();
  mock.timers.tick(m10); await first;
  const before = spy.scheduled;
  const closing = f.security.close();
  gate.release(); await closing; await settle(f.security);
  assert.equal(spy.scheduled, before);
  await f.advance(2 * h1);
  assert.equal(spy.fired, 1);
  assert.equal(f.state.reads, 1);
});

test('requestAccountRefresh without readAccountHistory is a no-op', async t => {
  const f = await started(t, { reader: false });
  assert.doesNotThrow(() => f.security.requestAccountRefresh());
  await f.advance(minute);
  assert.equal(f.state.reads, 0);
});
