import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ProviderQuota,
  QuotaFetchOptions,
  QuotaFetcher,
  QuotaWindow,
} from './types.js';

/**
 * Grok (xAI Grok Build CLI) subscription quota, read from grok's own log.
 *
 * Grok's plan has a single 7-day credit window. Its only readable source is
 * `unified.jsonl`, where grok records "billing: fetched credits config" entries
 * shaped like:
 *
 *   { "ts": "<ISO>", "msg": "billing: fetched credits config",
 *     "ctx": { "subscriptionTier": "SuperGrok" | null,
 *              "config": { "creditUsagePercent": 57.0,   // absent when 0% used
 *                          "currentPeriod": { "type": "USAGE_PERIOD_TYPE_WEEKLY",
 *                                             "start": "...", "end": "..." } } } }
 *
 * To make the source live, the fetcher can start the grok TUI in a pseudo-terminal
 * with no input; grok then fetches billing on its own and appends a fresh entry.
 * No prompt is sent, so no quota is spent.
 */

const BILLING_MESSAGE = 'billing: fetched credits config';
const LOG_TAIL_BYTES = 4 * 1024 * 1024;
const MS_PER_MINUTE = 60_000;

const REFRESH_FRESH_MS = 60_000;
const LIVE_MS = 120_000;
const REFRESH_RESERVE_MS = 3500;
const REFRESH_BUDGET_CAP_MS = 20_000;
const REFRESH_MIN_BUDGET_MS = 2000;
const REFRESH_POLL_MS = 500;
const REFRESH_EXIT_WAIT_MS = 1000;
const CLEANUP_POLL_MS = 50;
const CMD_TIMEOUT_MS = 1000;
const SYNC_CMD_TIMEOUT_MS = 500;
const SCRIPT_BINARY = '/usr/bin/script';
const PGREP_BIN = '/usr/bin/pgrep';
const PS_BIN = '/bin/ps';

const NO_DATA_MESSAGE = "no billing data in grok's log yet: open grok and run /usage";
const PERIOD_ENDED_MESSAGE =
  "grok's last recorded billing period has ended: open grok and run /usage to refresh";
const ZERO_PERCENT_MESSAGE = 'grok omitted the usage figure, which it does at 0% used';
const NOT_FOUND_MESSAGE = 'grok log not found (is grok installed?)';

type JsonRecord = Record<string, unknown>;

export interface GrokRefreshContext {
  homeDir: string;
  /** ts of the newest billing entry before the refresh, or null when there was none. */
  previousTs: string | null;
  budgetMs: number;
}

export interface GrokFetchDeps {
  refresh: (ctx: GrokRefreshContext) => Promise<void>;
  shouldRefresh: boolean;
}

/** The script-wrapped grok TUI as seen by the refresh. */
export interface GrokTui {
  readonly pid: number | undefined;
  /** True once the script process has exited (or never started). */
  hasExited(): boolean;
}

/** Every OS interaction of the refresh, injectable for tests. */
export interface GrokSys {
  spawnTui(grokBinary: string, scratchDir: string): GrokTui;
  /** Direct children of pid. Resolves [] when there are none or the query fails. */
  listChildren(pid: number): Promise<number[]>;
  /** `ps -o command=` for pid. Rejects when ps fails or times out. */
  commandOf(pid: number): Promise<string>;
  /** kill(pid) or kill(-pid) when group is true. Returns false when the call fails. */
  kill(pid: number, signal: NodeJS.Signals | 0, group: boolean): boolean;
  sleep(ms: number): Promise<void>;
}

/** What the refresh created, so cleanup can find it again. */
export interface GrokRefreshState {
  scratchDir: string;
  tui: GrokTui;
  /** Direct children of the script pid, recorded by parentage. */
  children: Set<number>;
}

/** Placeholder until the script is spawned: no pid, so nothing is ever signalled. */
export const NOT_STARTED_TUI: GrokTui = { pid: undefined, hasExited: () => true };

export interface InterruptDeps {
  emitter: Pick<NodeJS.Process, 'listenerCount'>;
  cleanup: () => void;
  removeHandlers: () => void;
  reraise: (signal: NodeJS.Signals) => void;
}

/**
 * Handles SIGINT/SIGTERM during a refresh: cleans up, removes our listeners, then
 * re-raises the signal only when no other listener will handle it. Otherwise the
 * other listeners already received the signal and own the shutdown.
 */
