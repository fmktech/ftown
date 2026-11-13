import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ProviderQuota,
  QuotaFetcher,
  QuotaFetchOptions,
  QuotaStatus,
  QuotaWindow,
  ScopedLimit,
} from './types.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const FALLBACK_CLAUDE_VERSION = '2.1.323';
const VERSION_TIMEOUT_MS = 2000;
const WEEKLY_MINUTES = 10080;
const FIVE_HOUR_MINUTES = 300;
const EXPIRED_MESSAGE = 'Claude login expired: run `claude` once to refresh it';
const NOT_SIGNED_IN_MESSAGE = 'not signed in: run `claude` and log in';
const UNEXPECTED_BODY_MESSAGE = 'unexpected response from Anthropic usage endpoint';
const MAX_REASON_LENGTH = 120;

const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt: number | null;
  plan: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normaliseResetsAt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Anthropic sends microseconds ("...00.043805+00:00"); keep milliseconds only.
  const trimmed = raw.replace(/(\.\d{3})\d+(?=[Z+-]|$)/, '$1');
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toWindow(kind: QuotaWindow['kind'], raw: Record<string, unknown>, windowMinutes: number): QuotaWindow {
  const utilization = raw.utilization;
  return {
    kind,
    usedPercent: typeof utilization === 'number' && Number.isFinite(utilization) ? utilization : null,
    resetsAt: normaliseResetsAt(raw.resets_at),
    windowMinutes,
    note: null,
  };
}

/**
 * Per-model limits from the body's `limits` array. Only entries with a model
 * scope are kept (unscoped entries duplicate the main windows). Malformed
 * input yields an empty list and never throws.
 */
function parseScopedLimits(raw: unknown): ScopedLimit[] {
  if (!Array.isArray(raw)) return [];
  const out: ScopedLimit[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || !isRecord(entry.scope) || !isRecord(entry.scope.model)) continue;
    const model = entry.scope.model;
    const name = [model.display_name, model.id].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
    );
    if (name === undefined) continue;
    const kind = typeof entry.kind === 'string' && (entry.kind.startsWith('five_hour') || entry.kind.startsWith('session'))
      ? 'five_hour'
      : 'weekly';
    const percent = entry.percent;
    out.push({
      scope: name,
      kind,
      usedPercent: typeof percent === 'number' && Number.isFinite(percent) ? percent : null,
      resetsAt: normaliseResetsAt(entry.resets_at),
    });
  }
  return out;
}

/**
 * Pure mapping from the body of GET /api/oauth/usage to a ProviderQuota.
 * Does no I/O; `plan` and `observedAt` are passed through as given.
 */
export function parseClaudeUsageResponse(body: unknown, plan: string | null, observedAt: string): ProviderQuota {
  if (!isRecord(body)) {
    return {
      provider: 'claude',
      status: 'error',
      plan,
      windows: [],
      source: 'live',
      observedAt,
      message: UNEXPECTED_BODY_MESSAGE,
    };
  }

  const windows: QuotaWindow[] = [];
  const fiveHourRaw = body.five_hour;
  const fiveHourActive = isRecord(fiveHourRaw);
  if (fiveHourActive) {
    windows.push(toWindow('five_hour', fiveHourRaw, FIVE_HOUR_MINUTES));
  } else {
    windows.push({
      kind: 'five_hour',
      usedPercent: null,
      resetsAt: null,
      windowMinutes: FIVE_HOUR_MINUTES,
      note: 'not reported',
    });
  }

  const weeklyRaw = body.seven_day;
  const weeklyPresent = isRecord(weeklyRaw);
  if (weeklyPresent) {
    windows.push(toWindow('weekly', weeklyRaw, WEEKLY_MINUTES));
  }

  const hasNumeric = windows.some((w) => w.usedPercent !== null);
  const idleFiveHour = !fiveHourActive;
  const hasData = hasNumeric || (idleFiveHour && weeklyPresent);
  const status: QuotaStatus = hasData ? 'ok' : 'no_data';

  const scopedLimits = parseScopedLimits(body.limits);
  return {
    provider: 'claude',
    status,
    plan,
    windows,
    source: 'live',
    observedAt,
    message: status === 'no_data' ? 'no usage window reported by Anthropic' : null,
    ...(scopedLimits.length > 0 ? { scopedLimits } : {}),
  };
}

