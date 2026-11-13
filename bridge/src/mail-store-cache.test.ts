import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore, createMailMessage, type MailStoreIo } from './mail-store.js';
import type { MailMessage } from './types.js';

type Context = { after(fn: () => Promise<void>): void };
type Stamp = Awaited<ReturnType<MailStoreIo['stat']>>;

/**
 * Real filesystem with call counters. ctime cannot be backdated, so the clock runs ahead instead:
 * every file looks quiet for longer than the racy-stamp margin and is therefore cacheable. That
 * also hides the margin, so a test that rewrites a file the store has just cached must change a
 * field that differs on every filesystem (size, inode), or set `clock.aheadMs = 0` first.
 */
function countingIo() {
  const calls = { stat: 0, read: 0 };
  const clock = { aheadMs: 60_000 };
  const io: MailStoreIo = {
    stat: (path) => { calls.stat++; return stat(path, { bigint: true }); },
    readFile: (path) => { calls.read++; return readFile(path, 'utf-8'); },
    now: () => Date.now() + clock.aheadMs,
  };
  return { calls, clock, io };
}

async function fixture(t: Context) {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-mail-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 's'));
  const { calls, clock, io } = countingIo();
  return { dir, calls, clock, file: join(dir, 's', 'inbox.jsonl'), store: new MailStore((id) => join(dir, id), io) };
}

const message = (body: string, extra: Partial<MailMessage> = {}): MailMessage => ({ ...createMailMessage({ from: 'a', to: 's', type: 'message', body }), ...extra });
const lines = (messages: MailMessage[]) => messages.map((item) => JSON.stringify(item)).join('\n') + '\n';
const NS_PER_MS = BigInt(1_000_000);
/** A stamp whose mtime and ctime are both `ms` (milliseconds since the epoch). */
const stampAt = (ms: number, ino = 7, size = 100): Stamp => ({ ino: BigInt(ino), size: BigInt(size), mtimeNs: BigInt(ms) * NS_PER_MS, ctimeNs: BigInt(ms) * NS_PER_MS });

/** Independent uncached reference for files that hold only messages. */
async function uncached(file: string): Promise<MailMessage[]> {
  let raw: string;
  try { raw = await readFile(file, 'utf-8'); } catch { return []; }
  return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as MailMessage);
}

/** Set a known mtime in the past (ctime still moves to now). */
async function age(file: string, secondsAgo = 60): Promise<Date> {
  const when = new Date(Date.now() - secondsAgo * 1000);
  await utimes(file, when, when);
  return when;
}

async function assertCurrent(store: MailStore, file: string): Promise<void> {
  const expected = await uncached(file);
  assert.deepEqual(await store.listAll('s', 0), expected);
  assert.deepEqual(await store.listUndelivered('s'), expected.filter((item) => !item.deliveredAt));
}

test('an unchanged inbox costs one stat and no read per heartbeat', async (t) => {
  const { store, file, calls } = await fixture(t);
  await writeFile(file, lines(Array.from({ length: 20 }, (_, i) => message(`m${i}`, i % 2 ? { deliveredAt: 'x' } : {}))));
  await age(file);
  const first = await store.listUndelivered('s');
  assert.deepEqual(calls, { stat: 1, read: 1 });
  for (let i = 0; i < 5; i++) assert.deepEqual(await store.listUndelivered('s'), first);
  assert.deepEqual(calls, { stat: 6, read: 1 });
  assert.equal(first.length, 10);
  await assertCurrent(store, file);
});

test('a missing inbox costs one stat, reads nothing, and is noticed once created', async (t) => {
  const { store, file, calls } = await fixture(t);
  assert.deepEqual(await store.listUndelivered('s'), []);
  assert.deepEqual(await store.listAll('s', 0), []);
  assert.deepEqual(calls, { stat: 2, read: 0 });
  await writeFile(file, lines([message('created')]));
  await assertCurrent(store, file);
  assert.equal((await store.listAll('s', 0))[0].body, 'created');
});

test('appends and rewrites through the store are visible immediately', async (t) => {
  const { store, file } = await fixture(t);
  await writeFile(file, lines([message('old')]));
  await age(file);
  await assertCurrent(store, file);
  await store.append(message('appended'));
  await assertCurrent(store, file);
  assert.equal((await store.listUndelivered('s')).length, 2);
  const marked = await store.markDelivered('s', [(await store.listUndelivered('s'))[0].id], 'poll');
  assert.equal(marked.length, 1);
  await assertCurrent(store, file);
  assert.equal((await store.listUndelivered('s')).length, 1);
  await store.commitPullRequestObservation('s', 'link', { url: 'https://github.com/o/r/pull/1', state: 'failed', checkedAt: '2026-01-01T00:00:00.000Z', stale: false, attempt: 1, headOid: 'abc' });
  assert.equal((await store.listAll('s', 0)).length, 3);
  assert.equal((await store.commitPullRequestObservation('s', 'link', { url: 'https://github.com/o/r/pull/1', state: 'failed', checkedAt: '2026-01-01T00:00:00.000Z', stale: false, attempt: 1, headOid: 'abc' })).enqueued, false);
});

