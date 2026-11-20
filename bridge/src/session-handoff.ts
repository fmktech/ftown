/**
 * One-step handoff: keep uncommitted work, start a new session in the same
 * directory, and move the plan item and pull request onto it.
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  /** Stop the old agent and fence its worktree before staging or replacement launch. */
  stopSession(sessionId: string): Promise<void>;
  /** True only when the replacement is persisted as running and its process is live. */
  isSessionHealthy(sessionId: string): Promise<boolean>;
  archiveSession(id: string): Promise<void>;
  plan?: {
    get(parentId: string): Promise<SessionPlan | null>;
    patch(parentId: string, itemId: string, input: { sessionId: string }): Promise<PlanItem>;
  };
  loadTerminalLog(id: string): Promise<string>;
  routing?: HandoffRouting;
  git?: (cwd: string, args: string[]) => Promise<GitResult>;
  scanStagedSecrets?: (cwd: string) => Promise<GitResult | undefined>;
  now?: () => Date;
}

export async function waitForSessionHealthy(
  inspect: () => Promise<{ status: Session['status'] | undefined; processActive: boolean }>,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = await inspect();
    if (snapshot.status !== 'running') return false;
    if (snapshot.processActive) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }
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

interface CommitOutcome { committed: boolean; note: string; sha?: string; skippedFiles?: string[] }

const MAX_HANDOFF_FILE_BYTES = 1024 * 1024;

function secretLikePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name.startsWith('.env') || name.endsWith('.pem') || name.endsWith('.key')
    || name.startsWith('id_') || name.startsWith('credentials') || name.endsWith('.p12');
}

function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function safeUntrackedFile(root: string, relPath: string): { safe: true } | { safe: false; reason: string } {
  if (!relPath || isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
    return { safe: false, reason: 'outside worktree' };
  }
  const candidate = resolve(root, relPath);
  if (!insideRoot(root, candidate)) return { safe: false, reason: 'outside worktree' };
  try {
    const target = realpathSync(candidate);
    if (!insideRoot(root, target)) return { safe: false, reason: 'outside worktree' };
    if (secretLikePath(relPath)) return { safe: false, reason: 'secret-like name' };
    if (statSync(candidate).size > MAX_HANDOFF_FILE_BYTES) return { safe: false, reason: 'larger than 1 MiB' };
  } catch {
    return { safe: false, reason: 'unavailable during handoff' };
  }
  return { safe: true };
}

