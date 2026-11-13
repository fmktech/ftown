import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

import { GitWorktrees, WorktreeError, slugifyWorktreeName } from './worktrees.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return stdout.trim();
}

async function createRepoFixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ftown-wt-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repoDir = join(root, 'repo');
  const remoteDir = join(root, 'remote.git');
  await mkdir(repoDir, { recursive: true });

  await git(root, 'init', '--bare', remoteDir);
  await git(repoDir, 'init', '-b', 'main');
  await git(repoDir, 'config', 'user.name', 'Test User');
  await git(repoDir, 'config', 'user.email', 'test@example.com');
  await git(repoDir, 'remote', 'add', 'origin', remoteDir);

  await writeFile(join(repoDir, '.gitignore'), 'ignored.log\n.claude/worktrees/\n');
  await writeFile(join(repoDir, 'README.md'), '# test\n');
  await git(repoDir, 'add', '.gitignore', 'README.md');
  await git(repoDir, 'commit', '-m', 'Initial commit');
  await git(repoDir, 'push', '-u', 'origin', 'main');

  return { root, repoDir, remoteDir, worktrees: new GitWorktrees({ now: () => 1_700_000_000_000 }) };
}

describe('slugifyWorktreeName', () => {
  it('lowercases, restricts to [a-z0-9-], and handles edge cases up to 48 chars', () => {
    assert.equal(slugifyWorktreeName('Worker_A1: Fix Auth!'), 'worker-a1-fix-auth');
    const long = slugifyWorktreeName('A'.repeat(60) + '---');
    assert.equal(long.length, 48);
    assert.match(long, /^[a-z0-9-]+$/);
    // Truncation at boundary where char 48 would have been a hyphen trims trailing hyphen
    const boundaryHyphen = slugifyWorktreeName(`${'a'.repeat(47)}-bbb`);
    assert.equal(boundaryHyphen, 'a'.repeat(47));
    assert.equal(slugifyWorktreeName('---leading-and-trailing---'), 'leading-and-trailing');
    assert.equal(slugifyWorktreeName(''), 'session');
    assert.equal(slugifyWorktreeName('!!!'), 'session');
  });
});

