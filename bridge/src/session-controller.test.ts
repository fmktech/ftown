import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SessionController } from './session-controller.js';
import type { SessionControllerDeps, SessionStoreLike } from './session-controller.js';
import type { SessionWorktree, WorktreeApi, WorktreeRetireDecision, WorktreeStatus } from './coordination/contract-b.js';
import { WorktreeError } from './coordination/contract-b.js';
import type { Session, SessionUsage } from './types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'worker',
    command: 'claude',
    status: 'completed',
    bridgeId: 'bridge-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** In-memory SessionStoreLike fake. */
function makeFakeStore(initial: Session[] = []): SessionStoreLike & {
  sessions: Map<string, Session>;
  saved: Session[];
} {
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

function setup(initial: Session[] = [], overrides: Partial<SessionControllerDeps> = {}) {
  const store = makeFakeStore(initial);
  const published: Session[] = [];
  const stops: string[] = [];
  const syntheticStops: Array<{ sessionId: string; reason: string }> = [];
  const unregistered: string[] = [];
  const removedCalls: Array<{ sessionId: string; onlyIfFinished?: boolean }> = [];

  const controller = new SessionController({
    store,
    runner: {
      stop: (sessionId) => {
        stops.push(sessionId);
        return store.sessions.get(sessionId)?.status === 'running';
      },
    },
    publishSessionUpdate: async (session) => {
      published.push({ ...session });
    },
    removeSession: async (sessionId, options) => {
      removedCalls.push({ sessionId, onlyIfFinished: options?.onlyIfFinished });
      const session = store.sessions.get(sessionId) ?? null;
      if (session) store.sessions.delete(sessionId);
      return session;
    },
    publishSyntheticStop: (sessionId, reason) => {
      syntheticStops.push({ sessionId, reason });
    },
    withSessionWrite: (_sessionId, task) => task(),
    unregisterSession: (sessionId) => {
      unregistered.push(sessionId);
    },
    ...overrides,
  });

  return { controller, store, published, stops, syntheticStops, unregistered, removedCalls };
}

describe('SessionController.update — rename', () => {
  it('renames, bumps updatedAt, saves, and publishes the updated session', async () => {
    const h = setup([makeSession()]);

    const result = await h.controller.update('sess-1', { name: 'renamed' });

    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.session.name, 'renamed');
      assert.notEqual(result.session.updatedAt, '2026-01-01T00:00:00.000Z');
    }
    assert.equal(h.store.saved.length, 1);
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0].name, 'renamed');
  });

  it('returns not_found for an unknown session, without saving or publishing', async () => {
    const h = setup();

    const result = await h.controller.update('nope', { name: 'renamed' });

    assert.deepEqual(result, { ok: false, code: 'not_found', message: 'Session not found' });
    assert.equal(h.store.saved.length, 0);
    assert.equal(h.published.length, 0);
  });

  it('rejects an empty or non-string name as invalid', async () => {
    const h = setup([makeSession()]);

    const empty = await h.controller.update('sess-1', { name: '' });
    assert.deepEqual(empty, { ok: false, code: 'invalid', message: 'Invalid name' });

    const nonString = await h.controller.update('sess-1', { name: 42 as unknown as string });
    assert.deepEqual(nonString, { ok: false, code: 'invalid', message: 'Invalid name' });

    assert.equal(h.store.saved.length, 0);
  });
});

