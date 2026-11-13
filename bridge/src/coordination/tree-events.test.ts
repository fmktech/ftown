import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { TREE_EVENTS_COMPACT_AT, TREE_EVENTS_FILE, TREE_EVENTS_MAX_WAIT_MS, TREE_EVENTS_RETAIN, TREE_EVENT_SUMMARY_MAX } from './contract.js';
import { TreeEventLog } from './tree-events.js';
import type { TreeEventInput } from './contract.js';

interface Fixture {
  dir: string;
  log: TreeEventLog;
  clock: { now: number };
  fileFor(rootId: string): string;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-tree-events-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = { now: 1_700_000_000_000 };
  const log = new TreeEventLog({ sessionDir: (id) => join(dir, id), now: () => clock.now });
  return { dir, log, clock, fileFor: (rootId) => join(dir, rootId, TREE_EVENTS_FILE) };
}

const input = (overrides: Partial<TreeEventInput> = {}): TreeEventInput => ({
  sessionId: 'child-1', sessionName: 'Child', kind: 'status', summary: 'hello', ...overrides,
});

/** Seeds a log file directly with `count` valid events (seq 1..count). */
async function seed(f: Fixture, rootId: string, count: number): Promise<void> {
  const dir = join(f.dir, rootId);
  await mkdir(dir, { recursive: true });
  const lines: string[] = [];
  for (let seq = 1; seq <= count; seq++) {
    lines.push(JSON.stringify({ seq, ts: new Date(0).toISOString(), sessionId: 'child-1', sessionName: 'Child', kind: 'status', summary: `e${seq}` }));
  }
  await writeFile(f.fileFor(rootId), lines.join('\n') + '\n', 'utf8');
}

