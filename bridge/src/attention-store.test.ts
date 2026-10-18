import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AttentionStore, AttentionError } from './attention-store.js';

const notice = (message = 'Approve this command?', extra: Record<string, unknown> = {}) => ({ notification_type: 'permission_prompt', message, ...extra });
async function fixture(t: { after: (fn: () => Promise<void>) => void }, retention = 500) {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-attention-unit-'));
  await mkdir(join(dir, 's1')); await mkdir(join(dir, 's2'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, resolve: (id: string) => join(dir, id), store: new AttentionStore((id) => join(dir, id), retention) };
}

test('durability, source/fingerprint dedup, recurrence and immutable creation cursor', async (t) => {
  const f = await fixture(t);
  const start = await f.store.list('s1');
  await f.store.record('s1', 'Notification', notice());
  await f.store.record('s1', 'Notification', notice());
  const first = await f.store.list('s1');
  assert.equal(first.events.length, 1); assert.equal(first.events[0].occurrences, 2);
  assert.equal(first.events[0].sequence, 1);
  const restarted = new AttentionStore(f.resolve);
  assert.deepEqual((await restarted.list('s1')).events, first.events);
  assert.equal((await stat(join(f.dir, 's1/attention.json'))).mode & 0o777, 0o600);
  await restarted.mutate('s1', [first.events[0].id], 'ack');
  assert.equal((await restarted.list('s1', { cursor: first.cursor })).events.length, 0);
  const acked = await restarted.list('s1');
  assert.ok(acked.events[0].acknowledgedAt);
  await restarted.mutate('s1', [first.events[0].id], 'resolve');
  await restarted.record('s1', 'Notification', notice());
  const later = await restarted.list('s1', { cursor: first.cursor });
  assert.equal(later.events.length, 1); assert.equal(later.events[0].sequence, 2);
  assert.notEqual(later.events[0].id, first.events[0].id);
  assert.equal((await restarted.list('s1', { cursor: start.cursor })).events.length, 1);
  await restarted.record('s1', 'Notification', notice('different', { notification_id: 'native-123' }));
  await new AttentionStore(f.resolve).record('s1', 'Notification', notice('retry changed text', { notification_id: 'native-123' }));
  const source = (await restarted.list('s1')).events.find((event) => event.message === 'different');
  assert.equal(source?.occurrences, 2);
  assert.ok(!(await readFile(join(f.dir, 's1/attention.json'), 'utf8')).includes('native-123'));
});

test('ack/resolve validate every ID atomically and retry without changing timestamps', async (t) => {
  const { store } = await fixture(t);
  await store.record('s1', 'Notification', notice());
  const event = (await store.list('s1')).events[0];
  await assert.rejects(store.mutate('s1', [event.id, 'unknown'], 'ack'), (e: unknown) => e instanceof AttentionError && e.code === 'unknown_attention');
  assert.equal((await store.list('s1')).events[0].acknowledgedAt, undefined);
  const [acked] = await store.mutate('s1', [event.id], 'ack');
  await delay(3);
  assert.equal((await store.mutate('s1', [event.id], 'ack'))[0].acknowledgedAt, acked.acknowledgedAt);
  const [resolved] = await store.mutate('s1', [event.id], 'resolve', 'API_KEY=hidden');
  await delay(3);
  assert.equal((await store.mutate('s1', [event.id], 'resolve'))[0].resolvedAt, resolved.resolvedAt);
  assert.equal((await store.list('s1')).events.length, 0);
  assert.equal((await store.list('s1', { includeResolved: true })).events[0].resolution, 'manual');
});

test('pagination never skips omitted events; pruning and ledger reset are visible', async (t) => {
  const { store, dir } = await fixture(t, 1);
  const start = await store.list('s1');
  for (let n = 0; n < 5; n++) await store.record('s1', 'Notification', notice(`question-${n}`));
  const first = await store.list('s1', { limit: 2 });
  assert.equal(first.hasMore, true); assert.deepEqual(first.events.map((event) => event.sequence), [1, 2]);
  const second = await store.list('s1', { cursor: first.cursor, limit: 2 });
  assert.deepEqual(second.events.map((event) => event.sequence), [3, 4]);
  const third = await store.list('s1', { cursor: second.cursor, limit: 2 });
  assert.deepEqual(third.events.map((event) => event.sequence), [5]);
  await store.mutate('s1', first.events.map((event) => event.id), 'resolve');
  assert.equal((await store.list('s1', { cursor: start.cursor })).cursorReset, true);
  assert.equal((await store.list('s1')).openCount, 3);
  await assert.rejects(store.list('s2', { cursor: first.cursor }), /another session/);
  await assert.rejects(store.list('s1', { cursor: 'garbage' }), /malformed/);
  await unlink(join(dir, 's1/attention.json'));
  assert.equal((await store.list('s1', { cursor: third.cursor })).cursorReset, true);
});

test('wait wakes only on eligible creation, survives the read/listener race and cleans up cancellation', async (t) => {
  const { store } = await fixture(t);
  const initial = await store.list('s1');
  const waiting = store.wait('s1', { cursor: initial.cursor }, 1);
  await store.record('s1', 'Notification', notice());
  const page = await waiting;
  assert.equal(page.events.length, 1);
  const controller = new AbortController();
  let completed = false;
  const next = store.wait('s1', { cursor: page.cursor }, 1, controller.signal).finally(() => { completed = true; });
  await store.record('s1', 'Notification', notice());
  await store.mutate('s1', [page.events[0].id], 'ack');
  await store.record('s1', 'PostToolUse', { tool_name: 'Read' });
  await delay(20); assert.equal(completed, false);
  controller.abort();
  await assert.rejects(next, /cancelled/);
  assert.equal((await store.wait('s1', {}, 0)).events.length, 0, 'acknowledged requests are not fresh wait matches');
  await store.record('s1', 'Notification', notice('new distinct question'));
  assert.equal((await store.wait('s1', { cursor: page.cursor }, 0)).events[0].message, 'new distinct question');
});

test('only explicit continuation resolves; storage failure cannot report durable success', async (t) => {
  const { store, resolve } = await fixture(t);
  await store.record('s1', 'Notification', notice());
  await store.record('s1', 'Notification', { notification_type: 'elicitation_dialog', message: 'which?' });
  await store.record('s1', 'PostToolUse', {}); await store.record('s1', 'Stop', {});
  assert.equal((await store.list('s1')).events.length, 2);
  await store.record('s1', 'Notification', { notification_type: 'elicitation_complete' });
  assert.equal((await store.list('s1')).events.length, 1);
  await store.record('s1', 'UserPromptSubmit', {});
  assert.equal((await store.list('s1')).events.length, 0);
  await assert.rejects(new AttentionStore(resolve).record('missing', 'Notification', notice()), (e: unknown) => e instanceof AttentionError && e.code === 'attention_storage_error');
});


test('notifications follow committed distinct questions and observed busy-to-idle only', async (t) => {
  const f = await fixture(t);
  const emitted: { session: string; notice: import('./push-notifier.js').PushNotice }[] = [];
  const store = new AttentionStore(f.resolve, 500, (session, notice) => { emitted.push({ session, notice }); });
  await store.record('s1', 'Stop', {});
  assert.equal(emitted.length, 0, 'initial idle never notifies');
  await store.record('s1', 'UserPromptSubmit', {});
  await store.record('s1', 'Stop', {});
  await store.record('s1', 'Stop', {});
  assert.deepEqual(emitted.map(({notice}) => notice.eventKey), ['idle']);
  await store.record('s1', 'Notification', notice('choose', {notification_id:'q'}));
  await store.record('s1', 'Notification', notice('choose', {notification_id:'q'}));
  const attention = (await store.list('s1')).events[0];
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].notice.eventKey, `question:${attention.id}`);
  assert.equal(emitted[1].notice.occurredAt, attention.createdAt);
  const throwing = new AttentionStore(f.resolve, 500, () => { throw new Error('observer'); });
  await throwing.record('s1', 'Notification', notice('another'));
  assert.equal((await throwing.list('s1')).events.length, 2, 'observer failure cannot undo committed attention');
});
