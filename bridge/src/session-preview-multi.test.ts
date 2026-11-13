import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionController, type SessionStoreLike } from './session-controller.js';
import type { Session } from './types.js';
import { createCommandHandler, type CommandRpcDeps } from './command-rpc.js';
import type { Command, CommandResponse } from './types.js';
import { runSessions } from './sessions-commands.js';
import { secureFixture } from './security/bridge/fixtures.test.js';

function makeFakeStore(initial: Session[] = []): SessionStoreLike & { sessions: Map<string, Session>; saved: Session[] } {
  const sessions = new Map(initial.map((s) => [s.id, s]));
  const saved: Session[] = [];
  return {
    sessions,
    saved,
    loadSession: async (id) => sessions.get(id) ?? null,
    saveSession: async (session) => {
      saved.push({ ...session });
      sessions.set(session.id, session);
    },
    listSessions: async () => [...sessions.values()],
    clearTerminalLog: async () => {},
  };
}

function setup(initial: Session[] = []) {
  const store = makeFakeStore(initial);
  const published: Session[] = [];
  const controller = new SessionController({
    store,
    runner: { stop: () => false },
    publishSessionUpdate: async (session) => { published.push({ ...session }); },
    removeSession: async (sessionId) => store.sessions.get(sessionId) ?? null,
    withSessionWrite: (_sessionId, task) => task(),
  });
  return { controller, store, published };
}

function makeSession(root: string, overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1', name: 'test', command: 'shell', bridgeId: 'bridge-1', status: 'completed',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workingDir: root,
    ...overrides,
  };
}

test('addPreview appends with new ids and re-registers in place, preserving untouched ids', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-multi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aPath = join(root, 'a.html');
  const bPath = join(root, 'b.md');
  const cPath = join(root, 'c.html');
  await writeFile(aPath, '<p>a</p>');
  await writeFile(bPath, '# b');
  await writeFile(cPath, '<p>c</p>');
  const session = makeSession(root);
  const { controller, store } = setup([session]);
  const first = await controller.setPreview('sess-1', [aPath, bPath]);
  assert.ok(first.ok);
  if (!first.ok) return;
  const firstSetId = first.session.preview!.id;
  const aId = first.session.preview!.files[0].id;
  const bId = first.session.preview!.files[1].id;
  // Append c.html -> new set id, a/b ids preserved, c fresh
  const appended = await controller.addPreview('sess-1', [cPath]);
  assert.ok(appended.ok);
  if (!appended.ok) return;
  assert.notEqual(appended.session.preview!.id, firstSetId);
  assert.deepEqual(appended.session.preview!.files.map((f) => f.fileName), ['a.html', 'b.md', 'c.html']);
  assert.equal(appended.session.preview!.files[0].id, aId);
  assert.equal(appended.session.preview!.files[1].id, bId);
  assert.ok(appended.session.preview!.files[2].id);
  assert.notEqual(appended.session.preview!.files[2].id, aId);
  assert.notEqual(appended.session.preview!.files[2].id, bId);
  // Re-register b.md in place -> same position, new file id, new set id, a/c preserved
  const bIdBefore = appended.session.preview!.files[1].id;
  const setBefore = appended.session.preview!.id;
  await writeFile(bPath, '# b v2');
  const reRegistered = await controller.addPreview('sess-1', [bPath]);
  assert.ok(reRegistered.ok);
  if (!reRegistered.ok) return;
  assert.notEqual(reRegistered.session.preview!.id, setBefore);
  assert.deepEqual(reRegistered.session.preview!.files.map((f) => f.fileName), ['a.html', 'b.md', 'c.html']);
  assert.equal(reRegistered.session.preview!.files[0].id, aId);
  assert.notEqual(reRegistered.session.preview!.files[1].id, bIdBefore);
  assert.equal(reRegistered.session.preview!.files[2].id, appended.session.preview!.files[2].id);
  // add with no existing preview behaves like setPreview
  const { controller: fresh, store: freshStore } = setup([makeSession(root)]);
  const added = await fresh.addPreview('sess-1', [aPath]);
  assert.ok(added.ok);
  if (added.ok) assert.deepEqual(added.session.preview!.files.map((f) => f.fileName), ['a.html']);
  // HTTP/CLI mapping note: real HTTP envelope is exercised by e2e/session-preview.spec.ts via CLI; here controller is the engine.
  assert.equal(freshStore.saved.length, 1);
  assert.equal(store.saved.length, 3);
});

