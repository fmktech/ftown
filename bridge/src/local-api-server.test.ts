import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderAuthMissingError, WorkingDirMissingError } from './create-ftown-session.js';
import {
  LocalApiServer,
  archivedSessionWasResumed,
  providerAuthMissingResponse,
  workingDirMissingResponse,
} from './local-api-server.js';
import { deleteLoop, getLoop, listLoops, mutateLoopRuntime } from './loop-store.js';
import { upsertLoopRunRecord } from './loop-run-store.js';
import { SessionStore } from './session-store.js';
import type { CentrifugoClient } from './centrifugo-client.js';
import type { CreateFtownSessionDeps } from './create-ftown-session.js';
import type { ProcessRunner } from './claude-runner.js';
import type { Loop, LoopRunRecord, Session } from './types.js';

async function api(
  port: number,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

describe('LocalApiServer session harness inheritance', () => {
  it('inherits the caller harness when omitted and preserves an explicit override', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ftw-session-harness-api-'));
    const server = new LocalApiServer();
    const token = 'test-token';
    const store = new SessionStore(join(home, 'data'));
    const runs: Array<{ command: string }> = [];
    const runner = {
      getPreferredRuntime: () => 'direct',
      run: (_sessionId: string, command: string) => {
        runs.push({ command });
      },
      stop: () => false,
    } as unknown as ProcessRunner;
    const centrifugo = {
      publishSessionUpdate: async () => {},
    } as unknown as CentrifugoClient;
    const caller: Session = {
      id: 'pi-parent',
      name: 'Pi parent',
      command: 'pi',
      shellType: 'pi',
      status: 'running',
      bridgeId: 'bridge-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await store.saveSession(caller);

    const sessionFactory: CreateFtownSessionDeps = {
      store,
      runner,
      centrifugo,
      userId: 'user-1',
      bridgeId: 'bridge-1',
      hookPort: 4321,
      hookToken: 'hook-token',
      notifyScriptPath: '/tmp/notify.sh',
      wireTerminalInput: () => {},
    };
    server.setAuthToken(token);
    server.setDependencies(store, runner, centrifugo, 'user-1');
    server.setSessionFactory(sessionFactory);

    const port = await server.start();
    try {
      const inherited = await api(
        port,
        token,
        'POST',
        '/api/sessions',
        { prompt: 'Use my harness', parentSessionId: true },
        { 'X-Ftown-Session-Id': caller.id },
      );
      assert.strictEqual(inherited.status, 201);
      assert.strictEqual((inherited.data.session as Session).shellType, 'pi');
      assert.strictEqual((inherited.data.session as Session).parentSessionId, caller.id);

      const explicit = await api(
        port,
        token,
        'POST',
        '/api/sessions',
        { shellType: 'claude', prompt: 'Use Claude', parentSessionId: true },
        { 'X-Ftown-Session-Id': caller.id },
      );
      assert.strictEqual(explicit.status, 201);
      assert.strictEqual((explicit.data.session as Session).shellType, 'claude');
      assert.match(runs[0].command, /pi/);
      assert.match(runs[1].command, /claude/);
    } finally {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// A blocked provider create/revive must surface as a 422 carrying the provider,
// the env-var KEY-bearing message, and the `ftown env set` fix — and NEVER the
// secret token itself. providerAuthMissingResponse builds that body once so both
// the create and revive catch branches stay identical.
describe('providerAuthMissingResponse', () => {
  it('maps a ProviderAuthMissingError to a 422 with {error, provider, fix}', () => {
    const err = new ProviderAuthMissingError('zai', 'ZAI_API_TOKEN', 'ftown env set zai <token>');
    const response = providerAuthMissingResponse(err);

    assert.strictEqual(response.status, 422);
    assert.strictEqual(response.body.error, err.message);
    assert.strictEqual(response.body.provider, 'zai');
    assert.strictEqual(response.body.fix, 'ftown env set zai <token>');
  });

  it('carries only the env-var KEY and fix, never a token value', () => {
    const secret = 'sk-super-secret-token-value-1234';
    const err = new ProviderAuthMissingError('kimi', 'KIMI_API_TOKEN', 'ftown env set kimi <token>');
    const response = providerAuthMissingResponse(err);

    const serialized = JSON.stringify(response.body);
    assert.ok(serialized.includes('KIMI_API_TOKEN'), 'body should name the env-var KEY');
    assert.ok(!serialized.includes(secret), 'body must not contain any token value');
    assert.strictEqual(response.body.provider, 'kimi');
    assert.strictEqual(response.body.fix, 'ftown env set kimi <token>');
  });

  it('echoes the provider flavor verbatim for each mapped flavor', () => {
    for (const provider of ['zai', 'fireworks', 'kimi', 'deepseek']) {
      const err = new ProviderAuthMissingError(
        provider,
        `${provider.toUpperCase()}_API_TOKEN`,
        `ftown env set ${provider} <token>`,
      );
      const response = providerAuthMissingResponse(err);
      assert.strictEqual(response.status, 422);
      assert.strictEqual(response.body.provider, provider);
      assert.strictEqual(response.body.fix, `ftown env set ${provider} <token>`);
    }
  });
});

describe('workingDirMissingResponse', () => {
  it('maps a WorkingDirMissingError to a 422 with a createable code and path', () => {
    const err = new WorkingDirMissingError('/tmp/missing-project');
    const response = workingDirMissingResponse(err);

    assert.strictEqual(response.status, 422);
    assert.strictEqual(response.body.error, err.message);
    assert.strictEqual(response.body.code, 'working_dir_missing');
    assert.strictEqual(response.body.workingDir, '/tmp/missing-project');
    assert.strictEqual(response.body.canCreate, true);
  });
});

describe('archivedSessionWasResumed', () => {
  it('reports Pi workdir/native continuation as resumed, but not a custom command', () => {
    const piSession = { shellType: 'pi' as const };

    assert.equal(archivedSessionWasResumed(piSession, false), true);
    assert.equal(archivedSessionWasResumed(piSession, true), false);
  });
});

describe('LocalApiServer session parent route', () => {
  it('moves and detaches a session through PATCH without allowing a parent cycle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ftw-session-parent-api-'));
    const server = new LocalApiServer();
    const token = 'test-token';
    const store = new SessionStore(join(home, 'data'));
    const published: Session[] = [];
    const runner = { stop: () => false } as unknown as ProcessRunner;
    const centrifugo = {
      publishSessionUpdate: async (_userId: string, session: Session) => {
        published.push(session);
      },
    } as unknown as CentrifugoClient;

    const makeSession = (id: string, parentSessionId?: string): Session => ({
      id,
      name: id,
      command: 'claude',
      status: 'running',
      bridgeId: 'bridge-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      parentSessionId,
    });

    await store.saveSession(makeSession('parent-a'));
    await store.saveSession(makeSession('parent-b'));
    await store.saveSession(makeSession('child', 'parent-a'));
    await store.saveSession({ ...makeSession('foreign-parent'), bridgeId: 'bridge-2' });
    server.setAuthToken(token);
    server.setDependencies(store, runner, centrifugo, 'user-1');

    const port = await server.start();
    try {
      const response = await api(port, token, 'PATCH', '/api/sessions/child', {
        parentSessionId: 'parent-b',
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual((response.data.session as Session).parentSessionId, 'parent-b');
      assert.strictEqual((await store.loadSession('child'))?.parentSessionId, 'parent-b');
      assert.strictEqual(published.at(-1)?.parentSessionId, 'parent-b');

      const cycle = await api(port, token, 'PATCH', '/api/sessions/parent-b', {
        parentSessionId: 'child',
      });
      assert.strictEqual(cycle.status, 400);
      assert.strictEqual(cycle.data.error, 'Session cannot be parented under its own descendant');

      const detached = await api(port, token, 'PATCH', '/api/sessions/child', {
        parentSessionId: null,
      });
      assert.strictEqual(detached.status, 200);
      assert.strictEqual((detached.data.session as Session).parentSessionId, undefined);
      assert.strictEqual((await store.loadSession('child'))?.parentSessionId, undefined);
      assert.strictEqual(published.at(-1)?.parentSessionId, undefined);

      const crossBridge = await api(port, token, 'PATCH', '/api/sessions/child', {
        parentSessionId: 'foreign-parent',
      });
      assert.strictEqual(crossBridge.status, 400);
      assert.strictEqual(crossBridge.data.error, 'Parent session belongs to another bridge');
    } finally {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('LocalApiServer loop routes', () => {
  it('creates, lists, runs, pauses, and deletes bridge-owned loops', async () => {
    const realHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'ftw-loop-api-'));
    process.env.HOME = home;

    const server = new LocalApiServer();
    const token = 'test-token';
    const published: Loop[] = [];
    const removed: string[] = [];
    const deleted: Loop[] = [];
    let kicks = 0;

    const store = new SessionStore(join(home, 'data'));
    const runner = { isRunning: () => false } as unknown as ProcessRunner;
    const centrifugo = {
      publishLoopUpdate: async (_userId: string, loop: Loop) => {
        published.push(loop);
      },
      publishLoopRemoved: async (_userId: string, loopId: string) => {
        removed.push(loopId);
      },
    } as unknown as CentrifugoClient;

    server.setAuthToken(token);
    server.setDependencies(store, runner, centrifugo, 'user-1');
    server.setLoopApi({
      bridgeId: 'bridge-1',
      scheduler: {
        kick: () => {
          kicks += 1;
        },
        onLoopDeleted: (loop) => {
          deleted.push(loop);
        },
      },
    });

    const port = await server.start();
    try {
      const create = await api(port, token, 'POST', '/api/loops', {
        name: 'nightly',
        schedule: { kind: 'interval', everyMs: 60_000 },
        harness: 'codex',
        task: 'run checks',
        enabled: true,
        overlapPolicy: 'skip',
        retention: { autoClearAfterRuns: 3 },
      });
      assert.strictEqual(create.status, 201);
      const loop = create.data.loop as Loop;
      assert.strictEqual(loop.bridgeId, 'bridge-1');
      assert.strictEqual(loop.harness, 'codex');
      assert.strictEqual(published.length, 1);

      const list = await api(port, token, 'GET', '/api/loops');
      assert.strictEqual(list.status, 200);
      assert.strictEqual((list.data.loops as Loop[]).length, 1);

      const runNow = await api(port, token, 'POST', `/api/loops/${loop.id}/run-now`);
      assert.strictEqual(runNow.status, 200);
      assert.strictEqual(runNow.data.fired, true);
      assert.strictEqual(kicks, 1);

      const runSession: Session = {
        id: 'run-1',
        name: 'nightly run',
        command: 'codex',
        status: 'completed',
        bridgeId: 'bridge-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:05.000Z',
        loopId: loop.id,
        shellType: 'codex',
        prompt: 'run checks',
      };
      await store.saveSession(runSession);
      await store.appendTerminalData(runSession.id, 'persisted output');
      const runs = await api(port, token, 'GET', `/api/loops/${loop.id}/runs`);
      assert.strictEqual(runs.status, 200);
      const records = runs.data.runs as LoopRunRecord[];
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0].sessionId, 'run-1');
      assert.strictEqual(records[0].status, 'ok');
      assert.strictEqual(records[0].logTail, 'persisted output');
      await store.deleteSession(runSession.id);
      upsertLoopRunRecord({
        id: 'run-1',
        loopId: loop.id,
        bridgeId: 'bridge-1',
        sessionId: 'run-1',
        name: 'nightly run',
        status: 'ok',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:05.000Z',
        finishedAt: '2026-01-01T00:00:05.000Z',
        durationMs: 5000,
        logTail: 'durable record output',
        logBytes: 21,
        logTruncated: false,
      });
      const durableRuns = await api(port, token, 'GET', `/api/loops/${loop.id}/runs`);
      assert.strictEqual(durableRuns.status, 200);
      const durableRecords = durableRuns.data.runs as LoopRunRecord[];
      assert.strictEqual(durableRecords.length, 1);
      assert.strictEqual(durableRecords[0].logTail, 'durable record output');

      const pause = await api(port, token, 'PATCH', `/api/loops/${loop.id}`, { enabled: false });
      assert.strictEqual(pause.status, 200);
      assert.strictEqual((pause.data.loop as Loop).enabled, false);

      const del = await api(port, token, 'DELETE', `/api/loops/${loop.id}`);
      assert.strictEqual(del.status, 200);
      assert.strictEqual(del.data.removed, true);
      assert.deepStrictEqual(removed, [loop.id]);
      assert.strictEqual(deleted[0].id, loop.id);
    } finally {
      server.stop();
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/** Shared harness for the run-now/group tests below: a real LocalApiServer
 * backed by a throwaway ~/.ftown, with recording centrifugo/scheduler stubs. */
function setupLoopApiServer() {
  const realHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'ftw-loop-api-'));
  process.env.HOME = home;

  const server = new LocalApiServer();
  const token = 'test-token';
  const published: Loop[] = [];
  let kicks = 0;

  const store = new SessionStore(join(home, 'data'));
  const runner = { isRunning: () => false } as unknown as ProcessRunner;
  const centrifugo = {
    publishLoopUpdate: async (_userId: string, loop: Loop) => {
      published.push(loop);
    },
    publishLoopRemoved: async () => {},
  } as unknown as CentrifugoClient;

  server.setAuthToken(token);
  server.setDependencies(store, runner, centrifugo, 'user-1');
  server.setLoopApi({
    bridgeId: 'bridge-1',
    scheduler: {
      kick: () => {
        kicks += 1;
      },
      onLoopDeleted: () => {},
    },
  });

  return {
    server,
    token,
    published,
    kicks: () => kicks,
    async cleanup() {
      server.stop();
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('LocalApiServer run-now — deleted loop is never resurrected', () => {
  it('run-now on an id that no longer exists returns not_found and writes/publishes nothing', async () => {
    const h = setupLoopApiServer();
    try {
      const port = await h.server.start();
      const create = await api(port, h.token, 'POST', '/api/loops', {
        name: 'nightly',
        schedule: { kind: 'interval', everyMs: 60_000 },
        harness: 'codex',
        task: 'run checks',
        enabled: true,
        overlapPolicy: 'skip',
        retention: { autoClearAfterRuns: 3 },
      });
      const loop = create.data.loop as Loop;
      h.published.length = 0;

      deleteLoop(loop.id); // simulates a delete_loop that lands first

      const runNow = await api(port, h.token, 'POST', `/api/loops/${loop.id}/run-now`);
      assert.strictEqual(runNow.status, 404);
      assert.strictEqual(runNow.data.fired, false);
      assert.strictEqual(runNow.data.reason, 'not_found');
      assert.strictEqual(getLoop(loop.id), undefined, 'loop stays deleted, not resurrected');
      assert.deepStrictEqual(listLoops(), []);
      assert.strictEqual(h.published.length, 0, 'no loop_update publish for a deleted loop');
      assert.strictEqual(h.kicks(), 0);
    } finally {
      await h.cleanup();
    }
  });

  it('mutateLoopRuntime (the primitive the run-now handlers use) leaves loops.json untouched when the loop is deleted before the write lands', async () => {
    const h = setupLoopApiServer();
    try {
      const port = await h.server.start();
      const create = await api(port, h.token, 'POST', '/api/loops', {
        name: 'nightly',
        schedule: { kind: 'interval', everyMs: 60_000 },
        harness: 'codex',
        task: 'run checks',
        enabled: true,
        overlapPolicy: 'skip',
        retention: { autoClearAfterRuns: 3 },
      });
      const loop = create.data.loop as Loop;

      // Mirrors exactly what the fixed run-now handlers do: getLoop() to
      // decide overlap, then write the manual-fire flag via
      // mutateLoopRuntime — but here the loop is deleted in between.
      assert.ok(getLoop(loop.id), 'precondition: loop exists before the race');
      deleteLoop(loop.id); // a concurrent delete_loop wins the race
      const result = mutateLoopRuntime(loop.id, (l) => {
        l.runNowRequested = true;
        l.updatedAt = new Date().toISOString();
      });

      assert.strictEqual(result, null, 'the write is skipped, not resurrected');
      assert.deepStrictEqual(listLoops(), []);
    } finally {
      await h.cleanup();
    }
  });
});

describe('LocalApiServer loop group field', () => {
  it('trims group on create and clears it on an empty-string PATCH', async () => {
    const h = setupLoopApiServer();
    try {
      const port = await h.server.start();
      const create = await api(port, h.token, 'POST', '/api/loops', {
        name: 'nightly',
        schedule: { kind: 'interval', everyMs: 60_000 },
        harness: 'codex',
        task: 'run checks',
        enabled: true,
        overlapPolicy: 'skip',
        retention: { autoClearAfterRuns: 3 },
        group: '  infra  ',
      });
      assert.strictEqual(create.status, 201);
      const loop = create.data.loop as Loop;
      assert.strictEqual(loop.group, 'infra');

      const list = await api(port, h.token, 'GET', '/api/loops');
      assert.strictEqual((list.data.loops as Loop[])[0].group, 'infra');

      const renamed = await api(port, h.token, 'PATCH', `/api/loops/${loop.id}`, { group: '  ops  ' });
      assert.strictEqual((renamed.data.loop as Loop).group, 'ops');

      const cleared = await api(port, h.token, 'PATCH', `/api/loops/${loop.id}`, { group: '' });
      assert.strictEqual(cleared.status, 200);
      assert.strictEqual((cleared.data.loop as Loop).group, undefined);
      assert.strictEqual(getLoop(loop.id)!.group, undefined);
    } finally {
      await h.cleanup();
    }
  });

  it('a blank/whitespace-only group on create is stored as absent', async () => {
    const h = setupLoopApiServer();
    try {
      const port = await h.server.start();
      const create = await api(port, h.token, 'POST', '/api/loops', {
        name: 'nightly',
        schedule: { kind: 'interval', everyMs: 60_000 },
        harness: 'codex',
        task: 'run checks',
        enabled: true,
        overlapPolicy: 'skip',
        retention: { autoClearAfterRuns: 3 },
        group: '   ',
      });
      assert.strictEqual((create.data.loop as Loop).group, undefined);
    } finally {
      await h.cleanup();
    }
  });
});
