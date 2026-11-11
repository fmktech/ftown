import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { toWireSession } from './session-wire.js';
import { PREVIEW_CHUNK_BYTES, PREVIEW_MAX_BYTES, PREVIEW_MAX_FILES, previewKindForPath } from './preview-protocol.js';
import { currentPreview, preparePreview, preparePreviewAdd, PreviewError, previewChunk, previewStatus, SessionPreviewReader, validPreviewId } from './session-preview.js';
import type { SessionPreviewSource } from './preview-protocol.js';
import type { Session } from './types.js';
import { SessionStore } from './session-store.js';

function makeSession(root: string): Session {
  return { id: 's', name: 'test', command: 'shell', bridgeId: 'b', status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workingDir: root };
}

async function assertPreviewError(promise: Promise<unknown>, reason: string): Promise<PreviewError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PreviewError, `expected PreviewError, got ${String(error)}`);
    assert.equal(error.reason, reason);
    return error;
  }
  assert.fail(`expected PreviewError(${reason})`);
}

test('kind by extension is case-insensitive; .txt and extensionless names are rejected', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(previewKindForPath('page.html'), 'html');
  assert.equal(previewKindForPath('page.HTM'), 'html');
  assert.equal(previewKindForPath('/some/dir/notes.md'), 'markdown');
  assert.equal(previewKindForPath('notes.MARKDOWN'), 'markdown');
  assert.equal(previewKindForPath('x.txt'), null);
  assert.equal(previewKindForPath('no-extension'), null);
  assert.equal(previewKindForPath('.html'), null);
  const session = makeSession(root);
  const txtPath = join(root, 'notes.txt');
  await writeFile(txtPath, 'plain');
  await assertPreviewError(preparePreview(session, [txtPath]), 'invalid_file');
  await writeFile(join(root, 'PAGE.HTML'), '<p>upper</p>');
  await writeFile(join(root, 'Notes.MD'), '# upper');
  const prepared = await preparePreview(session, [join(root, 'PAGE.HTML'), join(root, 'Notes.MD')]);
  assert.deepEqual(
    prepared.preview.files.map(file => [file.fileName, file.kind]),
    [['PAGE.HTML', 'html'], ['Notes.MD', 'markdown']],
  );
});

test('registration produces a registration-order descriptor with fresh ids; wire form strips previewSource', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'b.html'), '<p>b</p>');
  await writeFile(join(root, 'a.md'), '# a');
  const session = makeSession(root);
  const prepared = await preparePreview(session, [join(root, 'b.html'), join(root, 'a.md')]);
  assert.ok(validPreviewId(prepared.preview.id));
  assert.deepEqual(prepared.preview.files.map(file => file.fileName), ['b.html', 'a.md']);
  assert.deepEqual(prepared.preview.files.map(file => file.kind), ['html', 'markdown']);
  for (const file of prepared.preview.files) assert.ok(validPreviewId(file.id));
  assert.notEqual(prepared.preview.files[0].id, prepared.preview.files[1].id);
  assert.equal(prepared.previewSource.version, 2);
  assert.equal(prepared.previewSource.id, prepared.preview.id);
  assert.deepEqual(prepared.previewSource.files.map(file => file.id), prepared.preview.files.map(file => file.id));
  const wire = toWireSession({ ...session, preview: prepared.preview, previewSource: prepared.previewSource });
  assert.equal('previewSource' in wire, false);
  assert.equal(JSON.stringify(wire).includes(join(root, 'b.html')), false);
  assert.equal(JSON.stringify(wire).includes(join(root, 'a.md')), false);
  assert.deepEqual(wire.preview?.files.map(file => file.fileName), ['b.html', 'a.md']);
  // a second registration gets a fresh set id and fresh file ids
  const reRegistered = await preparePreview(session, [join(root, 'b.html'), join(root, 'a.md')]);
  assert.notEqual(reRegistered.preview.id, prepared.preview.id);
  assert.notDeepEqual(reRegistered.preview.files.map(file => file.id), prepared.preview.files.map(file => file.id));
});

