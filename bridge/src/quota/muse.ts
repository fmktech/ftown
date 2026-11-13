import { execFile } from 'node:child_process';

import type {
  ProviderQuota,
  QuotaFetchOptions,
  QuotaFetcher,
  QuotaStatus,
  QuotaWindow,
} from './types.js';

/**
 * Muse (Meta "Muse Code" CLI) subscription quota provider.
 *
 * Source: `muse usage --json`, documented as "Show your subscription allowance
 * (no model turn)". The populated `allowance` shape was not observed live
 * (the server only ever returned `allowance: null` during research), so every
 * field is accepted in both camelCase and snake_case.
 */

const MUSE_WEEKLY_MINUTES = 10080;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const MIN_ATTEMPT_BUDGET_MS = 3000;
const HINT_MAX_CHARS = 160;
const NO_ALLOWANCE_MESSAGE = 'muse reported no allowance yet (it appears after the first use in a window)';
const NO_WINDOW_MESSAGE = 'muse reported an allowance without any window';
const UNEXPECTED_OUTPUT_MESSAGE = 'unexpected output from `muse usage --json`';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstFinite(record: Json, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function epochMsToIso(ms: number | null): string | null {
  if (ms === null || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildWindow(
  kind: QuotaWindow['kind'],
  raw: Json,
  windowMinutes: number | null,
): QuotaWindow {
  return {
    kind,
    usedPercent: firstFinite(raw, ['usedPercent', 'used_percent']),
    resetsAt: epochMsToIso(firstFinite(raw, ['resetsAtMs', 'resets_at_ms'])),
    windowMinutes,
    note: null,
  };
}

function normalizeHint(hint: unknown): string | null {
  if (typeof hint !== 'string') return null;
  const collapsed = hint.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, HINT_MAX_CHARS);
}

/**
 * Pure: maps the parsed JSON of `muse usage --json` onto a ProviderQuota.
 * Never throws.
 */
export function parseMuseUsage(body: unknown, now: Date): ProviderQuota {
  const nowIso = now.toISOString();

  if (!isRecord(body)) {
    return {
      provider: 'muse',
      status: 'error',
      plan: null,
      windows: [],
      source: 'live',
      observedAt: nowIso,
      message: UNEXPECTED_OUTPUT_MESSAGE,
    };
  }

  const allowance = body.allowance;
  if (!isRecord(allowance)) {
    return {
      provider: 'muse',
      status: 'no_data',
      plan: null,
      windows: [],
      source: 'live',
      observedAt: nowIso,
      message: normalizeHint(body.hint) ?? NO_ALLOWANCE_MESSAGE,
    };
  }

  const tier = allowance.tier;
  const plan = typeof tier === 'string' ? tier : null;
  const observedAt =
    epochMsToIso(firstFinite(allowance, ['asOfMs', 'as_of_ms', 'observedAtMs', 'observed_at_ms'])) ??
    nowIso;

  const windows: QuotaWindow[] = [];

  if (isRecord(allowance.window)) {
    const durationMins = firstFinite(allowance.window, ['windowDurationMins', 'window_duration_mins']);
    const windowMinutes = durationMins !== null && durationMins > 0 ? durationMins : null;
    windows.push(buildWindow('five_hour', allowance.window, windowMinutes));
  }

  if (isRecord(allowance.weekly)) {
    windows.push(buildWindow('weekly', allowance.weekly, MUSE_WEEKLY_MINUTES));
  }

  const status: QuotaStatus = windows.length > 0 ? 'ok' : 'no_data';
  return {
    provider: 'muse',
    status,
    plan,
    windows,
    source: 'live',
    observedAt,
    message: status === 'ok' ? null : NO_WINDOW_MESSAGE,
  };
}

function nonParseFailure(status: QuotaStatus, message: string, now: Date): ProviderQuota {
  return {
    provider: 'muse',
    status,
    plan: null,
    windows: [],
    source: 'live',
    observedAt: now.toISOString(),
    message,
  };
}

/**
 * Pure: extracts the JSON document from `muse usage --json` stdout. The
 * launcher may print notices around it. Order: the whole stdout; then each
 * line (trimmed) that starts with `{`, last line first. The first candidate
 * that parses to an object wins. Returns undefined when none does.
 */
export function extractMuseJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  try {
    const whole: unknown = JSON.parse(trimmed);
    if (isRecord(whole)) return whole;
  } catch {
    // fall through to line-by-line extraction
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not a JSON line; keep scanning upward
    }
  }
  return undefined;
}

