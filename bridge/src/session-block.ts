/**
 * Records a blocked sub-state when a child hits a harness limit or ends
 * without a result, and tells the parent once per transition.
 */
import { sanitizeAttentionText } from './attention-events.js';
import { detectLimit, stripScreenAnsi, type LimitReason } from './harness-limits.js';
import type { BlockReason, Session, SessionBlock, SessionStatus } from './types.js';
import { AUTOMATION_REMOVED_MESSAGE } from './wire-types.js';

const RING_CHARS = 16_384;
const SCREEN_LINES = 20;
const SCREEN_CHARS = 1500;
const ERROR_CHARS = 2000;
const MAIL_CHARS = 8000;
const ATTENTION_CHARS = 2000;
const BACKOFF_MS = 5000;
/** Failure annotations are transient even if a session never emits again. */
export const BLOCK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function clearSessionBlock(session: Session): void {
  const block = session.block;
  if (!block) return;
  // lastError is written together with the block by this monitor. Keep the
  // terminal status/errorReason itself, which describes process lifecycle.
  delete session.lastError;
  delete session.block;
}

export interface FailureLifecycle {
  kind: 'output' | 'completed' | 'error';
  message?: string;
}

export interface BlockedMailContext {
  id: string;
  name: string;
  reason: BlockReason;
  resetAt?: string;
  exitCode?: number;
  worktree?: string;
  branch?: string;
  pullRequest?: string;
  planItem?: string;
  screenTail: string;
}

export interface SessionFailureDeps {
  loadSession(id: string): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  publishSession(session: Session): Promise<void>;
  withSessionWrite(id: string, task: () => Promise<void>): Promise<void>;
  loadTerminalLog?(id: string): Promise<string>;
  loadActivity?(id: string): Promise<'thinking' | 'tool_use' | 'idle' | 'unknown'>;
  listMail?(sessionId: string): Promise<Array<{ from: string; type: string }>>;
  acceptMail(parent: Session, body: { from: string; fromName?: string; type: 'escalation'; idempotencyKey: string; body: string }): Promise<{ ok: boolean; error?: string }>;
  recordAttention(sessionId: string, input: { title: string; message: string; notificationId: string }): Promise<boolean>;
  now?: () => Date;
  debounceMs?: number;
}

export function transitionKey(reason: BlockReason, resetAt: string | undefined, status: SessionStatus): string {
  return `${reason}|${resetAt ?? ''}|${status}`;
}

