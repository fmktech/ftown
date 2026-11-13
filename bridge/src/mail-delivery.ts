import { createMailMessage, createNudgeToken } from './mail-store.js';
import { HOOKED_SHELL_TYPES } from './harness-registry.js';
import { createNativeMailWaker, type NativeMailWaker } from './native-mail.js';
import {
  DIGEST_MAX,
  MAIL_TYPES_V2,
  MAX_WAKE_ATTEMPTS,
  NON_WAKING_MAIL_TYPES,
  type DigestProvider,
  type MailCounts,
  type MailEventSink,
  type MailTypeV2,
} from './coordination/contract.js';

import type { MailMessage, Session, ShellType } from './types.js';

export { MAIL_TYPES_V2, MAX_WAKE_ATTEMPTS, NON_WAKING_MAIL_TYPES };

export const MAX_MAIL_BODY_LENGTH = 64 * 1024;
export const MAX_MAIL_WAIT_SECONDS = 30;
export const MAIL_NUDGE_DELAY_MS = 5_000;
// Hooked agents (claude/codex and claude flavors) get mail through their Stop
// pump; the nudge is only a safety net for them, so wait much longer before
// typing into their pane — fast nudges race the pump and queue stale prompts.
export const MAIL_NUDGE_DELAY_HOOKED_MS = 60_000;
export const MAIL_NUDGE_MIN_INTERVAL_MS = 30_000;
// While an agent is mid-turn its Stop hook pump delivers mail at turn end, so
// nudging would only queue a stale prompt; re-check periodically in case the
// turn never reaches Stop, and ignore busy markers old enough to be a crash.
export const MAIL_NUDGE_BUSY_RECHECK_MS = 60_000;
export const AGENT_BUSY_STALE_MS = 30 * 60_000;
export const NATIVE_WAKE_LEASE_MS = 30_000;
/** Leading literals of every ftown-originated prompt (bridge or installed plugin). Trimmed prompts starting with one are injected. */
export const INJECTED_PROMPT_PREFIXES = ['[ftown msg from ', '[ftown mail]', 'FTown mail may be available.'] as const;
export const MAIL_WAKE_TEXT = `${INJECTED_PROMPT_PREFIXES[2]} If this prompt's hooks supplied [ftown mail], process that mail without reading it again. Otherwise run \`ftown harness mail read\` once; if no mail is returned, no action is needed.`;
/** The opencode plugin's effective wake prompt; mirrored by the static asset (asset-tested). */
export const OPENCODE_MAIL_WAKE_TEXT = `${INJECTED_PROMPT_PREFIXES[1]} You have new ftown mail — run \`ftown harness mail read\` to read it.`;
export interface NativeWakeRegistration { adapter: 'claude-mod' | 'opencode'; nativeSessionId: string }
export class NativeWakeRegistrationError extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message); }
}
export function parseNativeWakeRegistration(query: URLSearchParams): NativeWakeRegistration | undefined {
  const adapter = query.get('adapter');
  const nativeSessionId = query.get('nativeSessionId');
  if (adapter === null && nativeSessionId === null) return undefined;
  if ((adapter !== 'claude-mod' && adapter !== 'opencode') || !nativeSessionId
    || nativeSessionId.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(nativeSessionId)
    || query.getAll('adapter').length !== 1 || query.getAll('nativeSessionId').length !== 1
    || query.get('peek') !== '1' || query.get('wait') !== '0') {
    throw new NativeWakeRegistrationError(400, 'Native wake registration requires peek=1, wait=0, adapter and nativeSessionId');
  }
  return { adapter, nativeSessionId };
}

export const MAIL_TYPES: ReadonlyArray<MailMessage['type']> = MAIL_TYPES_V2;

const NUDGE_COUNT_ORDER: ReadonlyArray<MailTypeV2> = ['task', 'escalation', 'result', 'message'];

export function countMailTypes(messages: readonly MailMessage[]): MailCounts {
  const counts: MailCounts = {};
  for (const msg of messages) {
    if (NON_WAKING_MAIL_TYPES.has(msg.type)) continue;
    counts[msg.type] = (counts[msg.type] ?? 0) + 1;
  }
  return counts;
}

export function formatNudgeText(counts: MailCounts, digest?: string | null): string {
  const parts: string[] = [];
  let total = 0;
  for (const type of NUDGE_COUNT_ORDER) {
    const count = counts[type] ?? 0;
    if (count > 0) {
      total += count;
      parts.push(`${count} ${type}`);
    }
  }
  const base = `[ftown] ${total} new mail (${parts.join(', ')}) — run: ftown harness mail read`;
  const trimmedDigest = typeof digest === 'string' ? sanitizeMessageText(digest).slice(0, DIGEST_MAX) : '';
  return trimmedDigest ? `${base} | ${trimmedDigest}` : base;
}

export const NUDGE_TEXT = formatNudgeText;

// Composer TUIs detect pastes by input arrival rate; the submit CR must come well
// after that window or it is treated as a pasted newline.
const COMPOSER_PASTE_SETTLE_MS = 600;

// Messages are sanitized to a single line, so a delayed plain CR submits everywhere.
// (ESC+CR reads as Alt+Enter — insert newline — on current Claude Code.)
function submitSuffixFor(_shellType: ShellType | undefined): string {
  return '\r';
}

// Strip control chars and collapse whitespace so a message cannot inject keystrokes.
export function sanitizeMessageText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pending long-poll request for a session's inbox. */
interface MailWaiter {
  deliver: (messages: MailMessage[]) => void;
}
const codexMetadata = (value: string) => value.slice(0, 200).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const codexMailText = (message: MailMessage) =>
  `${INJECTED_PROMPT_PREFIXES[1]} id=${JSON.stringify(codexMetadata(message.id))} from=${JSON.stringify(codexMetadata(message.from))}`
  + (message.fromName ? ` fromName=${JSON.stringify(codexMetadata(message.fromName))}` : '')
  + ` type=${JSON.stringify(codexMetadata(message.type))}`
  + (message.threadId ? ` threadId=${JSON.stringify(codexMetadata(message.threadId))}` : '')
  + `\n\n${message.body}`;
