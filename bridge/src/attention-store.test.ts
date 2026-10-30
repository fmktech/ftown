import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AttentionStore, AttentionError, IDLE_NOTIFICATION_DELAY_MS, type AttentionNotificationOptions } from './attention-store.js';

const notice = (message = 'Approve this command?', extra: Record<string, unknown> = {}) => ({ notification_type: 'permission_prompt', message, ...extra });

test('explicit snapshots survive restart, prefer creation order and filter legacy and acknowledged requests', async t => {
  const f = await fixture(t);
  const a = (await f.store.record('s1', 'Notification', notice('A', { notification_type: 'agent_needs_input' })))!;
  const b = (await f.store.record('s1', 'Notification', notice('B', { notification_type: 'agent_needs_input' })))!;
  await f.store.record('s1', 'Notification', notice('A', { notification_type: 'agent_needs_input' }));
  await f.store.record('s1', 'Notification', notice('Legacy'));
  assert.equal((await new AttentionStore(f.resolve).explicitSnapshot('s1')).attention?.id, b.id);
  await f.store.mutate('s1', [b.id], 'ack');
  assert.equal((await f.store.explicitSnapshot('s1')).attention?.id, a.id);
  await f.store.record('s1', 'UserPromptSubmit', {});
  assert.deepEqual(await new AttentionStore(f.resolve).explicitSnapshot('s1'), { attention: null, sequence: 3 });
});

test('explicit dismissal atomically covers predecessors while preserving newer and legacy incidents', async t => {
  const f = await fixture(t);
  const a = (await f.store.record('s1', 'Notification', notice('A', { notification_type: 'agent_needs_input' })))!;
  const b = (await f.store.record('s1', 'Notification', notice('B', { notification_type: 'agent_needs_input' })))!;
  const legacy = (await f.store.record('s1', 'Notification', notice('Legacy')))!;
  const c = (await f.store.record('s1', 'Notification', notice('C', { notification_type: 'agent_needs_input' })))!;
  const before = await readFile(join(f.dir, 's1/attention.json'), 'utf8');
  await assert.rejects(f.store.resolveExplicitThrough('s1', 'unknown'), /Unknown explicit/);
  await assert.rejects(f.store.resolveExplicitThrough('s1', legacy.id), /Unknown explicit/);
  assert.equal(await readFile(join(f.dir, 's1/attention.json'), 'utf8'), before);
  assert.equal((await f.store.resolveExplicitThrough('s1', b.id)).attention?.id, c.id);
  const events = (await f.store.list('s1', { includeResolved: true })).events;
  for (const id of [a.id, b.id]) assert.equal(events.find(event => event.id === id)?.resolution, 'manual');
  for (const id of [legacy.id, c.id]) assert.equal(events.find(event => event.id === id)?.resolvedAt, undefined);
  await f.store.resolveExplicitThrough('s1', c.id);
  assert.equal((await new AttentionStore(f.resolve).explicitSnapshot('s1')).attention, null);
});
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
  // Freeze the wait deadline while exercising unrelated persisted operations.
  const realSetTimeout = setTimeout, realClearTimeout = clearTimeout;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const controller = new AbortController(), positiveController = new AbortController();
  let completed = false;
  const next = store.wait('s1', { cursor: page.cursor }, 1, controller.signal).finally(() => { completed = true; });
  void next.catch(() => {});
  let positive: ReturnType<typeof store.wait> | undefined;
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const assertPending = async () => {
      // The session lock is a barrier for the wait's read and the completed mutation.
      await store.list('s1');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(completed, false);
    };
    await assertPending();
    await store.record('s1', 'Notification', notice());
    await assertPending();
    await store.mutate('s1', [page.events[0].id], 'ack');
    await assertPending();
    await store.record('s1', 'PostToolUse', { tool_name: 'Read' });
    await assertPending();
    controller.abort();
    await assert.rejects(next, /cancelled/);
    assert.equal((await store.wait('s1', {}, 0)).events.length, 0, 'acknowledged requests are not fresh wait matches');
    positive = store.wait('s1', { cursor: page.cursor }, 1, positiveController.signal);
    void positive.catch(() => {});
    // Complete the wait's initial read before creating the eligible event.
    await store.list('s1');
    await new Promise<void>(resolve => setImmediate(resolve));
    await store.record('s1', 'Notification', notice('new distinct question'));
    // A real watchdog bounds a broken wake; it does not advance the mocked deadline.
    const timedOut = new Promise<never>((_, reject) => { guard = realSetTimeout(() => reject(new Error('eligible wait did not wake')), 10000); });
    const awakened = await Promise.race([positive, timedOut]);
    assert.equal(awakened.events[0]?.message, 'new distinct question');
    assert.equal((await store.wait('s1', { cursor: page.cursor }, 0)).events[0].message, 'new distinct question');
  } finally {
    controller.abort(); positiveController.abort();
    if (guard) realClearTimeout(guard);
    await Promise.allSettled([next, ...(positive ? [positive] : [])]);
    t.mock.timers.reset();
  }
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

