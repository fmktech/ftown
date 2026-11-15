import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveOpencodeBinary } from './models-opencode.js';
import type { ProviderQuota, QuotaFetchOptions, QuotaFetcher, QuotaWindow, QuotaWindowKind } from './types.js';

/**
 * opencode Go subscription quota.
 *
 * Source: `opencode api GET /api/experimental/usage/limits`, an undocumented
 * local route of the opencode CLI. It returns the Go allowance (rolling,
 * weekly, monthly percent windows) and does not start a model turn.
 * Console budgets are money objects, not percent windows, so they are ignored.
 * The row type has no link field, so the usage URL is not stored.
 */

const USAGE_ARGS = ['api', 'GET', '/api/experimental/usage/limits'] as const;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const WEEKLY_MINUTES = 10080;
const NOT_FOUND_MESSAGE = 'opencode CLI not found';
const CHECK_FAILED_MESSAGE = 'opencode CLI check failed';
const TIMED_OUT_MESSAGE = '`opencode api` timed out';
const TOO_LARGE_MESSAGE = '`opencode api` output was too large';
const FAILED_TO_START_MESSAGE = '`opencode api` failed to start';
const NO_SUBSCRIPTION_MESSAGE = 'opencode has no Go subscription';
const NO_WINDOWS_MESSAGE = 'opencode reported a Go plan without usage windows';
const AUTH_MESSAGE = 'opencode is not signed in';
const UNKNOWN_VERSION = 'unknown';
const AUTH_STDERR = /\b401\b|unauthori[sz]ed|unauthenticated|not signed in/i;

const METER_KINDS = [
  { key: 'rolling', kind: 'five_hour', windowMinutes: null },
  { key: 'weekly', kind: 'weekly', windowMinutes: WEEKLY_MINUTES },
  { key: 'monthly', kind: 'monthly', windowMinutes: null },
] as const satisfies readonly { key: string; kind: QuotaWindowKind; windowMinutes: number | null }[];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The error text for a missing route, non-JSON body, or unexpected shape. */
export function opencodeRouteUnavailableMessage(version: string): string {
  const shown = version.trim().length > 0 ? version.trim() : UNKNOWN_VERSION;
  return `opencode usage limits route unavailable; opencode version ${shown}`;
}

function quota(
  status: ProviderQuota['status'],
  observedAt: string,
  message: string | null,
  extras: Partial<Pick<ProviderQuota, 'plan' | 'windows'>> = {},
): ProviderQuota {
  return {
    provider: 'opencode',
    status,
    plan: extras.plan ?? null,
    windows: extras.windows ?? [],
    source: 'live',
    observedAt,
    message,
  };
}

function epochMsToIso(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

type MeterResult =
  | { ok: true; skip: true }
  | { ok: true; skip: false; usedPercent: number; limited: boolean; resetsAt: string | null }
  | { ok: false };

function parseMeter(value: unknown): MeterResult {
  if (value === undefined || value === null) return { ok: true, skip: true };
  if (!isRecord(value)) return { ok: false };
  if (typeof value.percent !== 'number' || !Number.isFinite(value.percent)) return { ok: false };
  if (typeof value.limited !== 'boolean') return { ok: false };
  if (value.resetsAt !== undefined && value.resetsAt !== null) {
    if (typeof value.resetsAt !== 'number' || !Number.isFinite(value.resetsAt)) return { ok: false };
  }
  const resetsAt = typeof value.resetsAt === 'number' ? epochMsToIso(value.resetsAt) : null;
  return { ok: true, skip: false, usedPercent: value.percent, limited: value.limited, resetsAt };
}

/**
 * Pure: maps the JSON of `opencode api GET /api/experimental/usage/limits`
 * onto a ProviderQuota. `version` is used only in the route-unavailable
 * error. Never throws. Ignores workspace ids, the usage URL, and budgets.
 */
export function parseOpencodeUsageLimits(body: unknown, observedAt: string, version: string): ProviderQuota {
  const routeError = (): ProviderQuota =>
    quota('error', observedAt, opencodeRouteUnavailableMessage(version));

  if (!isRecord(body) || !Object.prototype.hasOwnProperty.call(body, 'data')) return routeError();
  if (body.data === null) return quota('auth', observedAt, AUTH_MESSAGE);
  if (!isRecord(body.data)) return routeError();

  const data = body.data;
  if (Object.prototype.hasOwnProperty.call(data, 'budgets') && !Array.isArray(data.budgets)) return routeError();
  if (!Object.prototype.hasOwnProperty.call(data, 'go') || data.go === null) {
    return quota('no_data', observedAt, NO_SUBSCRIPTION_MESSAGE);
  }
  if (!isRecord(data.go)) return routeError();

  const windows: QuotaWindow[] = [];
  for (const meter of METER_KINDS) {
    if (!Object.prototype.hasOwnProperty.call(data.go, meter.key)) continue;
    const parsed = parseMeter(data.go[meter.key]);
    if (!parsed.ok) return routeError();
    if (parsed.skip) continue;
    windows.push({
      kind: meter.kind,
      usedPercent: parsed.usedPercent,
      resetsAt: parsed.resetsAt,
      windowMinutes: meter.windowMinutes,
      note: null,
      limited: parsed.limited,
    });
  }

  if (windows.length === 0) return quota('no_data', observedAt, NO_WINDOWS_MESSAGE, { plan: 'Go' });
  return quota('ok', observedAt, null, { plan: 'Go', windows });
}

function extractJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // fall through to the last JSON object line
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

function versionFrom(stdout: string): string {
  const line = stdout.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const stripped = line.replace(/^opencode\s+/i, '').trim();
  if (stripped.length === 0 || stripped.length > 80 || /[\s\u0000-\u001f\u007f]/.test(stripped)) {
    return UNKNOWN_VERSION;
  }
  return stripped;
}

type SpawnFailure = { code?: unknown; killed?: unknown; signal?: unknown };

function execFileText(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  cwd?: string,
): Promise<{ error: SpawnFailure | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        binary,
        [...args],
        {
          cwd,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          encoding: 'utf8',
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({
            error: error === null ? null : (error as SpawnFailure),
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
          });
        },
      );
    } catch {
      resolve({ error: { code: 'FAILED_TO_START' }, stdout: '', stderr: '' });
    }
  });
}