async function defaultStagedSecretScan(cwd: string): Promise<GitResult | undefined> {
  try {
    const result = await execFileAsync('gitleaks', [
      'git', '--staged', '--report-format', 'json', '--report-path', '-', '--redact', '--no-banner',
    ], { cwd, timeout: 30_000, maxBuffer: 2_000_000 });
    return { code: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (err) {
    const failure = err as { code?: number | string; stdout?: string; stderr?: string };
    if (failure.code === 'ENOENT') return undefined;
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
    };
  }
}

function pathsFromGitleaks(output: string): string[] {
  try {
    const findings: unknown = JSON.parse(output);
    if (!Array.isArray(findings)) return [];
    return findings.flatMap((finding) => {
      if (!finding || typeof finding !== 'object') return [];
      const record = finding as { File?: unknown; file?: unknown };
      const path = record.File ?? record.file;
      return typeof path === 'string' && path ? [path] : [];
    });
  } catch {
    return [];
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function displayPath(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

async function commitWork(session: Session, deps: SessionHandoffDeps, id: string): Promise<CommitOutcome> {
  const run = deps.git ?? defaultGit;
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
  const gitCwd = toplevel;
  const status = await run(gitCwd, ['status', '--porcelain']);
  if (status.code !== 0) {
    return { committed: false, note: `no commit: ${status.stderr.trim() || 'git status failed'}` };
  }
  if (!status.stdout.trim()) return { committed: false, note: 'no commit: working tree clean' };
  // A pre-staged tree may contain content that differs from the worktree (or
  // files intentionally staged by the caller). Never replace that index with
  // a handoff snapshot; ask the caller to resolve it explicitly.
  const staged = await run(gitCwd, ['diff', '--cached', '--quiet', 'HEAD', '--']);
  if (staged.code !== 0) {
    return { committed: false, note: 'no commit: pre-staged changes are not auto-committed; commit or unstage them before handoff' };
  }
  // Preserve the caller's index so a rejected scan can leave its staged set
  // exactly as it was. Unresolved index entries cannot be safely auto-committed.
  const savedIndex = await run(gitCwd, ['write-tree']);
  if (savedIndex.code !== 0 || !savedIndex.stdout.trim()) {
    return { committed: false, note: `no commit: cannot safely snapshot the index (${savedIndex.stderr.trim() || 'git write-tree failed'})` };
  }
  const headFiles = await run(gitCwd, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
  const indexedFiles = await run(gitCwd, ['ls-files', '--cached', '-z']);
  const eligibleOthers = await run(gitCwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  const trackedChanges = await run(gitCwd, ['diff', '--name-only', '-z', 'HEAD', '--']);
  if ([headFiles, indexedFiles, eligibleOthers, trackedChanges].some((result) => result.code !== 0)) {
    return { committed: false, note: 'no commit: could not inventory worktree files safely' };
  }
  const splitNul = (value: string) => value.split('\0').filter(Boolean);
  const tracked = new Set(splitNul(headFiles.stdout));
  const cachedUntracked = new Set(splitNul(indexedFiles.stdout).filter((path) => !tracked.has(path)));
  const eligible = new Set(splitNul(eligibleOthers.stdout));
  const untracked = uniquePaths([...cachedUntracked, ...eligible]);
  const skippedFiles: string[] = [];
  const safeFiles: string[] = [];
  const trackedCandidates = splitNul(trackedChanges.stdout).filter((path) => tracked.has(path));
  const approvedTracked = new Set<string>();
  for (const path of uniquePaths([...trackedCandidates, ...untracked])) {
    // A deleted tracked path has no content to add; allow its deletion.
    if (tracked.has(path) && !existsSync(join(toplevel, path))) {
      approvedTracked.add(path);
      continue;
    }
    const safety = safeUntrackedFile(toplevel, path);
    if (!safety.safe) skippedFiles.push(`${displayPath(path)} (${safety.reason})`);
    else if (tracked.has(path)) approvedTracked.add(path);
    else safeFiles.push(path);
  }

  // Start from HEAD, then add only tracked modifications and explicitly
  // approved untracked paths. This also removes unsafe files staged earlier.
  const reset = await run(gitCwd, ['read-tree', 'HEAD']);
  if (reset.code !== 0) {
    return { committed: false, note: `no commit: could not prepare a safe index (${reset.stderr.trim() || 'git read-tree failed'})`, skippedFiles };
  }
  for (const path of approvedTracked) {
    const added = await run(gitCwd, ['--literal-pathspecs', 'add', '-u', '--', path]);
    if (added.code !== 0) {
      await run(gitCwd, ['read-tree', savedIndex.stdout.trim()]);
      return { committed: false, note: `no commit: tracked changes could not be staged (${added.stderr.trim() || added.stdout.trim() || 'git add failed'})`, skippedFiles };
    }
  }
  for (const path of safeFiles) {
    const added = await run(gitCwd, ['--literal-pathspecs', 'add', '--', path]);
    if (added.code !== 0) {
      await run(gitCwd, ['read-tree', savedIndex.stdout.trim()]);
      return { committed: false, note: `no commit: safe untracked file could not be staged (${added.stderr.trim() || added.stdout.trim() || 'git add failed'})`, skippedFiles: uniquePaths([...skippedFiles, ...safeFiles]) };
    }
  }
  const stagedCandidates = await run(gitCwd, ['diff', '--cached', '--name-only', '-z', 'HEAD', '--']);
  if (stagedCandidates.code !== 0) {
    await run(gitCwd, ['read-tree', savedIndex.stdout.trim()]);
    return { committed: false, note: 'no commit: could not verify staged files safely', skippedFiles };
  }
  const allowed = new Set([...approvedTracked, ...safeFiles]);
  const unsafeStaged = splitNul(stagedCandidates.stdout).filter((path) => !allowed.has(path));
  if (unsafeStaged.length) {
    await run(gitCwd, ['read-tree', savedIndex.stdout.trim()]);
    return { committed: false, note: 'no commit: staged files failed safety checks', skippedFiles: uniquePaths([...skippedFiles, ...unsafeStaged]) };
  }

  const scan = await (deps.scanStagedSecrets ?? defaultStagedSecretScan)(gitCwd);
  if (scan && scan.code !== 0) {
    await run(gitCwd, ['read-tree', savedIndex.stdout.trim()]);
    const reportPaths = pathsFromGitleaks(scan.stdout).map(displayPath);
    const reason = scan.code === 1 ? 'gitleaks flagged staged content' : 'gitleaks scan failed';
    return {
      committed: false,
      note: `no commit: ${reason}; staged files were restored to their previous state`,
      skippedFiles: uniquePaths([...skippedFiles, ...safeFiles, ...reportPaths]),
    };
  }
  const committed = await run(gitCwd, ['-c', 'user.name=ftown', '-c', 'user.email=ftown@localhost', 'commit', '-m', `wip: handoff from ${id}`]);
  if (committed.code !== 0) {
    throw new Error(`git commit failed: ${committed.stderr.trim() || committed.stdout.trim() || 'unknown git error'}`);
  }
  const sha = await run(gitCwd, ['rev-parse', '--short', 'HEAD']);
  return { committed: true, note: `wip commit ${sha.stdout.trim() || 'created'}`, sha: sha.stdout.trim() || undefined, skippedFiles };
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
  skippedFiles?: string[];
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
    ...(input.skippedFiles?.length ? [`left uncommitted:\n${input.skippedFiles.join('\n')}`] : []),
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
  await deps.stopSession(session.id);
  const commit = await commitWork(session, deps, session.id);
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
  const brief = buildHandoffBrief({ session, screen, commitNote: commit.note, logText, diffText, planItem, skippedFiles: commit.skippedFiles });
  const created = await deps.createSession({
    name: target.name,
    prompt: brief,
    workingDir: dir,
    shellType: target.shellType,
    model: target.model,
    ...(session.account !== undefined ? { account: session.account } : {}),
    ...(session.allowedAccounts !== undefined ? { allowedAccounts: session.allowedAccounts } : {}),
    projectName: session.projectName || "Unassigned",
    parentBridgeId: session.parentBridgeId,
    parentSessionId: session.parentSessionId,
    ...(session.requireGreenPr ? { requireGreenPr: true } : {}),
  });

  try {
    if (!(await deps.isSessionHealthy(created.id))) {
      throw new Error(`replacement session ${created.id} is not healthy`);
    }
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
