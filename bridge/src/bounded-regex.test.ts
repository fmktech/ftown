import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedMatchIndexes } from './bounded-regex.js';

test('boundedMatchIndexes returns matching line indexes case-insensitively', async () => {
  assert.deepEqual(await boundedMatchIndexes('foo', ['a foo b', 'bar', 'FOO']), [0, 2]);
});

test('boundedMatchIndexes throws on an invalid pattern', () => {
  assert.throws(() => boundedMatchIndexes('(', ['x']), SyntaxError);
});

test('boundedMatchIndexes bounds catastrophic backtracking instead of stalling', async () => {
  const start = Date.now();
  const result = await boundedMatchIndexes('(.|..)+X$', ['ordinary terminal output without suffix!'], 300);
  assert.equal(result, null);
  assert.ok(Date.now() - start < 5_000, 'must terminate promptly');
});

test('boundedMatchIndexes bounds overlap-alternative backtracking', async () => {
  const result = await boundedMatchIndexes('(a|aa)+$', ['a'.repeat(40) + '!'], 300);
  assert.equal(result, null);
});