const AUTH_PATTERN =
  /\b(log ?in|logged out|sign ?in|signed out|unauthori[sz]ed|unauthenticated|authenticat\w*|not authenticated)\b/i;

/**
 * Pure: classifies a non-zero `muse usage` exit. Auth wording in stderr (as a
 * whole word) yields `auth`; anything else yields `error` with the exit code.
 */
export function classifyMuseFailure(
  exitCode: number | null,
  stderr: string,
): { status: 'auth' | 'error'; message: string } {
  if (AUTH_PATTERN.test(stderr)) {
    return { status: 'auth', message: 'muse login problem: run `muse` and sign in' };
  }
  const shown = exitCode === null ? 'unknown' : String(exitCode);
  return { status: 'error', message: `\`muse usage\` failed (exit ${shown})` };
}

/** One execution of `muse usage --json` with the given timeout, parsed and classified. Never rejects. */
function runMuseUsageOnce(now: Date, timeoutMs: number): Promise<ProviderQuota> {
  return new Promise<ProviderQuota>((resolve) => {
    try {
      execFile(
        'muse',
        ['usage', '--json'],
        { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          try {
            if (error) {
              const code = (error as { code?: unknown }).code;
              const killed = (error as { killed?: unknown }).killed === true;
              if (code === 'ENOENT') {
                resolve(nonParseFailure('unavailable', 'muse CLI not found', now));
                return;
              }
              if (killed) {
                resolve(nonParseFailure('error', '`muse usage` timed out', now));
                return;
              }
              const failure = classifyMuseFailure(
                typeof code === 'number' ? code : null,
                String(stderr),
              );
              resolve(nonParseFailure(failure.status, failure.message, now));
              return;
            }

            const parsed = extractMuseJson(String(stdout));
            if (parsed === undefined) {
              resolve(nonParseFailure('error', UNEXPECTED_OUTPUT_MESSAGE, now));
              return;
            }
            resolve(parseMuseUsage(parsed, now));
          } catch {
            resolve(nonParseFailure('error', UNEXPECTED_OUTPUT_MESSAGE, now));
          }
        },
      );
    } catch {
      resolve(nonParseFailure('error', '`muse usage` failed to start', now));
    }
  });
}

export interface MuseRetryDeps {
  /** Runs one attempt with the given timeout (the remaining overall budget). */
  runUsage: (timeoutMs: number) => Promise<ProviderQuota>;
  sleep: (ms: number) => Promise<void>;
  /** Monotonic-ish clock in milliseconds, used only for budget accounting. */
  nowMs: () => number;
}

/**
 * Retry loop for muse. Muse often answers "no allowance" on the first ask and
 * real numbers a few seconds later, so a `no_data` result is retried after
 * RETRY_DELAY_MS, at most MAX_ATTEMPTS attempts in total. Other statuses are
 * returned immediately. A retry only starts when the budget left after the
 * wait is at least MIN_ATTEMPT_BUDGET_MS; the first attempt always runs with
 * the full budget.
 */
export async function fetchMuseQuotaWith(
  options: QuotaFetchOptions,
  deps: MuseRetryDeps,
): Promise<ProviderQuota> {
  const start = deps.nowMs();
  const remaining = (): number => options.timeoutMs - (deps.nowMs() - start);

  let result = await deps.runUsage(options.timeoutMs);
  for (let attempt = 2; attempt <= MAX_ATTEMPTS && result.status === 'no_data'; attempt += 1) {
    if (remaining() - RETRY_DELAY_MS < MIN_ATTEMPT_BUDGET_MS) break;
    await deps.sleep(RETRY_DELAY_MS);
    result = await deps.runUsage(remaining());
  }
  return result;
}

export const fetchMuseQuota: QuotaFetcher = (options) =>
  fetchMuseQuotaWith(options, {
    runUsage: (timeoutMs) => runMuseUsageOnce(options.now(), timeoutMs),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    nowMs: () => Date.now(),
  });
