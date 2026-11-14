import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionProperties } from './attention.ts';
import { answered, askSent, att, cp, faultStart, sess, snap } from './testlog2.ts';
import type { Property } from '../contract.ts';

const get = (id: string): Property => {
  const p = attentionProperties.find((x) => x.id === id);
  assert.ok(p);
  return p;
};
const open = (extra = {}) => snap({ sessions: [sess('root'), sess('child1', { attention: [att('CHAOS-Q-1', extra)] })] });

test('exports exactly A1, A2, C2', () => {
  assert.deepEqual(attentionProperties.map((p) => p.id), ['A1', 'A2', 'C2']);
});

test('A1 passes with a single answer', () => {
  const r = get('A1').check([askSent(1, 'child1', 'CHAOS-Q-1'), answered(2, 'child1', 'CHAOS-Q-1')]);
  assert.equal(r.status, 'pass');
});
test('A1 violated on a double answer', () => {
  const r = get('A1').check([askSent(1, 'child1', 'CHAOS-Q-1'), answered(2, 'child1', 'CHAOS-Q-1'), answered(3, 'child1', 'CHAOS-Q-1')]);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, ['CHAOS-Q-1 answered 2 times']);
});
test('A1 unexercised without an accepted ask', () => {
  assert.equal(get('A1').check([]).status, 'unexercised');
  assert.equal(get('A1').check([askSent(1, 'child1', 'CHAOS-Q-1', false)]).status, 'unexercised');
});

test('A2 passes when parent is alive', () => {
  assert.equal(get('A2').check([cp(10, open(), true)]).status, 'pass');
});
test('A2 passes when dead parent and item is human-routed', () => {
  const s = snap({ sessions: [sess('root', { procAlive: false }), sess('child1', { attention: [att('CHAOS-Q-1', { route: 'human' })] })] });
  const early = cp(5, open());
  assert.equal(get('A2').check([early, cp(10, s, true)]).status, 'pass');
});
test('A2 violated when parent dead and item still parent-routed', () => {
  const s = snap({ sessions: [sess('root', { procAlive: false }), sess('child1', { attention: [att('CHAOS-Q-1')] })] });
  const r = get('A2').check([cp(10, s, true)]);
  assert.equal(r.status, 'violated');
  assert.equal(r.evidence.length, 1);
  assert.match(r.evidence[0], /child1 CHAOS-Q-1/);
});
test('A2 violated when parent status is not running', () => {
  const s = snap({ sessions: [sess('root', { status: 'error' }), sess('child1', { attention: [att('CHAOS-Q-1')] })] });
  assert.equal(get('A2').check([cp(10, s, true)]).status, 'violated');
});
test('A2 unexercised with no parent route anywhere', () => {
  assert.equal(get('A2').check([cp(10, snap(), true)]).status, 'unexercised');
  assert.equal(get('A2').check([]).status, 'unexercised');
});

test('C2 hit when parent is killed with an open parent ask', () => {
  const r = get('C2').check([cp(10, open()), faultStart(20, 'parent_kill9'), cp(30, snap(), true)]);
  assert.equal(r.status, 'hit');
  assert.deepEqual(r.evidence, ['parent_kill9 with open CHAOS-Q-1 from child1']);
});
test('C2 not hit when the ask was resolved or the checkpoint is after', () => {
  assert.equal(get('C2').check([cp(10, open({ resolved: true })), faultStart(20, 'parent_kill9')]).status, 'not_hit');
  assert.equal(get('C2').check([faultStart(20, 'parent_kill9'), cp(30, open())]).status, 'not_hit');
  assert.equal(get('C2').check([cp(10, open()), faultStart(20, 'agent_kill9')]).status, 'not_hit');
});
