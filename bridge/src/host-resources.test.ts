import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
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

test('returns a validated owner reading and keeps unavailable capacity unknown', async () => {
  const resources = await hostResourceSampler(tmpdir())();
  const response = (bridgeId: string) => ({ http: async () => ({ status: 200, body: { bridgeId, resources } }) });
  assert.deepEqual(await peerResources(response('a'), 'a'), resources);
  assert.equal(await peerResources(response('b'), 'a'), null);
  assert.equal(await peerResources({ http: async () => { throw new Error('offline'); } }, 'a'), null);
});