function readVersion(binary: string, timeoutMs: number): Promise<string> {
  if (timeoutMs <= 0) return Promise.resolve(UNKNOWN_VERSION);
  return execFileText(binary, ['--version'], timeoutMs).then((result) => {
    if (result.error !== null) return UNKNOWN_VERSION;
    return versionFrom(result.stdout);
  });
}

function classifySpawnError(error: SpawnFailure, observedAt: string): ProviderQuota | null {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return quota('error', observedAt, TOO_LARGE_MESSAGE);
  if (error.killed === true || error.signal === 'SIGKILL' || error.code === 'ETIMEDOUT') {
    return quota('error', observedAt, TIMED_OUT_MESSAGE);
  }
  if (error.code === 'ENOENT') return quota('unavailable', observedAt, NOT_FOUND_MESSAGE);
  if (error.code === 'FAILED_TO_START') return quota('error', observedAt, FAILED_TO_START_MESSAGE);
  return null;
}

/** One usage-limits call plus a version probe only when the route cannot be read. Never rejects. */
function execUsage(
  binary: string,
  cwd: string,
  timeoutMs: number,
  observedAt: string,
  deadlineMs: number,
): Promise<ProviderQuota> {
  return execFileText(binary, USAGE_ARGS, timeoutMs, cwd).then(async (result) => {
    try {
      if (result.error !== null) {
        const classified = classifySpawnError(result.error, observedAt);
        if (classified !== null) return classified;
      }
      const parsed = extractJson(result.stdout);
      if (parsed === undefined) {
        if (AUTH_STDERR.test(result.stderr)) return quota('auth', observedAt, AUTH_MESSAGE);
        const version = await readVersion(binary, deadlineMs - Date.now());
        return quota('error', observedAt, opencodeRouteUnavailableMessage(version));
      }
      const draft = parseOpencodeUsageLimits(parsed, observedAt, UNKNOWN_VERSION);
      if (draft.status === 'error' && draft.message === opencodeRouteUnavailableMessage(UNKNOWN_VERSION)) {
        const version = await readVersion(binary, deadlineMs - Date.now());
        return quota('error', observedAt, opencodeRouteUnavailableMessage(version));
      }
      return draft;
    } catch {
      return quota('error', observedAt, opencodeRouteUnavailableMessage(UNKNOWN_VERSION));
    }
  });
}

async function runUsage(
  binary: string,
  timeoutMs: number,
  observedAt: string,
  deadlineMs: number,
): Promise<ProviderQuota> {
  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'ftown-opencode-usage-'));
    return await execUsage(binary, scratch, timeoutMs, observedAt, deadlineMs);
  } catch {
    return quota('error', observedAt, FAILED_TO_START_MESSAGE);
  } finally {
    if (scratch !== null) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

function observedNow(options: QuotaFetchOptions): string {
  try {
    return options.now().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Reads opencode Go allowance from the CLI's local usage-limits route.
 * Never throws or rejects.
 */
export const fetchOpencodeQuota: QuotaFetcher = async (options) => {
  const observedAt = observedNow(options);
  try {
    const started = Date.now();
    const budget = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0;
    const deadlineMs = started + budget;
    let binary: string | null = null;
    try {
      binary = await resolveOpencodeBinary(options.homeDir, process.env.PATH);
    } catch {
      return quota('error', observedAt, CHECK_FAILED_MESSAGE);
    }
    if (binary === null) return quota('unavailable', observedAt, NOT_FOUND_MESSAGE);
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return quota('error', observedAt, TIMED_OUT_MESSAGE);
    return await runUsage(binary, remaining, observedAt, deadlineMs);
  } catch {
    return quota('error', observedAt, FAILED_TO_START_MESSAGE);
  }
};