export function screenTail(raw: string, maxLines = SCREEN_LINES, maxChars = SCREEN_CHARS): string {
  const lines = stripScreenAnsi(raw)
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

export function parseExitCode(message: string | undefined): number | undefined {
  if (!message) return undefined;
  const match = message.match(/(?:exited|exit) with code (-?\d+)/i);
  if (!match) return undefined;
  const code = Number(match[1]);
  return Number.isInteger(code) ? code : undefined;
}

export function buildBlockedMail(context: BlockedMailContext): string {
  const lines = [
    'Session blocked',
    `id: ${context.id}`,
    `name: ${context.name}`,
    `reason: ${context.reason}`,
  ];
  if (context.resetAt) lines.push(`resetAt: ${context.resetAt}`);
  if (context.exitCode !== undefined) lines.push(`exitCode: ${context.exitCode}`);
  if (context.worktree) lines.push(`worktree: ${context.worktree}`);
  if (context.branch) lines.push(`branch: ${context.branch}`);
  if (context.pullRequest) lines.push(`pullRequest: ${context.pullRequest}`);
  if (context.planItem) lines.push(`planItem: ${context.planItem}`);
  if (context.screenTail) {
    lines.push('screen:');
    lines.push(context.screenTail);
  }
  const body = lines.join('\n');
  return body.length > MAIL_CHARS ? body.slice(0, MAIL_CHARS) : body;
}

export interface ClassifiedFailure {
  /** Leave the stored session alone. */
  action: 'ignore' | 'apply';
  block?: SessionBlock;
  lastError?: string;
  /** Set only when the session status is error. */
  errorReason?: string;
  exitCode?: number;
  notify: boolean;
}

function retirement(message: string | undefined, errorReason: string | undefined): boolean {
  return message === AUTOMATION_REMOVED_MESSAGE || errorReason === AUTOMATION_REMOVED_MESSAGE;
}

function limitReason(reason: LimitReason | BlockReason | undefined): reason is LimitReason {
  return reason === 'usage_limit' || reason === 'rate_limit' || reason === 'auth';
}

function describeLastError(input: {
  reason: BlockReason;
  line?: string;
  message?: string;
  tail: string;
  exitUnavailable: boolean;
}): string {
  let base: string;
  if (input.line && limitReason(input.reason)) {
    base = `${input.reason}: ${input.line}`;
  } else if (input.exitUnavailable) {
    const message = input.message?.trim() || 'process ended';
    base = /exit code unavailable/i.test(message) ? message : `${message} (exit code unavailable)`;
  } else if (input.reason === 'exited' && !input.message?.trim()) {
    base = 'process ended without a result';
  } else if (input.message?.trim()) {
    base = input.message.trim();
  } else {
    base = 'process ended without an exit code';
  }
  const tail = input.tail.trim();
  const text = tail && !base.includes(tail) ? `${base}\n${tail}` : base;
  return sanitizeAttentionText(text, ERROR_CHARS) || 'process ended without an exit code';
}

/**
 * Decide the blocked sub-state for one observation.
 * A completed session that already sent a result is not a failure.
 * A screen match (usage, rate, auth) wins over crashed or exited.
 */
export function classifyFailure(input: {
  session: Session;
  screen: string;
  message?: string;
  hasResult: boolean;
  now: Date;
}): ClassifiedFailure {
  const { session } = input;
  if (retirement(input.message, session.errorReason)) return { action: 'ignore', notify: false };
  const status = session.status;
  if (status === 'completed' && input.hasResult) return { action: 'ignore', notify: false };
  if (status !== 'running' && status !== 'error' && status !== 'completed') return { action: 'ignore', notify: false };

  const hit = detectLimit(session.shellType, input.screen, input.now);
  const ending = status === 'error' || status === 'completed';
  if (status === 'running' && !hit) return { action: 'ignore', notify: false };
  if (!ending && !hit) return { action: 'ignore', notify: false };
  // A shell reaches completed when it is stopped or its command finishes.
  // It never mails a result, so that transition is not a missing report.
  // A limit or auth screen still counts, and status error still counts.
  if (status === 'completed' && session.shellType === 'shell' && !hit) {
    return { action: 'ignore', notify: false };
  }

  const exitUnavailable = Boolean(input.message && /without recording an exit code/i.test(input.message));
  const parsedCode = exitUnavailable ? undefined : parseExitCode(input.message);
  const reason: BlockReason = hit?.reason ?? (status === 'error' ? 'crashed' : 'exited');
  const resetAt = hit?.resetAt;
  const key = transitionKey(reason, resetAt, status);
  const existing = session.block;
  if (existing?.transitionKey === key && existing.notifiedAt) return { action: 'ignore', notify: false };

  const tail = sanitizeAttentionText(screenTail(input.screen), SCREEN_CHARS);
  const storedTail = tail || existing?.screenTail || '';
  const lastError = describeLastError({
    reason,
    line: hit?.line,
    message: input.message,
    tail: storedTail,
    exitUnavailable,
  });
  const block: SessionBlock = {
    reason,
    ...(resetAt ? { resetAt } : {}),
    screenTail: storedTail,
    ...(parsedCode !== undefined ? { exitCode: parsedCode } : {}),
    detectedAt: existing?.transitionKey === key ? existing.detectedAt : input.now.toISOString(),
    transitionKey: key,
  };
  return {
    action: 'apply',
    block,
    lastError,
    ...(status === 'error' ? { errorReason: lastError } : {}),
    ...(parsedCode !== undefined ? { exitCode: parsedCode } : {}),
    notify: true,
  };
}

function combineScreen(log: string, pending: string): string {
  if (!pending) return log.slice(-RING_CHARS);
  if (log.endsWith(pending)) return log.slice(-RING_CHARS);
  return (log + pending).slice(-RING_CHARS);
}

export class SessionFailureMonitor {
  private readonly buffers = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly observed = new Set<string>();
  private readonly debounceMs: number;

  constructor(private readonly deps: SessionFailureDeps) {
    this.debounceMs = deps.debounceMs ?? 200;
  }

  /** Buffer live output and classify once the screen has been quiet. */
  observe(sessionId: string, chunk: string): void {
    if (!chunk) return;
    const next = (this.buffers.get(sessionId) ?? '') + chunk;
    this.buffers.set(sessionId, next.length > RING_CHARS ? next.slice(-RING_CHARS) : next);
    const pending = this.timers.get(sessionId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.evaluate(sessionId, { kind: 'output' }).catch((err) => {
        console.error(`[Bridge] Failed to classify session ${sessionId}:`, err instanceof Error ? err.message : err);
      });
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  /** Run a pending screen classification now. Tests use this. */
  async flush(sessionId: string): Promise<void> {
    const pending = this.timers.get(sessionId);
    if (pending) clearTimeout(pending);
    this.timers.delete(sessionId);
    await this.evaluate(sessionId, { kind: 'output' });
  }

  /** Classify after the terminal status write has been released. */
  async settle(sessionId: string, event: { kind: 'completed' | 'error'; message?: string }): Promise<void> {
    const pending = this.timers.get(sessionId);
    if (pending) clearTimeout(pending);
    this.timers.delete(sessionId);
    await this.evaluate(sessionId, event);
  }

  /** Remove legacy or inactive annotations after their bounded retention. */
  async expire(sessionId: string): Promise<void> {
    await this.deps.withSessionWrite(sessionId, async () => {
      const session = await this.deps.loadSession(sessionId);
      if (!session?.block) return;
      this.observed.add(sessionId);
      const detected = Date.parse(session.block.detectedAt);
      if (Number.isFinite(detected) && this.now().getTime() - detected < BLOCK_RETENTION_MS) return;
      clearSessionBlock(session);
      session.updatedAt = this.now().toISOString();
      await this.deps.saveSession(session);
      await this.deps.publishSession(session);
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async evaluate(sessionId: string, event: FailureLifecycle): Promise<void> {
    await this.deps.withSessionWrite(sessionId, async () => {
      const session = await this.deps.loadSession(sessionId);
      if (!session) return;
      let log = '';
      if (this.deps.loadTerminalLog) {
        try { log = await this.deps.loadTerminalLog(sessionId); } catch { log = ''; }
      }
      const pending = this.buffers.get(sessionId) ?? '';
      // Once classified, old terminal history cannot classify a recovered or
      // dismissed incident again. Each subsequent output batch is fresh.
      const screen = event.kind === 'output' && (this.observed.has(sessionId) || pending)
        ? pending : combineScreen(log, pending);
      if (event.kind === 'output' && pending) {
        this.observed.add(sessionId);
        this.buffers.delete(sessionId);
      }
      if (event.kind === 'output' && pending && session.status === 'running' && this.deps.loadActivity) {
        const activity = await this.deps.loadActivity(sessionId).catch(() => 'unknown' as const);
        if (activity === 'thinking' || activity === 'tool_use') return;
      }
      if (event.kind === 'output' && pending && session.status === 'running' && session.block && screenTail(screen) && !detectLimit(session.shellType, screen, this.now())) {
        clearSessionBlock(session);
        session.updatedAt = this.now().toISOString();
        await this.deps.saveSession(session);
        await this.deps.publishSession(session);
        return;
      }
      const message = event.kind === 'output' ? undefined : event.message ?? session.errorReason;
      const hasResult = session.status === 'completed' || session.status === 'error'
        ? await this.reportedResult(session)
        : false;
      if (session.status === 'completed' && hasResult && session.block) {
        clearSessionBlock(session);
        session.updatedAt = this.now().toISOString();
        await this.deps.saveSession(session);
        await this.deps.publishSession(session);
        return;
      }
      const decision = classifyFailure({ session, screen, message, hasResult, now: this.now() });
      if (decision.action !== 'apply' || !decision.block || !decision.lastError) return;

      session.block = decision.block;
      session.lastError = decision.lastError;
      if (decision.exitCode !== undefined) session.exitCode = decision.exitCode;
      else delete session.exitCode;
      if (session.status === 'error' && decision.errorReason) session.errorReason = decision.errorReason;

      if (decision.notify && !this.backingOff(sessionId)) {
        // The transition key is durable before the external write. If the
        // bridge dies after mail append but before the notifiedAt save, retry
        // with the same idempotency key and the inbox will collapse it.
        session.updatedAt = this.now().toISOString();
        await this.deps.saveSession(session);
        await this.deps.publishSession(session);
        const sent = await this.notify(session, decision.block, decision.lastError);
        if (sent) session.block.notifiedAt = this.now().toISOString();
        else this.backoffUntil.set(sessionId, this.now().getTime() + BACKOFF_MS);
      }

      session.updatedAt = this.now().toISOString();
      await this.deps.saveSession(session);
      await this.deps.publishSession(session);
    });
  }

  private backingOff(sessionId: string): boolean {
    const until = this.backoffUntil.get(sessionId);
    if (until === undefined) return false;
    if (this.now().getTime() >= until) {
      this.backoffUntil.delete(sessionId);
      return false;
    }
    return true;
  }

  private async reportedResult(session: Session): Promise<boolean> {
    const parentId = session.parentSessionId;
    if (!parentId || !this.deps.listMail) return false;
    try {
      const mail = await this.deps.listMail(parentId);
      return mail.some((message) => message.type === 'result' && message.from === session.id);
    } catch {
      return false;
    }
  }

  private async notify(session: Session, block: SessionBlock, _lastError: string): Promise<boolean> {
    const parentId = session.parentSessionId;
    const parent = parentId ? await this.deps.loadSession(parentId) : null;
    const planItem = parent?.plan?.items.find((item) => item.sessionId === session.id);
    const body = buildBlockedMail({
      id: session.id,
      name: session.name,
      reason: block.reason,
      resetAt: block.resetAt,
      exitCode: block.exitCode,
      worktree: session.worktree?.path ?? session.workingDir,
      branch: session.worktree?.branch,
      pullRequest: session.pullRequestUrl,
      planItem: planItem ? `${planItem.id} ${planItem.title}` : undefined,
      screenTail: block.screenTail,
    });
    try {
      if (parent) {
        const accepted = await this.deps.acceptMail(parent, {
          from: session.id,
          fromName: session.name,
          type: 'escalation',
          idempotencyKey: `session-block:${session.id}:${block.transitionKey}`,
          body,
        });
        return accepted.ok;
      }
      const message = sanitizeAttentionText(body, ATTENTION_CHARS);
      return await this.deps.recordAttention(session.id, {
        title: 'Session blocked',
        message: message || 'Session blocked',
        notificationId: `block:${session.id}:${block.transitionKey}`.slice(0, 200),
      });
    } catch (err) {
      console.error(`[Bridge] Failed to report blocked session ${session.id}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }
}
