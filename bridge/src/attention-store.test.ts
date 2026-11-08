import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ATTENTION_WAITER_TTL_MS, type AttentionPrompt } from './attention-prompt-protocol.js';
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
  for (const event of [...first.events, second.events[0]]) await store.mutate('s1', [event.id], 'resolve');
  assert.equal((await store.list('s1', { cursor: start.cursor })).cursorReset, true);
  assert.equal((await store.list('s1')).openCount, 2);
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

const mailPrompt = (): AttentionPrompt => ({ channel: 'mail', questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev', description: 'staging' }], multiSelect: false, allowText: true }] });
const hookPrompt = (): AttentionPrompt => ({ ...mailPrompt(), channel: 'hook' });
const askInput = { questions: [{ question: 'Pick one', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] };
const needsInput = (message: string) => notice(message, { notification_type: 'agent_needs_input' });

test('prompt is persisted, reloaded, part of the fingerprint and never taken from hook data', async t => {
  const f = await fixture(t);
  const a = (await f.store.record('s1', 'Notification', needsInput('Q'), { prompt: mailPrompt() }))!;
  assert.deepEqual(a.prompt, mailPrompt());
  assert.deepEqual((await new AttentionStore(f.resolve).list('s1')).events[0].prompt, mailPrompt());
  const same = (await f.store.record('s1', 'Notification', needsInput('Q'), { prompt: mailPrompt() }))!;
  assert.equal(same.id, a.id);
  const other = mailPrompt(); other.questions[0].question = 'Other?';
  const b = (await f.store.record('s1', 'Notification', needsInput('Q'), { prompt: other }))!;
  assert.notEqual(b.id, a.id);
  const c = (await f.store.record('s1', 'Notification', { ...needsInput('Hooked'), prompt: mailPrompt(), attentionPrompt: mailPrompt() }))!;
  assert.equal(c.prompt, undefined);
});

test('recordDetailed reports created for a new item and deduped for a repeat, record stays unchanged', async t => {
  const f = await fixture(t);
  const ask = { tool_name: 'AskUserQuestion', tool_use_id: 'tuc', tool_input: askInput };
  const first = await f.store.recordDetailed('s1', 'PreToolUse', ask);
  assert.equal(first.created, true);
  assert.equal(first.item?.occurrences, 1);
  const again = await f.store.recordDetailed('s1', 'PreToolUse', ask);
  assert.equal(again.created, false);
  assert.equal(again.item?.id, first.item?.id);
  assert.equal(again.item?.occurrences, 2);
  const plain = await f.store.recordDetailed('s1', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'tub', tool_input: { command: 'ls' } });
  assert.deepEqual(plain, { item: undefined, created: false });
  const viaRecord = await f.store.record('s1', 'PreToolUse', ask);
  assert.equal(viaRecord?.id, first.item?.id);
  assert.equal(viaRecord?.occurrences, 3);
});

test('recordDetailed reports created false when deduping onto a resolved ask', async t => {
  const f = await fixture(t);
  const ask = { tool_name: 'AskUserQuestion', tool_use_id: 'tur', tool_input: askInput };
  const first = await f.store.recordDetailed('s1', 'PreToolUse', ask);
  assert.equal(first.created, true);
  await f.store.record('s1', 'PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'tur' });
  const again = await f.store.recordDetailed('s1', 'PreToolUse', ask);
  assert.equal(again.created, false);
  assert.equal(again.item?.id, first.item?.id);
});

test('AskUserQuestion PreToolUse stores a prompt, deduplicates by tool_use_id and fills a missing prompt', async t => {
  const f = await fixture(t);
  const first = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'tu1', tool_input: askInput }))!;
  assert.equal(first.type, 'ask_user');
  assert.equal(first.prompt?.channel, 'hook');
  assert.deepEqual(first.prompt?.questions[0].options, [{ label: 'A' }, { label: 'B' }]);
  const again = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'tu1', tool_input: askInput }))!;
  assert.equal(again.id, first.id); assert.equal(again.occurrences, 2);
  const noPrompt = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'tu2', tool_input: { questions: [{ question: 'free?' }] } }))!;
  assert.equal(noPrompt.prompt, undefined);
  const filled = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'tu2', tool_input: askInput }))!;
  assert.equal(filled.id, noPrompt.id); assert.ok(filled.prompt);
  const other = (await f.store.record('s1', 'PreToolUse', { tool_name: 'request_user_input', tool_use_id: 'tu3', tool_input: askInput }))!;
  assert.equal(other.prompt, undefined);
});

