import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { localApplication } from './security/bridge/local-client.js';
import { applicationJson } from './security/bridge/security.js';
import type { ApplicationJson } from './security/protocol.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BridgePointer, Session, MailMessage } from './wire-types.js';
import { resolveDefaultDataDir, resolveFtownHome } from './ftown-home.js';

export function bridgePointerPath(): string {
  if (process.env.FTOWN_DATA_DIR) return join(resolveFtownHome(process.env.FTOWN_DATA_DIR, resolveDefaultDataDir()), 'bridge.json');
  return join(homedir(), '.ftown', 'bridge.json');
}

export function loadPointer(): BridgePointer {
  const path = bridgePointerPath();
  let pointer: Partial<BridgePointer>;
  try { pointer = JSON.parse(readFileSync(path, 'utf8')) as Partial<BridgePointer>; }
  catch { throw new Error(`Bridge not running (no valid ${path}). Run ftown setup, then start ftown-bridge.`); }
  if (!Number.isInteger(pointer.port) || !pointer.port || pointer.port < 1 || pointer.port > 65535 || typeof pointer.token !== 'string' || !pointer.token) {
    throw new Error(`Invalid ${path} — missing port or token`);
  }
  return pointer as BridgePointer;
}

export async function api<T = unknown>(
  pointer: BridgePointer, method: string, path: string, body?: unknown,
  extraHeaders?: Record<string, string>, signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<T> {
  const result = await apiResponse(pointer, method, path, body, extraHeaders, signal, fetchFn);
  if (result.status < 200 || result.status >= 300) {
    const error = result.body && typeof result.body === 'object' && !Array.isArray(result.body) ? result.body.error : undefined;
    throw new Error(typeof error === 'string' ? error : `HTTP ${result.status}`);
  }
  return result.body as T;
}


export async function apiResponse(pointer: BridgePointer, method: string, path: string, body?: unknown,
  extraHeaders?: Record<string, string>, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<{ status: number; body: ApplicationJson }> {
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new Error('Unsupported API method');
  const requestId = randomUUID();
  const data: { [key: string]: ApplicationJson } = { timeoutMs: 60000 };
  if (body !== undefined) data.body = applicationJson(body);
  const caller = Object.entries(extraHeaders ?? {}).find(([key]) => key.toLowerCase() === 'x-ftown-session-id')?.[1];
  if (caller) data.callerSessionId = caller;
  const response = await localApplication(pointer, { type: 'application', route: { kind: 'http', requestId,
    method: method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path }, data, mcp: null }, signal, fetchFn);
  if (!response || typeof response !== 'object' || Array.isArray(response) || typeof response.status !== 'number' || !('body' in response)) throw new Error('Invalid encrypted API response');
  return { status: response.status, body: response.body };
}

export async function securityCommand(pointer: BridgePointer, type: 'security_devices' | 'security_invite' | 'security_revoke',
  payload: Record<string, ApplicationJson> = {}): Promise<ApplicationJson> {
  if (!pointer.bridgeId) throw new Error('Bridge upgrade required');
  const requestId = randomUUID();
  const data = await localApplication(pointer, { type: 'application', route: { kind: 'command', command: type, requestId, sessionId: null },
    data: { type, requestId, payload: { bridgeId: pointer.bridgeId, ...payload } }, mcp: null });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid encrypted command response');
  const response = data.response;
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.success !== true) throw new Error('Encrypted security command failed');
  return response.data ?? null;
}

export async function listSessions(pointer: BridgePointer): Promise<Session[]> {
  return (await api<{ sessions?: Session[] }>(pointer, 'GET', '/api/sessions')).sessions ?? [];
}

export interface InboxOptions { wait?: number; peek?: boolean; limit?: number; all?: boolean; signal?: AbortSignal }
export async function fetchInbox(pointer: BridgePointer, id: string, opts: InboxOptions = {}): Promise<MailMessage[]> {
  const params = new URLSearchParams({ wait: String(opts.wait ?? 0) });
  if (opts.peek) params.set('peek', '1');
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.all) params.set('all', '1');
  return (await api<{ messages?: MailMessage[] }>(pointer, 'GET', `/api/sessions/${id}/inbox?${params}`, undefined, undefined, opts.signal)).messages ?? [];
}

export async function sendMail(pointer: BridgePointer, id: string, body: Record<string, unknown>): Promise<{ id: string }> {
  return api(pointer, 'POST', `/api/sessions/${id}/inbox`, body);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function resolveSessionId(sessions: Session[], query: string): string {
  if (UUID_RE.test(query) || query.length >= 8) {
    const byPrefix = sessions.filter((s) => s.id === query || s.id.startsWith(query));
    if (byPrefix.length === 1) return byPrefix[0].id;
    if (byPrefix.length > 1) {
      throw new Error(
        `Ambiguous id prefix "${query}": ${byPrefix.map((s) => `${s.name} (${s.id.slice(0, 8)}…)`).join(', ')}`,
      );
    }
  }

  const exact = sessions.filter((s) => s.name === query);
  if (exact.length === 1) return exact[0].id;

  const fuzzy = sessions.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy[0].id;
  if (fuzzy.length > 1) {
    throw new Error(
      `Ambiguous name "${query}": ${fuzzy.map((s) => s.name).join(', ')} — use full name or id prefix`,
    );
  }

  throw new Error(`No session matching "${query}"`);
}
