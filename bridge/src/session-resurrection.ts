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
  return !session.loopId;
}

export interface SessionResurrectionDeps {
  store: SessionStore;
  runner: ProcessRunner;
  bridgeId: string;
  sessionFactoryDeps: CreateFtownSessionDeps;
  publishSessionUpdate: (session: Session) => Promise<void>;
  wireTerminalInput: (sessionId: string) => void;
}

/**
 * Resurrection engine: on bridge start, sessions left in a live state by a
 * previous bridge are reattached (tmux), respawned (resume), or marked as
 * error. Loop-run sessions are deferred to the loop scheduler.
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
    if (!session || (session.status !== 'running' && session.status !== 'pending')) return;
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

    // Reap tmux sessions for OUR dead store records (removed records, failed
    // kills) before resurrection re-creates any. Archived tombstones count as
    // dead too: remove_session deletes the store record, so a failed tmux
    // kill would otherwise leave a permanently invisible live agent. Tmux
    // sessions with ids we have no record of are left alone — they may
    // belong to another bridge running on this machine.
    if (isTmuxAvailable()) {
      const archived = await store.listArchived();
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
      for (const tmuxId of listFtownTmuxSessions()) {
        if (deadIds.has(tmuxId)) {
          console.log(`[Bridge] Killing tmux session for dead session ${tmuxId}`);
          await killTmuxSession(tmuxId);
        }
      }
    }

    let deferredLoopRuns = 0;
    for (const session of sessions) {
      if (session.loopId) {
        if (session.status !== 'running' && session.status !== 'pending') continue;
        deferredLoopRuns += 1;
        continue;
      }
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
    if (deferredLoopRuns > 0) {
      console.log(`[Bridge] Deferred ${deferredLoopRuns} loop-run session(s) to the loop scheduler`);
    }
  }
}
