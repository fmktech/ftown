import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { localApplication } from './security/bridge/local-client.js';
import { applicationJson } from './security/bridge/security.js';
import type { ApplicationJson } from './security/protocol.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatMailMessage, type BridgePointer, type Session, type MailMessage } from './wire-types.js';
import { resolveDefaultDataDir, resolveFtownHome } from './ftown-home.js';

export function bridgePointerPath(): string {
  if (process.env.FTOWN_DATA_DIR) return join(resolveFtownHome(process.env.FTOWN_DATA_DIR, resolveDefaultDataDir()), 'bridge.json');
  return join(homedir(), '.ftown', 'bridge.json');
}

export function loadPointer(): BridgePointer {
  const path = bridgePointerPath();
  let pointer: Partial<BridgePointer>;
  try { pointer = JSON.parse(readFileSync(path, 'utf8')) as Partial<BridgePointer>; }
  catch { throw new Error(`Bridge not running (no valid ${path}). Run ftown setup, then ftown start.`); }
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
  return apiResult<T>(result);
}
function apiResult<T>(result: { status: number; body: ApplicationJson }): T {
  if (result.status < 200 || result.status >= 300) {
    const error = result.body && typeof result.body === 'object' && !Array.isArray(result.body) ? result.body.error : undefined;
    throw new Error(typeof error === 'string' ? error : `HTTP ${result.status}`);
  }
  return result.body as T;
}


/** Cross-bridge control: when set (`--bridge` / FTOWN_BRIDGE), every API call is forwarded by the local bridge to this peer bridge. */
let peerTarget: string | null = null;
/** Inner deadline of a forwarded request: below the local 60 s request deadline, leaving room for the peer handshake and relay hops. */
const PEER_REQUEST_TIMEOUT_MS = 40_000;
export function setPeerTarget(target: string | null | undefined): void { peerTarget = target?.trim() || null; }
export function currentPeerTarget(): string | null { return peerTarget; }

export async function apiResponse(pointer: BridgePointer, method: string, path: string, body?: unknown,
  extraHeaders?: Record<string, string>, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<{ status: number; body: ApplicationJson }> {
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new Error('Unsupported API method');
  if (peerTarget !== null && path !== '/api/peers' && !path.startsWith('/api/peers?') && !path.startsWith('/api/peers/')) {
    // The caller's own session id means nothing on another bridge (and a peer refuses it): it is not forwarded.
    const forward: Record<string, unknown> = { bridge: peerTarget, method, path, timeoutMs: PEER_REQUEST_TIMEOUT_MS };
    const caller = Object.entries(extraHeaders ?? {}).find(([key]) => key.toLowerCase() === 'x-ftown-session-id')?.[1];
    const parentAction = method === 'POST' && /\/attention\/[^/]+\/(answer|escalate)$/.test(path);
    const forceCard = method === 'PUT' && path.endsWith('/card') && (body as {force?: boolean} | undefined)?.force;
    if (caller && (parentAction || forceCard)) body = { ...(body as Record<string, unknown>), parentSessionId: caller };
    if (body !== undefined) forward.body = body;
    return apiResponse(pointer, 'POST', '/api/peers/http', forward, undefined, signal, fetchFn);
  }
  return localApiResponse(pointer, method, path, body, extraHeaders, signal, fetchFn);
}

async function localApiResponse(pointer: BridgePointer, method: string, path: string, body?: unknown,
  extraHeaders?: Record<string, string>, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<{ status: number; body: ApplicationJson }> {
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

/** A security command the bridge refused, with its typed code (e.g. `account_managed`) and its fixed message. */
export class SecurityCommandError extends Error {
  constructor(readonly code: string | null, message: string) {
    super(message);
    this.name = 'SecurityCommandError';
  }
}

/** The bridge's refusal as a SecurityCommandError: a `[a-z_]` code and a printable message, both bounded. */
export function securityCommandError(response: { [key: string]: ApplicationJson }): SecurityCommandError {
  const data = response.data;
  const rawCode = data && typeof data === 'object' && !Array.isArray(data) ? data.code : undefined;
  const code = typeof rawCode === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(rawCode) ? rawCode : null;
  const rawMessage = typeof response.error === 'string' ? response.error.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 300) : '';
  const message = rawMessage || 'Encrypted security command failed';
  return new SecurityCommandError(code, code !== null && !message.includes(code) ? `${message} (${code})` : message);
}

export async function securityCommand(pointer: BridgePointer, type: 'security_devices' | 'security_invite' | 'security_revoke',
  payload: Record<string, ApplicationJson> = {}, send: typeof localApplication = localApplication): Promise<ApplicationJson> {
  if (!pointer.bridgeId) throw new Error('Bridge upgrade required');
  const requestId = randomUUID();
  const data = await send(pointer, { type: 'application', route: { kind: 'command', command: type, requestId, sessionId: null },
    data: { type, requestId, payload: { bridgeId: pointer.bridgeId, ...payload } }, mcp: null });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid encrypted command response');
  const response = data.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Encrypted security command failed');
  if (response.success !== true) throw securityCommandError(response);
  return response.data ?? null;
}

export async function listSessions(pointer: BridgePointer): Promise<Session[]> {
  return (await api<{ sessions?: Session[] }>(pointer, 'GET', '/api/sessions')).sessions ?? [];
}

export interface InboxOptions { wait?: number; peek?: boolean; limit?: number; all?: boolean; offset?: number; signal?: AbortSignal }
export interface InboxPage {
  messages: MailMessage[];
  moreAvailable: boolean;
  nextOffset: number | null;
  oversizedMessages: Array<{ id: string; serializedBytes: number; index?: number }>;
}
export async function fetchInboxPage(pointer: BridgePointer, id: string, opts: InboxOptions = {}): Promise<InboxPage> {
  if (opts.offset !== undefined && (!Number.isSafeInteger(opts.offset) || opts.offset < 0 || (!opts.peek && !opts.all && opts.offset !== 0))) {
    throw new Error('Inbox offset must be a nonnegative integer and requires --peek or --all');
  }
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) throw new Error('Inbox limit must be a positive integer');
  const params = new URLSearchParams({ wait: String(opts.wait ?? 0) });
  if (opts.peek) params.set('peek', '1');
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.all) params.set('all', '1');
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  const response = await api<Partial<InboxPage>>(pointer, 'GET', `/api/sessions/${id}/inbox?${params}`, undefined, undefined, opts.signal);
  return { messages: response.messages ?? [], moreAvailable: response.moreAvailable ?? false,
    nextOffset: response.nextOffset ?? null, oversizedMessages: response.oversizedMessages ?? [] };
}

