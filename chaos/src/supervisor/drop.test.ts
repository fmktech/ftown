import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule } from '../core/schedule.ts';
import { deriveRng } from '../core/rng.ts';
import { applyDrop, parseDropFaults } from './drop.ts';

test('parseDropFaults: unset/empty = null, tokens trimmed and de-duplicated', () => {
  assert.equal(parseDropFaults(undefined), null);
  assert.equal(parseDropFaults('  '), null);
  assert.deepEqual(parseDropFaults('f2, f4,f2'), ['f2', 'f4']);
  assert.deepEqual(parseDropFaults('f1,,f2'), ['f1', '', 'f2']);
});

test('drops by id and by kind from the seed schedule, keeping the rest unchanged', () => {
  const full = buildSchedule(1, 'high', deriveRng(1, 'faults'));
  const id = full[1].id;
  const kind = full[0].kind;
  const { faults, unknown } = applyDrop(full, [id, kind]);
  assert.deepEqual(unknown, []);
  assert.deepEqual(faults, full.filter((f) => f.id !== id && f.kind !== kind));
  assert.ok(faults.length < full.length);
});

test('unknown ids or kinds, and empty tokens, are reported', () => {
  const full = buildSchedule(1, 'high', deriveRng(1, 'faults'));
  assert.deepEqual(applyDrop(full, ['f99', 'bogus_kind', '']).unknown, ['f99', 'bogus_kind', '']);
  // A real kind that is not in this schedule is known (nothing to drop).
  assert.deepEqual(applyDrop([], ['bridge_sigstop']).unknown, []);
});