const nativeIdentity = (session: Session) => `${session.shellType}:${session.shellType === 'codex' ? session.codexSessionId ?? '' : session.museSessionId ?? ''}`;

/** The slice of SessionStore the mail engine needs. */
export interface MailDeliverySessionStore {
  loadSession(sessionId: string): Promise<Session | null>;
  listSessions(): Promise<Session[]>;
}

/** The slice of MailStore the mail engine needs. */
export interface MailDeliveryMailStore {
  append(msg: MailMessage): Promise<void>;
  listUndelivered(sessionId: string): Promise<MailMessage[]>;
  listUnnudgedWaking(sessionId: string): Promise<MailMessage[]>;
  listAll(sessionId: string, limit: number): Promise<MailMessage[]>;
  markDelivered(
    sessionId: string,
    ids: string[],
    via: NonNullable<MailMessage['deliveredVia']>,
  ): Promise<MailMessage[]>;
  markNudged(sessionId: string, ids: string[], token?: string): Promise<MailMessage[]>;
  unmarkNudged(sessionId: string, ids: string[], token: string): Promise<MailMessage[]>;
}

/** The slice of ProcessRunner the mail engine needs. */
export interface MailDeliveryRunner {
  isRunning(sessionId: string): boolean;
  write(sessionId: string, data: string): boolean;
}

/** Timer handle as returned by the injected setTimeout (Node's supports unref). */
export type MailTimerHandle = { unref?: () => void };

export interface MailDeliveryOptions {
  store?: MailDeliverySessionStore | null;
  mailStore?: MailDeliveryMailStore | null;
  runner?: MailDeliveryRunner | null;
  /** Clock seam — defaults to the real Date.now/setTimeout/clearTimeout. */
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => MailTimerHandle;
  clearTimeout?: (handle: MailTimerHandle) => void;
  nativeWake?: NativeMailWaker;
}

export type AcceptMailResult = { ok: true; id: string } | { ok: false; error: string };

export type InboxReadResult =
  | { kind: 'immediate'; messages: MailMessage[] }
  | { kind: 'longpoll'; messages: Promise<MailMessage[]>; abandon: () => void };

/**
 * The bridge's mail-delivery engine, extracted from the HTTP router so its
 * timing logic (long-poll waiters, nudge debounce/rate-limit/busy-recheck,
 * composer-paste injection) is unit-testable with a controlled clock.
 *
 * Owns ALL mail state: one long-poll waiter per session, nudge timers,
 * pending-nudge sender labels, last-nudge timestamps, and agent busy markers.
 * The HTTP server keeps route parsing/response writing and delegates here.
 */
export class MailDeliveryService {
  private store: MailDeliverySessionStore | null;
  private mailStore: MailDeliveryMailStore | null;
  private runner: MailDeliveryRunner | null;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => MailTimerHandle;
  private readonly clearTimeoutFn: (handle: MailTimerHandle) => void;

  private mailWaiters: Map<string, MailWaiter> = new Map();
  private nudgeTimers: Map<string, MailTimerHandle> = new Map();
  private pendingNudgeFrom: Map<string, string> = new Map();
  private lastNudgeAt: Map<string, number> = new Map();
  private agentBusySince: Map<string, number> = new Map();
  private nativeLeases = new Map<string, NativeWakeRegistration & { until: number }>();
  private selectionLocks = new Map<string, Promise<void>>();
  private codexClaims = new Map<string, Set<string>>();
  private codexRetryAt = new Map<string, number>();
  private batchAttempts = new Map<string, { key: string; count: number }>();
  private museNativeTried = new Map<string, string>();
  private wakeLocks = new Map<string, Promise<void>>();
  private wakeControllers = new Map<string, AbortController>();
  private legacyReadyAt = new Map<string, number>();
  private lastInjection = new Map<string, { text: string; at: number }>();
  private digestProvider: DigestProvider | null = null;
  private eventSink: MailEventSink | null = null;
  private stopped = false;
  private dependencyEpoch = 0;
  private readonly nativeWake: NativeMailWaker;

  constructor(options: MailDeliveryOptions = {}) {
    this.store = options.store ?? null;
    this.mailStore = options.mailStore ?? null;
    this.runner = options.runner ?? null;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.nativeWake = options.nativeWake ?? createNativeMailWaker();
  }

  setStore(store: MailDeliverySessionStore): void {
    if (this.store !== store) this.invalidateRecovery();
    this.store = store;
  }

  setMailStore(mailStore: MailDeliveryMailStore): void {
    if (this.mailStore !== mailStore) this.invalidateRecovery();
    this.mailStore = mailStore;
  }

  setRunner(runner: MailDeliveryRunner): void {
    if (this.runner !== runner) this.invalidateRecovery();
    this.runner = runner;
  }

  setDigestProvider(p: DigestProvider): void {
    this.digestProvider = p;
  }

  setEventSink(s: MailEventSink): void {
    this.eventSink = s;
  }

  private invalidateRecovery(): void {
    this.dependencyEpoch++;
    for (const timer of this.nudgeTimers.values()) this.clearTimeoutFn(timer);
    this.nudgeTimers.clear();
    this.batchAttempts.clear();
    this.museNativeTried.clear();
    for (const controller of this.wakeControllers.values()) controller.abort();
  }

