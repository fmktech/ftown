import { legacyDateTimeSchema } from '../../zod-compat.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { SecurityEvent, SecurityEventStatus, SecurityPage, SecurityPageQuery } from '../protocol.js';
import { BridgeSecurityError } from './errors.js';
import { boundedId } from './metadata.js';
import { AtomicSnapshot } from './snapshot.js';

const DAY = 86_400_000;
const knownTools = new Set(['sessions_create', 'sessions_get', 'sessions_update', 'sessions_stop', 'sessions_retry', 'sessions_remove',
  'sessions_revive', 'sessions_usage', 'sessions_running', 'chats_read', 'chats_search', 'messages_send', 'messages_read',
  'terminal_input', 'terminal_resize', 'terminal_clear', 'whoami', 'attention_request', 'attention_inbox', 'attention_wait',
  'attention_ack', 'attention_resolve', 'fleet_overview', 'machines_list', 'sessions_list', 'archive_list', 'messages_broadcast',
  'sessions_wait', 'fleet_batch', 'chats_search_fleet', 'unknown_tool', 'invalid_tool']);
const safeCodes = new Set(['security_setup_required', 'storage_unavailable', 'upgrade_required', 'approval_required', 'endpoint_revoked',
  'invalid_envelope', 'authentication_failed', 'wrong_context', 'expired', 'replayed', 'epoch_changed', 'permission_denied',
  'capacity_exceeded', 'audit_unavailable', 'outcome_unknown', 'bridge_offline', 'invalid_cursor', 'key_unavailable',
  'unknown_session', 'unknown_attention', 'attention_storage_error', 'cancelled', 'attention_not_ready', 'timeout', 'connection_error',
  'bridge_error', 'response_too_large', 'internal_error', 'interrupted']);
const safeOperation = /^[a-z][a-z0-9_]{0,63}$/;
const eventSchema = z.object({ version: z.literal(1), id: z.string().guid(), actionId: boundedId, parentActionId: boundedId.nullable(),
  ownerId: z.string().min(1).max(200), source: z.literal('bridge'), bridgeId: boundedId, clientId: boundedId.nullable(),
  grantId: boundedId.nullable(), endpointId: boundedId.nullable(), tool: z.string().max(64), operation: z.string().max(64).nullable(),
  sessionId: boundedId.nullable(), startedAt: legacyDateTimeSchema, finishedAt: legacyDateTimeSchema.nullable(),
  status: z.enum(['started', 'succeeded', 'rejected', 'failed', 'unknown']), errorCode: z.string().max(64).nullable(), mutating: z.boolean() }).strict();
const stateSchema = z.object({ version: z.literal(1), ownerId: z.string(), bridgeId: z.string(), epoch: z.string().guid(),
  sequence: z.number().int().nonnegative(), prunedThrough: z.number().int().nonnegative(), pruning: z.number().int().nonnegative().optional(), truncated: z.boolean(),
  entries: z.array(z.object({ sequence: z.number().int().positive(), admissionId: boundedId, event: eventSchema }).strict()).max(10000) }).strict();
type State = z.infer<typeof stateSchema>;
const cursorSchema = z.object({ v: z.literal(1), ownerId: z.string(), bridgeId: z.string(), epoch: z.string().guid(),
  snapshot: z.number().int().nonnegative(), before: z.number().int().positive(), pruning: z.number().int().nonnegative().default(0) }).strict();
export interface AuditAdmission {
  admissionId: string; actionId: string; parentActionId: string | null;
  clientId: string | null; grantId: string | null; endpointId: string | null;
  tool: string; operation: string | null; sessionId: string | null; mutating: boolean;
}
export interface AuditOptions { now?: () => number; maxEvents?: number }