test('record returns its own committed public event through concurrent requests and deduplication', async (t) => {
  const f = await fixture(t);
  const pushed: string[] = [];
  const store = new AttentionStore(f.resolve, 500, (_id, event) => { pushed.push(event.eventKey); });
  const [first, second, duplicate] = await Promise.all([
    store.record('s1', 'Notification', notice('First question')),
    store.record('s1', 'Notification', notice('Second question')),
    store.record('s1', 'Notification', notice('First question')),
  ]);
  assert.ok(first && second && duplicate);
  assert.equal(first.message, 'First question');
  assert.equal(second.message, 'Second question');
  assert.notEqual(first.id, second.id);
  assert.equal(duplicate.id, first.id);
  assert.equal(first.occurrences, 1, 'returned snapshots do not change under a later duplicate');
  assert.equal(duplicate.occurrences, 2);
  assert.deepEqual(pushed, [`question:${first.id}`, `question:${second.id}`]);
  assert.equal(Object.hasOwn(first, 'fingerprint'), false);
  assert.equal(Object.hasOwn(first, 'sourceId'), false);
  assert.deepEqual((await new AttentionStore(f.resolve).list('s1')).events.map((event) => event.id), [first.id, second.id]);
  await store.mutate('s1', [first.id], 'resolve');
  const recurrence = await store.record('s1', 'Notification', notice('First question'));
  assert.ok(recurrence);
  assert.notEqual(recurrence.id, first.id);
  assert.equal(pushed.length, 3);
  assert.equal(await store.record('s1', 'UnrelatedEvent', {}), undefined);
  assert.equal(await store.record('s1', 'PostToolUse', {}), undefined);
  await assert.rejects(store.record('missing', 'Notification', notice()), /could not be persisted/);
  assert.equal(pushed.length, 3, 'failed persistence cannot dispatch a question');
});


