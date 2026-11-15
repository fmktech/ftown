/**
 * One-step handoff: keep uncommitted work, start a new session in the same
 * directory, and move the plan item and pull request onto it.
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PlanItem, SessionPlan } from './coordination/contract-c.js';
import type { CreateFtownSessionInput } from './create-ftown-session.js';
import { normalizeShellType, type ShellType } from './harness-registry.js';
import { screenTail } from './session-block.js';
import type { Session } from './types.js';

const execFileAsync = promisify(execFile);
const BRIEF_CHARS = 28_000;
const SCREEN_LINES = 300;
const NAME_CHARS = 80;

export interface GitResult { code: number; stdout: string; stderr: string }

export interface HandoffRequest {
  shellType?: ShellType;
  model?: string;
  name?: string;
}

export interface RoutingPick {
  provider: string;
  model: string;
  problem: string | null;
  availability: string;
}

export interface HandoffRouting {
  get(payload: { refresh?: boolean }): Promise<{ report: { tiers: Array<{ picks: RoutingPick[] }> } }>;
}

export interface SessionHandoffDeps {
  loadSession(id: string): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  publishSession(session: Session): Promise<void>;
  createSession(input: CreateFtownSessionInput): Promise<Session>;
  archiveSession(id: string): Promise<void>;
  plan?: {
    get(parentId: string): Promise<SessionPlan | null>;
    patch(parentId: string, itemId: string, input: { sessionId: string }): Promise<PlanItem>;
  };
  loadTerminalLog(id: string): Promise<string>;
  routing?: HandoffRouting;
  git?: (cwd: string, args: string[]) => Promise<GitResult>;
  now?: () => Date;
}

export interface HandoffResult {
  session: Session;
  previousId: string;
  committed: boolean;
}

export function pickAvailableRouting(tiers: Array<{ picks: RoutingPick[] }>): { shellType: ShellType; model: string } | undefined {
  for (const tier of tiers) {
    for (const pick of tier.picks) {
      if (pick.problem) continue;
      if (pick.availability === 'exhausted') continue;
      let shell: ShellType | undefined;
      try { shell = normalizeShellType(pick.provider); } catch { shell = undefined; }
      if (!shell || !pick.model.trim()) continue;
      return { shellType: shell, model: pick.model };
    }
  }
  return undefined;
}

export async function defaultGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 2_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
    };
  }
}

function absoluteGitPath(cwd: string, value: string): string {
  const trimmed = value.trim();
  const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
  try { return realpathSync(absolute); } catch { return absolute; }
}

interface CommitOutcome { committed: boolean; note: string; sha?: string }

async function commitWork(session: Session, git: SessionHandoffDeps['git'], id: string): Promise<CommitOutcome> {
  const run = git ?? defaultGit;
  const dir = session.worktree?.path ?? session.workingDir;
  if (!dir) return { committed: false, note: 'no commit: session has no working directory' };
  const inside = await run(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { committed: false, note: 'no commit: not a git repository' };
  }
  const top = await run(dir, ['rev-parse', '--show-toplevel']);
  const gitDir = await run(dir, ['rev-parse', '--git-dir']);
  const common = await run(dir, ['rev-parse', '--git-common-dir']);
  if (top.code !== 0 || gitDir.code !== 0 || common.code !== 0) {
    return { committed: false, note: 'no commit: not a git repository' };
  }
  const toplevel = absoluteGitPath(dir, top.stdout);
  const here = absoluteGitPath(dir, dir);
  const linked = absoluteGitPath(dir, gitDir.stdout) !== absoluteGitPath(dir, common.stdout);
  const bridgeOwned = session.worktree?.createdByBridge === true && absoluteGitPath(dir, session.worktree.path) === here;
  const ownRoot = here === toplevel && !existsSync(join(toplevel, 'bridge', 'package.json'));
  if (!bridgeOwned && !linked && !ownRoot) {
    return { committed: false, note: 'no commit: working directory is not a dedicated worktree' };
  }
  const status = await run(dir, ['status', '--porcelain']);
  if (status.code !== 0) {
    return { committed: false, note: `no commit: ${status.stderr.trim() || 'git status failed'}` };
  }
  if (!status.stdout.trim()) return { committed: false, note: 'no commit: working tree clean' };
  const added = await run(dir, ['add', '-A']);
  if (added.code !== 0) {
    throw new Error(`git add failed: ${added.stderr.trim() || added.stdout.trim() || 'unknown git error'}`);
  }
  const committed = await run(dir, ['-c', 'user.name=ftown', '-c', 'user.email=ftown@localhost', 'commit', '-m', `wip: handoff from ${id}`]);
  if (committed.code !== 0) {
    throw new Error(`git commit failed: ${committed.stderr.trim() || committed.stdout.trim() || 'unknown git error'}`);
  }
  const sha = await run(dir, ['rev-parse', '--short', 'HEAD']);
  return { committed: true, note: `wip commit ${sha.stdout.trim() || 'created'}`, sha: sha.stdout.trim() || undefined };
}

async function gitText(run: NonNullable<SessionHandoffDeps['git']>, dir: string | undefined, args: string[]): Promise<string> {
  if (!dir) return '';
  const result = await run(dir, args);
  if (result.code !== 0) return '';
  return result.stdout.trim();
}

export function buildHandoffBrief(input: {
  session: Session;
  screen: string;
  commitNote: string;
  logText: string;
  diffText: string;
  planItem?: PlanItem;
}): string {
  const { session } = input;
  const screen = screenTail(input.screen, SCREEN_LINES, 12_000);
  const parts = [
    `Handoff from ${session.name} (${session.id})`,
    '',
    'Original prompt:',
    session.prompt?.trim() || '(none)',
    '',
    'Block:',
    session.block
      ? [`reason: ${session.block.reason}`, session.block.resetAt ? `resetAt: ${session.block.resetAt}` : '', session.lastError ? `lastError: ${session.lastError}` : ''].filter(Boolean).join('\n')
      : '(none)',
    '',
    'Git:',
    input.commitNote,
    input.logText ? `log:\n${input.logText}` : '',
    input.diffText ? `diff stat:\n${input.diffText}` : '',
    '',
    'Links:',
    `worktree: ${session.worktree?.path ?? session.workingDir ?? '(none)'}`,
    `branch: ${session.worktree?.branch ?? '(none)'}`,
    `pullRequest: ${session.pullRequestUrl ?? '(none)'}`,
    `planItem: ${input.planItem ? `${input.planItem.id} ${input.planItem.title}` : '(none)'}`,
    '',
    'Recent screen:',
    screen || '(none)',
  ];
  const brief = parts.filter((part) => part !== undefined).join('\n');
  if (brief.length <= BRIEF_CHARS) return brief;
  return `${brief.slice(0, BRIEF_CHARS - 20)}\n…(brief truncated)`;
}

function fallbackName(name: string): string {
  const trimmed = `${name.trim() || 'session'} handoff`.trim();
  return [...trimmed].slice(0, NAME_CHARS).join('');
}

async function resolveTarget(session: Session, request: HandoffRequest, routing: HandoffRouting | undefined): Promise<{ shellType?: ShellType; model?: string; name: string }> {
  const name = request.name?.trim() ? [...request.name.trim()].slice(0, NAME_CHARS).join('') : fallbackName(session.name);
  if (request.shellType) {
    const same = request.shellType === session.shellType;
    return { shellType: request.shellType, model: request.model?.trim() || (same ? session.model : undefined), name };
  }
  let picked: { shellType: ShellType; model: string } | undefined;
  if (routing) {
    try {
      const snapshot = await routing.get({ refresh: false });
      picked = pickAvailableRouting(snapshot.report.tiers);
    } catch {
      picked = undefined;
    }
  }
  return {
    shellType: picked?.shellType ?? session.shellType,
    model: request.model?.trim() || picked?.model || session.model,
    name,
  };
}

/**
 * Commit dirty work when it is safe, create the replacement session, move the
 * plan item and pull request, then archive the old session.
 * A failure after the new session exists names that id in the error.
 */
