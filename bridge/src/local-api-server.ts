import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { timingSafeEqual } from 'node:crypto';

import type { Server, IncomingMessage, ServerResponse } from 'node:http';

import type { SessionStore } from './session-store.js';
import type { MailStore } from './mail-store.js';
import { createMailMessage } from './mail-store.js';
import type { MailMessage, Session, ShellType } from './types.js';
import { buildSessionCommand } from './agent-commands.js';
import type { ProcessRunner } from './claude-runner.js';
import type { CentrifugoClient } from './centrifugo-client.js';
import type { TerminalManager } from './terminal-manager.js';
import {
  registerSessionConversation,
  resolveSessionIdByConversation,
  resolveSessionIdFromHookPayload,
} from './session-registry.js';
import {
  createFtownSession,
  parseCreateSessionBody,
  ProviderAuthMissingError,
  WorkingDirMissingError,
  type CreateFtownSessionDeps,
} from './create-ftown-session.js';
import { removeFtownSession } from './remove-ftown-session.js';
import { toWireSession } from './session-wire.js';

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

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
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
  const [host, port] = hostHeader.split(':');
  if (port && parseInt(port, 10) !== expectedPort) return false;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
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
const MAX_MAIL_BODY_LENGTH = 64 * 1024;
const MAX_MAIL_WAIT_SECONDS = 30;
const MAIL_NUDGE_DELAY_MS = 5_000;
// Hooked agents (claude/codex and claude flavors) get mail through their Stop
// pump; the nudge is only a safety net for them, so wait much longer before
// typing into their pane — fast nudges race the pump and queue stale prompts.
const MAIL_NUDGE_DELAY_HOOKED_MS = 60_000;
const HOOKED_SHELL_TYPES: ReadonlySet<string> = new Set([
  'claude', 'codex', 'zai', 'kimi', 'deepseek', 'fireworks',
]);
const MAIL_NUDGE_MIN_INTERVAL_MS = 30_000;
// While an agent is mid-turn its Stop hook pump delivers mail at turn end, so
// nudging would only queue a stale prompt; re-check periodically in case the
// turn never reaches Stop, and ignore busy markers old enough to be a crash.
const MAIL_NUDGE_BUSY_RECHECK_MS = 60_000;
const AGENT_BUSY_STALE_MS = 30 * 60_000;

const MAIL_TYPES: ReadonlyArray<MailMessage['type']> = ['message', 'task', 'result', 'escalation'];

/** Pending long-poll request for a session's inbox. */
interface MailWaiter {
  deliver: (messages: MailMessage[]) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Messages are sanitized to a single line, so a delayed plain CR submits everywhere.
// (ESC+CR reads as Alt+Enter — insert newline — on current Claude Code.)
function submitSuffixFor(_shellType: ShellType | undefined): string {
  return '\r';
}

// Strip control chars and collapse whitespace so a message cannot inject keystrokes.
function sanitizeMessageText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getQueryInt(url: URL, name: string, defaultValue: number): number {
  const val = url.searchParams.get(name);
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? defaultValue : Math.max(0, parsed);
}

export class LocalApiServer extends EventEmitter<HookServerEvents> {
  private server: Server | null = null;
  private store: SessionStore | null = null;
  private runner: ProcessRunner | null = null;
  private centrifugo: CentrifugoClient | null = null;
  private terminalManager: TerminalManager | null = null;
  private sessionDeps: CreateFtownSessionDeps | null = null;
  private mailStore: MailStore | null = null;
  private mailWaiters: Map<string, MailWaiter> = new Map();
  private nudgeTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingNudgeFrom: Map<string, string> = new Map();
  private lastNudgeAt: Map<string, number> = new Map();
  private agentBusySince: Map<string, number> = new Map();
  private userId: string = '';
  private authToken: string = '';
  private port: number = 0;

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  setMailStore(mailStore: MailStore): void {
    this.mailStore = mailStore;
  }

