import type { BrowserAccess } from './browser-access.js';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ApplicationJson, BridgeSecurityInfo, EnrollmentPacket, LocalEventPage, SecureEnvelope, VerifiedApplication } from './security/protocol.js';
import { BridgeSecurityService, applicationJson, type LedgerStatus } from './security/bridge/security.js';
import { executeSecurePacket } from './security/bridge/execute.js';
import type { SecureExecutionObserver } from './security/bridge/execution-observer.js';
import { observeHttpDelivery, scopedUpdateObserver } from './update-effects.js';
import { nativeWake } from './security/bridge/native-wake.js';
import { boundedMatchIndexes, GrepBusyError } from './bounded-regex.js';

import type { Server, IncomingMessage, ServerResponse } from 'node:http';

import type { SessionStore } from './session-store.js';
import type { MailStore } from './mail-store.js';
import type { PushNotice } from './push-notifier.js';
import { AttentionStore, AttentionError, type SubagentIdleSignal } from './attention-store.js';
import { sanitizeAttentionText, type AttentionItem } from './attention-events.js';
import { parseAttentionPrompt } from './attention-prompt.js';
import { ATTENTION_ITEM_WAIT_MAX_SECONDS, type AttentionPrompt } from './attention-prompt-protocol.js';
import type { Session } from './types.js';
import { MailDeliveryService, sanitizeMessageText, parseNativeWakeRegistration, NativeWakeRegistrationError, type AcceptMailResult } from './mail-delivery.js';
import type { ProcessRunner } from './claude-runner.js';
import type { CentrifugoClient } from './centrifugo-client.js';
import type { TerminalManager } from './terminal-manager.js';
import { AUTOMATION_REMOVED_CODE, AUTOMATION_REMOVED_MESSAGE, isRetiredAutomationSession } from './retired-automation.js';
import { SessionController } from './session-controller.js';
import {
  registerSessionConversation,
  resolveSessionIdByConversation,
  resolveSessionIdFromHookPayload,
} from './session-registry.js';
import {
  canResumeStoredSession,
  createFtownSession,
  deriveRelaunchCommand,
  InvalidShellTypeError,
  parseCreateSessionBody,
  PlanItemError,
  ProviderAuthMissingError,
  WorkingDirMissingError,
  type CreateFtownSessionDeps,
} from './create-ftown-session.js';
import { removeFtownSession } from './remove-ftown-session.js';
import { collectSessionUsage } from './usage-collector.js';
import { toWireSession } from './session-wire.js';
import { CardValidationError, type CardPatch } from './coordination/contract.js';
import {
  PARENT_UNAVAILABLE_NOTE,
  RouteError,
  WorktreeError,
  type AttentionRoute,
  type RouteContext,
  type RouteModule,
} from './coordination/contract-b.js';
import {
  decideRoute,
  deliverAttentionAnswer,
  formatParentQuestionMail,
  markArchivedWorktreeRetained,
} from './coordination/attention-routing.js';
import { handleBriefRoutes } from './coordination/routes-brief.js';
import { createPlanRoutes } from './coordination/routes-plan.js';
import { createWorktreeRoutes } from './coordination/routes-worktrees.js';
import { createCoordination, rootOf, type Coordination } from './coordination/wiring.js';
import { GitWorktrees } from './worktrees.js';

