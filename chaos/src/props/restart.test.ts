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
function snap(bridgeAlive = true, bridgeResponsive = true): Snapshot {
  return {
    bridgeAlive,
    bridgeResponsive,
    sessions: [],
    treeEvents: [],
    treeEventsCorruptLines: 0,
  };
}

function cp(t: number, bridgeAlive = true, name = `cp${t}`, final = false, bridgeResponsive = true): Rec {
  return {
    k: 'checkpoint',
    t,
    name,
    final,
    snap: snap(bridgeAlive, bridgeResponsive),
  };
}

function faultStart(
  t: number,
  id: string,
  kind: FaultKind = 'bridge_kill9',
  ok = true,
  doneT = t,
): Rec {
  return {
    k: 'fault',
    t,
    doneT,
    id,
    phase: 'start',
    kind,
    target: 'bridge',
    ok,
  };
}

function faultHeal(
  t: number,
  id: string,
  kind: FaultKind = 'bridge_kill9',
  ok = true,
  doneT = t,
): Rec {
  return {
    k: 'fault',
    t,
    doneT,
    id,
    phase: 'heal',
    kind,
    target: 'bridge',
    ok,
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
    faultStart(20_000, 'f1', 'bridge_kill9', true, 20_100),
    cp(25_000, false, 'cp25'), // inside fault interval
    faultHeal(30_000, 'f1', 'bridge_kill9', true, 35_000),
    cp(45_000, false, 'cp45'), // 10s after doneT: inside GRACE_MS (30s)
    cp(35_000 + GRACE_MS, false, 'cpGraceEnd'), // exactly at doneT + GRACE_MS
    cp(70_000, true, 'cp70'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.evidence, []);
});

test('normal kill -9 with heal ok=true in 27 s and dead checkpoint 10 s after doneT passes', () => {
  const log: Rec[] = [
    cp(60_000, true),
    faultStart(78_000, 'f1', 'bridge_kill9', true, 78_000),
    cp(90_000, false, 'cp90'),
    cp(105_000, false, 'cp105'),
    faultHeal(81_000, 'f1', 'bridge_kill9', true, 108_000),
    cp(118_000, false, 'cp118'), // 10 s after doneT
    cp(135_000, true, 'cp135'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.evidence, []);
});

test('violated when dead 31 s after heal doneT', () => {
  const log: Rec[] = [
    cp(60_000, true),
    faultStart(78_000, 'f1', 'bridge_kill9', true, 78_000),
    faultHeal(81_000, 'f1', 'bridge_kill9', true, 108_000),
    cp(139_000, false, 'cp139'), // 31 s after doneT=108_000
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge down at cp139 t=139000 last bridge fault f1 healed doneT=108000',
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
    'bridge down at cp20 t=20000 last bridge fault none healed doneT=none',
  ]);
});

test('violated when bridge is alive but not responsive outside grace', () => {
  const log: Rec[] = [
    cp(10_000, true),
    cp(20_000, true, 'cp20', false, false),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge down at cp20 t=20000 last bridge fault none healed doneT=none',
  ]);
});

test('ok=false start grants no grace', () => {
  const log: Rec[] = [
    cp(60_000, true),
    faultStart(80_000, 'f1', 'bridge_kill9', false, 80_000),
    cp(90_000, false, 'cp90'),
    faultHeal(82_000, 'f1', 'bridge_kill9', true, 82_000),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge down at cp90 t=90000 last bridge fault f1 healed doneT=82000',
  ]);
});

test('exact seed-2 shape: f1 heal ok=false, f2/f3 starts ok=false, cps at 90/105/120 s dead -> violated with heal-failed', () => {
  const log: Rec[] = [
    cp(60_000, true, 'cp60'),
    cp(75_000, true, 'cp75'),
    faultStart(78_000, 'f1', 'bridge_kill9', true, 78_000),
    cp(90_000, false, 'cp90'),
    cp(105_000, false, 'cp105'),
    faultHeal(81_000, 'f1', 'bridge_kill9', false, 108_900),
    faultStart(108_900, 'f2', 'bridge_kill9', false, 108_900),
    faultStart(108_900, 'f3', 'bridge_sigterm', false, 108_900),
    cp(120_000, false, 'cp120'),
    faultHeal(110_900, 'f2', 'bridge_kill9', true, 136_000),
    faultHeal(136_000, 'f3', 'bridge_sigterm', true, 136_000),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'heal failed: f1 bridge_kill9 t=81000 doneT=108900',
  ]);
});

test('final heal with ok=false violates even with non-bridge kind and no alive checkpoints', () => {
  const log: Rec[] = [
    { k: 'fault', t: 120_000, doneT: 145_000, id: 'heal', phase: 'heal', kind: 'clock_jump_fwd', target: 'all', ok: false },
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'heal failed: heal clock_jump_fwd t=120000 doneT=145000',
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

test('a start without heal covers up to start.doneT + GRACE_MS', () => {
  const log: Rec[] = [
    cp(10_000, true),
    faultStart(20_000, 'f1', 'bridge_kill9', true, 20_500),
    cp(25_000, false, 'cp25'),
    cp(20_500 + GRACE_MS, false, 'cpGraceEnd'),
    cp(20_500 + GRACE_MS + 1, false, 'cpAfter'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge down at cpAfter t=50501 last bridge fault none healed doneT=none',
  ]);
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
    'bridge down at cpA t=15000 last bridge fault none healed doneT=none',
    'bridge down at cpB t=20000 last bridge fault none healed doneT=none',
  ]);
});

test('evidence references the latest healed fault before the checkpoint', () => {
  const log: Rec[] = [
    cp(10_000, true),
    faultStart(20_000, 'f1', 'bridge_sigterm', true, 20_000),
    faultHeal(25_000, 'f1', 'bridge_sigterm', true, 26_000),
    cp(30_000, true),
    faultStart(50_000, 'f2', 'bridge_sigstop', true, 50_000),
    faultHeal(60_000, 'f2', 'bridge_sigstop', true, 61_000),
    cp(128_500, false, 'cp128'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge down at cp128 t=128500 last bridge fault f2 healed doneT=61000',
  ]);
});

test('final heal record with ok=true is ignored for intervals', () => {
  const log: Rec[] = [
    cp(10_000, true),
    // Final heal record emitted at end of schedule (target: 'all', id: 'heal')
    { k: 'fault', t: 20_000, doneT: 20_000, id: 'heal', phase: 'heal', kind: 'bridge_kill9', target: 'all', ok: true },
    cp(80_000, false, 'cp80'),
  ];
  const r = get('R2').check(log);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, [
    'bridge down at cp80 t=80000 last bridge fault none healed doneT=none',
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
    'bridge down at cp70 t=70000 last bridge fault none healed doneT=none',
  ]);
});

test('empty log or log without checkpoints passes', () => {
  assert.equal(get('R2').check([]).status, 'pass');
  assert.equal(get('R2').check([faultStart(10_000, 'f1', 'bridge_kill9')]).status, 'pass');
});