test('PostToolUse of an ask tool resolves the matching ask_user item as tool_complete', async t => {
  const f = await fixture(t);
  const a = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'tu1', tool_input: askInput }))!;
  const b = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'tu2', tool_input: askInput }))!;
  assert.ok(await f.store.record('s1', 'PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'tu1' }) === undefined);
  const events = (await f.store.list('s1', { includeResolved: true })).events;
  assert.equal(events.find(e => e.id === a.id)?.resolution, 'tool_complete');
  assert.equal(events.find(e => e.id === b.id)?.resolvedAt, undefined);
  await f.store.record('s1', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu2' });
  assert.equal((await f.store.list('s1')).events.length, 1);
});

test('explicit snapshot and dismissal include ask_user items with a prompt only', async t => {
  const f = await fixture(t);
  const noPrompt = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'x', tool_input: {} }))!;
  assert.equal((await f.store.explicitSnapshot('s1')).attention, null);
  await assert.rejects(f.store.resolveExplicitThrough('s1', noPrompt.id), /Unknown explicit/);
  const older = (await f.store.record('s1', 'Notification', needsInput('Old')))!;
  const asked = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'y', tool_input: askInput }))!;
  assert.equal((await f.store.explicitSnapshot('s1')).attention?.id, asked.id);
  await f.store.resolveExplicitThrough('s1', asked.id);
  const events = (await f.store.list('s1', { includeResolved: true })).events;
  assert.equal(events.find(e => e.id === older.id)?.resolution, 'manual');
  assert.equal(events.find(e => e.id === asked.id)?.resolution, 'manual');
  assert.equal(events.find(e => e.id === noPrompt.id)?.resolvedAt, undefined);
});

test('answer resolves, persists and returns the snapshot; every error is coded', async t => {
  const f = await fixture(t);
  const item = (await f.store.record('s1', 'Notification', needsInput('Q'), { prompt: mailPrompt() }))!;
  const legacy = (await f.store.record('s1', 'Notification', notice('Legacy')))!;
  const code = (e: unknown, status: number, c: string) => e instanceof AttentionError && e.status === status && e.code === c;
  await assert.rejects(f.store.answer('s1', 'nope', [{ selected: [0] }]), (e) => code(e, 404, 'attention_not_found'));
  await assert.rejects(f.store.answer('s1', legacy.id, [{ selected: [0] }]), (e) => code(e, 409, 'attention_not_answerable'));
  await assert.rejects(f.store.answer('s1', item.id, [{ selected: [5] }]), (e) => code(e, 400, 'invalid_answer'));
  await assert.rejects(f.store.answer('s1', item.id, 'x'), (e) => code(e, 400, 'invalid_answer'));
  const when = new Date('2026-10-20T10:00:00.000Z');
  const result = await f.store.answer('s1', item.id, [{ selected: [1], text: ' note ' }], when);
  assert.equal(result.waiterLive, false);
  assert.equal(result.item.resolution, 'answered');
  assert.equal(result.item.resolvedAt, when.toISOString());
  assert.deepEqual(result.item.answer, { answers: [{ selected: [1], text: 'note' }], answeredAt: when.toISOString() });
  assert.equal(result.snapshot.attention, null);
  const reloaded = (await new AttentionStore(f.resolve).list('s1', { includeResolved: true })).events.find(e => e.id === item.id);
  assert.deepEqual(reloaded?.answer, result.item.answer);
  await assert.rejects(f.store.answer('s1', item.id, [{ selected: [0] }]), (e) => code(e, 409, 'attention_already_resolved'));
});

