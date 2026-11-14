import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import type {
  ProviderQuota,
  QuotaFetchOptions,
  QuotaFetcher,
  QuotaStatus,
  QuotaWindow,
  QuotaWindowKind,
  ScopedLimit,
} from './types.js';

/**
 * Google Antigravity (`agy` CLI) subscription quota provider.
 *
 * `agy -p /usage --output-format json` is handled locally by the CLI: it makes
 * no model turn and spends no quota. The JSON envelope carries the limit
 * buckets under `command.data.groups[].buckets[]`. The command runs in an empty
 * scratch directory, so no project files are involved.
 */

const LOCAL_BIN_SEGMENTS = ['.local', 'bin', 'agy'] as const;
const BINARY_NAME = 'agy';
const USAGE_ARGS = ['-p', '/usage', '--output-format', 'json'] as const;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10080;
const WINDOW_MINUTES_BY_KIND: Record<QuotaWindowKind, number> = {
  five_hour: FIVE_HOUR_MINUTES,
  weekly: WEEKLY_MINUTES,
};

/**
 * Antigravity (`agy`) rate-limit pool names as reported in `scopedLimits`.
 * - `'Gemini Models'`: Gemini models except Argon
 * - `'Gemini 4 Argon'`: Gemini 4 Argon models (`gemini-4-argon*`)
 * - `'Claude and GPT models'`: Claude and GPT models served through `agy`
 */
export const AGY_QUOTA_POOLS = [
  'Gemini Models',
  'Gemini 4 Argon',
  'Claude and GPT models',
] as const;

export type AgyQuotaPool = (typeof AGY_QUOTA_POOLS)[number];

/**
 * Pure mapping from an `agy` model ID to its rate-limit pool (`scopedLimits` scope):
 * - `gemini-4-argon*` -> `'Gemini 4 Argon'`
 * - IDs containing `claude` or `gpt` -> `'Claude and GPT models'`
 * - Other `gemini*` -> `'Gemini Models'`
 * - Unknown / unrecognized IDs -> `null` (callers fall back to the tightest pool).
 */
export function agyQuotaPool(modelId: string): AgyQuotaPool | null {
  const id = modelId.trim().toLowerCase();
  if (id.length === 0) return null;
  if (id.startsWith('gemini-4-argon')) return 'Gemini 4 Argon';
  if (id.includes('claude') || id.includes('gpt')) return 'Claude and GPT models';
  if (id.startsWith('gemini')) return 'Gemini Models';
  return null;
}

