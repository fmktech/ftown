import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BridgeUpdateCoordinator, type BridgeUpdateDependencies } from './bridge-update.js';
import { UpdateAdmission } from './update-admission.js';
import type { VerifiedPrincipal } from './security/protocol.js';
import type { PreparedRelease, StableRelease, UpdateReceipt } from './update-runtime-contract.js';

const principal = { bridgeId: 'bridge', permissions: ['read', 'control'] } as VerifiedPrincipal;
const release: StableRelease = { version: '2.0.0', gitHead: 'a', integrity: 'sha512-a', tarballUrl: 'https://registry.npmjs.org/ftown/-/ftown-2.0.0.tgz', nodeEngine: '>=22' };
const prepared: PreparedRelease = { protocol: 1, operationId: '12345678-1234-4234-8234-123456789abc', targetVersion: '2.0.0', jobDir: '/job', packageRoot: '/job/pkg', packageEntry: '/job/pkg/dist/ftown-cli.js' };
const id = prepared.operationId;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  let receipt: UpdateReceipt | null = null, authorized = true, busy = false;
  const effects: string[] = [];
  const deps: BridgeUpdateDependencies = {
    bridgeId: 'bridge', currentVersion: '1.0.0', stagingRoot: '/tmp/updates',
    restart: { mode: 'local', home: '/home', dataDir: '/home/.ftown/data', cwd: '/home', apiUrl: '', bridgeId: 'bridge', ownerId: 'owner', endpointId: 'endpoint' },
    support: () => null, busy: async () => busy,
    authorize: async (_p, permission) => { if (!authorized && permission === 'control') throw new Error('revoked'); },
    resolve: async () => release,
    reserve: async () => { effects.push('reserve'); return { release: async () => { effects.push('release'); } }; },
    prepare: async () => { effects.push('stage'); return prepared; },
    discard: async () => { effects.push('discard'); },
    prepareHandoff: async () => { effects.push('prepare'); return { commit: async () => { effects.push('commit'); }, cancel: async () => { effects.push('cancel'); } }; },
    readReceipt: async () => receipt, writeReceipt: async value => { receipt = value; effects.push(`receipt:${value.operation.phase}`); },
    shutdown: async () => { effects.push('shutdown'); }, admission: new UpdateAdmission(),
  };
  return { deps, effects, revoke: () => { authorized = false; }, setBusy: (v: boolean) => { busy = v; }, receipt: () => receipt };
}

test('request is idempotent and effects wait for both response signals', async () => {
  const f = fixture(), coordinator = new BridgeUpdateCoordinator(f.deps);
  const first = await coordinator.request(principal, '2.0.0', id);
  assert.deepEqual(f.effects, ['receipt:staging']);
  const duplicate = await coordinator.request(principal, '2.0.0', id);
  assert.equal(duplicate.ticket, null);
  await assert.rejects(coordinator.request(principal, '2.0.1', id));
  first.ticket!.markSealed(); await tick(); assert.deepEqual(f.effects, ['receipt:staging']);
  first.ticket!.markDelivered(); await tick(); await tick();
  assert.deepEqual(f.effects, ['receipt:staging', 'reserve', 'stage', 'prepare', 'receipt:prepared', 'receipt:restarting', 'commit', 'shutdown']);
});

test('undelivered response records failure without staging', async () => {
  const f = fixture(), coordinator = new BridgeUpdateCoordinator(f.deps);
  const request = await coordinator.request(principal, '2.0.0', id);
  request.ticket!.markSealed(); request.ticket!.cancel(); request.ticket!.markDelivered(); await tick();
  assert.deepEqual(f.effects, ['receipt:staging', 'receipt:failed']);
  assert.equal(f.receipt()?.operation.phase, 'failed');
});

test('revocation after staging releases admission and owned resources', async () => {
  const f = fixture();
  f.deps.prepare = async () => { f.effects.push('stage'); f.revoke(); return prepared; };
  const coordinator = new BridgeUpdateCoordinator(f.deps), request = await coordinator.request(principal, '2.0.0', id);
  request.ticket!.markSealed(); request.ticket!.markDelivered(); await tick(); await tick();
  assert.deepEqual(f.effects, ['receipt:staging', 'reserve', 'stage', 'discard', 'release', 'receipt:failed']);
  assert.equal(f.deps.admission.isFrozen, false);
});

test('busy and control permission reject without staging', async () => {
  const f = fixture(), coordinator = new BridgeUpdateCoordinator(f.deps);
  f.setBusy(true);
  await assert.rejects(coordinator.request(principal, '2.0.0', id), { code: 'bridge_busy' });
  assert.deepEqual(f.effects, []);
  f.setBusy(false); f.revoke();
  const status = await coordinator.snapshot(principal);
  assert.equal(status.canUpdate, false); assert.equal(status.blockedReason, 'permission_denied');
  await assert.rejects(coordinator.request(principal, '2.0.0', id));
});

