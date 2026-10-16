import { AUTOMATION_REMOVED_MESSAGE, isRetiredAutomationSession } from './retired-automation.js';
import type { Session } from './types.js';
import type { SessionStore } from './session-store.js';
import type { ProcessRunner } from './claude-runner.js';
import {
  canResumeStoredSession,
  findMissingProviderAuth,
  relaunchFtownSession,
  type CreateFtownSessionDeps,
} from './create-ftown-session.js';
import { loadProviderEnv } from './provider-env-store.js';
import { registerSessionWorkspace } from './session-registry.js';
import { isTmuxAvailable, killTmuxSession, listFtownTmuxSessions } from './tmux.js';

export function shouldResurrectStoredSession(session: Session): boolean {
  if (session.status !== 'running' && session.status !== 'pending') return false;
  return !isRetiredAutomationSession(session);
}

export interface SessionResurrectionDeps {
  store: Pick<SessionStore, 'listSessions' | 'listArchived' | 'loadSession' | 'saveSession'>;
  runner: ProcessRunner;
  bridgeId: string;
  sessionFactoryDeps: CreateFtownSessionDeps;
  publishSessionUpdate: (session: Session) => Promise<void>;
  wireTerminalInput: (sessionId: string) => void;
  /** Exact dedicated-socket operations; injectable without touching a live tmux server. */
  tmux?: {
    available(): boolean;
    list(): string[];
    kill(sessionId: string): Promise<boolean>;
  };
}

/**
 * Resurrection engine: on bridge start, sessions left in a live state by a
 * previous bridge are reattached (tmux), respawned (resume), or marked as
 * error. Historical loop-owned sessions are retired before ordinary resurrection.
 */
export class SessionResurrection {
  private started = false;

  constructor(private readonly deps: SessionResurrectionDeps) {}

  private async markSessionDead(session: Session, reason?: string): Promise<void> {
    session.status = 'error';
    session.errorReason = reason;
    session.updatedAt = new Date().toISOString();
    await this.deps.store.saveSession(session);
    await this.deps.publishSessionUpdate(session);
    console.log(`[Bridge] Marked stale session ${session.id} as error`);
  }

  private async resurrectSession(sessionId: string): Promise<void> {
    const { store, runner, bridgeId, sessionFactoryDeps } = this.deps;
    // Commands run concurrently with the resurrection loop; act on fresh
    // state so a session stopped or removed mid-loop is not respawned.
    const session = await store.loadSession(sessionId);
    if (!session || !shouldResurrectStoredSession(session)) return;
    if (runner.isRunning(session.id)) return;

    if (runner.reattach(session.id, {
      workingDir: session.workingDir,
      parentSessionId: session.parentSessionId,
    })) {
      session.status = 'running';
      session.bridgeId = bridgeId;
      session.errorReason = undefined;
      session.updatedAt = new Date().toISOString();
      await store.saveSession(session);
      await this.deps.publishSessionUpdate(session);
      this.deps.wireTerminalInput(session.id);
      registerSessionWorkspace(session.id, session.workingDir);
      console.log(`[Bridge] Resurrected session ${session.id} via tmux reattach`);
      return;
    }

    if (canResumeStoredSession(session)) {
      const miss = findMissingProviderAuth(session.shellType, {
        processEnv: process.env,
        storeEnv: loadProviderEnv(),
      });
      if (miss) {
        await this.markSessionDead(session, miss.message);
        return;
      }
      // The custom-vs-rebuilt resume-command decision lives in
      // deriveRelaunchCommand, inside relaunchFtownSession.
      const resumeCommand = await relaunchFtownSession(sessionFactoryDeps, session, 'resume');
      console.log(`[Bridge] Resurrected session ${session.id} via resume respawn: ${resumeCommand}`);
      return;
    }

    await this.markSessionDead(session);
  }

