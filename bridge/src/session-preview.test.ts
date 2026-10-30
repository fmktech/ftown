import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionController } from './session-controller.js';
import { SessionStore } from './session-store.js';
import { toWireSession } from './session-wire.js';
import { PREVIEW_CHUNK_BYTES, PREVIEW_MAX_BYTES } from './preview-protocol.js';
import { SessionPreviewReader } from './session-preview.js';
import type { SessionPreviewSource } from './preview-protocol.js';
import type { Session, SessionUsage } from './types.js';
import type { CommandResponse } from './types.js';
import { createCommandHandler } from './command-rpc.js';
import type { CreateFtownSessionDeps } from './create-ftown-session.js';
import { SessionResurrection } from './session-resurrection.js';
import type { SessionResurrectionDeps } from './session-resurrection.js';

test('registration persists privately; bounded chunks and digest follow changes, missing files and clear', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'page.html');
  const bytes = Buffer.from(`<p>${'€'.repeat(40000)}</p>`);
  await writeFile(work, bytes);
  const store = new SessionStore(join(root, 'data'));
  const session: Session = { id: 's', name: 'test', command: 'shell', bridgeId: 'b', status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workingDir: root };
  await store.saveSession(session);
  const published: Session[] = [];
  const controller = new SessionController({ store, runner: { stop: () => true }, publishSessionUpdate: async s => { published.push(s); }, removeSession: async () => null });
  const registered = await controller.setPreview('s', work);
  assert.ok(registered.ok); if (!registered.ok) return;
  const id = registered.session.preview!.id;
  assert.equal(registered.session.preview!.fileName, 'page.html');
  assert.equal(JSON.stringify(toWireSession(registered.session)).includes(work), false);
  assert.equal('previewSource' in toWireSession(registered.session), false);
  assert.equal(published.length, 1);
  assert.equal((await new SessionStore(join(root, 'data')).loadSession('s'))?.preview?.id, id);
  const status = await controller.getPreviewStatus('s', id);
  assert.ok(status.ok && status.preview.state === 'ready'); if (!status.ok || status.preview.state !== 'ready') return;
  const first = await controller.getPreviewChunk('s', id, status.preview.revision, 0);
  const second = await controller.getPreviewChunk('s', id, status.preview.revision, PREVIEW_CHUNK_BYTES);
  assert.ok(first.ok && first.preview.state === 'chunk'); assert.ok(second.ok && second.preview.state === 'chunk');
  if (!first.ok || first.preview.state !== 'chunk' || !second.ok || second.preview.state !== 'chunk') return;
  assert.deepEqual(Buffer.concat([Buffer.from(first.preview.dataBase64, 'base64'), Buffer.from(second.preview.dataBase64, 'base64')]), bytes);
  assert.equal(first.preview.done, false); assert.equal(second.preview.done, true);
  assert.deepEqual(await controller.getPreviewStatus('s', id, status.preview.revision), { ok: true, preview: { state: 'unchanged', previewId: id, revision: status.preview.revision, totalBytes: bytes.length } });
  assert.deepEqual((await controller.getPreviewChunk('s', id, status.preview.revision, 1)), { ok: false, code: 'invalid', message: 'Invalid preview request' });
  await writeFile(work, Buffer.from(`<p>${'x'.repeat(bytes.length - 7)}</p>`));
  assert.deepEqual((await controller.getPreviewChunk('s', id, status.preview.revision, 0)), { ok: true, preview: { state: 'stale_revision' } });
  await unlink(work);
  assert.deepEqual((await controller.getPreviewStatus('s', id)), { ok: true, preview: { state: 'unavailable', previewId: id, reason: 'missing' } });
  await writeFile(work, '<p>back</p>');
  assert.equal((await controller.getPreviewStatus('s', id)).ok, true);
  await writeFile(work, '');
  const empty = await controller.getPreviewStatus('s', id);
  assert.ok(empty.ok && empty.preview.state === 'ready');
  if (empty.ok && empty.preview.state === 'ready') assert.deepEqual(await controller.getPreviewChunk('s', id, empty.preview.revision, 0), { ok: true, preview: { state: 'chunk', previewId: id, revision: empty.preview.revision, totalBytes: 0, offset: 0, dataBase64: '', done: true } });
  assert.ok((await controller.clearPreview('s')).ok);
  assert.deepEqual((await controller.getPreviewStatus('s', id)), { ok: true, preview: { state: 'unregistered' } });
  assert.deepEqual((await controller.getPreviewChunk('s', id, status.preview.revision, 0)), { ok: true, preview: { state: 'stale_revision' } });
  assert.ok((await controller.clearPreview('s')).ok);
});

