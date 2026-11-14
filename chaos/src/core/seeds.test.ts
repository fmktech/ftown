import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeeds } from './seeds.ts';

test('ranges and lists are sorted and de-duplicated', () => {
  assert.deepEqual(parseSeeds('1-3,2,7'), [1, 2, 3, 7]);
  assert.deepEqual(parseSeeds('5'), [5]);
  assert.deepEqual(parseSeeds('4-4'), [4]);
  assert.deepEqual(parseSeeds('9,1'), [1, 9]);
  assert.deepEqual(parseSeeds('0'), [0]);
});

test('malformed lists are rejected', () => {
  for (const bad of ['', '3-1', 'a', '1,,2', '1,', ',1', '1-', '-1', ' 1', '1 ', '1.5', '1-a', '1--2', '99999999999999999999']) {
    assert.throws(() => parseSeeds(bad), Error, JSON.stringify(bad));
  }
});

test('absurdly large ranges are rejected', () => {
  assert.throws(() => parseSeeds('1-1000000'), /too many/);
});