describe('SessionController.update — pull request metadata', () => {
  it('attaches, replaces, preserves and clears the URL on retained sessions', async () => {
    const h = setup([makeSession()]);
    const first = await h.controller.update('sess-1', { pullRequestUrl: ' https://github.com/fmktech/ftown/pull/128/?tab=files#review ' });
    assert.ok(first.ok);
    assert.equal(h.store.sessions.get('sess-1')?.pullRequestUrl, 'https://github.com/fmktech/ftown/pull/128');
    await h.controller.update('sess-1', { name: 'renamed' });
    assert.equal(h.store.sessions.get('sess-1')?.pullRequestUrl, 'https://github.com/fmktech/ftown/pull/128');
    await h.controller.update('sess-1', { pullRequestUrl: 'https://github.com/fmktech/ftown/pull/129' });
    assert.equal(h.published.at(-1)?.pullRequestUrl, 'https://github.com/fmktech/ftown/pull/129');
    await h.controller.update('sess-1', { pullRequestUrl: null });
    assert.equal(Object.hasOwn(h.store.sessions.get('sess-1')!, 'pullRequestUrl'), false);
    assert.equal(Object.hasOwn(h.published.at(-1)!, 'pullRequestUrl'), false);
    await h.controller.update('sess-1', { pullRequestUrl: null });
    assert.equal(h.store.saved.length, 5);
    assert.equal(h.published.length, 5);
  });

  it('validates every field before mutating even a store-owned reference', async () => {
    for (const input of [
      { name: 'must not change', pullRequestUrl: 'https://evil.test/owner/repo/pull/1' },
      { name: 'must not change', parent: { value: 'missing' }, pullRequestUrl: 'https://github.com/owner/repo/pull/1' },
      { name: '', pullRequestUrl: 'https://github.com/owner/repo/pull/1' },
      { pullRequestUrl: '' },
      { pullRequestUrl: 42 as unknown as string },
    ]) {
      const original = makeSession();
      const before = { ...original };
      const h = setup([original]);
      const result = await h.controller.update('sess-1', input);
      assert.equal(result.ok, false);
      assert.deepEqual(original, before);
      assert.equal(h.store.saved.length, 0);
      assert.equal(h.published.length, 0);
    }
  });

  for (const injected of [false, true]) it(`serializes concurrent rename and PR updates (${injected ? 'injected session boundary' : 'local fallback'})`, async () => {
    let snapshot = makeSession();
    let firstLoaded!: () => void;
    const loaded = new Promise<void>((resolve) => { firstLoaded = resolve; });
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let reads = 0;
    const h = setup();
    h.store.loadSession = async () => {
      const result = { ...snapshot };
      reads++;
      if (reads === 1) { firstLoaded(); await release; }
      return result;
    };
    h.store.saveSession = async (value) => { snapshot = { ...value }; };
    let boundary = Promise.resolve();
    const controller = new SessionController({
      store: h.store, runner: { stop: () => false }, removeSession: async () => null,
      publishSessionUpdate: async (value) => { h.published.push({ ...value }); },
      ...(injected ? { withSessionWrite: (_id: string, task: () => Promise<void>) => {
        const next = boundary.then(task); boundary = next.catch(() => {}); return next;
      } } : {}),
    });
    const rename = controller.update('sess-1', { name: 'concurrent rename' });
    await loaded;
    const attach = controller.update('sess-1', { pullRequestUrl: 'https://github.com/fmktech/ftown/pull/128' });
    // A microtask turn gives an unguarded second read a chance to enter; no
    // wall-clock delay or polling is needed to expose the lost-update ordering.
    await Promise.resolve();
    const readsBeforeRelease = reads;
    releaseFirst();
    const results = await Promise.all([rename, attach]);
    assert.equal(readsBeforeRelease, 1);
    assert.ok(results.every((result) => result.ok));
    assert.equal(snapshot.name, 'concurrent rename');
    assert.equal(snapshot.pullRequestUrl, 'https://github.com/fmktech/ftown/pull/128');
    assert.equal(h.published.length, 2);
    assert.equal(h.published[1].name, 'concurrent rename');
    assert.equal(h.published[1].pullRequestUrl, 'https://github.com/fmktech/ftown/pull/128');
  });
});