test('the 13th file is rejected and the registered set is unchanged (all-or-nothing)', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths: string[] = [];
  for (let i = 0; i < PREVIEW_MAX_FILES; i++) {
    const path = join(root, `f${i}.html`);
    await writeFile(path, `<p>${i}</p>`);
    paths.push(path);
  }
  const session = makeSession(root);
  const twelve = await preparePreview(session, paths);
  assert.equal(twelve.preview.files.length, PREVIEW_MAX_FILES);
  session.preview = twelve.preview;
  session.previewSource = twelve.previewSource;
  const thirteenth = join(root, 'f12.html');
  await writeFile(thirteenth, '<p>13</p>');
  await assertPreviewError(preparePreview(session, [...paths, thirteenth]), 'invalid_file');
  assert.equal(session.preview?.id, twelve.preview.id);
  assert.equal(session.preview?.files.length, PREVIEW_MAX_FILES);
  assert.equal(session.previewSource?.id, twelve.preview.id);
  // one bad path among good ones also leaves the set unchanged
  await assertPreviewError(preparePreview(session, [paths[0], join(root, '..', 'outside.html')]), 'invalid_file');
  assert.equal(session.preview?.id, twelve.preview.id);
  // empty and non-array input are rejected
  await assertPreviewError(preparePreview(session, []), 'invalid_file');
  await assertPreviewError(preparePreview(session, paths[0]), 'invalid_file');
});

test('duplicate basenames are rejected and the duplicate is named', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'a'), { recursive: true });
  await mkdir(join(root, 'b'), { recursive: true });
  await writeFile(join(root, 'a', 'dup.html'), '<p>a</p>');
  await writeFile(join(root, 'b', 'dup.html'), '<p>b</p>');
  const session = makeSession(root);
  const error = await assertPreviewError(
    preparePreview(session, [join(root, 'a', 'dup.html'), join(root, 'b', 'dup.html')]),
    'invalid_file',
  );
  assert.match(error.message, /dup\.html/);
});

test('each file is validated independently: symlink or outside-workdir anywhere rejects the whole set', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const good = join(root, 'ok.html');
  const target = join(root, 'target.html');
  await writeFile(good, '<p>ok</p>');
  await writeFile(target, '<p>target</p>');
  const link = join(root, 'link.html');
  await symlink(target, link);
  const session = makeSession(root);
  await assertPreviewError(preparePreview(session, [link]), 'invalid_file');
  await assertPreviewError(preparePreview(session, [good, link]), 'invalid_file');
  await assertPreviewError(preparePreview(session, [good, join(root, '..', 'outside.html')]), 'invalid_file');
  await assertPreviewError(preparePreview(session, [root]), 'invalid_file');
  await assertPreviewError(preparePreview(session, [join(root, 'no.md')]), 'missing');
  const prepared = await preparePreview(session, [good]);
  assert.equal(prepared.preview.files[0].fileName, 'ok.html');
});

test('old persisted shape loads as no preview', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'page.html');
  await writeFile(path, '<p>x</p>');
  const session = makeSession(root);
  const id = randomUUID();
  // version-1 source with fileName descriptor
  session.preview = { id, fileName: 'page.html' } as never;
  session.previewSource = { version: 1, id, root: await realpath(root), filePath: path } as never;
  assert.equal(currentPreview(session, id), null);
  // files-array descriptor but version-1 source
  const prepared = await preparePreview(session, [path]);
  session.preview = prepared.preview;
  session.previewSource = { ...prepared.previewSource, version: 1 } as never;
  assert.equal(currentPreview(session, prepared.preview.id), null);
  // fileName descriptor but version-2 source
  session.preview = { id: prepared.preview.id, fileName: 'page.html' } as never;
  session.previewSource = prepared.previewSource;
  assert.equal(currentPreview(session, prepared.preview.id), null);
  // the valid v2 shape resolves
  session.preview = prepared.preview;
  assert.equal(currentPreview(session, prepared.preview.id)?.id, prepared.preview.id);
  assert.equal(currentPreview(session, randomUUID()), null);
});