export function handleInterrupt(signal: NodeJS.Signals, deps: InterruptDeps): void {
  deps.cleanup();
  deps.removeHandlers();
  if (deps.emitter.listenerCount(signal) === 0) {
    deps.reraise(signal);
  }
}

type TailRead =
  | { kind: 'ok'; tail: string }
  | { kind: 'missing' }
  | { kind: 'error'; code: string };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLine(line: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isoOrNull(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function observedIso(ts: number, now: Date): string {
  return new Date(Number.isFinite(ts) ? ts : now.getTime()).toISOString();
}

function buildQuota(
  status: ProviderQuota['status'],
  observedAt: string,
  plan: string | null,
  windows: QuotaWindow[],
  message: string | null,
): ProviderQuota {
  return { provider: 'grok', status, plan, windows, source: 'cached', observedAt, message };
}

interface BillingRecord {
  /** Line timestamp in epoch ms, NaN when unreadable. */
  ts: number;
  plan: string | null;
  periodStart: number;
  /** Period end in epoch ms; always finite. */
  periodEnd: number;
  /** creditUsagePercent when it is a finite number, else null (key absent). */
  usedPercent: number | null;
}

/** The last billing entry whose currentPeriod.end parses, or null. */
function lastBilling(tailText: string): BillingRecord | null {
  const lines = tailText.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseLine(lines[index]);
    if (!record || record.msg !== BILLING_MESSAGE || !isRecord(record.ctx)) {
      continue;
    }
    const ctx = record.ctx;
    const config = isRecord(ctx.config) ? ctx.config : null;
    const period = config && isRecord(config.currentPeriod) ? config.currentPeriod : null;
    if (!config || !period) {
      continue;
    }
    const periodEnd = isoOrNull(period.end);
    if (!Number.isFinite(periodEnd)) {
      continue;
    }
    return {
      ts: isoOrNull(record.ts),
      plan: typeof ctx.subscriptionTier === 'string' && ctx.subscriptionTier !== ''
        ? ctx.subscriptionTier
        : null,
      periodStart: isoOrNull(period.start),
      periodEnd,
      usedPercent:
        typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)
          ? config.creditUsagePercent
          : null,
    };
  }
  return null;
}

/** ts of the newest billing line with a readable timestamp, or null. */
function newestBillingTs(tailText: string): string | null {
  const lines = tailText.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseLine(lines[index]);
    if (
      record &&
      record.msg === BILLING_MESSAGE &&
      typeof record.ts === 'string' &&
      Number.isFinite(Date.parse(record.ts))
    ) {
      return record.ts;
    }
  }
  return null;
}

interface ParsedBilling {
  quota: ProviderQuota;
  /** Epoch ms of the entry that supplied the result, or null. */
  entryTs: number | null;
}

function parseBillingTail(tailText: string, now: Date): ParsedBilling {
  const last = lastBilling(tailText);
  if (!last) {
    return {
      quota: buildQuota('unavailable', now.toISOString(), null, [], NO_DATA_MESSAGE),
      entryTs: null,
    };
  }
  const observedAt = observedIso(last.ts, now);
  const entryTs = Number.isFinite(last.ts) ? last.ts : null;
  if (last.periodEnd <= now.getTime()) {
    return {
      quota: buildQuota('unavailable', observedAt, last.plan, [], PERIOD_ENDED_MESSAGE),
      entryTs,
    };
  }
  const windowMinutes =
    Number.isFinite(last.periodStart) && last.periodEnd > last.periodStart
      ? Math.round((last.periodEnd - last.periodStart) / MS_PER_MINUTE)
      : null;
  const window: QuotaWindow = {
    kind: 'weekly',
    usedPercent: last.usedPercent ?? 0,
    resetsAt: new Date(last.periodEnd).toISOString(),
    windowMinutes,
    note: null,
  };
  return {
    quota: buildQuota(
      'ok',
      observedAt,
      last.plan,
      [window],
      last.usedPercent === null ? ZERO_PERCENT_MESSAGE : null,
    ),
    entryTs,
  };
}

/**
 * Pure parser over the tail of grok's unified.jsonl. The first line may be cut
 * mid-way and garbage lines are ignored, so only well-formed billing entries count.
 */
export function parseGrokBillingLog(tailText: string, now: Date): ProviderQuota {
  return parseBillingTail(tailText, now).quota;
}

function errorCode(err: unknown): string {
  if (isRecord(err) && typeof err.code === 'string') {
    return err.code;
  }
  return 'unknown error';
}

