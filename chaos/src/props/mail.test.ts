import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Property, Rec } from '../contract.ts';
import { mailProperties } from './mail.ts';
import { agent, agentSent, checkpoint, faultStart, mail, nudge, opSend, received, session } from './testlog.ts';

function prop(id: string): Property {
  const p = mailProperties.find((x) => x.id === id);
  assert.ok(p, id);
  return p;
}
const run = (id: string, log: Rec[]) => prop(id).check(log);

test('ids, kinds and sources', () => {
  assert.deepEqual(mailProperties.map((p) => [p.id, p.kind]), [
    ['M1', 'always'], ['M2', 'always'], ['M4', 'always'], ['M5', 'always'], ['C1', 'sometimes'],
  ]);
  assert.equal(prop('M1').title, 'accepted mail is durable');
  assert.equal(prop('M1').source, 'bridge/src/mail-delivery.ts:506-519');
});

// M1
test('M1 pass: tag in inbox or received', () => {
  const log = [
    opSend(1, 'CHAOS-M-1', 'child1'),
    agentSent(2, 'child2', 'CHAOS-M-2', 'child3'),
    received(3, 'child3', 'CHAOS-M-2'),
    checkpoint(9, [session('child1', [mail('CHAOS-M-1')]), session('child3')], true),
  ];
  assert.deepEqual(run('M1', log), { status: 'pass', evidence: [] });
});
test('M1 violated: lost mail', () => {
  const log = [opSend(1, 'CHAOS-M-12', 'child2'), checkpoint(9, [session('child2')], true)];
  assert.deepEqual(run('M1', log), { status: 'violated', evidence: ['lost CHAOS-M-12 to=child2'] });
});
test('M1 unexercised: no accepted send (refused only)', () => {
  const log = [opSend(1, 'CHAOS-M-1', 'child1', 'message', false), checkpoint(9, [session('child1')], true)];
  assert.equal(run('M1', log).status, 'unexercised');
});
test('M1 violated: inbox unparseable', () => {
  const log = [
    opSend(1, 'CHAOS-M-1', 'child1'),
    received(2, 'child1', 'CHAOS-M-1'),
    checkpoint(9, [session('child1', [], { inboxParses: false })], true),
  ];
  assert.deepEqual(run('M1', log), { status: 'violated', evidence: ['inbox unparseable child1'] });
});
test('M1 violated: no final checkpoint', () => {
  const log = [opSend(1, 'CHAOS-M-1', 'child1'), checkpoint(5, [session('child1', [mail('CHAOS-M-1')])])];
  assert.deepEqual(run('M1', log), { status: 'violated', evidence: ['no final checkpoint'] });
});
test('M1 evidence sorted', () => {
  const log = [
    opSend(1, 'CHAOS-M-2', 'child2'),
    opSend(2, 'CHAOS-M-1', 'child1'),
    checkpoint(9, [session('child1'), session('child2')], true),
  ];
  assert.deepEqual(run('M1', log).evidence, ['lost CHAOS-M-1 to=child1', 'lost CHAOS-M-2 to=child2']);
});

// M2
test('M2 pass', () => {
  const log = [received(1, 'child1', 'CHAOS-M-1'), received(2, 'child2', 'CHAOS-M-1')];
  assert.deepEqual(run('M2', log), { status: 'pass', evidence: [] });
});
test('M2 violated: duplicate receive', () => {
  const log = [received(1, 'child1', 'CHAOS-M-1'), received(5, 'child1', 'CHAOS-M-1')];
  assert.deepEqual(run('M2', log), { status: 'violated', evidence: ['duplicate CHAOS-M-1 to=child1'] });
});
test('M2 unexercised', () => {
  assert.equal(run('M2', [opSend(1, 'CHAOS-M-1', 'child1')]).status, 'unexercised');
});

// M4
test('M4 pass: nudges within waking count', () => {
  const log = [
    opSend(1, 'CHAOS-M-1', 'child1', 'task'),
    opSend(2, 'CHAOS-M-2', 'child1', 'message'),
    opSend(3, 'CHAOS-M-3', 'child1', 'fyi'),
    nudge(4, 'child1', 2),
  ];
  assert.deepEqual(run('M4', log), { status: 'pass', evidence: [] });
});
test('M4 violated: double nudge for one mail (agent-side send counts, duplicates collapse)', () => {
  const log = [
    agentSent(1, 'root', 'CHAOS-M-1000', 'child1', 'task'),
    opSend(2, 'CHAOS-M-1000', 'child1', 'task'),
    nudge(3, 'child1', 1),
    nudge(9, 'child1', 1),
  ];
  assert.deepEqual(run('M4', log), { status: 'violated', evidence: ['nudge excess to=child1 nudged=2 waking=1 untagged=0'] });
});
test('M4 violated: fyi-only role nudged', () => {
  const log = [
    opSend(1, 'CHAOS-M-1', 'child1', 'task'),
    opSend(2, 'CHAOS-M-2', 'child2', 'fyi'),
    nudge(3, 'child2', 1),
  ];
  assert.deepEqual(run('M4', log), { status: 'violated', evidence: ['nudge excess to=child2 nudged=1 waking=0 untagged=0'] });
});
test('M4 unexercised: only fyi or refused', () => {
  const log = [opSend(1, 'CHAOS-M-1', 'child1', 'fyi'), opSend(2, 'CHAOS-M-2', 'child1', 'task', false)];
  assert.equal(run('M4', log).status, 'unexercised');
});

