import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CHUNK_BYTES, extractSnapshot, installSnapshot, readSnapshot, sha256 } from './folder-snapshot.js';
import { FolderTransfers } from './folder-transfer.js';
import { TransferJournal } from './folder-transfer-journal.js';
import type { PeerControl } from './peer-control.js';

const sourceEndpoint = 'paired-sender';
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-transfer-test-'));
  const source = join(dir, 'source');
  const destination = join(dir, 'destination');
  const journalPath = join(dir, 'journal');
  const peers = {
    resolve: () => ({ bridgeId: 'peer', endpoint: { id: sourceEndpoint } }),
    connectDirect: async () => false,
    directHttp: async () => assert.fail('No data exchange without a direct link'),
  } as unknown as PeerControl;
  const open = () => new FolderTransfers(peers, new TransferJournal(journalPath));
  const transfers = open();
  await mkdir(source);
  await writeFile(join(source, 'fixture'), 'synthetic data');
  t.after(async () => {
    await transfers.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, source, destination, transfers, open, journalPath };
}

type Status = { id: string; state: string; error?: string; bytes: number };
async function prepare(transfers: FolderTransfers, path: string): Promise<string> {
  return ((await transfers.local({ action: 'receive', bridge: 'sender', path })) as Status).id;
}

async function waitFor(transfers: FolderTransfers, id: string, wanted: string, signal: AbortSignal): Promise<Status> {
  for (;;) {
    const status = await transfers.local({ action: 'status', id }) as Status;
    if (status.state === wanted) return status;
    assert.ok(['connecting', 'copying', 'installing', 'verifying'].includes(status.state), JSON.stringify(status));
    await delay(10, undefined, { signal });
  }
}

async function transmit(transfers: FolderTransfers, id: string, source: string, corruptDigest = false): Promise<void> {
  const hash = sha256();
  let offset = 0;
  await transfers.wire(sourceEndpoint, { action: 'begin', id });
  for await (const block of readSnapshot(source, new AbortController().signal)) {
    hash.update(block);
    await transfers.wire(sourceEndpoint, { action: 'chunk', id, offset, chunk: block.toString('base64') });
    offset += block.length;
  }
  await transfers.wire(sourceEndpoint, { action: 'verify', id, bytes: offset, digest: corruptDigest ? '0'.repeat(64) : hash.digest('hex') });
}

test('receiver refuses existing destinations and binds an invitation to its chosen sender', async t => {
  const { transfers, destination, dir } = await fixture(t);
  await mkdir(destination);
  await assert.rejects(prepare(transfers, destination), /Destination already exists/);
  assert.deepEqual(await readdir(destination), []);
  await rm(destination, { recursive: true });
  const id = await prepare(transfers, destination);
  for (const action of ['begin', 'status', 'cancel']) {
    await assert.rejects(transfers.wire('other-peer', { id, action }), /No matching receive invitation/);
  }
  await transfers.wire(sourceEndpoint, { action: 'begin', id });
  await transfers.wire(sourceEndpoint, { action: 'chunk', id, offset: 0, chunk: Buffer.from('partial').toString('base64') });
  assert.equal((await transfers.local({ action: 'cancel', id }) as Status).state, 'cancelled');
  assert.equal((await transfers.wire(sourceEndpoint, { action: 'status', id })).state, 'cancelled');
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('.ftown-transfer-')));
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('a sender reports a missing direct link and starts no data exchange', { timeout: 5_000 }, async t => {
  const { transfers, source } = await fixture(t);
  const id = crypto.randomUUID();
  await transfers.local({ action: 'send', bridge: 'recipient', path: source, id });
  const status = await waitFor(transfers, id, 'failed', t.signal);
  assert.match(status.error!, /No direct bridge link/);
});