async function readLogTail(logPath: string): Promise<string> {
  const handle = await open(logPath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readTailOrMissing(logPath: string): Promise<TailRead> {
  try {
    return { kind: 'ok', tail: await readLogTail(logPath) };
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { kind: 'missing' };
    }
    return { kind: 'error', code };
  }
}

/**
 * True only when a `ps -o command=` line contains the exact scratch dir path as a
 * whole path: preceded by start, whitespace or '=', and followed by end, whitespace
 * or '/'. A longer path that merely starts or ends with it does not match.
 */
export function isOwnGrokProcess(psCommand: string, scratchDir: string): boolean {
  if (scratchDir === '') {
    return false;
  }
  let index = psCommand.indexOf(scratchDir);
  while (index !== -1) {
    const before = index === 0 ? '' : psCommand.charAt(index - 1);
    const after = psCommand.charAt(index + scratchDir.length);
    const leftOk = index === 0 || /\s/.test(before) || before === '=';
    const rightOk = after === '' || /\s/.test(after) || after === '/';
    if (leftOk && rightOk) {
      return true;
    }
    index = psCommand.indexOf(scratchDir, index + 1);
  }
  return false;
}

/** Runs a fixed binary without a shell. Resolves with stdout, or '' on any failure. */
function runCommand(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: CMD_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The real OS layer. */
export const realGrokSys: GrokSys = {
  spawnTui(grokBinary, scratchDir) {
    let exited = false;
    const child = spawn(SCRIPT_BINARY, ['-q', '/dev/null', grokBinary, '--cwd', scratchDir], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('exit', () => {
      exited = true;
    });
    child.on('error', () => {
      exited = true;
    });
    child.unref();
    return {
      pid: child.pid,
      hasExited: () => exited || child.pid === undefined,
    };
  },
  async listChildren(pid) {
    const out = await runCommand(PGREP_BIN, ['-P', String(pid)]);
    const children: number[] = [];
    for (const line of out.split('\n')) {
      const child = Number(line.trim());
      if (Number.isInteger(child) && child > 0) {
        children.push(child);
      }
    }
    return children;
  },
  commandOf(pid) {
    return new Promise((resolve, reject) => {
      execFile(
        PS_BIN,
        ['-o', 'command=', '-p', String(pid)],
        { timeout: CMD_TIMEOUT_MS, encoding: 'utf8' },
        (err, stdout) => {
          if (err) {
            reject(err);
          } else {
            resolve(stdout);
          }
        },
      );
    });
  },
  kill(pid, signal, group) {
    try {
      process.kill(group ? -pid : pid, signal);
      return true;
    } catch (err) {
      // kill(0) on a pid we do not own reports EPERM, which still means it exists.
      return signal === 0 && isRecord(err) && err.code === 'EPERM';
    }
  },
  sleep,
};

/** True for pids the module may signal: integers greater than 1. */
export function isSignalablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}

/**
 * The single guarded path for every signal this module sends. Refuses any pid that
 * is not an integer greater than 1, so kill(0), kill(-0), kill(-1) and NaN never happen.
 */
export function signalSafely(
  sys: Pick<GrokSys, 'kill'>,
  pid: number,
  signal: NodeJS.Signals | 0,
  group = false,
): boolean {
  if (!isSignalablePid(pid)) {
    return false;
  }
  return sys.kill(pid, signal, group);
}

function isAlive(sys: Pick<GrokSys, 'kill'>, pid: number): boolean {
  return signalSafely(sys, pid, 0);
}

/** Ownership check: a failing ps is retried once; if it still fails the pid is NOT ours. */
async function verifiedOwned(sys: Pick<GrokSys, 'commandOf'>, pid: number, scratchDir: string): Promise<boolean> {
  if (!isSignalablePid(pid)) {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return isOwnGrokProcess(await sys.commandOf(pid), scratchDir);
    } catch {
      // Retry once.
    }
  }
  return false;
}

/** Records direct children of the script pid. Stops querying once any child is recorded. */
async function collectChildren(sys: Pick<GrokSys, 'listChildren'>, state: GrokRefreshState): Promise<void> {
  const scriptPid = state.tui.pid;
  if (scriptPid === undefined || state.tui.hasExited() || state.children.size > 0) {
    return;
  }
  let found: number[];
  try {
    found = await sys.listChildren(scriptPid);
  } catch {
    return;
  }
  for (const child of found) {
    if (isSignalablePid(child)) {
      state.children.add(child);
    }
  }
}

/**
 * Stops what the refresh created. Verified grok children get SIGTERM (pid and
 * group), then the script group gets SIGTERM. After up to 1 s, anything still alive
 * gets SIGKILL: the script group if it has not exited, and each verified child
 * (re-verified first). A child whose command line does not contain our scratch dir
 * is never signalled, and nothing is signalled after the script has exited.
 */
export async function stopGrokProcesses(sys: GrokSys, state: GrokRefreshState): Promise<void> {
  const { tui, scratchDir } = state;
  const scriptPid = tui.pid;
  const scriptRunning = (): boolean =>
    scriptPid !== undefined && isSignalablePid(scriptPid) && !tui.hasExited();

  const owned: number[] = [];
  for (const pid of state.children) {
    if (await verifiedOwned(sys, pid, scratchDir)) {
      owned.push(pid);
    }
  }

  for (const pid of owned) {
    signalSafely(sys, pid, 'SIGTERM');
    signalSafely(sys, pid, 'SIGTERM', true);
  }
  if (scriptPid !== undefined && scriptRunning()) {
    signalSafely(sys, scriptPid, 'SIGTERM', true);
  }

  let waited = 0;
  while ((scriptRunning() || owned.some((pid) => isAlive(sys, pid))) && waited < REFRESH_EXIT_WAIT_MS) {
    await sys.sleep(CLEANUP_POLL_MS);
    waited += CLEANUP_POLL_MS;
  }

  if (scriptPid !== undefined && scriptRunning()) {
    signalSafely(sys, scriptPid, 'SIGKILL', true);
  }
  for (const pid of owned) {
    if (isAlive(sys, pid) && (await verifiedOwned(sys, pid, scratchDir))) {
      signalSafely(sys, pid, 'SIGKILL');
      signalSafely(sys, pid, 'SIGKILL', true);
    }
  }
}

/** Ownership check for the synchronous exit path (execFileSync, one retry). */
function verifiedOwnedSync(pid: number, scratchDir: string): boolean {
  if (!isSignalablePid(pid)) {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const out = execFileSync(PS_BIN, ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: SYNC_CMD_TIMEOUT_MS,
      });
      return isOwnGrokProcess(out, scratchDir);
    } catch {
      // Retry once.
    }
  }
  return false;
}