test('a write through the store drops the cached parse even when the stat would still match', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-mail-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 's'));
  const file = join(dir, 's', 'inbox.jsonl');
  await writeFile(file, lines([message('one')]));
  const frozen = await stat(file, { bigint: true });
  const stamp: Stamp = { ...stampAt(Date.now() - 60_000), ino: frozen.ino, size: frozen.size };
  let reads = 0;
  const store = new MailStore((id) => join(dir, id), { stat: async () => stamp, readFile: (path) => { reads++; return readFile(path, 'utf-8'); }, now: () => Date.now() });
  assert.equal((await store.listAll('s', 0)).length, 1);
  assert.equal((await store.listAll('s', 0)).length, 1);
  assert.equal(reads, 1);
  await store.append(message('two'));
  assert.equal((await store.listAll('s', 0)).length, 2);
  await store.markDelivered('s', (await store.listAll('s', 0)).map((item) => item.id), 'poll');
  assert.equal((await store.listUndelivered('s')).length, 0);
});

test('changes made by another process are never served stale', async (t) => {
  const { store, file, calls, clock } = await fixture(t);
  const original = [message('aaaa'), message('bbbb')];
  await writeFile(file, lines(original));
  const mtime = await age(file);
  await assertCurrent(store, file);

  // Append by another process.
  await appendFile(file, lines([message('external')]));
  await age(file);
  await assertCurrent(store, file);
  assert.equal((await store.listAll('s', 0)).length, 3);

  // Truncation, read with the real clock: the file changed moments ago (its ctime is now), so it
  // must not be cached; the same-size rewrite below may land in the same ctime tick.
  clock.aheadMs = 0;
  await writeFile(file, lines(original));
  await age(file, 90);
  const readsBefore = calls.read;
  await assertCurrent(store, file);
  assert.equal((await store.listAll('s', 0)).length, 2);
  assert.equal(calls.read, readsBefore + 3, 'a file changed moments ago is re-read on every call');

  // In-place rewrite with the same size and a restored mtime, moments after the last change and
  // read. Only ctime could tell, and on Linux it often has not moved to a new tick yet.
  const before = await stat(file, { bigint: true });
  await writeFile(file, lines([{ ...original[0], body: 'cccc' }, original[1]]));
  await utimes(file, new Date(Number(before.mtimeMs)), new Date(Number(before.mtimeMs)));
  const after = await stat(file, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.ino, before.ino);
  await assertCurrent(store, file);
  assert.equal((await store.listAll('s', 0))[0].body, 'cccc');
  clock.aheadMs = 60_000;

  // Deletion.
  await rm(file);
  assert.deepEqual(await store.listAll('s', 0), []);
  assert.deepEqual(await store.listUndelivered('s'), []);

  // Recreation with the same size and the same mtime.
  const recreated = [{ ...original[0], body: 'dddd' }, original[1]];
  await writeFile(file, lines(recreated));
  await utimes(file, mtime, mtime);
  assert.equal((await stat(file, { bigint: true })).size, before.size);
  await assertCurrent(store, file);
  assert.equal((await store.listAll('s', 0))[0].body, 'dddd');

  // Once quiet again, the new content is cached.
  await age(file, 120);
  await assertCurrent(store, file);
  const reads = calls.read;
  await assertCurrent(store, file);
  assert.equal(calls.read, reads);
});

test('a file modified too recently to trust its stamp is re-read every time', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-mail-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = 1_700_000_000_000;
  let content = lines([message('first')]);
  let reads = 0;
  let modifiedAt = now - 500;
  const io: MailStoreIo = {
    // Identical identity on every call: the worst case for stamp comparison.
    stat: async () => stampAt(modifiedAt),
    readFile: async () => { reads++; return content; },
    now: () => now,
  };
  const store = new MailStore((id) => join(dir, id), io);
  assert.equal((await store.listAll('s', 0))[0].body, 'first');
  content = lines([message('second')]);
  assert.equal((await store.listAll('s', 0))[0].body, 'second');
  assert.equal(reads, 2);
  // A timestamp in the future (clock skew) is never trusted either.
  modifiedAt = now + 60_000;
  await store.listAll('s', 0); await store.listAll('s', 0);
  assert.equal(reads, 4);
  // Quiet for longer than the margin: cached from the next read on.
  modifiedAt = now - 60_000;
  await store.listAll('s', 0); await store.listAll('s', 0); await store.listAll('s', 0);
  assert.equal(reads, 5);
});

