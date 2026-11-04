import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedMatchIndexes,
  GrepBusyError,
  GREP_MAX_CONCURRENT,
  GREP_MAX_QUEUE,
} from './bounded-regex.js';

test('boundedMatchIndexes returns matching line indexes case-insensitively', async () => {
  assert.deepEqual(await boundedMatchIndexes('foo', ['a foo b', 'bar', 'FOO']), [0, 2]);
});

test('boundedMatchIndexes rejects on an invalid pattern', async () => {
  await assert.rejects(() => boundedMatchIndexes('(', ['x']), SyntaxError);
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

test('boundedMatchIndexes rejects overload once the worker pool and queue are saturated', async () => {
  // A catastrophic pattern holds each worker until its budget expires, so the
  // first GREP_MAX_CONCURRENT occupy slots and the next GREP_MAX_QUEUE wait.
  const pattern = '(.|..)+X$';
  const lines = ['ordinary terminal output without suffix!'];
  const inflight: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < GREP_MAX_CONCURRENT + GREP_MAX_QUEUE; i++) {
      inflight.push(boundedMatchIndexes(pattern, lines, 100));
    }
    await assert.rejects(() => boundedMatchIndexes(pattern, lines, 100), GrepBusyError);
  } finally {
    await Promise.allSettled(inflight);
  }
});

function liveWorkers(): number {
  const report = process.report?.getReport() as { workers?: unknown[] } | undefined;
  return report?.workers?.length ?? 0;
}

test('boundedMatchIndexes releases pool slots only after workers exit', async () => {
  // A pool slot must not be freed while a worker is still alive; otherwise
  // concurrent capacity exceeds GREP_MAX_CONCURRENT. Before that fix, worker
  // teardown lagged the resolved promises by several live workers.
  const baseline = liveWorkers();
  await Promise.all(
    Array.from({ length: 20 }, (_value, index) => boundedMatchIndexes('hello', [`hello ${index}`, 'nope'], 5_000)),
  );
  assert.equal(liveWorkers(), baseline, 'workers must have exited before their slots were released');
});
