import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeAuditStore, type AuditAdmission } from './audit.js';

const owner = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
const admission = (id: string): AuditAdmission => ({ admissionId: id, actionId: `action-${id}`, parentActionId: null,
  clientId: 'client', grantId: 'grant', endpointId: 'endpoint', tool: 'sessions_get', operation: 'sessions_get', sessionId: 'session', mutating: false });
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('admission is durable, duplicate-correlated, metadata-only, and unfinished outcomes become unknown on restart', async t => {
  const dir = await directory(t);
  const store = new BridgeAuditStore(dir, owner, 'bridge');
  const sensitive = 'secret raw prompt /Users/private token=supersecret';
  const { event, isNew } = await store.admit({ ...admission('request'), tool: sensitive, operation: sensitive, args: sensitive } as AuditAdmission);
  assert.equal(isNew, true);
  assert.equal(event.tool, 'invalid_tool');
  assert.equal(event.operation, null);
  assert.equal((await stat(join(dir, 'security', 'activity.json'))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(join(dir, 'security', 'activity.json'), 'utf8')).includes(sensitive));
  assert.equal((await store.admit({ ...admission('request'), tool: sensitive, operation: sensitive })).isNew, false);
  await assert.rejects(store.admit({ ...admission('request'), tool: sensitive, operation: sensitive, mutating: true }), { code: 'replayed' });
  await store.close();
  const restarted = new BridgeAuditStore(dir, owner, 'bridge');
  const records = await restarted.list();
  assert.equal(records.events.length, 1);
  assert.equal(records.events[0].status, 'unknown');
  assert.equal(records.events[0].errorCode, 'interrupted');
  assert.ok(records.events[0].finishedAt);
});

test('stable newest-first cursors exclude later inserts and are bound to owner/bridge', async t => {
  const dir = await directory(t);
  const store = new BridgeAuditStore(dir, owner, 'bridge');
  for (const id of ['one', 'two', 'three']) await store.admit(admission(id));
  const first = await store.list({ limit: 2 });
  assert.deepEqual(first.events.map(event => event.actionId), ['action-three', 'action-two']);
  assert.ok(first.nextCursor);
  await store.admit(admission('four'));
  const second = await store.list({ limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(second.events.map(event => event.actionId), ['action-one']);
  assert.equal(second.nextCursor, null);
  const wrongOwner = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
  wrongOwner.ownerId = 'another-owner';
  await assert.rejects(store.list({ cursor: Buffer.from(JSON.stringify(wrongOwner)).toString('base64url') }), { code: 'invalid_cursor' });
  await assert.rejects(store.list({ bridgeId: 'another-bridge' }), { code: 'wrong_context' });
  await assert.rejects(store.list({ limit: 101 }), { code: 'invalid_cursor' });
});

test('retention and count caps signal truncation/reset; arbitrary error text is never persisted', async t => {
  const dir = await directory(t);
  let now = Date.now();
  const store = new BridgeAuditStore(dir, owner, 'bridge', { now: () => now, maxEvents: 3 });
  const first = await store.admit(admission('one'));
  await store.finish(first.event.id, 'failed', 'Secret stack trace');
  for (const id of ['two', 'three']) {
    const admitted = await store.admit(admission(id)); await store.finish(admitted.event.id, 'succeeded');
  }
  const page = await store.list({ limit: 2 });
  const fourth = await store.admit(admission('four')); await store.finish(fourth.event.id, 'succeeded');
  const reset = await store.list({ cursor: page.nextCursor! });
  assert.equal(reset.truncated, true);
  assert.equal(reset.reset, true);
  assert.equal(reset.events.length, 3);
  assert.ok(!(await readFile(join(dir, 'security', 'activity.json'), 'utf8')).includes('Secret stack trace'));
  now += 31 * 86_400_000;
  const expired = await store.list();
  assert.deepEqual(expired.events, []);
  assert.equal(expired.oldestAvailableAt, null);
  assert.equal(expired.truncated, true);
});

test('live admissions survive age and count pruning, and exhausted live capacity rejects before another admission', async t => {
  const dir = await directory(t);
  let now = Date.now();
  const store = new BridgeAuditStore(dir, owner, 'bridge', { now: () => now, maxEvents: 2 });
  const held = await store.admit({ ...admission('held-mutation'), mutating: true });
  const old = await store.admit(admission('old-read')); await store.finish(old.event.id, 'succeeded');
  now += 31 * 86_400_000;
  const retained = await store.list();
  assert.deepEqual(retained.events.map(event => [event.actionId, event.status]), [['action-held-mutation', 'started']]);
  assert.equal(retained.truncated, true);
  const second = await store.admit(admission('second-live'));
  await assert.rejects(store.admit(admission('cannot-start')), { code: 'audit_unavailable' });
  assert.equal((await store.list()).events.length, 2);
  assert.equal((await store.finish(held.event.id, 'succeeded')).status, 'succeeded', 'the original mutation can still durably finish');
  const next = await store.admit(admission('next-read'));
  assert.deepEqual((await store.list()).events.map(event => event.id), [next.event.id, second.event.id]);
});

test('count pressure evicts finished reads before an older current-run mutation', async t => {
  const dir = await directory(t);
  const store = new BridgeAuditStore(dir, owner, 'bridge', { maxEvents: 2 });
  const held = await store.admit({ ...admission('held'), mutating: true });
  for (const id of ['read-one', 'read-two', 'read-three']) {
    const read = await store.admit(admission(id)); await store.finish(read.event.id, 'succeeded');
  }
  assert.deepEqual((await store.list()).events.map(event => event.actionId), ['action-read-three', 'action-held']);
  assert.equal((await store.finish(held.event.id, 'succeeded')).status, 'succeeded');
});

test('stable paging crosses previously pruned holes to reach an old live admission', async t => {
  const dir = await directory(t);
  const store = new BridgeAuditStore(dir, owner, 'bridge', { maxEvents: 3 });
  await store.admit({ ...admission('held'), mutating: true });
  for (const id of ['one', 'two', 'three', 'four']) {
    const read = await store.admit(admission(id)); await store.finish(read.event.id, 'succeeded');
  }
  const first = await store.list({ limit: 1 });
  const second = await store.list({ limit: 1, cursor: first.nextCursor! });
  const third = await store.list({ limit: 1, cursor: second.nextCursor! });
  assert.deepEqual([first, second, third].map(page => page.events[0].actionId), ['action-four', 'action-three', 'action-held']);
  assert.equal(second.reset, false); assert.equal(third.reset, false); assert.equal(third.nextCursor, null);
});

test('unwritable/corrupt audit cannot admit an operation and never silently resets existing evidence', async t => {
  const dir = await directory(t);
  const store = new BridgeAuditStore(dir, owner, 'bridge');
  await store.admit(admission('one'));
  const file = join(dir, 'security', 'activity.json');
  await writeFile(file, '{broken');
  await assert.rejects(store.admit(admission('two')), { code: 'audit_unavailable' });
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await assert.rejects(store.list(), { code: 'audit_unavailable' });
});
