import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from './session-store.js';
import type { Session } from './types.js';

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: `session ${id}`,
    command: 'zsh',
    status: 'running',
    bridgeId: 'bridge-1',
    createdAt: `2026-01-01T00:00:0${id.length % 10}.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    env: { TOKEN: 'secret', NESTED: 'value' },
    ...overrides,
  };
}

interface Fixture {
  dir: string;
  store: SessionStore;
  /** session.json paths read from disk since the last reset. */
  reads: string[];
  /** session.json paths whose next stats are replaced by the given result. */
  fakeStats: Map<string, BigIntStats>;
  /** Runs once, just before the named path is read or stat'ed. */
  beforeRead: Map<string, () => Promise<void>>;
  beforeStat: Map<string, () => Promise<void>>;
  /** Highest number of stats in flight at once since the last reset. */
  stats: { inFlight: number; maxInFlight: number };
  /** What a store with an empty index returns: the uncached scan. */
  uncached(): Promise<Session[]>;
  recordPath(id: string): string;
  /** Another store on the same directory and clock, with an empty index. */
  newStore(): SessionStore;
}

/**
 * ctime cannot be backdated, so by default the stores' clock runs a minute ahead: every file
 * looks quiet for longer than the racy-stamp margin and is cacheable once read. That hides the
 * margin, so a test that rewrites a record the store has just indexed must change a field that
 * differs on every filesystem (size, inode, a different mtime), or use `clockAheadMs: 0`.
 */
async function fixture(t: TestContext, { clockAheadMs = 60_000 }: { clockAheadMs?: number } = {}): Promise<Fixture> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ftown-store-index-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const reads: string[] = [];
  const readFile = fs.readFile;
  const beforeRead = new Map<string, () => Promise<void>>();
  const beforeStat = new Map<string, () => Promise<void>>();
  const stats = { inFlight: 0, maxInFlight: 0 };
  const once = async (hooks: Map<string, () => Promise<void>>, path: string): Promise<void> => {
    const hook = hooks.get(path);
    hooks.delete(path);
    await hook?.();
  };
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith('session.json')) reads.push(String(args[0]));
    await once(beforeRead, String(args[0]));
    return readFile(...args);
  });
  const fakeStats = new Map<string, BigIntStats>();
  const stat = fs.stat;
  t.mock.method(fs, 'stat', (async (...args: Parameters<typeof fs.stat>) => {
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      await once(beforeStat, String(args[0]));
      return fakeStats.get(String(args[0])) ?? await stat(...args);
    } finally {
      stats.inFlight--;
    }
  }) as typeof fs.stat);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const newStore = (): SessionStore => new SessionStore(dir, { now: () => Date.now() + clockAheadMs });
  return {
    dir,
    store: newStore(),
    newStore,
    reads,
    fakeStats,
    beforeRead,
    beforeStat,
    stats,
    uncached: () => new SessionStore(dir).listSessions(),
    recordPath: (id) => join(dir, 'sessions', id, 'session.json'),
  };
}

/** Compare the indexed store against an uncached scan, then clear the read log. */
async function assertMatchesUncached(f: Fixture): Promise<Session[]> {
  const listed = await f.store.listSessions();
  const indexedReads = [...f.reads];
  assert.deepStrictEqual(listed, await f.uncached());
  f.reads.length = 0;
  f.reads.push(...indexedReads);
  return listed;
}

test('an unchanged session directory is listed without reading any session.json', async (t) => {
  const f = await fixture(t);
  for (const id of ['a', 'bb', 'ccc']) await f.store.saveSession(makeSession(id));
  const fresh = f.newStore();
  const first = await fresh.listSessions();
  assert.equal(f.reads.length, 3);
  f.reads.length = 0;
  const second = await fresh.listSessions();
  assert.deepStrictEqual(f.reads, []);
  assert.deepStrictEqual(second, first);
  assert.deepStrictEqual(second.map((s) => s.id), ['ccc', 'bb', 'a']);
});

test('creates and updates through the store are visible in the same call, read back once', async (t) => {
  const f = await fixture(t);
  await f.store.saveSession(makeSession('a'));
  await f.store.saveSession(makeSession('bb'));
  assert.equal((await assertMatchesUncached(f)).length, 2);
  assert.deepStrictEqual(f.reads.sort(), [f.recordPath('a'), f.recordPath('bb')]);
  f.reads.length = 0;
  await f.store.listSessions();
  assert.deepStrictEqual(f.reads, []);

  await f.store.saveSession(makeSession('a', { status: 'completed', name: 'renamed' }));
  await f.store.saveSession(makeSession('ccc'));
  const listed = await assertMatchesUncached(f);
  assert.deepStrictEqual(f.reads.sort(), [f.recordPath('a'), f.recordPath('ccc')], 'only the saved records are re-read');
  assert.equal(listed.find((s) => s.id === 'a')?.name, 'renamed');
  assert.equal(listed.length, 3);
  assert.deepStrictEqual(await f.store.loadSession('a'), makeSession('a', { status: 'completed', name: 'renamed' }));
});

test('a record without optional fields round-trips exactly like an uncached read', async (t) => {
  const f = await fixture(t);
  const sparse = { ...makeSession('a'), pullRequestUrl: undefined } as Session;
  await f.store.saveSession(sparse);
  const [listed] = await assertMatchesUncached(f);
  assert.equal(Object.hasOwn(listed, 'pullRequestUrl'), false);
});

test('a direct file write is picked up and only that record is re-read', async (t) => {
  const f = await fixture(t);
  for (const id of ['a', 'bb', 'ccc']) await f.store.saveSession(makeSession(id));
  await f.store.listSessions();
  f.reads.length = 0;

  // Same byte length, written in place by "another process".
  const original = await fs.readFile(f.recordPath('bb'), 'utf-8');
  const rewritten = original.replace('"running"', '"stopped"');
  assert.equal(rewritten.length, original.length);
  f.reads.length = 0;
  await fs.writeFile(f.recordPath('bb'), rewritten);
  await fs.utimes(f.recordPath('bb'), new Date(1_800_000_000_000), new Date(1_800_000_000_000));

  const listed = await assertMatchesUncached(f);
  assert.deepStrictEqual(f.reads, [f.recordPath('bb')]);
  assert.equal(listed.find((s) => s.id === 'bb')?.status, 'stopped');
  assert.equal((await f.store.loadSession('bb'))?.status, 'stopped');
});

test('a record replaced by a same-size file with the same mtime is still detected (inode)', async (t) => {
  const f = await fixture(t);
  await f.store.saveSession(makeSession('a'));
  await f.store.listSessions();
  const path = f.recordPath('a');
  const before = await fs.stat(path);
  const original = await fs.readFile(path, 'utf-8');
  const replacement = `${path}.replacement`;
  await fs.writeFile(replacement, original.replace('"running"', '"stopped"'));
  await fs.utimes(replacement, before.atime, before.mtime);
  await fs.rename(replacement, path);
  f.reads.length = 0;
  const listed = await assertMatchesUncached(f);
  assert.equal(listed[0]?.status, 'stopped');
});

test('deleted sessions disappear whether removed through the store or from disk', async (t) => {
  const f = await fixture(t);
  for (const id of ['a', 'bb', 'ccc', 'dddd']) await f.store.saveSession(makeSession(id));
  await f.store.listSessions();

  await f.store.deleteSession('a');
  await fs.rm(join(f.dir, 'sessions', 'bb'), { recursive: true });
  await fs.rm(f.recordPath('ccc'));
  f.reads.length = 0;
  const listed = await assertMatchesUncached(f);
  assert.deepStrictEqual(listed.map((s) => s.id), ['dddd']);
  assert.deepStrictEqual(f.reads, []);
  assert.equal(await f.store.loadSession('a'), null);
  assert.equal(await f.store.loadSession('bb'), null);
  assert.equal(await f.store.loadSession('ccc'), null);
});

test('a directory recreated on disk after removal is listed again with its new content', async (t) => {
  const f = await fixture(t);
  await f.store.saveSession(makeSession('a'));
  await f.store.listSessions();
  await fs.rm(join(f.dir, 'sessions', 'a'), { recursive: true });
  assert.deepStrictEqual(await f.store.listSessions(), []);
  await fs.mkdir(join(f.dir, 'sessions', 'a'));
  await fs.writeFile(f.recordPath('a'), JSON.stringify(makeSession('a', { name: 'recreated' }), null, 2));
  const listed = await assertMatchesUncached(f);
  assert.equal(listed[0]?.name, 'recreated');
});

test('archive then revive under a new id matches an uncached scan at every step', async (t) => {
  const f = await fixture(t);
  const original = makeSession('a');
  await f.store.saveSession(original);
  await f.store.saveSession(makeSession('bb'));
  await f.store.listSessions();

  await f.store.archiveSession(original);
  await f.store.deleteSession(original.id);
  assert.deepStrictEqual((await assertMatchesUncached(f)).map((s) => s.id), ['bb']);

  const [tombstone] = await f.store.listArchived();
  const { removedAt: _removedAt, ...revived } = tombstone;
  await f.store.saveSession({ ...revived, id: 'revived' });
  // The removed id stays retired: saving it again must not resurrect a record.
  await f.store.saveSession(original);
  const listed = await assertMatchesUncached(f);
  assert.deepStrictEqual(listed.map((s) => s.id).sort(), ['bb', 'revived']);
});

test('callers cannot mutate the index through returned records', async (t) => {
  const f = await fixture(t);
  await f.store.saveSession(makeSession('a'));
  const [listed] = await f.store.listSessions();
  listed.name = 'mutated';
  listed.env!.TOKEN = 'mutated';
  const loaded = await f.store.loadSession('a');
  assert.ok(loaded);
  loaded.status = 'error';
  delete loaded.env!.NESTED;

  assert.deepStrictEqual(await f.store.listSessions(), [makeSession('a')]);
  assert.deepStrictEqual(await f.store.loadSession('a'), makeSession('a'));
  const again = await f.store.listSessions();
  assert.notEqual(again[0], (await f.store.listSessions())[0]);
});

test('the object passed to saveSession is not retained by the index', async (t) => {
  const f = await fixture(t);
  const session = makeSession('a');
  await f.store.saveSession(session);
  session.name = 'changed after save';
  assert.deepStrictEqual(await f.store.listSessions(), [makeSession('a')]);
});

test('a corrupt record keeps failing like an uncached scan and recovers once repaired', async (t) => {
  const f = await fixture(t);
  await f.store.saveSession(makeSession('a'));
  await f.store.listSessions();
  await fs.writeFile(f.recordPath('a'), '{ "id": ');
  await assert.rejects(f.store.listSessions(), SyntaxError);
  await assert.rejects(f.store.listSessions(), SyntaxError);
  await assert.rejects(f.store.loadSession('a'), SyntaxError);
  await assert.rejects(f.uncached(), SyntaxError);
  await fs.writeFile(f.recordPath('a'), JSON.stringify(makeSession('a', { name: 'repaired' })));
  assert.equal((await assertMatchesUncached(f))[0]?.name, 'repaired');
});

test('a missing sessions directory lists nothing, and non-directory entries are ignored', async (t) => {
  const f = await fixture(t);
  assert.deepStrictEqual(await f.store.listSessions(), []);
  await f.store.saveSession(makeSession('a'));
  await fs.writeFile(join(f.dir, 'sessions', 'stray-file'), 'x');
  await fs.mkdir(join(f.dir, 'sessions', 'empty-dir'));
  assert.deepStrictEqual((await assertMatchesUncached(f)).map((s) => s.id), ['a']);
  await fs.rm(join(f.dir, 'sessions'), { recursive: true });
  assert.deepStrictEqual(await f.store.listSessions(), []);
});

test('a rewrite with a different size and its mtime put back is detected', async (t) => {
  const f = await fixture(t);
  await f.store.saveSession(makeSession('a'));
  await f.store.listSessions();
  const path = f.recordPath('a');
  const before = await fs.stat(path);
  await fs.writeFile(path, JSON.stringify(makeSession('a', { name: 'a much longer name than before' }), null, 2));
  await fs.utimes(path, before.atime, before.mtime);
  const listed = await assertMatchesUncached(f);
  assert.equal(listed[0]?.name, 'a much longer name than before');
});

for (const field of ['ino', 'size', 'mtimeNs', 'ctimeNs'] as const) {
  test(`a change of ${field} alone invalidates an indexed record`, async (t) => {
    const f = await fixture(t);
    await f.store.saveSession(makeSession('a'));
    await f.store.saveSession(makeSession('bb'));
    await f.store.listSessions();
    const path = f.recordPath('a');
    const indexed = await fs.stat(path, { bigint: true });

    // New content on disk, but the filesystem reports the indexed stamp with
    // only this one field different.
    await fs.writeFile(path, JSON.stringify(makeSession('a', { name: 'changed' })));
    const reported = Object.assign(Object.create(Object.getPrototypeOf(indexed)) as BigIntStats, indexed);
    reported[field] = indexed[field] + 1n;
    f.fakeStats.set(path, reported);
    f.reads.length = 0;

    assert.equal((await f.store.listSessions()).find((s) => s.id === 'a')?.name, 'changed');
    assert.deepStrictEqual(f.reads, [path]);
    assert.equal((await f.store.loadSession('a'))?.name, 'changed');
  });
}

test('with the identical stamp reported, the indexed record is served without a read', async (t) => {
  const f = await fixture(t);
  await f.store.saveSession(makeSession('a'));
  await f.store.listSessions();
  const path = f.recordPath('a');
  f.fakeStats.set(path, await fs.stat(path, { bigint: true }));
  f.reads.length = 0;
  assert.equal((await f.store.loadSession('a'))?.name, 'session a');
  assert.deepStrictEqual(f.reads, []);
});

test('listing 900 sessions keeps yielding to the event loop, cached or not', async (t) => {
  const f = await fixture(t);
  const expected: string[] = [];
  for (let i = 0; i < 900; i++) {
    const id = `s${String(i).padStart(3, '0')}`;
    expected.push(id);
    await fs.mkdir(join(f.dir, 'sessions', id), { recursive: true });
    await fs.writeFile(f.recordPath(id), JSON.stringify(
      makeSession(id, { createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString() })));
  }
  const countTurns = async (work: () => Promise<Session[]>): Promise<{ turns: number; sessions: Session[] }> => {
    let turns = 0;
    let running = true;
    const spin = (): void => { if (running) { turns++; setImmediate(spin); } };
    setImmediate(spin);
    const sessions = await work();
    running = false;
    return { turns, sessions };
  };

  f.stats.maxInFlight = 0;
  const cold = await countTurns(() => f.store.listSessions());
  f.reads.length = 0;
  const warm = await countTurns(() => f.store.listSessions());
  assert.equal(f.stats.maxInFlight, 32, 'stats run in bounded batches');
  assert.deepStrictEqual(f.reads, []);
  assert.deepStrictEqual(warm.sessions, cold.sessions);
  assert.deepStrictEqual(warm.sessions.map((s) => s.id), [...expected].reverse());
  // 900 entries in batches of 32: the loop gets a turn between batches.
  assert.ok(warm.turns >= 20, `only ${warm.turns} event-loop turns during a cached listing`);
  assert.ok(cold.turns >= 20, `only ${cold.turns} event-loop turns during an uncached listing`);
});

test('a session removed while a cold listing is in flight is skipped, not fatal', async (t) => {
  const f = await fixture(t);
  for (const id of ['a', 'bb', 'ccc']) await f.store.saveSession(makeSession(id));
  const cold = f.newStore();
  // Stat'ed with its batch, gone by the time it is read.
  f.beforeRead.set(f.recordPath('bb'), () => fs.rm(join(f.dir, 'sessions', 'bb'), { recursive: true }));
  assert.deepStrictEqual((await cold.listSessions()).map((s) => s.id), ['ccc', 'a']);
  assert.deepStrictEqual(await cold.listSessions(), await f.uncached());

  // Same when only the record is replaced by something that is not a file path.
  f.beforeRead.set(f.recordPath('a'), async () => {
    await fs.rm(join(f.dir, 'sessions', 'a'), { recursive: true });
    await fs.writeFile(join(f.dir, 'sessions', 'a'), 'now a file');
  });
  const again = f.newStore();
  assert.deepStrictEqual((await again.listSessions()).map((s) => s.id), ['ccc']);
  assert.equal(await again.loadSession('a'), null);
});

test('a save overtaken by another writer does not index its own content', async (t) => {
  const f = await fixture(t);
  await f.store.saveSession(makeSession('a'));
  const path = f.recordPath('a');
  const theirs = makeSession('a', { name: 'written by another process, and longer' });
  await f.store.saveSession(makeSession('a', { name: 'ours' }));
  await fs.writeFile(path, JSON.stringify(theirs));

  assert.deepStrictEqual(await f.store.loadSession('a'), theirs);
  assert.deepStrictEqual(await f.store.listSessions(), [theirs]);
});

/**
 * Linux takes ctime from a coarse clock, so a same-size in-place rewrite within one tick of the
 * previous change reports exactly the stamp the store last saw. These force that collision on
 * every platform by reporting the earlier stamp again, with the store on the real clock.
 */
test('a just-read record rewritten in place with an identical stamp is never served stale', async (t) => {
  const f = await fixture(t, { clockAheadMs: 0 });
  await fs.mkdir(join(f.dir, 'sessions', 'a'), { recursive: true });
  const path = f.recordPath('a');
  await fs.writeFile(path, JSON.stringify(makeSession('a'), null, 2));
  assert.equal((await f.store.loadSession('a'))?.name, 'session a');
  // Every later stat reports this same stamp.
  f.fakeStats.set(path, await fs.stat(path, { bigint: true }));

  for (const name of ['session b', 'session c', 'session d']) {
    const current = await fs.readFile(path, 'utf-8');
    const rewritten = JSON.stringify(makeSession('a', { name }), null, 2);
    assert.equal(rewritten.length, current.length);
    await fs.writeFile(path, rewritten);
    assert.equal((await f.store.loadSession('a'))?.name, name);
    assert.equal((await f.store.listSessions())[0]?.name, name);
  }
});

test('a just-saved record rewritten in place with an identical stamp is never served stale', async (t) => {
  const f = await fixture(t, { clockAheadMs: 0 });
  await f.store.saveSession(makeSession('a', { name: 'ours' }));
  const path = f.recordPath('a');
  const published = await fs.stat(path, { bigint: true });
  const theirs = makeSession('a', { name: 'them' });
  await fs.writeFile(path, JSON.stringify(theirs, null, 2));
  assert.equal((await fs.stat(path)).size, Number(published.size));
  f.fakeStats.set(path, published);
  assert.deepStrictEqual(await f.store.loadSession('a'), theirs);
  assert.deepStrictEqual(await f.store.listSessions(), [theirs]);
});

test('with the real clock, a record quiet for longer than the margin is indexed', async (t) => {
  const f = await fixture(t, { clockAheadMs: 0 });
  await f.store.saveSession(makeSession('a'));
  const path = f.recordPath('a');
  const real = await fs.stat(path, { bigint: true });
  const old = BigInt(Date.now() - 60_000) * BigInt(1_000_000);
  const quiet = Object.assign(Object.create(Object.getPrototypeOf(real)) as BigIntStats, real, { mtimeNs: old, ctimeNs: old });
  f.fakeStats.set(path, quiet);
  assert.equal((await f.store.loadSession('a'))?.name, 'session a');
  f.reads.length = 0;
  assert.equal((await f.store.loadSession('a'))?.name, 'session a');
  assert.equal((await f.store.listSessions())[0]?.name, 'session a');
  assert.deepStrictEqual(f.reads, []);
});

test('listing prunes index entries of directories that are gone', async (t) => {
  const f = await fixture(t);
  for (const id of ['a', 'bb', 'ccc']) await f.store.saveSession(makeSession(id));
  await f.store.listSessions();
  const index = (f.store as unknown as { recordIndex: Map<string, unknown> }).recordIndex;
  assert.deepStrictEqual([...index.keys()].sort(), ['a', 'bb', 'ccc']);
  await fs.rm(join(f.dir, 'sessions', 'bb'), { recursive: true });
  await fs.rm(join(f.dir, 'sessions', 'ccc'), { recursive: true });
  await f.store.listSessions();
  assert.deepStrictEqual([...index.keys()], ['a']);
});