/** Durable received-operation evidence. Only fixed, bounded metadata is ever serialized. */
export class BridgeAuditStore {
  private readonly snapshot: AtomicSnapshot<State>;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private ready?: Promise<void>;
  constructor(dataDir: string, readonly ownerId: string, readonly bridgeId: string, options: AuditOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEvents = options.maxEvents ?? 10000;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1 || this.maxEvents > 10000) throw new BridgeSecurityError('capacity_exceeded');
    this.snapshot = new AtomicSnapshot(join(dataDir, 'security', 'activity.json'), stateSchema, () => ({
      version: 1, ownerId, bridgeId, epoch: randomUUID(), sequence: 0, prunedThrough: 0, pruning: 0, truncated: false, entries: [],
    }));
  }
  private check(state: State): void {
    if (state.ownerId !== this.ownerId || state.bridgeId !== this.bridgeId) throw new BridgeSecurityError('wrong_context');
    state.pruning ??= 0;
  }
  private prune(state: State, reserve = 0): void {
    const cutoff = this.now() - 30 * DAY;
    const retained = state.entries.filter(entry => entry.event.status === 'started' || Date.parse(entry.event.startedAt) >= cutoff);
    const removed = state.entries.filter(entry => entry.event.status !== 'started' && Date.parse(entry.event.startedAt) < cutoff);
    while (retained.length + reserve > this.maxEvents) {
      const finished = retained.findIndex(entry => entry.event.status !== 'started');
      if (finished < 0) throw new BridgeSecurityError('audit_unavailable');
      removed.push(...retained.splice(finished, 1));
    }
    if (removed.length) {
      state.prunedThrough = Math.max(state.prunedThrough, ...removed.map(entry => entry.sequence));
      state.pruning = (state.pruning ?? 0) + 1;
      state.truncated = true;
    }
    state.entries = retained;
  }
  async initialize(): Promise<void> {
    if (!this.ready) this.ready = this.snapshot.transact(state => {
      this.check(state);
      for (const entry of state.entries) if (entry.event.status === 'started') {
        entry.event.status = 'unknown'; entry.event.finishedAt = new Date(this.now()).toISOString(); entry.event.errorCode = 'interrupted';
      }
      this.prune(state);
    }).catch(() => { throw new BridgeSecurityError('audit_unavailable'); });
    await this.ready;
  }
  async admit(input: AuditAdmission): Promise<{ event: SecurityEvent; isNew: boolean }> {
    await this.initialize();
    const timestamp = new Date(this.now()).toISOString();
    let event: z.infer<typeof eventSchema>;
    try {
      boundedId.parse(input.admissionId);
      event = eventSchema.parse({ version: 1, id: randomUUID(), actionId: input.actionId, parentActionId: input.parentActionId,
        ownerId: this.ownerId, source: 'bridge', bridgeId: this.bridgeId, clientId: input.clientId, grantId: input.grantId,
        endpointId: input.endpointId, tool: knownTools.has(input.tool) ? input.tool : 'invalid_tool',
        operation: input.operation !== null && safeOperation.test(input.operation) ? input.operation : null,
        sessionId: input.sessionId, startedAt: timestamp, finishedAt: null, status: 'started', errorCode: null, mutating: input.mutating });
    } catch { throw new BridgeSecurityError('audit_unavailable'); }
    try {
      return await this.snapshot.transact(state => {
        this.check(state); this.prune(state);
        const previous = state.entries.find(entry => entry.admissionId === input.admissionId);
        if (previous) {
          const prior = previous.event;
          if (prior.actionId !== event.actionId || prior.endpointId !== event.endpointId || prior.operation !== event.operation
            || prior.tool !== event.tool || prior.sessionId !== event.sessionId || prior.mutating !== event.mutating
            || prior.grantId !== event.grantId || prior.clientId !== event.clientId || prior.parentActionId !== event.parentActionId) {
            throw new BridgeSecurityError('replayed');
          }
          return { event: prior, isNew: false };
        }
        this.prune(state, 1);
        state.entries.push({ admissionId: input.admissionId, sequence: ++state.sequence, event });
        return { event, isNew: true };
      });
    } catch (error) {
      if (error instanceof BridgeSecurityError && error.code === 'replayed') throw error;
      throw new BridgeSecurityError('audit_unavailable');
    }
  }
  async finish(id: string, status: Exclude<SecurityEventStatus, 'started'>, errorCode: string | null = null): Promise<SecurityEvent> {
    await this.initialize();
    try {
      return await this.snapshot.transact(state => {
        this.check(state);
        const entry = state.entries.find(item => item.event.id === id);
        if (!entry) throw new BridgeSecurityError('audit_unavailable');
        if (entry.event.status !== 'started') return entry.event;
        entry.event.status = status; entry.event.finishedAt = new Date(this.now()).toISOString();
        entry.event.errorCode = errorCode === null ? null : safeCodes.has(errorCode) ? errorCode : 'internal_error';
        return entry.event;
      });
    } catch { throw new BridgeSecurityError('audit_unavailable'); }
  }
  async list(query: SecurityPageQuery = {}): Promise<SecurityPage> {
    await this.initialize();
    if (query.bridgeId !== undefined && query.bridgeId !== this.bridgeId) throw new BridgeSecurityError('wrong_context');
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BridgeSecurityError('invalid_cursor');
    let incoming: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error('Invalid cursor');
        incoming = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
        if (incoming.ownerId !== this.ownerId || incoming.bridgeId !== this.bridgeId || incoming.before > incoming.snapshot + 1) throw new Error('Wrong cursor context');
      } catch { throw new BridgeSecurityError('invalid_cursor'); }
    }
    try {
      return await this.snapshot.transact(state => {
        this.check(state); this.prune(state);
        const reset = !!incoming && (incoming.epoch !== state.epoch || incoming.snapshot > state.sequence || incoming.pruning !== state.pruning);
        const snapshot = incoming && !reset ? incoming.snapshot : state.sequence;
        const before = incoming && !reset ? incoming.before : snapshot + 1;
        const eligible = state.entries.filter(entry => entry.sequence <= snapshot && entry.sequence < before).reverse();
        const page = eligible.slice(0, limit);
        const nextCursor = eligible.length > page.length && page.length > 0 ? Buffer.from(JSON.stringify({ v: 1,
          ownerId: this.ownerId, bridgeId: this.bridgeId, epoch: state.epoch, snapshot, before: page.at(-1)!.sequence, pruning: state.pruning })).toString('base64url') : null;
        return { events: page.map(entry => entry.event), nextCursor, retentionDays: 30, maxEvents: 10000,
          oldestAvailableAt: state.entries[0]?.event.startedAt ?? null, truncated: state.truncated, reset };
      });
    } catch { throw new BridgeSecurityError('audit_unavailable'); }
  }
  async close(): Promise<void> { await this.ready; await this.snapshot.close(); }
}