test('uncertain helper exit keeps admission closed and retains recovery evidence', async () => {
  const f = fixture();
  f.deps.prepareHandoff = async () => { throw Object.assign(new Error('uncertain'), { code: 'handoff_uncertain' }); };
  const coordinator = new BridgeUpdateCoordinator(f.deps), request = await coordinator.request(principal, '2.0.0', id);
  request.ticket!.markSealed(); request.ticket!.markDelivered(); await tick(); await tick();
  assert.equal(f.deps.admission.isFrozen, true);
  assert.equal(f.effects.includes('discard'), false);
  assert.equal(f.effects.includes('release'), false);
  assert.equal(f.receipt()?.operation.phase, 'restarting');
});

test('changed stable target is rejected before receipt or effects', async () => {
  const f = fixture(), coordinator = new BridgeUpdateCoordinator(f.deps);
  await assert.rejects(coordinator.request(principal, '1.9.0', id), { code: 'update_target_changed' });
  assert.deepEqual(f.effects, []);
  await assert.rejects(coordinator.request(principal, '2.0.0-rc.1', id), { code: 'invalid_update_request' });
});

test('execution independently checks latest again before staging', async () => {
  const f = fixture(); let checks = 0;
  f.deps.resolve = async () => ++checks === 1 ? release : { ...release, version: '2.1.0' };
  const coordinator = new BridgeUpdateCoordinator(f.deps), request = await coordinator.request(principal, '2.0.0', id);
  request.ticket!.markSealed(); request.ticket!.markDelivered(); await tick(); await tick();
  assert.equal(checks, 2); assert.equal(f.effects.includes('stage'), false);
  assert.equal(f.effects.includes('release'), true); assert.equal(f.receipt()?.operation.phase, 'failed');
});

test('failed helper cancellation keeps admission frozen and does not discard its stage', async () => {
  const f = fixture();
  f.deps.prepareHandoff = async () => ({
    commit: async () => { throw new Error('unknown commit'); },
    cancel: async () => { throw new Error('no exit proof'); },
  });
  const coordinator = new BridgeUpdateCoordinator(f.deps), request = await coordinator.request(principal, '2.0.0', id);
  request.ticket!.markSealed(); request.ticket!.markDelivered(); await tick(); await tick();
  assert.equal(f.deps.admission.isFrozen, true);
  assert.equal(f.effects.includes('discard'), false); assert.equal(f.effects.includes('release'), false);
});

test('revocation after helper commit cancels it before shutdown', async () => {
  const f = fixture();
  f.deps.prepareHandoff = async () => ({
    commit: async () => { f.effects.push('commit'); f.revoke(); },
    cancel: async () => { f.effects.push('cancel'); },
  });
  const coordinator = new BridgeUpdateCoordinator(f.deps), request = await coordinator.request(principal, '2.0.0', id);
  request.ticket!.markSealed(); request.ticket!.markDelivered(); await tick(); await tick();
  assert.equal(f.effects.includes('cancel'), true); assert.equal(f.effects.includes('shutdown'), false);
  assert.equal(f.deps.admission.isFrozen, false);
});


test('uncertain staging process freezes admission and preserves reservation', async () => {
  const f = fixture();
  f.deps.prepare = async () => { f.effects.push('stage'); throw Object.assign(new Error('child exit unknown'), { code: 'update_process_uncertain' }); };
  const coordinator = new BridgeUpdateCoordinator(f.deps), request = await coordinator.request(principal, '2.0.0', id);
  request.ticket!.markSealed(); request.ticket!.markDelivered(); await tick(); await tick();
  assert.equal(f.deps.admission.isFrozen, true);
  assert.equal(f.effects.includes('discard'), false); assert.equal(f.effects.includes('release'), false);
  assert.equal(f.receipt()?.operation.phase, 'restarting');
  await assert.rejects(coordinator.request(principal, '2.0.0', '12345678-1234-4234-8234-123456789abd'), { code: 'update_in_progress' });
});


test('manual setup recommends a newer release or the installed version without changing availability', async () => {
  const cases = [
    { label: 'newer', latest: '2.0.0', manual: 'npx ftown@2.0.0 setup', availability: 'available', canUpdate: true, blockedReason: null },
    { label: 'equal', latest: '1.0.0', manual: 'npx ftown@1.0.0 setup', availability: 'current', canUpdate: false, blockedReason: null },
    { label: 'installed ahead', latest: '0.19.57', manual: 'npx ftown@1.0.0 setup', availability: 'current', canUpdate: false, blockedReason: null },
    { label: 'unavailable', latest: null, manual: 'npx ftown@1.0.0 setup', availability: 'unknown', canUpdate: false, blockedReason: 'release_unavailable' },
  ] as const;
  for (const scenario of cases) {
    const f = fixture();
    f.deps.resolve = async () => { if (!scenario.latest) throw new Error('registry unavailable'); return { ...release, version: scenario.latest }; };
    const status = await new BridgeUpdateCoordinator(f.deps).snapshot(principal);
    assert.equal(status.manualCommand, scenario.manual, scenario.label);
    assert.equal(status.latestVersion, scenario.latest, scenario.label);
    assert.equal(status.availability, scenario.availability, scenario.label);
    assert.equal(status.canUpdate, scenario.canUpdate, scenario.label);
    assert.equal(status.blockedReason, scenario.blockedReason, scenario.label);
  }
});
