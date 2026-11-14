import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  WorktreeError,
  type SessionWorktree,
  type WorktreeApi,
  type WorktreeCreateRequest,
  type WorktreeRetireDecision,
  type WorktreeStatus,
} from './coordination/contract-b.js';

export {
  WorktreeError,
  type SessionWorktree,
  type WorktreeApi,
  type WorktreeCreateRequest,
  type WorktreeRetireDecision,
  type WorktreeStatus,
};

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const SLUG_MAX_LENGTH = 48;

export interface GitWorktreesOptions {
  now?: () => number;
}

export function slugifyWorktreeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return cleaned || 'session';
}

interface GitResult {
  stdout: string;
  stderr: string;
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  const { stdout, stderr } = await execFileAsync('git', [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { stdout, stderr };
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return stderr.trim();
    }
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim();
    }
  }
  return String(err);
}

export class GitWorktrees implements WorktreeApi {
  constructor(_options: GitWorktreesOptions = {}) {}

  async create(req: WorktreeCreateRequest): Promise<SessionWorktree> {
    const fromDir = req.fromDir;
    if (!fromDir || !existsSync(fromDir)) {
      throw new WorktreeError('not_a_repo', `Directory does not exist: ${fromDir}`);
    }

    let topLevelRaw: string;
    let gitDirRaw: string;
    let commonDirRaw: string;
    try {
      topLevelRaw = (await runGit(fromDir, ['rev-parse', '--show-toplevel'])).stdout.trim();
      gitDirRaw = (await runGit(fromDir, ['rev-parse', '--git-dir'])).stdout.trim();
      commonDirRaw = (await runGit(fromDir, ['rev-parse', '--git-common-dir'])).stdout.trim();
    } catch (err) {
      throw new WorktreeError('not_a_repo', `Not a git repository (${fromDir}): ${errorMessage(err)}`);
    }

    const topLevel = await realpath(resolve(fromDir, topLevelRaw));
    const gitDir = await realpath(resolve(fromDir, gitDirRaw));
    const commonDir = await realpath(resolve(fromDir, commonDirRaw));
    // When fromDir is itself a linked worktree, gitDir !== commonDir; use the main worktree's root (commonDir parent).
    const repoRoot = gitDir !== commonDir ? await realpath(dirname(commonDir)) : topLevel;

    let base: string;
    if (req.base !== undefined && req.base.trim().length > 0) {
      base = req.base.trim();
      if (base.startsWith('-')) {
        throw new WorktreeError('git_failed', `Invalid base ref: ${base}`);
      }
      try {
        await runGit(fromDir, ['rev-parse', '--verify', `${base}^{commit}`]);
      } catch (err) {
        throw new WorktreeError('git_failed', `Unknown base ref '${base}': ${errorMessage(err)}`);
      }
    } else {
      try {
        base = (await runGit(fromDir, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
      } catch {
        throw new WorktreeError('detached_head', 'detached HEAD; pass --base');
      }
      if (!base) {
        throw new WorktreeError('detached_head', 'detached HEAD; pass --base');
      }
    }

    const slug = slugifyWorktreeName(req.name);
    const rawBranch = req.branch !== undefined ? req.branch.trim() : `ftown/${slug}`;
    if (!rawBranch || rawBranch.startsWith('-') || rawBranch.includes('@{')) {
      throw new WorktreeError('bad_branch', `Invalid branch name: ${req.branch ?? ''}`);
    }

    try {
      const checked = (await runGit(repoRoot, ['check-ref-format', '--branch', rawBranch])).stdout.trim();
      if (checked !== rawBranch) {
        throw new WorktreeError('bad_branch', `Invalid branch name '${rawBranch}'`);
      }
    } catch (err) {
      if (err instanceof WorktreeError) throw err;
      throw new WorktreeError('bad_branch', `Invalid branch name '${rawBranch}': ${errorMessage(err)}`);
    }
    const branch = rawBranch;

    const worktreePath = join(repoRoot, '.claude', 'worktrees', slug);
    if (existsSync(worktreePath)) {
      throw new WorktreeError('exists', `Worktree path already exists: ${worktreePath}`);
    }

    try {
      await runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      throw new WorktreeError('exists', `Branch already exists: ${branch}`);
    } catch (err) {
      if (err instanceof WorktreeError) throw err;
    }

    await mkdir(dirname(worktreePath), { recursive: true });

    try {
      await runGit(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, base]);
    } catch (err) {
      const msg = errorMessage(err);
      if (/already exists|already checked out/i.test(msg)) {
        throw new WorktreeError('exists', msg);
      }
      throw new WorktreeError('git_failed', msg);
    }

    const realWorktreePath = await realpath(worktreePath);
    return {
      repoRoot,
      path: realWorktreePath,
      branch,
      base,
      createdByBridge: true,
    };
  }

  async status(wt: SessionWorktree): Promise<WorktreeStatus> {
    if (!existsSync(wt.path)) {
      return {
        path: wt.path,
        branch: wt.branch,
        base: wt.base,
        exists: false,
        dirty: false,
        ahead: 0,
        unpushed: null,
        mergedIntoBase: false,
      };
    }

    let realWtPath: string;
    let topLevel: string;
    try {
      realWtPath = await realpath(wt.path);
      const topOut = (await runGit(realWtPath, ['rev-parse', '--show-toplevel'])).stdout.trim();
      topLevel = await realpath(resolve(realWtPath, topOut));
    } catch (err) {
      throw new WorktreeError('git_failed', `Failed to resolve worktree root (${wt.path}): ${errorMessage(err)}`);
    }

    if (topLevel !== realWtPath) {
      throw new WorktreeError(
        'git_failed',
        `Worktree path '${wt.path}' is not a standalone worktree toplevel (resolved to '${topLevel}')`,
      );
    }

    let dirty: boolean;
    try {
      const porcelain = (await runGit(realWtPath, ['status', '--porcelain'])).stdout;
      dirty = porcelain.trim().length > 0;
    } catch (err) {
      throw new WorktreeError('git_failed', `Failed to read worktree status: ${errorMessage(err)}`);
    }

    let ahead: number;
    try {
      const countRaw = (await runGit(realWtPath, ['rev-list', '--count', `${wt.base}..${wt.branch}`])).stdout.trim();
      const parsed = Number.parseInt(countRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Unexpected rev-list count: ${countRaw}`);
      }
      ahead = parsed;
    } catch (err) {
      throw new WorktreeError('git_failed', `Failed to count commits ahead of base: ${errorMessage(err)}`);
    }

    let unpushed: number | null = null;
    let upstreamRef: string;
    try {
      upstreamRef = (
        await runGit(realWtPath, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${wt.branch}`])
      ).stdout.trim();
    } catch (err) {
      throw new WorktreeError('git_failed', `Failed to inspect branch upstream: ${errorMessage(err)}`);
    }

