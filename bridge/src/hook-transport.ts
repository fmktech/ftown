import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import {
  HOOK_REQUEST_TIMEOUT_MS,
  type HookAttemptError,
  type HookBridgeCandidate,
  type HookEnvironment,
  type HookPostResult,
  type HookTransportConfig,
  type HookWirePayload,
  type PostHookPayload,
} from './hook-contract.js';

/** Strict decimal port in the valid TCP range; anything else is not an endpoint. */
function parsePort(value: string | undefined): number | undefined {
  if (!value || !/^[0-9]+$/.test(value)) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPointer(env: HookEnvironment): { port: number; token?: string } | undefined {
  const pointer = nonEmpty(env.FTOWN_BRIDGE_POINTER)
    ?? (env.HOME ? join(env.HOME, '.ftown', 'bridge.json') : undefined);
  if (!pointer) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pointer, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const port = parsePort(typeof record.port === 'number' ? String(record.port) : undefined);
    if (port === undefined) return undefined;
    const token = typeof record.token === 'string' ? nonEmpty(record.token) : undefined;
    return { port, ...(token ? { token } : {}) };
  } catch {
    // Missing or malformed pointer is not an error on its own: env may still carry a live endpoint.
    return undefined;
  }
}

/**
 * Resolve endpoint candidates in today's hook order: explicit env first, then
 * the bridge pointer the current bridge rewrites on startup. An exact duplicate
 * is dropped so a resurrected session does not double-post to the same endpoint.
 */
export function buildHookTransportConfig(env: HookEnvironment): HookTransportConfig {
  const candidates: HookBridgeCandidate[] = [];
  const envPort = parsePort(env.FTOWN_HOOK_PORT);
  if (envPort !== undefined) {
    candidates.push({ port: envPort, ...(nonEmpty(env.FTOWN_HOOK_TOKEN) ? { token: nonEmpty(env.FTOWN_HOOK_TOKEN) } : {}), source: 'env' });
  }
  const pointer = readPointer(env);
  if (pointer && !candidates.some((candidate) => candidate.port === pointer.port && candidate.token === pointer.token)) {
    candidates.push({ ...pointer, source: 'pointer' });
  }
  return { candidates, timeoutMs: HOOK_REQUEST_TIMEOUT_MS };
}

/** Map a socket error to a short, sanitized cause (never includes tokens or payload). */
function socketMessage(error: Error & { code?: string }): string {
  switch (error.code) {
    case 'ECONNREFUSED': return 'connection refused';
    case 'ECONNRESET': return 'connection reset';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return 'network unreachable';
    case 'ETIMEDOUT': return 'timeout';
    default: return error.message === 'timeout' ? 'timeout' : 'network error';
  }
}

type SingleAttempt = { ok: true } | { ok: false; message: string; status?: number };

/** One loopback POST. Resolves once; a timeout aborts the request. */
function postOnce(candidate: HookBridgeCandidate, body: string, timeoutMs: number): Promise<SingleAttempt> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: SingleAttempt): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    };
    if (candidate.token) headers.Authorization = `Bearer ${candidate.token}`;
    const req = request(
      { host: '127.0.0.1', port: candidate.port, path: '/hook', method: 'POST', headers, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        res.on('end', () => {
          if (status >= 200 && status < 300) done({ ok: true });
          else done({ ok: false, status, message: `HTTP ${status}` });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error: Error & { code?: string }) => done({ ok: false, message: socketMessage(error) }));
    req.end(body);
  });
}

/** POST the hook payload to the first 2xx candidate; first success wins. */
export const postHookPayload: PostHookPayload = async (payload: HookWirePayload, config: HookTransportConfig): Promise<HookPostResult> => {
  if (config.candidates.length === 0) {
    return { ok: false, error: { kind: 'no-endpoint', message: 'no bridge endpoint configured', attempts: [] } };
  }
  const body = JSON.stringify(payload);
  const timeoutMs = config.timeoutMs ?? HOOK_REQUEST_TIMEOUT_MS;
  const attempts: HookAttemptError[] = [];
  for (const candidate of config.candidates) {
    const result = await postOnce(candidate, body, timeoutMs);
    if (result.ok) return { ok: true, candidate };
    attempts.push({
      port: candidate.port,
      source: candidate.source,
      ...(result.status !== undefined ? { status: result.status } : {}),
      message: result.message,
    });
  }
  const detail = attempts
    .map((attempt) => `port ${attempt.port}: ${attempt.message}${attempt.status !== undefined ? ` (HTTP ${attempt.status})` : ''}`)
    .join('; ');
  return {
    ok: false,
    error: {
      kind: 'delivery-failed',
      message: `bridge delivery failed after ${attempts.length} attempt(s): ${detail}`,
      attempts,
    },
  };
};
