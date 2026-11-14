import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT } from '../contract.ts';
import { differingKeys, firstDiffLine, formatSeedLine, normalizeConsole, sha256, summarizeSeed, violatedProps, worstExit, type BootResult } from './summary.ts';

const boot = (content: string, exitCode = 0, wallMs = 1000): BootResult => ({ exitCode, infraError: null, hash: sha256(content), content, wallMs });
const CANON = '{"k":"run","seed":1}\n{"k":"verdict","prop":"M1","kind":"always","status":"violated","evidence":[]}\n{"k":"verdict","prop":"A1","kind":"always","status":"pass","evidence":[]}\n';

test('identical runs pass with the guest exit code', () => {
  const s = summarizeSeed(3, [boot(CANON, 1), boot(CANON, 1, 2000)]);
  assert.equal(s.exitCode, EXIT.violation);
  assert.equal(s.nondeterminism, null);
  assert.deepEqual(s.violated, ['M1']);
  assert.equal(s.wallSec, 3);
  assert.match(formatSeedLine(s), /^seed 3  H_run=[0-9a-f]{12}  violated=M1  wall=3\.0s  exit=1$/);
});

test('differing runs are nondeterminism with the first differing line', () => {
  const s = summarizeSeed(1, [boot('a\nb\nc\n'), boot('a\nb\nc\n'), boot('a\nX\nc\n')]);
  assert.equal(s.exitCode, EXIT.nondeterminism);
  assert.match(s.nondeterminism!, /run1 vs run3 differ at line 2/);
  assert.match(s.nondeterminism!, /run3: X/);
});

test('same log but different exit code is nondeterminism', () => {
  assert.equal(summarizeSeed(1, [boot('a', 0), boot('a', 1)]).exitCode, EXIT.nondeterminism);
});

test('an infra error in any run makes the seed infra', () => {
  const bad: BootResult = { exitCode: EXIT.infra, infraError: 'timeout', hash: null, content: null, wallMs: 5 };
  const s = summarizeSeed(2, [boot('a'), bad]);
  assert.equal(s.exitCode, EXIT.infra);
  assert.match(formatSeedLine(s), /H_run=-{12}.*INFRA: timeout/);
});

test('worst exit ordering', () => {
  assert.equal(worstExit([]), EXIT.ok);
  assert.equal(worstExit([0, 4, 1]), EXIT.violation);
  assert.equal(worstExit([1, 3]), EXIT.infra);
  assert.equal(worstExit([3, 2, 1]), EXIT.nondeterminism);
  assert.equal(worstExit([0, 99]), EXIT.infra);
});

test('helpers', () => {
  assert.equal(firstDiffLine('a\nb', 'a\nb'), null);
  assert.deepEqual(firstDiffLine('a', 'a\nb'), { line: 2, a: '<eof>', b: 'b' });
  assert.deepEqual(differingKeys({ a: 1, b: [1], c: 2 }, { a: 1, b: [2], d: 3 }), ['b', 'c', 'd']);
  assert.deepEqual(violatedProps('garbage\n' + CANON), ['M1']);
  assert.equal(normalizeConsole('[    1.234567] hello\r\nx'), 'hello\nx');
});
