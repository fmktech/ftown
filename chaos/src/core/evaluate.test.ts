import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT, PROPERTY_IDS, type PropKind, type PropResult, type Property, type Rec } from '../contract.ts';
import { assertDeclared, evaluate, worst } from './evaluate.ts';

const mk = (id: string, kind: PropKind, check: Property['check']): Property => ({ id, kind, source: 's', title: id, check });
const fixed = (id: string, kind: PropKind, r: PropResult): Property => mk(id, kind, () => r);
const log: Rec[] = [{ k: 'run', seed: 1, level: 'low', profile: 'short', contract: 7 }];

test('all passing => ok; verdicts follow prop order', () => {
  const r = evaluate(
    [fixed('B', 'always', { status: 'pass', evidence: [] }), fixed('A', 'unreachable', { status: 'pass', evidence: [] })],
    log,
  );
  assert.equal(r.exitCode, EXIT.ok);
  assert.deepEqual(
    r.verdicts.map((v) => [v.k, v.prop, v.kind, v.status]),
    [['verdict', 'B', 'always', 'pass'], ['verdict', 'A', 'unreachable', 'pass']],
  );
});

test('always violated => violation', () => {
  const r = evaluate([fixed('X', 'always', { status: 'violated', evidence: ['e'] })], log);
  assert.equal(r.exitCode, EXIT.violation);
  assert.deepEqual(r.verdicts[0]!.evidence, ['e']);
});

test('always unexercised => violation (green cannot be vacuous)', () => {
  assert.equal(evaluate([fixed('X', 'always', { status: 'unexercised', evidence: [] })], log).exitCode, EXIT.violation);
});

test('unreachable violated => violation, pass => ok', () => {
  assert.equal(evaluate([fixed('S', 'unreachable', { status: 'violated', evidence: ['x'] })], log).exitCode, EXIT.violation);
  assert.equal(evaluate([fixed('S', 'unreachable', { status: 'pass', evidence: [] })], log).exitCode, EXIT.ok);
});

test('sometimes never affects the exit code', () => {
  for (const status of ['hit', 'not_hit'] as const) {
    assert.equal(evaluate([fixed('C', 'sometimes', { status, evidence: [] })], log).exitCode, EXIT.ok);
  }
});

test('a crashed check is violated and fails the run for every kind', () => {
  for (const kind of ['always', 'sometimes', 'unreachable'] as const) {
    const r = evaluate([mk('T', kind, () => { throw new Error('boom'); })], log);
    assert.equal(r.verdicts[0]!.status, 'violated');
    assert.deepEqual(r.verdicts[0]!.evidence, ['property threw: boom']);
    assert.equal(r.exitCode, EXIT.violation, kind);
  }
});

test('null/undefined result, invalid status and bad evidence are violated, never throw', () => {
  const bads: Property['check'][] = [
    () => null as unknown as PropResult,
    () => undefined as unknown as PropResult,
    () => ({ status: 'pass', evidence: 'x' as unknown as string[] }),
    () => ({ status: 'pass', evidence: [1 as unknown as string] }),
    () => ({ status: 'pass' }) as unknown as PropResult,
  ];
  for (const kind of ['always', 'sometimes'] as const) {
    for (const check of bads) {
      const r = evaluate([mk('X', kind, check)], log);
      assert.equal(r.verdicts[0]!.status, 'violated');
      assert.equal(r.exitCode, EXIT.violation);
    }
  }
});

test('a property cannot mutate the log seen by another', () => {
  const mutator = mk('M', 'sometimes', (l) => {
    try { (l as Rec[]).push({ k: 'run', seed: 9, level: 'off', profile: 'short', contract: 7 }); } catch { /* frozen */ }
    try { (l[0] as { seed: number }).seed = 99; } catch { /* frozen */ }
    return { status: 'hit', evidence: [] };
  });
  let seen: readonly Rec[] = [];
  const reader = mk('R', 'always', (l) => { seen = l; return { status: 'pass', evidence: [] }; });
  const r = evaluate([mutator, reader], log);
  assert.deepEqual(seen, log);
  assert.equal(log[0]!.k === 'run' && log[0]!.seed, 1, 'caller log untouched');
  assert.equal(r.verdicts[0]!.status, 'hit');
  assert.ok(Object.isFrozen(seen));
});

test('properties never see verdict records', () => {
  let seen: readonly Rec[] = [];
  evaluate([mk('X', 'always', (l) => { seen = l; return { status: 'pass', evidence: [] }; })], [
    ...log,
    { k: 'verdict', prop: 'Z', kind: 'always', status: 'pass', evidence: [] },
  ]);
  assert.deepEqual(seen, log);
});

test('assertDeclared', () => {
  const all = PROPERTY_IDS.map((id) => fixed(id, 'always', { status: 'pass', evidence: [] }));
  assertDeclared(all);
  assertDeclared([...all].reverse());
  assert.throws(() => assertDeclared(all.slice(1)), /missing/);
  assert.throws(() => assertDeclared([...all, fixed('ZZ', 'always', { status: 'pass', evidence: [] })]), /extra/);
  assert.throws(() => assertDeclared([...all, all[0]!]), /duplicate/);
});

test('worst precedence', () => {
  assert.equal(worst([0, 1, 4, 3]), 3);
  assert.equal(worst([0, 1, 4]), 4);
  assert.equal(worst([0, 1]), 1);
  assert.equal(worst([]), 0);
  assert.throws(() => worst([64]));
});
