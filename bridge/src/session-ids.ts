import type { HookEvent } from './local-api-server.js';
import type { SessionStore } from './session-store.js';
import type { Session } from './types.js';

export interface AgentSessionIdPersisterDeps {
  store: Pick<SessionStore, 'loadSession' | 'saveSession'>;
  publishSessionUpdate: (session: Session) => Promise<void>;
}

interface CachedAgentIds {
  claude?: string;
  cursor?: string;
  codex?: string;
  pi?: string;
  piFile?: string;
  isCodex?: boolean;
  isPi?: boolean;
}

/**
 * Persists agent-native session identity (Claude/Codex/Pi session_id, Pi
 * session_file, or Cursor conversation_id) from hook events onto the stored
 * session record, with an in-memory cache of the last persisted values to skip
 * disk reads on the hot hook path.
 */
export class AgentSessionIdPersister {
  private readonly cache = new Map<string, CachedAgentIds>();

  constructor(private readonly deps: AgentSessionIdPersisterDeps) {}

  async persist(hookEvent: HookEvent): Promise<void> {
    // Workspace-fallback attribution may come from a foreign agent the user
    // ran manually in the same directory; never persist its ids.
    if (hookEvent.source === 'workspace') return;

    const rawAgentId = hookEvent.data['session_id'];
    const rawCursorId = hookEvent.data['conversation_id'];
    const rawSessionFile = hookEvent.data['session_file'];
    // Claude Code AND Codex hooks carry session_id (which field it lands in
    // depends on the session's shellType); Cursor hooks carry conversation_id.
    const agentId = typeof rawAgentId === 'string' && rawAgentId ? rawAgentId : undefined;
    const cursorId = typeof rawCursorId === 'string' && rawCursorId ? rawCursorId : undefined;
    const sessionFile = typeof rawSessionFile === 'string' && rawSessionFile
      ? rawSessionFile
      : undefined;
    if (!agentId && !cursorId && !sessionFile) return;

    const cached = this.cache.get(hookEvent.sessionId);
    if (cached
      && (!agentId || (cached.isPi
        ? cached.pi === agentId
        : cached.isCodex ? cached.codex === agentId : cached.claude === agentId))
      && (!cursorId || cached.cursor === cursorId)
      && (!sessionFile || cached.piFile === sessionFile)) {
      return;
    }

    const session = await this.deps.store.loadSession(hookEvent.sessionId);
    if (!session) return;
    const isCodex = session.shellType === 'codex';
    const isPi = session.shellType === 'pi';

    let changed = false;
    if (agentId) {
      if (isPi && session.piSessionId !== agentId) {
        session.piSessionId = agentId;
        changed = true;
      } else if (isCodex && session.codexSessionId !== agentId) {
        session.codexSessionId = agentId;
        changed = true;
      } else if (!isCodex && session.claudeSessionId !== agentId) {
        session.claudeSessionId = agentId;
        changed = true;
      }
    }
    if (cursorId && session.cursorSessionId !== cursorId) {
      session.cursorSessionId = cursorId;
      changed = true;
    }
    if (isPi && sessionFile && session.piSessionFile !== sessionFile) {
      session.piSessionFile = sessionFile;
      changed = true;
    }
    if (!changed) {
      this.cache.set(hookEvent.sessionId, {
        claude: session.claudeSessionId,
        cursor: session.cursorSessionId,
        codex: session.codexSessionId,
        pi: session.piSessionId,
        piFile: session.piSessionFile,
        isCodex,
        isPi,
      });
      return;
    }

    session.updatedAt = new Date().toISOString();
    await this.deps.store.saveSession(session);
    // Cache only after a successful save, so a failed persist is retried.
    this.cache.set(hookEvent.sessionId, {
      claude: session.claudeSessionId,
      cursor: session.cursorSessionId,
      codex: session.codexSessionId,
      pi: session.piSessionId,
      piFile: session.piSessionFile,
      isCodex,
      isPi,
    });
    await this.deps.publishSessionUpdate(session);
  }
}