describe('SessionController.update — reparent', () => {
  it('flattens to the proposed parent\'s root so trees stay one level deep', async () => {
    const h = setup([
      makeSession({ id: 'root' }),
      makeSession({ id: 'child', parentSessionId: 'root' }),
      makeSession({ id: 'sess-1' }),
    ]);

    const result = await h.controller.update('sess-1', { parent: { value: 'child' } });

    assert.ok(result.ok);
    if (result.ok) assert.equal(result.session.parentSessionId, 'root');
  });

  it('clears the parent on null/undefined/empty-string values', async () => {
    for (const value of [null, undefined, '']) {
      const h = setup([makeSession({ parentSessionId: 'old-parent' })]);
      const result = await h.controller.update('sess-1', { parent: { value } });
      assert.ok(result.ok);
      if (result.ok) assert.equal(result.session.parentSessionId, undefined);
    }
  });

  it('rejects self-parenting and unknown parents without saving', async () => {
    const h = setup([makeSession()]);

    const self = await h.controller.update('sess-1', { parent: { value: 'sess-1' } });
    assert.deepEqual(self, { ok: false, code: 'invalid', message: 'Session cannot be its own parent' });

    const unknown = await h.controller.update('sess-1', { parent: { value: 'ghost' } });
    assert.deepEqual(unknown, { ok: false, code: 'invalid', message: 'Parent session not found' });

    assert.equal(h.store.saved.length, 0);
    assert.equal(h.published.length, 0);
  });

  it('rejects moving a parent under its own child', async () => {
    const h = setup([
      makeSession({ id: 'parent' }),
      makeSession({ id: 'child', parentSessionId: 'parent' }),
    ]);

    const result = await h.controller.update('parent', { parent: { value: 'child' } });

    assert.deepEqual(result, {
      ok: false,
      code: 'invalid',
      message: 'Session cannot be parented under its own descendant',
    });
    assert.equal(h.store.saved.length, 0);
    assert.equal(h.published.length, 0);
  });

  it('rejects reparenting a session that still has children', async () => {
    const h = setup([
      makeSession({ id: 'parent' }),
      makeSession({ id: 'child', parentSessionId: 'parent' }),
      makeSession({ id: 'other-root' }),
    ]);

    const result = await h.controller.update('parent', { parent: { value: 'other-root' } });

    assert.deepEqual(result, {
      ok: false,
      code: 'invalid',
      message: 'Session with children cannot be reparented',
    });
    assert.equal(h.store.saved.length, 0);
    assert.equal(h.published.length, 0);
  });

  it('rejects a parent that belongs to another bridge', async () => {
    const h = setup([
      makeSession({ id: 'child', bridgeId: 'bridge-1' }),
      makeSession({ id: 'foreign-parent', bridgeId: 'bridge-2' }),
    ]);

    const result = await h.controller.update('child', {
      parent: { value: 'foreign-parent' },
    });

    assert.deepEqual(result, {
      ok: false,
      code: 'invalid',
      message: 'Parent session belongs to another bridge',
    });
    assert.equal(h.store.saved.length, 0);
    assert.equal(h.published.length, 0);
  });
});

describe('SessionController.stop', () => {
  it('on a live session: synthetic Stop, persisted completed status, publish, unregister', async () => {
    const h = setup([makeSession({ status: 'running' })]);

    const result = await h.controller.stop('sess-1');

    assert.deepEqual(result, { stopped: true });
    assert.deepEqual(h.syntheticStops, [{ sessionId: 'sess-1', reason: 'stopped' }]);
    assert.equal(h.store.sessions.get('sess-1')!.status, 'completed');
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0].status, 'completed');
    assert.deepEqual(h.unregistered, ['sess-1']);
  });

  it('on a dead session: reports stopped=false and performs no side effects', async () => {
    const h = setup([makeSession({ status: 'completed' })]);

    const result = await h.controller.stop('sess-1');

    assert.deepEqual(result, { stopped: false });
    assert.equal(h.syntheticStops.length, 0);
    assert.equal(h.published.length, 0);
    assert.equal(h.unregistered.length, 0);
  });
});