/**
 * Pure parser for the Claude Code credentials JSON (keychain or file).
 * A token that is not printable ASCII without spaces is treated as absent,
 * so it can never reach an HTTP header or an error message.
 */
export function parseClaudeCredentials(raw: string): ClaudeCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) return null;
  const oauth = parsed.claudeAiOauth;
  if (typeof oauth.accessToken !== 'string' || !TOKEN_PATTERN.test(oauth.accessToken)) return null;
  const expiresAt =
    typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null;
  const plan = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null;
  return { accessToken: oauth.accessToken, expiresAt, plan };
}

function readKeychain(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          resolve(error ? null : String(stdout));
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function readCredentialsFile(homeDir: string): Promise<string | null> {
  try {
    return await readFile(join(homeDir, '.claude', '.credentials.json'), 'utf8');
  } catch {
    return null;
  }
}

async function loadCredentials(homeDir: string, timeoutMs: number): Promise<ClaudeCredentials | null> {
  if (process.platform === 'darwin') {
    const fromKeychain = await readKeychain(timeoutMs);
    const parsed = fromKeychain === null ? null : parseClaudeCredentials(fromKeychain);
    if (parsed) return parsed;
  }
  const fromFile = await readCredentialsFile(homeDir);
  return fromFile === null ? null : parseClaudeCredentials(fromFile);
}

function claudeVersion(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile('claude', ['--version'], { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
        const match = error ? null : /(\d+\.\d+\.\d+)/.exec(String(stdout));
        resolve(match ? match[1] : FALLBACK_CLAUDE_VERSION);
      });
    } catch {
      resolve(FALLBACK_CLAUDE_VERSION);
    }
  });
}

function failure(
  options: QuotaFetchOptions,
  status: QuotaStatus,
  plan: string | null,
  message: string,
): ProviderQuota {
  return {
    provider: 'claude',
    status,
    plan,
    windows: [],
    source: 'live',
    observedAt: options.now().toISOString(),
    message,
  };
}

/**
 * One-line, bounded, secret-free reason for a caught error. Every occurrence
 * of `secret` is replaced before truncation, so no part of it can survive.
 */
export function safeReason(error: unknown, secret: string | null): string {
  if (error instanceof Error && error.name === 'AbortError') return 'timed out';
  let text = error instanceof Error ? error.message : String(error);
  if (secret !== null && secret.length > 0) {
    text = text.split(secret).join('<redacted>');
  }
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return 'unknown error';
  return oneLine.length > MAX_REASON_LENGTH ? `${oneLine.slice(0, MAX_REASON_LENGTH)}...` : oneLine;
}

/**
 * Live fetch of the Claude subscription usage windows. Never throws, never
 * prints, never refreshes the OAuth token and never writes to the keychain.
 */
export const fetchClaudeQuota: QuotaFetcher = async (options) => {
  const started = Date.now();
  const remaining = (): number => Math.max(1, options.timeoutMs - (Date.now() - started));

  let plan: string | null = null;
  let secret: string | null = null;
  try {
    const credentials = await loadCredentials(options.homeDir, remaining());
    if (!credentials) {
      return failure(options, 'auth', null, NOT_SIGNED_IN_MESSAGE);
    }
    secret = credentials.accessToken;
    plan = credentials.plan;
    if (credentials.expiresAt !== null && credentials.expiresAt <= options.now().getTime()) {
      return failure(options, 'auth', plan, EXPIRED_MESSAGE);
    }

    const version = await claudeVersion(Math.min(VERSION_TIMEOUT_MS, remaining()));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining());
    try {
      const response = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'anthropic-beta': OAUTH_BETA,
          'User-Agent': `claude-code/${version}`,
        },
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        return failure(options, 'auth', plan, EXPIRED_MESSAGE);
      }
      if (!response.ok) {
        return failure(options, 'error', plan, `Anthropic usage endpoint returned HTTP ${response.status}`);
      }

      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return parseClaudeUsageResponse(body, plan, options.now().toISOString());
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return failure(options, 'error', plan, `could not reach Anthropic: ${safeReason(error, secret)}`);
  }
};