test('a mismatched envelope checksum leaves no destination or retained spool', { timeout: 5_000 }, async t => {
  const { transfers, source, destination, dir, journalPath } = await fixture(t);
  const id = await prepare(transfers, destination);
  await transmit(transfers, id, source, true);
  const failed = await waitFor(transfers, id, 'failed', t.signal);
  assert.match(failed.error!, /checksum mismatch/);
  // close waits for the cleanup already in progress.
  await transfers.close();
  assert.deepEqual(await readdir(journalPath), []);
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('.ftown-transfer-')));
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('a destination created after begin stays intact and the verified copy retries after restart', { timeout: 5_000 }, async t => {
  const { transfers, source, destination, dir, open, journalPath } = await fixture(t);
  const id = await prepare(transfers, destination);
  await transfers.wire(sourceEndpoint, { action: 'begin', id });
  const blocks: Buffer[] = [];
  for await (const block of readSnapshot(source, t.signal)) blocks.push(Buffer.from(block));
  const snapshot = Buffer.concat(blocks);
  await transfers.wire(sourceEndpoint, { action: 'chunk', id, offset: 0, chunk: snapshot.toString('base64') });
  await mkdir(destination);
  await writeFile(join(destination, 'existing'), 'leave this alone');
  await transfers.wire(sourceEndpoint, { action: 'verify', id, bytes: snapshot.length, digest: sha256().update(snapshot).digest('hex') });
  await waitFor(transfers, id, 'retained', t.signal);
  assert.deepEqual(await readdir(destination), ['existing']);
  await transfers.close();

  const recovered = open();
  t.after(() => recovered.close());
  const saved = await recovered.local({ action: 'status', id }) as Status;
  assert.equal(saved.state, 'retained');
  assert.equal(saved.bytes, snapshot.length);
  await rm(destination, { recursive: true });
  await rm(source, { recursive: true });
  await recovered.local({ action: 'retry', id });
  await waitFor(recovered, id, 'installed', t.signal);
  assert.equal(await readFile(join(destination, 'fixture'), 'utf8'), 'synthetic data');
  await recovered.close();
  assert.deepEqual(await readdir(journalPath), []);
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('.ftown-transfer-')));
});

test('exclusive install refuses an existing empty directory', { timeout: 5_000 }, async t => {
  const { dir, destination } = await fixture(t);
  const tree = join(dir, 'tree');
  await mkdir(tree);
  await mkdir(destination);
  await assert.rejects(installSnapshot(tree, destination, t.signal), /Exclusive install failed/);
  assert.deepEqual(await readdir(destination), []);
  assert.ok((await lstat(tree)).isDirectory());
});

test('sender rejects symlinks and privileged file modes', async t => {
  const { source, dir } = await fixture(t);
  const consume = async () => {
    for await (const _block of readSnapshot(source, t.signal)) { /* consume */ }
  };
  const outside = join(dir, 'outside');
  await writeFile(outside, 'synthetic outside root');
  await symlink(outside, join(source, 'link'));
  await assert.rejects(consume(), /Cannot read a stable folder snapshot/);
  await rm(join(source, 'link'));
  await chmod(join(source, 'fixture'), 0o6755);
  await assert.rejects(consume(), /Cannot read a stable folder snapshot/);
});

