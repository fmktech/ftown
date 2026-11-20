import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { startPeerSessionCache } from './peer-session-cache.js';

it('remembers the last peer status across restart and clears it on an empty owner snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-projects-'));
  const path = join(dir, 'cache.json');
  const peer = { bridgeId: 'b', endpointId: 'key-b', label: 'B', approvedAt: 'today' };
  const row = { id: 'child', bridgeId: 'b', name: 'child', parentSessionId: 'root', projectName: 'Shared',
    status: 'running', createdAt: 'yesterday', updatedAt: 'today' };
  let online = true;
  let rows = [row];
  const peers = { list: async () => [peer], http: async () => {
    if (!online) throw new Error('offline');
    return { status: 200, body: { sessions: rows } };
  } };
  let cache = await startPeerSessionCache(peers, path);
  try {
    await cache.refresh();
    await cache.stop();
    online = false;
    cache = await startPeerSessionCache(peers, path);
    await cache.refresh();
    assert.deepEqual(await cache.list(), [row]);
    online = true;
    rows = [];
    await cache.refresh();
    assert.deepEqual(await cache.list(), []);
  } finally {
    await cache.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

it('discards a foreign snapshot and revoked peers, and coalesces overlapping reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-peer-cache-'));
  const peer = { bridgeId: 'b', endpointId: 'key-b', label: 'B', approvedAt: 'today' };
  let approved = [peer];
  let owner = 'b';
  let calls = 0;
  const cache = await startPeerSessionCache({ list: async () => approved, http: async () => {
    calls++;
    return { status: 200, body: { sessions: [{ id: 'child', name: 'Child', bridgeId: owner, status: 'completed', createdAt: '1', updatedAt: '2' }] } };
  } }, join(dir, 'cache.json'));
  try {
    await Promise.all([cache.refresh(), cache.refresh()]);
    assert.equal(calls, 1);
    assert.equal((await cache.list()).length, 1);
    owner = 'wrong';
    await cache.refresh();
    assert.deepEqual(await cache.list(), []);
    owner = 'b';
    await cache.refresh();
    approved = [];
    assert.deepEqual(await cache.list(), []);
    await cache.refresh();
    approved = [peer];
    assert.deepEqual(await cache.list(), []);
  } finally {
    await cache.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