test('removePreview keeps remaining ids, changes set id, clears on last removal, errors on unknown name', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-multi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aPath = join(root, 'a.html');
  const bPath = join(root, 'b.md');
  await writeFile(aPath, '<p>a</p>');
  await writeFile(bPath, '# b');
  const session = makeSession(root);
  const { controller, store } = setup([session]);
  const set = await controller.setPreview('sess-1', [aPath, bPath]);
  assert.ok(set.ok);
  if (!set.ok) return;
  const setId = set.session.preview!.id;
  const aId = set.session.preview!.files[0].id;
  const bId = set.session.preview!.files[1].id;
  const unknown = await controller.removePreview('sess-1', ['missing.html']);
  assert.ok(!unknown.ok);
  if (!unknown.ok) {
    assert.equal(unknown.code, 'invalid');
    assert.match(unknown.message, /missing\.html/);
  }
  assert.equal(store.sessions.get('sess-1')!.preview!.id, setId);
  assert.equal(store.saved.length, 1);
  const removed = await controller.removePreview('sess-1', ['b.md']);
  assert.ok(removed.ok);
  if (!removed.ok) return;
  assert.notEqual(removed.session.preview!.id, setId);
  assert.deepEqual(removed.session.preview!.files.map((f) => f.fileName), ['a.html']);
  assert.equal(removed.session.preview!.files[0].id, aId);
  assert.equal(removed.session.preview!.files[0].kind, 'html');
  assert.equal(removed.session.previewSource!.id, removed.session.preview!.id);
  assert.deepEqual(removed.session.previewSource!.files.map((f) => f.id), [aId]);
  assert.notEqual(bId, aId);
  const cleared = await controller.removePreview('sess-1', ['a.html']);
  assert.ok(cleared.ok);
  if (!cleared.ok) return;
  assert.equal(cleared.session.preview, undefined);
  assert.equal(cleared.session.previewSource, undefined);
  assert.equal(store.saved.length, 3);
  // removing from a session with no preview reports the first unknown name
  const noPreview = await controller.removePreview('sess-1', ['a.html']);
  assert.ok(!noPreview.ok);
  if (!noPreview.ok) assert.match(noPreview.message, /a\.html/);
});

