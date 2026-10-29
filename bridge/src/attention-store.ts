import { legacyDateTimeSchema } from './zod-compat.js';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PushNotice } from './push-notifier.js';
import { classifyAttentionHook, sanitizeAttentionText, type Activity, type AttentionItem, type Resolution } from './attention-events.js';

const itemSchema = z.object({
  id: z.string(), sequence: z.number().int().positive(),
  type: z.enum(['permission_prompt', 'elicitation_dialog', 'agent_needs_input', 'ask_user']),
  title: z.string().max(200), message: z.string().max(2000),
  createdAt: z.string(), lastSeenAt: z.string(), occurrences: z.number().int().positive(),
  acknowledgedAt: z.string().optional(), resolvedAt: z.string().optional(),
  resolution: z.enum(['manual', 'user_prompt', 'elicitation_complete', 'session_end']).optional(),
  fingerprint: z.string(), sourceId: z.string().optional(), reason: z.string().optional(),
}).strict();
const ledgerSchema = z.object({
  version: z.literal(1), epoch: z.string().guid(), sequence: z.number().int().nonnegative(),
  prunedThrough: z.number().int().nonnegative(),
  activity: z.object({ state: z.enum(['thinking', 'tool_use', 'idle', 'unknown']), lastActivityAt: z.string().optional() }).strict(),
  events: z.array(itemSchema),
  idleCycle: z.object({ id: z.string().guid(), startedAt: legacyDateTimeSchema, dueAt: legacyDateTimeSchema, notifiedAt: legacyDateTimeSchema.optional() }).strict().optional(),
}).strict();
type Ledger = z.infer<typeof ledgerSchema>;
type StoredItem = Ledger['events'][number];
export interface AttentionPage {
  events: AttentionItem[]; cursor: string; hasMore: boolean; cursorReset: boolean; activity: Activity; openCount: number; latest?: AttentionItem;
}
export interface AttentionReadOptions { cursor?: string; limit?: number; includeResolved?: boolean; actionableOnly?: boolean }
export interface ExplicitAttentionSnapshot { attention: AttentionItem | null; sequence: number }
export class AttentionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const publicItem = ({ fingerprint: _fingerprint, sourceId: _sourceId, reason: _reason, ...item }: StoredItem): AttentionItem => item;

export const IDLE_NOTIFICATION_DELAY_MS = 600_000;
export interface AttentionNotificationOptions {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  isSessionActive?: (sessionId: string) => Promise<boolean>;
  onIdleCanceled?: (sessionId: string) => void;
}
interface IdleTimer { cycleId: string; timer: ReturnType<typeof setTimeout> }

/** Single-process, serialized snapshots. Missing/corrupt files never masquerade as recovered history. */
export class AttentionStore {
  private locks = new Map<string, Promise<unknown>>();
  private listeners = new Map<string, Set<() => void>>();
  private idleTimers = new Map<string, IdleTimer>();
  private notificationsStopped = false;
  private notificationOptions: Required<Omit<AttentionNotificationOptions, 'onIdleCanceled'>> & Pick<AttentionNotificationOptions, 'onIdleCanceled'>;
  constructor(private resolveDir: (sessionId: string) => string, private resolvedRetention = 500,
    private onNotification?: (sessionId: string, notice: PushNotice) => void,
    options: AttentionNotificationOptions = {}) {
    this.notificationOptions = { now: Date.now, schedule: setTimeout, cancel: clearTimeout,
      isSessionActive: async () => true, ...options };
  }