test('registration confines paths and content reads reject invalid UTF-8 and oversize', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'page.html'); await writeFile(work, '<p>ok</p>');
  await symlink(work, join(root, 'link.html'));
  const store = new SessionStore(join(root, 'data'));
  await store.saveSession({ id: 's', name: 'test', command: '', bridgeId: 'b', status: 'completed', createdAt: '', updatedAt: '', workingDir: root });
  const c = new SessionController({ store, runner: { stop: () => true }, publishSessionUpdate: async () => {}, removeSession: async () => null });
  for (const path of [join(root, 'link.html'), join(root, '..', 'outside.html'), root, join(root, 'no.js')]) assert.equal((await c.setPreview('s', path)).ok, false);
  await writeFile(work, Buffer.alloc(PREVIEW_MAX_BYTES + 1));
  assert.deepEqual(await c.setPreview('s', work), { ok: false, code: 'too_large', message: 'Invalid preview file' });
  await writeFile(work, '<p>ok</p>');
  const reg = await c.setPreview('s', work); assert.ok(reg.ok); if (!reg.ok) return;
  const id = reg.session.preview!.id;
  await writeFile(work, Buffer.from([0xff]));
  assert.deepEqual(await c.getPreviewStatus('s', id), { ok: true, preview: { state: 'unavailable', previewId: id, reason: 'invalid_utf8' } });
  await writeFile(work, Buffer.alloc(PREVIEW_MAX_BYTES + 1));
  assert.deepEqual(await c.getPreviewStatus('s', id), { ok: true, preview: { state: 'unavailable', previewId: id, reason: 'too_large' } });
  await unlink(work); await symlink(join(root, 'link.html'), work);
  assert.deepEqual(await c.getPreviewStatus('s', id), { ok: true, preview: { state: 'unavailable', previewId: id, reason: 'invalid_file' } });
});

test('a slow usage collection reloads and retains a concurrent preview registration', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'x.html'); await writeFile(file, 'ok');
  const store = new SessionStore(join(root, 'data'));
  await store.saveSession({ id: 's', name: 'test', command: '', bridgeId: 'b', status: 'completed', createdAt: '', updatedAt: '', workingDir: root });
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  const usage: SessionUsage = { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1, models: [], harness: 'test', collectedAt: '' };
  const c = new SessionController({ store, runner: { stop: () => true }, publishSessionUpdate: async () => {}, removeSession: async () => null, collectUsage: async () => { entered(); await gate; return usage; } });
  const pending = c.usage('s'); await started;
  const registered = await c.setPreview('s', file); assert.ok(registered.ok);
  release(); await pending;
  assert.equal((await store.loadSession('s'))?.preview?.id, registered.ok ? registered.session.preview?.id : undefined);
});

