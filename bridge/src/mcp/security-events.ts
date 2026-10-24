import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { SecurityError } from '../security/crypto.js';
import type { SecurityEvent, SecurityEventStatus, SecurityPage, SecurityPageQuery } from '../security/protocol.js';

export const KNOWN_MCP_TOOLS = new Set([
  'sessions_create', 'sessions_get', 'sessions_update', 'sessions_stop', 'sessions_retry', 'sessions_remove', 'sessions_revive',
  'sessions_usage', 'sessions_running', 'chats_read', 'chats_search', 'messages_send', 'messages_read', 'terminal_input', 'terminal_resize',
  'terminal_clear', 'whoami', 'attention_request', 'attention_inbox', 'attention_wait', 'attention_ack', 'attention_resolve',
  'fleet_overview', 'machines_list', 'sessions_list', 'archive_list', 'messages_broadcast', 'sessions_wait', 'fleet_batch', 'chats_search_fleet',
]);
export const READ_MCP_TOOLS = new Set([
  'sessions_get', 'sessions_usage', 'sessions_running', 'chats_read', 'chats_search', 'messages_read', 'whoami',
  'attention_inbox', 'attention_wait', 'fleet_overview', 'machines_list', 'sessions_list', 'archive_list', 'sessions_wait', 'chats_search_fleet',
]);
const FIXED_TOOLS = new Set(['unknown_tool', 'invalid_tool', 'initialize', 'tools_list', 'resources_list', 'resources_read', 'protocol_request', 'protocol_notification']);
const ERROR_CODES = new Set([
  'invalid_request', 'unknown_tool', 'invalid_arguments', 'forbidden', 'permission_denied', 'unknown_machine', 'unknown_session',
  'bridge_error', 'bridge_upgrade_required', 'upgrade_required', 'bridge_offline', 'timeout', 'cancelled', 'connection_error',
  'response_too_large', 'configuration_error', 'ssh_error', 'internal_error', 'invalid_cursor', 'unknown_attention',
  'attention_storage_error', 'attention_not_ready', 'audit_unavailable', 'outcome_unknown', 'approval_required', 'key_changed',
  'endpoint_revoked', 'invalid_envelope', 'authentication_failed', 'wrong_context', 'expired', 'replayed', 'epoch_changed',
  'capacity_exceeded', 'security_setup_required', 'key_unavailable', 'identity_unavailable', 'invalid_target',
]);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const eventSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), actionId: z.string().uuid(), parentActionId: z.string().uuid().nullable(), ownerId: z.string().uuid(),
  source: z.enum(['gateway', 'bridge']), bridgeId: id.nullable(), clientId: id.nullable(), grantId: id.nullable(), endpointId: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable(),
  tool: z.string().max(100), operation: z.string().max(100).nullable(), sessionId: id.nullable(), startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  status: z.enum(['started', 'succeeded', 'rejected', 'failed', 'unknown']), errorCode: z.string().max(64).nullable(), mutating: z.boolean(),
}).strict();
const cursorSchema = z.object({ version: z.literal(1), ownerId: z.string().uuid(), bridgeId: id.nullable(), afterAt: z.string().datetime(), afterId: z.string().uuid(), upperAt: z.string().datetime(), upperId: z.string().uuid() }).strict();
export type SecurityQuery = (text: string, values: unknown[]) => Promise<unknown[]>;
export interface SecurityOutcome { status: Exclude<SecurityEventStatus, 'started'>; errorCode: string | null }
export interface SecurityFinalizationState { event: SecurityEvent; finished: boolean; finishing?: Promise<void> }
const unavailable = () => new SecurityError('audit_unavailable', 'Security history storage is unavailable');

/** Concurrent close/send paths share one write; a failed write remains retryable. */
export async function finishSecurityEvent(audit: { finish(event: SecurityEvent, outcome: SecurityOutcome): Promise<void> } | undefined,
  state: SecurityFinalizationState, outcome: SecurityOutcome): Promise<void> {
  if (state.finished) return;
  if (state.finishing) return state.finishing;
  const work = Promise.resolve().then(async () => {
    if (!audit) throw unavailable();
    await audit.finish(state.event, outcome);
    state.finished = true;
  });
  state.finishing = work;
  try { await work; }
  finally { if (state.finishing === work) state.finishing = undefined; }
}