describe('GitWorktrees.create', () => {
  it('creates a worktree with default branch and path, and resolves main repoRoot from a linked worktree', async (t) => {
    const { repoDir, worktrees } = await createRepoFixture(t);

    const wt1 = await worktrees.create({
      fromDir: repoDir,
      name: 'Child Worker #1',
    });

    assert.equal(wt1.repoRoot, repoDir);
    assert.equal(wt1.branch, 'ftown/child-worker-1');
    assert.equal(wt1.base, 'main');
    assert.equal(wt1.path, join(repoDir, '.claude', 'worktrees', 'child-worker-1'));
    assert.equal(wt1.createdByBridge, true);
    assert.equal(existsSync(wt1.path), true);
    assert.equal(await git(wt1.path, 'symbolic-ref', '--short', 'HEAD'), 'ftown/child-worker-1');

    // Creating a second worktree when fromDir is itself the linked worktree wt1.path:
    // repoRoot must resolve to the main worktree's root (repoDir), not wt1.path.
    const wt2 = await worktrees.create({
      fromDir: wt1.path,
      name: 'Nested Request',
      branch: 'feat/custom-branch',
      base: 'main',
    });
    assert.equal(wt2.repoRoot, repoDir);
    assert.equal(wt2.branch, 'feat/custom-branch');
    assert.equal(wt2.base, 'main');
    assert.equal(wt2.path, join(repoDir, '.claude', 'worktrees', 'nested-request'));
    assert.equal(existsSync(wt2.path), true);
  });

  it('rejects bad branch (including @{-1}), nonexistent base, detached HEAD without --base, non-repo directory, and path/branch collisions', async (t) => {
    const { root, repoDir, worktrees } = await createRepoFixture(t);

    // 1. Not a repo (non-repo dir and missing dir)
    const nonRepo = join(root, 'not-a-repo');
    await mkdir(nonRepo, { recursive: true });
    await assert.rejects(
      worktrees.create({ fromDir: nonRepo, name: 'w1' }),
      (err: unknown) => err instanceof WorktreeError && err.code === 'not_a_repo',
    );
    await assert.rejects(
      worktrees.create({ fromDir: join(root, 'does-not-exist'), name: 'w1' }),
      (err: unknown) => err instanceof WorktreeError && err.code === 'not_a_repo',
    );

    // 2. Bad branch (including '@{-1}' and '@{u}')
    await git(repoDir, 'checkout', '-b', 'prev-branch');
    await git(repoDir, 'checkout', 'main');
    for (const badBranch of ['bad..branch', 'bad space', '-flag', '', '@{-1}', 'feat@{0}']) {
      await assert.rejects(
        worktrees.create({ fromDir: repoDir, name: 'w-bad', branch: badBranch }),
        (err: unknown) => err instanceof WorktreeError && err.code === 'bad_branch',
        `Expected bad_branch for ${ JSON.stringify(badBranch) }`,
      );
    }

    // 3. Nonexistent base ref -> WorktreeError('git_failed')
    await assert.rejects(
      worktrees.create({ fromDir: repoDir, name: 'bad-base', base: 'nonexistent-base-ref' }),
      (err: unknown) => err instanceof WorktreeError && err.code === 'git_failed',
    );

    // 4. Detached HEAD without base fails with detached_head, but succeeds with explicit base
    const headSha = await git(repoDir, 'rev-parse', 'HEAD');
    await git(repoDir, 'checkout', '--detach', headSha);
    await assert.rejects(
      worktrees.create({ fromDir: repoDir, name: 'detached-no-base' }),
      (err: unknown) =>
        err instanceof WorktreeError &&
        err.code === 'detached_head' &&
        err.message.includes('detached HEAD; pass --base'),
    );

    const fromDetachedWithBase = await worktrees.create({
      fromDir: repoDir,
      name: 'detached-with-base',
      base: 'main',
    });
    assert.equal(fromDetachedWithBase.base, 'main');
    await git(repoDir, 'checkout', 'main');

    // 5. Path / branch collision -> WorktreeError('exists')
    await assert.rejects(
      worktrees.create({ fromDir: repoDir, name: 'detached-with-base', branch: 'ftown/another-branch' }),
      (err: unknown) => err instanceof WorktreeError && err.code === 'exists',
    );
    await assert.rejects(
      worktrees.create({ fromDir: repoDir, name: 'different-slug', branch: fromDetachedWithBase.branch }),
      (err: unknown) => err instanceof WorktreeError && err.code === 'exists',
    );
  });
});

