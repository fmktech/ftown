import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PlanItem } from './coordination/contract-c.js';
import type { CreateFtownSessionInput } from './create-ftown-session.js';
import { handoffSession, pickAvailableRouting, type SessionHandoffDeps } from './session-handoff.js';
import type { Session } from './types.js';

function session(partial: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    name: partial.id,
    command: 'muse',
    status: 'running',
    bridgeId: 'bridge',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    shellType: 'muse',
    model: 'old-model',
    ...partial,
  };
}

function item(sessionId: string): PlanItem {
  return {
    id: 'p2',
    title: 'Ship the handoff',
    after: [],
    priority: 1,
    state: 'started',
    sessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function harness(options: { git?: SessionHandoffDeps['git']; routing?: SessionHandoffDeps['routing']; archive?: (id: string) => Promise<void> } = {}) {
  const sessions = new Map<string, Session>();
  const created: CreateFtownSessionInput[] = [];
  const archived: string[] = [];
  let routingCalls = 0;
  const planItems = [item('old')];
  const deps: SessionHandoffDeps = {
    loadSession: async (id) => {
      const found = sessions.get(id);
      return found ? structuredClone(found) : null;
    },
    saveSession: async (next) => { sessions.set(next.id, structuredClone(next)); },
    publishSession: async () => {},
    createSession: async (input) => {
      created.push(input);
      const next = session({
        id: 'new-session',
        name: input.name ?? 'new',
        command: 'created',
        prompt: input.prompt,
        workingDir: input.workingDir,
        shellType: input.shellType,
        model: input.model,
        parentSessionId: input.parentSessionId,
        ...(input.requireGreenPr ? { requireGreenPr: true } : {}),
        status: 'pending',
      });
      sessions.set(next.id, structuredClone(next));
      return structuredClone(next);
    },
    archiveSession: async (id) => {
      archived.push(id);
      if (options.archive) await options.archive(id);
      else sessions.delete(id);
    },
    plan: {
      get: async () => ({ seq: 2, items: planItems.map((entry) => structuredClone(entry)) }),
      patch: async (_parent, itemId, input) => {
        const found = planItems.find((entry) => entry.id === itemId);
        if (!found) throw new Error('missing item');
        found.sessionId = input.sessionId;
        return structuredClone(found);
      },
    },
    loadTerminalLog: async () => 'Usage limit reached\nresets at 9:00 PM\n',
    routing: options.routing ?? {
      get: async () => {
        routingCalls += 1;
        return { report: { tiers: [{ picks: [{ provider: 'grok', model: 'fast', problem: null, availability: 'available' }] }] } };
      },
    },
    git: options.git,
  };
  return { sessions, created, archived, planItems, deps, routingCalls: () => routingCalls };
}

test('pickAvailableRouting skips exhausted and broken providers', () => {
  const picked = pickAvailableRouting([
    { picks: [{ provider: 'claude', model: 'slow', problem: 'quota', availability: 'available' }, { provider: 'nope', model: 'x', problem: null, availability: 'available' }] },
    { picks: [{ provider: 'muse', model: '  ', problem: null, availability: 'available' }, { provider: 'agy', model: 'fast', problem: null, availability: 'exhausted' }, { provider: 'grok', model: 'fast', problem: null, availability: 'low' }] },
  ]);
  assert.deepEqual(picked, { shellType: 'grok', model: 'fast' });
});

test('handoff commits a dirty linked worktree, moves the plan and pull request, and archives the old session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ftown-handoff-'));
  const repo = join(root, 'repo');
  const wt = join(root, 'wt');
  try {
    mkdirSync(repo);
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, ['-c', 'user.email=ftown@localhost', '-c', 'user.name=ftown', 'add', 'a.txt']);
    git(repo, ['-c', 'user.email=ftown@localhost', '-c', 'user.name=ftown', 'commit', '-m', 'init']);
    git(repo, ['worktree', 'add', '-b', 'feature', wt]);
    writeFileSync(join(wt, 'dirty.txt'), 'dirty\n');

    const h = harness();
    h.sessions.set('parent', session({ id: 'parent', shellType: 'shell', command: 'zsh' }));
    h.sessions.set('old', session({
      id: 'old',
      name: 'worker',
      prompt: 'original task',
      parentSessionId: 'parent',
      workingDir: wt,
      pullRequestUrl: 'https://github.com/owner/repo/pull/9',
      pullRequestLinkId: 'link-1',
      requireGreenPr: true,
      worktree: { repoRoot: repo, path: wt, branch: 'feature', base: 'main', createdByBridge: true },
      block: { reason: 'usage_limit', resetAt: '2026-01-02T02:00:00.000Z', screenTail: 'Usage limit reached', detectedAt: '2026-01-01T00:00:00.000Z', transitionKey: 'usage_limit|2026-01-02T02:00:00.000Z|running' },
    }));
    const result = await handoffSession(h.deps, 'old', {});
    assert.equal(result.previousId, 'old');
    assert.equal(result.committed, true);
    assert.equal(result.session.id, 'new-session');
    assert.equal(git(wt, ['log', '-1', '--format=%s']).trim(), 'wip: handoff from old');
    assert.equal(git(wt, ['status', '--porcelain']), '');
    const input = h.created[0];
    assert.equal(input.workingDir, wt);
    assert.equal(input.shellType, 'grok');
    assert.equal(input.model, 'fast');
    assert.equal(input.parentSessionId, 'parent');
    assert.equal(input.requireGreenPr, true);
    assert.equal(input.worktree, undefined);
    assert.equal(input.planItem, undefined);
    assert.match(input.prompt ?? '', /original task/);
    assert.match(input.prompt ?? '', /Usage limit reached/);
    assert.match(input.prompt ?? '', /pullRequest: https:\/\/github.com\/owner\/repo\/pull\/9/);
    assert.match(input.prompt ?? '', /p2 Ship the handoff/);
    assert.equal(h.planItems[0].sessionId, 'new-session');
    assert.equal(result.session.pullRequestUrl, 'https://github.com/owner/repo/pull/9');
    assert.equal(result.session.pullRequestLinkId, 'link-1');
    assert.equal(result.session.worktree?.path, wt);
    assert.equal(result.session.workingDir, wt);
    assert.deepEqual(h.archived, ['old']);
    assert.equal(h.sessions.has('old'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a subdirectory of the checkout is not committed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ftown-handoff-repo-'));
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git(['init', '-b', 'main']);
    mkdirSync(join(root, 'bridge'));
    writeFileSync(join(root, 'bridge', 'package.json'), '{}\n');
    writeFileSync(join(root, 'readme.txt'), 'keep\n');
    git(['-c', 'user.email=ftown@localhost', '-c', 'user.name=ftown', 'add', '-A']);
    git(['-c', 'user.email=ftown@localhost', '-c', 'user.name=ftown', 'commit', '-m', 'init']);
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'dirty.txt'), 'nope\n');
    const calls: string[][] = [];
    const h = harness({
      git: async (cwd, args) => {
        calls.push([cwd, ...args]);
        try {
          const stdout = execFileSync('git', args, { cwd, encoding: 'utf8' });
          return { code: 0, stdout, stderr: '' };
        } catch (err) {
          const failure = err as { status?: number; stdout?: string; stderr?: string };
          return { code: failure.status ?? 1, stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? '') };
        }
      },
    });
    h.sessions.set('old', session({ id: 'old', workingDir: sub, prompt: 'stay' }));
    const result = await handoffSession(h.deps, 'old', { shellType: 'shell' });
    assert.equal(result.committed, false);
    assert.match(h.created[0].prompt ?? '', /no commit: working directory is not a dedicated worktree/);
    assert.equal(calls.some((args) => args.includes('commit')), false);
    assert.equal(git(['log', '-1', '--format=%s']).trim(), 'init');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a directory that is not a git repository is left uncommitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-handoff-plain-'));
  try {
    const h = harness();
    h.sessions.set('old', session({ id: 'old', workingDir: dir }));
    const result = await handoffSession(h.deps, 'old', { shellType: 'shell', model: 'plain' });
    assert.equal(result.committed, false);
    assert.match(h.created[0].prompt ?? '', /no commit: not a git repository/);
    assert.equal(h.created[0].shellType, 'shell');
    assert.equal(h.created[0].model, 'plain');
    assert.equal(h.routingCalls(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a routing failure keeps the current harness', async () => {
  const h = harness({ routing: { get: async () => { throw new Error('quota down'); } } });
  h.sessions.set('old', session({ id: 'old', shellType: 'opencode', model: 'kept' }));
  const result = await handoffSession(h.deps, 'old', {});
  assert.equal(result.session.shellType, 'opencode');
  assert.equal(result.session.model, 'kept');
  assert.match(h.created[0].prompt ?? '', /no commit: session has no working directory/);
});

test('an archive failure names the session that was already created', async () => {
  const h = harness({ archive: async () => { throw new Error('disk full'); } });
  h.sessions.set('old', session({ id: 'old' }));
  await assert.rejects(
    () => handoffSession(h.deps, 'old', { shellType: 'shell' }),
    /Handoff created new-session but could not finish moving old: disk full/,
  );
});
