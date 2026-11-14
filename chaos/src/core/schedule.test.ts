import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAULTS, FAULT_WINDOW_END_MS, FAULT_WINDOW_START_MS, type ChaosLevel, type FaultSpec } from '../contract.ts';
import { deriveRng } from './rng.ts';
import { buildSchedule, validateFaults } from './schedule.ts';

const build = (seed: number, level: ChaosLevel) => buildSchedule(seed, level, deriveRng(seed, 'faults'));

test('level off is empty', () => {
  for (let s = 1; s <= 20; s++) assert.deepEqual(build(s, 'off'), []);
});

test('same inputs give deep-equal output; seeds differ', () => {
  assert.deepEqual(build(42, 'high'), build(42, 'high'));
  assert.deepEqual(build(42, 'low'), build(42, 'low'));
  const seen = new Set<string>();
  for (let s = 1; s <= 30; s++) seen.add(JSON.stringify(build(s, 'high')));
  assert.ok(seen.size > 20);
});

test('ids f1..fn in atMs order', () => {
  const s = build(5, 'high');
  s.forEach((f, i) => assert.equal(f.id, `f${i + 1}`));
  for (let i = 1; i < s.length; i++) assert.ok(s[i - 1]!.atMs <= s[i]!.atMs);
});

for (const level of ['low', 'high'] as const) {
  test(`property over seeds 1..200 for level ${level}`, () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = build(seed, level);
      const longs = s.filter((f) => f.long);
      if (level === 'low') {
        assert.ok(s.length >= 2 && s.length <= 4, `seed ${seed} count ${s.length}`);
        assert.equal(longs.length, 0);
      } else {
        assert.ok(s.length >= 4 && s.length <= 6, `seed ${seed} count ${s.length}`);
        assert.equal(longs.length, 1);
      }
      for (const f of s) {
        assert.ok(f.atMs >= FAULT_WINDOW_START_MS, `seed ${seed} start`);
        assert.ok(f.atMs + f.durationMs <= FAULT_WINDOW_END_MS, `seed ${seed} end`);
        const spec = FAULTS.find((x) => x.kind === f.kind)!;
        if (spec.target === 'clock') {
          assert.equal(f.durationMs, 0);
          assert.ok(f.jumpMs !== null && f.jumpMs !== 0);
          assert.equal(f.jumpMs < 0, f.kind === 'clock_jump_back');
          assert.equal(f.target, 'clock');
        } else {
          assert.equal(f.jumpMs, null);
        }
        if (spec.target === 'parent') assert.equal(f.target, 'root');
        if (spec.target === 'agent') assert.ok(['child1', 'child2', 'child3'].includes(f.target));
        if (spec.target === 'bridge') assert.equal(f.target, 'bridge');
        if (f.long) assert.ok(spec.long !== null || spec.jump !== null);
      }
      for (let i = 0; i < s.length; i++) {
        for (let j = i + 1; j < s.length; j++) {
          const a = s[i]!;
          const b = s[j]!;
          const overlap = a.atMs <= b.atMs + b.durationMs && b.atMs <= a.atMs + a.durationMs;
          if (a.target === b.target) assert.ok(!overlap, `seed ${seed}: ${a.id}/${b.id} overlap on ${a.target}`);
          if (a.target === 'bridge' && b.target === 'bridge') assert.ok(!overlap);
        }
      }
      const kills = s.filter((f) => f.kind === 'parent_kill9' || f.kind === 'agent_kill9');
      const roles = kills.map((f) => f.target);
      assert.equal(new Set(roles).size, roles.length, `seed ${seed}: repeated kill`);
      for (const k of kills) {
        const later = s.filter((f) => f !== k && f.target === k.target && f.atMs >= k.atMs);
        assert.deepEqual(later, [], `seed ${seed}: fault on dead ${k.target}`);
      }
    }
  });
}

test('high level covers every long-capable kind across seeds', () => {
  const kinds = new Set<string>();
  for (let seed = 1; seed <= 200; seed++) for (const f of build(seed, 'high')) if (f.long) kinds.add(f.kind);
  assert.deepEqual(
    [...kinds].sort(),
    ['agent_sigstop', 'bridge_kill9', 'bridge_sigstop', 'clock_jump_back', 'clock_jump_fwd'],
  );
});

test('validateFaults accepts the real table', () => {
  validateFaults(FAULTS);
});

const base = FAULTS[0]!;
const clockSpec = FAULTS.find((f) => f.target === 'clock')!;
test('validateFaults rejects duplicate kinds', () => {
  assert.throws(() => validateFaults([base, base]), /duplicate/);
});
test('validateFaults rejects clock fault without jump', () => {
  assert.throws(() => validateFaults([{ ...clockSpec, jump: null }]), /no jump/);
});
test('validateFaults rejects non-clock fault with a jump', () => {
  assert.throws(() => validateFaults([{ ...base, jump: clockSpec.jump }]), /jump range/);
});
test('validateFaults rejects inverted and invalid ranges', () => {
  const bad = (f: Partial<FaultSpec>): FaultSpec => ({ ...base, ...f });
  assert.throws(() => validateFaults([bad({ short: [5, 1] })]), /inverted/);
  assert.throws(() => validateFaults([bad({ long: [9, 2] })]), /inverted/);
  assert.throws(() => validateFaults([bad({ short: [Number.NaN, 1] })]), /inverted/);
  assert.throws(() => validateFaults([{ ...clockSpec, jump: { short: [2, 1], long: [1, 1] } }]), /inverted/);
});