    if (upstreamRef.length > 0) {
      try {
        const countRaw = (await runGit(realWtPath, ['rev-list', '--count', `${wt.branch}@{u}..${wt.branch}`])).stdout.trim();
        const parsed = Number.parseInt(countRaw, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Unexpected unpushed count: ${countRaw}`);
        }
        unpushed = parsed;
      } catch (err) {
        throw new WorktreeError('git_failed', `Failed to count unpushed commits: ${errorMessage(err)}`);
      }
    }

    let mergedIntoBase = false;
    try {
      await runGit(realWtPath, ['merge-base', '--is-ancestor', wt.branch, wt.base]);
      mergedIntoBase = true;
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === 1) {
        mergedIntoBase = false;
      } else {
        throw new WorktreeError('git_failed', `Failed to check merge status: ${errorMessage(err)}`);
      }
    }

    return {
      path: wt.path,
      branch: wt.branch,
      base: wt.base,
      exists: true,
      dirty,
      ahead,
      unpushed,
      mergedIntoBase,
    };
  }

  decide(status: WorktreeStatus): WorktreeRetireDecision {
    if (!status.exists) {
      return { action: 'retain', reason: 'worktree missing' };
    }
    if (status.dirty) {
      return { action: 'retain', reason: 'uncommitted changes' };
    }
    if (status.mergedIntoBase) {
      return { action: 'remove', deleteBranch: true };
    }
    if (status.unpushed === 0) {
      return { action: 'remove', deleteBranch: false };
    }
    if (status.unpushed !== null && status.unpushed > 0) {
      return {
        action: 'retain',
        reason: `${status.unpushed} unpushed commit${status.unpushed === 1 ? '' : 's'}`,
      };
    }
    if (status.ahead > 0) {
      return {
        action: 'retain',
        reason: `${status.ahead} unmerged commit${status.ahead === 1 ? '' : 's'}`,
      };
    }
    return { action: 'retain', reason: 'unmerged branch' };
  }

  async remove(wt: SessionWorktree, opts: { force: boolean; deleteBranch: boolean }): Promise<void> {
    const removeArgs = ['worktree', 'remove', ...(opts.force ? ['--force'] : []), wt.path];
    try {
      await runGit(wt.repoRoot, removeArgs);
    } catch (err) {
      throw new WorktreeError('git_failed', errorMessage(err));
    }

    if (opts.deleteBranch) {
      let merged = false;
      try {
        await runGit(wt.repoRoot, ['merge-base', '--is-ancestor', wt.branch, wt.base]);
        merged = true;
      } catch (err) {
        const code = (err as { code?: unknown })?.code;
        if (code !== 1) {
          console.warn(`[GitWorktrees] Failed to verify merge status for branch '${wt.branch}': ${errorMessage(err)}`);
        }
        merged = false;
      }
      if (!merged) {
        console.warn(`[GitWorktrees] Refusing to delete unmerged branch '${wt.branch}'`);
        return;
      }
      try {
        await runGit(wt.repoRoot, ['branch', '-d', wt.branch]);
      } catch (err) {
        console.warn(`[GitWorktrees] Failed to delete branch '${wt.branch}': ${errorMessage(err)}`);
      }
    }
  }
}