test('all-or-nothing: one bad path or duplicate basename leaves the set unchanged and names the duplicate', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-multi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aPath = join(root, 'a.html');
  const linkTarget = join(root, 'target.html');
  const linkPath = join(root, 'link.html');
  await writeFile(aPath, '<p>a</p>');
  await writeFile(linkTarget, '<p>target</p>');
  await symlink(linkTarget, linkPath);
  await mkdir(join(root, 'sub1'), { recursive: true });
  await mkdir(join(root, 'sub2'), { recursive: true });
  const dup1 = join(root, 'sub1', 'dup.html');
  const dup2 = join(root, 'sub2', 'dup.html');
  await writeFile(dup1, '<p>1</p>');
  await writeFile(dup2, '<p>2</p>');
  const session = makeSession(root);
  const { controller, store } = setup([session]);
  const set = await controller.setPreview('sess-1', [aPath]);
  assert.ok(set.ok);
  if (!set.ok) return;
  const setId = set.session.preview!.id;
  // one symlink among good paths: rejected, set unchanged
  const bad = await controller.addPreview('sess-1', [linkPath]);
  assert.ok(!bad.ok);
  if (!bad.ok) assert.equal(bad.code, 'invalid');
  assert.equal(store.sessions.get('sess-1')!.preview!.id, setId);
  assert.equal(store.sessions.get('sess-1')!.preview!.files.length, 1);
  assert.equal(store.saved.length, 1);
  // duplicate basenames inside a replace: detail must surface, set unchanged
  const dup = await controller.setPreview('sess-1', [dup1, dup2]);
  assert.ok(!dup.ok);
  if (!dup.ok) {
    assert.equal(dup.code, 'invalid');
    assert.match(dup.message, /duplicate basename: dup\.html/);
  }
  assert.equal(store.sessions.get('sess-1')!.preview!.id, setId);
  // duplicate basenames inside an --add batch are also rejected
  const dupAdd = await controller.addPreview('sess-1', [dup1, dup2]);
  assert.ok(!dupAdd.ok);
  if (!dupAdd.ok) assert.match(dupAdd.message, /duplicate basename: dup\.html/);
  assert.equal(store.sessions.get('sess-1')!.preview!.id, setId);
  assert.equal(store.saved.length, 1);
  // 13th file via --add is rejected without changing the set
  const many: string[] = [];
  for (let i = 0; i < 12; i++) {
    const path = join(root, `m${i}.md`);
    await writeFile(path, `# ${i}`);
    many.push(path);
  }
  const twelve = await controller.setPreview('sess-1', many);
  assert.ok(twelve.ok);
  if (!twelve.ok) return;
  const twelveId = twelve.session.preview!.id;
  const thirteenth = join(root, 'm12.md');
  await writeFile(thirteenth, '# 13');
  const overflow = await controller.addPreview('sess-1', [thirteenth]);
  assert.ok(!overflow.ok);
  if (!overflow.ok) {
    assert.equal(overflow.code, 'invalid');
    assert.match(overflow.message, /Preview file limit is 12 files: 13 would be registered/);
  }
  assert.equal(store.sessions.get('sess-1')!.preview!.id, twelveId);
  assert.equal(store.sessions.get('sess-1')!.preview!.files.length, 12);
});

test('status and chunk fail for unknown fileId or stale previewId, validate ids, keep fileId on unavailable', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-multi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aPath = join(root, 'a.html');
  const bPath = join(root, 'b.md');
  await writeFile(aPath, '<p>a</p>');
  await writeFile(bPath, '# b');
  const session = makeSession(root);
  const { controller } = setup([session]);
  const set = await controller.setPreview('sess-1', [aPath, bPath]);
  assert.ok(set.ok);
  if (!set.ok) return;
  const previewId = set.session.preview!.id;
  const fileId = set.session.preview!.files[0].id;
  const unknownFile = randomUUID();
  const stalePreview = randomUUID();
  const statusUnknownFile = await controller.getPreviewStatus('sess-1', previewId, unknownFile);
  assert.deepEqual(statusUnknownFile, { ok: true, preview: { state: 'unregistered' } });
  const statusStale = await controller.getPreviewStatus('sess-1', stalePreview, fileId);
  assert.deepEqual(statusStale, { ok: true, preview: { state: 'unregistered' } });
  const chunkUnknownFile = await controller.getPreviewChunk('sess-1', previewId, unknownFile, 'a'.repeat(64), 0);
  assert.deepEqual(chunkUnknownFile, { ok: true, preview: { state: 'stale_revision' } });
  const chunkStale = await controller.getPreviewChunk('sess-1', stalePreview, fileId, 'a'.repeat(64), 0);
  assert.deepEqual(chunkStale, { ok: true, preview: { state: 'stale_revision' } });
  const badFile = await controller.getPreviewStatus('sess-1', previewId, 'not-a-uuid');
  assert.deepEqual(badFile, { ok: false, code: 'invalid', message: 'Invalid preview request' });
  const badPreview = await controller.getPreviewStatus('sess-1', 'bad', fileId);
  assert.deepEqual(badPreview, { ok: false, code: 'invalid', message: 'Invalid preview request' });
  const missingSession = await controller.getPreviewStatus('nope', previewId, fileId);
  assert.deepEqual(missingSession, { ok: false, code: 'not_found', message: 'Session not found' });
  const good = await controller.getPreviewStatus('sess-1', previewId, fileId);
  assert.ok(good.ok);
  if (good.ok && good.preview.state !== 'unavailable') assert.equal(good.preview.state, 'ready');
  // unavailable still carries fileId (missing file after registration)
  await rm(aPath, { force: true });
  const gone = await controller.getPreviewStatus('sess-1', previewId, fileId);
  assert.ok(gone.ok);
  if (gone.ok) {
    assert.equal(gone.preview.state, 'unavailable');
    if (gone.preview.state === 'unavailable') assert.equal(gone.preview.fileId, fileId);
  }
  const goneChunk = await controller.getPreviewChunk('sess-1', previewId, fileId, 'a'.repeat(64), 0);
  assert.ok(goneChunk.ok);
  if (goneChunk.ok) {
    assert.equal(goneChunk.preview.state, 'unavailable');
    if (goneChunk.preview.state === 'unavailable') assert.equal(goneChunk.preview.fileId, fileId);
  }
});

