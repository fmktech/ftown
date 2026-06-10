import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { timingSafeEqual } from 'node:crypto';

import type { Server, IncomingMessage, ServerResponse } from 'node:http';

import type { SessionStore } from './session-store.js';
import type { ShellType } from './types.js';
import type { ProcessRunner } from './claude-runner.js';
import type { CentrifugoClient } from './centrifugo-client.js';
import type { TerminalManager } from './terminal-manager.js';
import { registerSessionConversation, resolveSessionIdFromHookPayload } from './session-registry.js';
import {
  createFtownSession,
  parseCreateSessionBody,
  type CreateFtownSessionDeps,
} from './create-ftown-session.js';

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
  private userId: string = '';
  private authToken: string = '';
  private port: number = 0;

  setAuthToken(token: string): void {
    this.authToken = token;
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
      jsonResponse(res, 200, { sessions });
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
        jsonResponse(res, 201, { session });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message === 'Parent session not found' ? 400 : 500;
        jsonResponse(res, status, { error: message });
      }
      return;
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    const sessionScreenMatch = path.match(/^\/api\/sessions\/([^/]+)\/screen$/);
    const sessionGrepMatch = path.match(/^\/api\/sessions\/([^/]+)\/grep$/);
    const sessionKeysMatch = path.match(/^\/api\/sessions\/([^/]+)\/keys$/);
    const sessionMessageMatch = path.match(/^\/api\/sessions\/([^/]+)\/message$/);
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
      jsonResponse(res, 200, { session });
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

      jsonResponse(res, 200, { session });
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

      // Plain shells would execute the message as a command; deliver it as a quoted no-op
      // (`: '...'`) — interactive zsh has no '#' comments by default.
      const isAgent = session.shellType && session.shellType !== 'shell';
      const line = isAgent
        ? `[ftown msg from ${sender}] ${text}`
        : `: '[ftown msg from ${sender}] ${text.replace(/'/g, '')}'`;
      const wrote = this.runner.write(sessionId, line);
      if (!wrote) {
        jsonResponse(res, 409, { error: 'Session not running' });
        return;
      }
      // Composer TUIs detect pastes by input arrival rate; the submit CR must come well
      // after that window or it is treated as a pasted newline.
      await delay(600);
      this.runner.write(sessionId, submitSuffixFor(session.shellType));

      jsonResponse(res, 200, { delivered: true, sessionId, from: sender });
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