for (const action of ['clear', 'remove', 'replace'] as const) test(`in-flight content is discarded after ${action}`, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'x.html'); await writeFile(file, 'secret document');
  const store = new SessionStore(join(root, 'data'));
  await store.saveSession({ id: 's', name: 'test', command: '', bridgeId: 'b', status: 'completed', createdAt: '', updatedAt: '', workingDir: root });
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  class HeldReader extends SessionPreviewReader {
    override async read(session: Session, source: SessionPreviewSource) {
      const result = await super.read(session, source); entered(); await gate; return result;
    }
  }
  const c = new SessionController({ store, runner: { stop: () => true }, publishSessionUpdate: async () => {},
    removeSession: async id => { const session = await store.loadSession(id); await store.deleteSession(id); return session; }, previewReader: new HeldReader() });
  const reg = await c.setPreview('s', file); assert.ok(reg.ok); if (!reg.ok) return;
  const id = reg.session.preview!.id;
  const revision = createHash('sha256').update('secret document').digest('hex');
  const pending = c.getPreviewChunk('s', id, revision, 0); await started;
  if (action === 'clear') await c.clearPreview('s');
  if (action === 'remove') await c.remove('s');
  if (action === 'replace') await c.setPreview('s', file);
  release();
  assert.deepEqual(await pending, { ok: true, preview: { state: 'stale_revision' } });
});

test('preview RPC rejects malformed inputs and returns the typed read result', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'x.html'); await writeFile(file, 'hello');
  const store = new SessionStore(join(root, 'data'));
  await store.saveSession({ id: 's', name: 'test', command: '', bridgeId: 'b', status: 'completed', createdAt: '', updatedAt: '', workingDir: root });
  const c = new SessionController({ store, runner: { stop: () => true }, publishSessionUpdate: async () => {}, removeSession: async () => null });
  const reg = await c.setPreview('s', file); assert.ok(reg.ok); if (!reg.ok) return;
  const id = reg.session.preview!.id; const replies: CommandResponse[] = [];
  const handler = createCommandHandler({ bridgeId: 'b', sessionController: c, publishCommandResponse: async response => { replies.push(response); } });
  await handler({ type: 'session_preview_status', requestId: 'one', payload: { bridgeId: 'b', sessionId: 's', previewId: id } });
  assert.equal(replies[0].success, true);
  assert.equal((replies[0].data as { state: string }).state, 'ready');
  await handler({ type: 'session_preview_chunk', requestId: 'bad', payload: { bridgeId: 'b', sessionId: 's', previewId: id, revision: 'a'.repeat(64), offset: 1 } });
  assert.deepEqual(replies[1], { requestId: 'bad', success: false, error: 'Invalid preview request', data: { code: 'invalid' } });
});

test('retry waits for an in-flight preview registration and reloads its committed metadata', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'x.html'); await writeFile(file, 'hello');
  const store = new SessionStore(join(root, 'data'));
  await store.saveSession({ id: 's', name: 'test', command: 'fake', shellType: 'shell', bridgeId: 'b', status: 'completed', createdAt: '', updatedAt: '', workingDir: root });
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  const originalSave = store.saveSession.bind(store);
  store.saveSession = async session => { if (session.preview && session.status === 'completed') { entered(); await gate; } await originalSave(session); };
  const factory = { store, bridgeId: 'b', userId: 'u', runner: { run() {} },
    centrifugo: { publishSessionUpdate: async () => {} }, hookPort: 0, hookToken: '', notifyScriptPath: '', wireTerminalInput() {} } as unknown as CreateFtownSessionDeps;
  const c = new SessionController({ store, runner: { stop: () => true }, publishSessionUpdate: async () => {}, removeSession: async () => null, sessionFactory: factory });
  const registration = c.setPreview('s', file); await started;
  const retry = c.retry('s');
  release(); const registered = await registration; const result = await retry;
  assert.ok(registered.ok && result.ok);
  if (registered.ok && result.ok) assert.equal(result.session.preview?.id, registered.session.preview?.id);
  assert.equal((await store.loadSession('s'))?.preview?.id, registered.ok ? registered.session.preview?.id : undefined);
});

