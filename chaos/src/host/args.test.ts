import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseSeedRange, UsageError } from './args.ts';
import { OUT_DIR, seedOutDir } from './paths.ts';
import { join } from 'node:path';

test('seed ranges', () => {
  assert.deepEqual(parseSeedRange('1-4'), [1, 2, 3, 4]);
  assert.deepEqual(parseSeedRange('7'), [7]);
  assert.deepEqual(parseSeedRange('5-6,1,6'), [1, 5, 6]);
  assert.deepEqual(parseSeedRange('1-3,2,7'), [1, 2, 3, 7]);
  for (const bad of ['', '3-1', 'a', '1,,2', '1-', '-3', '1..3']) assert.throws(() => parseSeedRange(bad), UsageError, bad);
});

test('build', () => {
  assert.deepEqual(parseArgs(['build']), { cmd: 'build', image: null, checkRepro: false });
  assert.deepEqual(parseArgs(['build', '--check-repro']), { cmd: 'build', image: null, checkRepro: true });
  assert.deepEqual(parseArgs(['build', '--image', 'x:y']), { cmd: 'build', image: 'x:y', checkRepro: false });
  assert.deepEqual(parseArgs(['build', '--image=x:y']), { cmd: 'build', image: 'x:y', checkRepro: false });
});

test('selftest defaults and flags', () => {
  const c = parseArgs(['selftest', '--times', '3', '--mem', '2048', '--jobs', '1']);
  assert.deepEqual(c, { cmd: 'selftest', times: 3, vm: { memMb: 2048, icountShift: 1, timeoutSec: 300, jobs: 1 }, longSeconds: null });
  const l = parseArgs(['selftest', '--long', '600']);
  assert.ok(l.cmd === 'selftest');
  assert.deepEqual([l.longSeconds, l.vm.timeoutSec], [600, 3600]);
  const d = parseArgs(['selftest']);
  assert.ok(d.cmd === 'selftest');
  assert.deepEqual([d.vm.memMb, d.vm.jobs], [1536, 1]);
  assert.equal(parseArgs(['selftest']).cmd === 'selftest' && (parseArgs(['selftest']) as { times: number }).times, 2);
});

test('run, campaign and repro', () => {
  const r = parseArgs(['run', '--seeds', '1-4']);
  assert.ok(r.cmd === 'run');
  assert.deepEqual([r.seeds, r.level, r.profile, r.times, r.vm.jobs, r.vm.timeoutSec], [[1, 2, 3, 4], 'low', 'short', 2, 1, 2000]);
  const rSoak = parseArgs(['run', '--seeds', '1-4', '--profile', 'soak']);
  assert.ok(rSoak.cmd === 'run');
  assert.deepEqual([rSoak.level, rSoak.profile, rSoak.vm.timeoutSec], ['high', 'soak', 3000]);
  const cDefault = parseArgs(['campaign', '--seeds', '1-20']);
  assert.ok(cDefault.cmd === 'campaign');
  assert.deepEqual([cDefault.level, cDefault.profile, cDefault.vm.timeoutSec], ['low', 'short', 2000]);
  const c = parseArgs(['campaign', '--seeds', '1-20', '--times', '2', '--level', 'low', '--profile', 'soak', '--timeout', '999']);
  assert.ok(c.cmd === 'campaign');
  assert.deepEqual([c.seeds.length, c.level, c.profile, c.vm.timeoutSec], [20, 'low', 'soak', 999]);
  for (const argv of [['--repro', '9'], ['repro', '--seed', '9'], ['repro', '--repro', '9']]) {
    const p = parseArgs(argv);
    assert.ok(p.cmd === 'run', argv.join(' '));
    assert.deepEqual([p.seeds, p.times, p.profile, p.level], [[9], 5, 'short', 'low']);
  }
  const t = parseArgs(['--repro', '0', '--times', '2', '--level', 'off', '--profile', 'soak']);
  assert.ok(t.cmd === 'run');
  assert.deepEqual([t.seeds, t.times, t.level, t.profile, t.vm.timeoutSec], [[0], 2, 'off', 'soak', 3000]);
});

test('profile validation and seedOutDir', () => {
  assert.throws(() => parseArgs(['run', '--seeds', '1', '--profile', 'fast']), UsageError);
  assert.throws(() => parseArgs(['selftest', '--profile', 'short']), UsageError);
  assert.throws(() => parseArgs(['run', '--seeds', '1', '--profile', 'short', '--level', 'high']), /--profile soak/);
  assert.throws(() => parseArgs(['run', '--seeds', '1', '--level', 'high']), /--profile soak/);
  assert.equal(seedOutDir(3, 'short', null), join(OUT_DIR, '3-short'));
  assert.equal(seedOutDir(3, 'soak', 'f2,f4'), join(OUT_DIR, '3-soak-drop-f2,f4'));
});

test('drop faults', () => {
  const r = parseArgs(['repro', '--seed', '3', '--drop-faults', 'f2,clock_jump_fwd']);
  assert.ok(r.cmd === 'run');
  assert.equal(r.dropFaults, 'f2,clock_jump_fwd');
  const n = parseArgs(['run', '--seeds', '1']);
  assert.ok(n.cmd === 'run');
  assert.equal(n.dropFaults, null);
  for (const bad of ['F2', 'f2;rm', 'f2,', ',f2', 'a b', '']) assert.throws(() => parseArgs(['run', '--seeds', '1', '--drop-faults', bad]), UsageError, bad);
  assert.throws(() => parseArgs(['campaign', '--seeds', '1', '--drop-faults', 'f1']), UsageError);
});

test('usage errors', () => {
  const bad = [
    ['run'], ['frob'], ['run', '--seeds'], ['run', '--seeds', '1', '--level', 'max'], ['selftest', '--times', '0'],
    ['build', '--times', '2'], ['run', '--seeds', '1', '--wat', '1'], ['repro'], ['repro', '--seed', '1', '--repro', '2'],
    ['selftest', 'extra'], ['run', '--seeds', '1', '--seeds', '2'], ['selftest', '--icount-shift', '11'], ['selftest', '--mem', '1024'],
  ];
  for (const argv of bad) assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));
  assert.deepEqual(parseArgs([]), { cmd: 'help' });
  assert.deepEqual(parseArgs(['run', '-h']), { cmd: 'help' });
});