test('concurrent appends get strictly increasing seqs, oldest-first reads and a correct head', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.log.head('root1'), 0, 'missing file is not an error');
  const appended = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    f.log.append('root1', input({ sessionId: `c${i}`, summary: `s${i}` }))));
  const seqs = appended.map((event) => event.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(await f.log.head('root1'), 50);
  const page = await f.log.read('root1');
  assert.equal(page.events.length, 50, 'default limit is above 50');
  assert.deepEqual(page.events.map((event) => event.seq), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(page.cursor, 50);
  assert.match(page.events[0].ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('events persist across instances with 0600 file and 0700 directory modes', async (t) => {
  const f = await fixture(t);
  await f.log.append('root1', input({ summary: 'first' }));
  await f.log.append('root1', input({ summary: 'second', kind: 'attention', ref: 'attn-1' }));
  const before = await f.log.read('root1');
  const again = new TreeEventLog({ sessionDir: (id) => join(f.dir, id), now: () => f.clock.now });
  assert.deepEqual((await again.read('root1')).events, before.events);
  assert.equal(await again.head('root1'), 2);
  assert.equal((await stat(f.fileFor('root1'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.dir, 'root1'))).mode & 0o777, 0o700);
});

test('corrupt and truncated lines are skipped and never reset the seq counter', async (t) => {
  const f = await fixture(t);
  await f.log.append('root1', input({ summary: 'a' }));
  await f.log.append('root1', input({ summary: 'b' }));
  await f.log.append('root1', input({ summary: 'c' }));
  const file = f.fileFor('root1');
  await writeFile(file, (await readFile(file, 'utf8')).replace(/\n$/, '') + '\n{"seq": broken\n', 'utf8');
  const fresh = new TreeEventLog({ sessionDir: (id) => join(f.dir, id), now: () => f.clock.now });
  assert.equal(await fresh.head('root1'), 3);
  const fourth = await fresh.append('root1', input({ summary: 'd' }));
  assert.equal(fourth.seq, 4);
  const page = await fresh.read('root1');
  assert.deepEqual(page.events.map((event) => event.summary), ['a', 'b', 'c', 'd']);
  // A corrupt line in the middle is skipped as well.
  const valid = (await readFile(file, 'utf8')).split('\n').filter((line) => {
    if (!line.trim()) return false;
    try { JSON.parse(line); return true; } catch { return false; }
  });
  await writeFile(file, [valid[0], 'not json', valid[1], valid[2], valid[3]].join('\n') + '\n', 'utf8');
  const page2 = await fresh.read('root1');
  assert.equal(page2.events.length, 4);
  assert.equal(page2.events[0].seq, 1);
  assert.equal(page2.events[3].seq, 4);
});

test('compaction keeps the newest N events, preserves seq and stays atomic', async (t) => {
  const f = await fixture(t);
  await seed(f, 'rootC', TREE_EVENTS_COMPACT_AT);
  assert.equal(await f.log.head('rootC'), TREE_EVENTS_COMPACT_AT);
  await f.log.read('rootC', { limit: 1 });
  const appended = await f.log.append('rootC', input({ summary: 'fresh' }));
  assert.equal(appended.seq, TREE_EVENTS_COMPACT_AT + 1);
  const raw = await readFile(f.fileFor('rootC'), 'utf8');
  const seqs = raw.trim().split('\n').map((line) => (JSON.parse(line) as { seq: number }).seq);
  assert.equal(seqs.length, TREE_EVENTS_RETAIN);
  assert.equal(seqs[0], TREE_EVENTS_COMPACT_AT + 2 - TREE_EVENTS_RETAIN, 'newest 5000 of seqs 1..6001');
  assert.equal(seqs[seqs.length - 1], TREE_EVENTS_COMPACT_AT + 1);
  assert.equal(await f.log.head('rootC'), TREE_EVENTS_COMPACT_AT + 1);
  assert.equal((await stat(f.fileFor('rootC'))).mode & 0o777, 0o600);
  const page = await f.log.read('rootC');
  assert.equal(page.events.length, 100, 'read back through the default limit');
  assert.equal(page.cursor, TREE_EVENTS_COMPACT_AT + 2 - TREE_EVENTS_RETAIN + 99, 'oldest-first page cursor');
  // No tmp files left behind.
  const leftovers = (await readdir(join(f.dir, 'rootC'))).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('read applies since, default limit and 1..500 clamping', async (t) => {
  const f = await fixture(t);
  await seed(f, 'rootR', 700);
  assert.equal((await f.log.read('rootR')).events.length, 100);
  assert.equal((await f.log.read('rootR', { limit: 1000 })).events.length, 500);
  assert.equal((await f.log.read('rootR', { limit: 0 })).events.length, 1);
  assert.equal((await f.log.read('rootR', { limit: -5 })).events.length, 1);
  const tail = await f.log.read('rootR', { since: 650 });
  assert.deepEqual(tail.events.map((event) => event.seq), Array.from({ length: 50 }, (_, i) => 651 + i));
  assert.equal(tail.cursor, 700);
  const beyond = await f.log.read('rootR', { since: 10_000 });
  assert.deepEqual(beyond.events, []);
  assert.equal(beyond.cursor, 10_000);
  const narrow = await f.log.read('rootR', { since: 2, limit: 3 });
  assert.deepEqual(narrow.events.map((event) => event.seq), [3, 4, 5]);
  assert.equal(narrow.cursor, 5);
});

test('wait resolves on the next append for that root', async (t) => {
  const f = await fixture(t);
  await f.log.append('rootW', input({ summary: 'old' }));
  const pending = f.log.wait('rootW', 1, 5000);
  await delay(20);
  const appended = await f.log.append('rootW', input({ summary: 'wake' }));
  const page = await pending;
  assert.equal(page.timedOut, undefined);
  assert.deepEqual(page.events.map((event) => event.seq), [appended.seq]);
  assert.equal(page.cursor, appended.seq);
});

test('wait returns the existing page immediately when events already exist', async (t) => {
  const f = await fixture(t);
  await f.log.append('rootW', input({ summary: 'there' }));
  const page = await f.log.wait('rootW', 0, 5000);
  assert.equal(page.events.length, 1);
  assert.equal(page.timedOut, undefined);
});

test('wait does not lose an append that commits while the initial read is in flight', async (t) => {
  const f = await fixture(t);
  // Fire the append without awaiting so it races wait()'s registration/read window.
  const pendingAppend = f.log.append('rootY', input({ summary: 'racing' }));
  const page = await f.log.wait('rootY', 0, 5000);
  await pendingAppend;
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].summary, 'racing');
  assert.equal(page.timedOut, undefined);
});

test('cold-cache head() racing appends never duplicates or regresses seqs', async (t) => {
  const f = await fixture(t);
  const fresh = new TreeEventLog({ sessionDir: (id) => join(f.dir, id), now: () => f.clock.now });
  const [appended, heads] = await Promise.all([
    Promise.all(Array.from({ length: 20 }, (_, i) => fresh.append('rootH', input({ summary: `e${i}` })))),
    Promise.all(Array.from({ length: 20 }, () => fresh.head('rootH'))),
  ]);
  const seqs = appended.map((event) => event.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1), 'every seq used exactly once');
  for (const head of heads) assert.ok(head >= 0 && head <= 20);
  assert.equal(await fresh.head('rootH'), 20);
});

test('wait times out with an empty page and cursor = since', async (t) => {
  const f = await fixture(t);
  const page = await f.log.wait('rootW', 7, 25);
  assert.deepEqual(page.events, []);
  assert.equal(page.cursor, 7);
  assert.equal(page.timedOut, true);
});

test('wait clamps timeouts to TREE_EVENTS_MAX_WAIT_MS', async (t) => {
  const f = await fixture(t);
  // Capture the armed delay instead of waiting 300s: forward every timer to a fast real one.
  const original = globalThis.setTimeout;
  let captured: number | undefined;
  const capture = ((handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    captured ??= ms;
    return original(handler as never, 5, ...(rest as never[]));
  }) as unknown as typeof setTimeout;
  globalThis.setTimeout = capture;
  try {
    const page = await f.log.wait('rootW', 0, Number.MAX_SAFE_INTEGER);
    assert.equal(page.timedOut, true);
    assert.equal(captured, TREE_EVENTS_MAX_WAIT_MS, 'over-long timeouts clamp to the max');
  } finally {
    globalThis.setTimeout = original;
  }
});

test('wait aborted behaves like a timeout and cleans up', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = f.log.wait('rootW', 3, 5000, controller.signal);
  await delay(10);
  controller.abort();
  const page = await pending;
  assert.deepEqual(page.events, []);
  assert.equal(page.cursor, 3);
  assert.equal(page.timedOut, true);
  const waiters = (f.log as unknown as { waiters: Map<string, Set<unknown>> }).waiters;
  assert.equal(waiters.size, 0, 'abort must remove the waiter');
});

test('many concurrent waits leave no listeners or timers behind', async (t) => {
  const f = await fixture(t);
  const waits = Array.from({ length: 200 }, () => f.log.wait('rootX', 0, 10));
  const pages = await Promise.all(waits);
  for (const page of pages) {
    assert.deepEqual(page.events, []);
    assert.equal(page.timedOut, true);
  }
  const waiters = (f.log as unknown as { waiters: Map<string, Set<unknown>> }).waiters;
  assert.equal(waiters.size, 0);
  // The log still works afterwards.
  const appended = await f.log.append('rootX', input({ summary: 'after waits' }));
  assert.equal(appended.seq, 1);
  const page = await f.log.read('rootX');
  assert.equal(page.events.length, 1);
});

test('a failed compaction does not fail the append and still wakes waiters', async (t) => {
  const f = await fixture(t);
  const rootDir = join(f.dir, 'rootCF');
  await seed(f, 'rootCF', TREE_EVENTS_COMPACT_AT);
  await f.log.read('rootCF', { limit: 1 });
  const pending = f.log.wait('rootCF', TREE_EVENTS_COMPACT_AT, 5000);
  await delay(10);
  // Make the directory read-only so the compaction rewrite cannot create its tmp file,
  // while appending to the existing log file still succeeds.
  await chmod(rootDir, 0o500);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    const appended = await f.log.append('rootCF', input({ summary: 'durable anyway' }));
    assert.equal(appended.seq, TREE_EVENTS_COMPACT_AT + 1, 'append survives the failed compaction');
    const page = await pending;
    assert.equal(page.events.length, 1, 'waiter woken despite the failed compaction');
    assert.equal(page.events[0].summary, 'durable anyway');
    assert.ok(warnings.some((line) => line.includes('compaction')), 'failure is reported, not silent');
  } finally {
    console.warn = originalWarn;
    await chmod(rootDir, 0o700);
  }
});