export const agyPoolForModel = agyQuotaPool;
const NOT_FOUND_MESSAGE = 'agy CLI not found';
const NO_BUCKETS_MESSAGE = 'agy reported no usage buckets';
const UNEXPECTED_OUTPUT_MESSAGE = 'unexpected output from `agy -p /usage`';
const TIMED_OUT_MESSAGE = '`agy -p /usage` timed out';
const FAILED_TO_START_MESSAGE = '`agy -p /usage` failed to start';
const AUTH_MESSAGE = 'agy login problem: run `agy` and sign in';
const TURN_MESSAGE = 'agy ran a model turn for /usage (unexpected)';
const AUTH_PATTERN = /\b(log ?in|sign ?in|unauthori[sz]ed|unauthenticated|authenticat\w*)\b/i;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function observedNow(options: QuotaFetchOptions): string {
  try {
    return options.now().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function failureQuota(status: QuotaStatus, message: string, observedAt: string): ProviderQuota {
  return {
    provider: 'agy',
    status,
    plan: null,
    windows: [],
    source: 'live',
    observedAt,
    message,
  };
}

/** True only for a regular file that the current user can execute. Never throws. */
async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves the agy binary to an absolute path: first `<homeDir>/.local/bin/agy`
 * (skipped when homeDir is empty or not absolute), then `agy` in each PATH
 * entry. Empty and relative PATH entries are skipped. A candidate must be an
 * executable regular file. Returns null when none matches. Never throws.
 */
export async function resolveAgyBinary(
  homeDir: string,
  pathValue: string | undefined,
): Promise<string | null> {
  const candidates: string[] = [];
  if (homeDir.length > 0 && isAbsolute(homeDir)) {
    candidates.push(join(homeDir, ...LOCAL_BIN_SEGMENTS));
  }
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (dir.length === 0 || !isAbsolute(dir)) continue;
    candidates.push(join(dir, BINARY_NAME));
  }
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Percent used from remaining_fraction: (1 - remaining) * 100, one decimal, clamped to 0..100. */
function usedPercentOf(remaining: unknown): number | null {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null;
  const used = Math.round((1 - remaining) * 1000) / 10;
  return Math.min(100, Math.max(0, used));
}

function isoOf(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

interface UsageEntry {
  kind: QuotaWindowKind;
  windowMinutes: number;
  groupIndex: number;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
}

function rankOf(usedPercent: number | null): number {
  return usedPercent === null ? -1 : usedPercent;
}

/**
 * Pure: maps the parsed JSON envelope of `agy -p /usage --output-format json`
 * onto a ProviderQuota. Windows keep the most used bucket per kind; scopedLimits
 * list every usable bucket. Never throws.
 */
export function parseAgyUsage(body: unknown, observedAt: string): ProviderQuota {
  const command = isRecord(body) ? body.command : undefined;
  const data = isRecord(command) ? command.data : undefined;
  const groups = isRecord(data) ? data.groups : undefined;
  if (!isRecord(body) || body.status !== 'SUCCESS' || !Array.isArray(groups)) {
    return failureQuota('error', UNEXPECTED_OUTPUT_MESSAGE, observedAt);
  }

  const entries: UsageEntry[] = [];
  groups.forEach((group, groupIndex) => {
    if (!isRecord(group) || !Array.isArray(group.buckets)) return;
    const groupName = nonEmptyString(group.name);
    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) continue;
      const shape =
        bucket.window === '5h'
          ? { kind: 'five_hour' as const, windowMinutes: FIVE_HOUR_MINUTES }
          : bucket.window === 'weekly'
            ? { kind: 'weekly' as const, windowMinutes: WEEKLY_MINUTES }
            : null;
      if (shape === null) continue;
      const label =
        groupName ?? nonEmptyString(bucket.name) ?? nonEmptyString(bucket.id) ?? 'unknown';
      entries.push({
        kind: shape.kind,
        windowMinutes: shape.windowMinutes,
        groupIndex,
        label,
        usedPercent: usedPercentOf(bucket.remaining_fraction),
        resetsAt: isoOf(bucket.reset_time),
      });
    }
  });

  const windows: QuotaWindow[] = [];
  for (const kind of ['five_hour', 'weekly'] as const) {
    const ofKind = entries.filter((entry) => entry.kind === kind);
    if (ofKind.length === 0) continue;
    let best = ofKind[0];
    for (const entry of ofKind.slice(1)) {
      if (rankOf(entry.usedPercent) > rankOf(best.usedPercent)) best = entry;
    }
    const groupCount = new Set(ofKind.map((entry) => entry.groupIndex)).size;
    windows.push({
      kind,
      usedPercent: best.usedPercent,
      resetsAt: best.resetsAt,
      windowMinutes: best.windowMinutes,
      note: groupCount >= 2 ? `tightest: ${best.label}` : null,
    });
  }

  const scopedLimits: ScopedLimit[] = entries.map((entry) => ({
    scope: entry.label,
    kind: entry.kind,
    usedPercent: entry.usedPercent,
    resetsAt: entry.resetsAt,
  }));

  const hasNumber = windows.some((window) => window.usedPercent !== null);
  let message: string | null = hasNumber ? null : NO_BUCKETS_MESSAGE;
  if (typeof body.num_turns === 'number' && body.num_turns > 0) message = TURN_MESSAGE;

  const quota: ProviderQuota = {
    provider: 'agy',
    status: hasNumber ? 'ok' : 'no_data',
    plan: null,
    windows,
    source: 'live',
    observedAt,
    message,
  };
  if (scopedLimits.length > 0) quota.scopedLimits = scopedLimits;
  return quota;
}

/**
 * Pure: returns the quota windows that govern an `agy` model on `row`.
 * When `modelId` maps to a known pool and `row.scopedLimits` carries at least one
 * bucket for that pool, returns those pool windows (with `five_hour` = 300 min and
 * `weekly` = 10080 min). When `modelId` is unknown (`agyQuotaPool` returns `null`)
 * or the pool has no entries in `row.scopedLimits`, falls back to `row.windows`
 * (the tightest pool per window kind).
 */
export function agyWindowsForModel(
  row: Pick<ProviderQuota, 'windows' | 'scopedLimits'>,
  modelId: string,
): QuotaWindow[] {
  const pool = agyQuotaPool(modelId);
  const scoped = row.scopedLimits;
  if (pool !== null && Array.isArray(scoped) && scoped.length > 0) {
    const matches = scoped.filter((limit) => limit.scope === pool);
    if (matches.length > 0) {
      const windows: QuotaWindow[] = [];
      for (const kind of ['five_hour', 'weekly'] as const) {
        const ofKind = matches.filter((entry) => entry.kind === kind);
        if (ofKind.length === 0) continue;
        let best = ofKind[0];
        for (const entry of ofKind.slice(1)) {
          if (rankOf(entry.usedPercent) > rankOf(best.usedPercent)) best = entry;
        }
        windows.push({
          kind,
          usedPercent: best.usedPercent,
          resetsAt: best.resetsAt,
          windowMinutes: WINDOW_MINUTES_BY_KIND[kind],
          note: pool,
        });
      }
      if (windows.length > 0) return windows;
    }
  }
  return Array.isArray(row.windows) ? row.windows.map((window) => ({ ...window })) : [];
}

/** Pure: extracts the JSON object from stdout: the whole text, else the last line starting with `{`. */
function extractUsageJson(stdout: string): Json | undefined {
  const trimmed = stdout.trim();
  try {
    const whole: unknown = JSON.parse(trimmed);
    if (isRecord(whole)) return whole;
  } catch {
    // fall through to line-by-line extraction
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(lines[i]);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not a JSON line; keep scanning upward
    }
  }
  return undefined;
}

