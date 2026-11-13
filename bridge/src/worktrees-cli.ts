/**
 * `ftown worktrees` — bridge-owned worktree listing and pruning.
 * Thin client over the local worktree API (see coordination/contract-b.ts).
 */
import { Command, CommanderError } from 'commander';
import { api as request, loadPointer } from './cli-client.js';
import {
  WORKTREE_ROUTES,
  type SessionWorktree,
  type WorktreeStatus,
} from './coordination/contract-b.js';

/** One local-API call; injectable so tests need no bridge. */
export type WorktreesApiFn = (method: string, path: string, body?: unknown) => Promise<unknown>;

export interface WorktreesCliDeps {
  api: WorktreesApiFn;
  now: () => number;
  env: NodeJS.ProcessEnv;
  log: (text: string) => void;
  errorLog: (text: string) => void;
}

/** Usage problem: message printed, exit code 2. */
export class UsageError extends Error {
  constructor(message: string, readonly usage?: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface WorktreeListEntry {
  sessionId: string;
  sessionName: string;
  archived: boolean;
  worktree: SessionWorktree;
  /** null when the git probe failed for this row; `error` then holds the message */
  status: WorktreeStatus | null;
  error?: string;
}

export interface WorktreeListResponse {
  worktrees: WorktreeListEntry[];
}

export interface WorktreePruneResult {
  removed: string[];
  retained: Array<{ path: string; reason: string }>;
}

const WORKTREES_USAGE = 'Usage: ftown worktrees <list|prune> [--json]';

async function defaultApi(method: string, path: string, body?: unknown): Promise<unknown> {
  return request(loadPointer(), method, path, body);
}

function resolveDeps(partial?: Partial<WorktreesCliDeps>): WorktreesCliDeps {
  return {
    api: partial?.api ?? defaultApi,
    now: partial?.now ?? (() => Date.now()),
    env: partial?.env ?? process.env,
    log: partial?.log ?? ((text: string) => console.log(text)),
    errorLog: partial?.errorLog ?? ((text: string) => console.error(text)),
  };
}

/** Plain `ftown worktrees list` row (single spaces, optional tokens omitted): `<sessionName> <branch> <dirty|clean> ahead:<n> unpushed:<n|-> [merged] [(archived)] <path>`; a failed probe (`status: null`) prints `<sessionName> <branch> error: <message> <path>`. */
export function formatWorktreeRow(entry: WorktreeListEntry): string {
  if (entry.status === null) {
    return `${entry.sessionName} ${entry.worktree.branch} error: ${entry.error ?? 'unknown error'} ${entry.worktree.path}`;
  }
  const branch = entry.status.branch || entry.worktree.branch;
  const path = entry.worktree.path || entry.status.path;
  const parts: string[] = [
    entry.sessionName,
    branch,
    entry.status.dirty ? 'dirty' : 'clean',
    `ahead:${entry.status.ahead}`,
    `unpushed:${entry.status.unpushed === null ? '-' : entry.status.unpushed}`,
  ];
  if (entry.status.mergedIntoBase) parts.push('merged');
  if (entry.archived) parts.push('(archived)');
  parts.push(path);
  return parts.join(' ');
}

/** Plain `ftown worktrees prune` lines: one `removed <path>` per removal, one `retained <path>: <reason>` per retention. */
export function formatPruneLines(result: WorktreePruneResult): string[] {
  const lines: string[] = [];
  for (const path of result.removed) lines.push(`removed ${path}`);
  for (const entry of result.retained) lines.push(`retained ${entry.path}: ${entry.reason}`);
  return lines;
}

function asListResponse(data: unknown): WorktreeListResponse {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const worktrees = (data as { worktrees?: unknown }).worktrees;
    if (Array.isArray(worktrees)) return { worktrees: worktrees as WorktreeListEntry[] };
  }
  return { worktrees: [] };
}

function asPruneResult(data: unknown): WorktreePruneResult {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as { removed?: unknown; retained?: unknown };
    const removed = Array.isArray(record.removed)
      ? record.removed.filter((value): value is string => typeof value === 'string')
      : [];
    const retained: Array<{ path: string; reason: string }> = [];
    if (Array.isArray(record.retained)) {
      for (const entry of record.retained) {
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          const path = (entry as { path?: unknown }).path;
          const reason = (entry as { reason?: unknown }).reason;
          if (typeof path === 'string' && typeof reason === 'string') retained.push({ path, reason });
        }
      }
    }
    return { removed, retained };
  }
  return { removed: [], retained: [] };
}

interface WorktreesOptions {
  json?: boolean;
  plain?: boolean;
}

async function runList(deps: WorktreesCliDeps, opts: WorktreesOptions): Promise<void> {
  const data = await deps.api('GET', WORKTREE_ROUTES.list);
  if (opts.json === true) {
    deps.log(JSON.stringify(data, null, 2));
    return;
  }
  const { worktrees } = asListResponse(data);
  if (worktrees.length === 0) {
    deps.log('no worktrees');
    return;
  }
  for (const entry of worktrees) deps.log(formatWorktreeRow(entry));
}

async function runPrune(deps: WorktreesCliDeps, opts: WorktreesOptions): Promise<void> {
  const data = await deps.api('POST', WORKTREE_ROUTES.prune);
  if (opts.json === true) {
    deps.log(JSON.stringify(data, null, 2));
    return;
  }
  const lines = formatPruneLines(asPruneResult(data));
  if (lines.length === 0) {
    deps.log('nothing to prune');
    return;
  }
  for (const line of lines) deps.log(line);
}

function worktreesProgram(deps: WorktreesCliDeps): Command {
  const program = new Command()
    .name('ftown worktrees')
    .description('List and prune bridge-owned worktrees');
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => deps.log(text.trimEnd()),
    writeErr: (text) => deps.errorLog(text.trimEnd()),
  });
  program
    .command('list')
    .description('List live and archived bridge-owned worktrees')
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .action(async (opts: WorktreesOptions) => {
      await runList(deps, opts);
    });
  program
    .command('prune')
    .description('Remove retirable archived worktrees')
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .action(async (opts: WorktreesOptions) => {
      await runPrune(deps, opts);
    });
  return program;
}

export async function runWorktrees(argv: string[], deps?: Partial<WorktreesCliDeps>): Promise<number> {
  const resolved = resolveDeps(deps);
  if (argv.length === 0) {
    resolved.errorLog('ftown worktrees: a subcommand is required');
    resolved.errorLog(WORKTREES_USAGE);
    return 2;
  }
  try {
    await worktreesProgram(resolved).parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    if (error instanceof UsageError) {
      resolved.errorLog(`ftown worktrees: ${error.message}`);
      if (error.usage) resolved.errorLog(error.usage);
      return 2;
    }
    resolved.errorLog(`ftown worktrees: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
