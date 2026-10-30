import { AUTOMATION_REMOVED_CODE, AUTOMATION_REMOVED_MESSAGE, isRetiredAutomationSession } from './retired-automation.js';
import {
  createFtownSession,
  relaunchFtownSession,
  type CreateFtownSessionDeps,
  type CreateFtownSessionInput,
} from './create-ftown-session.js';

import type { RemoveFtownSessionOptions } from './remove-ftown-session.js';
import type { Session, SessionUsage } from './types.js';
import { normalizePullRequestUrl } from './pull-request-url.js';
import { currentPreview, preparePreview, PreviewError, previewChunk, previewStatus, SessionPreviewReader, validPreviewId, validRevision } from './session-preview.js';
import type { SessionPreviewChunk, SessionPreviewSource, SessionPreviewStatus } from './preview-protocol.js';
import { PREVIEW_CHUNK_BYTES } from './preview-protocol.js';

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

export type SessionErrorCode = 'not_found' | 'invalid' | 'too_large' | 'conflict' | typeof AUTOMATION_REMOVED_CODE;

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
  pullRequestUrl?: string | null;
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
  previewReader?: SessionPreviewReader;
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
  private readonly metadataWrites = new Map<string, Promise<void>>();
  private readonly previewReader: SessionPreviewReader;

  constructor(deps: SessionControllerDeps) {
    this.deps = deps;
    this.previewReader = deps.previewReader ?? new SessionPreviewReader();
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
   * Per-session token/cost usage. Returns the persisted snapshot for terminal
   * sessions; live sessions are always recollected because their totals are
   * still moving (including a retried session with an older snapshot). An on-demand result is
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
    const isTerminal = session.status === 'completed' || session.status === 'error';
    if (session.usage && isTerminal) {
      return { ok: true, usage: session.usage };
    }
    const collect = this.deps.collectUsage;
    if (!collect) {
      return { ok: true, usage: session.usage ?? null };
    }
    const usage = await collect(session);
    if (usage && isTerminal) await this.withSessionMutation(sessionId, async () => {
      const fresh = await this.deps.store.loadSession(sessionId);
      if (!fresh || (fresh.status !== 'completed' && fresh.status !== 'error')) return;
      fresh.usage = usage;
      fresh.updatedAt = new Date().toISOString();
      await this.deps.store.saveSession(fresh);
      await this.deps.publishSessionUpdate(fresh);
    });
    return { ok: true, usage: usage ?? session.usage ?? null };
  }

  /** Collect several sessions behind one transport request. Missing sessions are omitted. */
  async usages(sessionIds: string[]): Promise<Record<string, SessionUsage | null>> {
    const entries = await Promise.all(
      Array.from(new Set(sessionIds)).map(async (sessionId) => {
        const result = await this.usage(sessionId);
        return result.ok ? ([sessionId, result.usage] as const) : null;
      }),
    );
    return Object.fromEntries(entries.filter((entry) => entry !== null));
  }

  /** Re-run a finished/dead session's stored command verbatim. */
  async retry(sessionId: string): Promise<SessionControllerResult<{ session: Session }>> {
    return this.withSessionMutation(sessionId, async () => {
    const existingSession = await this.deps.store.loadSession(sessionId);
    if (!existingSession) {
      return { ok: false, code: 'not_found', message: 'Session not found' };
    }
    if (isRetiredAutomationSession(existingSession)) {
      return { ok: false, code: AUTOMATION_REMOVED_CODE, message: AUTOMATION_REMOVED_MESSAGE };
    }
    if (existingSession.status === 'running') {
      return { ok: false, code: 'conflict', message: 'Session is already running' };
    }
    if (!existingSession.command) {
      return { ok: false, code: 'invalid', message: 'Session has no command (created before v0.2.0)' };
    }

    const factory = this.require(this.deps.sessionFactory, 'sessionFactory');
    await relaunchFtownSession(factory, existingSession, 'retry');
    return { ok: true, session: existingSession };
    });
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
    return this.withSessionMutation(sessionId, () => this.updateMetadata(sessionId, input));
  }

  private async withSessionMutation<T>(sessionId: string, update: () => Promise<T>): Promise<T> {
    if (this.deps.withSessionWrite) {
      let result!: T;
      await this.deps.withSessionWrite(sessionId, async () => { result = await update(); });
      return result;
    }
    const previous = this.metadataWrites.get(sessionId) ?? Promise.resolve();
    const next = previous.then(update, update);
    const settled = next.then(() => undefined, () => undefined);
    this.metadataWrites.set(sessionId, settled);
    try { return await next; }
    finally { if (this.metadataWrites.get(sessionId) === settled) this.metadataWrites.delete(sessionId); }
  }

  private async updateMetadata(
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
    }

    let pullRequestUrl: string | undefined;
    if (input.pullRequestUrl !== undefined && input.pullRequestUrl !== null) {
      try { pullRequestUrl = normalizePullRequestUrl(input.pullRequestUrl); }
      catch { return { ok: false, code: 'invalid', message: 'Invalid pullRequestUrl' }; }
    }
    let parentSessionId: string | undefined;
    if (input.parent) {
      const raw = input.parent.value;
      if (raw === null || raw === undefined || raw === '') {
        parentSessionId = undefined;
      } else if (typeof raw !== 'string') {
        return { ok: false, code: 'invalid', message: 'Invalid parentSessionId' };
      } else if (raw === session.id) {
        return { ok: false, code: 'invalid', message: 'Session cannot be its own parent' };
      } else {
        const proposed = await this.deps.store.loadSession(raw);
        if (!proposed) {
          return { ok: false, code: 'invalid', message: 'Parent session not found' };
        }
        if (proposed.bridgeId !== session.bridgeId) {
          return {
            ok: false,
            code: 'invalid',
            message: 'Parent session belongs to another bridge',
          };
        }
        parentSessionId = proposed.parentSessionId ?? proposed.id;
        if (parentSessionId === session.id) {
          return {
            ok: false,
            code: 'invalid',
            message: 'Session cannot be parented under its own descendant',
          };
        }
        const sessions = await this.deps.store.listSessions();
        if (sessions.some((candidate) => candidate.parentSessionId === session.id)) {
          return {
            ok: false,
            code: 'invalid',
            message: 'Session with children cannot be reparented',
          };
        }
      }
    }

    // Validate the entire update before touching the loaded object: some store
    // implementations return shared references rather than detached snapshots.
    if (input.name !== undefined) session.name = input.name;
    if (input.parent) session.parentSessionId = parentSessionId;
    if (input.pullRequestUrl === null) delete session.pullRequestUrl;
    else if (pullRequestUrl !== undefined) session.pullRequestUrl = pullRequestUrl;
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
    return this.withSessionMutation(sessionId, async () => {
      const removed = await this.deps.removeSession(sessionId, options);
      return { removed: removed !== null };
    });
  }

  async setPreview(sessionId: string, path: unknown): Promise<SessionControllerResult<{ session: Session }>> {
    return this.withSessionMutation(sessionId, async () => {
      const session = await this.deps.store.loadSession(sessionId);
      if (!session) return { ok: false, code: 'not_found', message: 'Session not found' };
      try {
        const prepared = await preparePreview(session, path);
        session.preview = prepared.preview; session.previewSource = prepared.previewSource;
        session.updatedAt = new Date().toISOString();
        await this.deps.store.saveSession(session);
        await this.deps.publishSessionUpdate(session);
        return { ok: true, session };
      } catch (error) {
        if (error instanceof PreviewError) return { ok: false, code: error.reason === 'too_large' ? 'too_large' : 'invalid', message: 'Invalid preview file' };
        throw error;
      }
    });
  }

  async clearPreview(sessionId: string): Promise<SessionControllerResult<{ session: Session }>> {
    return this.withSessionMutation(sessionId, async () => {
      const session = await this.deps.store.loadSession(sessionId);
      if (!session) return { ok: false, code: 'not_found', message: 'Session not found' };
      delete session.preview; delete session.previewSource;
      session.updatedAt = new Date().toISOString();
      await this.deps.store.saveSession(session); await this.deps.publishSessionUpdate(session);
      return { ok: true, session };
    });
  }

  private async previewSnapshot(sessionId: string, previewId: string): Promise<{ session: Session; source: SessionPreviewSource | null } | null> {
    return this.withSessionMutation(sessionId, async () => {
      const session = await this.deps.store.loadSession(sessionId);
      if (!session) return null;
      const source = currentPreview(session, previewId);
      return { session, source };
    });
  }

  async getPreviewStatus(sessionId: string, previewId: string, knownRevision?: string): Promise<SessionControllerResult<{ preview: SessionPreviewStatus }>> {
    if (!validPreviewId(previewId) || (knownRevision !== undefined && !validRevision(knownRevision))) return { ok: false, code: 'invalid', message: 'Invalid preview request' };
    const selected = await this.previewSnapshot(sessionId, previewId);
    if (!selected) return { ok: false, code: 'not_found', message: 'Session not found' };
    if (!selected.source) return { ok: true, preview: { state: 'unregistered' } };
    try {
      const data = await this.previewReader.read(selected.session, selected.source);
      const current = await this.previewSnapshot(sessionId, previewId);
      if (!current?.source || current.session.workingDir !== selected.session.workingDir || JSON.stringify(current.source) !== JSON.stringify(selected.source)) return { ok: true, preview: { state: 'unregistered' } };
      return { ok: true, preview: previewStatus(previewId, data, knownRevision) };
    } catch (error) {
      const current = await this.previewSnapshot(sessionId, previewId);
      if (!current?.source || current.session.workingDir !== selected.session.workingDir || JSON.stringify(current.source) !== JSON.stringify(selected.source)) return { ok: true, preview: { state: 'unregistered' } };
      return { ok: true, preview: { state: 'unavailable', previewId, reason: error instanceof PreviewError ? error.reason : 'unavailable' } };
    }
  }

  async getPreviewChunk(sessionId: string, previewId: string, revision: string, offset: number): Promise<SessionControllerResult<{ preview: SessionPreviewChunk }>> {
    if (!validPreviewId(previewId) || !validRevision(revision) || !Number.isSafeInteger(offset) || offset < 0 || offset % PREVIEW_CHUNK_BYTES !== 0) return { ok: false, code: 'invalid', message: 'Invalid preview request' };
    const selected = await this.previewSnapshot(sessionId, previewId);
    if (!selected) return { ok: false, code: 'not_found', message: 'Session not found' };
    if (!selected.source) return { ok: true, preview: { state: 'stale_revision' } };
    try {
      const data = await this.previewReader.read(selected.session, selected.source);
      const current = await this.previewSnapshot(sessionId, previewId);
      if (!current?.source || current.session.workingDir !== selected.session.workingDir || JSON.stringify(current.source) !== JSON.stringify(selected.source)) return { ok: true, preview: { state: 'stale_revision' } };
      if (data.revision === revision && (data.bytes.length === 0 ? offset !== 0 : offset >= data.bytes.length)) return { ok: false, code: 'invalid', message: 'Invalid preview request' };
      return { ok: true, preview: previewChunk(previewId, data, revision, offset) };
    } catch (error) {
      const current = await this.previewSnapshot(sessionId, previewId);
      if (!current?.source || current.session.workingDir !== selected.session.workingDir || JSON.stringify(current.source) !== JSON.stringify(selected.source)) return { ok: true, preview: { state: 'stale_revision' } };
      return { ok: true, preview: { state: 'unavailable', previewId, reason: error instanceof PreviewError ? error.reason : 'unavailable' } };
    }
  }

  /** Flush pending output, wipe the persisted log, drop the live buffer. */
  async clearTerminal(sessionId: string): Promise<{ cleared: true }> {
    this.require(this.deps.flushTerminalBuffer, 'flushTerminalBuffer')(sessionId);
    await this.deps.store.clearTerminalLog(sessionId);
    this.require(this.deps.destroyTerminal, 'destroyTerminal')(sessionId);
    return { cleared: true };
  }
}