test('status and chunk helpers thread fileId through; unknown fileId and stale previewId fail', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const htmlPath = join(root, 'page.html');
  const mdPath = join(root, 'notes.md');
  await writeFile(htmlPath, 'hello');
  await writeFile(mdPath, '# title');
  const session = makeSession(root);
  const prepared = await preparePreview(session, [htmlPath, mdPath]);
  session.preview = prepared.preview;
  session.previewSource = prepared.previewSource;
  const reader = new SessionPreviewReader();
  const source = currentPreview(session, prepared.preview.id);
  assert.ok(source);
  const htmlId = prepared.preview.files[0].id;
  const mdId = prepared.preview.files[1].id;
  const htmlSnapshot = await reader.read(session, source!, htmlId);
  assert.equal(htmlSnapshot.bytes.toString(), 'hello');
  assert.equal(htmlSnapshot.revision, createHash('sha256').update('hello').digest('hex'));
  const mdSnapshot = await reader.read(session, source!, mdId);
  assert.equal(mdSnapshot.bytes.toString(), '# title');
  assert.deepEqual(previewStatus(prepared.preview.id, htmlId, htmlSnapshot), {
    state: 'ready', previewId: prepared.preview.id, fileId: htmlId, revision: htmlSnapshot.revision, totalBytes: 5,
  });
  assert.deepEqual(previewStatus(prepared.preview.id, htmlId, htmlSnapshot, htmlSnapshot.revision), {
    state: 'unchanged', previewId: prepared.preview.id, fileId: htmlId, revision: htmlSnapshot.revision, totalBytes: 5,
  });
  assert.deepEqual(previewChunk(prepared.preview.id, htmlId, htmlSnapshot, htmlSnapshot.revision, 0), {
    state: 'chunk', previewId: prepared.preview.id, fileId: htmlId, revision: htmlSnapshot.revision,
    totalBytes: 5, offset: 0, dataBase64: Buffer.from('hello').toString('base64'), done: true,
  });
  // unknown fileId fails at the reader; a stale previewId resolves to no preview.
  // (Controller translation of these to unregistered/stale_revision is B2's scope.)
  await assertPreviewError(reader.read(session, source!, randomUUID()), 'invalid_file');
  assert.equal(currentPreview(session, randomUUID()), null);
});

test('bounded chunks and digest follow changes; missing and empty files behave', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'page.html');
  const bytes = Buffer.from(`<p>${'€'.repeat(40000)}</p>`);
  await writeFile(path, bytes);
  const session = makeSession(root);
  const prepared = await preparePreview(session, [path]);
  session.preview = prepared.preview;
  session.previewSource = prepared.previewSource;
  const reader = new SessionPreviewReader();
  const source = currentPreview(session, prepared.preview.id)!;
  const fileId = prepared.preview.files[0].id;
  const snapshot = await reader.read(session, source, fileId);
  const first = previewChunk(prepared.preview.id, fileId, snapshot, snapshot.revision, 0);
  const second = previewChunk(prepared.preview.id, fileId, snapshot, snapshot.revision, PREVIEW_CHUNK_BYTES);
  assert.ok(first.state === 'chunk' && second.state === 'chunk');
  if (first.state !== 'chunk' || second.state !== 'chunk') return;
  assert.deepEqual(Buffer.concat([Buffer.from(first.dataBase64, 'base64'), Buffer.from(second.dataBase64, 'base64')]), bytes);
  assert.equal(first.done, false);
  assert.equal(second.done, true);
  // misaligned offset is an invalid request; a wrong revision is stale
  assert.throws(() => previewChunk(prepared.preview.id, fileId, snapshot, snapshot.revision, 1), PreviewError);
  assert.deepEqual(previewChunk(prepared.preview.id, fileId, snapshot, 'a'.repeat(64), 0), { state: 'stale_revision' });
  // content changes produce a new revision
  await writeFile(path, Buffer.from(`<p>${'x'.repeat(bytes.length - 7)}</p>`));
  const changed = await reader.read(session, source, fileId);
  assert.notEqual(changed.revision, snapshot.revision);
  // a missing file reports reason 'missing'
  await unlink(path);
  await assertPreviewError(reader.read(session, source, fileId), 'missing');
  // an empty file is ready with one done chunk
  await writeFile(path, '');
  const empty = await reader.read(session, source, fileId);
  assert.equal(empty.bytes.length, 0);
  assert.deepEqual(previewChunk(prepared.preview.id, fileId, empty, empty.revision, 0), {
    state: 'chunk', previewId: prepared.preview.id, fileId, revision: empty.revision, totalBytes: 0, offset: 0, dataBase64: '', done: true,
  });
});

