import { createHash } from 'node:crypto';
import type { AttentionItem } from './attention-events.js';
import { BOARD_SNAPSHOT_EVENTS, type BoardSnapshot } from './coordination/contract-c.js';
import type { BoardQuery, TreeEvent, TreeEventLogApi } from './coordination/contract.js';
import type { Session } from './types.js';

/** Reads used to build a BoardSnapshot. Must not mutate sessions, plans, or attention. */
export interface SessionBoardSource {
  board(query: BoardQuery): Promise<BoardSnapshot['board']>;
  events: Pick<TreeEventLogApi, 'head' | 'read'>;
  openAttention(sessionId: string): Promise<AttentionItem[]>;
}

async function newestRootEvents(
  events: Pick<TreeEventLogApi, 'head' | 'read'>,
  rootId: string,
): Promise<TreeEvent[]> {
  const head = await events.head(rootId);
  if (head <= 0) return [];
  const since = Math.max(0, head - Math.max(BOARD_SNAPSHOT_EVENTS, 500));
  const page = await events.read(rootId, { since, limit: 500 });
  return page.events.slice(-BOARD_SNAPSHOT_EVENTS);
}

export async function buildSessionBoardSnapshot(source: SessionBoardSource, sessionId: string): Promise<BoardSnapshot> {
  const board = await source.board({ sessionId: sessionId, all: true });
  const events = await newestRootEvents(source.events, board.rootId);
  const attention: BoardSnapshot['attention'] = [];
  for (const card of board.cards) {
    if (card.archived) continue;
    try {
      const items = await source.openAttention(card.sessionId);
      for (const event of items) {
        if (event.resolvedAt) continue;
        attention.push({ sessionId: card.sessionId, event });
      }
    } catch (error) {
      console.warn(
        '[Bridge] Could not read child attention for board snapshot:',
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { board, events, attention };
}

/** One bounded pending job per root. Changes during a build run in a later batch. */
export function createSessionBoardPublisher(deps: {
  source: SessionBoardSource;
  publish(rootId: string, snapshot: BoardSnapshot): Promise<void>;
  loadSession(id: string): Promise<Session | null>;
  userId: string;
  debounceMs?: number;
}) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  const dirty = new Set<string>();
  // Retain only the latest 256 roots, without keeping large plaintext snapshots.
  const previous = new Map<string, string>();
  let stopped = false;
  async function flush(rootId: string): Promise<void> {
    pending.delete(rootId);
    if (stopped) return;
    if (running.has(rootId)) { dirty.add(rootId); return; }
    running.add(rootId);
    try {
      const snapshot = await buildSessionBoardSnapshot(deps.source, rootId);
      const serialized = JSON.stringify(snapshot);
      const digest = createHash('sha256').update(serialized).digest('hex');
      if (!stopped && previous.get(rootId) !== digest) {
        await deps.publish(rootId, snapshot);
        previous.delete(rootId);
        previous.set(rootId, digest);
        if (previous.size > 256) previous.delete(previous.keys().next().value!);
      }
    } catch (error) {
      console.warn('[Bridge] Could not publish board snapshot:', error instanceof Error ? error.message : error);
    } finally {
      running.delete(rootId);
      if (dirty.delete(rootId)) schedule(rootId);
    }
  }
  function schedule(rootId: string): void {
    if (stopped || pending.has(rootId)) return;
    const timer = setTimeout(() => { void flush(rootId); }, deps.debounceMs ?? 1000);
    timer.unref?.();
    pending.set(rootId, timer);
  }
  async function sessionChanged(sessionId: string): Promise<void> {
    try {
      const session = await deps.loadSession(sessionId);
      if (session) schedule(session.parentSessionId ?? session.id);
    } catch { /* A removed session is covered by its session publication/tree event. */ }
  }
  function observePublication(channel: string, data: unknown): void {
    if (!data || typeof data !== 'object') return;
    if (channel === `sessions:updates#${deps.userId}`) {
      const update = data as { type?: string; session?: Pick<Session, 'id' | 'parentSessionId'> };
      if (update.type === 'session_update' && update.session?.id) schedule(update.session.parentSessionId ?? update.session.id);
    } else if (channel.startsWith('events:') && channel.endsWith(`#${deps.userId}`)) {
      void sessionChanged(channel.slice('events:'.length, -(deps.userId.length + 1)));
    }
  }
  return {
    schedule, observePublication,
    /** Cloud writes are best-effort; reconnect must retry even byte-identical local snapshots. */
    reconcile(rootIds: Iterable<string>) {
      previous.clear();
      for (const rootId of rootIds) schedule(rootId);
    },
    stop() {
      stopped = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear(); dirty.clear(); previous.clear();
    },
  };
}
