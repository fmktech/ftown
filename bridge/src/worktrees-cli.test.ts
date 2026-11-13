import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatPruneLines,
  formatWorktreeRow,
  runWorktrees,
  type WorktreeListEntry,
  type WorktreesCliDeps,
} from './worktrees-cli.js';

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

type Handler = (call: RecordedCall) => unknown;

function harness(handler: Handler): {
  deps: Partial<WorktreesCliDeps>;
  calls: RecordedCall[];
  out: string[];
  err: string[];
} {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: Partial<WorktreesCliDeps> = {
    api: async (method: string, path: string, body?: unknown) => {
      const call: RecordedCall = { method, path, body };
      calls.push(call);
      return handler(call);
    },
    now: () => Date.parse('2026-01-01T12:00:00.000Z'),
    env: {},
    log: (text: string) => out.push(text),
    errorLog: (text: string) => err.push(text),
  };
  return { deps, calls, out, err };
}

function makeEntry(overrides: Partial<WorktreeListEntry> = {}): WorktreeListEntry {
  const entry: WorktreeListEntry = {
    sessionId: 'sess-1',
    sessionName: 'worker-a',
    archived: false,
    worktree: {
      repoRoot: '/repo',
      path: '/repo/.claude/worktrees/worker-a',
      branch: 'ftown/worker-a',
      base: 'main',
      createdByBridge: true,
    },
    status: {
      path: '/repo/.claude/worktrees/worker-a',
      branch: 'ftown/worker-a',
      base: 'main',
      exists: true,
      dirty: false,
      ahead: 2,
      unpushed: 1,
      mergedIntoBase: false,
    },
  };
  return { ...entry, ...overrides };
}

test('formatWorktreeRow covers clean/dirty, unpushed null, merged and archived tokens', () => {
  assert.equal(
    formatWorktreeRow(makeEntry()),
    'worker-a ftown/worker-a clean ahead:2 unpushed:1 /repo/.claude/worktrees/worker-a',
  );
  const dirty = makeEntry();
  dirty.status = { ...dirty.status, dirty: true, ahead: 0, unpushed: null, mergedIntoBase: true };
  dirty.archived = true;
  assert.equal(
    formatWorktreeRow(dirty),
    'worker-a ftown/worker-a dirty ahead:0 unpushed:- merged (archived) /repo/.claude/worktrees/worker-a',
  );
  const mergedOnly = makeEntry();
  mergedOnly.status = { ...mergedOnly.status, unpushed: 0, mergedIntoBase: true };
  assert.equal(
    formatWorktreeRow(mergedOnly),
    'worker-a ftown/worker-a clean ahead:2 unpushed:0 merged /repo/.claude/worktrees/worker-a',
  );
  const archivedOnly = makeEntry({ archived: true });
  assert.equal(
    formatWorktreeRow(archivedOnly),
    'worker-a ftown/worker-a clean ahead:2 unpushed:1 (archived) /repo/.claude/worktrees/worker-a',
  );
});

test('formatPruneLines prints removed then retained with reasons', () => {
  assert.deepEqual(
    formatPruneLines({
      removed: ['/repo/.claude/worktrees/old-a'],
      retained: [{ path: '/repo/.claude/worktrees/old-b', reason: '2 unpushed commits' }],
    }),
    ['removed /repo/.claude/worktrees/old-a', 'retained /repo/.claude/worktrees/old-b: 2 unpushed commits'],
  );
  assert.deepEqual(formatPruneLines({ removed: [], retained: [] }), []);
});

test('list maps to GET /api/worktrees and prints one plain row per entry', async () => {
  const live = makeEntry();
  const archived = makeEntry({ sessionId: 'sess-2', sessionName: 'worker-b', archived: true });
  archived.worktree = { ...archived.worktree, path: '/repo/.claude/worktrees/worker-b', branch: 'ftown/worker-b' };
  archived.status = { ...archived.status, path: '/repo/.claude/worktrees/worker-b', branch: 'ftown/worker-b', dirty: true, ahead: 0, unpushed: null, mergedIntoBase: true };
  const { deps, calls, out } = harness(() => ({ worktrees: [live, archived] }));
  assert.equal(await runWorktrees(['list'], deps), 0);
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/worktrees', body: undefined }]);
  assert.deepEqual(out, [
    'worker-a ftown/worker-a clean ahead:2 unpushed:1 /repo/.claude/worktrees/worker-a',
    'worker-b ftown/worker-b dirty ahead:0 unpushed:- merged (archived) /repo/.claude/worktrees/worker-b',
  ]);
});

test('formatWorktreeRow prints an error row when status is null', () => {
  const failed = makeEntry({ status: null, error: 'git status failed: not a git repository' });
  assert.equal(
    formatWorktreeRow(failed),
    'worker-a ftown/worker-a error: git status failed: not a git repository /repo/.claude/worktrees/worker-a',
  );
});