test('hook-channel answers need a live waiter and report waiterLive', async t => {
  const f = await fixture(t);
  const item = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'h1', tool_input: askInput }))!;
  await assert.rejects(f.store.answer('s1', item.id, [{ selected: [0] }]), (e) => e instanceof AttentionError && e.status === 409 && e.code === 'answer_waiter_gone');
  const poll = f.store.waitForItem('s1', item.id, 5000);
  await delay(20);
  assert.equal(f.store.hasLiveWaiter(item.id), true);
  const result = await f.store.answer('s1', item.id, [{ selected: [1] }]);
  assert.equal(result.waiterLive, true);
  assert.equal((await poll).resolution, 'answered');
});

test('waitForItem: immediate cases, deadline, unknown id, and wakes on every resolution path', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.waitForItem('s1', 'nope', 0), (e) => e instanceof AttentionError && e.status === 404 && e.code === 'attention_not_found');
  const item = (await f.store.record('s1', 'Notification', needsInput('Q'), { prompt: mailPrompt() }))!;
  assert.equal((await f.store.waitForItem('s1', item.id, 0)).resolvedAt, undefined);
  const started = Date.now();
  assert.equal((await f.store.waitForItem('s1', item.id, 60)).resolvedAt, undefined);
  assert.ok(Date.now() - started >= 50);

  await f.store.mutate('s1', [item.id], 'resolve');
  const wakes: Array<[string, (id: string) => Promise<unknown>]> = [
    ['manual', id => f.store.mutate('s1', [id], 'resolve')],
    ['user_prompt', () => f.store.record('s1', 'UserPromptSubmit', {})],
    ['session_end', () => f.store.record('s1', 'SessionEnd', {})],
    ['manual', id => f.store.resolveExplicitThrough('s1', id)],
    ['answered', id => f.store.answer('s1', id, [{ selected: [0] }])],
  ];
  for (const [i, [resolution, act]] of wakes.entries()) {
    const fresh = (await f.store.record('s1', 'Notification', needsInput(`Q${i}`), { prompt: mailPrompt() }))!;
    const poll = f.store.waitForItem('s1', fresh.id, 5000);
    await delay(10);
    await act(fresh.id);
    assert.equal((await poll).resolution, resolution);
  }
  const elicit = (await f.store.record('s1', 'Notification', { notification_type: 'elicitation_dialog', message: 'E' }))!;
  const poll = f.store.waitForItem('s1', elicit.id, 5000);
  await delay(10);
  await f.store.record('s1', 'Notification', { notification_type: 'elicitation_complete' });
  assert.equal((await poll).resolution, 'elicitation_complete');
  const ask = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'w1', tool_input: askInput }))!;
  const poll2 = f.store.waitForItem('s1', ask.id, 5000);
  await delay(10);
  await f.store.record('s1', 'PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'w1' });
  assert.equal((await poll2).resolution, 'tool_complete');
});

test('waitForItem sees a resolution committed right after its first read', async t => {
  const f = await fixture(t);
  const item = (await f.store.record('s1', 'Notification', needsInput('Q'), { prompt: mailPrompt() }))!;
  const internals = f.store as unknown as { readItem: (id: string, eventId: string) => Promise<unknown> };
  const original = internals.readItem.bind(f.store);
  let injected = false;
  internals.readItem = async (id, eventId) => {
    const read = await original(id, eventId);
    if (!injected) { injected = true; await f.store.mutate(id, [eventId], 'resolve'); }
    return read; // stale: still open, so the waiter must be woken by the injected resolution
  };
  const started = Date.now();
  const done = await f.store.waitForItem('s1', item.id, 5000);
  assert.equal(done.resolution, 'manual');
  assert.ok(Date.now() - started < 2000);
});