export async function handoffSession(deps: SessionHandoffDeps, sessionId: string, request: HandoffRequest = {}): Promise<HandoffResult> {
  const session = await deps.loadSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const target = await resolveTarget(session, request, deps.routing);
  const commit = await commitWork(session, deps.git, session.id);
  let screen = '';
  try { screen = await deps.loadTerminalLog(sessionId); } catch { screen = ''; }
  const dir = session.worktree?.path ?? session.workingDir;
  const run = deps.git ?? defaultGit;
  const base = session.worktree?.base;
  const logText = await gitText(run, dir, base ? ['log', '--oneline', `${base}..HEAD`] : ['log', '-n', '20', '--oneline']);
  const diffText = await gitText(run, dir, base ? ['diff', '--stat', base] : ['diff', '--stat', 'HEAD']);
  let planItem: PlanItem | undefined;
  if (session.parentSessionId && deps.plan) {
    const plan = await deps.plan.get(session.parentSessionId);
    planItem = plan?.items.find((item) => item.sessionId === session.id && item.state === 'started');
  }
  const brief = buildHandoffBrief({ session, screen, commitNote: commit.note, logText, diffText, planItem });
  const created = await deps.createSession({
    name: target.name,
    prompt: brief,
    workingDir: dir,
    shellType: target.shellType,
    model: target.model,
    parentSessionId: session.parentSessionId,
    ...(session.requireGreenPr ? { requireGreenPr: true } : {}),
  });

  try {
    if (planItem && session.parentSessionId && deps.plan) {
      const plan = await deps.plan.get(session.parentSessionId);
      const linked = plan?.items.filter((item) => item.sessionId === session.id && item.state === 'started') ?? [];
      for (const item of linked) {
        await deps.plan.patch(session.parentSessionId, item.id, { sessionId: created.id });
      }
    }
    const oldSession = await deps.loadSession(session.id);
    const newSession = await deps.loadSession(created.id);
    if (!oldSession || !newSession) throw new Error('session disappeared during handoff');
    if (oldSession.worktree) {
      newSession.worktree = oldSession.worktree;
      newSession.workingDir = oldSession.worktree.path;
      delete oldSession.worktree;
    }
    if (oldSession.pullRequestUrl) {
      newSession.pullRequestUrl = oldSession.pullRequestUrl;
      delete oldSession.pullRequestUrl;
    }
    if (oldSession.pullRequestLinkId) {
      newSession.pullRequestLinkId = oldSession.pullRequestLinkId;
      delete oldSession.pullRequestLinkId;
    }
    const stamp = (deps.now?.() ?? new Date()).toISOString();
    oldSession.updatedAt = stamp;
    newSession.updatedAt = stamp;
    await deps.saveSession(newSession);
    await deps.saveSession(oldSession);
    await deps.publishSession(newSession);
    await deps.publishSession(oldSession);
    await deps.archiveSession(oldSession.id);
    return { session: newSession, previousId: oldSession.id, committed: commit.committed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Handoff created ${created.id} but could not finish moving ${session.id}: ${message}`);
  }
}
