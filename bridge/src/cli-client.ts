import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BridgePointer, Session, MailMessage } from './wire-types.js';

export function bridgePointerPath(): string { return join(homedir(), '.ftown', 'bridge.json'); }

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
  const response = await fetchFn(`http://127.0.0.1:${pointer.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${pointer.token}`, ...extraHeaders, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) { try { data = JSON.parse(text) as unknown; } catch { data = { raw: text }; } }
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `HTTP ${response.status} ${path}`);
  return data as T;
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