export function safeTool(value: unknown): string {
  return typeof value === 'string' && KNOWN_MCP_TOOLS.has(value) ? value : typeof value === 'string' ? 'unknown_tool' : 'invalid_tool';
}
export function safeFailureCode(value: unknown): string {
  return typeof value === 'string' && ERROR_CODES.has(value) ? value : 'internal_error';
}
export function securityOutcome(value: unknown): SecurityOutcome {
  if (typeof value !== 'object' || value === null) return { status: 'succeeded', errorCode: null };
  const object = value as Record<string, unknown>;
  const nested = typeof object.structuredContent === 'object' && object.structuredContent !== null ? object.structuredContent as Record<string, unknown> : object;
  if (typeof nested.error === 'object' && nested.error !== null) {
    const failure = nested.error as Record<string, unknown>;
    return { status: failure.outcomeUnknown === true ? 'unknown' : ['forbidden', 'permission_denied', 'unknown_tool', 'invalid_arguments'].includes(String(failure.code)) ? 'rejected' : 'failed', errorCode: safeFailureCode(failure.code) };
  }
  if (object.isError === true) return { status: 'failed', errorCode: 'bridge_error' };
  if (Array.isArray(nested.results) && nested.results.some(item => typeof item === 'object' && item !== null && 'ok' in item && item.ok === false)) return { status: 'failed', errorCode: 'bridge_error' };
  return { status: 'succeeded', errorCode: null };
}
export function validateSecurityEvent(value: unknown): SecurityEvent {
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success || (!KNOWN_MCP_TOOLS.has(parsed.data.tool) && !FIXED_TOOLS.has(parsed.data.tool))
    || (parsed.data.operation !== null && !KNOWN_MCP_TOOLS.has(parsed.data.operation))
    || (parsed.data.errorCode !== null && !ERROR_CODES.has(parsed.data.errorCode))
    || (parsed.data.status === 'started' && parsed.data.finishedAt !== null)
    || (parsed.data.status !== 'started' && parsed.data.finishedAt === null)) throw unavailable();
  return parsed.data;
}
export function encodeSecurityCursor(ownerId: string, bridgeId: string | undefined, last: SecurityEvent, first: SecurityEvent): string {
  return Buffer.from(JSON.stringify({ version: 1, ownerId, bridgeId: bridgeId ?? null, afterAt: last.startedAt, afterId: last.id, upperAt: first.startedAt, upperId: first.id })).toString('base64url');
}
export function decodeSecurityCursor(cursor: string, ownerId: string, bridgeId?: string): z.infer<typeof cursorSchema> {
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw unavailable();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw unavailable();
    const parsed = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (parsed.ownerId !== ownerId || parsed.bridgeId !== (bridgeId ?? null)) throw unavailable();
    return parsed;
  } catch { throw new SecurityError('invalid_cursor', 'Security history cursor is invalid for this account or filter'); }
}
export async function listSecurityPage(query: SecurityQuery, ownerId: string, page: SecurityPageQuery = {}): Promise<SecurityPage> {
  if (!z.string().uuid().safeParse(ownerId).success || (page.bridgeId !== undefined && !id.safeParse(page.bridgeId).success)
    || (page.limit !== undefined && (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100))) throw new SecurityError('invalid_cursor', 'Invalid security history filter');
  const limit = page.limit ?? 50;
  const cursor = page.cursor ? decodeSecurityCursor(page.cursor, ownerId, page.bridgeId) : undefined;
  const filter = page.bridgeId ?? null;
  const stats = await query("SELECT MIN(started_at) AS oldest, COUNT(*)::int AS count FROM mcp_security_events WHERE owner_id=$1 AND ($2::text IS NULL OR bridge_id=$2) AND started_at>=NOW()-INTERVAL '30 days'", [ownerId, filter]);
  const stat = z.object({ oldest: z.union([z.date(), z.string(), z.null()]), count: z.number() }).parse(stats[0] ?? { oldest: null, count: 0 });
  const oldest = stat.oldest === null ? null : new Date(stat.oldest).toISOString();
  const reset = !!cursor && (oldest === null || cursor.afterAt < oldest);
  const activeCursor = reset ? undefined : cursor;
  const rows = await query(
    "SELECT event FROM mcp_security_events WHERE owner_id=$1 AND ($2::text IS NULL OR bridge_id=$2) AND started_at>=NOW()-INTERVAL '30 days' AND ($3::timestamptz IS NULL OR (started_at,id)<=($3::timestamptz,$4::uuid)) AND ($5::timestamptz IS NULL OR (started_at,id)<($5::timestamptz,$6::uuid)) ORDER BY started_at DESC,id DESC LIMIT $7",
    [ownerId, filter, activeCursor?.upperAt ?? null, activeCursor?.upperId ?? null, activeCursor?.afterAt ?? null, activeCursor?.afterId ?? null, limit + 1],
  );
  const events = rows.map(row => {
    if (typeof row !== 'object' || row === null || !('event' in row)) throw unavailable();
    const event = validateSecurityEvent(row.event);
    if (event.ownerId !== ownerId || (filter !== null && event.bridgeId !== filter)) throw unavailable();
    return event;
  });
  const hasMore = events.length > limit;
  const selected = events.slice(0, limit);
  const last = selected.at(-1);
  const first = selected[0];
  const upper = activeCursor && first ? { ...first, startedAt: activeCursor.upperAt, id: activeCursor.upperId } : first;
  return {
    events: selected, nextCursor: hasMore && last && upper ? encodeSecurityCursor(ownerId, page.bridgeId, last, upper) : null,
    retentionDays: 30, maxEvents: 10000, oldestAvailableAt: oldest,
    truncated: stat.count >= 10000 || reset, reset,
  };
}

