import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../core/clock.ts';
import { ROLES } from '../contract.ts';
import type { Rec, ScheduledFault } from '../contract.ts';
import { runFaults, timeline } from './faults.ts';
import type { FaultActions } from './faults.ts';

const f = (id: string, kind: ScheduledFault['kind'], target: ScheduledFault['target'], atMs: number, durationMs: number, jumpMs: number | null = null): ScheduledFault => ({ id, kind, target, atMs, durationMs, jumpMs, long: false });

function fakeActions(calls: string[], opts: { exitInTime?: boolean; clockOk?: boolean } = {}): FaultActions {
  let alive = true;
  return {
    async signalBridge(sig) {
      calls.push(`bridge ${sig}`);
      if (!alive) return false;
      if (sig === 'SIGKILL') alive = false;
      if (sig === 'SIGTERM' && opts.exitInTime !== false) alive = false;
      return true;
    },
    async waitBridgeExit(bound) {
      calls.push(`wait ${bound}`);
      return !alive;
    },
    async bridgeAlive() {
      return alive;
    },
    async bridgeUp() {
      calls.push('up');
      alive = true;
      return true;
    },
    async signalAgent(role, sig) {
      calls.push(`${role} ${sig}`);
      return true;
    },
    async jumpClock(ms) {
      calls.push(`clock ${ms}`);
      return opts.clockOk ?? false;
    },
  };
}

test('timeline orders heals before starts at equal times', () => {
  const t = timeline([f('f1', 'bridge_sigstop', 'bridge', 20_000, 2_000), f('f2', 'agent_kill9', 'child1', 22_000, 0)]);
  assert.deepEqual(t.map((s) => `${s.fault.id}:${s.phase}@${s.atMs}`), ['f1:start@20000', 'f1:heal@22000', 'f2:start@22000']);
});

test('executes start/heal per kind and ends with the final heal', async () => {
  const clock = fakeClock();
  const calls: string[] = [];
  const recs: Rec[] = [];
  const schedule = [
    f('f1', 'bridge_kill9', 'bridge', 20_000, 3_000),
    f('f2', 'agent_sigstop', 'child2', 30_000, 3_000),
    f('f3', 'bridge_sigterm', 'bridge', 40_000, 2_000),
    f('f4', 'parent_kill9', 'root', 50_000, 0),
    f('f5', 'clock_jump_fwd', 'clock', 60_000, 0, 90_000),
  ];
  const done = runFaults({ clock, schedule, actions: fakeActions(calls), roles: ROLES, log: (r) => recs.push(r) });
  await clock.advance(100_000);
  await done;
  assert.deepEqual(calls, [
    'bridge SIGKILL', 'up', 'child2 SIGSTOP', 'child2 SIGCONT', 'bridge SIGTERM', 'wait 30000', 'up', 'root SIGKILL', 'clock 90000',
    'bridge SIGCONT', 'root SIGCONT', 'child1 SIGCONT', 'child2 SIGCONT', 'child3 SIGCONT',
  ]);
  assert.deepEqual(
    recs.map((r) => (r.k === 'fault' ? `${r.t} ${r.doneT} ${r.id} ${r.phase} ${r.kind} ${r.target} ${r.ok}` : '')),
    [
      '20000 20000 f1 start bridge_kill9 bridge true',
      '23000 23000 f1 heal bridge_kill9 bridge true',
      '30000 30000 f2 start agent_sigstop child2 true',
      '33000 33000 f2 heal agent_sigstop child2 true',
      '40000 40000 f3 start bridge_sigterm bridge true',
      '42000 42000 f3 heal bridge_sigterm bridge true',
      '50000 50000 f4 start parent_kill9 root true',
      '60000 60000 f5 start clock_jump_fwd clock false',
      '60000 60000 heal heal clock_jump_fwd all true',
    ],
  );
});

test('sigterm that does not exit in time is killed and logged ok=false', async () => {
  const clock = fakeClock();
  const calls: string[] = [];
  const recs: Rec[] = [];
  const done = runFaults({ clock, schedule: [f('f1', 'bridge_sigterm', 'bridge', 20_000, 1_000)], actions: fakeActions(calls, { exitInTime: false }), roles: ROLES, log: (r) => recs.push(r) });
  await clock.advance(30_000);
  await done;
  assert.deepEqual(calls.slice(0, 5), ['bridge SIGTERM', 'wait 30000', 'bridge SIGKILL', 'wait 10000', 'up']);
  assert.equal(recs[0].k === 'fault' && recs[0].ok, false);
});

test('stopped() ends the loop before the next step and skips the final heal', async () => {
  const clock = fakeClock();
  const calls: string[] = [];
  const recs: Rec[] = [];
  let stop = false;
  const done = runFaults({ clock, schedule: [f('f1', 'agent_kill9', 'child1', 20_000, 0), f('f2', 'agent_kill9', 'child2', 40_000, 0)], actions: fakeActions(calls), roles: ROLES, log: (r) => recs.push(r), stopped: () => stop });
  await clock.advance(25_000);
  stop = true;
  await clock.advance(30_000);
  await done;
  assert.deepEqual(calls, ['child1 SIGKILL']);
  assert.equal(recs.length, 1);
});

test('empty schedule: no records, no final heal', async () => {
  const calls: string[] = [];
  const recs: Rec[] = [];
  await runFaults({ clock: fakeClock(), schedule: [], actions: fakeActions(calls), roles: ROLES, log: (r) => recs.push(r) });
  assert.deepEqual(calls, []);
  assert.deepEqual(recs, []);
});

test('a slow heal does not delay other faults; a bridge step waits for the running bridge heal', async () => {
  const clock = fakeClock();
  const calls: string[] = [];
  const recs: Rec[] = [];
  const base = fakeActions(calls);
  const actions: FaultActions = {
    ...base,
    async bridgeUp() {
      calls.push('up begin');
      await clock.sleep(26_000);
      calls.push('up end');
      return base.bridgeUp();
    },
  };
  const schedule = [
    f('f1', 'bridge_kill9', 'bridge', 20_000, 3_000),
    f('f2', 'agent_kill9', 'child1', 30_000, 0),
    f('f3', 'bridge_sigstop', 'bridge', 35_000, 2_000),
  ];
  const done = runFaults({ clock, schedule, actions, roles: ROLES, log: (r) => recs.push(r) });
  await clock.advance(100_000);
  await done;
  assert.deepEqual(
    recs.map((r) => (r.k === 'fault' ? `${r.t} ${r.doneT} ${r.id} ${r.phase}` : '')),
    [
      '20000 20000 f1 start',
      '30000 30000 f2 start',
      '23000 49000 f1 heal',
      '49000 49000 f3 start',
      '51000 51000 f3 heal',
      '51000 51000 heal heal',
    ],
  );
  assert.deepEqual(calls.slice(0, 6), ['bridge SIGKILL', 'up begin', 'child1 SIGKILL', 'up end', 'up', 'bridge SIGSTOP']);
});