test('content reads reject invalid UTF-8, oversize and symlink swaps; oversize registration is too_large', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'page.html');
  await writeFile(path, '<p>ok</p>');
  const session = makeSession(root);
  const prepared = await preparePreview(session, [path]);
  session.preview = prepared.preview;
  session.previewSource = prepared.previewSource;
  const reader = new SessionPreviewReader();
  const source = currentPreview(session, prepared.preview.id)!;
  const fileId = prepared.preview.files[0].id;
  await writeFile(path, Buffer.from([0xff]));
  await assertPreviewError(reader.read(session, source, fileId), 'invalid_utf8');
  await writeFile(path, Buffer.alloc(PREVIEW_MAX_BYTES + 1));
  await assertPreviewError(reader.read(session, source, fileId), 'too_large');
  await assertPreviewError(preparePreview(makeSession(root), [path]), 'too_large');
  await writeFile(path, '<p>ok</p>');
  await unlink(path);
  await symlink(join(root, 'target.html'), path);
  await assertPreviewError(reader.read(session, source, fileId), 'invalid_file');
});

test('reader limits active file reads to four without an unbounded queue', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths: string[] = [];
  const names = ['a.html', 'b.html', 'c.html', 'd.html', 'e.html'];
  for (const name of names) {
    const path = join(root, name);
    await writeFile(path, `ok-${name}`);
    paths.push(path);
  }
  const session = makeSession(root);
  const prepared = await preparePreview(session, paths);
  let release!: () => void;
  let allOpened!: () => void;
  let count = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opened = new Promise<void>(resolve => { allOpened = resolve; });
  class HeldReader extends SessionPreviewReader {
    protected override async openFile(path: string) {
      count++;
      if (count === 4) allOpened();
      await gate;
      return super.openFile(path);
    }
  }
  const reader = new HeldReader();
  const source = prepared.previewSource;
  const active = prepared.preview.files.slice(0, 4).map(file => reader.read(session, source, file.id));
  await opened;
  await assertPreviewError(reader.read(session, source, prepared.preview.files[4].id), 'unavailable');
  release();
  const results = await Promise.all(active);
  for (const result of results) assert.equal(result.bytes.toString().startsWith('ok-'), true);
});

test('reader validates only the requested file: a deleted sibling does not affect the healthy file', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aPath = join(root, 'a.html');
  const bPath = join(root, 'b.md');
  await writeFile(aPath, '<p>a</p>');
  await writeFile(bPath, '# b');
  const session = makeSession(root);
  const prepared = await preparePreview(session, [aPath, bPath]);
  session.preview = prepared.preview;
  session.previewSource = prepared.previewSource;
  const reader = new SessionPreviewReader();
  const source = currentPreview(session, prepared.preview.id)!;
  const aId = prepared.preview.files[0].id;
  const bId = prepared.preview.files[1].id;
  await unlink(bPath);
  // The healthy file reads fine while its sibling is gone.
  const snapshot = await reader.read(session, source, aId);
  assert.equal(snapshot.bytes.toString(), '<p>a</p>');
  // The missing sibling alone reports missing.
  await assertPreviewError(reader.read(session, source, bId), 'missing');
  // A symlink-swapped sibling likewise does not affect the healthy read.
  await writeFile(join(root, 'target.html'), '<p>target</p>');
  await symlink(join(root, 'target.html'), bPath);
  const again = await reader.read(session, source, aId);
  assert.equal(again.bytes.toString(), '<p>a</p>');
  await assertPreviewError(reader.read(session, source, bId), 'invalid_file');
});

