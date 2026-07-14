import { createMailMessage } from './mail-store.js';
import { HOOKED_SHELL_TYPES } from './harness-registry.js';

import type { MailMessage, Session, ShellType } from './types.js';

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

export const MAIL_TYPES: ReadonlyArray<MailMessage['type']> = ['message', 'task', 'result', 'escalation'];

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

/** The slice of SessionStore the mail engine needs. */
export interface MailDeliverySessionStore {
  loadSession(sessionId: string): Promise<Session | null>;
  listSessions(): Promise<Session[]>;
}

/** The slice of MailStore the mail engine needs. */
export interface MailDeliveryMailStore {
  append(msg: MailMessage): Promise<void>;
  listUndelivered(sessionId: string): Promise<MailMessage[]>;
  listAll(sessionId: string, limit: number): Promise<MailMessage[]>;
  markDelivered(
    sessionId: string,
    ids: string[],
    via: NonNullable<MailMessage['deliveredVia']>,
  ): Promise<MailMessage[]>;
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

  constructor(options: MailDeliveryOptions = {}) {
    this.store = options.store ?? null;
    this.mailStore = options.mailStore ?? null;
    this.runner = options.runner ?? null;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  setStore(store: MailDeliverySessionStore): void {
    this.store = store;
  }

  setMailStore(mailStore: MailDeliveryMailStore): void {
    this.mailStore = mailStore;
  }

  setRunner(runner: MailDeliveryRunner): void {
    this.runner = runner;
  }

  /** Both the session store and the mail store are wired. */
  isReady(): boolean {
    return this.store !== null && this.mailStore !== null;
  }

  /** Clear all timers and resolve every pending long poll with []. */
  stop(): void {
    for (const timer of this.nudgeTimers.values()) this.clearTimeoutFn(timer);
    this.nudgeTimers.clear();
    for (const waiter of [...this.mailWaiters.values()]) waiter.deliver([]);
    this.mailWaiters.clear();
  }

  /** Hook activity (UserPromptSubmit/PreToolUse/PostToolUse): the agent is mid-turn. */
  markAgentBusy(sessionId: string): void {
    this.agentBusySince.set(sessionId, this.now());
  }

  /** Hook Stop/SessionEnd: the agent's turn ended. */
  markAgentIdle(sessionId: string): void {
    this.agentBusySince.delete(sessionId);
  }

  // Plain shells would execute the message as a command; deliver it as a quoted no-op
  // (`: '...'`) — interactive zsh has no '#' comments by default.
  async injectPtyLine(session: Session, sender: string, text: string): Promise<boolean> {
    if (!this.runner) return false;
    const isAgent = session.shellType && session.shellType !== 'shell';
    const line = isAgent
      ? `[ftown msg from ${sender}] ${text}`
      : `: '[ftown msg from ${sender}] ${text.replace(/'/g, '')}'`;
    if (!this.runner.write(session.id, line)) return false;
    // Composer TUIs detect pastes by input arrival rate; the submit CR must come well
    // after that window or it is treated as a pasted newline.
    await this.delay(COMPOSER_PASTE_SETTLE_MS);
    this.runner.write(session.id, submitSuffixFor(session.shellType));
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

    const waiter = this.mailWaiters.get(session.id);
    if (waiter) {
      const undelivered = await this.mailStore.listUndelivered(session.id);
      const marked = await this.mailStore.markDelivered(
        session.id,
        undelivered.map((m) => m.id),
        'poll',
      );
      waiter.deliver(marked);
    } else {
      const nudgeDelay = HOOKED_SHELL_TYPES.has(session.shellType ?? 'claude')
        ? MAIL_NUDGE_DELAY_HOOKED_MS
        : MAIL_NUDGE_DELAY_MS;
      this.scheduleMailNudge(session.id, fromName ?? from, nudgeDelay);
    }

    return { ok: true, id: msg.id };
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
    // relationships (no parent, no children, not an orchestrator) gets an
    // instant stop instead of holding its Stop hook open for `wait` seconds.
    // Late mail for everyone is still covered by the idle nudge.
    let effectiveWait = wait;
    if (wait > 0 && !(await this.participatesInMail(session))) {
      effectiveWait = 0;
    }

    const undelivered = await mailStore.listUndelivered(session.id);
    if (undelivered.length > 0 || effectiveWait <= 0) {
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
      mailStore
        .listUndelivered(session.id)
        .then((pending) => {
          if (settled || pending.length === 0) return [] as MailMessage[];
          return mailStore.markDelivered(session.id, pending.map((m) => m.id), 'poll');
        })
        .then((marked) => waiter.deliver(marked))
        .catch(() => waiter.deliver([]));
    }, effectiveWait * 1000);
    this.mailWaiters.set(session.id, waiter);

    const abandon = (): void => {
      if (this.mailWaiters.get(session.id) !== waiter) return;
      settled = true;
      this.clearTimeoutFn(timer);
      this.mailWaiters.delete(session.id);
    };

    return { kind: 'longpoll', messages, abandon };
  }

  /** A session earns the Stop-hook listen window only if mail can plausibly
   *  arrive: it has a parent, has children, was marked an orchestrator, or has
   *  exchanged mail before. */
  async participatesInMail(session: Session): Promise<boolean> {
    if (session.parentSessionId) return true;
    if (session.env?.FTOWN_ORCHESTRATOR === '1') return true;
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

  private async fireMailNudge(sessionId: string): Promise<void> {
    if (!this.store || !this.mailStore || !this.runner) return;

    const fromLabel = this.pendingNudgeFrom.get(sessionId) ?? 'ftown';
    const undelivered = await this.mailStore.listUndelivered(sessionId);
    if (undelivered.length === 0) {
      this.pendingNudgeFrom.delete(sessionId);
      return;
    }

    const busySince = this.agentBusySince.get(sessionId);
    if (busySince !== undefined && this.now() - busySince < AGENT_BUSY_STALE_MS) {
      this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_BUSY_RECHECK_MS);
      return;
    }

    const sinceLast = this.now() - (this.lastNudgeAt.get(sessionId) ?? 0);
    if (sinceLast < MAIL_NUDGE_MIN_INTERVAL_MS) {
      // Rate-limited: retry once the window reopens (mail may still be unread).
      this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_MIN_INTERVAL_MS - sinceLast);
      return;
    }

    this.pendingNudgeFrom.delete(sessionId);
    if (!this.runner.isRunning(sessionId)) return;
    const session = await this.store.loadSession(sessionId);
    if (!session) return;

    this.lastNudgeAt.set(sessionId, this.now());
    const text = sanitizeMessageText(
      `You have new ftown mail from ${fromLabel} — run \`~/.ftown/bin/ftown-harness mail read\` to read it.`,
    );
    await this.injectPtyLine(session, 'ftown-mail', text);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeoutFn(resolve, ms));
  }
}
