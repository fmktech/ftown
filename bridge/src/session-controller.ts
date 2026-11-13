import { randomUUID } from 'node:crypto';

import { AUTOMATION_REMOVED_CODE, AUTOMATION_REMOVED_MESSAGE, isRetiredAutomationSession } from './retired-automation.js';
import {
  createFtownSession,
  relaunchFtownSession,
  type CreateFtownSessionDeps,
  type CreateFtownSessionInput,
} from './create-ftown-session.js';

import type { RemoveFtownSessionOptions } from './remove-ftown-session.js';
import type { Session, SessionUsage } from './types.js';
import type { WorktreeApi } from './coordination/contract-b.js';
import { GitWorktrees } from './worktrees.js';
import { normalizePullRequestUrl } from './pull-request-url.js';
import { currentPreview, preparePreview, preparePreviewAdd, PreviewError, previewChunk, previewStatus, SessionPreviewReader, validFileId, validPreviewId, validRevision } from './session-preview.js';
import type { SessionPreviewChunk, SessionPreviewSource, SessionPreviewStatus } from './preview-protocol.js';
import { PREVIEW_CHUNK_BYTES } from './preview-protocol.js';
import { PreviewChatError, PreviewChatStore, validateChatInput } from './preview-chat.js';
import { PREVIEW_CHAT_AGENT_SHELLS } from './preview-chat-protocol.js';
import type { PreviewChatErrorCode, PreviewChatInput, PreviewChatPage, PreviewChatWriteResult } from './preview-chat-protocol.js';
import type { AcceptMailResult } from './mail-delivery.js';

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
  previewChat?: PreviewChatStore;
  previewChatBridgeId?: string;
  previewChatRunning?(sessionId: string): boolean;
  enqueuePreviewChat?(session: Session, text: string): Promise<AcceptMailResult>;
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
  worktrees?: WorktreeApi;
  // ---- Runtime closures still owned by index.ts. They are injected rather
  // than restructured out of index.ts (a later task splits that file); only
  // stop/clearTerminal need them, so the HTTP adapter may omit them.
  publishSyntheticStop?(sessionId: string, reason: 'complete' | 'error' | 'stopped'): void;
  withSessionWrite?(sessionId: string, task: () => Promise<void>): Promise<void>;
  unregisterSession?(sessionId: string): void;
  flushTerminalBuffer?(sessionId: string): void;
  destroyTerminal?(sessionId: string): void;
  /**
   * Live session, after a successful stop and immediately before archive/remove.
   * Must run before the store record is deleted: the exit handler cannot reload it.
   */
  onSessionEnding?(session: Session): Promise<void>;
}

export type WorktreeRemoveMode = 'auto' | 'keep' | 'force';

export interface WorktreeRemoveOutcome {
  action: 'removed' | 'retained' | 'none';
  reason?: string;
}

export class SessionController {
  private readonly deps: SessionControllerDeps;
  private readonly metadataWrites = new Map<string, Promise<void>>();
  private readonly previewReader: SessionPreviewReader;
  private readonly worktrees: WorktreeApi;

