import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SessionController } from './session-controller.js';
import type { SessionControllerDeps, SessionStoreLike } from './session-controller.js';
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
  it('maps the removed session to { removed: true } and a miss to { removed: false }', async () => {
    const h = setup([makeSession()]);

    assert.deepEqual(await h.controller.remove('sess-1', { onlyIfFinished: true }), { removed: true });
    assert.deepEqual(h.removedCalls, [{ sessionId: 'sess-1', onlyIfFinished: true }]);

    assert.deepEqual(await h.controller.remove('sess-1'), { removed: false });
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
