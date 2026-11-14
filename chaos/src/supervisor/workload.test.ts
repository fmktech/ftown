import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../core/clock.ts';
import { deriveRng } from '../core/rng.ts';
import { FAULT_WINDOW_END_MS } from '../contract.ts';
import type { Rec } from '../contract.ts';
import { normaliseError, planWorkload, runWorkload } from './workload.ts';

test('plan: deterministic, 5–15 s apart, tags from 1, ends by the fault window', () => {
  const p = planWorkload(1, deriveRng, 8_000);
  assert.deepEqual(p, planWorkload(1, deriveRng, 8_000));
  assert.ok(p.length >= 15);
  let prev = 8_000;
  p.forEach((m, i) => {
    assert.equal(m.tag, `CHAOS-M-${i + 1}`);
    assert.ok(m.atMs - prev >= 5_000 && m.atMs - prev <= 15_000);
    assert.ok(m.atMs <= FAULT_WINDOW_END_MS);
    assert.notEqual(m.type, 'escalation');
    prev = m.atMs;
  });
});

test('normaliseError never leaks raw text', () => {
  assert.equal(normaliseError(124, 'whatever 127.0.0.1:8040'), 'timeout');
  assert.equal(normaliseError(1, 'Error: connect ECONNREFUSED 127.0.0.1:41234'), 'bridge_down');
  assert.equal(normaliseError(1, 'fetch failed'), 'bridge_down');
  assert.equal(normaliseError(4, 'permission_denied for abc-123'), 'rejected:permission_denied');
  assert.equal(normaliseError(1, 'Bridge not running'), 'bridge_down');
  assert.equal(normaliseError(1, 'Bridge security: bridge_offline'), 'bridge_down');
  assert.equal(normaliseError(1, 'connected to something odd 10.0.0.1'), 'rejected:exit_1');
});

test('runWorkload logs ok and normalised failures at the planned times', async () => {
  const clock = fakeClock();
  const recs: Rec[] = [];
  const sent: string[] = [];
  const done = runWorkload({
    clock,
    plan: [
      { atMs: 5_000, tag: 'CHAOS-M-1', to: 'child1', type: 'task' },
      { atMs: 12_000, tag: 'CHAOS-M-2', to: 'child2', type: 'fyi' },
      { atMs: 20_000, tag: 'CHAOS-M-3', to: 'child3', type: 'message' },
    ],
    idOf: (r) => (r === 'child3' ? null : `id-${r}`),
    send: async (id, type, body) => {
      sent.push(`${id} ${type} ${body}`);
      await clock.sleep(700);
      return id === 'id-child2' ? { code: 1, stdout: '', stderr: 'ECONNREFUSED' } : { code: 0, stdout: 'mail x sent', stderr: '' };
    },
    log: (r) => recs.push(r),
  });
  await clock.advance(30_000);
  await done;
  assert.deepEqual(sent, ['id-child1 task CHAOS-M-1 from=external to=child1', 'id-child2 fyi CHAOS-M-2 from=external to=child2']);
  assert.deepEqual(recs, [
    { k: 'op', t: 5_000, op: { op: 'mail_send', tag: 'CHAOS-M-1', to: 'child1', type: 'task' }, ok: true, error: null },
    { k: 'op', t: 12_000, op: { op: 'mail_send', tag: 'CHAOS-M-2', to: 'child2', type: 'fyi' }, ok: false, error: 'bridge_down' },
    { k: 'op', t: 20_000, op: { op: 'mail_send', tag: 'CHAOS-M-3', to: 'child3', type: 'message' }, ok: false, error: 'rejected:no_session' },
  ]);
});
