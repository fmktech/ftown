import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qemuArgs } from './qemu.ts';

test('qemu command line is hermetic and deterministic', () => {
  const a = qemuArgs({ cmd: 'run', seed: 7, level: 'high', memMb: 3072, icountShift: 1 });
  const s = a.join(' ');
  assert.equal(a[0], 'qemu-system-x86_64');
  for (const must of ['-nic none', '-nodefaults', '-no-reboot', 'tcg,thread=single', '-smp 1', '-m 3072M',
    'Nehalem,-rdrand,-rdseed', 'shift=1,sleep=off,align=off', 'base=2026-01-01T00:00:00,clock=vm',
    'chaos.cmd=run', 'chaos.seed=7', 'chaos.level=high', 'random.trust_cpu=off']) assert.ok(s.includes(must), must);
  assert.ok(!/virtio-rng|-qmp|-monitor|-netdev|localtime/.test(s));
  assert.deepEqual(a, qemuArgs({ cmd: 'run', seed: 7, level: 'high', memMb: 3072, icountShift: 1 }));
  assert.equal(a.filter((x) => x === '-serial').length, 2);
});