  async resurrectSessions(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const { store } = this.deps;
    const sessions = await store.listSessions();

    const tmux = this.deps.tmux ?? {
      available: isTmuxAvailable, list: listFtownTmuxSessions, kill: killTmuxSession,
    };
    const liveTmuxIds = new Set(tmux.available() ? tmux.list() : []);
    const retiredIds = new Set(sessions.filter(isRetiredAutomationSession).map((session) => session.id));
    // Only explicit historical provenance proves ownership. Do not inspect loop
    // definitions, prompts, names, or project data. Retry cleanup on later starts
    // even if an earlier start already marked this record error.
    for (const snapshot of sessions) {
      if (!retiredIds.has(snapshot.id)) continue;
      try {
        const current = await store.loadSession(snapshot.id);
        if (!current || !isRetiredAutomationSession(current)) continue;
        let cleanupFailed = false;
        if (liveTmuxIds.has(current.id)) {
          try { cleanupFailed = !await tmux.kill(current.id); }
          catch { cleanupFailed = true; }
        }
        const reason = cleanupFailed
          ? `${AUTOMATION_REMOVED_MESSAGE}; failed to stop retired tmux session ${current.id}; cleanup will retry on bridge restart`
          : AUTOMATION_REMOVED_MESSAGE;
        if (cleanupFailed) console.error(`[Bridge] ${reason}`);
        if (current.status === 'running' || current.status === 'pending' || cleanupFailed
          || current.errorReason?.startsWith(`${AUTOMATION_REMOVED_MESSAGE}; failed to stop`)) {
          await this.markSessionDead(current, reason);
        }
      } catch (error) {
        console.error(`[Bridge] Failed to retire automation session ${snapshot.id}:`, error);
      }
    }

    // Reap tmux sessions for OUR dead store records (removed records, failed
    // kills) before resurrection re-creates any. Archived tombstones count as
    // dead too: remove_session deletes the store record, so a failed tmux
    // kill would otherwise leave a permanently invisible live agent. Tmux
    // sessions with ids we have no record of are left alone — they may
    // belong to another bridge running on this machine.
    if (liveTmuxIds.size > 0) {
      const archived = await store.listArchived();
      const currentIds = new Set(sessions.map((session) => session.id));
      const retiredArchiveIds = new Set(archived
        .filter((record) => isRetiredAutomationSession(record) && !currentIds.has(record.id))
        .map((record) => record.id));
      const deadIds = new Set([
        ...sessions
          .filter((s) => s.status !== 'running' && s.status !== 'pending')
          .map((s) => s.id),
        ...archived.map((a) => a.id),
      ]);
      // A live store record outranks any tombstone for the same id (crash
      // between archive and delete leaves both): never reap resurrectables.
      for (const s of sessions) {
        if (s.status === 'running' || s.status === 'pending') {
          deadIds.delete(s.id);
        }
      }
      for (const tmuxId of liveTmuxIds) {
        if (deadIds.has(tmuxId) && !retiredIds.has(tmuxId)) {
          console.log(`[Bridge] Killing tmux session for dead session ${tmuxId}`);
          const stopped = await tmux.kill(tmuxId);
          if (!stopped && retiredArchiveIds.has(tmuxId)) {
            console.error(`[Bridge] ${AUTOMATION_REMOVED_MESSAGE}; failed to stop archived retired tmux session ${tmuxId}; cleanup will retry on bridge restart`);
          }
        }
      }
    }

    for (const session of sessions) {
      if (!shouldResurrectStoredSession(session)) continue;
      try {
        await this.resurrectSession(session.id);
      } catch (err) {
        console.error(`[Bridge] Failed to resurrect session ${session.id}:`, err);
        try {
          const current = await store.loadSession(session.id);
          if (current) await this.markSessionDead(current);
        } catch (markErr) {
          console.error(`[Bridge] Failed to mark session ${session.id} as error:`, markErr);
        }
      }
    }

  }
}
