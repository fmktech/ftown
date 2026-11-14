import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionProperties } from './sessions.ts';
import { cp, sess, snap } from './testlog2.ts';
import type { Property } from '../contract.ts';

const get = (id: string): Property => {
  const p = sessionProperties.find((x) => x.id === id);
  assert.ok(p);
  return p;
};

test('exports exactly S1, R1', () => {
  assert.deepEqual(sessionProperties.map((p) => p.id), ['S1', 'R1']);
});

test('S1 passes when live sessions have a tmux or process', () => {
  const s = snap({ sessions: [sess('root'), sess('child1', { tmuxAlive: false })] });
  assert.equal(get('S1').check([cp(1, s, true)]).status, 'pass');
});
test('S1 passes for a completed dead session', () => {
  const s = snap({ sessions: [sess('root'), sess('child1', { status: 'completed', tmuxAlive: false, procAlive: false })] });
  assert.equal(get('S1').check([cp(1, s, true)]).status, 'pass');
});
test('S1 violated for running and pending dead sessions', () => {
  const s = snap({ sessions: [
    sess('root'),
    sess('child1', { status: 'running', tmuxAlive: false, procAlive: false }),
    sess('child2', { status: 'pending', tmuxAlive: false, procAlive: false }),
  ] });
  const r = get('S1').check([cp(1, s, true)]);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, ['child1 status=running tmux and process gone', 'child2 status=pending tmux and process gone']);
});

test('R1 passes on a healthy final checkpoint', () => {
  assert.equal(get('R1').check([cp(1, snap(), true)]).status, 'pass');
});
test('R1 violated when bridge down, unresponsive or session unparseable', () => {
  const s = snap({ bridgeAlive: false, bridgeResponsive: false, sessions: [sess('root'), sess('child1', { status: 'unparseable' })] });
  const r = get('R1').check([cp(1, s, true)]);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, ['bridge not alive', 'bridge not responsive', 'child1 session.json unparseable']);
});
test('R1 violated with no final checkpoint', () => {
  const r = get('R1').check([cp(1, snap())]);
  assert.equal(r.status, 'violated');
  assert.deepEqual(r.evidence, ['no final checkpoint']);
});
