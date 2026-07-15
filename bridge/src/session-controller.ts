import {
  createFtownSession,
  relaunchFtownSession,
  type CreateFtownSessionDeps,
  type CreateFtownSessionInput,
} from './create-ftown-session.js';

import type { RemoveFtownSessionOptions } from './remove-ftown-session.js';
import type { Session, SessionUsage } from './types.js';

/**
 * Transport-agnostic session operations, defined ONCE and shared by the two
 * dispatch surfaces (the Centrifugo RPC switch in index.ts and the local HTTP
 * router in local-api-server.ts). Methods take already-parsed typed input and
 * return typed results/errors; the adapters own all wire concerns (command
 * envelopes, HTTP statuses, toWireSession payload shaping).
 *
 * Error-propagation contract (matches the pre-refactor adapters byte for byte):
 * - `create` and `retry` let ProviderAuthMissingError / WorkingDirMissingError /
 *   generic Errors THROW — each adapter already owns a per-error-class mapping
 *   (RPC outer catch with the working-dir data envelope; HTTP 422/400/500).
 * - State/lookup failures return typed `{ ok: false, code, message }` results.
 */

export type SessionErrorCode = 'not_found' | 'invalid' | 'conflict';

export interface SessionControllerError {
  ok: false;
  code: SessionErrorCode;
  message: string;
}

export type SessionControllerResult<T> = ({ ok: true } & T) | SessionControllerError;

/** Combined rename/reparent input. `parent` PRESENT means "reparent"; a value
 * of null/undefined/'' clears the parent (both dispatchers treat all three as
 * clear). `value` is unknown so adapters can hand over unvalidated wire input. */
export interface SessionUpdateInput {
  name?: string;
  parent?: { value: unknown };
}

/** Narrow structural slice of SessionStore so tests can use in-memory fakes. */
export interface SessionStoreLike {
  loadSession(sessionId: string): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  listSessions(): Promise<Session[]>;
  clearTerminalLog(sessionId: string): Promise<void>;
}

export interface SessionControllerDeps {
  store: SessionStoreLike;
  runner: { stop(sessionId: string): boolean };
  publishSessionUpdate(session: Session): Promise<void>;
  /** removeFtownSession closed over its dep bundle. Returns the removed
   * session, or null when nothing was removed (unknown id, or the
   * onlyIfFinished guard rejected it). */
  removeSession(
    sessionId: string,
    options?: RemoveFtownSessionOptions,
  ): Promise<Session | null>;
  /** Full factory bundle, required by create/retry only. */
  sessionFactory?: CreateFtownSessionDeps;
  /** Optional: extract token/cost usage from harness-native session files.
   * Required only by usage(); omitted in adapters that never call it. */
  collectUsage?(session: Session): Promise<SessionUsage | null>;
  // ---- Runtime closures still owned by index.ts. They are injected rather
  // than restructured out of index.ts (a later task splits that file); only
  // stop/clearTerminal need them, so the HTTP adapter may omit them.
  publishSyntheticStop?(sessionId: string, reason: 'complete' | 'error' | 'stopped'): void;
  withSessionWrite?(sessionId: string, task: () => Promise<void>): Promise<void>;
  unregisterSession?(sessionId: string): void;
  flushTerminalBuffer?(sessionId: string): void;
  destroyTerminal?(sessionId: string): void;
}

export class SessionController {
  private readonly deps: SessionControllerDeps;

  constructor(deps: SessionControllerDeps) {
    this.deps = deps;
  }

  private require<T>(dep: T | undefined, name: string): T {
    if (dep === undefined) {
      throw new Error(`SessionController: ${name} dependency not wired`);
    }
    return dep;
  }

  /** Create + launch a session. Throws (see class doc) — adapters map errors. */
  async create(input: CreateFtownSessionInput): Promise<Session> {
    const factory = this.require(this.deps.sessionFactory, 'sessionFactory');
    return createFtownSession(factory, input);
  }

  /** Stop a running session and persist/publish its completed state. */
  async stop(sessionId: string): Promise<{ stopped: boolean }> {
    const stopped = this.deps.runner.stop(sessionId);
    if (stopped) {
      this.require(this.deps.publishSyntheticStop, 'publishSyntheticStop')(sessionId, 'stopped');
      await this.require(this.deps.withSessionWrite, 'withSessionWrite')(sessionId, async () => {
        const session = await this.deps.store.loadSession(sessionId);
        if (session) {
          session.status = 'completed';
          session.updatedAt = new Date().toISOString();
          await this.deps.store.saveSession(session);
          await this.deps.publishSessionUpdate(session);
        }
      });
      this.require(this.deps.unregisterSession, 'unregisterSession')(sessionId);
    }
    return { stopped };
  }