test('list prints error rows alongside healthy rows and keeps --json as passthrough', async () => {
  const healthy = makeEntry();
  const failed = makeEntry({
    sessionId: 'sess-2',
    sessionName: 'worker-b',
    archived: true,
    status: null,
    error: 'worktree path missing',
  });
  failed.worktree = { ...failed.worktree, path: '/repo/.claude/worktrees/worker-b', branch: 'ftown/worker-b' };
  const payload = { worktrees: [healthy, failed] };

  const plain = harness(() => payload);
  assert.equal(await runWorktrees(['list'], plain.deps), 0);
  assert.deepEqual(plain.out, [
    'worker-a ftown/worker-a clean ahead:2 unpushed:1 /repo/.claude/worktrees/worker-a',
    'worker-b ftown/worker-b error: worktree path missing /repo/.claude/worktrees/worker-b',
  ]);

  const json = harness(() => payload);
  assert.equal(await runWorktrees(['list', '--json'], json.deps), 0);
  assert.deepEqual(JSON.parse(json.out.join('\n')), payload);
});

test('list --plain behaves like the default plain output', async () => {
  const { deps, out } = harness(() => ({ worktrees: [makeEntry()] }));
  assert.equal(await runWorktrees(['list', '--plain'], deps), 0);
  assert.deepEqual(out, ['worker-a ftown/worker-a clean ahead:2 unpushed:1 /repo/.claude/worktrees/worker-a']);
});

test('list --json prints the API payload as JSON without plain rows', async () => {
  const payload = { worktrees: [makeEntry()] };
  const { deps, calls, out } = harness(() => payload);
  assert.equal(await runWorktrees(['list', '--json'], deps), 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /api/worktrees']);
  assert.deepEqual(JSON.parse(out.join('\n')), payload);
});

test('list with no worktrees prints the empty message', async () => {
  const { deps, out } = harness(() => ({ worktrees: [] }));
  assert.equal(await runWorktrees(['list'], deps), 0);
  assert.deepEqual(out, ['no worktrees']);
});

test('prune maps to POST /api/worktrees/prune and prints removed and retained', async () => {
  const { deps, calls, out } = harness(() => ({
    removed: ['/repo/.claude/worktrees/old-a'],
    retained: [{ path: '/repo/.claude/worktrees/old-b', reason: 'uncommitted changes' }],
  }));
  assert.equal(await runWorktrees(['prune'], deps), 0);
  assert.deepEqual(calls, [{ method: 'POST', path: '/api/worktrees/prune', body: undefined }]);
  assert.deepEqual(out, [
    'removed /repo/.claude/worktrees/old-a',
    'retained /repo/.claude/worktrees/old-b: uncommitted changes',
  ]);
});

test('prune --json prints the API payload as JSON', async () => {
  const payload = { removed: ['/repo/.claude/worktrees/old-a'], retained: [] };
  const { deps, out } = harness(() => payload);
  assert.equal(await runWorktrees(['prune', '--json'], deps), 0);
  assert.deepEqual(JSON.parse(out.join('\n')), payload);
});

test('prune with nothing removed or retained prints the empty message', async () => {
  const { deps, out } = harness(() => ({ removed: [], retained: [] }));
  assert.equal(await runWorktrees(['prune'], deps), 0);
  assert.deepEqual(out, ['nothing to prune']);
});

test('missing subcommand exits 2 and makes no request', async () => {
  const { deps, calls, err } = harness(() => ({ worktrees: [] }));
  assert.equal(await runWorktrees([], deps), 2);
  assert.equal(calls.length, 0);
  assert.match(err.join('\n'), /Usage: ftown worktrees/);
});

test('unknown subcommand and unknown flags exit 2 and make no request', async () => {
  const cases: string[][] = [
    ['bogus'],
    ['list', '--bogus-flag'],
    ['prune', '--bogus-flag'],
    ['list', 'extra-positional'],
    ['--json'],
  ];
  for (const argv of cases) {
    const { deps, calls } = harness(() => ({ worktrees: [] }));
    assert.equal(await runWorktrees(argv, deps), 2, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});

test('help exits 0 for the group and each subcommand', async () => {
  for (const argv of [['--help'], ['list', '--help'], ['prune', '--help']]) {
    const { deps, calls } = harness(() => ({ worktrees: [] }));
    assert.equal(await runWorktrees(argv, deps), 0, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
  }
});

test('HTTP errors exit 1 with the server message for list and prune', async () => {
  for (const argv of [['list'], ['prune']]) {
    const { deps, err } = harness(() => {
      throw new Error('Bridge not running');
    });
    assert.equal(await runWorktrees(argv, deps), 1, argv.join(' '));
    assert.match(err.join('\n'), /Bridge not running/);
  }
});