export class SecurityEventStore {
  private readonly runId = randomUUID();
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(readonly pool: Pool) {}
  async start(): Promise<void> {
    try {
      await this.pool.query('SELECT owner_id,event FROM mcp_security_events LIMIT 0');
      await this.renew();
      await this.reconcile();
      this.heartbeat = setInterval(() => { void this.renew().then(() => this.reconcile()).catch(() => {}); }, 30_000);
      this.heartbeat.unref();
    } catch { throw new SecurityError('security_setup_required', 'Security history database migration is required'); }
  }
  private async renew(): Promise<void> {
    await this.pool.query("INSERT INTO mcp_gateway_runs(run_id,lease_expires_at) VALUES($1,NOW()+INTERVAL '90 seconds') ON CONFLICT(run_id) DO UPDATE SET lease_expires_at=EXCLUDED.lease_expires_at", [this.runId]);
  }
  async reconcile(): Promise<void> {
    await this.pool.query("UPDATE mcp_security_events e SET event=e.event||jsonb_build_object('status','unknown','finishedAt',$1::text,'errorCode','outcome_unknown') WHERE e.event->>'status'='started' AND NOT EXISTS(SELECT 1 FROM mcp_gateway_runs r WHERE r.run_id=e.run_id AND r.lease_expires_at>NOW())", [new Date().toISOString()]);
    // Bounded global cleanup also expires history for accounts that never call again.
    await this.pool.query("DELETE FROM mcp_security_events WHERE (owner_id,id) IN (SELECT owner_id,id FROM mcp_security_events WHERE started_at<NOW()-INTERVAL '30 days' AND event->>'status'<>'started' ORDER BY started_at LIMIT 1000)");
    await this.pool.query('DELETE FROM mcp_endpoint_identities WHERE grant_id IN (SELECT grant_id FROM mcp_endpoint_identities WHERE expires_at<NOW() ORDER BY expires_at LIMIT 1000)');
    await this.pool.query("DELETE FROM mcp_gateway_runs WHERE run_id IN (SELECT r.run_id FROM mcp_gateway_runs r WHERE r.lease_expires_at<NOW()-INTERVAL '1 day' AND NOT EXISTS(SELECT 1 FROM mcp_security_events e WHERE e.run_id=r.run_id) LIMIT 1000)");
  }
  async admit(input: SecurityEvent): Promise<void> {
    const event = validateSecurityEvent(input);
    if (event.source !== 'gateway' || event.status !== 'started') throw unavailable();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`security-audit:${event.ownerId}`]);
      await client.query("INSERT INTO mcp_gateway_runs(run_id,lease_expires_at) VALUES($1,NOW()+INTERVAL '90 seconds') ON CONFLICT(run_id) DO UPDATE SET lease_expires_at=EXCLUDED.lease_expires_at", [this.runId]);
      await client.query("DELETE FROM mcp_security_events WHERE owner_id=$1 AND event->>'status'<>'started' AND (started_at<NOW()-INTERVAL '30 days' OR id IN(SELECT id FROM mcp_security_events WHERE owner_id=$1 ORDER BY started_at DESC,id DESC OFFSET 9999))", [event.ownerId]);
      const count = await client.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM mcp_security_events WHERE owner_id=$1', [event.ownerId]);
      if (count.rows[0].count >= 10000) throw new SecurityError('capacity_exceeded', 'Security history admission capacity is exhausted');
      await client.query('INSERT INTO mcp_security_events(owner_id,id,action_id,parent_action_id,bridge_id,started_at,event,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [event.ownerId, event.id, event.actionId, event.parentActionId, event.bridgeId, event.startedAt, JSON.stringify(event), this.runId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof SecurityError) throw error;
      throw unavailable();
    } finally { client.release(); }
  }
  async finish(event: SecurityEvent, outcome: SecurityOutcome): Promise<void> {
    const completed = validateSecurityEvent({ ...event, finishedAt: new Date().toISOString(), status: outcome.status, errorCode: outcome.errorCode === null ? null : safeFailureCode(outcome.errorCode) });
    try {
      const result = await this.pool.query("UPDATE mcp_security_events SET event=$1 WHERE owner_id=$2 AND id=$3 AND run_id=$4 AND event->>'status' IN ('started','unknown')", [JSON.stringify(completed), completed.ownerId, completed.id, this.runId]);
      if (result.rowCount !== 1) throw unavailable();
    } catch { throw new SecurityError('outcome_unknown', 'Operation may have executed but its final security record could not be saved'); }
  }
  list(ownerId: string, page?: SecurityPageQuery): Promise<SecurityPage> {
    return listSecurityPage(async (text, values) => (await this.pool.query(text, values)).rows, ownerId, page);
  }
  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    await this.pool.query('UPDATE mcp_gateway_runs SET lease_expires_at=NOW() WHERE run_id=$1', [this.runId]);
    await this.reconcile();
  }
}
