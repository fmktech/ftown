import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import type { ProviderQuota, QuotaFetcher, QuotaWindow, QuotaWindowKind } from './types.js';

/**
 * OpenAI Codex subscription-quota provider.
 *
 * PRIMARY: spawn `codex app-server --listen stdio://` and ask it for
 * `account/rateLimits/read` over newline-delimited JSON-RPC.
 * FALLBACK: the newest rollout files under ~/.codex/sessions, where Codex
 * writes `token_count` events that may carry the last-known rate limits.
 *
 * Nothing here prints, and nothing here reads ~/.codex/auth.json.
 */

const AUTH_MESSAGE = 'Codex login problem: run `codex login`';
const FIVE_HOUR_CUTOFF_MINUTES = 1440;
const ROLLOUT_FILE_LIMIT = 5;

export interface CodexRolloutHit {
  /** The raw `rate_limits` object from the rollout event. */
  rateLimits: unknown;
  /** ISO-8601 instant of the event (file mtime when the event has no timestamp). */
  observedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pick(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}

function isoFromUnixSeconds(seconds: number | null): string | null {
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function kindFor(minutes: number | null, position: 'primary' | 'secondary'): QuotaWindowKind {
  if (minutes === null) return position === 'primary' ? 'five_hour' : 'weekly';
  return minutes < FIVE_HOUR_CUTOFF_MINUTES ? 'five_hour' : 'weekly';
}

function parseWindow(
  raw: Record<string, unknown>,
  position: 'primary' | 'secondary',
  source: 'live' | 'cached',
  now: Date,
): QuotaWindow {
  const windowMinutes = finiteNumber(pick(raw, 'windowDurationMins', 'window_minutes'));
  const resetSeconds = finiteNumber(pick(raw, 'resetsAt', 'resets_at'));
  let usedPercent = finiteNumber(pick(raw, 'usedPercent', 'used_percent'));
  let note: string | null = null;

  if (source === 'cached' && resetSeconds !== null && resetSeconds * 1000 <= now.getTime()) {
    usedPercent = null;
    note = 'reset since last Codex turn';
  }

  return {
    kind: kindFor(windowMinutes, position),
    usedPercent,
    resetsAt: isoFromUnixSeconds(resetSeconds),
    windowMinutes,
    note,
  };
}

/**
 * Pure: turns a Codex `rateLimits` object (live RPC result or cached rollout
 * `rate_limits`) into a ProviderQuota. Accepts camelCase and snake_case keys.
 */
export function parseCodexRateLimits(
  rateLimits: unknown,
  source: 'live' | 'cached',
  observedAt: string,
  now: Date,
): ProviderQuota {
  if (!isRecord(rateLimits)) {
    return {
      provider: 'codex',
      status: 'error',
      plan: null,
      windows: [],
      source,
      observedAt,
      message: 'unexpected rate-limit data from Codex',
    };
  }

  const plan = pick(rateLimits, 'planType', 'plan_type');
  const windows: QuotaWindow[] = [];
  const seenKinds = new Set<QuotaWindowKind>();

  for (const position of ['primary', 'secondary'] as const) {
    const raw = rateLimits[position];
    if (!isRecord(raw)) continue;
    const window = parseWindow(raw, position, source, now);
    if (seenKinds.has(window.kind)) continue;
    seenKinds.add(window.kind);
    windows.push(window);
  }

  if (windows.length === 0) {
    return {
      provider: 'codex',
      status: 'no_data',
      plan: typeof plan === 'string' && plan !== '' ? plan : null,
      windows,
      source,
      observedAt,
      message: 'Codex reported no rate-limit windows',
    };
  }

  return {
    provider: 'codex',
    status: 'ok',
    plan: typeof plan === 'string' && plan !== '' ? plan : null,
    windows,
    source,
    observedAt,
    message: null,
  };
}

function descending(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(descending);
  } catch {
    return [];
  }
}

async function listRolloutFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(descending);
  } catch {
    return [];
  }
}

/** Newest-first list of at most `limit` rollout file paths under `sessionsRoot`. */
async function newestRolloutFiles(sessionsRoot: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  for (const year of await listDirectories(sessionsRoot)) {
    const yearDir = join(sessionsRoot, year);
    for (const month of await listDirectories(yearDir)) {
      const monthDir = join(yearDir, month);
      for (const day of await listDirectories(monthDir)) {
        const dayDir = join(monthDir, day);
        for (const name of await listRolloutFiles(dayDir)) {
          files.push(join(dayDir, name));
          if (files.length >= limit) return files;
        }
      }
    }
  }
  return files;
}

async function scanRolloutFile(path: string): Promise<CodexRolloutHit | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== 'event_msg' || !isRecord(entry.payload)) continue;
    if (entry.payload.type !== 'token_count') continue;
    const rateLimits = entry.payload.rate_limits;
    if (!isRecord(rateLimits)) continue;

    let observedAt: string | null = null;
    if (typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp))) {
      observedAt = new Date(entry.timestamp).toISOString();
    }
    if (observedAt === null) {
      try {
        observedAt = (await stat(path)).mtime.toISOString();
      } catch {
        return null;
      }
    }
    return { rateLimits, observedAt };
  }
  return null;
}

