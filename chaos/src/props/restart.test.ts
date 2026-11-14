import test from 'node:test';
import assert from 'node:assert/strict';
import { GRACE_MS, restartProperties } from './restart.ts';
import type { FaultKind, Property, Rec, Snapshot } from '../contract.ts';

const get = (id: string): Property => {
  const p = restartProperties.find((x) => x.id === id);
  assert.ok(p, `Property ${id} not found in restartProperties`);
  return p;
};

// Tiny log builders for restart property tests.
function snap(bridgeAlive = true): Snapshot {
  return {
    bridgeAlive,
    bridgeResponsive: true,
    sessions: [],
    treeEvents: [],
    treeEventsCorruptLines: 0,
  };
}

function cp(t: number, bridgeAlive = true, name = `cp${t}`, final = false): Rec {
  return {
    k: 'checkpoint',
    t,
    name,
    final,
    snap: snap(bridgeAlive),
  };
}

function faultStart(t: number, id: string, kind: FaultKind = 'bridge_kill9'): Rec {
  return {
    k: 'fault',
    t,
    id,
    phase: 'start',
    kind,
    target: 'bridge',
    ok: true,
  };
}

function faultHeal(t: number, id: string, kind: FaultKind = 'bridge_kill9'): Rec {
  return {
    k: 'fault',
    t,
    id,
    phase: 'heal',
    kind,
    target: 'bridge',
    ok: true,
  };
}

test('exports exactly R2', () => {
  assert.deepEqual(restartProperties.map((p) => p.id), ['R2']);
  const r2 = get('R2');
  assert.equal(r2.kind, 'unreachable');
  assert.equal(r2.title, 'bridge down while no bridge fault is active');
  assert.equal(
    r2.source,
    'bridge/src/solo/hub-manager.ts (hub health wait); bridge/src/index.ts solo start',
  );
});

test('pass when the bridge is only dead inside a fault interval or within the grace', () => {
  const log: Rec[] = [
    cp(10_000, true),
    faultStart(20_000, 'f1', 'bridge_kill9'),
    cp(25_000, false, 'cp25'), // inside fault interval
    faultHeal(30_000, 'f1', 'bridge_kill9'),
    cp(45_000, false, 'cp45'), // 15s after heal: inside GRACE_MS (30s)
    cp(30_000 + GRACE_MS, false, 'cpGraceEnd'), // exactly at heal + GRACE_MS
    cp(65_000, true, 'cp65'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.evidence, []);
});

test('violated when dead 60 s after a heal', () => {
  const log: Rec[] = [
    cp(10_000, true),
    faultStart(20_000, 'f1', 'bridge_kill9'),
    faultHeal(30_000, 'f1', 'bridge_kill9'),
    cp(90_000, false, 'cp90'), // 60s (60,000 ms) after heal
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge dead at checkpoint cp90, 60000 ms after heal of f1 (bridge_kill9)',
  ]);
});

test('violated when dead with no bridge fault at all', () => {
  const log: Rec[] = [
    cp(10_000, true),
    cp(20_000, false, 'cp20'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge dead at checkpoint cp20, no bridge fault before it',
  ]);
});

test('ignored during bring-up', () => {
  const log: Rec[] = [
    cp(5_000, false, 'cp5'),
    cp(10_000, false, 'cp10'),
    cp(15_000, true, 'cp15'), // first alive checkpoint
    cp(20_000, true, 'cp20'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.evidence, []);
});

test('a start without heal covers the rest of the log', () => {
  const log: Rec[] = [
    cp(10_000, true),
    faultStart(20_000, 'f1', 'bridge_kill9'),
    cp(25_000, false, 'cp25'),
    cp(100_000, false, 'cp100'),
    cp(500_000, false, 'cp500'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.evidence, []);
});

test('evidence text exact: multiple violating checkpoints sorted', () => {
  const log: Rec[] = [
    cp(10_000, true),
    cp(20_000, false, 'cpB'),
    cp(15_000, false, 'cpA'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge dead at checkpoint cpA, no bridge fault before it',
    'bridge dead at checkpoint cpB, no bridge fault before it',
  ]);
});

test('evidence references the latest healed fault before the checkpoint and rounds N down', () => {
  const log: Rec[] = [
    cp(10_000, true),
    faultStart(20_000, 'f1', 'bridge_sigterm'),
    faultHeal(25_000, 'f1', 'bridge_sigterm'),
    cp(30_000, true),
    faultStart(50_000, 'f2', 'bridge_sigstop'),
    faultHeal(60_000, 'f2', 'bridge_sigstop'),
    cp(128_500, false, 'cp128'), // 68,500 ms after heal of f2 -> rounds down to 60,000 ms
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge dead at checkpoint cp128, 60000 ms after heal of f2 (bridge_sigstop)',
  ]);
});

test('final heal record with id heal is ignored', () => {
  const log: Rec[] = [
    cp(10_000, true),
    // Final heal record emitted at end of schedule (target: 'all', id: 'heal')
    { k: 'fault', t: 20_000, id: 'heal', phase: 'heal', kind: 'bridge_kill9', target: 'all', ok: true },
    cp(80_000, false, 'cp80'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge dead at checkpoint cp80, no bridge fault before it',
  ]);
});

test('non-bridge faults are ignored', () => {
  const log: Rec[] = [
    cp(10_000, true),
    faultStart(20_000, 'f1', 'agent_kill9'),
    faultHeal(25_000, 'f1', 'agent_kill9'),
    cp(70_000, false, 'cp70'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge dead at checkpoint cp70, no bridge fault before it',
  ]);
});

test('empty log or log without checkpoints passes', () => {
  assert.equal(get('R2').check([]).status, 'pass');
  assert.equal(get('R2').check([faultStart(10_000, 'f1', 'bridge_kill9')]).status, 'pass');
});
