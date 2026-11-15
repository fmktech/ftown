/**
 * Screen detectors for harness usage, rate, and auth pauses.
 * Phrases come from each CLI's own limit and sign-in text. A hit is a short
 * screen line, not a libc errno glued to another message.
 */
export type LimitReason = 'usage_limit' | 'rate_limit' | 'auth';

export interface LimitHit {
  reason: LimitReason;
  /** ISO time when the screen names a reset or a retry delay. */
  resetAt?: string;
  /** The screen line that matched. */
  line: string;
}

const ANSI_ESCAPE = new RegExp(
  '\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?|\\x1b[@-_]?',
  'g',
);

const MAX_LINE = 300;
const TAIL_CHARS = 4000;

const USAGE_REACHED = /\busage limit reached\b/i;
const HIT_USAGE = /you(?:'|’)ve hit your usage limit\b/i;
const RATE_EXCEEDED = /\brate limit exceeded\b/i;
const RATE_REACHED = /\brate limit reached\b/i;
const RATE_LIMITED = /\brate limited\b/i;
const QUOTA_LATER = /\bquota exceeded,\s*try again later\b/i;
const CODEX_QUOTA = /\bquota exceeded\.\s*check your plan and billing details\b/i;
const RESOURCE = /(?:^|[^A-Za-z0-9_])RESOURCE_EXHAUSTED(?:[^A-Za-z0-9_]|$)/;
const NOT_LOGGED = /\bnot logged in\b/i;
const PLEASE_LOGIN = /\bplease run \/login\b/i;
const LOGIN_EXPIRED = /\blogin expired\b/i;
const TOKEN_EXPIRED = /\btoken (?:has )?expired\b/i;
const SIGN_IN = /\bsign in required\b/i;
const CANNOT_SIGN_IN = /\bcannot sign in\b/i;
const AUTH_REQUIRED = /\bauthentication required\b/i;
const UNAUTHORIZED = /\bunauthorized \(401\)(?!\w)/i;
const STORAGE_QUOTA = /storage quota|quota_exceeded/i;

const RANK: Record<LimitReason, number> = { usage_limit: 0, rate_limit: 1, auth: 2 };

/** Canonical harness key. `agy` is the quota id for the antigravity harness. */
export function canonicalHarness(shellType: string | undefined): string | undefined {
  const trimmed = shellType?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'agy') return 'antigravity';
  return trimmed;
}

export function stripScreenAnsi(raw: string): string {
  return raw.replace(ANSI_ESCAPE, '');
}

function shortLine(line: string): string | undefined {
  const text = line.trim();
  if (!text || text.length >= MAX_LINE) return undefined;
  return text;
}

function codexQuota(line: string): boolean {
  if (/file too large/i.test(line)) return false;
  return CODEX_QUOTA.test(line);
}

function usageHit(shell: string, line: string): boolean {
  // Cursor's local bundle has the auth strings. The limit phrases are screen text.
  if (shell === 'cursor') {
    if (STORAGE_QUOTA.test(line)) return false;
    return /\busage limit\b/i.test(line);
  }
  if (shell === 'codex' && (HIT_USAGE.test(line) || codexQuota(line))) return true;
  if (shell === 'muse' || shell === 'claude' || shell === 'codex' || shell === 'grok' || shell === 'opencode' || shell === 'antigravity') {
    return USAGE_REACHED.test(line);
  }
  return false;
}

function rateHit(shell: string, line: string): boolean {
  if (shell === 'cursor') {
    if (STORAGE_QUOTA.test(line)) return false;
    return /\brate limit\b/i.test(line);
  }
  if (shell === 'muse') return RATE_LIMITED.test(line);
  if (shell === 'opencode' || shell === 'antigravity') {
    if (RESOURCE.test(line)) return true;
  }
  if (shell === 'antigravity' && QUOTA_LATER.test(line)) return true;
  if (shell === 'claude' || shell === 'codex' || shell === 'grok' || shell === 'opencode' || shell === 'antigravity') {
    if (RATE_EXCEEDED.test(line)) return true;
  }
  if (shell === 'codex' && RATE_REACHED.test(line)) return true;
  return false;
}