describe('GitWorktrees.status, decide, and remove', () => {
  it('tracks dirty (untracked vs ignored), ahead, unpushed, and mergedIntoBase accurately', async (t) => {
    const { repoDir, worktrees } = await createRepoFixture(t);

    const wt = await worktrees.create({
      fromDir: repoDir,
      name: 'feature-worker',
    });

    // Fresh worktree: clean, 0 ahead, no upstream (unpushed: null), mergedIntoBase: true
    let st = await worktrees.status(wt);
    assert.deepEqual(st, {
      path: wt.path,
      branch: 'ftown/feature-worker',
      base: 'main',
      exists: true,
      dirty: false,
      ahead: 0,
      unpushed: null,
      mergedIntoBase: true,
    });

    // Ignored file does NOT make status dirty
    await writeFile(join(wt.path, 'ignored.log'), 'noise\n');
    st = await worktrees.status(wt);
    assert.equal(st.dirty, false);

    // Untracked non-ignored file DOES make status dirty
    await writeFile(join(wt.path, 'feature.txt'), 'hello\n');
    st = await worktrees.status(wt);
    assert.equal(st.dirty, true);

    // Commit the file -> clean, ahead: 1, unpushed: null, mergedIntoBase: false
    await git(wt.path, 'add', 'feature.txt');
    await git(wt.path, 'commit', '-m', 'Add feature');
    st = await worktrees.status(wt);
    assert.equal(st.dirty, false);
    assert.equal(st.ahead, 1);
    assert.equal(st.unpushed, null);
    assert.equal(st.mergedIntoBase, false);

    // Push with upstream tracking -> unpushed: 0
    await git(wt.path, 'push', '-u', 'origin', wt.branch);
    st = await worktrees.status(wt);
    assert.equal(st.unpushed, 0);
    assert.equal(st.mergedIntoBase, false);

    // Make a second local commit without pushing -> ahead: 2, unpushed: 1
    await writeFile(join(wt.path, 'feature2.txt'), 'world\n');
    await git(wt.path, 'add', 'feature2.txt');
    await git(wt.path, 'commit', '-m', 'Second commit');
    st = await worktrees.status(wt);
    assert.equal(st.ahead, 2);
    assert.equal(st.unpushed, 1);
    assert.equal(st.mergedIntoBase, false);

    // Merge branch into main -> mergedIntoBase: true, ahead: 0
    await git(repoDir, 'merge', '--ff-only', wt.branch);
    st = await worktrees.status(wt);
    assert.equal(st.ahead, 0);
    assert.equal(st.mergedIntoBase, true);
  });

  it('implements the pure decide table for every status combination', () => {
    const worktrees = new GitWorktrees();
    const baseStatus = {
      path: '/tmp/wt',
      branch: 'ftown/w1',
      base: 'main',
      exists: true,
      dirty: false,
      ahead: 0,
      unpushed: null as number | null,
      mergedIntoBase: true,
    };

    // 1. Missing worktree -> retain
    assert.deepEqual(worktrees.decide({ ...baseStatus, exists: false }), {
      action: 'retain',
      reason: 'worktree missing',
    });

    // 2. Dirty worktree -> retain 'uncommitted changes' even if merged or pushed
    assert.deepEqual(worktrees.decide({ ...baseStatus, dirty: true, mergedIntoBase: true }), {
      action: 'retain',
      reason: 'uncommitted changes',
    });

    // 3. Clean + mergedIntoBase -> remove + deleteBranch: true
    assert.deepEqual(worktrees.decide({ ...baseStatus, mergedIntoBase: true, unpushed: null }), {
      action: 'remove',
      deleteBranch: true,
    });

    // 4. Clean + not mergedIntoBase + unpushed === 0 -> remove + deleteBranch: false
    assert.deepEqual(worktrees.decide({ ...baseStatus, mergedIntoBase: false, ahead: 2, unpushed: 0 }), {
      action: 'remove',
      deleteBranch: false,
    });

    // 5. Clean + not mergedIntoBase + unpushed > 0 -> retain with unpushed count
    assert.deepEqual(worktrees.decide({ ...baseStatus, mergedIntoBase: false, ahead: 2, unpushed: 2 }), {
      action: 'retain',
      reason: '2 unpushed commits',
    });
    assert.deepEqual(worktrees.decide({ ...baseStatus, mergedIntoBase: false, ahead: 1, unpushed: 1 }), {
      action: 'retain',
      reason: '1 unpushed commit',
    });

    // 6. Clean + not mergedIntoBase + no upstream -> retain with unmerged count
    assert.deepEqual(worktrees.decide({ ...baseStatus, mergedIntoBase: false, ahead: 3, unpushed: null }), {
      action: 'retain',
      reason: '3 unmerged commits',
    });
  });

  it('status fails closed by throwing WorktreeError(git_failed) on plain subdirectories or broken refs, and returns exists:false on missing path', async (t) => {
    const { repoDir, worktrees } = await createRepoFixture(t);

    // 1. Missing path -> exists: false, decide -> retain 'worktree missing', remove -> throws git_failed
    const missingWt = {
      repoRoot: repoDir,
      path: join(repoDir, '.claude', 'worktrees', 'missing-wt'),
      branch: 'ftown/missing-wt',
      base: 'main',
      createdByBridge: true as const,
    };
    const missingStatus = await worktrees.status(missingWt);
    assert.equal(missingStatus.exists, false);
    assert.deepEqual(worktrees.decide(missingStatus), { action: 'retain', reason: 'worktree missing' });
    await assert.rejects(
      worktrees.remove(missingWt, { force: false, deleteBranch: false }),
      (err: unknown) => err instanceof WorktreeError && err.code === 'git_failed',
    );

    // 2. Plain directory inside repoDir (where --show-toplevel resolves to repoDir != wt.path) -> throws git_failed
    const plainSubdir = join(repoDir, '.claude', 'worktrees', 'plain-dir');
    await mkdir(plainSubdir, { recursive: true });
    await assert.rejects(
      worktrees.status({
        repoRoot: repoDir,
        path: plainSubdir,
        branch: 'main',
        base: 'main',
        createdByBridge: true,
      }),
      (err: unknown) => err instanceof WorktreeError && err.code === 'git_failed',
    );

    // 3. Valid worktree but broken/nonexistent base ref -> rev-list fails -> status throws git_failed
    const wt = await worktrees.create({ fromDir: repoDir, name: 'broken-ref-check' });
    await assert.rejects(
      worktrees.status({ ...wt, base: 'refs/heads/does-not-exist' }),
      (err: unknown) => err instanceof WorktreeError && err.code === 'git_failed',
    );
  });

  it('remove refuses dirty worktree when force:false, removes when force:true, deletes merged branch, and never deletes unmerged branch', async (t) => {
    const warnMock = t.mock.method(console, 'warn', () => {});
    const { repoDir, worktrees } = await createRepoFixture(t);

    // Case 1: Dirty worktree refused with force: false, removed with force: true
    const wtDirty = await worktrees.create({ fromDir: repoDir, name: 'dirty-worker' });
    await writeFile(join(wtDirty.path, 'dirty.txt'), 'uncommitted\n');
    await assert.rejects(
      worktrees.remove(wtDirty, { force: false, deleteBranch: false }),
      (err: unknown) => err instanceof WorktreeError && err.code === 'git_failed',
    );
    assert.equal(existsSync(wtDirty.path), true);

    await worktrees.remove(wtDirty, { force: true, deleteBranch: false });
    assert.equal(existsSync(wtDirty.path), false);

    // Case 2: Merged branch is deleted when deleteBranch: true
    const wtMerged = await worktrees.create({ fromDir: repoDir, name: 'merged-worker' });
    await writeFile(join(wtMerged.path, 'merged.txt'), 'done\n');
    await git(wtMerged.path, 'add', 'merged.txt');
    await git(wtMerged.path, 'commit', '-m', 'Merged work');
    await git(repoDir, 'merge', '--ff-only', wtMerged.branch);

    const mergedStatus = await worktrees.status(wtMerged);
    const mergedDecision = worktrees.decide(mergedStatus);
    assert.deepEqual(mergedDecision, { action: 'remove', deleteBranch: true });

    await worktrees.remove(wtMerged, { force: false, deleteBranch: mergedDecision.deleteBranch });
    assert.equal(existsSync(wtMerged.path), false);
    await assert.rejects(git(repoDir, 'show-ref', '--verify', `refs/heads/${wtMerged.branch}`));

    // Case 3: Unmerged branch (even when pushed to upstream and even if deleteBranch: true is passed) is NEVER deleted and logs warning
    const wtUnmerged = await worktrees.create({ fromDir: repoDir, name: 'unmerged-worker' });
    await writeFile(join(wtUnmerged.path, 'unmerged.txt'), 'wip\n');
    await git(wtUnmerged.path, 'add', 'unmerged.txt');
    await git(wtUnmerged.path, 'commit', '-m', 'Unmerged work');
    await git(wtUnmerged.path, 'push', '-u', 'origin', wtUnmerged.branch);

    const unmergedStatus = await worktrees.status(wtUnmerged);
    const unmergedDecision = worktrees.decide(unmergedStatus);
    assert.deepEqual(unmergedDecision, { action: 'remove', deleteBranch: false });

    // Even if caller passes deleteBranch: true, remove must never delete an unmerged branch
    const warnsBefore = warnMock.mock.calls.length;
    await worktrees.remove(wtUnmerged, { force: false, deleteBranch: true });
    assert.equal(existsSync(wtUnmerged.path), false);
    assert.ok(warnMock.mock.calls.length > warnsBefore, 'warns when skipping deletion of unmerged branch');
    const branchRef = await git(repoDir, 'show-ref', '--verify', `refs/heads/${wtUnmerged.branch}`);
    assert.ok(branchRef.includes(wtUnmerged.branch), 'unmerged branch must remain in refs/heads');
  });
});