test('old persisted shape (version:1) loads as no preview for status, chunk and remove', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-multi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'page.html');
  await writeFile(path, '<p>x</p>');
  const id = randomUUID();
  const fileId = randomUUID();
  const session = makeSession(root, {
    preview: { id, fileName: 'page.html' } as never,
    previewSource: { version: 1, id, root: await realpath(root), filePath: path } as never,
  });
  const { controller } = setup([session]);
  const status = await controller.getPreviewStatus('sess-1', id, fileId);
  assert.deepEqual(status, { ok: true, preview: { state: 'unregistered' } });
  const chunk = await controller.getPreviewChunk('sess-1', id, fileId, 'a'.repeat(64), 0);
  assert.deepEqual(chunk, { ok: true, preview: { state: 'stale_revision' } });
  const removed = await controller.removePreview('sess-1', ['page.html']);
  assert.ok(!removed.ok);
  if (!removed.ok) assert.match(removed.message, /page\.html/);
});

test('deleted sibling does not affect healthy file status/chunk; missing file reports missing only', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-multi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aPath = join(root, 'a.html');
  const bPath = join(root, 'b.md');
  await writeFile(aPath, '<p>a</p>');
  await writeFile(bPath, '# b');
  const session = makeSession(root);
  const { controller } = setup([session]);
  const set = await controller.setPreview('sess-1', [aPath, bPath]);
  assert.ok(set.ok);
  if (!set.ok) return;
  const previewId = set.session.preview!.id;
  const aId = set.session.preview!.files[0].id;
  const bId = set.session.preview!.files[1].id;
  await rm(bPath, { force: true });
  // Healthy sibling still ready + chunkable while b.md is missing.
  const good = await controller.getPreviewStatus('sess-1', previewId, aId);
  assert.ok(good.ok);
  if (!good.ok) return;
  assert.equal(good.preview.state, 'ready');
  if (!good.ok || good.preview.state !== 'ready') return;
  const chunk = await controller.getPreviewChunk('sess-1', previewId, aId, good.preview.revision, 0);
  assert.ok(chunk.ok);
  if (chunk.ok && chunk.preview.state === 'chunk') assert.equal(Buffer.from(chunk.preview.dataBase64, 'base64').toString(), '<p>a</p>');
  else assert.fail('expected chunk state');
  // Missing file alone reports unavailable/missing.
  const gone = await controller.getPreviewStatus('sess-1', previewId, bId);
  assert.ok(gone.ok);
  if (gone.ok) {
    assert.equal(gone.preview.state, 'unavailable');
    if (gone.preview.state === 'unavailable') {
      assert.equal(gone.preview.fileId, bId);
      assert.equal(gone.preview.reason, 'missing');
    }
  }
});