test('summary is cleaned, control chars stripped and truncated with an ellipsis', async (t) => {
  const f = await fixture(t);
  const long = 'x'.repeat(400);
  const event = await f.log.append('root1', input({
    summary: `a\u0007b\nc\td  ${long}`,
    sessionName: `Name\nwith\u0008tabs${'y'.repeat(250)}`,
    ref: `https://example.test/${'z'.repeat(600)}`,
  }));
  assert.equal(event.summary.length, TREE_EVENT_SUMMARY_MAX);
  assert.ok(event.summary.endsWith('…'));
  assert.ok(event.summary.startsWith('a b c d x'), 'control chars and whitespace become single spaces');
  assert.ok(!/[\u0000-\u001f\u007f]/.test(event.summary));
  assert.equal(event.sessionName.length, 200);
  assert.ok(event.sessionName.startsWith('Name with tabs'));
  assert.equal(event.ref?.length, 500);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(event.sessionName));
  // A ref that cleans to nothing is stored as absent, not ''.
  const bare = await f.log.append('root1', input({ summary: 'a\nb', ref: ' \u0007\n' }));
  assert.equal(bare.summary, 'a b');
  assert.equal('ref' in bare, false);
});

test('invalid ids, kinds and fields are rejected', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.log.append('bad id!', input()), /Invalid session id/);
  await assert.rejects(f.log.append('root1', input({ sessionId: '../escape' })), /Invalid session id/);
  await assert.rejects(f.log.read('no spaces'), /Invalid session id/);
  await assert.rejects(f.log.wait('$bad', 0, 10), /Invalid session id/);
  await assert.rejects(f.log.head('x'.repeat(201)), /Invalid session id/);
  await assert.rejects(
    f.log.append('root1', input({ kind: 'bogus' }) as unknown as TreeEventInput),
    /Invalid event kind/,
  );
  // Nothing was written.
  assert.equal(await f.log.head('root1'), 0);
});