/** One `agy -p /usage` run in `cwd` (no shell). Resolves with a ProviderQuota; never rejects. */
function execUsage(binary: string, cwd: string, timeoutMs: number, observedAt: string): Promise<ProviderQuota> {
  return new Promise<ProviderQuota>((resolve) => {
    try {
      execFile(
        binary,
        [...USAGE_ARGS],
        {
          cwd,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          encoding: 'utf8',
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          try {
            if (error) {
              const code = (error as { code?: unknown }).code;
              const killed = (error as { killed?: unknown }).killed === true;
              if (killed) {
                resolve(failureQuota('error', TIMED_OUT_MESSAGE, observedAt));
                return;
              }
              if (code === 'ENOENT') {
                resolve(failureQuota('unavailable', NOT_FOUND_MESSAGE, observedAt));
                return;
              }
              if (AUTH_PATTERN.test(String(stderr))) {
                resolve(failureQuota('auth', AUTH_MESSAGE, observedAt));
                return;
              }
              const shown = typeof code === 'number' ? String(code) : 'unknown';
              resolve(failureQuota('error', `\`agy -p /usage\` failed (exit ${shown})`, observedAt));
              return;
            }
            const parsed = extractUsageJson(String(stdout));
            if (parsed === undefined) {
              resolve(failureQuota('error', UNEXPECTED_OUTPUT_MESSAGE, observedAt));
              return;
            }
            resolve(parseAgyUsage(parsed, observedAt));
          } catch {
            resolve(failureQuota('error', UNEXPECTED_OUTPUT_MESSAGE, observedAt));
          }
        },
      );
    } catch {
      resolve(failureQuota('error', FAILED_TO_START_MESSAGE, observedAt));
    }
  });
}

/** Runs /usage inside a fresh scratch directory and removes it afterwards. Never rejects. */
async function runAgyUsage(binary: string, timeoutMs: number, observedAt: string): Promise<ProviderQuota> {
  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'ftown-agy-usage-'));
    return await execUsage(binary, scratch, timeoutMs, observedAt);
  } catch {
    return failureQuota('error', FAILED_TO_START_MESSAGE, observedAt);
  } finally {
    if (scratch !== null) {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Reads agy's own `/usage` report non-interactively. Never throws or rejects. */
export const fetchAgyQuota: QuotaFetcher = async (options) => {
  const observedAt = observedNow(options);
  let binary: string | null = null;
  try {
    binary = await resolveAgyBinary(options.homeDir, process.env.PATH);
  } catch {
    binary = null;
  }
  if (binary === null) return failureQuota('unavailable', NOT_FOUND_MESSAGE, observedAt);
  return runAgyUsage(binary, options.timeoutMs, observedAt);
};
