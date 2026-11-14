import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuHasFlag, fixedShuffle, hasNonLoInterface } from './selftest.ts';

const NETDEV = 'Inter-|   Receive\n face |bytes\n    lo: 0 0\n';

test('only lo is not a network interface', () => {
  assert.equal(hasNonLoInterface(NETDEV, ['lo']), false);
  assert.equal(hasNonLoInterface(NETDEV + '  eth0: 1 2\n', ['lo']), true);
  assert.equal(hasNonLoInterface(NETDEV, ['eth0', 'lo']), true);
});

test('cpu flag detection', () => {
  const info = 'processor\t: 0\nflags\t\t: fpu sse4_2 popcnt\n';
  assert.equal(cpuHasFlag(info, 'rdrand'), false);
  assert.equal(cpuHasFlag(info + 'flags\t: rdrand\n', 'rdrand'), true);
  assert.equal(cpuHasFlag('flags : rdrandx\n', 'rdrand'), false);
});

test('fixed shuffle is a constant permutation', () => {
  const a = fixedShuffle(50);
  assert.deepEqual(a, fixedShuffle(50));
  assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 50 }, (_, i) => i));
  assert.notDeepEqual(a, Array.from({ length: 50 }, (_, i) => i));
});
