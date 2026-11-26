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

test('macOS reports kernel pressure levels alongside bytes and keeps capacity when the probe is unavailable', async t => {
  let reply: string | Error = '';
  t.mock.method(os, 'platform', () => 'darwin');
  t.mock.method(childProcess, 'execFile', (file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
    assert.equal(file, '/usr/sbin/sysctl');
    assert.deepEqual(args, ['-n', 'kern.memorystatus_vm_pressure_level']);
    if (reply instanceof Error) done(reply, '');
    else done(null, reply);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const [output, expected] of [
    ['1\n', 'normal'], ['2\n', 'warning'], ['4\n', 'critical'], ['3\n', undefined], [new Error('unsupported'), undefined],
  ] as const) {
    reply = output;
    const stats = await hostResourceSampler(tmpdir())();
    assert.equal(stats.memoryPressure, expected);
    assert.ok(stats.totalRamBytes > 0);
  }
});

test('returns a validated owner reading and keeps unavailable capacity unknown', async () => {
  const resources = { sampledAt: 100, cpuPercent: 50, freeRamBytes: 10, totalRamBytes: 100, freeDiskBytes: 1000 };
  const response = (bridgeId: string, extras = {}) => ({ http: async () => ({ status: 200, body: { bridgeId, resources: { ...resources, ...extras } } }) });
  assert.deepEqual(await peerResources(response('a'), 'a'), resources);
  for (const memoryPressure of ['normal', 'warning', 'critical']) {
    assert.deepEqual(await peerResources(response('a', { memoryPressure }), 'a'), { ...resources, memoryPressure });
  }
  const futureReport = await peerResources(response('a', { memoryPressure: 'unrecognized' }), 'a');
  assert.equal(futureReport?.memoryPressure, undefined);
  assert.equal(futureReport?.totalRamBytes, resources.totalRamBytes);
  assert.equal(await peerResources(response('b'), 'a'), null);
  assert.equal(await peerResources({ http: async () => { throw new Error('offline'); } }, 'a'), null);
});