test('--add succeeds while an existing file is missing or swapped; entries retained verbatim', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-multi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aPath = join(root, 'a.html');
  const bPath = join(root, 'b.md');
  const cPath = join(root, 'c.html');
  await writeFile(aPath, '<p>a</p>');
  await writeFile(bPath, '# b');
  await writeFile(cPath, '<p>c</p>');
  const session = makeSession(root);
  const { controller, store } = setup([session]);
  const set = await controller.setPreview('sess-1', [aPath, bPath]);
  assert.ok(set.ok);
  if (!set.ok) return;
  const aId = set.session.preview!.files[0].id;
  const bId = set.session.preview!.files[1].id;
  const bFilePath = set.session.previewSource!.files[1].filePath;
  await rm(bPath, { force: true });
  // Existing b.md deleted: --add still succeeds, b retained with same id/path.
  const appended = await controller.addPreview('sess-1', [cPath]);
  assert.ok(appended.ok);
  if (!appended.ok) return;
  assert.deepEqual(appended.session.preview!.files.map((f) => f.fileName), ['a.html', 'b.md', 'c.html']);
  assert.equal(appended.session.preview!.files[0].id, aId);
  assert.equal(appended.session.preview!.files[1].id, bId);
  assert.equal(appended.session.previewSource!.files[1].id, bId);
  assert.equal(appended.session.previewSource!.files[1].filePath, bFilePath);
  assert.equal(store.saved.length, 2);
  const previewId = appended.session.preview!.id;
  const bGone = await controller.getPreviewStatus('sess-1', previewId, bId);
  assert.ok(bGone.ok);
  if (bGone.ok && bGone.preview.state === 'unavailable') assert.equal(bGone.preview.reason, 'missing');
  else assert.fail('expected unavailable/missing for deleted b.md');
  const aGood = await controller.getPreviewStatus('sess-1', previewId, aId);
  assert.ok(aGood.ok);
  if (aGood.ok) assert.equal(aGood.preview.state, 'ready');
  // Swapping b.md to a symlink also does not block --add.
  await writeFile(join(root, 'target.html'), '<p>target</p>');
  await rm(bPath, { force: true });
  await symlink(join(root, 'target.html'), bPath);
  const dPath = join(root, 'd.md');
  await writeFile(dPath, '# d');
  const swapped = await controller.addPreview('sess-1', [dPath]);
  assert.ok(swapped.ok);
  if (!swapped.ok) return;
  assert.deepEqual(swapped.session.preview!.files.map((f) => f.fileName), ['a.html', 'b.md', 'c.html', 'd.md']);
  assert.equal(swapped.session.preview!.files[1].id, bId);
  assert.equal(swapped.session.previewSource!.files[1].filePath, bFilePath);
  const bSwapped = await controller.getPreviewStatus('sess-1', swapped.session.preview!.id, bId);
  assert.ok(bSwapped.ok);
  if (bSwapped.ok && bSwapped.preview.state === 'unavailable') assert.equal(bSwapped.preview.reason, 'invalid_file');
  else assert.fail('expected unavailable/invalid_file for symlinked b.md');
});

test('--add enforces the cap across the resulting set, including missing entries; in-place re-register at 12 succeeds', async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-multi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths: string[] = [];
  for (let i = 0; i < 12; i++) {
    const path = join(root, `n${i}.md`);
    await writeFile(path, `# ${i}`);
    paths.push(path);
  }
  const session = makeSession(root);
  const { controller, store } = setup([session]);
  const twelve = await controller.setPreview('sess-1', paths);
  assert.ok(twelve.ok);
  if (!twelve.ok) return;
  const twelveId = twelve.session.preview!.id;
  const keepId = twelve.session.preview!.files[5].id;
  // Re-register one file in place at the cap: still 12, replaced id is new.
  await writeFile(paths[5], '# 5 v2');
  const reRegistered = await controller.addPreview('sess-1', [paths[5]]);
  assert.ok(reRegistered.ok);
  if (!reRegistered.ok) return;
  assert.equal(reRegistered.session.preview!.files.length, 12);
  assert.notEqual(reRegistered.session.preview!.files[5].id, keepId);
  assert.equal(reRegistered.session.preview!.files[4].id, twelve.session.preview!.files[4].id);
  // Delete one existing file, then adding a 13th distinct file still fails:
  // the missing entry is retained and counts toward the cap.
  await rm(paths[0], { force: true });
  const thirteenth = join(root, 'n12.md');
  await writeFile(thirteenth, '# 13');
  const overflow = await controller.addPreview('sess-1', [thirteenth]);
  assert.ok(!overflow.ok);
  if (!overflow.ok) assert.equal(overflow.code, 'invalid');
  assert.equal(store.sessions.get('sess-1')!.preview!.files.length, 12);
  assert.equal(store.sessions.get('sess-1')!.preview!.id, reRegistered.session.preview!.id);
  assert.notEqual(twelveId, reRegistered.session.preview!.id);
  // A within-batch duplicate on --add is still rejected.
  await mkdir(join(root, 'other'), { recursive: true });
  const other = join(root, 'other', 'n1.md');
  await writeFile(other, '# other');
  const dup = await controller.addPreview('sess-1', [paths[1], other]);
  assert.ok(!dup.ok);
  if (!dup.ok) assert.match(dup.message, /duplicate basename: n1\.md/);
});

