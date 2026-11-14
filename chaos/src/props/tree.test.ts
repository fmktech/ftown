import test from 'node:test';
import assert from 'node:assert/strict';
import { treeProperties } from './tree.ts';
import { cp, ev, snap } from './testlog2.ts';

const t1 = treeProperties[0];

test('exports exactly T1', () => {
  assert.deepEqual(treeProperties.map((p) => p.id), ['T1']);
});
test('passes on contiguous growing seqs, first may be >1', () => {
  const r = t1.check([cp(1, snap({ treeEvents: [ev(5), ev(6)] })), cp(2, snap({ treeEvents: [ev(5), ev(6), ev(7)] }), true)]);
  assert.equal(r.status, 'pass');
});
test('violated on a gap', () => {
  const r = t1.check([cp(1, snap({ treeEvents: [ev(1), ev(3)] }), true)]);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, ['seq 1 followed by 3']);
});
test('violated on a duplicate seq', () => {
  assert.equal(t1.check([cp(1, snap({ treeEvents: [ev(1), ev(1)] }), true)]).status, 'violated');
});
test('violated when last seq regresses', () => {
  const r = t1.check([cp(1, snap({ treeEvents: [ev(1), ev(2), ev(3)] })), cp(2, snap({ treeEvents: [ev(1), ev(2)] }), true)]);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, ['last seq regressed 3 to 2']);
});
test('violated when a seq changes kind between checkpoints', () => {
  const r = t1.check([cp(1, snap({ treeEvents: [ev(1, 'a')] })), cp(2, snap({ treeEvents: [ev(1, 'b')] }), true)]);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, ['seq 1 changed a/child1 to b/child1']);
});
test('violated on corrupt lines in the final checkpoint only', () => {
  const bad = snap({ treeEvents: [ev(1)], treeEventsCorruptLines: 2 });
  assert.deepEqual(t1.check([cp(1, bad, true)]).evidence, ['corrupt lines 2']);
  assert.equal(t1.check([cp(1, bad), cp(2, snap({ treeEvents: [ev(1)] }), true)]).status, 'pass');
});
test('unexercised without tree events', () => {
  assert.equal(t1.check([]).status, 'unexercised');
  assert.equal(t1.check([cp(1, snap(), true)]).status, 'unexercised');
});