  setDependencies(
    store: SessionStore,
    runner: ProcessRunner,
    centrifugo: CentrifugoClient,
    userId: string,
    terminalManager?: TerminalManager,
  ): void {
    this.store = store;
    this.runner = runner;
    this.centrifugo = centrifugo;
    this.userId = userId;
    this.terminalManager = terminalManager ?? null;
  }

  setSessionFactory(deps: CreateFtownSessionDeps): void {
    this.sessionDeps = deps;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      server.on('error', (err: Error) => {
        console.error('[LocalApiServer] Server error:', err.message);
      });

      server.listen(0, '127.0.0.1', () => {
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
    });
  }

  stop(): void {
    for (const timer of this.nudgeTimers.values()) clearTimeout(timer);
    this.nudgeTimers.clear();
    for (const waiter of [...this.mailWaiters.values()]) waiter.deliver([]);
    this.mailWaiters.clear();
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

    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(origin)) {
      jsonResponse(res, 403, { error: 'Forbidden origin' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (this.authToken) {
      const presented = extractBearer(req);
      if (!presented || !constantTimeEq(presented, this.authToken)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="ftown-bridge"');
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    if (path === '/hook' && req.method === 'POST') {
      this.handleHook(req, res);
      return;
    }

    if (path.startsWith('/api/')) {
      this.handleApiRoute(req, res, path, url).catch((err) => {
        if (err instanceof BadRequestError) {
          jsonResponse(res, 400, { error: err.message });
          return;
        }
        console.error('[LocalApiServer] API route error:', err instanceof Error ? err.message : String(err));
        jsonResponse(res, 500, { error: 'Internal server error' });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private async handleApiRoute(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    url: URL,
  ): Promise<void> {
    if (!this.store) {
      jsonResponse(res, 503, { error: 'Server not ready' });
      return;
    }

    // GET /api/sessions
    if (path === '/api/sessions' && req.method === 'GET') {
      const sessions = await this.store.listSessions();
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

      const input = parseCreateSessionBody(
        body,
        useCallerAsParent ? callerSessionId : undefined,
      );

      if (!input.command && !input.shellType && !input.prompt) {
        jsonResponse(res, 400, {
          error: 'Provide shellType, prompt, and/or command',
        });
        return;
      }

      try {
        const session = await createFtownSession(this.sessionDeps, input);
        jsonResponse(res, 201, { session: toWireSession(session) });
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

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    const sessionReviveMatch = path.match(/^\/api\/sessions\/([^/]+)\/revive$/);
    const sessionScreenMatch = path.match(/^\/api\/sessions\/([^/]+)\/screen$/);
    const sessionGrepMatch = path.match(/^\/api\/sessions\/([^/]+)\/grep$/);
    const sessionKeysMatch = path.match(/^\/api\/sessions\/([^/]+)\/keys$/);
    const sessionMessageMatch = path.match(/^\/api\/sessions\/([^/]+)\/message$/);
    const sessionInboxMatch = path.match(/^\/api\/sessions\/([^/]+)\/inbox$/);
    const sessionResizeMatch = path.match(/^\/api\/sessions\/([^/]+)\/resize$/);
    const sessionRunningMatch = path.match(/^\/api\/sessions\/([^/]+)\/running$/);

    // GET /api/sessions/:id
    if (sessionMatch && req.method === 'GET') {
      const sessionId = sessionMatch[1];
      const session = await this.store.loadSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }
      jsonResponse(res, 200, { session: toWireSession(session) });
      return;
    }

    // DELETE /api/sessions/:id — remove the session (archived as a tombstone)
    if (sessionMatch && req.method === 'DELETE') {
      const sessionId = sessionMatch[1];

      if (!this.runner || !this.centrifugo || !this.userId) {
        jsonResponse(res, 503, { error: 'Server not ready' });
        return;
      }

      const session = await this.store.loadSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }

      await removeFtownSession(
        { store: this.store, runner: this.runner, centrifugo: this.centrifugo, userId: this.userId },
        sessionId,
      );

      jsonResponse(res, 200, { removed: true, sessionId });
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
            (tombstone.codexSessionId && s.codexSessionId === tombstone.codexSessionId)) &&
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

      // Custom-command sessions (command override at create time) must rerun
      // their command verbatim — the builder would silently swap in a stock
      // claude session. Builder-generated commands are rebuilt instead so the
      // tombstone's agent session id is injected as --resume (matching
      // resurrectSession's heuristic).
      const builderDefault = buildSessionCommand({
        shellType: tombstone.shellType,
        workingDir: tombstone.workingDir,
        model: tombstone.model,
      });
      const builderResume = buildSessionCommand({
        shellType: tombstone.shellType,
        workingDir: tombstone.workingDir,
        model: tombstone.model,
        claudeSessionId: tombstone.claudeSessionId,
        cursorSessionId: tombstone.cursorSessionId,
        codexSessionId: tombstone.codexSessionId,
      });
      const isCustomCommand = Boolean(tombstone.command)
        && tombstone.command !== builderDefault
        && tombstone.command !== builderResume;

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
          parentSessionId,
        });
        // resumed=false means a fresh conversation (no agent session id was
        // recorded before removal); callers should not assume context survived.
        // Codex resumes via a `resume <id>` subcommand instead of a --resume flag.
        const resumed =
          session.command.includes(' --resume ') ||
          /(^|\s)codex(\s+\S+)*\s+resume\s/.test(session.command);
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

    // PATCH /api/sessions/:id
    if (sessionMatch && req.method === 'PATCH') {
      const sessionId = sessionMatch[1];
      const body = await parseBody(req);
      const name = body.name as string | undefined;
      const hasParentField = Object.prototype.hasOwnProperty.call(body, 'parentSessionId');
      const rawParent = body.parentSessionId as string | null | undefined;

      if (name === undefined && !hasParentField) {
        jsonResponse(res, 400, { error: 'Nothing to update' });
        return;
      }

      const session = await this.store.loadSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }

      if (name !== undefined) {
        if (typeof name !== 'string' || !name) {
          jsonResponse(res, 400, { error: 'Invalid name' });
          return;
        }
        session.name = name;
      }

      if (hasParentField) {
        if (rawParent === null || rawParent === '' || rawParent === undefined) {
          session.parentSessionId = undefined;
        } else if (typeof rawParent !== 'string') {
          jsonResponse(res, 400, { error: 'Invalid parentSessionId' });
          return;
        } else if (rawParent === sessionId) {
          jsonResponse(res, 400, { error: 'Session cannot be its own parent' });
          return;
        } else {
          const proposed = await this.store.loadSession(rawParent);
          if (!proposed) {
            jsonResponse(res, 400, { error: 'Parent session not found' });
            return;
          }
          session.parentSessionId = proposed.parentSessionId ?? proposed.id;
        }
      }

      session.updatedAt = new Date().toISOString();
      await this.store.saveSession(session);

      if (this.centrifugo && this.userId) {
        await this.centrifugo.publishSessionUpdate(this.userId, session);
      }

      jsonResponse(res, 200, { session: toWireSession(session) });
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

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch {
        jsonResponse(res, 400, { error: 'Invalid regex pattern' });
        return;
      }

      if (this.terminalManager && this.terminalManager.has(sessionId)) {
        jsonResponse(
          res,
          200,
          this.terminalManager.grep(sessionId, pattern, offset, limit, contextLines),
        );
        return;
      }

      const log = await this.store.loadTerminalLog(sessionId);
      const allLines = log.split('\n');
      const matches: { lineNumber: number; text: string; before?: string[]; after?: string[] }[] = [];

      for (let i = 0; i < allLines.length; i++) {
        if (regex.test(allLines[i])) {
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

      const wrote = await this.injectPtyLine(session, sender, text);
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

  // Plain shells would execute the message as a command; deliver it as a quoted no-op
  // (`: '...'`) — interactive zsh has no '#' comments by default.
  private async injectPtyLine(session: Session, sender: string, text: string): Promise<boolean> {
    if (!this.runner) return false;
    const isAgent = session.shellType && session.shellType !== 'shell';
    const line = isAgent
      ? `[ftown msg from ${sender}] ${text}`
      : `: '[ftown msg from ${sender}] ${text.replace(/'/g, '')}'`;
    if (!this.runner.write(session.id, line)) return false;
    // Composer TUIs detect pastes by input arrival rate; the submit CR must come well
    // after that window or it is treated as a pasted newline.
    await delay(600);
    this.runner.write(session.id, submitSuffixFor(session.shellType));
    return true;
  }

  private async handleInboxPost(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    if (!this.store || !this.mailStore) {
      jsonResponse(res, 503, { error: 'Mail store not ready' });
      return;
    }

    const session = await this.store.loadSession(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return;
    }

    const body = await parseBody(req);
    const text = body.body;
    if (typeof text !== 'string' || !text.trim()) {
      jsonResponse(res, 400, { error: 'Missing body' });
      return;
    }
    if (text.length > MAX_MAIL_BODY_LENGTH) {
      jsonResponse(res, 400, { error: `Body too long (max ${MAX_MAIL_BODY_LENGTH} chars)` });
      return;
    }

    let type: MailMessage['type'] = 'message';
    if (body.type !== undefined) {
      if (typeof body.type !== 'string' || !MAIL_TYPES.includes(body.type as MailMessage['type'])) {
        jsonResponse(res, 400, { error: `Invalid type (expected one of: ${MAIL_TYPES.join(', ')})` });
        return;
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

    jsonResponse(res, 201, { id: msg.id });
  }

  private async handleInboxGet(res: ServerResponse, sessionId: string, url: URL): Promise<void> {
    if (!this.store || !this.mailStore) {
      jsonResponse(res, 503, { error: 'Mail store not ready' });
      return;
    }
    const mailStore = this.mailStore;

    const session = await this.store.loadSession(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return;
    }

    const wait = Math.min(getQueryInt(url, 'wait', 0), MAX_MAIL_WAIT_SECONDS);
    const peek = getQueryInt(url, 'peek', 0) === 1;
    const all = url.searchParams.get('all') === '1';
    const limit = getQueryInt(url, 'limit', 50);

    if (peek) {
      const messages = all
        ? await mailStore.listAll(session.id, limit)
        : await mailStore.listUndelivered(session.id);
      jsonResponse(res, 200, { messages });
      return;
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
      jsonResponse(res, 200, { messages: marked });
      return;
    }

    // Long poll: hold until mail arrives or `wait` seconds elapse. One waiter
    // per session — a newer waiter resolves the previous one with [].
    const existing = this.mailWaiters.get(session.id);
    if (existing) existing.deliver([]);

    let settled = false;
    const waiter: MailWaiter = {
      deliver: (messages: MailMessage[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.mailWaiters.get(session.id) === waiter) {
          this.mailWaiters.delete(session.id);
        }
        jsonResponse(res, 200, { messages });
      },
    };
    const timer = setTimeout(() => {
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

    res.on('close', () => {
      if (this.mailWaiters.get(session.id) !== waiter) return;
      settled = true;
      clearTimeout(timer);
      this.mailWaiters.delete(session.id);
    });
  }

  // Debounced wake-up for mail that no long-poll consumed: after 5s, if it is still
  // undelivered and the session is running, inject a one-line pointer to the
  // harness mail command. At most one nudge per session per 30s; senders coalesce.
  private scheduleMailNudge(sessionId: string, fromLabel: string, delayMs = MAIL_NUDGE_DELAY_MS): void {
    this.pendingNudgeFrom.set(sessionId, fromLabel);
    if (this.nudgeTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.nudgeTimers.delete(sessionId);
      this.fireMailNudge(sessionId).catch((err) => {
        console.error('[LocalApiServer] Mail nudge failed:', err instanceof Error ? err.message : String(err));
      });
    }, delayMs);
    timer.unref();
    this.nudgeTimers.set(sessionId, timer);
  }

  /** A session earns the Stop-hook listen window only if mail can plausibly
   *  arrive: it has a parent, has children, was marked an orchestrator, or has
   *  exchanged mail before. */
  private async participatesInMail(session: Session): Promise<boolean> {
    if (session.parentSessionId) return true;
    if (session.env?.FTOWN_ORCHESTRATOR === '1') return true;
    if (!this.store || !this.mailStore) return false;
    const sessions = await this.store.listSessions();
    if (sessions.some((s) => s.parentSessionId === session.id)) return true;
    const history = await this.mailStore.listAll(session.id, 1);
    return history.length > 0;
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
    if (busySince !== undefined && Date.now() - busySince < AGENT_BUSY_STALE_MS) {
      this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_BUSY_RECHECK_MS);
      return;
    }

    const sinceLast = Date.now() - (this.lastNudgeAt.get(sessionId) ?? 0);
    if (sinceLast < MAIL_NUDGE_MIN_INTERVAL_MS) {
      // Rate-limited: retry once the window reopens (mail may still be unread).
      this.scheduleMailNudge(sessionId, fromLabel, MAIL_NUDGE_MIN_INTERVAL_MS - sinceLast);
      return;
    }

    this.pendingNudgeFrom.delete(sessionId);
    if (!this.runner.isRunning(sessionId)) return;
    const session = await this.store.loadSession(sessionId);
    if (!session) return;

    this.lastNudgeAt.set(sessionId, Date.now());
    const text = sanitizeMessageText(
      `You have new ftown mail from ${fromLabel} — run \`~/.ftown/bin/ftown-harness mail read\` to read it.`,
    );
    await this.injectPtyLine(session, 'ftown-mail', text);
  }

  private handleHook(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const payload = JSON.parse(body) as Record<string, unknown>;

        const hookEventName = payload.hook_event_name as string | undefined;
        let ftownSessionId = payload.ftown_session_id as string | undefined;
        // notify.sh reports how it attributed the session id.
        let source = typeof payload.ftown_session_source === 'string'
          ? payload.ftown_session_source
          : undefined;
        if (!ftownSessionId) {
          const resolved = resolveSessionIdFromHookPayload(payload);
          ftownSessionId = resolved?.sessionId;
          source = resolved?.source;
        }

        if (!ftownSessionId || !hookEventName) {
          res.writeHead(200);
          res.end('{"ok":true}');
          return;
        }

        if (hookEventName === 'UserPromptSubmit' || hookEventName === 'PreToolUse' || hookEventName === 'PostToolUse') {
          this.agentBusySince.set(ftownSessionId, Date.now());
        } else if (hookEventName === 'Stop' || hookEventName === 'SessionEnd') {
          this.agentBusySince.delete(ftownSessionId);
        }

        const conversationId = payload.conversation_id;
        // Workspace attribution may belong to a foreign agent running in the
        // same directory; never let it claim the conversation mapping.
        if (typeof conversationId === 'string' && conversationId && source !== 'workspace') {
          registerSessionConversation(ftownSessionId, conversationId);
        }

        console.log(`[LocalApiServer] Received ${hookEventName} for ftown session ${ftownSessionId}`);

        const { ftown_session_id: _, ftown_session_source: __, ...rest } = payload;

        const hookEvent: HookEvent = {
          sessionId: ftownSessionId,
          eventName: hookEventName,
          data: rest as Record<string, unknown>,
          source,
        };

        this.emit('event', hookEvent);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (err) {
        console.error('[LocalApiServer] Failed to parse hook payload:', err instanceof Error ? err.message : String(err));
        res.writeHead(400);
        res.end();
      }
    });

    req.on('error', (err: Error) => {
      console.error('[LocalApiServer] Request error:', err.message);
      res.writeHead(500);
      res.end();
    });
  }
}
