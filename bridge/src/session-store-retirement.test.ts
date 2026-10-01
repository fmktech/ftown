import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { SessionStore } from './session-store.js';
import { TerminalPump } from './terminal-pump.js';
import { SessionController } from './session-controller.js';
import { removeFtownSession, type RemoveFtownSessionDeps } from './remove-ftown-session.js';
import type { Session, SessionUsage } from './types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const usage: SessionUsage = {
  inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0,
  totalTokens: 20, models: ['scratch'], harness: 'scratch', collectedAt: '2026-09-30T00:00:00Z',
};

async function fixture(t: TestContext, status: Session['status'] = 'running', collectUsage?: () => Promise<SessionUsage>) {
  const dir = await fs.mkdtemp('/tmp/ftown-retired-sidebar-persistence-test-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir);
  const session: Session = {
    id: 'retirement-case', bridgeId: 'scratch-bridge', name: 'retirement case',
    status, shellType: 'shell', command: 'fake', workingDir: dir,
    createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z',
  };
  await store.saveSession(session);
  const updates: Session[] = [];
  const finished = deferred();
  const usagePublished = deferred();
  const runner = Object.assign(new EventEmitter(), { stop: () => true });
  const publish = async (s: Session) => {
    updates.push(structuredClone(s));
    if (s.usage) usagePublished.resolve();
  };
  const pump = new TerminalPump({
    store, terminalManager: { write() {}, destroy() {} },
    publishTerminalData() {}, publishSessionUpdate: publish,
    publishHookEvent: async () => {}, unregisterSession: () => finished.resolve(), collectUsage,
  });
  pump.attach(runner as unknown as Pick<RemoveFtownSessionDeps['runner'], 'on'>);
  const remove = () => removeFtownSession({
    store, runner: runner as unknown as RemoveFtownSessionDeps['runner'],
    centrifugo: { publishSessionUpdate: async (_user: string, s: Session) => publish(s) } as RemoveFtownSessionDeps['centrifugo'],
    userId: 'scratch-user',
  }, session.id);
  const controller = new SessionController({
    store, runner, publishSessionUpdate: publish, removeSession: remove,
    withSessionWrite: (id, task) => pump.withSessionWrite(id, task), collectUsage,
  });
  return { dir, store, session, runner, pump, controller, remove, updates, finished, usagePublished };
}

function gateSave(store: SessionStore, predicate: (session: Session) => boolean = () => true) {
  const entered = deferred();
  const release = deferred();
  const save = store.saveSession.bind(store);
  let armed = true;
  store.saveSession = async (session) => {
    if (armed && predicate(session)) {
      armed = false;
      entered.resolve();
      await release.promise;
    }
    return save(session);
  };
  return { entered, release };
}

async function assertAbsent(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(await f.store.loadSession(f.session.id), null);
  assert.deepEqual(await f.store.listSessions(), []);
  assert.equal(existsSync(f.store.sessionDir(f.session.id)), false);
  // Fresh IO readers prove absence independently of the in-memory latch.
  assert.deepEqual(await new SessionStore(f.dir).listSessions(), []);
  assert.equal((await f.store.listArchived()).length, 1);
}

for (const event of ['complete', 'error'] as const) {
  test(`late pump ${event} save cannot recreate a removed record`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    const gate = gateSave(f.store);
    t.after(gate.release.resolve);
    f.runner.emit(event, f.session.id, new Error('scratch failure'));
    await gate.entered.promise;
    await f.remove();
    await assertAbsent(f);
    gate.release.resolve();
    await f.finished.promise;
    await assertAbsent(f);
    assert.equal(f.updates.at(-1)?.status, event === 'complete' ? 'completed' : 'error');
  });
}

test('late pump usage save cannot recreate a removed record', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, 'running', async () => usage);
  const gate = gateSave(f.store, (session) => !!session.usage);
  t.after(gate.release.resolve);
  f.runner.emit('complete', f.session.id);
  await gate.entered.promise;
  await f.remove();
  gate.release.resolve();
  await f.usagePublished.promise;
  await f.pump.withSessionWrite(f.session.id, async () => {});
  await assertAbsent(f);
});

test('controller usage bypassing the pump queue stays absent after retirement', { timeout: 5000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(release.resolve);
  const f = await fixture(t, 'completed', async () => {
    entered.resolve();
    await release.promise;
    return usage;
  });
  const pending = f.controller.usage(f.session.id);
  await entered.promise;
  await f.pump.withSessionWrite(f.session.id, async () => { await f.controller.remove(f.session.id); });
  release.resolve();
  assert.equal((await pending).ok, true);
  await assertAbsent(f);
  // Promise<void> saves still permit late publications; the UI owns that boundary.
  assert.deepEqual(f.updates.map((s) => s.status), ['removed', 'completed']);
});

test('removal before completion loads leaves only the archive', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.remove();
  f.runner.emit('complete', f.session.id);
  await f.finished.promise;
  await assertAbsent(f);
  assert.deepEqual(f.updates.map((s) => s.status), ['removed']);
});