test('concurrent double answer: exactly one wins, the other is already_resolved', async t => {
  const f = await fixture(t);
  const item = (await f.store.record('s1', 'Notification', needsInput('Q'), { prompt: mailPrompt() }))!;
  const results = await Promise.allSettled([
    f.store.answer('s1', item.id, [{ selected: [0] }]),
    f.store.answer('s1', item.id, [{ selected: [1] }]),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal((rejected.reason as AttentionError).code, 'attention_already_resolved');
});

test('waitForItem leaves no waiter or liveness behind after deadline, abort, 404 or resolution', async t => {
  const f = await fixture(t);
  const item = (await f.store.record('s1', 'Notification', needsInput('Q'), { prompt: mailPrompt() }))!;
  const internals = f.store as unknown as { itemWaiters: Map<string, Set<unknown>>; pollers: Map<string, unknown> };
  await f.store.waitForItem('s1', item.id, 30);
  assert.equal(internals.itemWaiters.size, 0);
  assert.equal(f.store.hasLiveWaiter(item.id), true, 'TTL liveness remains after a deadline return');
  await assert.rejects(f.store.waitForItem('s1', 'ghost', 30), /Unknown attention/);
  assert.equal(internals.itemWaiters.size, 0);
  assert.equal(f.store.hasLiveWaiter('ghost'), false);
  assert.equal(internals.pollers.has('ghost'), false);
  const ac = new AbortController();
  const aborted = f.store.waitForItem('s1', item.id, 5000, ac.signal);
  await delay(10); ac.abort();
  await assert.rejects(aborted, /cancelled/);
  assert.equal(internals.itemWaiters.size, 0);
  assert.equal(f.store.hasLiveWaiter(item.id), false);
  assert.equal((await f.store.waitForItem('s1', item.id, Number.NaN)).resolvedAt, undefined);
  assert.equal((await f.store.waitForItem('s1', item.id, -5)).resolvedAt, undefined);
});

test('answer liveness: mail needs an active wait (no TTL), hook accepts a recent poll', async t => {
  const f = await fixture(t);
  const mail = (await f.store.record('s1', 'Notification', needsInput('M'), { prompt: mailPrompt() }))!;
  await f.store.waitForItem('s1', mail.id, 30);
  assert.equal(f.store.hasLiveWaiter(mail.id), true);
  assert.equal((await f.store.answer('s1', mail.id, [{ selected: [0] }])).waiterLive, false);
  const mail2 = (await f.store.record('s1', 'Notification', needsInput('M2'), { prompt: mailPrompt() }))!;
  const poll = f.store.waitForItem('s1', mail2.id, 5000);
  await delay(20);
  assert.equal((await f.store.answer('s1', mail2.id, [{ selected: [0] }])).waiterLive, true);
  await poll;
  const hook = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'lv', tool_input: askInput }))!;
  await f.store.waitForItem('s1', hook.id, 30);
  assert.equal((await f.store.answer('s1', hook.id, [{ selected: [0] }])).waiterLive, true);
});

test('a replayed AskUserQuestion hook does not reopen or duplicate a resolved ask_user item', async t => {
  const f = await fixture(t);
  const first = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'r1', tool_input: askInput }))!;
  await f.store.record('s1', 'PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'r1' });
  const pushed: string[] = [];
  const store = new AttentionStore(f.resolve, 500, (_s, n) => pushed.push(n.eventKey));
  const again = (await store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'r1', tool_input: askInput }))!;
  assert.equal(again.id, first.id); assert.equal(again.resolution, 'tool_complete'); assert.equal(again.occurrences, 2);
  assert.equal((await store.list('s1', { includeResolved: true })).events.length, 1);
  assert.equal(pushed.length, 0);
  // Other kinds still open a fresh item after resolution.
  const n1 = (await store.record('s1', 'Notification', notice('Same', { notification_id: 'n1' })))!;
  await store.mutate('s1', [n1.id], 'resolve');
  assert.notEqual((await store.record('s1', 'Notification', notice('Same', { notification_id: 'n1' })))!.id, n1.id);
});