export interface CliInboxOptions extends InboxOptions {
  json: boolean;
  messageId?: string;
  cursor?: string;
}
interface MailFieldChunk { offset: number; chunk: string; totalChars: number; nextOffset: number | null }
interface MailContinuation { messageId: string; body: MailFieldChunk; metadata: MailFieldChunk; nextCursor: string | null; completionToken: string | null }

/** One bounded response per field; never reassemble an oversized message into one tool result. */
export async function readInboxForCli(pointer: BridgePointer, id: string, opts: CliInboxOptions, command: string, includeSessionId = false): Promise<void> {
  if (opts.messageId !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(opts.messageId)) throw new Error('Invalid mail message ID');
    if (opts.offset !== undefined || opts.limit !== undefined) throw new Error('Use an opaque cursor with --message-id');
    if (opts.cursor !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(opts.cursor)) throw new Error('Invalid mail cursor');
    const response = await api<MailContinuation>(pointer, 'GET', `/api/sessions/${id}/inbox/${opts.messageId}/chunk`
      + (opts.cursor ? `?cursor=${opts.cursor}` : ''), undefined, undefined, opts.signal);
    const validPart = (part: MailFieldChunk): boolean => {
      if (!part || typeof part.chunk !== 'string' || part.chunk.length > 7000 || !Number.isSafeInteger(part.totalChars)
        || !Number.isSafeInteger(part.offset) || part.offset < 0 || part.offset > part.totalChars || (!opts.cursor && part.offset !== 0)) return false;
      const end = part.offset + part.chunk.length;
      return end <= part.totalChars && (part.nextOffset === null ? end === part.totalChars
        : Number.isSafeInteger(part.nextOffset) && part.nextOffset === end && end > part.offset && end < part.totalChars);
    };
    if (response.messageId !== opts.messageId || !validPart(response.body) || !validPart(response.metadata)) throw new Error('Invalid mail continuation');
    const { body, metadata, nextCursor, completionToken } = response;
    const complete = body.nextOffset === null && metadata.nextOffset === null;
    if (complete ? nextCursor !== null || typeof completionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(completionToken)
      : completionToken !== null || typeof nextCursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nextCursor)) throw new Error('Invalid mail continuation token');
    const continuation = complete ? null : `${command} --message-id ${opts.messageId} --cursor ${nextCursor}`
      + (opts.peek ? ' --peek' : '') + (opts.json ? ' --json' : '');
    const result = { ...(includeSessionId ? { sessionId: id } : {}), messageId: opts.messageId, body, metadata, complete, nextCursor, continuation };
    const output = opts.json ? JSON.stringify(result) + '\n'
      : `Mail ${opts.messageId}\nBody chunk: ${JSON.stringify(body.chunk)}\nMetadata JSON chunk: ${JSON.stringify(metadata.chunk)}\n`
        + (continuation ? `Continue: ${continuation}\n` : 'Body and metadata complete.\n');
    await writeMailOutput(output);
    if (!opts.peek && complete) await acknowledgeInbox(pointer, id, [opts.messageId], completionToken!);
    return;
  }
  if (opts.cursor !== undefined) throw new Error('Mail cursor requires --message-id');
  if ((opts.offset ?? 0) > 0 && !opts.peek && !opts.all) throw new Error('Inbox offset requires --peek or --all');
  const page = await fetchInboxPage(pointer, id, { ...opts, peek: true });
  await writeMailOutput(formatInboxOutput(page, opts.json, command, includeSessionId ? id : undefined, opts));
  if (!opts.peek) await acknowledgeInbox(pointer, id, page.messages.filter(message => !message.deliveredAt).map(message => message.id));
}
export async function fetchInbox(pointer: BridgePointer, id: string, opts: InboxOptions = {}): Promise<MailMessage[]> {
  return (await fetchInboxPage(pointer, id, opts)).messages;
}