test('an active atomic save and deletion serialize, with unrelated IDs independent', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  t.after(release.resolve);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith('/retirement-case/session.json')) {
      entered.resolve();
      await release.promise;
    }
    return rename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const saving = f.store.saveSession({ ...f.session, name: 'pending snapshot' });
  await entered.promise;
  let deleted = false;
  const deleting = f.store.deleteSession(f.session.id).then(() => { deleted = true; });
  // Collect rejection now as baseline deletion removes the pending temp file.
  const savingResult = saving.then(() => null, (error: unknown) => error);
  const other = { ...f.session, id: 'independent' };
  await f.store.saveSession(other);
  assert.equal((await f.store.loadSession(other.id))?.id, other.id);
  assert.equal(deleted, false, 'delete must wait for the active same-ID write');
  release.resolve();
  assert.equal(await savingResult, null);
  await deleting;
  await f.store.saveSession(f.session);
  assert.equal(await f.store.loadSession(f.session.id), null);
  assert.equal(existsSync(f.store.sessionDir(f.session.id)), false);
});

test('terminal append/clear serialize with delete and late output cannot recreate directories', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  t.after(release.resolve);
  const append = fs.appendFile;
  t.mock.method(fs, 'appendFile', async (...args: Parameters<typeof fs.appendFile>) => {
    if (String(args[0]).endsWith('/terminal.log')) {
      entered.resolve();
      await release.promise;
    }
    return append(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const appending = f.store.appendTerminalData(f.session.id, 'pending tail\n');
  const appendResult = appending.then(() => null, (error: unknown) => error);
  await entered.promise;
  const clearing = f.store.clearTerminalLog(f.session.id);
  const deleting = f.store.deleteSession(f.session.id);
  release.resolve();
  assert.equal(await appendResult, null);
  await clearing;
  await deleting;
  await f.store.appendTerminalData(f.session.id, 'late output\n');
  await f.store.clearTerminalLog(f.session.id);
  assert.equal(existsSync(f.store.sessionDir(f.session.id)), false);
  assert.equal(await f.store.loadTerminalLog(f.session.id), '');
});

test('ordinary snapshots, terminal clearing and revival with a new ID remain usable', async (t) => {
  const f = await fixture(t);
  await f.store.saveSession({ ...f.session, name: 'renamed' });
  assert.equal((await f.store.loadSession(f.session.id))?.name, 'renamed');
  await f.store.appendTerminalData(f.session.id, 'ordinary log');
  await f.store.clearTerminalLog(f.session.id);
  assert.equal(await f.store.loadTerminalLog(f.session.id), '');
  await f.remove();
  const revived = { ...f.session, id: 'new-revival-id' };
  await f.store.saveSession(revived);
  await f.store.appendTerminalData(revived.id, 'new log');
  assert.deepEqual((await f.store.listSessions()).map((s) => s.id), [revived.id]);
  assert.equal(await f.store.loadTerminalLog(revived.id), 'new log');
  assert.equal((await f.store.listArchived())[0].id, f.session.id);
});

test('failed saves and terminal appends do not poison the same-ID queue', async (t) => {
  const f = await fixture(t);
  const saveBlocker = `${f.store.sessionDir(f.session.id)}/session.json`;
  await fs.rm(saveBlocker);
  await fs.mkdir(saveBlocker);
  await assert.rejects(f.store.saveSession(f.session));
  await fs.rm(saveBlocker, { recursive: true });
  await f.store.saveSession(f.session);
  assert.equal((await f.store.loadSession(f.session.id))?.id, f.session.id);
  const logBlocker = `${f.store.sessionDir(f.session.id)}/terminal.log`;
  await fs.mkdir(logBlocker);
  await assert.rejects(f.store.appendTerminalData(f.session.id, 'failure'));
  await fs.rm(logBlocker, { recursive: true });
  await f.store.appendTerminalData(f.session.id, 'recovered');
  assert.equal(await f.store.loadTerminalLog(f.session.id), 'recovered');
});

test('failed deletion does not latch retirement or poison later writes', async (t) => {
  const f = await fixture(t);
  const remove = fs.rm;
  let fail = true;
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (fail && String(args[0]) === f.store.sessionDir(f.session.id)) {
      fail = false;
      throw Object.assign(new Error('injected delete failure'), { code: 'EACCES' });
    }
    return remove(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(f.store.deleteSession(f.session.id), /injected delete failure/);
  await f.store.saveSession({ ...f.session, name: 'after failed delete' });
  assert.equal((await f.store.loadSession(f.session.id))?.name, 'after failed delete');
  await f.store.appendTerminalData(f.session.id, 'still legitimate');
  await f.store.deleteSession(f.session.id);
  await f.store.saveSession(f.session);
  assert.equal(existsSync(f.store.sessionDir(f.session.id)), false);
});
