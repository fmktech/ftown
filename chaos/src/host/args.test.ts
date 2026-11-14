import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseSeedRange, UsageError } from './args.ts';

test('seed ranges', () => {
  assert.deepEqual(parseSeedRange('1-4'), [1, 2, 3, 4]);
  assert.deepEqual(parseSeedRange('7'), [7]);
  assert.deepEqual(parseSeedRange('5-6,1,6'), [1, 5, 6]);
  for (const bad of ['', '4-1', 'a', '1-', '-3', '1..3']) assert.throws(() => parseSeedRange(bad), UsageError, bad);
});

test('build', () => {
  assert.deepEqual(parseArgs(['build']), { cmd: 'build', image: null });
  assert.deepEqual(parseArgs(['build', '--image', 'x:y']), { cmd: 'build', image: 'x:y' });
  assert.deepEqual(parseArgs(['build', '--image=x:y']), { cmd: 'build', image: 'x:y' });
});

test('selftest defaults and flags', () => {
  const c = parseArgs(['selftest', '--times', '3', '--mem', '1024', '--jobs', '1']);
  assert.deepEqual(c, { cmd: 'selftest', times: 3, vm: { memMb: 1024, icountShift: 1, timeoutSec: 900, jobs: 1 } });
  assert.equal(parseArgs(['selftest']).cmd === 'selftest' && (parseArgs(['selftest']) as { times: number }).times, 2);
});

test('run, campaign and repro', () => {
  const r = parseArgs(['run', '--seeds', '1-4']);
  assert.ok(r.cmd === 'run');
  assert.deepEqual([r.seeds, r.level, r.times, r.vm.jobs], [[1, 2, 3, 4], 'high', 2, 2]);
  const c = parseArgs(['campaign', '--seeds', '1-20', '--times', '2', '--level', 'low']);
  assert.ok(c.cmd === 'campaign');
  assert.deepEqual([c.seeds.length, c.level], [20, 'low']);
  for (const argv of [['--repro', '9'], ['repro', '--seed', '9'], ['repro', '--repro', '9']]) {
    const p = parseArgs(argv);
    assert.ok(p.cmd === 'run', argv.join(' '));
    assert.deepEqual([p.seeds, p.times], [[9], 5]);
  }
  const t = parseArgs(['--repro', '0', '--times', '2', '--level', 'off']);
  assert.ok(t.cmd === 'run');
  assert.deepEqual([t.seeds, t.times, t.level], [[0], 2, 'off']);
});

test('usage errors', () => {
  const bad = [
    ['run'], ['frob'], ['run', '--seeds'], ['run', '--seeds', '1', '--level', 'max'], ['selftest', '--times', '0'],
    ['build', '--times', '2'], ['run', '--seeds', '1', '--wat', '1'], ['repro'], ['repro', '--seed', '1', '--repro', '2'],
    ['selftest', 'extra'], ['run', '--seeds', '1', '--seeds', '2'], ['selftest', '--icount-shift', '11'],
  ];
  for (const argv of bad) assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));
  assert.deepEqual(parseArgs([]), { cmd: 'help' });
  assert.deepEqual(parseArgs(['run', '-h']), { cmd: 'help' });
});
