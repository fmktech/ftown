import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import * as routesWorktreesModule from './routes-worktrees.js';
import { createWorktreeRoutes, type WorktreeRoutesDeps } from './routes-worktrees.js';
import {
  RouteError,
  WORKTREE_ROUTES,
  WorktreeError,
  type RouteContext,
  type SessionWorktree,
  type WorktreeApi,
  type WorktreeRetireDecision,
  type WorktreeStatus,
} from './contract-b.js';
import type { Session } from '../types.js';

function makeWorktree(slug: string, overrides: Partial<SessionWorktree> = {}): SessionWorktree {
  return {
    repoRoot: '/repo',
    path: `/repo/.claude/worktrees/${slug}`,
    branch: `ftown/${slug}`,
    base: 'main',
    createdByBridge: true,
    ...overrides,
  };
}

function makeSession(id: string, name: string, worktree?: SessionWorktree): Session {
  return {
    id,
    name,
    command: 'claude',
    status: 'completed',
    bridgeId: 'bridge-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(worktree ? { workingDir: worktree.path, worktree } : {}),
  };
}

function makeStatus(wt: SessionWorktree, overrides: Partial<WorktreeStatus> = {}): WorktreeStatus {
  return {
    path: wt.path,
    branch: wt.branch,
    base: wt.base,
    exists: true,
    dirty: false,
    ahead: 0,
    unpushed: 0,
    mergedIntoBase: true,
    ...overrides,
  };
}

function makeFakeCtx(opts: {
  method: string;
  path: string;
  query?: string;
}): RouteContext & {
  response: { status: number; body: unknown } | null;
} {
  let response: { status: number; body: unknown } | null = null;
  return {
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    method: opts.method,
    path: opts.path,
    query: new URLSearchParams(opts.query ?? ''),
    parseBody: async () => ({}),
    json: (status, body) => {
      response = { status, body };
    },
    loadSession: async () => null,
    saveSession: async () => {},
    publishSession: () => {},
    get response() {
      return response;
    },
  };
}

function makeHarness(opts: {
  live?: Session[];
  archived?: Session[];
  statuses?: Map<string, WorktreeStatus>;
  statusErrorPaths?: Set<string>;
  decide?: (st: WorktreeStatus) => WorktreeRetireDecision;
  removeErrorPaths?: Set<string>;
  markRetainedErrorIds?: Set<string>;
} = {}) {
  const live = opts.live ?? [];
  const archived = opts.archived ?? [];
  const statuses = opts.statuses ?? new Map<string, WorktreeStatus>();
  const removeCalls: Array<{ wt: SessionWorktree; opts: { force: boolean; deleteBranch: boolean } }> = [];
  const retainedMarks: Array<{ sessionId: string; reason: string }> = [];

  const worktrees: WorktreeApi = {
    create: async () => makeWorktree('created'),
    status: async (wt) => {
      if (opts.statusErrorPaths?.has(wt.path)) {
        throw new WorktreeError('git_failed', `status failed for ${wt.path}`);
      }
      return statuses.get(wt.path) ?? makeStatus(wt);
    },
    decide: (st) => {
      if (opts.decide) return opts.decide(st);
      if (!st.exists) return { action: 'retain', reason: 'worktree missing' };
      if (st.dirty) return { action: 'retain', reason: 'uncommitted changes' };
      if (st.mergedIntoBase) return { action: 'remove', deleteBranch: true };
      if (st.unpushed === 0) return { action: 'remove', deleteBranch: false };
      return { action: 'retain', reason: `${st.unpushed ?? st.ahead} unpushed commits` };
    },
    remove: async (wt, removeOpts) => {
      removeCalls.push({ wt, opts: removeOpts });
      if (opts.removeErrorPaths?.has(wt.path)) {
        throw new WorktreeError('git_failed', `cannot remove ${wt.path}`);
      }
    },
  };

  const deps: WorktreeRoutesDeps = {
    listLive: async () => live,
    listArchived: async () => archived,
    worktrees,
    markRetained: async (sessionId, reason) => {
      if (opts.markRetainedErrorIds?.has(sessionId)) {
        throw new Error(`archive write failed for ${sessionId}`);
      }
      retainedMarks.push({ sessionId, reason });
    },
  };

  const route = createWorktreeRoutes(deps);
  return { route, removeCalls, retainedMarks };
}

