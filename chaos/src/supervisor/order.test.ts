import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Rec, Snapshot } from '../contract.ts';
import { canonicalOrder, compareRecs } from './order.ts';
import type { Seq } from './order.ts';

const snap: Snapshot = { bridgeAlive: true, bridgeResponsive: true, sessions: [], treeEvents: [], treeEventsCorruptLines: 0 };
const recs: Rec[] = [
  { k: 'checkpoint', t: 10, name: 'cp1', final: false, snap },
  { k: 'agent', t: 10, role: 'child2', e: { ev: 'start', pid: 1 } },
  { k: 'agent', t: 10, role: 'root', e: { ev: 'start', pid: 2 } },
  { k: 'op', t: 10, op: { op: 'mail_send', tag: 'CHAOS-M-1', to: 'child1', type: 'task' }, ok: true, error: null },
  { k: 'fault', t: 10, id: 'f1', phase: 'start', kind: 'bridge_kill9', target: 'bridge', ok: true },
  { k: 'agent', t: 5, role: 'child3', e: { ev: 'start', pid: 3 } },
  { k: 'agent', t: 10, role: 'root', e: { ev: 'exit', code: 0 } },
];

test('orders by t, then kind fault<op<agent<checkpoint, then role, then sequence', () => {
  const items: Seq[] = recs.map((rec, seq) => ({ rec, seq }));
  const out = canonicalOrder(items);
  assert.deepEqual(out.map((r) => `${r.k}${r.k === 'agent' ? `:${r.role}:${r.e.ev}` : ''}`), [
    'agent:child3:start', 'fault', 'op', 'agent:root:start', 'agent:root:exit', 'agent:child2:start', 'checkpoint',
  ]);
});

test('comparator is total and independent of input order', () => {
  const items: Seq[] = recs.map((rec, seq) => ({ rec, seq }));
  const reversed = [...items].reverse();
  assert.deepEqual(canonicalOrder(reversed), canonicalOrder(items));
  for (const a of items) {
    assert.equal(compareRecs(a, a), 0);
    for (const b of items) if (a !== b) assert.equal(Math.sign(compareRecs(a, b)), -Math.sign(compareRecs(b, a)));
  }
});

test('run and schedule sort before everything', () => {
  const head: Seq[] = [
    { rec: { k: 'op', t: 0, op: { op: 'session_create', role: 'root' }, ok: true, error: null }, seq: 0 },
    { rec: { k: 'schedule', faults: [] }, seq: 1 },
    { rec: { k: 'run', seed: 1, level: 'off', contract: 3 }, seq: 2 },
  ];
  assert.deepEqual(canonicalOrder(head).map((r) => r.k), ['run', 'schedule', 'op']);
});