  constructor(deps: SessionControllerDeps) {
    this.deps = deps;
    this.previewReader = deps.previewReader ?? new SessionPreviewReader();
    this.worktrees = deps.worktrees ?? new GitWorktrees();
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
      let ended: Session | undefined;
      await this.require(this.deps.withSessionWrite, 'withSessionWrite')(sessionId, async () => {
        const session = await this.deps.store.loadSession(sessionId);
        if (session) {
          session.status = 'completed';
          session.updatedAt = new Date().toISOString();
          await this.deps.store.saveSession(session);
          await this.deps.publishSessionUpdate(session);
          ended = session;
        }
      });
      if (ended) await this.noteSessionEnding(ended);
      this.require(this.deps.unregisterSession, 'unregisterSession')(sessionId);
    }
    return { stopped };
  }

  /** Best-effort. A failure here must not block stop or archive. */
  private async noteSessionEnding(session: Session): Promise<void> {
    if (!this.deps.onSessionEnding) return;
    try {
      await this.deps.onSessionEnding(session);
    } catch (error) {
      console.warn(
        '[SessionController] Failed to escalate attention before session ended:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  list(): Promise<Session[]> {
    return this.deps.store.listSessions();
  }

  get(sessionId: string): Promise<Session | null> {
    return this.deps.store.loadSession(sessionId);
  }

  private async chat<T>(sessionId: string, task: (store: PreviewChatStore, session: Session) => Promise<T>): Promise<({ ok: true } & T) | { ok: false; code: PreviewChatErrorCode; message: string }> {
    try {
      return await this.withSessionMutation(sessionId, async () => {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new PreviewChatError('invalid', 'Invalid session');
        const session = await this.deps.store.loadSession(sessionId);
        if (!session) throw new PreviewChatError('not_found', 'Session not found');
        if (!this.deps.previewChat || !this.deps.previewChatBridgeId) throw new PreviewChatError('unavailable', 'Conversation unavailable');
        if (session.bridgeId !== this.deps.previewChatBridgeId) throw new PreviewChatError('not_found', 'Session not found');
        return { ok: true as const, ...await task(this.deps.previewChat, session) };
      });
    } catch (error) {
      return { ok: false, code: error instanceof PreviewChatError ? error.code : 'unavailable', message: error instanceof PreviewChatError ? error.message : 'Conversation unavailable' };
    }
  }
  listPreviewChat(sessionId: string, cursor?: string): Promise<({ ok: true; page: PreviewChatPage }) | { ok: false; code: PreviewChatErrorCode; message: string }> {
    return this.chat(sessionId, async store => ({ page: await store.list(sessionId, cursor) }));
  }
  sendPreviewChat(sessionId: string, input: PreviewChatInput): Promise<({ ok: true; result: PreviewChatWriteResult }) | { ok: false; code: PreviewChatErrorCode; message: string }> {
    return this.chat(sessionId, async (store, session) => {
      validateChatInput(input);
      const existing = await store.find(sessionId, input, 'user');
      if (existing) return { result: { sessionId, turn: existing } };
      if (!session.shellType || !PREVIEW_CHAT_AGENT_SHELLS.some(type => type === session.shellType)) throw new PreviewChatError('unsupported', 'Conversation is unavailable for this session');
      if (session.status !== 'running' || !this.deps.previewChatRunning?.(sessionId)) throw new PreviewChatError('not_running', 'Session is not running');
      if (!this.deps.enqueuePreviewChat) throw new PreviewChatError('unavailable', 'Conversation unavailable');
      const turn = await store.reserve(sessionId, input, 'user');
      try {
        const mail = await this.deps.enqueuePreviewChat(session, `${input.text}\n\nReply to the preview conversation with: ftown sessions preview-reply --message <your reply>`);
        if (mail.ok) return { result: { sessionId, turn: await store.markQueued(sessionId, input.id) } };
      } catch { /* Reservation prevents unsafe retry after uncertain delivery. */ }
      return { result: { sessionId, turn } };
    });
  }
  replyPreviewChat(sessionId: string, input: PreviewChatInput): Promise<({ ok: true; result: PreviewChatWriteResult }) | { ok: false; code: PreviewChatErrorCode; message: string }> {
    return this.chat(sessionId, async store => ({ result: { sessionId, turn: await store.reserve(sessionId, input, 'agent') } }));
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
    if (input.pullRequestUrl === null) { delete session.pullRequestUrl; delete session.pullRequestLinkId; }
    else if (pullRequestUrl !== undefined) {
      if (session.pullRequestUrl?.toLowerCase() !== pullRequestUrl.toLowerCase() || !session.pullRequestLinkId) session.pullRequestLinkId = randomUUID();
      session.pullRequestUrl = pullRequestUrl;
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
    worktreeMode: WorktreeRemoveMode = 'auto',
  ): Promise<{
    removed: boolean;
    worktreeOutcome?: WorktreeRemoveOutcome;
  }> {
    return this.withSessionMutation(sessionId, async () => {
      const session = await this.deps.store.loadSession(sessionId);
      if (
        !session ||
        (options?.onlyIfFinished &&
          session.status !== 'completed' &&
          session.status !== 'error')
      ) {
        const removed = await this.deps.removeSession(sessionId, options);
        return { removed: removed !== null };
      }

      let worktreeOutcome: WorktreeRemoveOutcome | undefined;

      if (session.worktree?.createdByBridge) {
        this.deps.runner.stop(sessionId);
        const wt = session.worktree;
        if (worktreeMode === 'keep') {
          worktreeOutcome = { action: 'retained', reason: 'kept by request' };
        } else {
          try {
            if (worktreeMode === 'force') {
              let deleteBranch = false;
              try {
                const st = await this.worktrees.status(wt);
                deleteBranch = st.mergedIntoBase;
              } catch {
                deleteBranch = false;
              }
              await this.worktrees.remove(wt, {
                force: true,
                deleteBranch,
              });
              worktreeOutcome = { action: 'removed' };
            } else {
              const st = await this.worktrees.status(wt);
              const decision = this.worktrees.decide(st);
              if (decision.action === 'remove') {
                await this.worktrees.remove(wt, {
                  force: false,
                  deleteBranch: decision.deleteBranch,
                });
                worktreeOutcome = { action: 'removed' };
              } else {
                worktreeOutcome = { action: 'retained', reason: decision.reason };
              }
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            worktreeOutcome = { action: 'retained', reason };
          }
        }

        if (worktreeOutcome.action === 'removed') {
          // list/prune read the archived tombstone. A removed worktree left on
          // that record shows up as "retained: worktree missing".
          delete session.worktree;
          await this.deps.store.saveSession(session);
        } else if (worktreeOutcome.action === 'retained' && worktreeOutcome.reason !== undefined) {
          session.worktree = {
            ...wt,
            retained: {
              reason: worktreeOutcome.reason,
              at: new Date().toISOString(),
            },
          };
          await this.deps.store.saveSession(session);
        }
      }

      await this.noteSessionEnding(session);
      const removed = await this.deps.removeSession(sessionId, options);
      if (!removed) {
        return { removed: false };
      }
      return worktreeOutcome ? { removed: true, worktreeOutcome } : { removed: true };
    });
  }

  async setPreview(sessionId: string, paths: unknown): Promise<SessionControllerResult<{ session: Session }>> {
    return this.withSessionMutation(sessionId, async () => {
      const session = await this.deps.store.loadSession(sessionId);
      if (!session) return { ok: false, code: 'not_found', message: 'Session not found' };
      try {
        const prepared = await preparePreview(session, paths);
        session.preview = prepared.preview; session.previewSource = prepared.previewSource;
        session.updatedAt = new Date().toISOString();
        await this.deps.store.saveSession(session);
        await this.deps.publishSessionUpdate(session);
        return { ok: true, session };
      } catch (error) {
        if (error instanceof PreviewError) return { ok: false, code: error.reason === 'too_large' ? 'too_large' : 'invalid', message: error.message && error.message !== 'Preview unavailable' ? error.message : 'Invalid preview file' };
        throw error;
      }
    });
  }

  async addPreview(sessionId: string, paths: unknown): Promise<SessionControllerResult<{ session: Session }>> {
    return this.withSessionMutation(sessionId, async () => {
      const session = await this.deps.store.loadSession(sessionId);
      if (!session) return { ok: false, code: 'not_found', message: 'Session not found' };
      if (!Array.isArray(paths) || paths.length < 1) {
        return { ok: false, code: 'invalid', message: 'Invalid preview file' };
      }
      for (const entry of paths) {
        if (typeof entry !== 'string') {
          return { ok: false, code: 'invalid', message: 'Invalid preview file' };
        }
      }
      const added = paths as string[];
      const existing =
        session.preview && session.previewSource
          ? currentPreview(session, session.preview.id)
          : null;
      if (!existing || !session.preview || !session.workingDir) {
        try {
          const prepared = await preparePreview(session, added);
          session.preview = prepared.preview; session.previewSource = prepared.previewSource;
          session.updatedAt = new Date().toISOString();
          await this.deps.store.saveSession(session);
          await this.deps.publishSessionUpdate(session);
          return { ok: true, session };
        } catch (error) {
          if (error instanceof PreviewError) return { ok: false, code: error.reason === 'too_large' ? 'too_large' : 'invalid', message: error.message && error.message !== 'Preview unavailable' ? error.message : 'Invalid preview file' };
          throw error;
        }
      }
      // Merge path: preparePreviewAdd validates ONLY the incoming command-line
      // paths and carries existing entries over verbatim without re-validation.
      // Within-batch duplicates and the resulting-set cap are enforced there.
      try {
        const prepared = await preparePreviewAdd(session, { preview: session.preview, previewSource: existing }, added);
        session.preview = prepared.preview; session.previewSource = prepared.previewSource;
        session.updatedAt = new Date().toISOString();
        await this.deps.store.saveSession(session);
        await this.deps.publishSessionUpdate(session);
        return { ok: true, session };
      } catch (error) {
        if (error instanceof PreviewError) return { ok: false, code: error.reason === 'too_large' ? 'too_large' : 'invalid', message: error.message && error.message !== 'Preview unavailable' ? error.message : 'Invalid preview file' };
        throw error;
      }
    });
  }

  async removePreview(sessionId: string, names: unknown): Promise<SessionControllerResult<{ session: Session }>> {
    return this.withSessionMutation(sessionId, async () => {
      const session = await this.deps.store.loadSession(sessionId);
      if (!session) return { ok: false, code: 'not_found', message: 'Session not found' };
      if (!Array.isArray(names) || names.length < 1) {
        return { ok: false, code: 'invalid', message: 'Invalid preview file' };
      }
      for (const entry of names) {
        if (typeof entry !== 'string' || entry.length === 0) {
          return { ok: false, code: 'invalid', message: 'Invalid preview file' };
        }
      }
      const requested = names as string[];
      const existing =
        session.preview && session.previewSource
          ? currentPreview(session, session.preview.id)
          : null;
      if (!existing || !session.preview) {
        return { ok: false, code: 'invalid', message: `Preview file not found: ${requested[0]}` };
      }
      const descriptor = session.preview;
      const source: SessionPreviewSource = existing;
      const present = new Set(descriptor.files.map((file) => file.fileName));
      for (const name of requested) {
        if (!present.has(name)) {
          return { ok: false, code: 'invalid', message: `Preview file not found: ${name}` };
        }
      }
      const removeSet = new Set(requested);
      const remainingFiles = descriptor.files.filter((file) => !removeSet.has(file.fileName));
      if (remainingFiles.length === 0) {
        delete session.preview; delete session.previewSource;
        session.updatedAt = new Date().toISOString();
        await this.deps.store.saveSession(session);
        await this.deps.publishSessionUpdate(session);
        return { ok: true, session };
      }
      const remainingIds = new Set(remainingFiles.map((file) => file.id));
      const nextId = randomUUID();
      session.preview = { id: nextId, files: remainingFiles.map((file) => ({ id: file.id, fileName: file.fileName, kind: file.kind })) };
      session.previewSource = { version: 2, id: nextId, root: source.root, files: source.files.filter((file) => remainingIds.has(file.id)).map((file) => ({ id: file.id, filePath: file.filePath })) };
      session.updatedAt = new Date().toISOString();
      await this.deps.store.saveSession(session);
      await this.deps.publishSessionUpdate(session);
      return { ok: true, session };
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

  async getPreviewStatus(sessionId: string, previewId: string, fileId: string, knownRevision?: string): Promise<SessionControllerResult<{ preview: SessionPreviewStatus }>> {
    if (!validPreviewId(previewId) || !validFileId(fileId) || (knownRevision !== undefined && !validRevision(knownRevision))) return { ok: false, code: 'invalid', message: 'Invalid preview request' };
    const selected = await this.previewSnapshot(sessionId, previewId);
    if (!selected) return { ok: false, code: 'not_found', message: 'Session not found' };
    if (!selected.source || !selected.source.files.some((file) => file.id === fileId)) return { ok: true, preview: { state: 'unregistered' } };
    try {
      const data = await this.previewReader.read(selected.session, selected.source, fileId);
      const current = await this.previewSnapshot(sessionId, previewId);
      if (!current?.source || current.session.workingDir !== selected.session.workingDir || JSON.stringify(current.source) !== JSON.stringify(selected.source) || !current.source.files.some((file) => file.id === fileId)) return { ok: true, preview: { state: 'unregistered' } };
      return { ok: true, preview: previewStatus(previewId, fileId, data, knownRevision) };
    } catch (error) {
      const current = await this.previewSnapshot(sessionId, previewId);
      if (!current?.source || current.session.workingDir !== selected.session.workingDir || JSON.stringify(current.source) !== JSON.stringify(selected.source) || !current.source.files.some((file) => file.id === fileId)) return { ok: true, preview: { state: 'unregistered' } };
      return { ok: true, preview: { state: 'unavailable', previewId, fileId, reason: error instanceof PreviewError ? error.reason : 'unavailable' } };
    }
  }

  async getPreviewChunk(sessionId: string, previewId: string, fileId: string, revision: string, offset: number): Promise<SessionControllerResult<{ preview: SessionPreviewChunk }>> {
    if (!validPreviewId(previewId) || !validFileId(fileId) || !validRevision(revision) || !Number.isSafeInteger(offset) || offset < 0 || offset % PREVIEW_CHUNK_BYTES !== 0) return { ok: false, code: 'invalid', message: 'Invalid preview request' };
    const selected = await this.previewSnapshot(sessionId, previewId);
    if (!selected) return { ok: false, code: 'not_found', message: 'Session not found' };
    if (!selected.source || !selected.source.files.some((file) => file.id === fileId)) return { ok: true, preview: { state: 'stale_revision' } };
    try {
      const data = await this.previewReader.read(selected.session, selected.source, fileId);
      const current = await this.previewSnapshot(sessionId, previewId);
      if (!current?.source || current.session.workingDir !== selected.session.workingDir || JSON.stringify(current.source) !== JSON.stringify(selected.source) || !current.source.files.some((file) => file.id === fileId)) return { ok: true, preview: { state: 'stale_revision' } };
      if (data.revision === revision && (data.bytes.length === 0 ? offset !== 0 : offset >= data.bytes.length)) return { ok: false, code: 'invalid', message: 'Invalid preview request' };
      return { ok: true, preview: previewChunk(previewId, fileId, data, revision, offset) };
    } catch (error) {
      const current = await this.previewSnapshot(sessionId, previewId);
      if (!current?.source || current.session.workingDir !== selected.session.workingDir || JSON.stringify(current.source) !== JSON.stringify(selected.source) || !current.source.files.some((file) => file.id === fileId)) return { ok: true, preview: { state: 'stale_revision' } };
      return { ok: true, preview: { state: 'unavailable', previewId, fileId, reason: error instanceof PreviewError ? error.reason : 'unavailable' } };
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