test('RPC requires fileId and threads it to the controller', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const statusState = { state: 'ready' as const, previewId: 'p', fileId: 'f', revision: 'r', totalBytes: 1 };
  const fake = {
    getPreviewStatus: async (sessionId: string, previewId: string, fileId: string) => {
      calls.push({ method: 'status', args: [sessionId, previewId, fileId] });
      return { ok: true as const, preview: statusState };
    },
    getPreviewChunk: async (sessionId: string, previewId: string, fileId: string, revision: string, offset: number) => {
      calls.push({ method: 'chunk', args: [sessionId, previewId, fileId, revision, offset] });
      return { ok: true as const, preview: { state: 'stale_revision' as const } };
    },
    get: async () => null,
  } as unknown as SessionController;
  const responses: CommandResponse[] = [];
  const handler = createCommandHandler({
    bridgeId: 'bridge-1', sessionController: fake,
    publishCommandResponse: async (response) => { responses.push(response); },
  } as CommandRpcDeps);
  const previewId = randomUUID();
  const fileId = randomUUID();
  const revision = 'a'.repeat(64);
  const send = (type: Command['type'], payload: Record<string, unknown>, requestId: string) =>
    handler({ type, requestId, payload } as Command, undefined);
  // missing fileId -> invalid, controller untouched
  await send('session_preview_status', { bridgeId: 'bridge-1', sessionId: 'sess-1', previewId }, 'r-missing');
  assert.equal(responses.at(-1)?.success, false);
  assert.deepEqual(responses.at(-1)?.data, { code: 'invalid' });
  assert.equal(calls.length, 0);
  // invalid fileId -> invalid
  await send('session_preview_status', { bridgeId: 'bridge-1', sessionId: 'sess-1', previewId, fileId: 'bad' }, 'r-bad');
  assert.equal(responses.at(-1)?.success, false);
  assert.deepEqual(responses.at(-1)?.data, { code: 'invalid' });
  assert.equal(calls.length, 0);
  // valid status passes fileId through
  await send('session_preview_status', { bridgeId: 'bridge-1', sessionId: 'sess-1', previewId, fileId }, 'r-ok');
  assert.equal(responses.at(-1)?.success, true);
  assert.deepEqual(calls.at(-1), { method: 'status', args: ['sess-1', previewId, fileId] });
  // valid chunk passes fileId through
  await send('session_preview_chunk', { bridgeId: 'bridge-1', sessionId: 'sess-1', previewId, fileId, revision, offset: 0 }, 'r-chunk');
  assert.equal(responses.at(-1)?.success, true);
  assert.deepEqual(calls.at(-1), { method: 'chunk', args: ['sess-1', previewId, fileId, revision, 0] });
  // chunk without fileId -> invalid
  await send('session_preview_chunk', { bridgeId: 'bridge-1', sessionId: 'sess-1', previewId, revision, offset: 0 }, 'r-chunk-missing');
  assert.equal(responses.at(-1)?.success, false);
  assert.deepEqual(responses.at(-1)?.data, { code: 'invalid' });
});