describe('SessionController.remove', () => {
  const sampleWorktree: SessionWorktree = {
    repoRoot: '/repo',
    path: '/repo/.claude/worktrees/worker',
    branch: 'ftown/worker',
    base: 'main',
    createdByBridge: true,
  };

  function makeStatus(overrides: Partial<WorktreeStatus> = {}): WorktreeStatus {
    return {
      path: sampleWorktree.path,
      branch: sampleWorktree.branch,
      base: sampleWorktree.base,
      exists: true,
      dirty: false,
      ahead: 0,
      unpushed: 0,
      mergedIntoBase: true,
      ...overrides,
    };
  }

  function makeFakeWorktrees(opts: {
    status?: (wt: SessionWorktree) => Promise<WorktreeStatus>;
    decide?: (st: WorktreeStatus) => WorktreeRetireDecision;
    remove?: (wt: SessionWorktree, options: { force: boolean; deleteBranch: boolean }) => Promise<void>;
  } = {}): WorktreeApi & {
    statusCalls: SessionWorktree[];
    removeCalls: Array<{ wt: SessionWorktree; opts: { force: boolean; deleteBranch: boolean } }>;
  } {
    const statusCalls: SessionWorktree[] = [];
    const removeCalls: Array<{ wt: SessionWorktree; opts: { force: boolean; deleteBranch: boolean } }> = [];
    return {
      statusCalls,
      removeCalls,
      create: async () => sampleWorktree,
      status: async (wt) => {
        statusCalls.push(wt);
        return opts.status ? opts.status(wt) : makeStatus();
      },
      decide: (st) => {
        if (opts.decide) return opts.decide(st);
        if (!st.exists) return { action: 'retain', reason: 'worktree missing' };
        if (st.dirty) return { action: 'retain', reason: 'uncommitted changes' };
        if (st.mergedIntoBase) return { action: 'remove', deleteBranch: true };
        if (st.unpushed === 0) return { action: 'remove', deleteBranch: false };
        return { action: 'retain', reason: '2 unpushed commits' };
      },
      remove: async (wt, removeOpts) => {
        removeCalls.push({ wt, opts: removeOpts });
        if (opts.remove) await opts.remove(wt, removeOpts);
      },
    };
  }

  it('maps the removed session to { removed: true } and a miss to { removed: false }', async () => {
    const h = setup([makeSession()]);

    assert.deepEqual(await h.controller.remove('sess-1', { onlyIfFinished: true }), { removed: true });
    assert.deepEqual(h.removedCalls, [{ sessionId: 'sess-1', onlyIfFinished: true }]);

    assert.deepEqual(await h.controller.remove('sess-1'), { removed: false });
  });

  it('auto-retires a clean merged bridge worktree and deletes the branch', async () => {
    const worktrees = makeFakeWorktrees({
      status: async () => makeStatus({ mergedIntoBase: true, dirty: false }),
    });
    const h = setup([makeSession({ worktree: { ...sampleWorktree } })], { worktrees });

    const res = await h.controller.remove('sess-1');

    assert.deepEqual(res, {
      removed: true,
      worktreeOutcome: { action: 'removed' },
    });
    assert.equal(worktrees.statusCalls.length, 1);
    assert.deepEqual(worktrees.removeCalls, [
      { wt: sampleWorktree, opts: { force: false, deleteBranch: true } },
    ]);
    assert.equal(h.store.saved.length, 0);
  });

  it('auto-retains a dirty or unpushed worktree and persists worktree.retained before archiving', async () => {
    const worktrees = makeFakeWorktrees({
      status: async () => makeStatus({ dirty: true, mergedIntoBase: false }),
    });
    let archivedSnapshot: Session | null = null;
    const h = setup([makeSession({ worktree: { ...sampleWorktree } })], { worktrees });
    const origRemove = h.store.sessions;
    const controller = new SessionController({
      store: h.store,
      runner: { stop: () => false },
      publishSessionUpdate: async () => {},
      worktrees,
      removeSession: async (id) => {
        const s = await h.store.loadSession(id);
        archivedSnapshot = s ? structuredClone(s) : null;
        origRemove.delete(id);
        return s;
      },
    });

    const res = await controller.remove('sess-1');

    assert.deepEqual(res, {
      removed: true,
      worktreeOutcome: { action: 'retained', reason: 'uncommitted changes' },
    });
    assert.equal(worktrees.removeCalls.length, 0);
    assert.equal(h.store.saved.length, 1);
    assert.equal(archivedSnapshot?.worktree?.retained?.reason, 'uncommitted changes');
    assert.ok(archivedSnapshot?.worktree?.retained?.at);
  });

  it('keep mode retains with "kept by request" without calling status or remove', async () => {
    const worktrees = makeFakeWorktrees();
    const h = setup([makeSession({ worktree: { ...sampleWorktree } })], { worktrees });

    const res = await h.controller.remove('sess-1', undefined, 'keep');

    assert.deepEqual(res, {
      removed: true,
      worktreeOutcome: { action: 'retained', reason: 'kept by request' },
    });
    assert.equal(worktrees.statusCalls.length, 0);
    assert.equal(worktrees.removeCalls.length, 0);
    assert.equal(h.store.saved.length, 1);
    assert.equal(h.store.saved[0].worktree?.retained?.reason, 'kept by request');
  });

  it('force mode removes with force=true and deleteBranch only when mergedIntoBase', async () => {
    const unmergedWorktrees = makeFakeWorktrees({
      status: async () => makeStatus({ dirty: true, mergedIntoBase: false }),
    });
    const h1 = setup([makeSession({ worktree: { ...sampleWorktree } })], {
      worktrees: unmergedWorktrees,
    });
    const res1 = await h1.controller.remove('sess-1', undefined, 'force');
    assert.deepEqual(res1, { removed: true, worktreeOutcome: { action: 'removed' } });
    assert.deepEqual(unmergedWorktrees.removeCalls, [
      { wt: sampleWorktree, opts: { force: true, deleteBranch: false } },
    ]);

    const mergedWorktrees = makeFakeWorktrees({
      status: async () => makeStatus({ dirty: true, mergedIntoBase: true }),
    });
    const h2 = setup([makeSession({ worktree: { ...sampleWorktree } })], {
      worktrees: mergedWorktrees,
    });
    const res2 = await h2.controller.remove('sess-1', undefined, 'force');
    assert.deepEqual(res2, { removed: true, worktreeOutcome: { action: 'removed' } });
    assert.deepEqual(mergedWorktrees.removeCalls, [
      { wt: sampleWorktree, opts: { force: true, deleteBranch: true } },
    ]);

    const failingStatusWorktrees = makeFakeWorktrees({
      status: async () => {
        throw new WorktreeError('git_failed', 'fatal: status probe failed');
      },
    });
    const h3 = setup([makeSession({ worktree: { ...sampleWorktree } })], {
      worktrees: failingStatusWorktrees,
    });
    const res3 = await h3.controller.remove('sess-1', undefined, 'force');
    assert.deepEqual(res3, { removed: true, worktreeOutcome: { action: 'removed' } });
    assert.deepEqual(failingStatusWorktrees.removeCalls, [
      { wt: sampleWorktree, opts: { force: true, deleteBranch: false } },
    ]);
  });

  it('git errors retain the worktree with reason and never block archiving', async () => {
    const worktrees = makeFakeWorktrees({
      remove: async () => {
        throw new WorktreeError('git_failed', 'fatal: worktree locked');
      },
    });
    const h = setup([makeSession({ worktree: { ...sampleWorktree } })], { worktrees });

    const res = await h.controller.remove('sess-1', undefined, 'auto');

    assert.deepEqual(res, {
      removed: true,
      worktreeOutcome: { action: 'retained', reason: 'fatal: worktree locked' },
    });
    assert.equal(h.removedCalls.length, 1);
    assert.equal(h.store.saved.length, 1);
    assert.equal(h.store.saved[0].worktree?.retained?.reason, 'fatal: worktree locked');
  });

  it('does not touch worktrees when onlyIfFinished rejects a running session', async () => {
    const worktrees = makeFakeWorktrees();
    const h = setup(
      [makeSession({ status: 'running', worktree: { ...sampleWorktree } })],
      {
        worktrees,
        removeSession: async () => null,
      },
    );

    const res = await h.controller.remove('sess-1', { onlyIfFinished: true }, 'force');

    assert.deepEqual(res, { removed: false });
    assert.equal(worktrees.statusCalls.length, 0);
    assert.equal(worktrees.removeCalls.length, 0);
  });
});