  private clearIdleTimer(id: string): void {
    const entry = this.idleTimers.get(id);
    if (entry) this.notificationOptions.cancel(entry.timer);
    this.idleTimers.delete(id);
  }
  private idleCanceled(id: string): void {
    this.clearIdleTimer(id);
    try { this.notificationOptions.onIdleCanceled?.(id); } catch { /* Optional observer is isolated. */ }
  }
  private scheduleIdle(id: string, cycle: NonNullable<Ledger['idleCycle']>): void {
    if (this.notificationsStopped || cycle.notifiedAt || !this.onNotification) return;
    this.clearIdleTimer(id);
    const remaining = Math.max(0, Date.parse(cycle.dueAt) - this.notificationOptions.now());
    const timer = this.notificationOptions.schedule(() => { void this.emitIdle(id, cycle.id).catch(() => {
      if (this.idleTimers.get(id)?.cycleId === cycle.id) this.clearIdleTimer(id);
    }); }, Math.min(remaining, 2_147_483_647));
    timer.unref?.();
    this.idleTimers.set(id, { cycleId: cycle.id, timer });
  }
  private async emitIdle(id: string, cycleId: string): Promise<void> {
    await this.withLock(id, async () => {
      const current = () => !this.notificationsStopped && this.idleTimers.get(id)?.cycleId === cycleId;
      if (!current()) return;
      const ledger = await this.load(id);
      const cycle = ledger.idleCycle;
      if (!cycle || cycle.id !== cycleId || cycle.notifiedAt || ledger.activity.state !== 'idle') { this.clearIdleTimer(id); return; }
      const active = await this.notificationOptions.isSessionActive(id);
      if (!current()) return;
      if (!active) { delete ledger.idleCycle; await this.save(id, ledger); this.idleCanceled(id); return; }
      if (this.notificationOptions.now() < Date.parse(cycle.dueAt)) { this.scheduleIdle(id, cycle); return; }
      const timestamp = new Date(this.notificationOptions.now()).toISOString();
      cycle.notifiedAt = timestamp;
      await this.save(id, ledger);
      if (!current()) return;
      this.clearIdleTimer(id);
      try { this.onNotification?.(id, { kind: 'idle', eventKey: `idle:${cycle.id}`, title: 'Agent has been idle for 10 minutes',
        message: 'The agent is ready for your next instruction.', occurredAt: timestamp }); } catch { /* Durable qualification is not rolled back by delivery failure. */ }
    });
  }
  async restoreIdleNotifications(ids: Iterable<string>): Promise<void> {
    for (const id of ids) {
      try {
        await this.withLock(id, async () => {
          if (this.notificationsStopped) return;
          const ledger = await this.load(id);
          if (ledger.activity.state === 'idle' && ledger.idleCycle && !ledger.idleCycle.notifiedAt) this.scheduleIdle(id, ledger.idleCycle);
        });
      } catch { console.warn(`[Bridge] Could not restore idle notification for session ${id}`); }
    }
  }
  async cancelIdleNotification(id: string): Promise<void> {
    this.idleCanceled(id);
    await this.withLock(id, async () => {
      this.idleCanceled(id);
      const ledger = await this.load(id);
      if (ledger.idleCycle) { delete ledger.idleCycle; await this.save(id, ledger); }
    });
  }
  stopNotifications(): void {
    this.notificationsStopped = true;
    for (const id of Array.from(this.idleTimers.keys())) this.idleCanceled(id);
  }

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return Promise.reject(new AttentionError('invalid_session', 'Invalid session ID'));
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(id, settled);
    void settled.then(() => { if (this.locks.get(id) === settled) this.locks.delete(id); });
    return next;
  }
  private async load(id: string): Promise<Ledger> {
    try { return ledgerSchema.parse(JSON.parse(await readFile(join(this.resolveDir(id), 'attention.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const ledger: Ledger = { version: 1, epoch: randomUUID(), sequence: 0, prunedThrough: 0, activity: { state: 'unknown' }, events: [] };
        await this.save(id, ledger);
        return ledger;
      }
      throw new AttentionError('attention_storage_error', 'Attention history could not be read', 500);
    }
  }
  private async save(id: string, ledger: Ledger) {
    const dir = this.resolveDir(id);
    const file = join(dir, 'attention.json');
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      // Never mkdir here: deleting a session must not be undone by an in-flight hook.
      const handle = await open(tmp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(ledger), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(tmp, file);
      const directory = await open(dir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new AttentionError('attention_storage_error', 'Attention history could not be persisted', 500);
    }
  }
  private cursor(id: string, ledger: Ledger, sequence: number) {
    return Buffer.from(JSON.stringify({ v: 1, session: id, epoch: ledger.epoch, sequence })).toString('base64url');
  }
  private parseCursor(id: string, cursor: string) {
    try {
      if (cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const value = z.object({ v: z.literal(1), session: z.literal(id), epoch: z.string().guid(), sequence: z.number().int().nonnegative() }).strict().parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      return value;
    } catch { throw new AttentionError('invalid_cursor', 'Cursor is malformed or belongs to another session'); }
  }
  private prune(ledger: Ledger) {
    const resolved = ledger.events.filter((event) => event.resolvedAt).sort((a, b) => b.sequence - a.sequence);
    const drop = new Set(resolved.slice(this.resolvedRetention).map((event) => event.id));
    for (const event of ledger.events) if (drop.has(event.id)) ledger.prunedThrough = Math.max(ledger.prunedThrough, event.sequence);
    ledger.events = ledger.events.filter((event) => !drop.has(event.id));
  }
  async record(id: string, eventName: string, data: Record<string, unknown>): Promise<AttentionItem | undefined> {
    const observation = classifyAttentionHook(eventName, data);
    if (!observation.activity && !observation.attention && !observation.resolve) return;
    const cancelIdle = observation.activity === 'thinking' || observation.activity === 'tool_use' || observation.resolve === 'session_end';
    if (cancelIdle) this.idleCanceled(id);
    return this.withLock(id, async () => {
      const ledger = await this.load(id);
      const timestamp = new Date(this.notificationOptions.now()).toISOString();
      const notifications: PushNotice[] = [];
      if (cancelIdle) { this.idleCanceled(id); delete ledger.idleCycle; }
      else if (observation.activity === 'idle' && ['thinking', 'tool_use'].includes(ledger.activity.state)) {
        ledger.idleCycle = { id: randomUUID(), startedAt: timestamp, dueAt: new Date(this.notificationOptions.now() + IDLE_NOTIFICATION_DELAY_MS).toISOString() };
      }
      if (observation.activity) ledger.activity = { state: observation.activity, lastActivityAt: timestamp };
      if (observation.resolve) for (const event of ledger.events) {
        if (event.resolvedAt || (observation.resolve === 'elicitation_complete' && event.type !== 'elicitation_dialog')) continue;
        event.resolvedAt = timestamp;
        event.resolution = observation.resolve;
      }
      let created = false;
      let recorded: StoredItem | undefined;
      if (observation.attention) {
        const { sourceId: rawSourceId, ...attention } = observation.attention;
        const sourceId = rawSourceId ? createHash('sha256').update(rawSourceId).digest('hex') : undefined;
        const fingerprint = createHash('sha256').update(JSON.stringify(attention)).digest('hex');
        const existing = ledger.events.find((event) => !event.resolvedAt && (sourceId ? event.sourceId === sourceId : event.fingerprint === fingerprint));
        if (existing) { existing.lastSeenAt = timestamp; existing.occurrences++; recorded = existing; }
        else {
          const attentionId = randomUUID();
          notifications.push({ kind: 'question', eventKey: `question:${attentionId}`, title: attention.title, message: attention.message, occurredAt: timestamp });
          recorded = { ...attention, id: attentionId, sequence: ++ledger.sequence, createdAt: timestamp, lastSeenAt: timestamp, occurrences: 1, fingerprint, ...(sourceId ? { sourceId } : {}) };
          ledger.events.push(recorded);
          created = true;
        }
      }
      this.prune(ledger);
      await this.save(id, ledger);
      if (ledger.activity.state === 'idle' && ledger.idleCycle && !ledger.idleCycle.notifiedAt
        && !this.idleTimers.has(id)) this.scheduleIdle(id, ledger.idleCycle);
      for (const notice of notifications) {
        try { if (!this.notificationsStopped) this.onNotification?.(id, notice); } catch { /* Optional delivery cannot fail a committed hook. */ }
      }
      if (created) for (const listener of this.listeners.get(id) ?? []) listener();
      return recorded ? publicItem(recorded) : undefined;
    });
  }
  async list(id: string, options: AttentionReadOptions = {}): Promise<AttentionPage> {
    return this.withLock(id, async () => {
      const ledger = await this.load(id);
      const incoming = options.cursor ? this.parseCursor(id, options.cursor) : undefined;
      const cursorReset = !!incoming && (incoming.epoch !== ledger.epoch || incoming.sequence < ledger.prunedThrough || incoming.sequence > ledger.sequence);
      const after = incoming && !cursorReset ? incoming.sequence : 0;
      const limit = Math.min(100, Math.max(1, options.limit ?? 50));
      const eligible = ledger.events.filter((event) => event.sequence > after && (options.includeResolved || !event.resolvedAt) && (!options.actionableOnly || (!event.resolvedAt && !event.acknowledgedAt))).sort((a, b) => a.sequence - b.sequence);
      const events = eligible.slice(0, limit);
      const hasMore = eligible.length > events.length;
      // Do not skip records omitted by this page; filtered-out rows do not block later actionable events.
      const sequence = hasMore ? events.at(-1)!.sequence : ledger.sequence;
      return { events: events.map(publicItem), cursor: this.cursor(id, ledger, sequence), hasMore, cursorReset, activity: { ...ledger.activity }, openCount: ledger.events.filter((event) => !event.resolvedAt).length, ...(ledger.events.filter((event) => !event.resolvedAt).at(-1) ? { latest: publicItem(ledger.events.filter((event) => !event.resolvedAt).at(-1)!) } : {}) };
    });
  }
  private latestExplicit(ledger: Ledger): AttentionItem | null {
    const latest = ledger.events.filter(event => event.type === 'agent_needs_input' && !event.resolvedAt && !event.acknowledgedAt)
      .reduce<StoredItem | undefined>((current, event) => !current || event.sequence > current.sequence ? event : current, undefined);
    return latest ? publicItem(latest) : null;
  }
  async explicitSnapshot(id: string): Promise<ExplicitAttentionSnapshot> {
    return this.withLock(id, async () => {
      const ledger = await this.load(id);
      return { attention: this.latestExplicit(ledger), sequence: ledger.sequence };
    });
  }
  /** Dismiss the displayed incident and its superseded explicit predecessors. */
  async resolveExplicitThrough(id: string, eventId: string): Promise<ExplicitAttentionSnapshot> {
    return this.withLock(id, async () => {
      const ledger = await this.load(id);
      const displayed = ledger.events.find(event => event.id === eventId && event.type === 'agent_needs_input');
      if (!displayed) throw new AttentionError('unknown_attention', 'Unknown explicit attention request');
      const timestamp = new Date().toISOString();
      for (const event of ledger.events) {
        if (event.type === 'agent_needs_input' && event.sequence <= displayed.sequence && !event.resolvedAt) {
          event.resolvedAt = timestamp;
          event.resolution = 'manual';
        }
      }
      this.prune(ledger);
      await this.save(id, ledger);
      return { attention: this.latestExplicit(ledger), sequence: ledger.sequence };
    });
  }
  async mutate(id: string, ids: string[], operation: 'ack' | 'resolve', reason?: string): Promise<AttentionItem[]> {
    return this.withLock(id, async () => {
      const ledger = await this.load(id);
      const wanted = [...new Set(ids)];
      if (!wanted.length || wanted.length > 100 || wanted.some((eventId) => !ledger.events.some((event) => event.id === eventId))) {
        throw new AttentionError('unknown_attention', 'One or more attention IDs are unknown');
      }
      const timestamp = new Date().toISOString();
      const result = wanted.map((eventId) => ledger.events.find((event) => event.id === eventId)!);
      for (const event of result) {
        if (operation === 'ack' && !event.acknowledgedAt) event.acknowledgedAt = timestamp;
        if (operation === 'resolve' && !event.resolvedAt) {
          event.resolvedAt = timestamp; event.resolution = 'manual' satisfies Resolution;
          if (reason) event.reason = sanitizeAttentionText(reason, 500);
        }
      }
      const output = result.map(publicItem);
      this.prune(ledger);
      await this.save(id, ledger);
      return output;
    });
  }
  async wait(id: string, options: AttentionReadOptions, waitSeconds: number, signal?: AbortSignal): Promise<AttentionPage> {
    const deadline = Date.now() + Math.min(25, Math.max(0, waitSeconds)) * 1000;
    // Install before the first read so a committed event cannot fall between read and listener setup.
    let notify: (() => void) | undefined;
    const listeners = this.listeners.get(id) ?? new Set<() => void>();
    const listener = () => notify?.();
    listeners.add(listener); this.listeners.set(id, listeners);
    try {
      while (true) {
        if (signal?.aborted) throw new AttentionError('cancelled', 'Attention wait cancelled', 499);
        let wake!: () => void;
        const change = new Promise<void>((resolve) => { wake = resolve; });
        notify = wake;
        const page = await this.list(id, { ...options, actionableOnly: true, includeResolved: false });
        if (page.events.length || Date.now() >= deadline) return page;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => wake();
        try {
          const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); });
          signal?.addEventListener('abort', cancel, { once: true });
          if (signal?.aborted) wake();
          await Promise.race([change, timeout]);
        } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
      }
    } finally { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); }
  }
}
