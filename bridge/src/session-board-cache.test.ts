import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createSessionBoardCache } from './session-board-cache.js';
import type { BoardSnapshot } from './coordination/contract-c.js';
import { PLAN_LIMITS } from './coordination/contract-c.js';
import { SESSION_BOARD_CACHE_TTL_MS, SESSION_BOARD_CHUNK_BYTES, SESSION_BOARD_MAX_BYTES, type SessionBoardManifest } from './session-board-protocol.js';

function snapshot(characters = 0): BoardSnapshot {
  return { board: { rootId: 'root', cursor: 0, cards: [], rollup: { working: 0, blocked: 0, waiting_review: 0, done: 0, failed: 0, unset: 0 } },
    events: characters ? [{ seq: 1, ts: '', sessionId: 'child', sessionName: 'child', kind: 'status', summary: '界'.repeat(characters) }] : [], attention: [] };
}
export function maximumPlanSnapshot(): BoardSnapshot {
  const data = snapshot();
  data.board.plan = { ready: [], items: Array.from({ length: PLAN_LIMITS.items }, (_, n) => ({ id: `p${n + 1}`,
    title: '界'.repeat(PLAN_LIMITS.title), note: '界'.repeat(PLAN_LIMITS.note), after: [], priority: 2, state: 'todo', createdAt: '', updatedAt: '' })) };
  return data;
}
const manifest = (value: unknown): SessionBoardManifest => {
  assert.equal((value as SessionBoardManifest).type, 'session_board_chunks');
  return value as SessionBoardManifest;
};

test('small snapshots keep the existing response and legitimate maximum plans reassemble losslessly', () => {
  const cache = createSessionBoardCache();
  const small = snapshot(); assert.equal(cache.store('principal', small), small);
  const original = maximumPlanSnapshot(); const bytes = Buffer.from(JSON.stringify(original));
  const result = manifest(cache.store('principal', original));
  assert.equal(result.snapshotId, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.totalBytes, bytes.length);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < result.totalBytes; offset += SESSION_BOARD_CHUNK_BYTES) {
    const chunk = cache.chunk('principal', result.snapshotId, offset);
    assert.equal(chunk.offset, offset); assert.equal(chunk.rootId, 'root'); assert.equal(chunk.totalBytes, bytes.length);
    const next = Buffer.from(chunk.data, 'base64'); assert.ok(next.length <= SESSION_BOARD_CHUNK_BYTES); chunks.push(next);
  }
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), original);
});

test('cached bytes are immutable and scoped to authenticated principal, bridge and requested session', () => {
  const cache = createSessionBoardCache(); const original = maximumPlanSnapshot();
  const scope = JSON.stringify(['principal', 'bridge', 'root']);
  const result = manifest(cache.store(scope, original));
  const first = cache.chunk(scope, result.snapshotId, 0);
  original.board.plan!.items[0].title = 'mutated';
  assert.deepEqual(cache.chunk(scope, result.snapshotId, 0), first);
  for (const other of [['other', 'bridge', 'root'], ['principal', 'other', 'root'], ['principal', 'bridge', 'child']]) {
    assert.throws(() => cache.chunk(JSON.stringify(other), result.snapshotId, 0), { code: 'session_board_snapshot_unavailable', status: 404 });
  }
});

test('chunks enforce SHA, safe aligned offsets, missing snapshots and fixed expiry', () => {
  let now = 0; const cache = createSessionBoardCache(() => now);
  const result = manifest(cache.store('scope', maximumPlanSnapshot()));
  for (const offset of [-1, 1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => cache.chunk('scope', result.snapshotId, offset), { code: 'invalid_session_board_request', status: 400 });
  }
  assert.throws(() => cache.chunk('scope', result.snapshotId.toUpperCase(), 0), { code: 'invalid_session_board_request' });
  assert.throws(() => cache.chunk('scope', '0'.repeat(64), 0), { code: 'session_board_snapshot_unavailable' });
  assert.throws(() => cache.chunk('scope', result.snapshotId, Math.ceil(result.totalBytes / SESSION_BOARD_CHUNK_BYTES) * SESSION_BOARD_CHUNK_BYTES), { code: 'session_board_snapshot_unavailable' });
  now = SESSION_BOARD_CACHE_TTL_MS - 1; cache.chunk('scope', result.snapshotId, 0);
  now += 1; assert.throws(() => cache.chunk('scope', result.snapshotId, 0), { code: 'session_board_snapshot_unavailable', status: 404 });
});

test('combined retained bytes and entry count are bounded with oldest snapshot eviction', () => {
  const cache = createSessionBoardCache();
  const large = snapshot(2_000_000); // 6 MiB per immutable snapshot
  const one = manifest(cache.store('one', large));
  cache.store('two', large); cache.store('three', large);
  assert.throws(() => cache.chunk('one', one.snapshotId, 0), { code: 'session_board_snapshot_unavailable' });
  const smallCache = createSessionBoardCache(); const first = manifest(smallCache.store('0', maximumPlanSnapshot()));
  for (let n = 1; n < 5; n++) smallCache.store(String(n), maximumPlanSnapshot());
  assert.throws(() => smallCache.chunk('0', first.snapshotId, 0), { code: 'session_board_snapshot_unavailable' });
});

test('snapshots above the maximum fail explicitly without evicting valid data', () => {
  const cache = createSessionBoardCache(); const valid = manifest(cache.store('scope', maximumPlanSnapshot()));
  assert.throws(() => cache.store('large', snapshot(Math.ceil(SESSION_BOARD_MAX_BYTES / 3))), { code: 'session_board_snapshot_too_large', status: 413 });
  assert.ok(cache.chunk('scope', valid.snapshotId, 0).data);
});