  /** Re-arm the existing wake path when an attached receiver becomes available.
   * The mailbox remains the consumption authority; recovery only sends a pointer.
   */
  async recoverPendingMail(sessionId: string): Promise<void> {
    const { store, mailStore, runner, dependencyEpoch } = this;
    const current = () => !this.stopped && dependencyEpoch === this.dependencyEpoch;
    if (!current() || !store || !mailStore || !runner || !runner.isRunning(sessionId)) return;
    const session = await store.loadSession(sessionId);
    if (!current() || !session || session.status !== 'running' || session.shellType === 'pi'
      || !runner.isRunning(sessionId)) return;
    const pending = await mailStore.listUnnudgedWaking(sessionId);
    if (!current() || !pending.length || !runner.isRunning(sessionId)) return;
    // Reads may have raced deletion/stop or an inbox drain. The wake path checks
    // them again immediately before dispatch, including native capability probes.
    const legacyDelay = HOOKED_SHELL_TYPES.has(session.shellType ?? 'claude')
      ? MAIL_NUDGE_DELAY_HOOKED_MS : MAIL_NUDGE_DELAY_MS;
    if (!this.legacyReadyAt.has(sessionId)) this.legacyReadyAt.set(sessionId, this.now() + legacyDelay);
    const sender = this.pendingNudgeFrom.get(sessionId) ?? pending[0].fromName ?? pending[0].from;
    this.scheduleMailNudge(sessionId, sender,
      session.shellType === 'codex' || session.shellType === 'muse' ? MAIL_NUDGE_DELAY_MS : legacyDelay);
  }

  /** Both the session store and the mail store are wired. */
  isReady(): boolean {
    return this.store !== null && this.mailStore !== null;
  }

  /** Clear all timers and resolve every pending long poll with []. */
  stop(): void {
    this.stopped = true;
    this.invalidateRecovery();
    for (const timer of this.nudgeTimers.values()) this.clearTimeoutFn(timer);
    this.nudgeTimers.clear();
    for (const waiter of [...this.mailWaiters.values()]) waiter.deliver([]);
    this.mailWaiters.clear();
    this.nativeLeases.clear();
    this.legacyReadyAt.clear();
    this.codexRetryAt.clear();
    this.batchAttempts.clear();
    this.museNativeTried.clear();
    this.lastInjection.clear();
    for (const controller of this.wakeControllers.values()) controller.abort();
    this.wakeControllers.clear();
  }

  private pluginIdentity(session: Session, adapter: NativeWakeRegistration['adapter']): string | undefined {
    if (adapter === 'opencode') return session.shellType === 'opencode' ? session.opencodeSessionId : undefined;
    return ['claude', 'zai', 'kimi', 'deepseek', 'fireworks'].includes(session.shellType ?? 'claude')
      ? session.claudeSessionId : undefined;
  }

  registerNativeWake(session: Session, registration: NativeWakeRegistration): void {
    if (this.stopped || session.status !== 'running' || !this.runner?.isRunning(session.id)
      || this.pluginIdentity(session, registration.adapter) !== registration.nativeSessionId) {
      this.nativeLeases.delete(session.id);
      throw new NativeWakeRegistrationError(409, 'Native wake session identity or running process does not match');
    }
    this.nativeLeases.set(session.id, { ...registration, until: this.now() + NATIVE_WAKE_LEASE_MS });
  }

  private pluginLeaseRemaining(session: Session): number {
    const lease = this.nativeLeases.get(session.id);
    if (!lease) return 0;
    if (session.status !== 'running' || !this.runner?.isRunning(session.id)
      || this.pluginIdentity(session, lease.adapter) !== lease.nativeSessionId || lease.until <= this.now()) {
      this.nativeLeases.delete(session.id);
      return 0;
    }
    return lease.until - this.now();
  }