/**
 * Best-effort synchronous cleanup for process exit and SIGINT/SIGTERM. Safe to run
 * more than once: verification and guarded signals make a repeat a no-op.
 */
export function cleanupGrokProcessesSync(state: GrokRefreshState): void {
  const scriptPid = state.tui.pid;
  for (const pid of state.children) {
    if (verifiedOwnedSync(pid, state.scratchDir)) {
      signalSafely(realGrokSys, pid, 'SIGKILL');
      signalSafely(realGrokSys, pid, 'SIGKILL', true);
    }
  }
  if (scriptPid !== undefined && !state.tui.hasExited()) {
    signalSafely(realGrokSys, scriptPid, 'SIGKILL', true);
  }
  try {
    rmSync(state.scratchDir, { recursive: true, force: true });
  } catch {
    // Ignored: best effort.
  }
}

/**
 * Starts grok's TUI under a pseudo-terminal with no input until it appends a
 * billing entry newer than `previousTs`, the script exits, or the budget runs out.
 * Interrupts (exit, SIGINT, SIGTERM) run a synchronous cleanup while the refresh is
 * in flight. The process group and the scratch directory are always cleaned up.
 * Never throws.
 */
export async function refreshGrokBilling(
  ctx: GrokRefreshContext,
  sys: GrokSys = realGrokSys,
): Promise<void> {
  const logPath = join(ctx.homeDir, '.grok', 'logs', 'unified.jsonl');
  const grokBinary = join(ctx.homeDir, '.grok', 'bin', 'grok');

  // Synchronous, so no signal can land between creating the scratch dir and knowing it.
  let scratchDir: string;
  try {
    scratchDir = mkdtempSync(join(tmpdir(), 'ftown-quota-grok-'));
  } catch {
    return;
  }
  const state: GrokRefreshState = { scratchDir, tui: NOT_STARTED_TUI, children: new Set<number>() };

  const removeHandlers = (): void => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
  const onExit = (): void => {
    cleanupGrokProcessesSync(state);
  };
  const onSigint = (): void => {
    handleInterrupt('SIGINT', {
      emitter: process,
      cleanup: () => cleanupGrokProcessesSync(state),
      removeHandlers,
      reraise: (signal) => {
        signalSafely(realGrokSys, process.pid, signal);
      },
    });
  };
  const onSigterm = (): void => {
    handleInterrupt('SIGTERM', {
      emitter: process,
      cleanup: () => cleanupGrokProcessesSync(state),
      removeHandlers,
      reraise: (signal) => {
        signalSafely(realGrokSys, process.pid, signal);
      },
    });
  };

  process.once('exit', onExit);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    state.tui = sys.spawnTui(grokBinary, scratchDir);
    await collectChildren(sys, state);

    const deadline = Date.now() + ctx.budgetMs;
    while (Date.now() < deadline) {
      await sys.sleep(REFRESH_POLL_MS);
      await collectChildren(sys, state);
      const tail = await readLogTail(logPath).catch(() => null);
      if (tail !== null) {
        const ts = newestBillingTs(tail);
        if (ts !== null && ts !== ctx.previousTs) {
          return;
        }
      }
      if (state.tui.hasExited()) {
        return;
      }
    }
  } catch {
    // Best effort: the cached data is used instead.
  } finally {
    await stopGrokProcesses(sys, state).catch(() => undefined);
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    removeHandlers();
  }
}