test('a same-size rewrite that keeps the whole stamp is never served stale (real clock)', async (t) => {
  // Linux takes ctime from a coarse clock: a same-size in-place rewrite within one tick of the
  // previous change reports exactly the stamp the store last saw. Force that on every platform.
  const dir = await mkdtemp(join(tmpdir(), 'ftown-mail-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 's'));
  const file = join(dir, 's', 'inbox.jsonl');
  await writeFile(file, lines([message('aaaa'), message('bbbb')]));
  let frozen: Stamp | undefined;
  const store = new MailStore((id) => join(dir, id), {
    stat: async (path) => (frozen ??= await stat(path, { bigint: true })),
    readFile: (path) => readFile(path, 'utf-8'),
    now: () => Date.now(),
  });
  await assertCurrent(store, file);
  for (const body of ['cccc', 'dddd', 'eeee']) {
    const [first, second] = await uncached(file);
    await writeFile(file, lines([{ ...first, body }, second]));
    assert.equal((await store.listAll('s', 0))[0].body, body);
    await assertCurrent(store, file);
  }
});

for (const field of ['ino', 'size', 'mtimeNs', 'ctimeNs'] as const) {
  test(`a change of ${field} alone invalidates a cached inbox`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'ftown-mail-cache-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let content = lines([message('first')]);
    let reads = 0;
    let reported = stampAt(Date.now() - 60_000);
    const store = new MailStore((id) => join(dir, id), {
      stat: async () => reported,
      readFile: async () => { reads++; return content; },
      now: () => Date.now(),
    });
    assert.equal((await store.listAll('s', 0))[0].body, 'first');
    assert.equal((await store.listAll('s', 0))[0].body, 'first');
    assert.equal(reads, 1);
    content = lines([message('second')]);
    reported = { ...reported, [field]: reported[field] + BigInt(1) };
    assert.equal((await store.listAll('s', 0))[0].body, 'second');
    assert.equal(reads, 2);
  });
}

test('callers cannot change what later reads return', async (t) => {
  const { store, file, calls } = await fixture(t);
  await writeFile(file, lines([message('one'), message('two')]));
  await age(file);
  const all = await store.listAll('s', 0);
  const undelivered = await store.listUndelivered('s');
  const tail = await store.listAll('s', 1);
  assert.throws(() => { all[0].body = 'tampered'; }, TypeError);
  assert.throws(() => { undelivered[1].deliveredAt = 'now'; }, TypeError);
  all.push(message('injected')); all.reverse(); undelivered.length = 0; tail.pop();
  await assertCurrent(store, file);
  assert.equal(calls.read, 1);

  // A failed rewrite must not leave delivery marks in the cached parse.
  const internal = store as unknown as { replaceInbox(id: string, inbox: unknown): Promise<void> };
  const replace = internal.replaceInbox;
  internal.replaceInbox = async () => { throw new Error('disk full'); };
  await assert.rejects(store.markDelivered('s', (await store.listUndelivered('s')).map((item) => item.id), 'poll'), /disk full/);
  assert.equal((await store.listUndelivered('s')).length, 2);
  await assertCurrent(store, file);
  internal.replaceInbox = replace;
  const marked = await store.markDelivered('s', (await store.listUndelivered('s')).map((item) => item.id), 'poll');
  assert.equal(marked.length, 2);
  marked[0].body = 'callers own marked copies';
  assert.equal((await store.listUndelivered('s')).length, 0);
  await assertCurrent(store, file);
});

test('a malformed checkpoint keeps failing closed and is never cached', async (t) => {
  const { store, file, calls } = await fixture(t);
  await writeFile(file, '{"_ftown":"pr-event-checkpoint","version":2}\n');
  await age(file);
  await assert.rejects(store.listAll('s', 0), /Invalid PR event checkpoint/);
  await assert.rejects(store.listUndelivered('s'), /Invalid PR event checkpoint/);
  assert.equal(calls.read, 2);
});

test('the cache is bounded and an evicted inbox is simply re-read', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-mail-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { calls, io } = countingIo();
  const store = new MailStore((id) => join(dir, id), io);
  const count = 257;
  for (let i = 0; i < count; i++) {
    await mkdir(join(dir, `s${i}`));
    await writeFile(join(dir, `s${i}`, 'inbox.jsonl'), lines([message(`body-${i}`)]));
    await age(join(dir, `s${i}`, 'inbox.jsonl'));
  }
  for (let i = 0; i < count; i++) assert.equal((await store.listAll(`s${i}`, 0))[0].body, `body-${i}`);
  assert.equal(calls.read, count);
  assert.equal((await store.listAll(`s${count - 1}`, 0))[0].body, `body-${count - 1}`);
  assert.equal(calls.read, count);
  assert.equal((await store.listAll('s0', 0))[0].body, 'body-0');
  assert.equal(calls.read, count + 1);
});
