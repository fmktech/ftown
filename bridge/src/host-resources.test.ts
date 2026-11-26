import assert from 'node:assert/strict';
import { test } from 'node:test';
import os, { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { hostResourceSampler, peerResources } from './host-resources.js';

test('coalesces reads and reports machine memory and space on the requested volume', async () => {
  const sample = hostResourceSampler(tmpdir());
  const pending = sample();
  assert.equal(sample(), pending);
  const stats = await pending;
  assert.ok(stats.cpuPercent === null || (stats.cpuPercent >= 0 && stats.cpuPercent <= 100));
  assert.ok(stats.freeRamBytes >= 0 && stats.totalRamBytes >= stats.freeRamBytes);
  assert.ok(stats.freeDiskBytes !== null && stats.freeDiskBytes >= 0);
});

test('macOS reports an available RAM estimate and kernel pressure independently', async t => {
  const vmStat = (pageSize: number) => `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)
Pages free:                                   5.
Pages active:                              1000.
Pages inactive:                              37.
Pages speculative:                            8.
Pages purgeable:                             12.
File-backed pages:                          479.`;
  const unavailable = new Error('not supported');
  let pressure: string | Error;
  let vm: string | Error;
  t.mock.method(os, 'platform', () => 'darwin');
  t.mock.method(os, 'freemem', () => 13 * 4096);
  t.mock.method(os, 'totalmem', () => 2 ** 30);
  t.mock.method(childProcess, 'execFile', (file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
    const isVmStat = file === '/usr/bin/vm_stat';
    if (!isVmStat) assert.equal(file, '/usr/sbin/sysctl');
    assert.deepEqual(args, isVmStat ? [] : ['-n', 'kern.memorystatus_vm_pressure_level']);
    const reply = isVmStat ? vm : pressure;
    if (reply instanceof Error) done(reply, '');
    else done(null, reply);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const [vmOutput, pressureOutput, expectedBytes, expectedPressure] of [
    [vmStat(16384), '1\n', 819200, 'normal'],
    [vmStat(4096), '2\n', 204800, 'warning'],
    [unavailable, '4\n', undefined, 'critical'],
    [vmStat(4096), unavailable, 204800, undefined],
    [vmStat(4096).replace('Pages speculative:', 'Missing:'), '3\n', undefined, undefined],
    [vmStat(0), '1\n', undefined, 'normal'],
    [vmStat(4096).replace('37.', '500000.'), '1\n', undefined, 'normal'],
  ] as const) {
    vm = vmOutput;
    pressure = pressureOutput;
    const stats = await hostResourceSampler(tmpdir())();
    assert.equal(stats.availableRamBytes, expectedBytes);
    assert.equal(stats.memoryPressure, expectedPressure);
    assert.equal(stats.freeRamBytes, 53248);
  }
});

test('returns a validated owner reading and keeps unavailable capacity unknown', async () => {
  const resources = { sampledAt: 100, cpuPercent: 50, freeRamBytes: 10, totalRamBytes: 100, freeDiskBytes: 1000 };
  const response = (bridgeId: string, extras = {}) => ({ http: async () => ({ status: 200, body: { bridgeId, resources: { ...resources, ...extras } } }) });
  assert.deepEqual(await peerResources(response('a'), 'a'), resources);
  for (const memoryPressure of ['normal', 'warning', 'critical']) {
    assert.deepEqual(await peerResources(response('a', { memoryPressure }), 'a'), { ...resources, memoryPressure });
  }
  const withCapacity = await peerResources(response('a', { availableRamBytes: 90 }), 'a');
  assert.equal(withCapacity?.availableRamBytes, 90);
  const futureReport = await peerResources(response('a', { memoryPressure: 'unrecognized', availableRamBytes: 101 }), 'a');
  assert.equal(futureReport?.availableRamBytes, undefined);
  assert.equal(futureReport?.memoryPressure, undefined);
  assert.equal(futureReport?.totalRamBytes, resources.totalRamBytes);
  assert.equal(await peerResources(response('b'), 'a'), null);
  assert.equal(await peerResources({ http: async () => { throw new Error('offline'); } }, 'a'), null);
});
