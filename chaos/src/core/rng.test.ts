import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRng } from './rng.ts';

function draws(seed: number, label: Parameters<typeof deriveRng>[1], n: number): number[] {
  const r = deriveRng(seed, label);
  return Array.from({ length: n }, () => r.u32());
}

test('first 5 u32 of (1, faults) are pinned', () => {
  assert.deepEqual(draws(1, 'faults', 5), PINNED);
});

test('same (seed,label) gives the same sequence', () => {
  assert.deepEqual(draws(7, 'faults', 40), draws(7, 'faults', 40));
});

test('different seed or label gives different draws', () => {
  const base = draws(1, 'faults', 10);
  assert.notDeepEqual(base, draws(2, 'faults', 10));
  assert.notDeepEqual(base, draws(1, 'workload.mail', 10));
  assert.notDeepEqual(draws(1, 'agent.child1', 10), draws(1, 'agent.child2', 10));
});

test('stream continues across block boundaries (8 u32 per block)', () => {
  const a = draws(3, 'faults', 20);
  assert.equal(new Set(a).size, 20);
});

test('label containing ":" throws', () => {
  assert.throws(() => deriveRng(1, 'agent.a:b'), /':'/);
});

test('non-integer seed throws', () => {
  assert.throws(() => deriveRng(1.5, 'faults'));
});

test('float is in [0,1)', () => {
  const r = deriveRng(9, 'faults');
  for (let i = 0; i < 1000; i++) {
    const f = r.float();
    assert.ok(f >= 0 && f < 1);
  }
});

test('int stays in range, hits both bounds, handles lo==hi', () => {
  const r = deriveRng(5, 'faults');
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const v = r.int(3, 6);
    assert.ok(v >= 3 && v <= 6);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6]);
  assert.equal(r.int(4, 4), 4);
  assert.throws(() => r.int(5, 4));
});

test('int is unbiased: rejection sampling discards values above the limit', () => {
  // range 3_000_000_000 => limit = 3e9 (floor(2^32/3e9)=1); u32 >= 3e9 must be rejected.
  const raw = deriveRng(11, 'faults');
  const r = deriveRng(11, 'faults');
  let rejectedSeen = false;
  for (let i = 0; i < 200; i++) {
    // Mirror the stream in lock-step to know whether the next raw value would be rejected.
    const out = r.int(0, 2_999_999_999);
    let x = raw.u32();
    while (x >= 3_000_000_000) {
      rejectedSeen = true;
      x = raw.u32();
    }
    assert.equal(out, x);
  }
  assert.ok(rejectedSeen, 'test must exercise at least one rejection');
});

test('pick returns members and throws on empty', () => {
  const r = deriveRng(2, 'faults');
  for (let i = 0; i < 50; i++) assert.ok(['a', 'b', 'c'].includes(r.pick(['a', 'b', 'c'])));
  assert.throws(() => r.pick([]));
});

test('chance respects extremes', () => {
  const r = deriveRng(2, 'faults');
  for (let i = 0; i < 100; i++) {
    assert.equal(r.chance(0), false);
    assert.equal(r.chance(1), true);
  }
});

const PINNED: number[] = [3362849753, 1213490563, 1295919203, 2705416092, 973030652];