test('preparePreviewAdd validates only incoming paths and carries existing entries verbatim', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aPath = join(root, 'a.html');
  const bPath = join(root, 'b.md');
  const cPath = join(root, 'c.html');
  await writeFile(aPath, '<p>a</p>');
  await writeFile(bPath, '# b');
  await writeFile(cPath, '<p>c</p>');
  const session = makeSession(root);
  const first = await preparePreview(session, [aPath, bPath]);
  session.preview = first.preview;
  session.previewSource = first.previewSource;
  const aId = first.preview.files[0].id;
  const bId = first.preview.files[1].id;
  const bFilePath = first.previewSource.files[1].filePath;
  // Existing file deleted on disk: the add still succeeds and retains it.
  await unlink(bPath);
  const merged = await preparePreviewAdd(session, { preview: first.preview, previewSource: first.previewSource }, [cPath]);
  assert.deepEqual(merged.preview.files.map(file => file.fileName), ['a.html', 'b.md', 'c.html']);
  assert.equal(merged.preview.files[0].id, aId);
  assert.equal(merged.preview.files[1].id, bId);
  assert.equal(merged.previewSource.files[1].id, bId);
  assert.equal(merged.previewSource.files[1].filePath, bFilePath);
  assert.notEqual(merged.preview.id, first.preview.id);
  assert.notEqual(merged.preview.files[2].id, aId);
  assert.notEqual(merged.preview.files[2].id, bId);
  // A symlink-swapped existing file likewise does not block the add.
  await writeFile(join(root, 'target2.html'), '<p>target</p>');
  await symlink(join(root, 'target2.html'), bPath);
  const dPath = join(root, 'd.md');
  await writeFile(dPath, '# d');
  const merged2 = await preparePreviewAdd(session, { preview: merged.preview, previewSource: merged.previewSource }, [dPath]);
  assert.deepEqual(merged2.preview.files.map(file => file.fileName), ['a.html', 'b.md', 'c.html', 'd.md']);
  assert.equal(merged2.preview.files[1].id, bId);
  assert.equal(merged2.previewSource.files[1].filePath, bFilePath);
  // Incoming validation still bites: a missing incoming file is rejected.
  await assertPreviewError(
    preparePreviewAdd(session, { preview: merged.preview, previewSource: merged.previewSource }, [join(root, 'gone.html')]),
    'missing',
  );
  // Within-batch duplicates are still rejected with the duplicate named.
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'c.html'), '<p>other c</p>');
  const dupError = await assertPreviewError(
    preparePreviewAdd(session, { preview: merged.preview, previewSource: merged.previewSource }, [cPath, join(root, 'sub', 'c.html')]),
    'invalid_file',
  );
  assert.match(dupError.message, /c\.html/);
});

test('old persisted shape is dropped on store load (both fields, wire, and re-save)', async t => {
  const dataDir = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-store-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new SessionStore(dataDir);
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'page.html');
  await writeFile(path, '<p>x</p>');
  const legacyId = randomUUID();
  const legacy = {
    ...makeSession(root),
    id: 'legacy-1',
    preview: { id: legacyId, fileName: 'page.html' } as never,
    previewSource: { version: 1, id: legacyId, root: await realpath(root), filePath: path } as never,
  };
  await store.saveSession(legacy);
  const onDisk = await readFile(join(store.sessionDir('legacy-1'), 'session.json'), 'utf-8');
  assert.ok(onDisk.includes('previewSource'));
  const loaded = await store.loadSession('legacy-1');
  assert.ok(loaded);
  assert.equal(loaded.preview, undefined);
  assert.equal(loaded.previewSource, undefined);
  const wire = toWireSession(loaded);
  assert.equal('preview' in wire, false);
  assert.equal('previewSource' in wire, false);
  assert.equal(currentPreview(loaded, legacyId), null);
  // Re-saving the loaded (cleaned) session persists the drop.
  await store.saveSession(loaded);
  const cleaned = await readFile(join(store.sessionDir('legacy-1'), 'session.json'), 'utf-8');
  assert.equal(cleaned.includes('previewSource'), false);
  assert.equal(cleaned.includes('page.html'), false);
  // A valid v2 shape survives the same load untouched.
  const session = makeSession(root);
  session.id = 'valid-1';
  const prepared = await preparePreview(session, [path]);
  session.preview = prepared.preview;
  session.previewSource = prepared.previewSource;
  await store.saveSession(session);
  const reloaded = await store.loadSession('valid-1');
  assert.ok(reloaded?.preview);
  assert.ok(reloaded?.previewSource);
  assert.equal(reloaded.preview.id, prepared.preview.id);
  assert.equal(reloaded.previewSource.version, 2);
  assert.equal(currentPreview(reloaded, prepared.preview.id)?.id, prepared.preview.id);
});

test('a file growing beyond the cap after stat is rejected before unbounded allocation', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'x.html');
  await writeFile(path, 'ok');
  const session = makeSession(root);
  const prepared = await preparePreview(session, [path]);
  class GrowingReader extends SessionPreviewReader {
    protected override async initialStat(handle: FileHandle) {
      const before = await super.initialStat(handle);
      await appendFile(path, Buffer.alloc(PREVIEW_MAX_BYTES));
      return before;
    }
  }
  await assertPreviewError(
    new GrowingReader().read(session, prepared.previewSource, prepared.preview.files[0].id),
    'too_large',
  );
});
