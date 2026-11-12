import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
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
  /** What a store with an empty index returns: the uncached scan. */
  uncached(): Promise<Session[]>;
  recordPath(id: string): string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ftown-store-index-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const reads: string[] = [];
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith('session.json')) reads.push(String(args[0]));
    return readFile(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return {
    dir,
    store: new SessionStore(dir),
    reads,
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
  const fresh = new SessionStore(f.dir);
  const first = await fresh.listSessions();
  assert.equal(f.reads.length, 3);
  f.reads.length = 0;
  const second = await fresh.listSessions();
  assert.deepStrictEqual(f.reads, []);
  assert.deepStrictEqual(second, first);
  assert.deepStrictEqual(second.map((s) => s.id), ['ccc', 'bb', 'a']);
});

test('creates and updates through the store refresh the index in the same call', async (t) => {
  const f = await fixture(t);
  await f.store.saveSession(makeSession('a'));
  await f.store.saveSession(makeSession('bb'));
  assert.equal((await assertMatchesUncached(f)).length, 2);
  assert.deepStrictEqual(f.reads, [], 'records saved by this store are not read back');

  await f.store.saveSession(makeSession('a', { status: 'completed', name: 'renamed' }));
  await f.store.saveSession(makeSession('ccc'));
  f.reads.length = 0;
  const listed = await assertMatchesUncached(f);
  assert.deepStrictEqual(f.reads, []);
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