export interface HookPayload {
  ftown_session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

export interface HookEvent {
  sessionId: string;
  eventName: string;
  data: Record<string, unknown>;
  /** How the session id was attributed; 'workspace' is an untrusted directory fallback. */
  source?: string;
}

interface HookServerEvents {
  event: [HookEvent];
}

interface ApiError {
  error: string;
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

class BadRequestError extends Error {}

/** PLAN_ROUTES paths: /api/sessions/:id/plan and /api/sessions/:id/plan/:itemId. */
function isPlanRoutePath(path: string): boolean {
  return /^\/api\/sessions\/[^/]+\/plan(?:\/[^/]+)?$/.test(path);
}

/**
 * A blocked provider create/revive (mapped flavor with no machine token anywhere)
 * is a client-fixable 422, not a 500. The body carries the provider, the
 * KEY-bearing error message, and the `ftown env set` fix — NEVER a token value.
 */
export function providerAuthMissingResponse(
  err: ProviderAuthMissingError,
): { status: 422; body: { error: string; provider: string; fix: string } } {
  return {
    status: 422,
    body: { error: err.message, provider: err.provider, fix: err.fix },
  };
}

export function workingDirMissingResponse(
  err: WorkingDirMissingError,
): { status: 422; body: { error: string; code: string; workingDir: string; canCreate: boolean } } {
  return {
    status: 422,
    body: {
      error: err.message,
      code: err.code,
      workingDir: err.workingDir,
      canCreate: true,
    },
  };
}

export function archivedSessionWasResumed(
  session: Pick<
    Session,
    | 'shellType'
    | 'claudeSessionId'
    | 'cursorSessionId'
    | 'codexSessionId'
    | 'opencodeSessionId'
    | 'museSessionId'
    | 'grokSessionId'
    | 'antigravitySessionId'
  >,
  isCustomCommand: boolean,
): boolean {
  return !isCustomCommand && canResumeStoredSession(session);
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequestError('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch {
        reject(new BadRequestError('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function constantTimeEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isLoopbackHost(hostHeader: string | undefined, expectedPort: number): boolean {
  if (!hostHeader) return false;
  const match = /^(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/.exec(hostHeader);
  return !!match && (!match[2] || Number(match[2]) === expectedPort);
}

function extractBearer(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const header = req.headers['x-bridge-token'];
  if (typeof header === 'string' && header) return header.trim();
  return null;
}

const MAX_MESSAGE_LENGTH = 2000;
function getQueryInt(url: URL, name: string, defaultValue: number): number {
  const val = url.searchParams.get(name);
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? defaultValue : Math.max(0, parsed);
}

export class LocalApiServer extends EventEmitter<HookServerEvents> {
  private server: Server | null = null;
  private browserAccess: BrowserAccess | null = null;
  private store: SessionStore | null = null;
  private runner: ProcessRunner | null = null;
  private centrifugo: CentrifugoClient | null = null;
  private terminalManager: TerminalManager | null = null;
  private sessionDeps: CreateFtownSessionDeps | null = null;
  private mail: MailDeliveryService = new MailDeliveryService();
  private attention: AttentionStore | null = null;
  private userId: string = '';
  private authToken: string = '';
  private security: BridgeSecurityService | null = null;
  private securityInfo: BridgeSecurityInfo | null = null;
  private secureCommand: ((message: VerifiedApplication) => Promise<ApplicationJson>) | null = null;
  private secureObserver?: SecureExecutionObserver;
  private localEventSequence = 0;
  private localEvents: LocalEventPage['events'] = [];
  private localEventBytes = 0;
  private readonly localEventWaiters = new Set<() => void>();

  setSecurity(security: BridgeSecurityService, info: BridgeSecurityInfo,
    command: (message: VerifiedApplication) => Promise<ApplicationJson>, observer?: SecureExecutionObserver): void {
    this.security = security; this.securityInfo = info; this.secureCommand = command;
    this.secureObserver = observer;
  }
  /** GET /api/security/info: the static info, plus in account mode `ledger: { divergence, serverBehind, removedOnOtherHistory }` (CONTRACT §5: a computer
   *  holding a different account history is shown with a warning). */
  private securityInfoPayload(): BridgeSecurityInfo | (BridgeSecurityInfo & { ledger: Pick<LedgerStatus, 'divergence' | 'serverBehind' | 'removedOnOtherHistory'> }) {
    const info = this.securityInfo!;
    if (!this.security?.options.ledger) return info;
    const status = this.security.ledgerStatus();
    return { ...info, ledger: { divergence: status.divergence, serverBehind: status.serverBehind, removedOnOtherHistory: status.removedOnOtherHistory } };
  }
  recordPublication(channel: string, data: unknown): void {
    const item = { channel, data: applicationJson(data), cursor: ++this.localEventSequence };
    this.localEvents.push(item); this.localEventBytes += Buffer.byteLength(JSON.stringify(item));
    while (this.localEvents.length > 1000 || this.localEventBytes > 2_000_000) {
      const removed = this.localEvents.shift(); if (!removed) break;
      this.localEventBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
    for (const wake of this.localEventWaiters) wake();
  }

  async dispatchSecure(message: VerifiedApplication, clientGone?: AbortSignal): Promise<ApplicationJson> {
    if (!this.security) throw new Error('Security is starting');
    const route = message.application.route;
    if (route.kind === 'command') {
      if (!this.secureCommand) throw new Error('Commands are starting');
      return this.secureCommand(message);
    }
    if (route.kind !== 'http') throw new Error('Invalid application route');
    if ((route.method === 'PUT' || route.method === 'DELETE') && /^\/api\/sessions\/[A-Za-z0-9_-]{1,200}\/preview$/.test(route.path.split('?')[0])
      && message.principal.endpoint.kind !== 'local-cli') return { status: 403, body: { error: 'permission_denied', code: 'permission_denied' } };
    if (route.method === 'GET' && route.path.startsWith('/api/browser/events')) {
      const url = new URL(route.path, 'http://localhost');
      const raw = url.searchParams.get('after') ?? '0';
      if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('Invalid event cursor');
      const after = Number(raw);
      if (after === this.localEventSequence) await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.localEventWaiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, 20000); this.localEventWaiters.add(wake);
      });
      await this.security.revalidate(message.principal);
      let reset = after > this.localEventSequence || after < (this.localEvents[0]?.cursor ?? this.localEventSequence + 1) - 1;
      const events = this.localEvents.filter(event => reset || event.cursor > after);
      const page: LocalEventPage['events'] = [];
      let bytes = 0;
      let cursor = reset ? 0 : after;
      for (const event of events) {
        const size = Buffer.byteLength(JSON.stringify(event));
        if (size > 250000) { cursor = event.cursor; reset = true; continue; }
        if (bytes + size > 250000) break;
        page.push(event); bytes += size; cursor = event.cursor;
      }
      return applicationJson({ events: page, cursor: events.length ? cursor : this.localEventSequence, reset });
    }
    const input = message.application.data as { body?: ApplicationJson; callerSessionId?: string };
    const request = Readable.from([Buffer.from(JSON.stringify(input.body ?? {}), 'utf8')]) as unknown as IncomingMessage;
    request.method = route.method; request.url = route.path; request.headers = {};
    if (input.callerSessionId && message.principal.endpoint.kind === 'local-cli') request.headers['x-ftown-session-id'] = input.callerSessionId;
    // This response adapter is in-process only. It never creates a socket or exports a bearer capability.
    const response = new EventEmitter() as EventEmitter & { statusCode: number; destroyed: boolean; headersSent: boolean;
      writeHead: (status: number) => void; setHeader: () => void; end: (body?: string) => void };
    response.statusCode = 200; response.destroyed = false; response.headersSent = false;
    // When the outer transport goes away before the inner response completes, surface it like a real socket close (once).
    let responseEnded = false;
    const onClientGone = () => {
      if (responseEnded || response.destroyed) return;
      response.destroyed = true; response.emit('close');
    };
    if (clientGone) { if (clientGone.aborted) onClientGone(); else clientGone.addEventListener('abort', onClientGone, { once: true }); }
    const completed = new Promise<ApplicationJson>((resolve, reject) => {
      response.writeHead = status => { response.statusCode = status; response.headersSent = true; };
      response.setHeader = () => undefined;
      response.end = text => {
        responseEnded = true; clientGone?.removeEventListener('abort', onClientGone);
        try {
          const body: ApplicationJson = text ? JSON.parse(text) as ApplicationJson : null;
          if (Buffer.byteLength(text ?? '') > 300000) resolve({ status: 413, body: { error: 'response_too_large', code: 'response_too_large', outcomeUnknown: route.method !== 'GET' } });
          else resolve({ status: response.statusCode, body });
        } catch { reject(new Error('Invalid internal response')); }
      };
    });
    await this.security.revalidate(message.principal);
    void this.handleApiRoute(request, response as unknown as ServerResponse, new URL(route.path, 'http://localhost').pathname,
      new URL(route.path, 'http://localhost')).catch(error => {
        if (error instanceof BadRequestError || error instanceof WorktreeError || error instanceof PlanItemError || error instanceof InvalidShellTypeError) jsonResponse(response as unknown as ServerResponse, 400, { error: error.message });
        else if (error instanceof RouteError) jsonResponse(response as unknown as ServerResponse, error.status, { error: error.message });
        else if (error instanceof AttentionError) jsonResponse(response as unknown as ServerResponse, error.status, { error: error.message, code: error.code });
        else jsonResponse(response as unknown as ServerResponse, 500, { error: 'bridge_error', code: 'bridge_error' });
      });
    return completed;
  }
  private port: number = 0;
  private sessionController: SessionController | null = null;
  private lifecycleController: SessionController | null = null;
  private coordination: Coordination | null = null;
  private defaultCoordination: Coordination | null = null;
  private mailStore: MailStore | null = null;
  private attentionPushHandler?: (sessionId: string, notice: PushNotice) => void;
  /** In-flight parent-routed creates. Pushes are held, then dropped only for that item id. */
  private parentPushAttempt = 0;
  private readonly parentPushAttempts = new Map<string, Set<number>>();
  private readonly heldAttentionPushes: Array<{
    sessionId: string;
    notice: PushNotice;
    owners: Set<number>;
    dropped: boolean;
  }> = [];
  private recoveryEpoch = 0;
  private recoveryStartedAt = -1;
  private recoveryStopped = false;
  private runnerReadyListener: ((sessionId: string) => void) | null = null;
  private readonly worktreeRoutes: RouteModule = createWorktreeRoutes({
    listLive: async () => (this.store ? this.store.listSessions() : []),
    listArchived: async () =>
      this.store
        ? (await this.store.listArchived()).map((record) => {
            const sanitized = { ...record };
            delete sanitized.env;
            delete sanitized.previewSource;
            return sanitized;
          })
        : [],
    worktrees: new GitWorktrees(),
    markRetained: async (sessionId, reason) => {
      if (!this.store) return;
      await markArchivedWorktreeRetained((id) => this.store!.sessionDir(id), sessionId, reason);
    },
  });

  setBrowserAccess(access: BrowserAccess): void {
    this.browserAccess = access;
  }

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  setAttentionStore(store: AttentionStore): void {
    this.attention = store;
    this.defaultCoordination = null;
    // onNotification is a private constructor parameter. It is still an own
    // instance property at runtime; the cast is the only way to wrap it.
    const internal = store as unknown as {
      onNotification?: (sessionId: string, notice: PushNotice) => void;
    };
    const original = internal.onNotification;
    this.attentionPushHandler = original;
    if (original) {
      internal.onNotification = (sessionId: string, notice: PushNotice) => {
        const attempts = this.parentPushAttempts.get(sessionId);
        if (attempts && attempts.size > 0) {
          this.heldAttentionPushes.push({
            sessionId,
            notice,
            owners: new Set(attempts),
            dropped: false,
          });
          return;
        }
        original(sessionId, notice);
      };
    }
  }

  /** Dashboard notice + push for an item that is reaching the human now. */
  publishHumanAttention(sessionId: string, item: AttentionItem): void {
    if (item.type === 'ask_user' || item.prompt?.channel === 'hook') {
      this.emit('event', {
        sessionId,
        eventName: 'PreToolUse',
        source: 'api',
        data: {
          hook_event_name: 'PreToolUse',
          attentionId: item.id,
          attentionSequence: item.sequence,
          attentionCreatedAt: item.createdAt,
          ...(item.prompt ? { attentionPrompt: item.prompt } : {}),
        },
      });
    } else {
      this.emit('event', {
        sessionId,
        eventName: 'Notification',
        source: 'api',
        data: {
          notification_type: 'agent_needs_input',
          title: item.title,
          message: item.message,
          notification_id: item.id,
          attentionId: item.id,
          attentionSequence: item.sequence,
          attentionCreatedAt: item.createdAt,
          ...(item.prompt ? { attentionPrompt: item.prompt } : {}),
        },
      });
    }
    try {
      this.attentionPushHandler?.(sessionId, {
        kind: 'question',
        eventKey: `question:${item.id}`,
        title: item.title,
        message: item.message,
        occurredAt: item.escalatedAt ?? item.createdAt,
      });
    } catch {
      // Optional push delivery cannot fail escalation.
    }
  }

  private readCallerSessionId(req: IncomingMessage): string | undefined {
    const callerHeader = req.headers['x-ftown-session-id'];
    return typeof callerHeader === 'string' && callerHeader.trim()
      ? callerHeader.trim()
      : undefined;
  }

  private readAttentionTarget(body: Record<string, unknown>): 'human' | undefined {
    if (!Object.prototype.hasOwnProperty.call(body, 'to')) return undefined;
    if (body.to === 'human') return 'human';
    throw new BadRequestError("Invalid attention target");
  }

  private async resolveAttentionRouting(
    child: Session,
    to?: 'human',
  ): Promise<{ route: AttentionRoute; parent: Session | null }> {
    if (!this.store || !child.parentSessionId) {
      return { route: 'human', parent: null };
    }
    const parent = await this.store.loadSession(child.parentSessionId);
    const parentRunning =
      !!parent &&
      (typeof this.runner?.isRunning === 'function'
        ? this.runner.isRunning(parent.id)
        : parent.status === 'running');
    const route = decideRoute(child, parent, parentRunning, to);
    return { route, parent };
  }

  /** Hold pushes for this session until the created item id is known. */
  private beginParentPushHold(sessionId: string): number {
    const attempt = ++this.parentPushAttempt;
    let attempts = this.parentPushAttempts.get(sessionId);
    if (!attempts) {
      attempts = new Set();
      this.parentPushAttempts.set(sessionId, attempts);
    }
    attempts.add(attempt);
    return attempt;
  }

  /** Drop only `question:<suppressItemId>`. Every other held notice is delivered. */
  private finishParentPushHold(sessionId: string, attempt: number, suppressItemId?: string): void {
    const attempts = this.parentPushAttempts.get(sessionId);
    attempts?.delete(attempt);
    if (attempts && attempts.size === 0) this.parentPushAttempts.delete(sessionId);
    const suppressKey = suppressItemId ? `question:${suppressItemId}` : undefined;
    for (let index = this.heldAttentionPushes.length - 1; index >= 0; index--) {
      const held = this.heldAttentionPushes[index];
      if (!held.owners.has(attempt)) continue;
      held.owners.delete(attempt);
      if (suppressKey && held.notice.eventKey === suppressKey) held.dropped = true;
      if (held.owners.size === 0) {
        this.heldAttentionPushes.splice(index, 1);
        if (!held.dropped) {
          try { this.attentionPushHandler?.(held.sessionId, held.notice); } catch { /* Optional push delivery cannot fail the request. */ }
        }
      }
    }
  }

  /** Apply a parent route only when the item was just created. Repeats keep their stored route. */
  private async applyParentRoute(
    session: Session,
    item: AttentionItem,
    created: boolean,
    route: AttentionRoute,
    parent: Session | null,
  ): Promise<{ item: AttentionItem; skipNotice: boolean; suppressPushId?: string }> {
    if (created && route === 'parent' && parent && this.attention) {
      const routed = await this.attention.setRoute(session.id, item.id, {
        route: 'parent',
        routedTo: parent.id,
      });
      if (!routed) return { item, skipNotice: false };
      const fallback = await this.sendParentQuestionMail(session, parent, routed);
      // The create push is the parent's to swallow. A mail failure publishes its own.
      return { item: fallback ?? routed, skipNotice: true, suppressPushId: item.id };
    }
    if (!created && item.route === 'parent') return { item, skipNotice: true };
    return { item, skipNotice: false };
  }

  /** Mail the parent. On failure, route the item to the human and publish now. Returns that item. */
  private async sendParentQuestionMail(
    child: Session,
    parent: Session,
    item: AttentionItem,
  ): Promise<AttentionItem | undefined> {
    let failed = false;
    try {
      const accepted = await this.acceptSessionMail(parent, {
        from: child.id,
        fromName: child.name,
        type: 'escalation',
        threadId: item.id,
        body: formatParentQuestionMail(child, item),
      });
      if (!accepted.ok) {
        console.error('[Bridge] Failed to mail parent question:', accepted.error);
        failed = true;
      }
    } catch (err) {
      console.error(
        '[Bridge] Failed to mail parent question:',
        err instanceof Error ? err.message : err,
      );
      failed = true;
    }
    if (!failed || !this.attention) return undefined;
    const updated = await this.attention.setRoute(child.id, item.id, {
      route: 'human',
      escalatedAt: new Date().toISOString(),
      escalationNote: PARENT_UNAVAILABLE_NOTE,
    }, 'parent');
    if (updated && !updated.resolvedAt && updated.route === 'human') {
      this.publishHumanAttention(child.id, updated);
      return updated;
    }
    try {
      return await this.attention.waitForItem(child.id, item.id, 0);
    } catch {
      return item;
    }
  }

  /** Caller must be the child's parent. Returns the parent session, or null after writing 403. */
  private async loadParentCaller(
    req: IncomingMessage,
    res: ServerResponse,
    child: Session,
  ): Promise<Session | null> {
    const caller = this.readCallerSessionId(req);
    if (!this.store || !child.parentSessionId || caller !== child.parentSessionId) {
      jsonResponse(res, 403, { error: 'Only the parent session can do this', code: 'forbidden' });
      return null;
    }
    const parent = await this.store.loadSession(child.parentSessionId);
    if (!parent || parent.id !== child.parentSessionId) {
      jsonResponse(res, 403, { error: 'Only the parent session can do this', code: 'forbidden' });
      return null;
    }
    return parent;
  }

  private async dispatchCoordinationRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    url: URL,
  ): Promise<boolean> {
    if (!this.store) return false;
    const store = this.store;
    let responded = false;
    const ctx: RouteContext = {
      req,
      res,
      method: req.method ?? 'GET',
      path,
      query: url.searchParams,
      callerSessionId: this.readCallerSessionId(req),
      parseBody: () => parseBody(req),
      json: (status, body) => {
        responded = true;
        jsonResponse(res, status, body);
      },
      loadSession: (id) => store.loadSession(id),
      saveSession: (session) => store.saveSession(session),
      publishSession: (session) => {
        if (this.centrifugo && this.userId) {
          void this.centrifugo.publishSessionUpdate(this.userId, session);
        }
      },
    };
    try {
      if (await handleBriefRoutes(ctx)) return true;
      if (isPlanRoutePath(path)) {
        const plan = this.getCoordination()?.plan;
        if (plan && await createPlanRoutes(plan)(ctx)) return true;
      }
      if (await this.worktreeRoutes(ctx)) return true;
      return false;
    } catch (error) {
      if (error instanceof RouteError) {
        if (!responded && !res.headersSent) ctx.json(error.status, { error: error.message });
        return true;
      }
      throw error;
    }
  }

  private async handleParentAttentionAction(
    req: IncomingMessage,
    res: ServerResponse,
    childId: string,
    eventId: string,
    action: 'answer' | 'escalate',
  ): Promise<void> {
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { error: 'Method not allowed' });
      return;
    }
    if (!this.store) {
      jsonResponse(res, 503, { error: 'Server not ready' });
      return;
    }
    const child = await this.store.loadSession(childId);
    if (!child) {
      jsonResponse(res, 404, { error: 'Session not found', code: 'unknown_session' });
      return;
    }
    if (!this.attention) {
      jsonResponse(res, 503, { error: 'Attention store not ready', code: 'attention_not_ready' });
      return;
    }
    const parent = await this.loadParentCaller(req, res, child);
    if (!parent) return;
    if (action === 'answer') {
      const body = await parseBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => key !== 'answers')) {
        throw new BadRequestError('Invalid attention answer');
      }
      const { item, waiterLive } = await this.attention.answer(
        child.id,
        eventId,
        body.answers,
        undefined,
        { kind: 'session', sessionId: parent.id, name: parent.name },
      );
      await deliverAttentionAnswer({
        child,
        item,
        waiterLive,
        sender: { from: parent.id, fromName: parent.name },
        acceptMail: (session, mailBody) => this.acceptSessionMail(session, mailBody),
      });
      jsonResponse(res, 200, { event: item });
      return;
    }
    const body = await parseBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => key !== 'note')) {
      throw new BadRequestError('Invalid escalation');
    }
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) {
      throw new BadRequestError('Invalid escalation note');
    }
    const current = await this.attention.waitForItem(child.id, eventId, 0);
    if (current.resolvedAt || current.route !== 'parent') {
      jsonResponse(res, 409, { error: 'Attention request is already with the human', code: 'attention_conflict' });
      return;
    }
    const updated = await this.attention.setRoute(child.id, eventId, {
      route: 'human',
      escalatedAt: new Date().toISOString(),
      ...(typeof body.note === 'string' ? { escalationNote: body.note } : {}),
    }, 'parent');
    if (!updated || updated.resolvedAt || updated.route !== 'human') {
      jsonResponse(res, 409, { error: 'Attention request is already with the human', code: 'attention_conflict' });
      return;
    }
    this.publishHumanAttention(child.id, updated);
    jsonResponse(res, 200, { event: updated });
  }

  setCoordination(coordination: Coordination): void {
    this.coordination = coordination;
    this.defaultCoordination = null;
    if (typeof this.mail.setDigestProvider === 'function') {
      this.mail.setDigestProvider(coordination.digest);
    }
    if (typeof this.mail.setEventSink === 'function') {
      this.mail.setEventSink(coordination.mailSink);
    }
  }

  private getCoordination(): Coordination | null {
    if (this.coordination) return this.coordination;
    if (this.defaultCoordination) return this.defaultCoordination;
    const store = this.store;
    if (!store) return null;
    this.defaultCoordination = createCoordination({
      store,
      attention: {
        list: async (id) =>
          this.attention
            ? this.attention.list(id)
            : { activity: { state: 'unknown' }, openCount: 0 },
        listRouted: async (childId) =>
          this.attention ? this.attention.listRouted(childId) : [],
        setRoute: async (sessionId, eventId, fields, expectRoute) =>
          this.attention ? this.attention.setRoute(sessionId, eventId, fields, expectRoute) : undefined,
      },
      prStatus: async () => null,
      mail: {
        unreadCount: async (id) => {
          const ms = this.mailStore;
          if (!ms) return 0;
          if (typeof ms.unreadCount === 'function') return ms.unreadCount(id);
          return (await ms.listUndelivered(id)).length;
        },
      },
      publishSession: (session) => {
        if (this.centrifugo && this.userId) {
          void this.centrifugo.publishSessionUpdate(this.userId, session);
        }
      },
      now: Date.now,
      onAttentionEscalated: (sessionId, item) => {
        this.publishHumanAttention(sessionId, item);
      },
    });
    return this.defaultCoordination;
  }

  /** Internal producer hook for mail already committed to the inbox. */
  async notifyCommittedMail(session: Session, sender: string, requireRunning = false): Promise<void> {
    await this.mail.notifyCommittedMail(session, sender, requireRunning);
  }

  setMailStore(mailStore: MailStore): void {
    if (this.mailStore !== mailStore) this.recoveryEpoch++;
    this.mailStore = mailStore;
    this.defaultCoordination = null;
    this.mail.setMailStore(mailStore);
    this.startMailRecovery();
  }

  enqueuePreviewChat(session: Session, text: string) {
    return this.mail.acceptMail(session, { body: text, from: 'preview', fromName: 'Preview conversation' });
  }

  setDependencies(
    store: SessionStore,
    runner: ProcessRunner,
    centrifugo: CentrifugoClient,
    userId: string,
    terminalManager?: TerminalManager,
  ): void {
    const changed = this.store !== store || this.runner !== runner;
    if (this.runnerReadyListener) this.runner?.off?.('ready', this.runnerReadyListener);
    if (changed) this.recoveryEpoch++;
    this.store = store;
    this.runner = runner;
    this.centrifugo = centrifugo;
    this.userId = userId;
    this.terminalManager = terminalManager ?? null;
    this.mail.setStore(store);
    this.mail.setRunner(runner);
    this.bindMailRecovery();
    this.startMailRecovery();
    this.invalidateControllers();
  }

  private bindMailRecovery(): void {
    if (this.recoveryStopped || !this.runner) return;
    const runner = this.runner;
    // Read the current epoch at dispatch: setting the mail store also changes it.
    this.runnerReadyListener = (id) => {
      const epoch = this.recoveryEpoch;
      if (this.recoveryStopped || this.runner !== runner || !this.mailStore) return;
      void this.recoverMail(id, epoch);
    };
    runner.on?.('ready', this.runnerReadyListener);
  }

  private async recoverMail(id: string, epoch: number): Promise<void> {
    if (this.recoveryStopped || this.recoveryEpoch !== epoch) return;
    try { await this.mail.recoverPendingMail(id); }
    catch (error) {
      console.error('[LocalApiServer] Mail recovery failed:', error instanceof Error ? error.message : String(error));
    }
  }

  private startMailRecovery(): void {
    const { store, runner, recoveryEpoch: epoch } = this;
    if (this.recoveryStopped || !store || !runner || !this.mailStore || this.recoveryStartedAt === epoch) return;
    this.recoveryStartedAt = epoch;
    void (async () => {
      const sessions = await store.listSessions();
      for (const session of sessions) {
        if (this.recoveryStopped || this.recoveryEpoch !== epoch) return;
        if (session.status === 'running' && runner.isRunning(session.id)) await this.recoverMail(session.id, epoch);
      }
    })().catch((error) => {
      console.error('[LocalApiServer] Initial mail recovery failed:', error instanceof Error ? error.message : String(error));
    });
  }

  setSessionFactory(deps: CreateFtownSessionDeps): void {
    this.sessionDeps = deps;
    this.invalidateControllers();
  }

  /** Controllers are lazy snapshots of the injected deps; rebuild on re-wiring. */
  private invalidateControllers(): void {
    this.sessionController = null;
    this.lifecycleController = null;
    this.defaultCoordination = null;
  }

  /** Transport-agnostic session operations (shared with the RPC switch). */
  setSessionController(controller: SessionController): void {
    this.sessionController = controller;
    this.lifecycleController = controller;
  }

  private getSessionController(): SessionController | null {
    if (this.sessionController) return this.sessionController;
    const { store, runner, centrifugo, userId } = this;
    if (!store || !runner || !centrifugo || !userId) return null;
    this.sessionController = new SessionController({
      store,
      runner,
      publishSessionUpdate: (session) => centrifugo.publishSessionUpdate(userId, session),
      removeSession: (id, options) =>
        removeFtownSession({ store, runner, centrifugo, userId }, id, options),
      collectUsage: (session) => collectSessionUsage(session),
      onSessionEnding: async (session) => {
        const coordination = this.getCoordination();
        if (coordination) await coordination.onSessionExit(session.id, session);
      },
      ...(this.sessionDeps ? { sessionFactory: this.sessionDeps } : {}),
    });
    return this.sessionController;
  }

  async start(preferredPort = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && preferredPort !== 0 && !this.server) {
          preferredPort = 0;
          server.listen(0, '127.0.0.1');
          return;
        }
        reject(err);
      });

      server.once('listening', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        this.server = server;
        this.port = address.port;
        console.log(`[LocalApiServer] Listening on port ${address.port}`);
        resolve(address.port);
      });
      server.listen(preferredPort, '127.0.0.1');
    });
  }

  /**
   * The underlying loopback http.Server, for attaching a WebSocket upgrade
   * handler (loopback WS rung). Null until `start()` resolves. The HTTP request
   * handler keeps its own loopback-only guard; upgrade guarding is the caller's.
   */
  getHttpServer(): Server | null {
    return this.server;
  }

  stop(): void {
    for (const wake of this.localEventWaiters) wake();
    this.recoveryStopped = true;
    this.recoveryEpoch++;
    if (this.runnerReadyListener) this.runner?.off?.('ready', this.runnerReadyListener);
    this.runnerReadyListener = null;
    this.browserAccess?.close();
    this.mail.stop();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!isLoopbackHost(req.headers.host, this.port)) {
      jsonResponse(res, 421, { error: 'Misdirected request' });
      return;
    }

    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${req.headers.host}`); }
    catch { jsonResponse(res, 400, { error: 'Invalid request URL' }); return; }
    const path = url.pathname;
    const securityOrigin = req.headers.origin;
    if (path.startsWith('/api/security/')) {
      if (securityOrigin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(securityOrigin)
        && securityOrigin !== this.security?.options.browserOrigin) { jsonResponse(res, 403, { error: 'Forbidden origin' }); return; }
      if (securityOrigin) {
        res.setHeader('Access-Control-Allow-Origin', securityOrigin); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (!this.security || !this.securityInfo) { jsonResponse(res, 503, { error: 'security_setup_required', code: 'security_setup_required' }); return; }
      if (path === '/api/security/info' && req.method === 'GET') { jsonResponse(res, 200, this.securityInfoPayload()); return; }
      if (req.method === 'POST' && (path === '/api/security/envelope' || path === '/api/security/events')) {
        const security = this.security;
        void parseBody(req).then(async body => {
          if (Buffer.byteLength(JSON.stringify(body)) > 450000) throw new Error('Packet too large');
          const events = path === '/api/security/events';
          const packet = body as unknown as SecureEnvelope | EnrollmentPacket;
          const observer = scopedUpdateObserver(this.secureObserver);
          const envelope = packet.type === 'ftown_enrollment' ? packet.envelope : packet;
          const delivery = observeHttpDelivery(res, observer, envelope?.messageId ?? '');
          let result: SecureEnvelope;
          // Propagate a mid-request client disconnect to the inner in-process request (long-polls must stop being "live").
          const clientGone = new AbortController();
          res.once('close', () => { if (!res.writableEnded) clientGone.abort(); });
          try { result = await executeSecurePacket(security, packet, { transport: events ? 'local-events' : 'local-http',
            channel: `${events ? 'local-events' : 'local-http'}:${security.bridgeId}`, bridgeId: security.bridgeId, pairId: null }, async message => {
              if (events && (message.application.route.kind !== 'http' || message.application.route.method !== 'GET'
                || !message.application.route.path.startsWith('/api/browser/events?'))) throw new Error('Invalid event route');
              return this.dispatchSecure(message, clientGone.signal);
            }, undefined, observer); } catch (error) { delivery(false); throw error; }
          delivery(true);
          if (!res.destroyed) jsonResponse(res, 200, result);
        }).catch(() => { if (!res.headersSent) jsonResponse(res, 400, { error: 'invalid_envelope', code: 'invalid_envelope' }); });
        return;
      }
      jsonResponse(res, 404, { error: 'Not found' }); return;
    }
    if (path === '/hook' && req.method === 'POST') {
      const presented = extractBearer(req);
      if (!presented || !this.authToken || !constantTimeEq(presented, this.authToken) || securityOrigin) {
        jsonResponse(res, 401, { error: 'Unauthorized' }); return;
      }
      void this.handleHook(req, res); return;
    }
    // Raw bearer application/browser APIs are retired, including old local pairing capabilities.
    jsonResponse(res, 426, { error: 'upgrade_required', code: 'upgrade_required' }); return;
  }

  private async handleApiRoute(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    url: URL,
  ): Promise<void> {
    if (path === '/api/loops' || path.startsWith('/api/loops/')) {
      jsonResponse(res, 410, { code: AUTOMATION_REMOVED_CODE, error: AUTOMATION_REMOVED_MESSAGE });
      return;
    }

    if (!this.store) {
      jsonResponse(res, 503, { error: 'Server not ready' });
      return;
    }

    // GET /api/sessions
    if (path === '/api/sessions' && req.method === 'GET') {
      const sessions = await (this.getSessionController()?.list() ?? this.store.listSessions());
      jsonResponse(res, 200, { sessions: sessions.map(toWireSession) });
      return;
    }

    // POST /api/sessions — create a new agent session (same as UI create_session)
    if (path === '/api/sessions' && req.method === 'POST') {
      if (!this.sessionDeps) {
        jsonResponse(res, 503, { error: 'Session factory not ready' });
        return;
      }

      const body = await parseBody(req);
      const callerHeader = req.headers['x-ftown-session-id'];
      const callerSessionId =
        typeof callerHeader === 'string' && callerHeader.trim()
          ? callerHeader.trim()
          : undefined;

      const useCallerAsParent = body.parentSessionId === true || body.parentSessionId === 'caller';
      if (useCallerAsParent) {
        delete body.parentSessionId;
      }

      // Harness selection and parent assignment are intentionally independent.
      // Any in-session client may omit shellType to inherit its own harness,
      // while an explicit shellType (or custom command) always wins.
      if (!body.shellType && !body.command && callerSessionId) {
        const caller = await this.store.loadSession(callerSessionId);
        if (caller?.shellType) body.shellType = caller.shellType;
      }

      let input: ReturnType<typeof parseCreateSessionBody>;
      try {
        input = parseCreateSessionBody(
          body,
          useCallerAsParent ? callerSessionId : undefined,
        );
      } catch (err) {
        if (err instanceof WorktreeError || err instanceof PlanItemError || err instanceof InvalidShellTypeError) {
          jsonResponse(res, 400, { error: err.message });
          return;
        }
        throw err;
      }

      if (!input.command && !input.shellType && !input.prompt) {
        jsonResponse(res, 400, {
          error: 'Provide shellType, prompt, and/or command',
        });
        return;
      }

      const controller = this.getSessionController();
      if (!controller) {
        jsonResponse(res, 503, { error: 'Session factory not ready' });
        return;
      }

      try {
        const session = await controller.create(input);
        jsonResponse(res, 201, { session: toWireSession(session) });
      } catch (err) {
        if (err instanceof WorktreeError || err instanceof PlanItemError || err instanceof InvalidShellTypeError) {
          jsonResponse(res, 400, { error: err.message });
          return;
        }
        if (err instanceof ProviderAuthMissingError) {
          const r = providerAuthMissingResponse(err);
          jsonResponse(res, r.status, r.body);
          return;
        }
        if (err instanceof WorkingDirMissingError) {
          const r = workingDirMissingResponse(err);
          jsonResponse(res, r.status, r.body);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        const status = message === 'Parent session not found' ? 400 : 500;
        jsonResponse(res, status, { error: message });
      }
      return;
    }

    // GET /api/archive — tombstones of removed sessions, newest last.
    // env is stripped: it can carry API keys and only revive (server-side)
    // needs it.
    if (path === '/api/archive' && req.method === 'GET') {
      const archived = (await this.store.listArchived()).map((record) => {
        const sanitized = { ...record };
        delete sanitized.env;
        delete sanitized.previewSource;
        return sanitized;
      });
      jsonResponse(res, 200, { archived });
      return;
    }

    // GET /api/inbox/resolve?conversation=<id> — ftown session id for an agent
    // conversation id (fallback for hooks missing FTOWN_SESSION_ID).
    if (path === '/api/inbox/resolve' && req.method === 'GET') {
      const conversation = url.searchParams.get('conversation');
      if (!conversation) {
        jsonResponse(res, 400, { error: 'Missing conversation' });
        return;
      }
      const sessionId = resolveSessionIdByConversation(conversation);
      if (!sessionId) {
        jsonResponse(res, 404, { error: 'Unknown conversation' });
        return;
      }
      jsonResponse(res, 200, { sessionId });
      return;
    }

    if (await this.dispatchCoordinationRoutes(req, res, path, url)) return;

    const parentAttentionMatch = path.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/attention\/([A-Za-z0-9_-]{1,100})\/(answer|escalate)$/);
    if (parentAttentionMatch) {
      await this.handleParentAttentionAction(
        req,
        res,
        parentAttentionMatch[1],
        parentAttentionMatch[2],
        parentAttentionMatch[3] as 'answer' | 'escalate',
      );
      return;
    }

    const attentionMatch = path.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/attention(?:\/([A-Za-z0-9_-]+))?$/);
    if (attentionMatch) {
      const id = attentionMatch[1];
      const session = await this.store.loadSession(id);
      if (!session) { jsonResponse(res, 404, { error: 'Session not found', code: 'unknown_session' }); return; }
      if (!this.attention) { jsonResponse(res, 503, { error: 'Attention store not ready', code: 'attention_not_ready' }); return; }
      const attentionSub = attentionMatch[2];
      const attentionAction = attentionSub === 'ack' || attentionSub === 'resolve' ? attentionSub : undefined;
      if (attentionSub === 'routed') {
        if (req.method !== 'GET') { jsonResponse(res, 405, { error: 'Method not allowed' }); return; }
        const caller = this.readCallerSessionId(req);
        if (caller !== id) {
          jsonResponse(res, 403, { error: 'Only the parent session can do this', code: 'forbidden' });
          return;
        }
        const sessions = await this.store.listSessions();
        const items: Array<{ sessionId: string; sessionName: string; event: AttentionItem }> = [];
        for (const child of sessions) {
          if (child.parentSessionId !== id || child.id === id) continue;
          const routed = await this.attention.listRouted(child.id);
          for (const event of routed) items.push({ sessionId: child.id, sessionName: child.name, event });
        }
        jsonResponse(res, 200, { items });
        return;
      }
      if (attentionSub === 'ask') {
        if (req.method !== 'POST') { jsonResponse(res, 405, { error: 'Method not allowed' }); return; }
        if (session.status !== 'running' && session.status !== 'pending') {
          jsonResponse(res, 409, { error: 'Session is not active', code: 'session_not_active' }); return;
        }
        const body = await parseBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some((key) => !['toolName', 'toolUseId', 'toolInput', 'to'].includes(key))) throw new BadRequestError('Invalid ask arguments');
        if (typeof body.toolName !== 'string' || !body.toolName.trim() || body.toolName.length > 200) throw new BadRequestError('Invalid toolName');
        if (typeof body.toolUseId !== 'string' || !body.toolUseId.trim() || body.toolUseId.length > 200) throw new BadRequestError('Invalid toolUseId');
        const to = this.readAttentionTarget(body);
        const { route, parent } = await this.resolveAttentionRouting(session, to);
        const toolData = { tool_name: body.toolName, tool_use_id: body.toolUseId, tool_input: body.toolInput };
        const hold = route === 'parent' ? this.beginParentPushHold(id) : undefined;
        let suppressItemId: string | undefined;
        try {
          const { item, created } = await this.attention!.recordDetailed(id, 'PreToolUse', toolData);
          // When ftown's ordinary (async) PreToolUse hook is missing or late, this is the only signal the UI gets.
          // Same stamped payload as /hook; deduped asks publish nothing, and the agent is not marked busy.
          // Only a newly created parent-routed item skips that notice and the push.
          let responseItem = item;
          if (item && created) {
            const applied = await this.applyParentRoute(session, item, created, route, parent);
            responseItem = applied.item;
            suppressItemId = applied.suppressPushId;
            if (!applied.skipNotice) {
              this.emit('event', { sessionId: id, eventName: 'PreToolUse', source: 'api', data: {
                hook_event_name: 'PreToolUse', ...toolData,
                attentionId: applied.item.id, attentionSequence: applied.item.sequence, attentionCreatedAt: applied.item.createdAt,
              } } as HookEvent);
            }
            if (session.parentSessionId) {
              await this.getCoordination()?.emit(session, 'attention', applied.item.title, applied.item.id);
            }
          }
          jsonResponse(res, 200, { event: responseItem && responseItem.prompt ? responseItem : null });
        } finally {
          if (hold !== undefined) this.finishParentPushHold(id, hold, suppressItemId);
        }
        return;
      }
      if (attentionSub && !attentionAction) {
        if (req.method !== 'GET') { jsonResponse(res, 405, { error: 'Method not allowed' }); return; }
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(attentionSub)) throw new BadRequestError('Invalid attention id');
        const raw = url.searchParams.get('waitSeconds');
        if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) > ATTENTION_ITEM_WAIT_MAX_SECONDS)) throw new BadRequestError('Invalid waitSeconds');
        const waitSeconds = raw === null ? 0 : Number(raw);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.on('close', cancel);
        if (res.destroyed) controller.abort();
        try {
          const item = await this.attention.waitForItem(id, attentionSub, waitSeconds * 1000, controller.signal);
          if (!res.destroyed) jsonResponse(res, 200, { event: item });
        } finally { res.off('close', cancel); }
        return;
      }
      if (!attentionSub && req.method === 'POST') {
        if (session.status !== 'running' && session.status !== 'pending') {
          jsonResponse(res, 409, { error: 'Session is not active', code: 'session_not_active' }); return;
        }
        const body = await parseBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some((key) => !['title', 'message', 'questions', 'to'].includes(key))) throw new BadRequestError('Invalid attention arguments');
        if (typeof body.message !== 'string' || !body.message.trim() || body.message.trim().length > 2000) throw new BadRequestError('Invalid attention message');
        if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 200)) throw new BadRequestError('Invalid attention title');
        const to = this.readAttentionTarget(body);
        const title = sanitizeAttentionText(typeof body.title === 'string' ? body.title : 'Session needs your input', 200);
        const message = sanitizeAttentionText(body.message, 2000);
        if (!title || !message) throw new BadRequestError('Attention text must not be empty');
        let prompt: AttentionPrompt | undefined;
        if (body.questions !== undefined) {
          const parsed = parseAttentionPrompt(body.questions, 'mail');
          if (!parsed.ok) { jsonResponse(res, 400, { error: parsed.error, code: 'invalid_prompt' }); return; }
          prompt = parsed.value;
        }
        const { route, parent } = await this.resolveAttentionRouting(session, to);
        const hold = route === 'parent' ? this.beginParentPushHold(id) : undefined;
        let suppressItemId: string | undefined;
        try {
          const event = await this.attention!.record(id, 'Notification', { notification_type: 'agent_needs_input', title, message }, prompt ? { prompt } : undefined);
          if (!event) throw new AttentionError('attention_storage_error', 'Attention history could not be persisted', 500);
          // record() only reports the item. A newly created row starts at one occurrence;
          // a repeat increments it and must keep the route it already has.
          const applied = await this.applyParentRoute(session, event, event.occurrences === 1, route, parent);
          suppressItemId = applied.suppressPushId;
          // Durable commit precedes publication; the live stream carries only
          // the sanitized request and its exact committed record identifier.
          // A new parent-routed item skips the dashboard notice. A repeat keeps
          // its stored route, so a human-routed repeat still publishes.
          if (!applied.skipNotice) {
            this.emit('event', { sessionId: id, eventName: 'Notification', source: 'api', data: {
              notification_type: 'agent_needs_input', title: applied.item.title, message: applied.item.message, notification_id: applied.item.id,
              attentionId: applied.item.id, attentionSequence: applied.item.sequence, attentionCreatedAt: applied.item.createdAt,
              ...(applied.item.prompt ? { attentionPrompt: applied.item.prompt } : {}),
            } });
          }
          if (session.parentSessionId) {
            await this.getCoordination()?.emit(session, 'attention', applied.item.title, applied.item.id);
          }
          jsonResponse(res, 200, { event: applied.item });
        } finally {
          if (hold !== undefined) this.finishParentPushHold(id, hold, suppressItemId);
        }
        return;
      }
      if (!attentionSub && req.method === 'GET') {
        const integer = (name: string, fallback: number, maximum: number) => {
          const raw = url.searchParams.get(name);
          if (raw === null) return fallback;
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) throw new BadRequestError(`Invalid ${name}`);
          return Number(raw);
        };
        const limit = integer('limit', 50, 100);
        if (limit < 1) throw new BadRequestError('Invalid limit');
        const waitSeconds = integer('waitSeconds', 0, 25);
        const includeResolved = url.searchParams.get('includeResolved');
        const actionableOnly = url.searchParams.get('actionableOnly');
        if ((includeResolved !== null && !['true', 'false'].includes(includeResolved)) || (actionableOnly !== null && !['true', 'false'].includes(actionableOnly))) throw new BadRequestError('Invalid attention filter');
        const options = { cursor: url.searchParams.get('cursor') ?? undefined, limit, includeResolved: includeResolved === 'true', actionableOnly: actionableOnly === 'true' };
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.on('close', cancel);
        if (res.destroyed) controller.abort();
        try {
          const page = waitSeconds ? await this.attention.wait(id, options, waitSeconds, controller.signal) : await this.attention.list(id, options);
          if (!res.destroyed) {
            // Removal during a wait is an unknown session, never an empty recovered inbox.
            if (!await this.store.loadSession(id)) { jsonResponse(res, 404, { error: 'Session not found', code: 'unknown_session' }); return; }
            jsonResponse(res, 200, page);
          }
        } finally { res.off('close', cancel); }
        return;
      }
      if (attentionAction && req.method === 'POST') {
        const body = await parseBody(req);
        const ids = body.eventIds;
        if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))) throw new BadRequestError('Invalid attention IDs');
        if (Object.keys(body).some((key) => !['eventIds', ...(attentionAction === 'resolve' ? ['reason'] : [])].includes(key))) throw new BadRequestError('Unknown attention argument');
        if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) throw new BadRequestError('Invalid resolution reason');
        jsonResponse(res, 200, { events: await this.attention.mutate(id, ids as string[], attentionAction, body.reason as string | undefined) });
        return;
      }
      jsonResponse(res, 405, { error: 'Method not allowed' }); return;
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    const sessionReviveMatch = path.match(/^\/api\/sessions\/([^/]+)\/revive$/);
    const sessionScreenMatch = path.match(/^\/api\/sessions\/([^/]+)\/screen$/);
    const sessionGrepMatch = path.match(/^\/api\/sessions\/([^/]+)\/grep$/);
    const sessionKeysMatch = path.match(/^\/api\/sessions\/([^/]+)\/keys$/);
    const sessionMessageMatch = path.match(/^\/api\/sessions\/([^/]+)\/message$/);
    const sessionInboxMatch = path.match(/^\/api\/sessions\/([^/]+)\/inbox$/);
    const sessionResizeMatch = path.match(/^\/api\/sessions\/([^/]+)\/resize$/);
    const sessionRunningMatch = path.match(/^\/api\/sessions\/([^/]+)\/running$/);
    const sessionUsageMatch = path.match(/^\/api\/sessions\/([^/]+)\/usage$/);
    const sessionPreviewMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/preview$/);
    const sessionChatMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/preview-chat(?:\/(send|reply))?$/);
    const sessionCardMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/card$/);
    const sessionBoardMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/board$/);
    const sessionEventsMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,200})\/events$/);

    if (sessionCardMatch) {
      const coordination = this.getCoordination();
      if (!coordination) { jsonResponse(res, 503, { error: 'Server not ready' }); return; }
      const id = sessionCardMatch[1];
      if ([...url.searchParams.keys()].length > 0) throw new BadRequestError('Unknown query parameter');
      if (req.method === 'GET') {
        const card = await coordination.board.card(id);
        if (!card) { jsonResponse(res, 404, { error: 'Session not found' }); return; }
        jsonResponse(res, 200, card);
        return;
      }
      if (req.method === 'PUT') {
        const body = await parseBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new BadRequestError('Card update must be an object');
        }
        const rawBody = body as Record<string, unknown>;
        const keys = Object.keys(rawBody);
        if (keys.length === 0) throw new BadRequestError('Empty card update');
        for (const key of keys) {
          if (!['state', 'headline', 'progress', 'blockedOn', 'next', 'force'].includes(key)) {
            throw new BadRequestError(`Unknown card field: ${key}`);
          }
        }
        if ('force' in rawBody && typeof rawBody.force !== 'boolean') {
          throw new BadRequestError('force must be a boolean');
        }
        const force = rawBody.force === true;
        const patch = { ...rawBody };
        delete patch.force;
        if (Object.keys(patch).length === 0) {
          throw new BadRequestError('Empty card update');
        }
        const targetSession = await this.store?.loadSession(id);
        if (!targetSession) {
          jsonResponse(res, 404, { error: 'Session not found' });
          return;
        }
        const callerId = this.readCallerSessionId(req);
        const forcedByParent =
          force &&
          Boolean(callerId && targetSession.parentSessionId && callerId === targetSession.parentSessionId);
        if (targetSession.requireGreenPr && patch.state === 'done' && !forcedByParent) {
          if (!targetSession.pullRequestUrl) {
            jsonResponse(res, 409, { error: 'Cannot mark card done: linked PR required' });
            return;
          }
          let pr: { status: { state: string }; fresh: boolean } | null = null;
          try {
            pr = await coordination.prStatusFresh(targetSession.pullRequestUrl);
          } catch {
            pr = null;
          }
          if (pr && !pr.fresh) {
            jsonResponse(res, 409, { error: 'Checking PR status, retry in ~1 min' });
            return;
          }
          const prState = pr?.status.state ?? 'unknown';
          if (prState !== 'passed' && prState !== 'merged') {
            jsonResponse(res, 409, { error: `PR checks are ${prState}; wait for green` });
            return;
          }
        }
        try {
          await coordination.cards.set(id, patch as CardPatch);
        } catch (err) {
          if (err instanceof CardValidationError) {
            jsonResponse(res, 400, { error: err.message });
            return;
          }
          if (err instanceof Error && err.message === 'Session not found') {
            jsonResponse(res, 404, { error: 'Session not found' });
            return;
          }
          throw err;
        }
        if (targetSession.requireGreenPr && patch.state === 'done' && forcedByParent) {
          await coordination.emit(targetSession, 'status', `done forced by parent (${callerId})`);
        }
        const card = await coordination.board.card(id);
        if (!card) { jsonResponse(res, 404, { error: 'Session not found' }); return; }
        jsonResponse(res, 200, card);
        return;
      }
      if (req.method === 'DELETE') {
        const body = await parseBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
          throw new BadRequestError('Unexpected request body');
        }
        const session = await this.store.loadSession(id);
        if (!session) { jsonResponse(res, 404, { error: 'Session not found' }); return; }
        await coordination.cards.clear(id);
        jsonResponse(res, 200, { ok: true });
        return;
      }
      jsonResponse(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (sessionBoardMatch) {
      const coordination = this.getCoordination();
      if (!coordination) { jsonResponse(res, 503, { error: 'Server not ready' }); return; }
      if (req.method !== 'GET') { jsonResponse(res, 405, { error: 'Method not allowed' }); return; }
      const id = sessionBoardMatch[1];
      for (const key of url.searchParams.keys()) {
        if (key !== 'since' && key !== 'ready' && key !== 'all') {
          throw new BadRequestError(`Unknown query parameter: ${key}`);
        }
        if (url.searchParams.getAll(key).length > 1) {
          throw new BadRequestError(`Duplicate query parameter: ${key}`);
        }
      }
      let since: number | undefined;
      const rawSince = url.searchParams.get('since');
      if (rawSince !== null) {
        if (!/^\d{1,12}$/.test(rawSince) || !Number.isSafeInteger(Number(rawSince))) {
          throw new BadRequestError('Invalid since');
        }
        since = Number(rawSince);
      }
      let ready: boolean | undefined;
      const rawReady = url.searchParams.get('ready');
      if (rawReady !== null) {
        if (!['1', '0', 'true', 'false'].includes(rawReady)) {
          throw new BadRequestError('Invalid ready');
        }
        ready = rawReady === '1' || rawReady === 'true';
      }
      let all: boolean | undefined;
      const rawAll = url.searchParams.get('all');
      if (rawAll !== null) {
        if (!['1', '0', 'true', 'false'].includes(rawAll)) {
          throw new BadRequestError('Invalid all');
        }
        all = rawAll === '1' || rawAll === 'true';
      }
      try {
        const board = await coordination.board.board({
          sessionId: id,
          ...(since !== undefined ? { since } : {}),
          ...(ready !== undefined ? { ready } : {}),
          ...(all !== undefined ? { all } : {}),
        });
        jsonResponse(res, 200, board);
      } catch (err) {
        if (err instanceof Error && err.message === 'Session not found') {
          jsonResponse(res, 404, { error: 'Session not found' });
          return;
        }
        throw err;
      }
      return;
    }

    if (sessionEventsMatch) {
      const coordination = this.getCoordination();
      if (!coordination) { jsonResponse(res, 503, { error: 'Server not ready' }); return; }
      if (req.method !== 'GET') { jsonResponse(res, 405, { error: 'Method not allowed' }); return; }
      const id = sessionEventsMatch[1];
      for (const key of url.searchParams.keys()) {
        if (key !== 'since' && key !== 'limit' && key !== 'waitSeconds') {
          throw new BadRequestError(`Unknown query parameter: ${key}`);
        }
        if (url.searchParams.getAll(key).length > 1) {
          throw new BadRequestError(`Duplicate query parameter: ${key}`);
        }
      }
      let since: number | undefined;
      const rawSince = url.searchParams.get('since');
      if (rawSince !== null) {
        if (!/^\d{1,12}$/.test(rawSince) || !Number.isSafeInteger(Number(rawSince))) {
          throw new BadRequestError('Invalid since');
        }
        since = Number(rawSince);
      }
      let limit: number | undefined;
      const rawLimit = url.searchParams.get('limit');
      if (rawLimit !== null) {
        if (!/^\d{1,12}$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit))) {
          throw new BadRequestError('Invalid limit');
        }
        limit = Number(rawLimit);
        if (limit < 1 || limit > 500) {
          throw new BadRequestError('Invalid limit');
        }
      }
      let waitSeconds: number | undefined;
      const rawWait = url.searchParams.get('waitSeconds');
      if (rawWait !== null) {
        if (!/^\d{1,12}$/.test(rawWait) || !Number.isSafeInteger(Number(rawWait))) {
          throw new BadRequestError('Invalid waitSeconds');
        }
        waitSeconds = Number(rawWait);
        if (waitSeconds > 300) {
          throw new BadRequestError('Invalid waitSeconds');
        }
      }
      const session = await this.store.loadSession(id);
      if (!session) { jsonResponse(res, 404, { error: 'Session not found' }); return; }
      const rootId = rootOf(session);
      if (waitSeconds && waitSeconds > 0) {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.on('close', cancel);
        if (res.destroyed) controller.abort();
        try {
          let page = await coordination.events.wait(rootId, since ?? 0, waitSeconds * 1000, controller.signal);
          if (limit !== undefined && page.events.length > limit) {
            const sliced = page.events.slice(0, limit);
            page = { ...page, events: sliced, cursor: sliced[sliced.length - 1].seq };
          }
          jsonResponse(res, 200, page);
        } finally {
          res.off('close', cancel);
        }
        return;
      }
      const page = await coordination.events.read(rootId, {
        ...(since !== undefined ? { since } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      jsonResponse(res, 200, page);
      return;
    }

    if (sessionChatMatch) {
      const controller = this.getSessionController();
      if (!controller) { jsonResponse(res, 503, { error: 'Conversation unavailable', code: 'unavailable' }); return; }
      const [, sessionId, action] = sessionChatMatch;
      let result;
      if (!action && req.method === 'GET') {
        if ([...url.searchParams.keys()].some(key => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1) { jsonResponse(res, 400, { error: 'Invalid conversation request', code: 'invalid' }); return; }
        result = await controller.listPreviewChat(sessionId, url.searchParams.get('cursor') ?? undefined);
      } else if (action && req.method === 'POST' && !url.search) {
        const body = await parseBody(req);
        if (Object.keys(body).sort().join(',') !== 'id,text' || typeof body.id !== 'string' || typeof body.text !== 'string') { jsonResponse(res, 400, { error: 'Invalid conversation request', code: 'invalid' }); return; }
        result = action === 'send' ? await controller.sendPreviewChat(sessionId, { id: body.id, text: body.text }) : await controller.replyPreviewChat(sessionId, { id: body.id, text: body.text });
      } else { jsonResponse(res, 400, { error: 'Invalid conversation request', code: 'invalid' }); return; }
      if (result.ok) { jsonResponse(res, 200, 'page' in result ? result.page : result.result); return; }
      const status = { invalid: 400, too_large: 413, not_found: 404, not_running: 409, unsupported: 409, conflict: 409, capacity_exceeded: 429, unavailable: 503 }[result.code];
      jsonResponse(res, status, { error: result.message, code: result.code }); return;
    }

    if (sessionPreviewMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const controller = this.getSessionController();
      if (!controller) { jsonResponse(res, 503, { error: 'Server not ready' }); return; }
      const body = await parseBody(req);
      if (req.method === 'PUT') {
        if (Object.keys(body).some((key) => key !== 'paths' && key !== 'mode') || !('paths' in body) || !Array.isArray(body.paths) || body.paths.length < 1 || body.paths.length > 12 || body.paths.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
          jsonResponse(res, 400, { error: 'Invalid preview request' }); return;
        }
        const mode = body.mode;
        if (mode !== undefined && mode !== 'replace' && mode !== 'add') {
          jsonResponse(res, 400, { error: 'Invalid preview request' }); return;
        }
        const result = mode === 'add' ? await controller.addPreview(sessionPreviewMatch[1], body.paths) : await controller.setPreview(sessionPreviewMatch[1], body.paths);
        if (!result.ok) { jsonResponse(res, result.code === 'not_found' ? 404 : result.code === 'too_large' ? 413 : 400, { error: result.message }); return; }
        jsonResponse(res, 200, { session: toWireSession(result.session) }); return;
      }
      if (Object.keys(body).some((key) => key !== 'names')) {
        jsonResponse(res, 400, { error: 'Invalid preview request' }); return;
      }
      if (body.names === undefined || (Array.isArray(body.names) && body.names.length === 0)) {
        const result = await controller.clearPreview(sessionPreviewMatch[1]);
        if (!result.ok) { jsonResponse(res, result.code === 'not_found' ? 404 : 400, { error: result.message }); return; }
        jsonResponse(res, 200, { session: toWireSession(result.session) }); return;
      }
      if (!Array.isArray(body.names) || body.names.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
        jsonResponse(res, 400, { error: 'Invalid preview request' }); return;
      }
      const result = await controller.removePreview(sessionPreviewMatch[1], body.names);
      if (!result.ok) { jsonResponse(res, result.code === 'not_found' ? 404 : result.code === 'too_large' ? 413 : 400, { error: result.message }); return; }
      jsonResponse(res, 200, { session: toWireSession(result.session) }); return;
    }

    // Lifecycle routes use the same controller as dashboard RPC.
    const lifecycleMatch = path.match(/^\/api\/sessions\/([^/]+)\/(stop|retry)$/);
    if (lifecycleMatch && req.method === 'POST') {
      const controller = lifecycleMatch[2] === 'stop' ? this.lifecycleController : this.getSessionController();
      if (!controller) { jsonResponse(res, 503, { error: 'Server not ready' }); return; }
      const id = lifecycleMatch[1];
      if (!await controller.get(id)) { jsonResponse(res, 404, { error: 'Session not found' }); return; }
      if (lifecycleMatch[2] === 'stop') {
        jsonResponse(res, 200, await controller.stop(id));
      } else {
        const result = await controller.retry(id);
        if (result.ok) jsonResponse(res, 200, { session: toWireSession(result.session) });
        else jsonResponse(res, result.code === AUTOMATION_REMOVED_CODE ? 410 : result.code === 'not_found' ? 404 : result.code === 'conflict' ? 409 : 400, { error: result.message, ...(result.code === AUTOMATION_REMOVED_CODE ? { code: AUTOMATION_REMOVED_CODE } : {}) });
      }
      return;
    }

    // GET /api/sessions/:id
    if (sessionMatch && req.method === 'GET') {
      const sessionId = sessionMatch[1];
      const session = await (this.getSessionController()?.get(sessionId) ?? this.store.loadSession(sessionId));
      if (!session) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }
      jsonResponse(res, 200, { session: toWireSession(session), capabilities: {
        ...(this.attention ? { attention: { version: 1, request: true, prompt: true } } : {}),
        sessionMetadata: { pullRequest: true, preview: true },
      } });
      return;
    }

    // DELETE /api/sessions/:id — remove the session (archived as a tombstone)
    if (sessionMatch && req.method === 'DELETE') {
      const sessionId = sessionMatch[1];

      const controller = this.getSessionController();
      if (!controller) {
        jsonResponse(res, 503, { error: 'Server not ready' });
        return;
      }

      const session = await controller.get(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }

      const worktreeValues = url.searchParams.getAll('worktree');
      if (worktreeValues.length > 1) throw new BadRequestError('Invalid worktree mode');
      let worktreeMode: 'auto' | 'keep' | 'force' = 'auto';
      if (worktreeValues.length === 1) {
        const mode = worktreeValues[0];
        if (mode !== 'keep' && mode !== 'force') throw new BadRequestError('Invalid worktree mode');
        worktreeMode = mode;
      }

      const removed = await controller.remove(sessionId, undefined, worktreeMode);
      this.mail.markSessionEnded(sessionId);

      jsonResponse(res, 200, {
        removed: true,
        sessionId,
        ...(removed.worktreeOutcome ? { worktreeOutcome: removed.worktreeOutcome } : {}),
      });
      return;
    }

    // POST /api/sessions/:id/revive — recreate a removed session from its tombstone
    if (sessionReviveMatch && req.method === 'POST') {
      const sessionId = sessionReviveMatch[1];

      if (!this.sessionDeps) {
        jsonResponse(res, 503, { error: 'Session factory not ready' });
        return;
      }

      const archived = await this.store.listArchived();
      // Newest tombstone wins when a session was removed and revived repeatedly.
      const tombstone = archived.filter((record) => record.id === sessionId).pop();
      if (!tombstone) {
        jsonResponse(res, 404, { error: 'Archived session not found' });
        return;
      }

      if (isRetiredAutomationSession(tombstone)) {
        jsonResponse(res, 410, { code: AUTOMATION_REMOVED_CODE, error: AUTOMATION_REMOVED_MESSAGE });
        return;
      }

      const sessions = await this.store.listSessions();
      // Revive can mint several store sessions sharing one agent id over time,
      // so every match must be checked, not just the first. isRunning only
      // reflects attached PTYs; a live tmux session the bridge has not (yet)
      // reattached — restart window, failed reattach — counts as running too,
      // as does a store record still marked running before resurrection runs.
      const isLive = (s: Session): boolean =>
        this.runner
          ? this.runner.isRunning(s.id) || this.runner.hasTmuxSession(s.id) || s.status === 'running'
          : s.status === 'running';
      const conflict = sessions.find(
        (s) =>
          ((tombstone.claudeSessionId && s.claudeSessionId === tombstone.claudeSessionId) ||
            (tombstone.cursorSessionId && s.cursorSessionId === tombstone.cursorSessionId) ||
            (tombstone.codexSessionId && s.codexSessionId === tombstone.codexSessionId) ||
            (tombstone.piSessionId && s.piSessionId === tombstone.piSessionId) ||
            (tombstone.opencodeSessionId &&
              s.opencodeSessionId === tombstone.opencodeSessionId) ||
            (tombstone.museSessionId &&
              s.museSessionId === tombstone.museSessionId) ||
            (tombstone.grokSessionId &&
              s.grokSessionId === tombstone.grokSessionId) ||
            (tombstone.antigravitySessionId &&
              s.antigravitySessionId === tombstone.antigravitySessionId)) &&
          isLive(s),
      );
      if (conflict) {
        jsonResponse(res, 409, {
          error: `Session ${conflict.id} is already running with the same agent session id`,
        });
        return;
      }

      const parentSessionId = tombstone.parentSessionId
        ? (await this.store.loadSession(tombstone.parentSessionId)) ? tombstone.parentSessionId : undefined
        : undefined;

      // Custom-command tombstones (command override at create time) must rerun
      // their command verbatim — the builder would silently swap in a stock
      // claude session. Builder-generated commands are rebuilt by
      // createFtownSession instead, so the tombstone's agent session id is
      // injected as --resume. The classification lives in the session module.
      const { isCustom: isCustomCommand } = deriveRelaunchCommand(tombstone);

      try {
        const session = await createFtownSession(this.sessionDeps, {
          command: isCustomCommand ? tombstone.command : undefined,
          name: tombstone.name,
          workingDir: tombstone.workingDir,
          env: tombstone.env,
          shellType: tombstone.shellType,
          model: tombstone.model,
          claudeSessionId: tombstone.claudeSessionId,
          cursorSessionId: tombstone.cursorSessionId,
          codexSessionId: tombstone.codexSessionId,
          piSessionId: tombstone.piSessionId,
          piSessionFile: tombstone.piSessionFile,
          opencodeSessionId: tombstone.opencodeSessionId,
          museSessionId: tombstone.museSessionId,
          grokSessionId: tombstone.grokSessionId,
          antigravitySessionId: tombstone.antigravitySessionId,
          parentSessionId,
        });
        // A builder-managed resumable harness preserves conversation context;
        // custom commands are rerun verbatim and cannot make that guarantee.
        const resumed = archivedSessionWasResumed(tombstone, isCustomCommand);
        jsonResponse(res, 201, { session: toWireSession(session), resumed });
      } catch (err) {
          if (err instanceof ProviderAuthMissingError) {
            const r = providerAuthMissingResponse(err);
            jsonResponse(res, r.status, r.body);
            return;
          }
          if (err instanceof WorkingDirMissingError) {
            const r = workingDirMissingResponse(err);
            jsonResponse(res, r.status, r.body);
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          jsonResponse(res, 500, { error: message });
        }
      return;
    }

    // PATCH /api/sessions/:id — rename, reparent and/or associate a pull request
    if (sessionMatch && req.method === 'PATCH') {
      const sessionId = sessionMatch[1];
      const body = await parseBody(req);
      const name = body.name as string | undefined;
      const hasParentField = Object.prototype.hasOwnProperty.call(body, 'parentSessionId');
      const hasPullRequestField = Object.prototype.hasOwnProperty.call(body, 'pullRequestUrl');

      if (name === undefined && !hasParentField && !hasPullRequestField) {
        jsonResponse(res, 400, { error: 'Nothing to update' });
        return;
      }

      const controller = this.getSessionController();
      if (!controller) {
        jsonResponse(res, 503, { error: 'Server not ready' });
        return;
      }

      const result = await controller.update(sessionId, {
        ...(name === undefined ? {} : { name }),
        ...(hasParentField ? { parent: { value: body.parentSessionId } } : {}),
        ...(hasPullRequestField ? { pullRequestUrl: body.pullRequestUrl as string | null } : {}),
      });
      if (!result.ok) {
        jsonResponse(res, result.code === 'not_found' ? 404 : 400, { error: result.message });
        return;
      }

      jsonResponse(res, 200, { session: toWireSession(result.session) });
      return;
    }

    // GET /api/sessions/:id/screen
    if (sessionScreenMatch && req.method === 'GET') {
      const sessionId = sessionScreenMatch[1];
      const session = await this.store.loadSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }

      const offset = getQueryInt(url, 'offset', 0);
      const limit = getQueryInt(url, 'limit', 1000);

      if (this.terminalManager && this.terminalManager.has(sessionId)) {
        const screen = this.terminalManager.getScreen(sessionId, offset, limit);
        jsonResponse(res, 200, screen);
        return;
      }

      const log = await this.store.loadTerminalLog(sessionId);
      if (!log || log.length === 0) {
        jsonResponse(res, 200, { lines: [], totalLines: 0, offset, limit });
        return;
      }

      const allLines = log.split('\n');
      const totalLines = allLines.length;
      const lines = allLines.slice(offset, offset + limit);

      jsonResponse(res, 200, { lines, totalLines, offset, limit });
      return;
    }

    // DELETE /api/sessions/:id/screen
    if (sessionScreenMatch && req.method === 'DELETE') {
      const sessionId = sessionScreenMatch[1];
      const session = await this.store.loadSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }

      await this.store.clearTerminalLog(sessionId);
      if (this.terminalManager && this.terminalManager.has(sessionId)) {
        this.terminalManager.destroy(sessionId);
      }

      jsonResponse(res, 200, { cleared: true });
      return;
    }

    // POST /api/sessions/:id/grep
    if (sessionGrepMatch && req.method === 'POST') {
      const sessionId = sessionGrepMatch[1];
      const session = await this.store.loadSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }

      const body = await parseBody(req);
      const pattern = body.pattern as string | undefined;
      if (!pattern) {
        jsonResponse(res, 400, { error: 'Missing pattern' });
        return;
      }

      const offset = typeof body.offset === 'number' ? Math.max(0, body.offset) : 0;
      const limit = typeof body.limit === 'number' ? Math.max(0, body.limit) : 1000;
      const contextLines =
        typeof body.context === 'number' ? Math.max(0, Math.min(10, body.context)) : 0;

      if (pattern.length > 256) {
        jsonResponse(res, 400, { error: 'Pattern too long' });
        return;
      }

      const allLines = this.terminalManager && this.terminalManager.has(sessionId)
        ? this.terminalManager.allLines(sessionId)
        : (await this.store.loadTerminalLog(sessionId)).split('\n');

      let indexes: number[] | null;
      try {
        indexes = await boundedMatchIndexes(pattern, allLines);
      } catch (error) {
        if (error instanceof GrepBusyError) {
          jsonResponse(res, 429, { error: 'Too many concurrent searches' });
          return;
        }
        jsonResponse(res, 400, { error: 'Invalid regex pattern' });
        return;
      }
      if (indexes === null) {
        jsonResponse(res, 400, { error: 'Pattern too complex' });
        return;
      }

      const matches: { lineNumber: number; text: string; before?: string[]; after?: string[] }[] = [];
      for (const i of indexes) {
        const entry: { lineNumber: number; text: string; before?: string[]; after?: string[] } = {
          lineNumber: i + 1,
          text: allLines[i],
        };
        if (contextLines > 0) {
          entry.before = allLines.slice(Math.max(0, i - contextLines), i);
          entry.after = allLines.slice(i + 1, Math.min(allLines.length, i + 1 + contextLines));
        }
        matches.push(entry);
      }

      const totalMatches = matches.length;
      const paginatedMatches = matches.slice(offset, offset + limit);

      jsonResponse(res, 200, { matches: paginatedMatches, totalMatches, offset, limit });
      return;
    }

    // POST /api/sessions/:id/keys
    if (sessionKeysMatch && req.method === 'POST') {
      const sessionId = sessionKeysMatch[1];
      const body = await parseBody(req);
      const keys = body.keys as string | undefined;

      if (!keys) {
        jsonResponse(res, 400, { error: 'Missing keys' });
        return;
      }

      if (!this.runner) {
        jsonResponse(res, 503, { error: 'Runner not available' });
        return;
      }

      const sent = this.runner.write(sessionId, keys);
      if (!sent) {
        jsonResponse(res, 409, { error: 'Session not running' });
        return;
      }

      jsonResponse(res, 200, { sent: true });
      return;
    }

    // POST /api/sessions/:id/message — deliver a short text line into another session's PTY
    if (sessionMessageMatch && req.method === 'POST') {
      const sessionId = sessionMessageMatch[1];
      const body = await parseBody(req);
      const rawText = body.text;

      if (typeof rawText !== 'string' || !rawText.trim()) {
        jsonResponse(res, 400, { error: 'Missing text' });
        return;
      }
      if (rawText.length > MAX_MESSAGE_LENGTH) {
        jsonResponse(res, 400, { error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` });
        return;
      }

      const text = sanitizeMessageText(rawText);
      if (!text) {
        jsonResponse(res, 400, { error: 'Message empty after sanitization' });
        return;
      }

      const session = await this.store.loadSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }

      if (!this.runner) {
        jsonResponse(res, 503, { error: 'Runner not available' });
        return;
      }
      if (!this.runner.isRunning(sessionId)) {
        jsonResponse(res, 409, { error: 'Session not running' });
        return;
      }

      let sender = 'unknown';
      const from = typeof body.from === 'string' ? body.from.trim() : '';
      if (from) {
        const fromSession = await this.store.loadSession(from);
        if (fromSession) sender = fromSession.name || from.slice(0, 8);
      }

      const wrote = await this.mail.injectPtyLine(session, sender, text);
      if (!wrote) {
        jsonResponse(res, 409, { error: 'Session not running' });
        return;
      }

      jsonResponse(res, 200, { delivered: true, sessionId, from: sender });
      return;
    }

    // POST /api/sessions/:id/inbox — store mail for a session (long-poll kick or nudge)
    if (sessionInboxMatch && req.method === 'POST') {
      await this.handleInboxPost(req, res, sessionInboxMatch[1]);
      return;
    }

    // GET /api/sessions/:id/inbox — read mail (peek, drain, or long poll)
    if (sessionInboxMatch && req.method === 'GET') {
      await this.handleInboxGet(res, sessionInboxMatch[1], url);
      return;
    }

    // POST /api/sessions/:id/resize
    if (sessionResizeMatch && req.method === 'POST') {
      const sessionId = sessionResizeMatch[1];
      const body = await parseBody(req);
      const cols = typeof body.cols === 'number' ? body.cols : NaN;
      const rows = typeof body.rows === 'number' ? body.rows : NaN;

      if (Number.isNaN(cols) || Number.isNaN(rows)) {
        jsonResponse(res, 400, { error: 'Missing or invalid cols/rows' });
        return;
      }

      if (!this.runner) {
        jsonResponse(res, 503, { error: 'Runner not available' });
        return;
      }

      const resized = this.runner.resize(sessionId, cols, rows);
      if (!resized) {
        jsonResponse(res, 409, { error: 'Session not running' });
        return;
      }

      jsonResponse(res, 200, { resized: true });
      return;
    }

    // GET /api/sessions/:id/usage — per-session token/cost usage
    if (sessionUsageMatch && req.method === 'GET') {
      const controller = this.getSessionController();
      if (!controller) {
        jsonResponse(res, 503, { error: 'Server not ready' });
        return;
      }
      const result = await controller.usage(sessionUsageMatch[1]);
      if (!result.ok) {
        jsonResponse(res, 404, { error: result.message });
        return;
      }
      jsonResponse(res, 200, { usage: result.usage });
      return;
    }

    // GET /api/sessions/:id/running
    if (sessionRunningMatch && req.method === 'GET') {
      const sessionId = sessionRunningMatch[1];
      const session = await this.store.loadSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }

      const running = this.runner ? this.runner.isRunning(sessionId) : false;
      jsonResponse(res, 200, { sessionId, running });
      return;
    }

    jsonResponse(res, 404, { error: 'Not found' });
  }

  /** Queue browser mail using the same durable delivery path as local inbox POST. */
  async enqueueSessionMessage(session: Session, message: string): Promise<AcceptMailResult> {
    if (!this.mail.isReady()) return { ok: false, error: 'Mail store not ready' };
    return this.mail.acceptMail(session, { from: 'browser', fromName: 'You', type: 'message', body: message });
  }

  /** Queue arbitrary mail (e.g. an attention answer with a threadId) through the durable delivery path. */
  async acceptSessionMail(session: Session, body: Record<string, unknown>): Promise<AcceptMailResult> {
    if (!this.mail.isReady()) return { ok: false, error: 'Mail store not ready' };
    return this.mail.acceptMail(session, body);
  }

  /** Best-effort child-idle tree event emission. */
  async notifyIdleParent(signal: SubagentIdleSignal, isCurrent: () => boolean): Promise<void> {
    const store = this.store; const runner = this.runner; const bridgeId = this.securityInfo?.bridgeId;
    if (!store || !runner || !bridgeId || !/^[A-Za-z0-9_-]{1,200}$/.test(signal.sessionId) || !isCurrent()) return;
    const child = await store.loadSession(signal.sessionId);
    if (!child || child.id !== signal.sessionId || child.bridgeId !== bridgeId || child.status !== 'running' || child.shellType === 'shell'
      || !child.parentSessionId || child.parentSessionId === child.id || !/^[A-Za-z0-9_-]{1,200}$/.test(child.parentSessionId)) return;
    const parentId = child.parentSessionId;
    const parent = await store.loadSession(parentId);
    if (!parent || parent.id !== parentId || parent.bridgeId !== bridgeId || parent.status !== 'running' || parent.shellType === 'shell') return;
    const currentParent = await store.loadSession(parentId);
    const currentChild = await store.loadSession(signal.sessionId);
    if (!isCurrent() || !currentChild || currentChild.id !== signal.sessionId || currentChild.bridgeId !== bridgeId || currentChild.status !== 'running'
      || currentChild.shellType === 'shell' || currentChild.parentSessionId !== parentId
      || !currentParent || currentParent.id !== parentId || currentParent.bridgeId !== bridgeId || currentParent.status !== 'running' || currentParent.shellType === 'shell'
      || !runner.isRunning(currentChild.id) || !runner.isRunning(currentParent.id)) return;
    const name = sanitizeAttentionText(currentChild.name, 200) || 'Session';
    if (!isCurrent()) return;
    await this.getCoordination()?.emit(currentChild, 'idle', `${name} idle for 2m`);
  }

  private async handleInboxPost(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    if (!this.store || !this.mail.isReady()) {
      jsonResponse(res, 503, { error: 'Mail store not ready' });
      return;
    }

    const session = await this.store.loadSession(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return;
    }

    const body = await parseBody(req);
    const result = await this.mail.acceptMail(session, body);
    if (!result.ok) {
      jsonResponse(res, 400, { error: result.error });
      return;
    }

    jsonResponse(res, 201, { id: result.id });
  }

  private async handleInboxGet(res: ServerResponse, sessionId: string, url: URL): Promise<void> {
    if (!this.store || !this.mail.isReady()) {
      jsonResponse(res, 503, { error: 'Mail store not ready' });
      return;
    }

    const session = await this.store.loadSession(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return;
    }

    try {
      const registration = parseNativeWakeRegistration(url.searchParams);
      if (registration) this.mail.registerNativeWake(session, registration);
    } catch (error) {
      if (!(error instanceof NativeWakeRegistrationError)) throw error;
      jsonResponse(res, error.status, { error: error.message });
      return;
    }

    const result = await this.mail.readMail(session, {
      wait: getQueryInt(url, 'wait', 0),
      peek: getQueryInt(url, 'peek', 0) === 1,
      all: url.searchParams.get('all') === '1',
      limit: getQueryInt(url, 'limit', 50),
    });

    if (result.kind === 'immediate') {
      jsonResponse(res, 200, { messages: result.messages });
      return;
    }

    // Long poll: the promise resolves when mail arrives or the wait elapses.
    // On client disconnect abandon the waiter — the promise then never resolves
    // and no response is written (the socket is gone anyway).
    res.on('close', result.abandon);
    const messages = await result.messages;
    jsonResponse(res, 200, { messages });
  }

  private async handleHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const payload = await parseBody(req);
      if (payload.hook_event_name === 'FtownNativeWake') {
        if (!this.store || !this.mailStore) { jsonResponse(res, 503, { error: 'not_ready' }); return; }
        try {
          const result = await nativeWake(payload, { getSession: id => this.store!.loadSession(id),
            register: (session, registration) => this.mail.registerNativeWake(session, registration),
            unread: id => this.mailStore!.listUndelivered(id),
            busy: id => this.mail.isAgentRecentlyBusy(id) });
          jsonResponse(res, 200, result);
        } catch { jsonResponse(res, 409, { error: 'invalid_native_target' }); }
        return;
      }
      if (payload.hook_event_name === 'FtownWakeSubmitted') {
        // Opencode announces the wake before submitting it (same 200 either way).
        // Record only: never forwarded to the dashboard, never attention.
        const submittedId = typeof payload.ftown_session_id === 'string' ? payload.ftown_session_id : undefined;
        const submittedSource = typeof payload.ftown_session_source === 'string' ? payload.ftown_session_source : undefined;
        if (submittedId && submittedSource !== 'workspace' && /^[a-zA-Z0-9_-]+$/.test(submittedId)
          && await this.store?.loadSession(submittedId)) {
          try {
            await this.mail.notePluginHandoff(submittedId);
          } catch (error) {
            console.warn(
              `[LocalApiServer] Failed to note plugin handoff for ${submittedId}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        jsonResponse(res, 200, { ok: true });
        return;
      }
      const hookEventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : undefined;
      let ftownSessionId = typeof payload.ftown_session_id === 'string' ? payload.ftown_session_id : undefined;
      let source = typeof payload.ftown_session_source === 'string' ? payload.ftown_session_source : undefined;
      if (!ftownSessionId) {
        const resolved = resolveSessionIdFromHookPayload(payload);
        ftownSessionId = resolved?.sessionId;
        source = resolved?.source;
      }
      if (!ftownSessionId || !hookEventName) { jsonResponse(res, 200, { ok: true }); return; }
      const { ftown_session_id: _, ftown_session_source: __, attentionId: _attentionId,
        attentionSequence: _attentionSequence, attentionCreatedAt: _attentionCreatedAt, ...restWithInjected } = payload;
      // Never trust a harness-supplied injected flag.
      const { injected: _incomingInjected, ...rest } = restWithInjected;
      const isPromptSubmit = hookEventName === 'UserPromptSubmit' || hookEventName === 'beforeSubmitPrompt';
      const injected = isPromptSubmit && this.mail.isInjectedPrompt(ftownSessionId, rest);
      let committedAttention: Awaited<ReturnType<AttentionStore['record']>> = undefined;
      // Workspace fallback can identify a foreign agent in the same directory.
      // Only known explicit/native-attributed sessions may produce authoritative records.
      if (this.attention && source !== 'workspace' && /^[a-zA-Z0-9_-]+$/.test(ftownSessionId) && await this.store?.loadSession(ftownSessionId)) {
        committedAttention = await this.attention.record(ftownSessionId, hookEventName, rest,
          isPromptSubmit ? { promptOrigin: injected ? 'injected' : 'human' } : undefined);
      }
      if (hookEventName === 'UserPromptSubmit' || hookEventName === 'PreToolUse' || hookEventName === 'PostToolUse') this.mail.markAgentBusy(ftownSessionId, hookEventName);
      else if (hookEventName === 'Stop') this.mail.markAgentIdle(ftownSessionId);
      else if (hookEventName === 'SessionEnd') { this.mail.markAgentIdle(ftownSessionId); this.mail.markSessionEnded(ftownSessionId); }
      const conversationId = payload.conversation_id;
      if (typeof conversationId === 'string' && conversationId && source !== 'workspace') registerSessionConversation(ftownSessionId, conversationId);
      const hookEvent: HookEvent = { sessionId: ftownSessionId, eventName: hookEventName, data: {
        ...rest,
        ...(injected ? { injected: true } : {}),
        ...(committedAttention ? { attentionId: committedAttention.id, attentionSequence: committedAttention.sequence, attentionCreatedAt: committedAttention.createdAt } : {}),
      }, source };
      // Persistence is complete before listeners can publish and before HTTP success.
      this.emit('event', hookEvent);
      jsonResponse(res, 200, { ok: true });
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof AttentionError) jsonResponse(res, error.status, { error: error.message, code: error.code });
      else if (error instanceof BadRequestError) jsonResponse(res, 400, { error: error.message });
      else jsonResponse(res, 500, { error: 'Hook handling failed' });
    }
  }
}