  private async withSelection<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.selectionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => held);
    this.selectionLocks.set(sessionId, tail);
    await previous;
    try { return await fn(); }
    finally {
      release();
      if (this.selectionLocks.get(sessionId) === tail) this.selectionLocks.delete(sessionId);
    }
  }

  private available(sessionId: string, messages: MailMessage[]): MailMessage[] {
    const claimed = this.codexClaims.get(sessionId);
    return claimed?.size ? messages.filter(message => !claimed.has(message.id)) : messages;
  }

  /** Hook activity (UserPromptSubmit/PreToolUse/PostToolUse): the agent is mid-turn. */
  markAgentBusy(sessionId: string): void {
    this.agentBusySince.set(sessionId, this.now());
  }

  /** Hook Stop: the agent's turn ended (the injection record is kept). */
  markAgentIdle(sessionId: string): void {
    this.agentBusySince.delete(sessionId);
  }

  /** Hook SessionEnd / session removal: forget the injection record. */
  markSessionEnded(sessionId: string): void {
    this.lastInjection.delete(sessionId);
  }

  /** Last bridge-submitted text for a session (PTY nudge or native wake), if any. */
  lastPromptInjection(sessionId: string): { text: string; at: number } | undefined {
    return this.lastInjection.get(sessionId);
  }

  private recordInjection(sessionId: string, text: string): void {
    this.lastInjection.set(sessionId, { text, at: this.now() });
  }

  /** Let the API server record an opencode/claude-mod plugin handoff (mail handed to the plugin). */
  async notePluginHandoff(sessionId: string): Promise<void> {
    this.recordInjection(sessionId, OPENCODE_MAIL_WAKE_TEXT);
    const existingTimer = this.nudgeTimers.get(sessionId);
    if (existingTimer) {
      this.clearTimeoutFn(existingTimer);
      this.nudgeTimers.delete(sessionId);
    }
    this.pendingNudgeFrom.delete(sessionId);
    const mailStore = this.mailStore;
    if (!mailStore) return;
    const token = createNudgeToken(this.now());
    try {
      const snapshot = await mailStore.listUnnudgedWaking(sessionId);
      const undeliveredWaking = this.wakeLocks.has(sessionId)
        ? (await mailStore.listUndelivered(sessionId)).filter((m) => !NON_WAKING_MAIL_TYPES.has(m.type))
        : snapshot;
      const batchIds = Array.from(new Set([...snapshot.map((m) => m.id), ...undeliveredWaking.map((m) => m.id)]));
      if (batchIds.length === 0) return;
      await this.withSelection(sessionId, async () => {
        await mailStore.markNudged(sessionId, batchIds, token);
      });
      const inFlightWake = this.wakeLocks.get(sessionId);
      if (inFlightWake) {
        void inFlightWake
          .then(async () => {
            const retryTimer = this.nudgeTimers.get(sessionId);
            if (retryTimer) {
              this.clearTimeoutFn(retryTimer);
              this.nudgeTimers.delete(sessionId);
            }
            this.pendingNudgeFrom.delete(sessionId);
            await this.withSelection(sessionId, async () => {
              await mailStore.markNudged(sessionId, batchIds, token);
            });
          })
          .catch((err) => {
            console.error('[MailDelivery] Plugin handoff stamp failed:', err instanceof Error ? err.message : String(err));
          });
      }
    } catch (err) {
      console.error('[MailDelivery] Plugin handoff stamp failed:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Whether a UserPromptSubmit hook payload was submitted by ftown itself (bridge or installed plugin).
   * Generic over harnesses: any `prompt` string counts as prompt text. A human typing a marker at
   * the start is treated as injected (accepted false positive); a marker merely contained mid-text is human.
   */
  isInjectedPrompt(sessionId: string, hookData: Record<string, unknown>): boolean {
    const rawPrompt = typeof hookData.prompt === 'string' ? hookData.prompt : '';
    const last = this.lastInjection.get(sessionId);
    if (rawPrompt.trim().length > 0) {
      const trimmed = rawPrompt.trim();
      if (INJECTED_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
      const firstLine = last?.text.split('\n')[0]?.trim() ?? '';
      if (firstLine && trimmed.startsWith(firstLine)) return true;
      return false;
    }
    if (!last) return false;
    // One-shot: the first no-prompt hook consumes the record; the timed rule
    // for hooks carrying text is not consumed.
    if (this.now() - last.at < 15_000) {
      this.lastInjection.delete(sessionId);
      return true;
    }
    return false;
  }

  // Plain shells would execute the message as a command; deliver it as a quoted no-op
  // (`: '...'`) — interactive zsh has no '#' comments by default.
  // origin 'human' deliveries (dashboard-typed text, if any) must not record an injection.
  // Recorded BEFORE the first write: the prompt hook can fire before the settle
  // delays finish, and a stale record after a failed write is acceptable.
  async injectPtyLine(
    session: Session,
    sender: string,
    text: string,
    options?: { origin?: 'injected' | 'human'; onFirstWrite?: () => void },
  ): Promise<boolean> {
    if (this.stopped || !this.runner) return false;
    const epoch = this.dependencyEpoch;
    const isAgent = session.shellType && session.shellType !== 'shell';
    const safeSender = sender.replace(/['\r\n]/g, '');
    const line = isAgent
      ? `${INJECTED_PROMPT_PREFIXES[0]}${safeSender}] ${text}`
      : `: '${INJECTED_PROMPT_PREFIXES[0]}${safeSender}] ${text.replace(/'/g, '')}'`;
    if (options?.origin !== 'human') this.recordInjection(session.id, line);
    if (!this.runner.write(session.id, line)) return false;
    options?.onFirstWrite?.();
    // Composer TUIs detect pastes by input arrival rate; the submit CR must come well
    // after that window or it is treated as a pasted newline.
    await this.delay(COMPOSER_PASTE_SETTLE_MS);
    if (this.stopped || epoch !== this.dependencyEpoch) return false;
    if (!this.runner.write(session.id, submitSuffixFor(session.shellType))) return false;
    if (isAgent) {
      // Retry Enter separately after the same settle window so it cannot become
      // part of the first paste/submit batch.
      await this.delay(COMPOSER_PASTE_SETTLE_MS);
      if (this.stopped || epoch !== this.dependencyEpoch) return false;
      if (!this.runner.write(session.id, submitSuffixFor(session.shellType))) return false;
    }
    return true;
  }

  /**
   * Store incoming mail for a session: validate, append, then either kick the
   * session's long-poll waiter or schedule an idle nudge.
   */
  async acceptMail(session: Session, body: Record<string, unknown>): Promise<AcceptMailResult> {
    if (!this.mailStore) {
      return { ok: false, error: 'Mail store not ready' };
    }

    const text = body.body;
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'Missing body' };
    }
    if (text.length > MAX_MAIL_BODY_LENGTH) {
      return { ok: false, error: `Body too long (max ${MAX_MAIL_BODY_LENGTH} chars)` };
    }

    let type: MailMessage['type'] = 'message';
    if (body.type !== undefined) {
      if (typeof body.type !== 'string' || !MAIL_TYPES.includes(body.type as MailMessage['type'])) {
        return { ok: false, error: `Invalid type (expected one of: ${MAIL_TYPES.join(', ')})` };
      }
      type = body.type as MailMessage['type'];
    }

    const from = typeof body.from === 'string' && body.from.trim() ? body.from.trim() : 'external';
    const fromName =
      typeof body.fromName === 'string' && body.fromName.trim() ? body.fromName.trim() : undefined;
    const threadId =
      typeof body.threadId === 'string' && body.threadId.trim() ? body.threadId.trim() : undefined;

    const msg = createMailMessage({ from, fromName, to: session.id, type, threadId, body: text });
    await this.mailStore.append(msg);
    if (this.eventSink) {
      const sink = this.eventSink;
      try {
        void Promise.resolve(sink.onAccepted(msg, session)).catch((err) => {
          console.error('[MailDelivery] Event sink failed:', err instanceof Error ? err.message : String(err));
        });
      } catch (err) {
        console.error('[MailDelivery] Event sink failed:', err instanceof Error ? err.message : String(err));
      }
    }
    await this.notifyCommittedMail(session, fromName ?? from);
    return { ok: true, id: msg.id };
  }

  /** Wake existing consumers for committed unread mail without appending it again. */
  async notifyCommittedMail(session: Session, sender: string, requireRunning = false): Promise<void> {
    const mailStore = this.mailStore;
    if (!mailStore || this.stopped) return;
    let hadWaiter = false, pending = false;
    await this.withSelection(session.id, async () => {
      if (requireRunning) {
        const current = await this.store?.loadSession(session.id);
        if (!current || current.status !== 'running' || !this.runner?.isRunning(session.id) || this.stopped) return;
        session = current;
      }
      const waiter = this.mailWaiters.get(session.id);
      hadWaiter = !!waiter;
      if (waiter) {
        const undelivered = this.available(session.id, await mailStore.listUndelivered(session.id));
        if (this.mailWaiters.get(session.id) === waiter && undelivered.length > 0) {
          const marked = await mailStore.markDelivered(session.id, undelivered.map(m => m.id), 'poll');
          waiter.deliver(marked);
        }
      }
      pending = (await mailStore.listUnnudgedWaking(session.id)).length > 0;
    });
    if (pending && (!hadWaiter || session.shellType === 'codex') && session.shellType !== 'pi') {
      const legacyDelay = HOOKED_SHELL_TYPES.has(session.shellType ?? 'claude')
        ? MAIL_NUDGE_DELAY_HOOKED_MS : MAIL_NUDGE_DELAY_MS;
      if (!this.pendingNudgeFrom.has(session.id)) this.legacyReadyAt.set(session.id, this.now() + legacyDelay);
      const nudgeDelay = session.shellType === 'codex' || session.shellType === 'muse' ? MAIL_NUDGE_DELAY_MS : legacyDelay;
      this.scheduleMailNudge(session.id, sender, nudgeDelay);
    }
  }

  /**
   * Read a session's inbox: peek, drain, or long poll. A long poll returns a
   * promise that resolves when mail arrives (or the wait elapses) plus an
   * `abandon` callback the caller must invoke if the client disconnects —
   * abandoning never marks messages delivered, so no mail is lost.
   */
  async readMail(
    session: Session,
    query: { wait: number; peek: boolean; all: boolean; limit: number },
  ): Promise<InboxReadResult> {
    const mailStore = this.mailStore;
    if (!mailStore) {
      return { kind: 'immediate', messages: [] };
    }

    const wait = Math.min(query.wait, MAX_MAIL_WAIT_SECONDS);

    if (query.peek) {
      const messages = query.all
        ? await mailStore.listAll(session.id, query.limit)
        : await mailStore.listUndelivered(session.id);
      return { kind: 'immediate', messages };
    }

    // The listen window is earned, not universal: a session with no mail
    // relationships (no parent, no children) gets an
    // instant stop instead of holding its Stop hook open for `wait` seconds.
    // Late mail for everyone is still covered by the idle nudge.
    let effectiveWait = wait;
    if (wait > 0 && !(await this.participatesInMail(session))) {
      effectiveWait = 0;
    }

    return this.withSelection(session.id, async () => {
      const undelivered = this.available(session.id, await mailStore.listUndelivered(session.id));
      // Claimed mail must not hold the queue-triggered hook open.
      if (undelivered.length > 0 || effectiveWait <= 0 || this.codexClaims.has(session.id)) {
        const marked = await mailStore.markDelivered(
          session.id,
          undelivered.map((m) => m.id),
          effectiveWait > 0 ? 'poll' : 'drain',
        );
        return { kind: 'immediate', messages: marked };
      }

      // Long poll: hold until mail arrives or `wait` seconds elapse. One waiter
      // per session — a newer waiter resolves the previous one with [].
      const existing = this.mailWaiters.get(session.id);
      if (existing) existing.deliver([]);

      let settled = false;
      let resolveMessages!: (messages: MailMessage[]) => void;
      const messages = new Promise<MailMessage[]>((resolve) => {
        resolveMessages = resolve;
      });
      const waiter: MailWaiter = {
        deliver: (delivered: MailMessage[]) => {
          if (settled) return;
          settled = true;
          this.clearTimeoutFn(timer);
          if (this.mailWaiters.get(session.id) === waiter) {
            this.mailWaiters.delete(session.id);
          }
          resolveMessages(delivered);
        },
      };
      const timer = this.setTimeoutFn(() => {
        // Guard each async step on settled: once the client disconnects (or a new
        // waiter replaced this one) we must not mark messages delivered — they
        // would be lost without ever reaching a session.
        if (settled || this.mailWaiters.get(session.id) !== waiter) return;
        void this.withSelection(session.id, async () => {
          const pending = this.available(session.id, await mailStore.listUndelivered(session.id));
          if (settled || this.mailWaiters.get(session.id) !== waiter || pending.length === 0) return [] as MailMessage[];
          return mailStore.markDelivered(session.id, pending.map(m => m.id), 'poll');
        }).then(marked => waiter.deliver(marked)).catch(() => waiter.deliver([]));
      }, effectiveWait * 1000);
      this.mailWaiters.set(session.id, waiter);

      const abandon = (): void => {
        if (this.mailWaiters.get(session.id) !== waiter) return;
        settled = true;
        this.clearTimeoutFn(timer);
        this.mailWaiters.delete(session.id);
      };

      return { kind: 'longpoll', messages, abandon };
    });
  }

  /** A session earns the listen window when it has a native persistent listener
   *  (Pi), a parent, children, or prior mail history. */
  async participatesInMail(session: Session): Promise<boolean> {
    if (session.shellType === 'pi') return true;
    if (session.parentSessionId) return true;
    if (!this.store || !this.mailStore) return false;
    const sessions = await this.store.listSessions();
    if (sessions.some((s) => s.parentSessionId === session.id)) return true;
    const history = await this.mailStore.listAll(session.id, 1);
    return history.length > 0;
  }

  // Debounced wake-up for mail that no long-poll consumed: after 5s, if it is still
  // undelivered and the session is running, inject a one-line pointer to the
  // harness mail command. At most one nudge per session per 30s; senders coalesce.
  private scheduleMailNudge(sessionId: string, fromLabel: string, delayMs = MAIL_NUDGE_DELAY_MS): void {
    if (this.stopped) return;
    this.pendingNudgeFrom.set(sessionId, fromLabel);
    if (this.nudgeTimers.has(sessionId)) return;
    const timer = this.setTimeoutFn(() => {
      this.nudgeTimers.delete(sessionId);
      this.fireMailNudge(sessionId).catch((err) => {
        console.error('[MailDelivery] Mail nudge failed:', err instanceof Error ? err.message : String(err));
      });
    }, delayMs);
    timer.unref?.();
    this.nudgeTimers.set(sessionId, timer);
  }

  /** True while the agent is mid-turn (hook activity since the last Stop), up to AGENT_BUSY_STALE_MS. */
  isAgentRecentlyBusy(sessionId: string): boolean {
    const busySince = this.agentBusySince.get(sessionId);
    return busySince !== undefined && this.now() - busySince < AGENT_BUSY_STALE_MS;
  }

  private fireMailNudge(sessionId: string): Promise<void> {
    const epoch = this.dependencyEpoch;
    const previous = this.wakeLocks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => epoch === this.dependencyEpoch ? this.wakeSession(sessionId) : undefined);
    const settled = next.catch(() => undefined);
    this.wakeLocks.set(sessionId, settled);
    void settled.then(() => { if (this.wakeLocks.get(sessionId) === settled) this.wakeLocks.delete(sessionId); });
    return next;
  }

  private async wakeCodex(session: Session, store: MailDeliverySessionStore, mailStore: MailDeliveryMailStore,
    runner: MailDeliveryRunner | null, epoch: number, fromLabel: string): Promise<void> {
    const sessionId = session.id;
    const current = () => !this.stopped && this.dependencyEpoch === epoch && this.mailStore === mailStore;
    const wait = (this.codexRetryAt.get(sessionId) ?? 0) - this.now();
    if (wait > 0) { this.scheduleMailNudge(sessionId, fromLabel, wait); return; }
    if (!runner || !runner.isRunning(sessionId) || session.status !== 'running') {
      const pending = await this.withSelection(sessionId, async () =>
        current() ? this.available(sessionId, await mailStore.listUnnudgedWaking(sessionId)) : [],
      );
      if (!current() || !pending.length) {
        this.pendingNudgeFrom.delete(sessionId);
        this.codexRetryAt.delete(sessionId);
        this.batchAttempts.delete(sessionId);
        return;
      }
      const batchIds = pending.map((m) => m.id);
      const batchKey = batchIds.slice().sort().join(',');
      const prev = this.batchAttempts.get(sessionId);
      const attempts = (prev?.key === batchKey ? prev.count : 0) + 1;
      if (attempts >= MAX_WAKE_ATTEMPTS) {
        const token = createNudgeToken(this.now());
        await this.withSelection(sessionId, async () => {
          if (!current()) return;
          await mailStore.markNudged(sessionId, batchIds, token);
        });
        this.batchAttempts.delete(sessionId);
        this.codexRetryAt.delete(sessionId);
        this.pendingNudgeFrom.delete(sessionId);
      } else {
        this.batchAttempts.set(sessionId, { key: batchKey, count: attempts });
        this.codexRetryAt.set(sessionId, this.now() + MAIL_NUDGE_BUSY_RECHECK_MS);
        this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_BUSY_RECHECK_MS);
      }
      return;
    }
    let claimSet: Set<string> | undefined;
    const batch = await this.withSelection(sessionId, async () => {
      if (!current()) return [];
      const pending = this.available(sessionId, await mailStore.listUnnudgedWaking(sessionId));
      if (!current() || !pending.length) return [];
      claimSet = new Set(pending.map(m => m.id));
      this.codexClaims.set(sessionId, claimSet);
      return pending;
    });
    if (!batch.length || !claimSet) {
      this.pendingNudgeFrom.delete(sessionId);
      this.codexRetryAt.delete(sessionId);
      this.batchAttempts.delete(sessionId);
      return;
    }
    const batchIds = batch.map(m => m.id);
    const batchKey = batchIds.slice().sort().join(',');
    if (!current()) {
      await this.withSelection(sessionId, async () => {
        if (this.codexClaims.get(sessionId) === claimSet) this.codexClaims.delete(sessionId);
      });
      return;
    }
    const identity = nativeIdentity(session);
    const controller = new AbortController();
    this.wakeControllers.set(sessionId, controller);
    let accepted = false;
    try {
      const isCurrent = async () => {
        if (!current() || controller.signal.aborted) return false;
        const live = await store.loadSession(sessionId);
        const pending = await mailStore.listUnnudgedWaking(sessionId);
        const pendingIds = new Set(pending.map(m => m.id));
        return current() && !controller.signal.aborted && !!live && live.status === 'running'
          && live.shellType === 'codex' && nativeIdentity(live) === identity && runner.isRunning(sessionId)
          && this.codexClaims.get(sessionId) === claimSet && batchIds.some(id => pendingIds.has(id));
      };
      const wakeText = batch.map(codexMailText).join('\n\n');
      // Recorded BEFORE the wake call: the prompt hook can fire before it resolves.
      this.recordInjection(sessionId, wakeText);
      const result = await this.nativeWake(session, wakeText, controller.signal, isCurrent)
        .catch(() => ({ status: 'unknown' as const }));
      if (result.status === 'accepted' && current() && !controller.signal.aborted) {
        const token = createNudgeToken(this.now());
        accepted = await this.withSelection(sessionId, async () => {
          if (!current() || controller.signal.aborted || this.codexClaims.get(sessionId) !== claimSet) return false;
          const marked = await mailStore.markDelivered(sessionId, batchIds, 'cli');
          await mailStore.markNudged(sessionId, batchIds, token);
          return marked.length > 0;
        });
      }
    } catch {
      // Mark failures leave the record durable and retry with the same ID.
    } finally {
      if (this.wakeControllers.get(sessionId) === controller) this.wakeControllers.delete(sessionId);
      await this.withSelection(sessionId, async () => {
        if (this.codexClaims.get(sessionId) === claimSet) this.codexClaims.delete(sessionId);
      });
    }
    if (!current()) return;
    if (accepted) {
      this.codexRetryAt.delete(sessionId);
      this.batchAttempts.delete(sessionId);
    } else {
      const prev = this.batchAttempts.get(sessionId);
      const attempts = (prev?.key === batchKey ? prev.count : 0) + 1;
      if (attempts >= MAX_WAKE_ATTEMPTS) {
        const token = createNudgeToken(this.now());
        await this.withSelection(sessionId, async () => {
          if (!current()) return;
          await mailStore.markNudged(sessionId, batchIds, token);
        });
        this.batchAttempts.delete(sessionId);
        this.codexRetryAt.delete(sessionId);
      } else {
        this.batchAttempts.set(sessionId, { key: batchKey, count: attempts });
        this.codexRetryAt.set(sessionId, this.now() + MAIL_NUDGE_BUSY_RECHECK_MS);
      }
    }
    const remaining = await mailStore.listUnnudgedWaking(sessionId);
    if (!current()) return;
    if (remaining.length) {
      this.scheduleMailNudge(sessionId, fromLabel, accepted ? MAIL_NUDGE_DELAY_MS : MAIL_NUDGE_BUSY_RECHECK_MS);
    } else {
      this.pendingNudgeFrom.delete(sessionId);
      this.codexRetryAt.delete(sessionId);
      this.batchAttempts.delete(sessionId);
    }
  }

  private async wakeSession(sessionId: string): Promise<void> {
    const { store, mailStore, runner, dependencyEpoch } = this;
    const current = () => !this.stopped && dependencyEpoch === this.dependencyEpoch;
    if (!current() || !store || !mailStore) return;

    const fromLabel = this.pendingNudgeFrom.get(sessionId) ?? 'ftown';
    const undelivered = await mailStore.listUnnudgedWaking(sessionId);
    if (!current()) return;
    if (undelivered.length === 0) {
      this.pendingNudgeFrom.delete(sessionId);
      this.legacyReadyAt.delete(sessionId);
      this.batchAttempts.delete(sessionId);
      return;
    }
    let session = await store.loadSession(sessionId);
    if (!current()) return;
    if (session?.shellType === 'codex') {
      await this.wakeCodex(session, store, mailStore, runner, dependencyEpoch, fromLabel);
      return;
    }
    if (!session || session.status !== 'running' || session.shellType === 'pi' || !runner || !runner.isRunning(sessionId)) {
      this.nativeLeases.delete(sessionId);
      return;
    }
    const leaseRemaining = this.pluginLeaseRemaining(session);
    if (leaseRemaining > 0) { this.scheduleMailNudge(sessionId, fromLabel, leaseRemaining); return; }
    if (this.isAgentRecentlyBusy(sessionId)) {
      this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_BUSY_RECHECK_MS);
      return;
    }

    let museStamped: { batch: MailMessage[]; batchIds: string[]; token: string } | undefined;
    if (session.shellType === 'muse') {
      // A hook may have drained mail during the session lookup. Never wake for a stale snapshot.
      session = await store.loadSession(sessionId);
      const pending = await mailStore.listUnnudgedWaking(sessionId);
      if (!current() || !pending.length || !session || session.status !== 'running' || !runner.isRunning(sessionId)) return;
      if (session.shellType !== 'muse') { this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_DELAY_MS); return; }
      const batchIds = pending.map((message) => message.id);
      const batchKey = batchIds.slice().sort().join(',');
      if (this.museNativeTried.get(sessionId) !== batchKey) {
        const museToken = createNudgeToken(this.now());
        const stamped = await mailStore.markNudged(sessionId, batchIds, museToken);
        if (!stamped.length) {
          this.pendingNudgeFrom.delete(sessionId);
          return;
        }
        if (!current()) {
          await mailStore.unmarkNudged(sessionId, batchIds, museToken);
          return;
        }
        this.museNativeTried.set(sessionId, batchKey);
        const prev = this.batchAttempts.get(sessionId);
        const museAttempts = (prev?.key === batchKey ? prev.count : 0) + 1;
        this.batchAttempts.set(sessionId, { key: batchKey, count: museAttempts });
        const identity = nativeIdentity(session);
        const controller = new AbortController();
        this.wakeControllers.set(sessionId, controller);
        const isCurrent = async () => {
          if (!current() || controller.signal.aborted) return false;
          const live = await store.loadSession(sessionId);
          const currentPending = await mailStore.listUndelivered(sessionId);
          return current() && !controller.signal.aborted && !!live && live.status === 'running'
            && nativeIdentity(live) === identity && !this.isAgentRecentlyBusy(sessionId)
            && runner.isRunning(sessionId) && currentPending.some(message => batchIds.includes(message.id));
        };
        let result;
        // Recorded BEFORE the wake call: the prompt hook can fire before it resolves.
        this.recordInjection(sessionId, MAIL_WAKE_TEXT);
        try { result = await this.nativeWake(session, MAIL_WAKE_TEXT, controller.signal, isCurrent).catch(() => ({ status: 'unknown' as const })); }
        finally { if (this.wakeControllers.get(sessionId) === controller) this.wakeControllers.delete(sessionId); }
        // Never unstamp after an accepted/unknown native wake, regardless of later busy/isCurrent checks.
        if (result.status === 'accepted' || result.status === 'unknown') {
          this.pendingNudgeFrom.delete(sessionId);
          this.batchAttempts.delete(sessionId);
          return;
        }
        if (museAttempts >= MAX_WAKE_ATTEMPTS) {
          this.pendingNudgeFrom.delete(sessionId);
          this.batchAttempts.delete(sessionId);
          return;
        }
        if (!current() || !(await isCurrent())) {
          await mailStore.unmarkNudged(sessionId, batchIds, museToken);
          if (current() && runner.isRunning(sessionId)) {
            const live = await store.loadSession(sessionId);
            if (current() && live && live.status === 'running' && runner.isRunning(sessionId)) {
              this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_BUSY_RECHECK_MS);
            }
          }
          return;
        }
        museStamped = { batch: stamped, batchIds: stamped.map((m) => m.id), token: museToken };
      }
    }

    const unstampMuse = async () => {
      if (museStamped?.batchIds.length) {
        await mailStore.unmarkNudged(sessionId, museStamped.batchIds, museStamped.token);
      }
    };

    const legacyWait = (this.legacyReadyAt.get(sessionId) ?? 0) - this.now();
    if (legacyWait > 0) { await unstampMuse(); this.scheduleMailNudge(sessionId, fromLabel, legacyWait); return; }

    if (this.isAgentRecentlyBusy(sessionId)) {
      await unstampMuse();
      this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_BUSY_RECHECK_MS);
      return;
    }

    // "Never nudged" must be its own state, not `lastNudgeAt ?? 0` — a clock
    // that starts near zero (tests, or a freshly booted process) would make
    // `now() - 0` look like it's already inside the rate-limit window.
    const lastNudgeAt = this.lastNudgeAt.get(sessionId);
    if (lastNudgeAt !== undefined) {
      const sinceLast = this.now() - lastNudgeAt;
      if (sinceLast < MAIL_NUDGE_MIN_INTERVAL_MS) {
        // Rate-limited: retry once the window reopens (mail may still be unread).
        await unstampMuse();
        this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_MIN_INTERVAL_MS - sinceLast);
        return;
      }
    }

    let digest: string | null = null;
    if (this.digestProvider) {
      try {
        digest = await this.digestProvider.digestFor(sessionId);
      } catch {
        digest = null;
      }
      if (!current()) { await unstampMuse(); return; }
    }

    // Recheck after native probing/rejection and before each legacy side effect.
    let pending: MailMessage[];
    if (museStamped) {
      const stillUndelivered = new Set((await mailStore.listUndelivered(sessionId)).map((m) => m.id));
      pending = museStamped.batch.filter((m) => stillUndelivered.has(m.id));
    } else {
      pending = await mailStore.listUnnudgedWaking(sessionId);
    }
    session = await store.loadSession(sessionId);
    if (!current() || !pending.length || !session || session.status !== 'running' || !runner.isRunning(sessionId)) {
      await unstampMuse();
      return;
    }
    if (session.shellType === 'codex') { await unstampMuse(); this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_DELAY_MS); return; }
    const refreshedLease = this.pluginLeaseRemaining(session);
    if (refreshedLease > 0) { await unstampMuse(); this.scheduleMailNudge(sessionId, fromLabel, refreshedLease); return; }
    if (this.isAgentRecentlyBusy(sessionId)) {
      await unstampMuse();
      this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_BUSY_RECHECK_MS);
      return;
    }

    let activeBatch: MailMessage[];
    let batchIds: string[];
    let token: string;
    if (museStamped) {
      activeBatch = pending;
      batchIds = museStamped.batchIds;
      token = museStamped.token;
    } else {
      token = createNudgeToken(this.now());
      const requestedIds = pending.map((m) => m.id);
      const stamped = await mailStore.markNudged(sessionId, requestedIds, token);
      if (!stamped.length) {
        await mailStore.unmarkNudged(sessionId, requestedIds, token);
        this.pendingNudgeFrom.delete(sessionId);
        return;
      }
      activeBatch = stamped;
      batchIds = stamped.map((m) => m.id);
    }
    if (!current()) {
      await mailStore.unmarkNudged(sessionId, batchIds, token);
      return;
    }

    const batchKey = batchIds.slice().sort().join(',');
    const prev = this.batchAttempts.get(sessionId);
    const attempts = (prev?.key === batchKey ? prev.count : 0) + 1;
    this.batchAttempts.set(sessionId, { key: batchKey, count: attempts });

    const text = sanitizeMessageText(formatNudgeText(countMailTypes(activeBatch), digest));
    let wroteToPty = false;
    const injected = await this.injectPtyLine(session, 'ftown-mail', text, {
      onFirstWrite: () => {
        wroteToPty = true;
      },
    });
    const deliveredToPty = wroteToPty || injected;
    if (!deliveredToPty) {
      if (attempts >= MAX_WAKE_ATTEMPTS) {
        this.batchAttempts.delete(sessionId);
        this.pendingNudgeFrom.delete(sessionId);
        return;
      }
      await mailStore.unmarkNudged(sessionId, batchIds, token);
      if (current()) this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_DELAY_MS);
      return;
    }
    this.batchAttempts.delete(sessionId);
    this.pendingNudgeFrom.delete(sessionId);
    if (current()) {
      this.lastNudgeAt.set(sessionId, this.now());
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeoutFn(resolve, ms));
  }
}