function clock() {
  let now = Date.parse('2026-10-18T12:00:00.000Z');
  const tasks = new Map<ReturnType<typeof setTimeout>, { at: number; fn: () => void }>();
  const options = { now: () => now, schedule: (fn: () => void, ms: number) => {
    const token = { unref() {} } as ReturnType<typeof setTimeout>; tasks.set(token, { at: now + ms, fn }); return token;
  }, cancel: (token: ReturnType<typeof setTimeout>) => { tasks.delete(token); } };
  return { options, tasks, advance(ms: number) { now += ms; for (const [token, task] of [...tasks]) if (task.at <= now) { tasks.delete(token); task.fn(); } } };
}
async function notifications(t: Parameters<typeof fixture>[0], extra: AttentionNotificationOptions = {}) {
  const f = await fixture(t); const time = clock();
  const emitted: import('./push-notifier.js').PushNotice[] = [];
  const signals: import('./attention-store.js').SubagentIdleSignal[] = [];
  const options = { ...time.options, onSubagentIdle: async (signal: import('./attention-store.js').SubagentIdleSignal) => { signals.push(signal); }, ...extra };
  const store = new AttentionStore(f.resolve, 500, (_id, event) => { emitted.push(event); }, options);
  t.after(() => { store.stopNotifications(); });
  const advance = async (ms: number) => { time.advance(ms); await store.list('s1'); };
  return { ...f, time, options, store, emitted, signals, advance,
    ledger: async () => JSON.parse(await readFile(join(f.dir, 's1/attention.json'), 'utf8')) };
}
async function becomeIdle(store: AttentionStore) {
  await store.record('s1', 'UserPromptSubmit', {}); await store.record('s1', 'Stop', {});
}
test('child idle waits two uninterrupted minutes, repeated Stop does not reset and a new cycle rearms', async (t) => {
  const f = await notifications(t);
  await f.store.record('s1', 'Stop', {}); await f.advance(IDLE_NOTIFICATION_DELAY_MS);
  assert.equal(f.signals.length, 0, 'unknown to idle does not arm');
  await becomeIdle(f.store); const original = (await f.ledger()).idleCycle;
  await f.advance(119_999); assert.equal(f.signals.length, 0);
  await f.store.record('s1', 'Stop', {}); assert.deepEqual((await f.ledger()).idleCycle, original);
  await f.advance(1); assert.deepEqual(f.signals, [{ sessionId: 's1', cycleId: original.id, startedAt: original.startedAt }]);
  assert.equal((await f.ledger()).idleCycle.notifiedAt, new Date(f.time.options.now()).toISOString());
  await f.store.record('s1', 'Stop', {}); await f.advance(600_000);
  assert.equal(f.signals.length, 1); assert.equal(f.emitted.length, 0, 'no human idle notice');
  await becomeIdle(f.store); const next = (await f.ledger()).idleCycle; assert.notEqual(next.id, original.id);
  await f.advance(119_999); assert.equal(f.signals.length, 1);
  await f.advance(1); assert.equal(f.signals[1].cycleId, next.id);
});
test('question pushes remain immediate and deduplicated while idle produces no push', async (t) => {
  const f = await notifications(t); await becomeIdle(f.store);
  await f.store.record('s1', 'Notification', notice('choose', { notification_id: 'q' }));
  await f.store.record('s1', 'Notification', notice('choose', { notification_id: 'q' }));
  const event = (await f.store.list('s1')).events[0];
  assert.equal(f.emitted.length, 1); assert.equal(f.emitted[0].eventKey, `question:${event.id}`);
  await f.advance(600_000); assert.equal(f.signals.length, 1); assert.equal(f.emitted.length, 1);
  const throwing = new AttentionStore(f.resolve, 500, () => { throw new Error('observer'); });
  t.after(() => throwing.stopNotifications()); await throwing.record('s1', 'Notification', notice('another'));
  assert.equal((await throwing.list('s1')).events.length, 2);
});
test('busy, session end, stop/removal and shutdown cancel without reviving deleted sessions', async (t) => {
  const f = await notifications(t);
  for (const event of ['PreToolUse', 'UserPromptSubmit', 'SessionEnd']) {
    await becomeIdle(f.store); await f.advance(119_999); await f.store.record('s1', event, {}); await f.advance(1);
    assert.equal((await f.ledger()).idleCycle, undefined, event);
  }
  await becomeIdle(f.store); await f.store.cancelIdleNotification('s1'); await f.advance(120_000);
  assert.equal((await f.ledger()).idleCycle, undefined);
  await becomeIdle(f.store); f.store.stopNotifications(); await f.advance(120_000);
  assert.equal(f.signals.length, 0); assert.equal(f.time.tasks.size, 0);
  const deleted = await notifications(t); await becomeIdle(deleted.store); await rm(join(deleted.dir, 's1'), { recursive: true });
  await assert.rejects(deleted.store.cancelIdleNotification('s1'), /persisted/); await assert.rejects(stat(join(deleted.dir, 's1')), { code: 'ENOENT' });
});
test('restore migrates both marked and unmarked old human cycles and respects new marked cycles', async (t) => {
  for (const marked of [false, true]) {
    const f = await notifications(t); await becomeIdle(f.store); const saved = await f.ledger(); f.store.stopNotifications();
    saved.idleCycle.dueAt = new Date(Date.parse(saved.idleCycle.startedAt) + 600_000).toISOString();
    if (marked) saved.idleCycle.notifiedAt = saved.idleCycle.dueAt;
    await writeFile(join(f.dir, 's1/attention.json'), JSON.stringify(saved));
    f.time.advance(119_999);
    const restored = new AttentionStore(f.resolve, 500, (_id, event) => f.emitted.push(event), f.options);
    t.after(() => restored.stopNotifications());
    await restored.restoreIdleNotifications(['s1']); const migrated = await f.ledger();
    assert.equal(Date.parse(migrated.idleCycle.dueAt) - Date.parse(migrated.idleCycle.startedAt), 120_000);
    assert.equal(migrated.idleCycle.notifiedAt, undefined);
    f.time.advance(1); await restored.list('s1'); assert.equal(f.signals.length, 1);
    restored.stopNotifications();
    const again = new AttentionStore(f.resolve, 500, (_id, event) => f.emitted.push(event), f.options);
    t.after(() => again.stopNotifications()); await again.restoreIdleNotifications(['s1']); f.time.advance(600_000); await again.list('s1');
    assert.equal(f.signals.length, 1); assert.equal(f.emitted.length, 0);
    await again.record('s2', 'Stop', {}); await again.restoreIdleNotifications(['s2']); f.time.advance(120_000); await again.list('s2'); assert.equal(f.signals.length, 1);
  }
});
test('overdue restored cycles attempt once, while inactive and corrupt sessions are isolated', async (t) => {
  for (const active of [true, false]) {
    const f = await notifications(t); await becomeIdle(f.store); f.store.stopNotifications(); f.time.advance(200_000);
    const broken = join(f.dir, 's2/attention.json'); await writeFile(broken, '{"version":1,"idleCycle":{"id":"malformed"}}');
    const restored = new AttentionStore(f.resolve, 500, undefined, { ...f.options, isSessionActive: async () => active });
    t.after(() => restored.stopNotifications()); await restored.restoreIdleNotifications(['s2', 'missing', 's1']);
    f.time.advance(0); await restored.list('s1'); assert.equal(f.signals.length, active ? 1 : 0);
    assert.equal(!!(await f.ledger()).idleCycle, active); await assert.rejects(stat(join(f.dir, 'missing')), { code: 'ENOENT' });
  }
});
test('resuming activity fences a callback blocked on asynchronous target lookup', async (t) => {
  let release!: () => void; let entered!: () => void; let sent = 0;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const f = await notifications(t, { onSubagentIdle: async (_signal, isCurrent) => { entered(); await new Promise<void>(resolve => { release = resolve; }); if (isCurrent()) sent++; } });
  await becomeIdle(f.store); f.time.advance(120_000); await checking;
  const resumed = f.store.record('s1', 'PreToolUse', {}); release(); await resumed;
  assert.equal(sent, 0); assert.equal((await f.ledger()).idleCycle, undefined);
});
test('uncertain callback failure is never retried after a durable attempt marker', async (t) => {
  let attempts = 0; const f = await notifications(t, { onSubagentIdle: async () => { attempts++; throw new Error('may have queued'); } });
  await becomeIdle(f.store); await f.advance(120_000); assert.equal(attempts, 1); assert.ok((await f.ledger()).idleCycle.notifiedAt);
  f.store.stopNotifications(); const restored = new AttentionStore(f.resolve, 500, undefined, f.options);
  t.after(() => restored.stopNotifications()); await restored.restoreIdleNotifications(['s1']); f.time.advance(600_000); await restored.list('s1'); assert.equal(attempts, 1);
});
test('concurrent idle/resume/idle preserves newest timer and explicit cancellation clears a queued arm', async (t) => {
  const f = await notifications(t); await f.store.record('s1', 'UserPromptSubmit', {});
  await Promise.all([f.store.record('s1', 'Stop', {}), f.store.record('s1', 'PreToolUse', {}), f.store.record('s1', 'Stop', {})]);
  const cycle = (await f.ledger()).idleCycle; assert.equal(f.time.tasks.size, 1);
  await f.advance(120_000); assert.equal(f.signals[0].cycleId, cycle.id);
  await f.store.record('s1', 'UserPromptSubmit', {}); await Promise.all([f.store.record('s1', 'Stop', {}), f.store.cancelIdleNotification('s1')]);
  assert.equal(f.time.tasks.size, 0); assert.equal((await f.ledger()).idleCycle, undefined);
});
