import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AttentionStore, AttentionError, IDLE_NOTIFICATION_DELAY_MS, type AttentionNotificationOptions } from './attention-store.js';

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


function clock() {
  let now = Date.parse('2026-10-18T12:00:00.000Z');
  const tasks = new Map<ReturnType<typeof setTimeout>, { at: number; fn: () => void }>();
  const options = { now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const token = { unref() {} } as ReturnType<typeof setTimeout>;
      tasks.set(token, { at: now + ms, fn }); return token;
    }, cancel: (token: ReturnType<typeof setTimeout>) => { tasks.delete(token); } };
  return { options, tasks, advance(ms: number) {
    now += ms;
    for (const [token, task] of [...tasks]) if (task.at <= now) { tasks.delete(token); task.fn(); }
  } };
}
async function notifications(t: Parameters<typeof fixture>[0], extra: AttentionNotificationOptions = {}) {
  const f = await fixture(t); const time = clock();
  const emitted: import('./push-notifier.js').PushNotice[] = [];
  const store = new AttentionStore(f.resolve, 500, (_id, event) => { emitted.push(event); }, { ...time.options, ...extra });
  t.after(async () => { store.stopNotifications(); });
  const advance = async (ms: number) => { time.advance(ms); await store.list('s1'); };
  return { ...f, time, store, emitted, advance,
    ledger: async () => JSON.parse(await readFile(join(f.dir, 's1/attention.json'), 'utf8')) };
}
async function becomeIdle(store: AttentionStore) {
  await store.record('s1', 'UserPromptSubmit', {}); await store.record('s1', 'Stop', {});
}
test('idle waits ten uninterrupted minutes, repeats do not reset, and a new busy period rearms', async (t) => {
  const f = await notifications(t);
  await f.store.record('s1', 'Stop', {}); await f.advance(IDLE_NOTIFICATION_DELAY_MS);
  assert.equal(f.emitted.length, 0, 'initial idle never arms');
  await becomeIdle(f.store); const original = (await f.ledger()).idleCycle;
  await f.advance(599_999); assert.equal(f.emitted.length, 0);
  await f.store.record('s1', 'Stop', {});
  assert.deepEqual((await f.ledger()).idleCycle, original, 'repeated idle preserves UUID and deadline');
  await f.advance(1); assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0].eventKey, `idle:${original.id}`);
  assert.equal(f.emitted[0].occurredAt, new Date(f.time.options.now()).toISOString());
  assert.equal((await f.ledger()).idleCycle.notifiedAt, f.emitted[0].occurredAt);
  await f.store.record('s1', 'Stop', {}); await f.advance(1_200_000);
  assert.equal(f.emitted.length, 1, 'one alert per continuous idle period');
  await becomeIdle(f.store); const next = (await f.ledger()).idleCycle;
  assert.notEqual(next.id, original.id);
  await f.advance(599_999); assert.equal(f.emitted.length, 1);
  await f.advance(1); assert.equal(f.emitted[1].eventKey, `idle:${next.id}`);
});
test('questions remain immediate and committed/deduplicated while idle is delayed', async (t) => {
  const f = await notifications(t); await becomeIdle(f.store);
  await f.store.record('s1', 'Notification', notice('choose', { notification_id: 'q' }));
  await f.store.record('s1', 'Notification', notice('choose', { notification_id: 'q' }));
  const event = (await f.store.list('s1')).events[0];
  assert.equal(f.emitted.length, 1); assert.equal(f.emitted[0].eventKey, `question:${event.id}`);
  assert.equal(f.emitted[0].occurredAt, event.createdAt);
  const throwing = new AttentionStore(f.resolve, 500, () => { throw new Error('observer'); });
  t.after(async () => { throwing.stopNotifications(); });
  await throwing.record('s1', 'Notification', notice('another'));
  assert.equal((await throwing.list('s1')).events.length, 2);
});
test('busy, session end, deletion and shutdown cancel idle without reviving deleted sessions', async (t) => {
  const canceled: string[] = [];
  const f = await notifications(t, { onIdleCanceled: id => { canceled.push(id); } });
  for (const event of ['PreToolUse', 'UserPromptSubmit', 'SessionEnd']) {
    await becomeIdle(f.store); await f.advance(599_999);
    await f.store.record('s1', event, {}); await f.advance(1);
    assert.equal((await f.ledger()).idleCycle, undefined, event);
  }
  await becomeIdle(f.store); await f.store.cancelIdleNotification('s1'); await f.advance(600_000);
  assert.equal((await f.ledger()).idleCycle, undefined);
  await becomeIdle(f.store); f.store.stopNotifications(); await f.advance(600_000);
  assert.equal(f.emitted.length, 0); assert.equal(f.time.tasks.size, 0); assert.ok(canceled.length >= 4);
  const deleted = await notifications(t);
  await becomeIdle(deleted.store); await rm(join(deleted.dir, 's1'), { recursive: true });
  await assert.rejects(deleted.store.cancelIdleNotification('s1'), /persisted/);
  await assert.rejects(stat(join(deleted.dir, 's1')), { code: 'ENOENT' });
});
test('restores only persisted pending cycles, preserving identity/deadline and not replaying notified or legacy idle', async (t) => {
  const f = await notifications(t); await becomeIdle(f.store);
  const cycle = (await f.ledger()).idleCycle; f.store.stopNotifications(); f.time.advance(300_000);
  const restored = new AttentionStore(f.resolve, 500, (_id, event) => { f.emitted.push(event); }, f.time.options);
  t.after(async () => { restored.stopNotifications(); });
  await restored.restoreIdleNotifications(['s1']); f.time.advance(299_999); await restored.list('s1');
  assert.equal(f.emitted.length, 0); f.time.advance(1); await restored.list('s1');
  assert.equal(f.emitted[0].eventKey, `idle:${cycle.id}`);
  restored.stopNotifications();
  const again = new AttentionStore(f.resolve, 500, (_id, event) => { f.emitted.push(event); }, f.time.options);
  t.after(async () => { again.stopNotifications(); });
  await again.restoreIdleNotifications(['s1']); f.time.advance(600_000); await again.list('s1');
  assert.equal(f.emitted.length, 1);
  await again.record('s2', 'Stop', {}); await again.restoreIdleNotifications(['s2']);
  f.time.advance(600_000); await again.list('s2'); assert.equal(f.emitted.length, 1, 'legacy idle has no inferred cycle');
});
test('overdue persisted cycles emit once, while inactive sessions lose pending cycles', async (t) => {
  for (const active of [true, false]) {
    const f = await notifications(t); await becomeIdle(f.store); f.store.stopNotifications(); f.time.advance(900_000);
    const restored = new AttentionStore(f.resolve, 500, (_id, event) => { f.emitted.push(event); }, { ...f.time.options, isSessionActive: async () => active });
    t.after(async () => { restored.stopNotifications(); });
    await restored.restoreIdleNotifications(['s1']); f.time.advance(0); await restored.list('s1');
    assert.equal(f.emitted.length, active ? 1 : 0);
    assert.equal(!!(await f.ledger()).idleCycle, active);
  }
});
test('resumed activity fences a timer awaiting live registry eligibility', async (t) => {
  let release!: (active: boolean) => void; let entered!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const f = await notifications(t, { isSessionActive: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  await becomeIdle(f.store); f.time.advance(600_000); await checking;
  const resumed = f.store.record('s1', 'PreToolUse', {});
  release(true); await resumed;
  assert.equal(f.emitted.length, 0); assert.equal((await f.ledger()).idleCycle, undefined);
});

test('concurrent idle/resume/idle preserves only the newest timer and explicit cancellation clears a queued arm', async (t) => {
  const f = await notifications(t);
  await f.store.record('s1', 'UserPromptSubmit', {});
  await Promise.all([f.store.record('s1', 'Stop', {}), f.store.record('s1', 'PreToolUse', {}), f.store.record('s1', 'Stop', {})]);
  const cycle = (await f.ledger()).idleCycle;
  assert.equal(f.time.tasks.size, 1);
  await f.advance(600_000); assert.equal(f.emitted[0].eventKey, `idle:${cycle.id}`);
  await f.store.record('s1', 'UserPromptSubmit', {});
  await Promise.all([f.store.record('s1', 'Stop', {}), f.store.cancelIdleNotification('s1')]);
  assert.equal(f.time.tasks.size, 0); assert.equal((await f.ledger()).idleCycle, undefined);
});
test('one unreadable recovery ledger cannot block another pending cycle or manufacture recovered history', async (t) => {
  const f = await notifications(t); await becomeIdle(f.store); f.store.stopNotifications();
  const broken = join(f.dir, 's2/attention.json'); const contents = '{"version":1,"idleCycle":{"id":"malformed"}}';
  await writeFile(broken, contents);
  const recovered = new AttentionStore(f.resolve, 500, (_id, event) => { f.emitted.push(event); }, f.time.options);
  t.after(async () => { recovered.stopNotifications(); });
  await recovered.restoreIdleNotifications(['s2', 'missing', 's1']);
  assert.equal(await readFile(broken, 'utf8'), contents);
  await assert.rejects(recovered.list('s2'), /could not be read/);
  await assert.rejects(stat(join(f.dir, 'missing')), { code:'ENOENT' });
  f.time.advance(600_000); await recovered.list('s1'); assert.equal(f.emitted.length, 1);
});