test('receiver rejects absolute and traversing paths, duplicates, and invalid file hashes', async t => {
  const { dir } = await fixture(t);
  const footer = Buffer.alloc(4);
  const header = (path: string, size: number | null) => {
    const json = Buffer.from(JSON.stringify({ path, size }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    return Buffer.concat([length, json]);
  };
  const bad = [
    { snapshot: header('/absolute', null), error: /Invalid snapshot path/ },
    { snapshot: header('../escape', null), error: /Invalid snapshot path/ },
    { snapshot: header('a/'.concat('x'.repeat(256)), null), error: /Invalid snapshot path/ },
    { snapshot: Buffer.concat([header('a', null), header('a', null)]), error: /Invalid snapshot entry order/ },
    { snapshot: Buffer.concat([header('a', null), header('A/b', null)]), error: /Invalid snapshot entry order/ },
    { snapshot: Buffer.concat([header('file', 1), Buffer.from('x'), Buffer.alloc(32)]), error: /file verification failed/ },
  ];
  for (const [i, { snapshot, error }] of bad.entries()) {
    const root = join(dir, `tree-${i}`);
    const spool = join(dir, `spool-${i}`);
    await mkdir(root, { mode: 0o700 });
    const archive = Buffer.concat([snapshot, footer]);
    await writeFile(spool, archive);
    await assert.rejects(extractSnapshot(spool, root, archive.length, sha256().update(archive).digest('hex'), t.signal), error);
  }
});

test('the receiver bounds the chunk window and rejects gaps and duplicate offsets', async t => {
  const { transfers, destination } = await fixture(t);
  const id = await prepare(transfers, destination);
  const chunk = Buffer.alloc(CHUNK_BYTES, 42).toString('base64');
  const block = (offset: number) => transfers.wire(sourceEndpoint, { action: 'chunk', id, offset, chunk });
  await transfers.wire(sourceEndpoint, { action: 'begin', id });
  assert.equal((await block(CHUNK_BYTES)).bytes, 0);
  await assert.rejects(block(CHUNK_BYTES), /Invalid snapshot block/);
  await assert.rejects(block(4 * CHUNK_BYTES), /Invalid snapshot block/);
  await assert.rejects(transfers.wire(sourceEndpoint, {
    action: 'verify', id, bytes: 2 * CHUNK_BYTES, digest: '0'.repeat(64),
  }), /Invalid snapshot checksum/);
  assert.equal((await block(0)).bytes, 2 * CHUNK_BYTES);
  assert.equal((await transfers.wire(sourceEndpoint, { action: 'cancel', id })).state, 'cancelled');
});

test('discard removes a retained snapshot and its journal', { timeout: 5_000 }, async t => {
  const { transfers, source, destination, dir, journalPath } = await fixture(t);
  const id = await prepare(transfers, destination);
  await transfers.wire(sourceEndpoint, { action: 'begin', id });
  let offset = 0;
  const hash = sha256();
  for await (const block of readSnapshot(source, t.signal)) {
    hash.update(block);
    await transfers.wire(sourceEndpoint, { action: 'chunk', id, offset, chunk: block.toString('base64') });
    offset += block.length;
  }
  await mkdir(destination);
  await transfers.wire(sourceEndpoint, { action: 'verify', id, bytes: offset, digest: hash.digest('hex') });
  await waitFor(transfers, id, 'retained', t.signal);
  assert.equal((await transfers.local({ action: 'discard', id }) as Status).state, 'cancelled');
  assert.deepEqual(await readdir(journalPath), []);
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('.ftown-transfer-')));
  assert.deepEqual(await readdir(destination), []);
});

test('startup removes staged partial data from interrupted receivers', async t => {
  const { transfers, destination, dir, open, journalPath } = await fixture(t);
  const id = await prepare(transfers, destination);
  await transfers.wire(sourceEndpoint, { action: 'begin', id });
  await transfers.wire(sourceEndpoint, { action: 'chunk', id, offset: 0, chunk: Buffer.from('partial').toString('base64') });
  const creating = crypto.randomUUID();
  const emptyStage = join(dir, `.ftown-transfer-${crypto.randomUUID()}`);
  await new TransferJournal(journalPath).save(creating, {
    destination: join(dir, 'another-destination'), endpoint: sourceEndpoint, stage: emptyStage,
  });
  await mkdir(emptyStage, { mode: 0o700 });
  // Open a fresh instance without the original shutdown cleanup, including a
  // second transfer interrupted between staging directory creation and journaling its inode.
  const recovered = open();
  t.after(() => recovered.close());
  const status = await recovered.local({ action: 'status', id }) as Status;
  assert.equal(status.state, 'failed');
  assert.deepEqual(await readdir(journalPath), []);
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('.ftown-transfer-')));
});
