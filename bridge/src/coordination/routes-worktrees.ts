import {
  RouteError,
  WORKTREE_ROUTES,
  type RouteContext,
  type RouteModule,
  type SessionWorktree,
  type WorktreeApi,
  type WorktreeStatus,
} from './contract-b.js';
import type { Session } from '../types.js';

export interface WorktreeRoutesDeps {
  listLive(): Promise<Session[]>;
  listArchived(): Promise<Session[]>;
  worktrees: WorktreeApi;
  markRetained(sessionId: string, reason: string): Promise<void>;
}

export interface WorktreeRouteEntry {
  sessionId: string;
  sessionName: string;
  archived: boolean;
  worktree: SessionWorktree;
  status: WorktreeStatus | null;
  error?: string;
}

export interface WorktreePruneResponse {
  removed: string[];
  retained: Array<{ path: string; reason: string }>;
}

async function safeMarkRetained(
  deps: WorktreeRoutesDeps,
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    await deps.markRetained(sessionId, reason);
  } catch (error) {
    console.warn(
      '[WorktreeRoutes] Failed to mark worktree retained:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function hasBridgeWorktree(
  session: Session,
): session is Session & { worktree: SessionWorktree } {
  return Boolean(session.worktree && session.worktree.createdByBridge);
}

/**
 * Deduplicate archived tombstones (newest wins per session id) and exclude
 * sessions or worktree paths that are currently live.
 */
function selectArchivedWithWorktree(
  archived: Session[],
  liveIds: Set<string>,
  livePaths: Set<string>,
): Array<Session & { worktree: SessionWorktree }> {
  const lastIndexById = new Map<string, number>();
  for (let i = 0; i < archived.length; i++) {
    lastIndexById.set(archived[i].id, i);
  }
  const selected: Array<Session & { worktree: SessionWorktree }> = [];
  for (let i = 0; i < archived.length; i++) {
    const session = archived[i];
    if (lastIndexById.get(session.id) !== i) continue;
    if (liveIds.has(session.id)) continue;
    if (!hasBridgeWorktree(session)) continue;
    if (livePaths.has(session.worktree.path)) continue;
    selected.push(session);
  }
  return selected;
}

function requireNoQuery(ctx: RouteContext): void {
  for (const key of ctx.query.keys()) {
    throw new RouteError(400, `Unknown query parameter: ${key}`);
  }
}

/**
 * Factory for WORKTREE_ROUTES:
 *   GET  /api/worktrees       → { worktrees: WorktreeRouteEntry[] }
 *   POST /api/worktrees/prune → { removed: string[]; retained: Array<{ path: string; reason: string }> }
 */
export function createWorktreeRoutes(deps: WorktreeRoutesDeps): RouteModule {
  return async function routeWorktrees(ctx: RouteContext): Promise<boolean> {
    if (ctx.path === WORKTREE_ROUTES.list) {
      if (ctx.method !== 'GET') {
        throw new RouteError(405, 'Method not allowed');
      }
      requireNoQuery(ctx);

      const [live, archived] = await Promise.all([
        deps.listLive(),
        deps.listArchived(),
      ]);

      const liveWithWorktree = live.filter(hasBridgeWorktree);
      const liveIds = new Set(live.map((s) => s.id));
      const livePaths = new Set(liveWithWorktree.map((s) => s.worktree.path));
      const archivedWithWorktree = selectArchivedWithWorktree(
        archived,
        liveIds,
        livePaths,
      );

      const candidates: Array<{
        session: Session & { worktree: SessionWorktree };
        archived: boolean;
      }> = [
        ...liveWithWorktree.map((session) => ({ session, archived: false })),
        ...archivedWithWorktree.map((session) => ({ session, archived: true })),
      ];

      const worktrees: WorktreeRouteEntry[] = [];
      for (const { session, archived: isArchived } of candidates) {
        try {
          const status = await deps.worktrees.status(session.worktree);
          worktrees.push({
            sessionId: session.id,
            sessionName: session.name,
            archived: isArchived,
            worktree: session.worktree,
            status,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          worktrees.push({
            sessionId: session.id,
            sessionName: session.name,
            archived: isArchived,
            worktree: session.worktree,
            status: null,
            error: message,
          });
        }
      }

      ctx.json(200, { worktrees });
      return true;
    }

    if (ctx.path === WORKTREE_ROUTES.prune) {
      if (ctx.method !== 'POST') {
        throw new RouteError(405, 'Method not allowed');
      }
      requireNoQuery(ctx);

      const [live, archived] = await Promise.all([
        deps.listLive(),
        deps.listArchived(),
      ]);

      const liveWithWorktree = live.filter(hasBridgeWorktree);
      const liveIds = new Set(live.map((s) => s.id));
      const livePaths = new Set(liveWithWorktree.map((s) => s.worktree.path));
      const archivedWithWorktree = selectArchivedWithWorktree(
        archived,
        liveIds,
        livePaths,
      );

      const removed: string[] = [];
      const retained: Array<{ path: string; reason: string }> = [];

      for (const session of archivedWithWorktree) {
        const wt = session.worktree;
        try {
          const status = await deps.worktrees.status(wt);
          const decision = deps.worktrees.decide(status);
          if (decision.action === 'remove') {
            await deps.worktrees.remove(wt, {
              force: false,
              deleteBranch: decision.deleteBranch,
            });
            removed.push(wt.path);
          } else {
            await safeMarkRetained(deps, session.id, decision.reason);
            retained.push({ path: wt.path, reason: decision.reason });
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await safeMarkRetained(deps, session.id, reason);
          retained.push({ path: wt.path, reason });
        }
      }

      const result: WorktreePruneResponse = { removed, retained };
      ctx.json(200, result);
      return true;
    }

    return false;
  };
}