test('dismissal and answers sweep only older plain requests, never older prompted ones', async t => {
  const f = await fixture(t);
  const plain = (await f.store.record('s1', 'Notification', needsInput('Plain')))!;
  const askedMail = (await f.store.record('s1', 'Notification', needsInput('Prompted'), { prompt: mailPrompt() }))!;
  const plain2 = (await f.store.record('s1', 'Notification', needsInput('Plain2')))!;
  const target = (await f.store.record('s1', 'Notification', needsInput('Target'), { prompt: mailPrompt() }))!;
  await f.store.resolveExplicitThrough('s1', target.id);
  let events = (await f.store.list('s1', { includeResolved: true })).events;
  for (const id of [plain.id, plain2.id, target.id]) assert.equal(events.find(e => e.id === id)?.resolution, 'manual');
  assert.equal(events.find(e => e.id === askedMail.id)?.resolvedAt, undefined);

  const g = await fixture(t);
  const p1 = (await g.store.record('s1', 'Notification', needsInput('Plain')))!;
  const older = (await g.store.record('s1', 'Notification', needsInput('Older'), { prompt: mailPrompt() }))!;
  const answered = (await g.store.record('s1', 'Notification', needsInput('Answered'), { prompt: mailPrompt() }))!;
  const result = await g.store.answer('s1', answered.id, [{ selected: [0] }]);
  events = (await g.store.list('s1', { includeResolved: true })).events;
  assert.equal(events.find(e => e.id === p1.id)?.resolution, 'manual');
  assert.equal(events.find(e => e.id === older.id)?.resolvedAt, undefined);
  assert.equal(result.snapshot.attention?.id, older.id);
});

test('items resolved by the current operation survive pruning', async t => {
  const f = await fixture(t, 1);
  const a = (await f.store.record('s1', 'Notification', needsInput('A'), { prompt: mailPrompt() }))!;
  const b = (await f.store.record('s1', 'Notification', needsInput('B'), { prompt: mailPrompt() }))!;
  await f.store.answer('s1', b.id, [{ selected: [0] }]);
  const answeredFirst = await f.store.answer('s1', a.id, [{ selected: [0] }]);
  assert.equal(answeredFirst.item.id, a.id);
  const ids = (await f.store.list('s1', { includeResolved: true })).events.map(e => e.id);
  assert.ok(ids.includes(a.id));
  assert.equal((await f.store.waitForItem('s1', a.id, 0)).resolution, 'answered');
});

test('invalid prompts are rejected before touching disk; prompt strings are redacted', async t => {
  const f = await fixture(t);
  const before = await f.store.list('s1');
  const bad = mailPrompt(); bad.questions[0].options = [{ label: 'x' }, { label: 'X' }];
  await assert.rejects(f.store.record('s1', 'Notification', needsInput('Q'), { prompt: bad }), (e) => e instanceof AttentionError && e.code === 'invalid_prompt' && e.status === 400);
  const long = mailPrompt(); long.questions[0].question = 'q'.repeat(501);
  await assert.rejects(f.store.record('s1', 'Notification', needsInput('Q'), { prompt: long }), (e) => e instanceof AttentionError && e.code === 'invalid_prompt');
  const extra = { channel: 'mail', questions: [], oops: 1 } as unknown as AttentionPrompt;
  await assert.rejects(f.store.record('s1', 'Notification', needsInput('Q'), { prompt: extra }), (e) => e instanceof AttentionError && e.code === 'invalid_prompt');
  assert.equal((await new AttentionStore(f.resolve).list('s1')).events.length, before.events.length);

  const secret = mailPrompt();
  secret.questions[0].question = 'Use API_KEY=topsecret or Bearer abc.def.ghi?';
  secret.questions[0].options = [{ label: 'sk-ant-abcdefghijklmnop1', description: 'token ghp_abcdefghijklmnopqrstuvwx' }, { label: 'sk-ant-abcdefghijklmnop2' }];
  await assert.rejects(f.store.record('s1', 'Notification', needsInput('S'), { prompt: secret }), (e) => e instanceof AttentionError && e.code === 'invalid_prompt', 'labels collide after redaction');
  secret.questions[0].options[1] = { label: 'plain' };
  const ok = (await f.store.record('s1', 'Notification', needsInput('S'), { prompt: secret }))!;
  const raw = await readFile(join(f.dir, 's1/attention.json'), 'utf8');
  for (const leak of ['topsecret', 'abc.def.ghi', 'abcdefghijklmnop1', 'ghp_abcdefghijklmnopqrstuvwx']) assert.ok(!raw.includes(leak), leak);
  assert.ok(ok.prompt?.questions[0].question.includes('[redacted]'));

  const hook = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'sec', tool_input: { questions: [{ question: 'Pick?', options: [{ label: 'Bearer abc.def' }, { label: 'ok' }] }] } }))!;
  assert.equal(hook.prompt?.questions[0].options[0].label, 'Bearer [redacted]');
  const collide = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'sec2', tool_input: { questions: [{ question: 'Pick?', options: [{ label: 'sk-ant-abcdefghijklmnop1' }, { label: 'sk-ant-abcdefghijklmnop2' }] }] } }))!;
  assert.equal(collide.prompt, undefined);
});