describe('createWorktreeRoutes', () => {
  it('exports createWorktreeRoutes and does not export handleWorktreeRoutes', () => {
    assert.equal(typeof createWorktreeRoutes, 'function');
    assert.equal('handleWorktreeRoutes' in routesWorktreesModule, false);
  });

  it('returns false for non-matching paths', async () => {
    const { route } = makeHarness();
    const ctx = makeFakeCtx({ method: 'GET', path: '/api/sessions' });
    assert.equal(await route(ctx), false);
    assert.equal(ctx.response, null);
  });

  it('throws RouteError 405 for unsupported methods and 400 for unexpected query params', async () => {
    const { route } = makeHarness();

    await assert.rejects(
      () => route(makeFakeCtx({ method: 'POST', path: WORKTREE_ROUTES.list })),
      (err: unknown) => err instanceof RouteError && err.status === 405,
    );

    await assert.rejects(
      () => route(makeFakeCtx({ method: 'GET', path: WORKTREE_ROUTES.prune })),
      (err: unknown) => err instanceof RouteError && err.status === 405,
    );

    await assert.rejects(
      () => route(makeFakeCtx({ method: 'GET', path: WORKTREE_ROUTES.list, query: 'foo=1' })),
      (err: unknown) => err instanceof RouteError && err.status === 400,
    );
  });

  it('GET /api/worktrees lists live + archived sessions with bridge worktrees and statuses each', async () => {
    const wtLive = makeWorktree('live-worker');
    const wtArch = makeWorktree('arch-worker');
    const statuses = new Map<string, WorktreeStatus>([
      [wtLive.path, makeStatus(wtLive, { dirty: true, ahead: 2, unpushed: 1, mergedIntoBase: false })],
      [wtArch.path, makeStatus(wtArch, { dirty: false, ahead: 0, unpushed: 0, mergedIntoBase: true })],
    ]);

    const { route } = makeHarness({
      live: [
        makeSession('s-live', 'live-worker', wtLive),
        makeSession('s-plain', 'no-worktree'),
      ],
      archived: [
        makeSession('s-arch', 'arch-worker', wtArch),
        makeSession('s-arch-plain', 'arch-no-wt'),
      ],
      statuses,
    });

    const ctx = makeFakeCtx({ method: 'GET', path: WORKTREE_ROUTES.list });
    const handled = await route(ctx);

    assert.equal(handled, true);
    assert.equal(ctx.response?.status, 200);
    assert.deepEqual(ctx.response?.body, {
      worktrees: [
        {
          sessionId: 's-live',
          sessionName: 'live-worker',
          archived: false,
          worktree: wtLive,
          status: statuses.get(wtLive.path),
        },
        {
          sessionId: 's-arch',
          sessionName: 'arch-worker',
          archived: true,
          worktree: wtArch,
          status: statuses.get(wtArch.path),
        },
      ],
    });
  });

  it('POST /api/worktrees/prune inspects archived only, removes retirable worktrees, and marks retained ones', async () => {
    const wtLive = makeWorktree('live-clean');
    const wtMerged = makeWorktree('arch-merged');
    const wtPushed = makeWorktree('arch-pushed');
    const wtDirty = makeWorktree('arch-dirty');
    const wtGitFail = makeWorktree('arch-fail');

    const statuses = new Map<string, WorktreeStatus>([
      [wtLive.path, makeStatus(wtLive, { mergedIntoBase: true })],
      [wtMerged.path, makeStatus(wtMerged, { mergedIntoBase: true, dirty: false })],
      [wtPushed.path, makeStatus(wtPushed, { mergedIntoBase: false, unpushed: 0, dirty: false })],
      [wtDirty.path, makeStatus(wtDirty, { dirty: true, mergedIntoBase: false })],
      [wtGitFail.path, makeStatus(wtGitFail, { mergedIntoBase: true, dirty: false })],
    ]);

    const { route, removeCalls, retainedMarks } = makeHarness({
      live: [makeSession('s-live', 'live-clean', wtLive)],
      archived: [
        makeSession('s-merged', 'arch-merged', wtMerged),
        makeSession('s-pushed', 'arch-pushed', wtPushed),
        makeSession('s-dirty', 'arch-dirty', wtDirty),
        makeSession('s-fail', 'arch-fail', wtGitFail),
      ],
      statuses,
      removeErrorPaths: new Set([wtGitFail.path]),
    });

    const ctx = makeFakeCtx({ method: 'POST', path: WORKTREE_ROUTES.prune });
    const handled = await route(ctx);

    assert.equal(handled, true);
    assert.equal(ctx.response?.status, 200);
    assert.deepEqual(ctx.response?.body, {
      removed: [wtMerged.path, wtPushed.path],
      retained: [
        { path: wtDirty.path, reason: 'uncommitted changes' },
        { path: wtGitFail.path, reason: `cannot remove ${wtGitFail.path}` },
      ],
    });

    assert.deepEqual(removeCalls, [
      { wt: wtMerged, opts: { force: false, deleteBranch: true } },
      { wt: wtPushed, opts: { force: false, deleteBranch: false } },
      { wt: wtGitFail, opts: { force: false, deleteBranch: true } },
    ]);

    assert.deepEqual(retainedMarks, [
      { sessionId: 's-dirty', reason: 'uncommitted changes' },
      { sessionId: 's-fail', reason: `cannot remove ${wtGitFail.path}` },
    ]);
  });

  it('GET /api/worktrees catches status() errors per row and returns status: null + error', async () => {
    const wtBroken = makeWorktree('broken-wt');
    const wtOk = makeWorktree('ok-wt');
    const okStatus = makeStatus(wtOk);

    const { route } = makeHarness({
      live: [makeSession('s-broken', 'broken-wt', wtBroken)],
      archived: [makeSession('s-ok', 'ok-wt', wtOk)],
      statuses: new Map([[wtOk.path, okStatus]]),
      statusErrorPaths: new Set([wtBroken.path]),
    });

    const ctx = makeFakeCtx({ method: 'GET', path: WORKTREE_ROUTES.list });
    const handled = await route(ctx);

    assert.equal(handled, true);
    assert.equal(ctx.response?.status, 200);
    assert.deepEqual(ctx.response?.body, {
      worktrees: [
        {
          sessionId: 's-broken',
          sessionName: 'broken-wt',
          archived: false,
          worktree: wtBroken,
          status: null,
          error: `status failed for ${wtBroken.path}`,
        },
        {
          sessionId: 's-ok',
          sessionName: 'ok-wt',
          archived: true,
          worktree: wtOk,
          status: okStatus,
        },
      ],
    });
  });

  it('POST /api/worktrees/prune continues when markRetained throws on one session', async () => {
    const wtDirty1 = makeWorktree('dirty-1');
    const wtMerged = makeWorktree('merged-2');
    const wtDirty3 = makeWorktree('dirty-3');

    const statuses = new Map<string, WorktreeStatus>([
      [wtDirty1.path, makeStatus(wtDirty1, { dirty: true, mergedIntoBase: false })],
      [wtMerged.path, makeStatus(wtMerged, { dirty: false, mergedIntoBase: true })],
      [wtDirty3.path, makeStatus(wtDirty3, { dirty: true, mergedIntoBase: false })],
    ]);

    const { route, removeCalls, retainedMarks } = makeHarness({
      archived: [
        makeSession('s-dirty-1', 'dirty-1', wtDirty1),
        makeSession('s-merged-2', 'merged-2', wtMerged),
        makeSession('s-dirty-3', 'dirty-3', wtDirty3),
      ],
      statuses,
      markRetainedErrorIds: new Set(['s-dirty-1']),
    });

    const ctx = makeFakeCtx({ method: 'POST', path: WORKTREE_ROUTES.prune });
    const handled = await route(ctx);

    assert.equal(handled, true);
    assert.equal(ctx.response?.status, 200);
    assert.deepEqual(ctx.response?.body, {
      removed: [wtMerged.path],
      retained: [
        { path: wtDirty1.path, reason: 'uncommitted changes' },
        { path: wtDirty3.path, reason: 'uncommitted changes' },
      ],
    });
    assert.equal(removeCalls.length, 1);
    assert.deepEqual(retainedMarks, [
      { sessionId: 's-dirty-3', reason: 'uncommitted changes' },
    ]);
  });
});
