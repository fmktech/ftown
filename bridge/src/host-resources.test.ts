import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { hostResourceSampler } from './host-resources.js';

test('coalesces reads and reports machine memory and space on the requested volume', async () => {
  const sample = hostResourceSampler(tmpdir());
  const pending = sample();
  assert.equal(sample(), pending);
  const stats = await pending;
  assert.ok(stats.cpuPercent === null || (stats.cpuPercent >= 0 && stats.cpuPercent <= 100));
  assert.ok(stats.freeRamBytes >= 0 && stats.totalRamBytes >= stats.freeRamBytes);
  assert.ok(stats.freeDiskBytes !== null && stats.freeDiskBytes >= 0);
});