interface Recorded { url: string; method: string; body?: unknown }
async function cliFixture(run: (requests: Recorded[], output: string[]) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'ftown-preview-cli-'));
  const prevHome = process.env.HOME;
  const prevSession = process.env.FTOWN_SESSION_ID;
  const prevDataDir = process.env.FTOWN_DATA_DIR;
  const prevFetch = globalThis.fetch;
  const prevLog = console.log;
  const prevError = console.error;
  const requests: Recorded[] = [];
  const output: string[] = [];
  mkdirSync(join(home, '.ftown'));
  process.env.HOME = home;
  process.env.FTOWN_DATA_DIR = join(home, '.ftown', 'data');
  delete process.env.FTOWN_SESSION_ID;
  const secure = await secureFixture(join(home, '.ftown'), async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    const last = requests.at(-1)!;
    const urlText = String(url);
    if (last.method === 'GET' && urlText.includes('/api/sessions/')) {
      return new Response(JSON.stringify({ capabilities: { sessionMetadata: { preview: true } } }));
    }
    return new Response(JSON.stringify({ session: { id: 'sess-1', preview: { id: 'x', files: [] } } }));
  }, 12345);
  writeFileSync(join(home, '.ftown', 'bridge.json'), JSON.stringify(secure.pointer));
  globalThis.fetch = secure.fetch;
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  try { await run(requests, output); } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevSession === undefined) delete process.env.FTOWN_SESSION_ID; else process.env.FTOWN_SESSION_ID = prevSession;
    if (prevDataDir === undefined) delete process.env.FTOWN_DATA_DIR; else process.env.FTOWN_DATA_DIR = prevDataDir;
    await secure.security.close();
    globalThis.fetch = prevFetch; console.log = prevLog; console.error = prevError;
    rmSync(home, { recursive: true, force: true });
  }
}

test('CLI preview supports replace, --add, --remove, --clear with mutual exclusivity', async () => {
  await cliFixture(async (requests, output) => {
    process.env.FTOWN_SESSION_ID = 'sess-1';
    // replace with two files, ordered
    assert.equal(await runSessions(['preview', 'a.html', 'b.md']), 0);
    const putReplace = requests.at(-1)!;
    assert.equal(putReplace.method, 'PUT');
    assert.equal((putReplace.body as Record<string, unknown>).mode, 'replace');
    const replacePaths = (putReplace.body as { paths: string[] }).paths;
    assert.deepEqual(replacePaths.map((p) => p.slice(p.lastIndexOf('/') + 1)), ['a.html', 'b.md']);
    assert.ok(replacePaths.every((p) => p.startsWith('/')));
    // --add appends
    assert.equal(await runSessions(['preview', '--add', 'c.html']), 0);
    const putAdd = requests.at(-1)!;
    assert.equal(putAdd.method, 'PUT');
    assert.equal((putAdd.body as Record<string, unknown>).mode, 'add');
    assert.equal((putAdd.body as { paths: string[] }).paths.length, 1);
    // --remove by basename
    assert.equal(await runSessions(['preview', '--remove', 'b.md']), 0);
    const delRemove = requests.at(-1)!;
    assert.equal(delRemove.method, 'DELETE');
    assert.deepEqual(delRemove.body, { names: ['b.md'] });
    // --clear sends no body
    assert.equal(await runSessions(['preview', '--clear']), 0);
    const delClear = requests.at(-1)!;
    assert.equal(delClear.method, 'DELETE');
    assert.equal(delClear.body, undefined);
    // JSON output carries the session (files at preview.files)
    const parsed = JSON.parse(output.at(-1) ?? '{}') as { session?: { preview?: { files?: unknown[] } } };
    assert.ok(parsed.session);
    // mutual exclusivity and usage errors mutate nothing
    const before = requests.length;
    assert.equal(await runSessions(['preview', '--add', 'a.html', '--remove', 'b.md']), 1);
    assert.equal(await runSessions(['preview', '--add', 'a.html', '--clear']), 1);
    assert.equal(await runSessions(['preview', 'a.html', '--add', 'b.html']), 1);
    assert.equal(await runSessions(['preview', 'a.html', '--clear']), 1);
    assert.equal(await runSessions(['preview']), 1);
    assert.equal(requests.length, before);
    // help documents limits
    assert.equal(await runSessions(['preview', '--help']), 0);
    assert.ok(output.some((line) => line.includes('.html') || line.includes('preview files') || line.includes('12')));
    assert.equal(requests.length, before);
  });
});