/**
 * Finds the most recent `token_count` event carrying non-null `rate_limits`.
 * Examines at most the 5 newest rollout files, newest first, scanning each
 * from its last line. Never throws; missing directories yield null.
 */
export async function readLatestCodexRateLimits(sessionsRoot: string): Promise<CodexRolloutHit | null> {
  try {
    for (const path of await newestRolloutFiles(sessionsRoot, ROLLOUT_FILE_LIMIT)) {
      const hit = await scanRolloutFile(path);
      if (hit) return hit;
    }
    return null;
  } catch {
    return null;
  }
}

class CodexLiveError extends Error {
  constructor(
    readonly reason: 'missing' | 'timeout' | 'auth' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

const AUTH_ERROR_PATTERN = new RegExp(
  [
    String.raw`\bnot\s+logged\s+in\b`,
    String.raw`\blogged\s+out\b`,
    String.raw`\blog\s+in\b`,
    String.raw`\blogin\b`,
    String.raw`\bsign\s+in\b`,
    String.raw`\bsigned\s+out\b`,
    String.raw`\bunauthori[sz]ed\b`,
    String.raw`\bunauthenticated\b`,
    String.raw`\bauthentication\b`,
    String.raw`\b401\b`,
    String.raw`\bcredentials?\b`,
    String.raw`\btoken\s+expired\b`,
    String.raw`\bexpired\s+token\b`,
  ].join('|'),
  'i',
);

/** True when an app-server error message describes a login/credential problem. */
export function isCodexAuthError(text: string): boolean {
  return AUTH_ERROR_PATTERN.test(text);
}

function rpcErrorFrom(error: unknown): CodexLiveError {
  const text = isRecord(error) && typeof error.message === 'string' ? error.message : '';
  if (isCodexAuthError(text)) {
    return new CodexLiveError('auth', AUTH_MESSAGE);
  }
  return new CodexLiveError('failed', 'codex app-server request failed');
}

/**
 * Runs the JSON-RPC handshake against `codex app-server` and resolves with the
 * `account/rateLimits/read` result. Always kills the child before settling.
 */
function requestLiveRateLimits(timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      reject(new CodexLiveError('failed', 'codex app-server request failed'));
      return;
    }

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const lines = createInterface({ input: child.stdout });

    const isRunning = (): boolean => child.exitCode === null && child.signalCode === null;

    const finish = (error: CodexLiveError | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      lines.close();
      try {
        child.stdin.end();
      } catch {
        // stdin already closed; nothing to do.
      }
      if (isRunning()) {
        try {
          child.kill('SIGTERM');
        } catch {
          // spawn never produced a process; nothing to kill.
        }
        const forceKill = setTimeout(() => {
          if (isRunning()) {
            try {
              child.kill('SIGKILL');
            } catch {
              // already gone.
            }
          }
        }, 1000);
        forceKill.unref();
      }
      if (error) reject(error);
      else resolve(value);
    };

    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        error.code === 'ENOENT'
          ? new CodexLiveError('missing', 'codex CLI not found')
          : new CodexLiveError('failed', 'codex app-server request failed'),
      );
    });
    child.on('exit', () => {
      finish(new CodexLiveError('failed', 'codex app-server exited before responding'));
    });
    child.stdin.on('error', () => {
      finish(new CodexLiveError('failed', 'codex app-server request failed'));
    });

    lines.on('line', (line: string) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) return;

      if (message.id === 1) {
        if (message.error !== undefined) {
          finish(rpcErrorFrom(message.error));
          return;
        }
        send({ jsonrpc: '2.0', method: 'initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
      } else if (message.id === 2) {
        if (message.error !== undefined) finish(rpcErrorFrom(message.error));
        else finish(null, message.result);
      }
    });

    timer = setTimeout(() => {
      finish(new CodexLiveError('timeout', 'codex app-server timed out'));
    }, timeoutMs);

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'ftown-quota', version: '1.0.0' } },
    });
  });
}

/**
 * Codex quota: live app-server RPC first, cached rollout files second.
 * Never rejects and never prints.
 */
export const fetchCodexQuota: QuotaFetcher = async (options) => {
  const now = options.now();
  let primary: CodexLiveError;

  try {
    const result = await requestLiveRateLimits(options.timeoutMs);
    const rateLimits = isRecord(result) ? result.rateLimits : undefined;
    return parseCodexRateLimits(rateLimits, 'live', now.toISOString(), now);
  } catch (error) {
    primary = error instanceof CodexLiveError ? error : new CodexLiveError('failed', 'codex app-server request failed');
  }

  const hit = await readLatestCodexRateLimits(join(options.homeDir, '.codex', 'sessions'));
  if (hit) return parseCodexRateLimits(hit.rateLimits, 'cached', hit.observedAt, now);

  return {
    provider: 'codex',
    status: primary.reason === 'auth' ? 'auth' : 'unavailable',
    plan: null,
    windows: [],
    source: 'live',
    observedAt: now.toISOString(),
    message: primary.message,
  };
};
