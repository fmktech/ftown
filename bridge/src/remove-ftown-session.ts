import type { CentrifugoClient } from './centrifugo-client.js';
import type { ProcessRunner } from './claude-runner.js';
import type { SessionStore } from './session-store.js';
import type { Session } from './types.js';

export interface RemoveFtownSessionDeps {
  store: SessionStore;
  runner: ProcessRunner;
  centrifugo: CentrifugoClient;
  userId: string;
}

export interface RemoveFtownSessionOptions {
  /** Skip removal unless the session is completed/error (bulk-clear guard
   * against racing a session that was retried back to running). */
  onlyIfFinished?: boolean;
}

/**
 * Stop the session, write a tombstone to archive.jsonl, delete the store
 * record, and publish a 'removed' update. Returns the removed session, or
 * null when nothing was removed (no store record, or the onlyIfFinished
 * guard rejected it). For unknown ids, stop is still attempted so orphaned
 * tmux sessions without a store record can be reaped.
 */
export async function removeFtownSession(
  deps: RemoveFtownSessionDeps,
  sessionId: string,
  options: RemoveFtownSessionOptions = {},
): Promise<Session | null> {
  const session = await deps.store.loadSession(sessionId);

  if (options.onlyIfFinished
    && (!session || (session.status !== 'completed' && session.status !== 'error'))) {
    return null;
  }

  deps.runner.stop(sessionId);

  if (!session) {
    // No store record: nothing to archive, and deleteSession must not run —
    // an unvalidated id (e.g. '..') would otherwise reach the recursive rm.
    return null;
  }

  // Tombstone before delete: a crash between the two leaves a stale store
  // record (re-removable) rather than a session lost without an archive entry.
  await deps.store.archiveSession(session);
  await deps.store.deleteSession(sessionId);

  const removedSession: Session = {
    ...session,
    status: 'removed' as Session['status'],
    updatedAt: new Date().toISOString(),
  };
  await deps.centrifugo.publishSessionUpdate(deps.userId, removedSession);

  return session;
}
