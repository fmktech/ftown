import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT, PROPERTY_IDS, type PropKind, type PropResult, type Property, type Rec } from '../contract.ts';
import { assertDeclared, evaluate, worst } from './evaluate.ts';

const mk = (id: string, kind: PropKind, check: Property['check']): Property => ({ id, kind, source: 's', title: id, check });
const fixed = (id: string, kind: PropKind, r: PropResult): Property => mk(id, kind, () => r);
const log: Rec[] = [{ k: 'run', seed: 1, level: 'low', contract: 3 }];

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

test('a throwing property is violated with evidence', () => {
  const r = evaluate([mk('T', 'sometimes', () => { throw new Error('boom'); })], log);
  assert.equal(r.verdicts[0]!.status, 'violated');
  assert.deepEqual(r.verdicts[0]!.evidence, ['property threw: boom']);
  assert.equal(r.exitCode, EXIT.ok, 'only always/unreachable affect the exit code');
  const r2 = evaluate([mk('T', 'always', () => { throw new Error('boom'); })], log);
  assert.equal(r2.exitCode, EXIT.violation);
});

test('a status invalid for the kind is violated', () => {
  const r = evaluate([fixed('X', 'always', { status: 'hit', evidence: [] })], log);
  assert.equal(r.verdicts[0]!.status, 'violated');
  assert.equal(r.exitCode, EXIT.violation);
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