/** Acknowledge IDs only after their contents reached the consuming CLI's output. */
export async function acknowledgeInbox(pointer: BridgePointer, id: string, ids: string[], completionToken?: string): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (completionToken !== undefined && unique.length !== 1) throw new Error('A completion token must acknowledge exactly one mail ID');
  const acknowledged: string[] = [];
  for (let offset = 0; offset < unique.length; offset += 500) {
    const result = await api<{ acknowledgedIds: string[] }>(pointer, 'POST', `/api/sessions/${id}/inbox/ack`, { ids: unique.slice(offset, offset + 500), ...(completionToken ? { completionToken } : {}) });
    acknowledged.push(...result.acknowledgedIds);
  }
  return acknowledged;
}

export function formatInboxOutput(page: InboxPage, json: boolean, readCommand: string, sessionId?: string,
  view: { peek?: boolean; all?: boolean; limit?: number } = {}): string {
  if (json) return JSON.stringify({ ...(sessionId ? { sessionId } : {}), ...page }) + '\n';
  const lines = page.messages.map(message => {
    const { body: _body, ...metadata } = message;
    return formatMailMessage(message) + '\nMetadata: ' + JSON.stringify(metadata);
  });
  for (const message of [...page.oversizedMessages].sort((left, right) => (left.index ?? Infinity) - (right.index ?? Infinity))) {
    const text = `Mail ${message.id} needs bounded continuation (${message.serializedBytes} serialized bytes). Run \`${readCommand} --message-id ${message.id}${view.peek ? ' --peek' : ''}\`; it remains unread.`;
    lines.splice(message.index ?? lines.length, 0, text);
  }
  if (!lines.length) lines.push('(no mail)');
  const continuation = readCommand + (view.peek ? ' --peek' : '') + (view.all ? ' --all' : '')
    + (view.limit !== undefined ? ` --limit ${view.limit}` : '');
  if (page.moreAvailable) lines.push(page.nextOffset === null || (!view.peek && !view.all)
    ? `More mail is available. Run \`${readCommand}\` again.`
    : `More mail is available. Run \`${continuation} --offset ${page.nextOffset}\` to continue.`);
  return lines.join('\n') + '\n';
}

/** Wait for output completion before acknowledging any mailbox records. */
export async function writeMailOutput(text: string): Promise<void> {
  if (Buffer.byteLength(text) >= 100_000) throw new Error('Mail output exceeds the 100KB bound; use a smaller page or message continuation');
  await new Promise<void>((resolve, reject) => {
    const stdout = process.stdout;
    let settled = false;
    const cleanup = () => { stdout.off('error', failed); stdout.off('close', closed); };
    const failed = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
      // A Writable can emit its error immediately after the write callback.
      setImmediate(cleanup);
    };
    const closed = () => failed(new Error('stdout closed before mail output completed'));
    stdout.once('error', failed); stdout.once('close', closed);
    try {
      stdout.write(text, error => {
        if (error) { failed(error); return; }
        if (settled) return;
        settled = true; cleanup(); resolve();
      });
    } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
  });
}

/** Reach the owner named by a session relationship without changing the CLI's global target. */
export async function sessionApiAt<T>(pointer: BridgePointer, owner: string | undefined, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!owner || owner === pointer.bridgeId) return apiResult<T>(await localApiResponse(pointer, method, path, body));
  return api(pointer, 'POST', '/api/peers/http', {
    bridge: owner, method, path, timeoutMs: PEER_REQUEST_TIMEOUT_MS, ...(body === undefined ? {} : { body }),
  });
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