test('startup resurrection reloads preview after its original session list was captured', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'x.html'); await writeFile(file, 'hello');
  const store = new SessionStore(join(root, 'data'));
  await store.saveSession({ id: 's', name: 'test', command: 'fake', shellType: 'shell', bridgeId: 'b', status: 'running', createdAt: '', updatedAt: '', workingDir: root });
  let listed!: () => void; let release!: () => void;
  const started = new Promise<void>(r => { listed = r; }); const gate = new Promise<void>(r => { release = r; });
  const list = store.listSessions.bind(store);
  store.listSessions = async () => { const stale = await list(); listed(); await gate; return stale; };
  let tail = Promise.resolve();
  const withSessionWrite = async (_id: string, task: () => Promise<void>) => {
    const next = tail.then(task); tail = next.catch(() => {}); await next;
  };
  const c = new SessionController({ store, runner: { stop: () => true }, publishSessionUpdate: async () => {}, removeSession: async () => null, withSessionWrite });
  const deps = { store, runner: { isRunning: () => false, reattach: () => true }, bridgeId: 'b', sessionFactoryDeps: {},
    publishSessionUpdate: async () => {}, wireTerminalInput: () => {}, withSessionWrite, tmux: { available: () => false, list: () => [], kill: async () => true } } as unknown as SessionResurrectionDeps;
  const pending = new SessionResurrection(deps).resurrectSessions(); await started;
  const registered = await c.setPreview('s', file); assert.ok(registered.ok);
  release(); await pending;
  assert.equal((await store.loadSession('s'))?.preview?.id, registered.ok ? registered.session.preview?.id : undefined);
});

test('reader limits active file reads to four without an unbounded queue', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'x.html'); await writeFile(file, 'hello');
  const store = new SessionStore(join(root, 'data'));
  await store.saveSession({ id: 's', name: 'test', command: '', bridgeId: 'b', status: 'completed', createdAt: '', updatedAt: '', workingDir: root });
  let release!: () => void; let allOpened!: () => void; let count = 0;
  const gate = new Promise<void>(r => { release = r; }); const opened = new Promise<void>(r => { allOpened = r; });
  class HeldReader extends SessionPreviewReader {
    protected override async openFile(path: string) { count++; if (count === 4) allOpened(); await gate; return super.openFile(path); }
  }
  const reader = new HeldReader();
  const c = new SessionController({ store, runner: { stop: () => true }, publishSessionUpdate: async () => {}, removeSession: async () => null, previewReader: reader });
  const reg = await c.setPreview('s', file); assert.ok(reg.ok); if (!reg.ok) return;
  const id = reg.session.preview!.id;
  const active = Array.from({ length: 4 }, () => c.getPreviewStatus('s', id)); await opened;
  assert.deepEqual(await c.getPreviewStatus('s', id), { ok: true, preview: { state: 'unavailable', previewId: id, reason: 'unavailable' } });
  release(); assert.ok((await Promise.all(active)).every(result => result.ok && result.preview.state === 'ready'));
});

test('a file growing beyond the cap after stat is rejected before unbounded allocation', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ftown-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'x.html'); await writeFile(file, 'ok');
  const store = new SessionStore(join(root, 'data'));
  await store.saveSession({ id: 's', name: 'test', command: '', bridgeId: 'b', status: 'completed', createdAt: '', updatedAt: '', workingDir: root });
  class GrowingReader extends SessionPreviewReader {
    protected override async initialStat(handle: FileHandle) { const before = await super.initialStat(handle); await appendFile(file, Buffer.alloc(PREVIEW_MAX_BYTES)); return before; }
  }
  const c = new SessionController({ store, runner: { stop: () => true }, publishSessionUpdate: async () => {}, removeSession: async () => null, previewReader: new GrowingReader() });
  const reg = await c.setPreview('s', file); assert.ok(reg.ok); if (!reg.ok) return;
  const id = reg.session.preview!.id;
  assert.deepEqual(await c.getPreviewStatus('s', id), { ok: true, preview: { state: 'unavailable', previewId: id, reason: 'too_large' } });
});