function authHit(shell: string, line: string): boolean {
  if (shell === 'cursor') return AUTH_REQUIRED.test(line) || SIGN_IN.test(line);
  if (shell === 'muse') return NOT_LOGGED.test(line);
  if (shell === 'claude') return PLEASE_LOGIN.test(line) || NOT_LOGGED.test(line) || LOGIN_EXPIRED.test(line) || TOKEN_EXPIRED.test(line);
  if (shell === 'codex') return NOT_LOGGED.test(line) || TOKEN_EXPIRED.test(line);
  if (shell === 'grok') return NOT_LOGGED.test(line) || TOKEN_EXPIRED.test(line) || UNAUTHORIZED.test(line);
  if (shell === 'opencode') return NOT_LOGGED.test(line) || PLEASE_LOGIN.test(line) || SIGN_IN.test(line) || TOKEN_EXPIRED.test(line);
  if (shell === 'antigravity') return SIGN_IN.test(line) || NOT_LOGGED.test(line) || CANNOT_SIGN_IN.test(line);
  return false;
}

function matchLine(shell: string, line: string): LimitReason | undefined {
  if (usageHit(shell, line)) return 'usage_limit';
  if (rateHit(shell, line)) return 'rate_limit';
  if (authHit(shell, line)) return 'auth';
  return undefined;
}

function unitMs(unit: string): number {
  const name = unit.toLowerCase();
  if (name.startsWith('d')) return 86_400_000;
  if (name.startsWith('h')) return 3_600_000;
  if (name.startsWith('m')) return 60_000;
  return 1000;
}

/** Clock without a date is later today, or tomorrow when that time has passed. */
export function parseResetAt(text: string, now: Date): string | undefined {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/);
  if (iso) {
    const parsed = new Date(iso[1]);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const duration = text.match(/(?:retry in|try again in|retry after)\s+(\d+)\s*(days?|hours?|minutes?|seconds?|d|h|m|s)\b/i);
  if (duration) {
    const amount = Number(duration[1]);
    if (Number.isFinite(amount) && amount >= 0) {
      return new Date(now.getTime() + amount * unitMs(duration[2])).toISOString();
    }
  }
  const ampm = text.match(/\bresets(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const clock = ampm ?? text.match(/\bresets(?:\s+at)?\s+(\d{1,2}):(\d{2})\b/);
  if (!clock) return undefined;
  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const suffix = ampm ? clock[3]?.toLowerCase() : undefined;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  if (suffix) {
    if (hour < 1 || hour > 12) return undefined;
    if (hour === 12) hour = suffix === 'am' ? 0 : 12;
    else if (suffix === 'pm') hour += 12;
  } else if (hour > 23) {
    return undefined;
  }
  const target = new Date(now.getTime());
  target.setSeconds(0, 0);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.toISOString();
}

/**
 * Recognise a usage, rate, or auth pause on a harness screen.
 * Unknown harnesses return undefined; those sessions still fail closed on
 * error and on an exit that never reported a result.
 */
export function detectLimit(shellType: string | undefined, screen: string, now: Date = new Date()): LimitHit | undefined {
  const shell = canonicalHarness(shellType);
  if (!shell || !screen) return undefined;
  const sanitized = stripScreenAnsi(screen);
  const window = sanitized.length > TAIL_CHARS ? sanitized.slice(-TAIL_CHARS) : sanitized;
  const lines = window.split(/\r\n|\n|\r/);
  let best: { reason: LimitReason; index: number; line: string } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = shortLine(lines[index] ?? '');
    if (!line) continue;
    const reason = matchLine(shell, line);
    if (!reason) continue;
    if (!best || RANK[reason] < RANK[best.reason] || (reason === best.reason && index >= best.index)) {
      best = { reason, index, line };
    }
  }
  if (!best) return undefined;
  const nearby = lines.slice(best.index, best.index + 6).join('\n');
  const resetAt = parseResetAt(nearby, now);
  return { reason: best.reason, line: best.line, ...(resetAt ? { resetAt } : {}) };
}