describe('SessionController.retry', () => {
  it('surfaces typed state errors instead of relaunching', async () => {
    const factory = {} as never; // never reached by these paths… except deps presence
    const running = setup([makeSession({ status: 'running' })], { sessionFactory: factory });
    const r1 = await running.controller.retry('sess-1');
    assert.deepEqual(r1, { ok: false, code: 'conflict', message: 'Session is already running' });

    const missing = setup([], { sessionFactory: factory });
    const r2 = await missing.controller.retry('sess-1');
    assert.deepEqual(r2, { ok: false, code: 'not_found', message: 'Session not found' });

    const noCommand = setup([makeSession({ command: '' })], { sessionFactory: factory });
    const r3 = await noCommand.controller.retry('sess-1');
    assert.deepEqual(r3, {
      ok: false,
      code: 'invalid',
      message: 'Session has no command (created before v0.2.0)',
    });
  });
});

describe('SessionController.usage', () => {
  function makeUsage(overrides: Partial<SessionUsage> = {}): SessionUsage {
    return {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      totalTokens: 10,
      models: ['claude-sonnet-5'],
      harness: 'claude',
      collectedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('returns not_found for an unknown session', async () => {
    const { controller } = setup([]);
    const result = await controller.usage('nope');
    assert.deepEqual(result, { ok: false, code: 'not_found', message: 'Session not found' });
  });

  it('collects a deduplicated batch and omits sessions that no longer exist', async () => {
    const first = makeUsage({ totalTokens: 11 });
    const second = makeUsage({ totalTokens: 22 });
    const collectorCalls: string[] = [];
    const { controller } = setup(
      [
        makeSession({ id: 'sess-1', status: 'running' }),
        makeSession({ id: 'sess-2', status: 'running' }),
      ],
      {
        collectUsage: async (session) => {
          collectorCalls.push(session.id);
          return session.id === 'sess-1' ? first : second;
        },
      },
    );

    const usages = await controller.usages(['sess-1', 'missing', 'sess-2', 'sess-1']);

    assert.deepEqual(usages, { 'sess-1': first, 'sess-2': second });
    assert.deepEqual(collectorCalls.sort(), ['sess-1', 'sess-2']);
  });

  it('passes through persisted usage without invoking the collector', async () => {
    const persisted = makeUsage({ totalTokens: 42 });
    let collectorCalls = 0;
    const { controller } = setup(
      [makeSession({ usage: persisted })],
      { collectUsage: async () => { collectorCalls += 1; return makeUsage(); } },
    );

    const result = await controller.usage('sess-1');
    assert.ok(result.ok);
    assert.deepEqual(result.usage, persisted);
    assert.equal(collectorCalls, 0);
  });

  it('recollects persisted usage for a running session instead of returning a stale snapshot', async () => {
    const persisted = makeUsage({ totalTokens: 10 });
    const live = makeUsage({ totalTokens: 25 });
    let collectorCalls = 0;
    const { controller, store, published } = setup(
      [makeSession({ status: 'running', usage: persisted })],
      { collectUsage: async () => { collectorCalls += 1; return live; } },
    );

    const result = await controller.usage('sess-1');

    assert.ok(result.ok);
    assert.deepEqual(result.usage, live);
    assert.equal(collectorCalls, 1);
    assert.equal(store.saved.length, 0);
    assert.equal(published.length, 0);
  });

  it('collects on demand for a terminal session and persists + publishes the result', async () => {
    const collectedUsage = makeUsage();
    const { controller, store, published } = setup(
      [makeSession({ status: 'completed' })],
      { collectUsage: async () => collectedUsage },
    );

    const result = await controller.usage('sess-1');
    assert.ok(result.ok);
    assert.deepEqual(result.usage, collectedUsage);
    assert.equal(store.saved.length, 1);
    assert.deepEqual(store.saved[0].usage, collectedUsage);
    assert.deepEqual(published[0]?.usage, collectedUsage);
  });

  it('collects on demand for a RUNNING session without persisting (numbers still moving)', async () => {
    const collectedUsage = makeUsage();
    const { controller, store, published } = setup(
      [makeSession({ status: 'running' })],
      { collectUsage: async () => collectedUsage },
    );

    const result = await controller.usage('sess-1');
    assert.ok(result.ok);
    assert.deepEqual(result.usage, collectedUsage);
    assert.equal(store.saved.length, 0);
    assert.equal(published.length, 0);
  });

  it('returns null usage when the collector yields null, without persisting', async () => {
    const { controller, store } = setup(
      [makeSession({ status: 'completed' })],
      { collectUsage: async () => null },
    );

    const result = await controller.usage('sess-1');
    assert.ok(result.ok);
    assert.equal(result.usage, null);
    assert.equal(store.saved.length, 0);
  });

  it('returns null usage when no collector is wired', async () => {
    const { controller } = setup([makeSession({ status: 'completed' })]);
    const result = await controller.usage('sess-1');
    assert.ok(result.ok);
    assert.equal(result.usage, null);
  });
});

it('keeps a link incarnation for equivalent URLs and replaces it after unlink', async () => {
  const h = setup([makeSession()]);
  await h.controller.update('sess-1', { pullRequestUrl: 'https://github.com/owner/repo/pull/1' });
  const first = h.store.sessions.get('sess-1')!.pullRequestLinkId; assert.ok(first);
  await h.controller.update('sess-1', { pullRequestUrl: 'https://github.com/OWNER/REPO/pull/1' });
  assert.equal(h.store.sessions.get('sess-1')!.pullRequestLinkId, first);
  await h.controller.update('sess-1', { pullRequestUrl: null });
  assert.equal(h.store.sessions.get('sess-1')!.pullRequestLinkId, undefined);
  await h.controller.update('sess-1', { pullRequestUrl: 'https://github.com/owner/repo/pull/1' });
  assert.notEqual(h.store.sessions.get('sess-1')!.pullRequestLinkId, first);
});