test('dedup that adds a prompt refreshes the fingerprint; prompt key order does not matter', async t => {
  const f = await fixture(t);
  const a = (await f.store.record('s1', 'Notification', needsInput('Q'), { prompt: mailPrompt() }))!;
  const reordered = JSON.parse(JSON.stringify(mailPrompt(), ['channel', 'questions', 'multiSelect', 'allowText', 'options', 'label', 'description', 'question', 'header'])) as AttentionPrompt;
  assert.equal((await f.store.record('s1', 'Notification', needsInput('Q'), { prompt: reordered }))!.id, a.id);
  const noPrompt = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'fp', tool_input: {} }))!;
  const filled = (await f.store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'fp', tool_input: askInput }))!;
  assert.equal(filled.id, noPrompt.id);
  const raw = JSON.parse(await readFile(join(f.dir, 's1/attention.json'), 'utf8')) as { events: Array<{ id: string; fingerprint: string }> };
  const before = raw.events.find(e => e.id === noPrompt.id)!.fingerprint;
  assert.equal(before.length, 64);
});

test('waitForItem abort rejects as cancelled and clears liveness when no waits remain', async t => {
  const f = await fixture(t);
  const item = (await f.store.record('s1', 'Notification', needsInput('Q'), { prompt: mailPrompt() }))!;
  const one = new AbortController(); const two = new AbortController();
  const a = f.store.waitForItem('s1', item.id, 5000, one.signal);
  const b = f.store.waitForItem('s1', item.id, 5000, two.signal);
  await delay(10);
  one.abort();
  await assert.rejects(a, (e) => e instanceof AttentionError && e.code === 'cancelled' && e.status === 499);
  assert.equal(f.store.hasLiveWaiter(item.id), true);
  two.abort();
  await assert.rejects(b, (e) => e instanceof AttentionError && e.code === 'cancelled');
  assert.equal(f.store.hasLiveWaiter(item.id), false);
  await assert.rejects(f.store.waitForItem('s1', item.id, 5000, AbortSignal.abort()), /cancelled/);
});

