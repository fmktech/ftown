import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Rec } from '../contract.ts';
import { decodeLog, encodeLog, encodeRec, hashLog } from './canon.ts';

const sample: Rec[] = [
  { k: 'run', seed: 3, level: 'high', contract: 3 },
  {
    k: 'schedule',
    faults: [{ id: 'f1', kind: 'clock_jump_back', target: 'clock', atMs: 90000, durationMs: 0, jumpMs: -30000, long: false }],
  },
  { k: 'fault', t: 90000, id: 'f1', phase: 'start', kind: 'clock_jump_back', target: 'clock', ok: true },
  { k: 'op', t: 5, op: { op: 'mail_send', tag: 'CHAOS-M-1', to: 'child1', type: 'task' }, ok: false, error: 'x "q"\n' },
  { k: 'agent', t: 7, role: 'child1', e: { ev: 'mail_received', tag: 'CHAOS-M-1', type: 'task', fromRole: 'root' } },
  {
    k: 'checkpoint',
    t: 30000,
    name: 'c1',
    final: false,
    snap: { bridgeAlive: true, bridgeResponsive: true, sessions: [], treeEvents: [{ seq: 1, kind: 'k', role: null }], treeEventsCorruptLines: 0 },
  },
  { k: 'verdict', prop: 'M1', kind: 'always', status: 'pass', evidence: ['b', 'a'] },
];

/** Rebuild an object with its keys in reverse insertion order, recursively. */
function shuffled(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shuffled);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).reverse()) out[k] = shuffled(o[k]);
    return out;
  }
  return v;
}

test('top-level key order follows the contract; nested keys are alphabetical; no whitespace', () => {
  assert.equal(encodeRec(sample[0]!), '{"k":"run","seed":3,"level":"high","contract":3}');
  assert.equal(
    encodeRec(sample[1]!),
    '{"k":"schedule","faults":[{"atMs":90000,"durationMs":0,"id":"f1","jumpMs":-30000,"kind":"clock_jump_back","long":false,"target":"clock"}]}',
  );
  assert.equal(
    encodeRec(sample[3]!),
    '{"k":"op","t":5,"op":{"op":"mail_send","tag":"CHAOS-M-1","to":"child1","type":"task"},"ok":false,"error":"x \\"q\\"\\n"}',
  );
  for (const r of sample) assert.doesNotMatch(encodeRec(r), /\n|: |, /);
});

test('encoding is stable under shuffled input key order; arrays keep order', () => {
  for (const r of sample) assert.equal(encodeRec(shuffled(r) as Rec), encodeRec(r));
  assert.match(encodeRec(sample[6]!), /"evidence":\["b","a"\]/);
});

test('encodeLog / decodeLog round trip and hash', () => {
  const text = encodeLog(sample);
  assert.ok(text.endsWith('\n'));
  assert.equal(text.split('\n').length, sample.length + 1);
  assert.deepEqual(decodeLog(text), sample);
  assert.equal(encodeLog(decodeLog(text)), text);
  assert.match(hashLog(text), /^[0-9a-f]{64}$/);
  assert.equal(hashLog(text), hashLog(encodeLog(shuffled(sample) as Rec[])));
  assert.notEqual(hashLog(text), hashLog(text + '\n'));
});

test('empty log, malformed logs', () => {
  assert.equal(encodeLog([]), '');
  assert.deepEqual(decodeLog(''), []);
  assert.throws(() => decodeLog('{"k":"run"}'), /newline/);
  assert.throws(() => decodeLog('{"k":"run"}\n\n{"k":"run"}\n'), /blank/);
  assert.throws(() => decodeLog('nope\n'));
});

test('unknown kind and non-finite numbers throw', () => {
  assert.throws(() => encodeRec({ k: 'nope' } as unknown as Rec));
  assert.throws(() => encodeRec({ k: 'run', seed: Number.NaN, level: 'off', contract: 3 }));
});

test('only plain data is allowed: integers, strings, booleans, null, arrays, plain objects', () => {
  const withE = (e: unknown) => ({ k: 'agent', t: 1, role: 'root', e }) as unknown as Rec;
  assert.throws(() => encodeRec({ k: 'run', seed: 1.5, level: 'off', contract: 3 }), /non-integer/);
  assert.throws(() => encodeRec({ k: 'run', seed: Number.POSITIVE_INFINITY, level: 'off', contract: 3 }));
  assert.throws(() => encodeRec(withE({ ev: 'x', d: new Date(0) })), /plain/);
  assert.throws(() => encodeRec(withE({ ev: 'x', d: new Map() })), /plain/);
  assert.throws(() => encodeRec(withE({ ev: 'x', d: new Set() })), /plain/);
  class C { a = 1; }
  assert.throws(() => encodeRec(withE({ ev: 'x', d: new C() })), /plain/);
  assert.throws(() => encodeRec(withE({ ev: 'x', d: 1n })), /unsupported/);
  assert.equal(encodeRec(withE({ ev: 'x', d: Object.create(null) })), '{"k":"agent","t":1,"role":"root","e":{"d":{},"ev":"x"}}');
  for (const bad of [{ k: 'nope' }, { k: '__proto__' }, { k: 'toString' }, {}, null]) {
    assert.throws(() => encodeRec(bad as unknown as Rec), /unknown record kind/);
  }
});