  list(): Promise<Session[]> {
    return this.deps.store.listSessions();
  }

  get(sessionId: string): Promise<Session | null> {
    return this.deps.store.loadSession(sessionId);
  }

  /**
   * Per-session token/cost usage. Returns the persisted snapshot when
   * present; otherwise collects on demand (covers live sessions and sessions
   * that finished before usage collection existed). An on-demand result is
   * persisted + published only when the session is terminal — a live
   * session's numbers are still moving, so caching them would go stale.
   */
  async usage(
    sessionId: string,
  ): Promise<SessionControllerResult<{ usage: SessionUsage | null }>> {
    const session = await this.deps.store.loadSession(sessionId);
    if (!session) {
      return { ok: false, code: 'not_found', message: 'Session not found' };
    }
    if (session.usage) {
      return { ok: true, usage: session.usage };
    }
    const collect = this.deps.collectUsage;
    if (!collect) {
      return { ok: true, usage: null };
    }
    const usage = await collect(session);
    if (usage && (session.status === 'completed' || session.status === 'error')) {
      session.usage = usage;
      session.updatedAt = new Date().toISOString();
      await this.deps.store.saveSession(session);
      await this.deps.publishSessionUpdate(session);
    }
    return { ok: true, usage };
  }

  /** Re-run a finished/dead session's stored command verbatim. */
  async retry(sessionId: string): Promise<SessionControllerResult<{ session: Session }>> {
    const factory = this.require(this.deps.sessionFactory, 'sessionFactory');

    const existingSession = await this.deps.store.loadSession(sessionId);
    if (!existingSession) {
      return { ok: false, code: 'not_found', message: 'Session not found' };
    }
    if (existingSession.status === 'running') {
      return { ok: false, code: 'conflict', message: 'Session is already running' };
    }
    if (!existingSession.command) {
      return { ok: false, code: 'invalid', message: 'Session has no command (created before v0.2.0)' };
    }

    await relaunchFtownSession(factory, existingSession, 'retry');
    return { ok: true, session: existingSession };
  }

  /**
   * Rename and/or reparent in ONE load-mutate-save-publish pass (the HTTP
   * PATCH route updates both fields atomically; the RPC adapter calls with a
   * single field). Reparenting flattens to the proposed parent's root so
   * session trees stay one level deep.
   */
  async update(
    sessionId: string,
    input: SessionUpdateInput,
  ): Promise<SessionControllerResult<{ session: Session }>> {
    const session = await this.deps.store.loadSession(sessionId);
    if (!session) {
      return { ok: false, code: 'not_found', message: 'Session not found' };
    }

    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name) {
        return { ok: false, code: 'invalid', message: 'Invalid name' };
      }
      session.name = input.name;
    }

    if (input.parent) {
      const raw = input.parent.value;
      if (raw === null || raw === undefined || raw === '') {
        session.parentSessionId = undefined;
      } else if (typeof raw !== 'string') {
        return { ok: false, code: 'invalid', message: 'Invalid parentSessionId' };
      } else if (raw === session.id) {
        return { ok: false, code: 'invalid', message: 'Session cannot be its own parent' };
      } else {
        const proposed = await this.deps.store.loadSession(raw);
        if (!proposed) {
          return { ok: false, code: 'invalid', message: 'Parent session not found' };
        }
        session.parentSessionId = proposed.parentSessionId ?? proposed.id;
      }
    }

    session.updatedAt = new Date().toISOString();
    await this.deps.store.saveSession(session);
    await this.deps.publishSessionUpdate(session);

    return { ok: true, session };
  }

  /** Remove (archive + delete + publish removed). removed=false when nothing
   * was removed — unknown id, or the onlyIfFinished guard rejected it. */
  async remove(
    sessionId: string,
    options?: RemoveFtownSessionOptions,
  ): Promise<{ removed: boolean }> {
    const removed = await this.deps.removeSession(sessionId, options);
    return { removed: removed !== null };
  }

  /** Flush pending output, wipe the persisted log, drop the live buffer. */
  async clearTerminal(sessionId: string): Promise<{ cleared: true }> {
    this.require(this.deps.flushTerminalBuffer, 'flushTerminalBuffer')(sessionId);
    await this.deps.store.clearTerminalLog(sessionId);
    this.require(this.deps.destroyTerminal, 'destroyTerminal')(sessionId);
    return { cleared: true };
  }
}
