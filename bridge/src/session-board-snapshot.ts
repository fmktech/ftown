import { createHash } from 'node:crypto';
import type { AttentionItem } from './attention-events.js';
import { BOARD_SNAPSHOT_EVENTS, type BoardSnapshot } from './coordination/contract-c.js';
import type { BoardQuery, TreeEvent, TreeEventLogApi } from './coordination/contract.js';
import type { Session } from './types.js';
import { isPermanentPublicationError } from './outbound-pipeline-types.js';

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
  /** Seed previous roots before mutations can reparent or remove a session. Trees are flattened by SessionController. */
  initialSessions?: Iterable<Pick<Session, 'id' | 'parentSessionId'>>;
}) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  const dirty = new Set<string>();
  const retries = new Map<string, number>();
  const sessionRoots = new Map<string, string>();
  for (const session of deps.initialSessions ?? []) sessionRoots.set(session.id, session.parentSessionId ?? session.id);
  // Retain only the latest 256 roots, without keeping large plaintext snapshots.
  const previous = new Map<string, string>();
  let stopped = false;
  let reconciliation = 0;
  async function flush(rootId: string): Promise<void> {
    pending.delete(rootId);
    if (stopped) return;
    if (running.has(rootId)) { dirty.add(rootId); return; }
    running.add(rootId);
    const generation = reconciliation;
    let retry = false;
    let deliveryStarted = false;
    try {
      const snapshot = await buildSessionBoardSnapshot(deps.source, rootId);
      // A former root can now be a child. Never label its new parent's data
      // with the old root ID, and do not retry deleted roots indefinitely.
      if (snapshot.board.rootId !== rootId) return;
      const serialized = JSON.stringify(snapshot);
      const digest = createHash('sha256').update(serialized).digest('hex');
      if (!stopped && previous.get(rootId) !== digest) {
        deliveryStarted = true;
        await deps.publish(rootId, snapshot);
        if (!stopped && generation === reconciliation) {
          previous.delete(rootId);
          previous.set(rootId, digest);
          if (previous.size > 256) previous.delete(previous.keys().next().value!);
        }
      }
      retries.delete(rootId);
    } catch (error) {
      console.warn('[Bridge] Could not publish board snapshot:', error instanceof Error ? error.message : error);
      // Unknown namespace on an older relay is permanent until configuration
      // changes. Never leave an idle retry loop running against that relay.
      retry = deliveryStarted && !isPermanentPublicationError(error);
      if (retry && !stopped) retries.set(rootId, Math.min(5, (retries.get(rootId) ?? 0) + 1));
      else retries.delete(rootId);
    } finally {
      running.delete(rootId);
      const changed = dirty.delete(rootId);
      if (changed || retry) schedule(rootId);
    }
  }
  function schedule(rootId: string): void {
    if (stopped || pending.has(rootId)) return;
    if (running.has(rootId)) { dirty.add(rootId); return; }
    const delay = retries.has(rootId) ? Math.min(30_000, 1000 * 2 ** ((retries.get(rootId) ?? 1) - 1)) : deps.debounceMs ?? 1000;
    const timer = setTimeout(() => { void flush(rootId); }, delay);
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
      const update = data as { type?: string; session?: Pick<Session, 'id' | 'parentSessionId'> & { status?: string } };
      if (update.type === 'session_update' && update.session?.id) {
        const session = update.session;
        const previousRoot = sessionRoots.get(session.id);
        const root = session.parentSessionId ?? session.id;
        if (previousRoot && previousRoot !== root) schedule(previousRoot);
        schedule(root);
        if (session.status === 'removed') sessionRoots.delete(session.id);
        else sessionRoots.set(session.id, root);
      }
    } else if (channel.startsWith('events:') && channel.endsWith(`#${deps.userId}`)) {
      void sessionChanged(channel.slice('events:'.length, -(deps.userId.length + 1)));
    }
  }
  return {
    schedule, observePublication,
    /** Cloud writes are best-effort; reconnect must retry even byte-identical local snapshots. */
    reconcile(rootIds: Iterable<string>) {
      reconciliation += 1;
      previous.clear();
      retries.clear();
      for (const rootId of rootIds) schedule(rootId);
    },
    stop() {
      stopped = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear(); dirty.clear(); previous.clear(); retries.clear(); sessionRoots.clear();
    },
  };
}