/** The real refresh runs only on darwin, when not disabled by env, and when grok is installed. */
async function refreshAllowed(homeDir: string): Promise<boolean> {
  if (process.env.FTOWN_QUOTA_GROK_NO_REFRESH === '1' || process.platform !== 'darwin') {
    return false;
  }
  try {
    return (await stat(join(homeDir, '.grok', 'bin', 'grok'))).isFile();
  } catch {
    return false;
  }
}

/**
 * Read -> optional refresh -> re-read -> parse. Never throws and never prints.
 * The 60 s freshness skip applies even when deps.shouldRefresh is true.
 */
export async function fetchGrokQuotaWith(
  options: QuotaFetchOptions,
  deps: GrokFetchDeps,
): Promise<ProviderQuota> {
  const logPath = join(options.homeDir, '.grok', 'logs', 'unified.jsonl');
  const startedAt = currentTime(options);
  try {
    const first = await readTailOrMissing(logPath);
    if (first.kind === 'error') {
      return buildQuota(
        'error',
        options.now().toISOString(),
        null,
        [],
        `grok log read failed (${first.code})`,
      );
    }
    let tail = first.kind === 'ok' ? first.tail : '';
    let missing = first.kind === 'missing';

    const nowMs = options.now().getTime();
    const previousTs = newestBillingTs(tail);
    const previousMs = previousTs === null ? Number.NaN : Date.parse(previousTs);
    const fresh = Number.isFinite(previousMs) && nowMs - previousMs < REFRESH_FRESH_MS;
    const budgetMs = Math.min(options.timeoutMs - REFRESH_RESERVE_MS, REFRESH_BUDGET_CAP_MS);

    if (deps.shouldRefresh && !fresh && budgetMs >= REFRESH_MIN_BUDGET_MS) {
      try {
        await deps.refresh({ homeDir: options.homeDir, previousTs, budgetMs });
      } catch {
        // Keep the cached data.
      }
      const after = await readTailOrMissing(logPath);
      if (after.kind === 'ok') {
        tail = after.tail;
        missing = false;
      }
    }

    if (missing) {
      return buildQuota('unavailable', options.now().toISOString(), null, [], NOT_FOUND_MESSAGE);
    }
    const parsed = parseBillingTail(tail, options.now());
    const live =
      parsed.quota.status === 'ok' &&
      parsed.entryTs !== null &&
      Math.abs(nowMs - parsed.entryTs) <= LIVE_MS;
    return { ...parsed.quota, source: live ? 'live' : 'cached' };
  } catch {
    return buildQuota('error', startedAt.toISOString(), null, [], 'grok quota check failed');
  }
}

/** options.now(), falling back to the real clock if the injected clock throws. */
function currentTime(options: Pick<QuotaFetchOptions, 'now'>): Date {
  try {
    return options.now();
  } catch {
    return new Date();
  }
}

/** Grok quota fetcher: refreshes grok's log when allowed, then reads it. Never throws. */
export const fetchGrokQuota: QuotaFetcher = async (options) => {
  const shouldRefresh = await refreshAllowed(options.homeDir);
  return fetchGrokQuotaWith(options, { refresh: (ctx) => refreshGrokBilling(ctx), shouldRefresh });
};