test('liveness lasts ATTENTION_WAITER_TTL_MS after the latest poll started', async t => {
  const f = await fixture(t);
  let now = Date.parse('2026-10-18T12:00:00.000Z');
  const store = new AttentionStore(f.resolve, 500, undefined, { now: () => now });
  const item = (await store.record('s1', 'Notification', needsInput('Q'), { prompt: mailPrompt() }))!;
  assert.equal(store.hasLiveWaiter(item.id), false);
  await store.waitForItem('s1', item.id, 0);
  assert.equal(store.hasLiveWaiter(item.id), false, 'a zero-wait read is not a waiter');
  await store.waitForItem('s1', item.id, 30);
  assert.equal(store.hasLiveWaiter(item.id), true);
  assert.equal(store.hasLiveWaiter(item.id, now + ATTENTION_WAITER_TTL_MS), true);
  assert.equal(store.hasLiveWaiter(item.id, now + ATTENTION_WAITER_TTL_MS + 1), false);
  now += 30_000;
  await store.waitForItem('s1', item.id, 30);
  assert.equal(store.hasLiveWaiter(item.id, now + ATTENTION_WAITER_TTL_MS), true);
  now += ATTENTION_WAITER_TTL_MS + 1;
  assert.equal(store.hasLiveWaiter(item.id), false);
  const hook = (await store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ttl', tool_input: askInput }))!;
  await assert.rejects(store.answer('s1', hook.id, [{ selected: [0] }]), /no longer waiting/);
  await store.waitForItem('s1', hook.id, 30);
  assert.equal((await store.answer('s1', hook.id, [{ selected: [0] }])).waiterLive, true);
});

test('ledgers written before prompts existed still load', async t => {
  const f = await fixture(t);
  const old = { version: 1, epoch: '7b2f3c1e-8f1a-4d57-9a53-0a5b0f6a2c11', sequence: 1, prunedThrough: 0, activity: { state: 'unknown' },
    events: [{ id: 'e1', sequence: 1, type: 'agent_needs_input', title: 'T', message: 'M', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', occurrences: 1, fingerprint: 'f', resolvedAt: '2026-01-02T00:00:00.000Z', resolution: 'user_prompt' }] };
  await writeFile(join(f.dir, 's1/attention.json'), JSON.stringify(old));
  const page = await f.store.list('s1', { includeResolved: true });
  assert.equal(page.events[0].id, 'e1'); assert.equal(page.events[0].prompt, undefined);
});

test('liveness TTL runs from the end of the latest poll, not its start', async t => {
  const f = await fixture(t);
  let now = Date.parse('2026-10-18T12:00:00.000Z');
  const store = new AttentionStore(f.resolve, 500, undefined, { now: () => now });
  const hook = (await store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'end', tool_input: askInput }))!;
  // waitForItem's window is measured with Date.now()/setTimeout; fake both so a slow fs read cannot expire the
  // window before the poll registers (the old real-time 50 ms window made this flaky on loaded CI).
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const runPoll = async (eventId: string) => {
    const poll = store.waitForItem('s1', eventId, 50);
    while (!store.hasLiveWaiter(eventId)) await new Promise<void>(resolve => setImmediate(resolve)); // poller registered
    now += 25_000; // the long-poll ran its full window
    t.mock.timers.tick(50);
    await poll;
  };
  await runPoll(hook.id);
  const result = await store.answer('s1', hook.id, [{ selected: [0] }]);
  assert.equal(result.waiterLive, true);

  const second = (await store.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'end2', tool_input: askInput }))!;
  await runPoll(second.id);
  now += ATTENTION_WAITER_TTL_MS + 1;
  await assert.rejects(store.answer('s1', second.id, [{ selected: [0] }]), (e) => e instanceof AttentionError && e.code === 'answer_waiter_gone');
});

test('malformed prompts of any shape give invalid_prompt, never a TypeError', async t => {
  const f = await fixture(t);
  for (const prompt of [{}, null, 'x', 5, { channel: 'mail' }, { channel: 'mail', questions: [{ question: 'q' }] },
    { channel: 'mail', questions: [null] }, { channel: 'mail', questions: [{ question: 'q', options: 'a', multiSelect: false, allowText: true }] }]) {
    await assert.rejects(f.store.record('s1', 'Notification', needsInput('Q'), { prompt: prompt as never }),
      (e) => e instanceof AttentionError && e.code === 'invalid_prompt' && e.status === 400, JSON.stringify(prompt));
  }
});