test('M4 untagged bridge mail: W=4 U=1 nudged=5 passes, 6 violates', () => {
  const base = (n: number): Rec[] => [
    opSend(1, 'CHAOS-M-1', 'root', 'task'), opSend(2, 'CHAOS-M-2', 'root', 'task'),
    opSend(3, 'CHAOS-M-3', 'root', 'message'), opSend(4, 'CHAOS-M-4', 'root', 'result'),
    checkpoint(5, [session('root', [], { untaggedWakingMail: 0 })]),
    checkpoint(6, [session('root', [], { untaggedWakingMail: 1 })]),
    checkpoint(7, [session('root', [], { untaggedWakingMail: 0 })]),
    nudge(8, 'root', n - 2), nudge(9, 'root', 2),
  ];
  assert.deepEqual(run('M4', base(5)), { status: 'pass', evidence: [] });
  assert.deepEqual(run('M4', base(6)), { status: 'violated', evidence: ['nudge excess to=root nudged=6 waking=4 untagged=1'] });
});
test('M4 exercised by untagged mail alone; unexercised when W+U=0', () => {
  assert.equal(run('M4', [checkpoint(5, [session('root', [], { untaggedWakingMail: 1 })]), nudge(6, 'root', 1)]).status, 'pass');
  assert.equal(run('M4', [checkpoint(5, [session('root')])]).status, 'unexercised');
});

// M5
test('M5 pass: pending fyi and nudged mail are fine, dead sessions ignored', () => {
  const log = [
    checkpoint(9, [
      session('child1', [
        mail('CHAOS-M-1', { delivered: false, type: 'fyi' }),
        mail('CHAOS-M-2', { delivered: false, nudged: true, type: 'task' }),
      ]),
      session('child2', [mail('CHAOS-M-3', { delivered: false, type: 'task' })], { procAlive: false }),
    ], true),
  ];
  assert.deepEqual(run('M5', log), { status: 'pass', evidence: [] });
});
test('M5 violated', () => {
  const log = [
    checkpoint(9, [session('child1', [mail('CHAOS-M-7', { delivered: false, type: 'task' })])], true),
  ];
  assert.deepEqual(run('M5', log), { status: 'violated', evidence: ['pending CHAOS-M-7 to=child1'] });
});
test('M5 unexercised: no live session or no final checkpoint', () => {
  assert.equal(run('M5', [checkpoint(9, [session('child1', [], { tmuxAlive: false })], true)]).status, 'unexercised');
  assert.equal(run('M5', [checkpoint(9, [session('child1')])]).status, 'unexercised');
});

// C1
test('C1 hit: kill9 while mail undelivered', () => {
  const log = [
    checkpoint(10, [session('child1', [mail('CHAOS-M-1', { delivered: false })])]),
    faultStart(20, 'bridge_kill9'),
  ];
  assert.deepEqual(run('C1', log), { status: 'hit', evidence: [] });
});
test('C1 hit: sigterm', () => {
  const log = [checkpoint(10, [session('child1', [mail('CHAOS-M-1', { delivered: false })])]), faultStart(20, 'bridge_sigterm')];
  assert.equal(run('C1', log).status, 'hit');
});
test('C1 not_hit: all delivered, other fault kind, heal phase, or checkpoint after', () => {
  const pending = checkpoint(10, [session('child1', [mail('CHAOS-M-1', { delivered: false })])]);
  assert.equal(run('C1', [checkpoint(10, [session('child1', [mail('CHAOS-M-1')])]), faultStart(20, 'bridge_kill9')]).status, 'not_hit');
  assert.equal(run('C1', [pending, faultStart(20, 'bridge_sigstop')]).status, 'not_hit');
  assert.equal(run('C1', [pending, { k: 'fault', t: 20, id: 'f1', phase: 'heal', kind: 'bridge_kill9', target: 'bridge', ok: true }]).status, 'not_hit');
  assert.equal(run('C1', [faultStart(5, 'bridge_kill9'), pending]).status, 'not_hit');
  assert.equal(run('C1', []).status, 'not_hit');
});
test('agent helper compiles with generic events', () => {
  assert.equal(agent(1, 'root', { ev: 'start', pid: 1 }).k, 'agent');
});
