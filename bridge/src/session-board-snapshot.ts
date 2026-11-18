import { createHash } from 'node:crypto';
import type { AttentionItem } from './attention-events.js';
import { BOARD_SNAPSHOT_EVENTS, type BoardSnapshot } from './coordination/contract-c.js';
import type { BoardQuery, TreeEvent, TreeEventLogApi } from './coordination/contract.js';
import type { Session } from './types.js';
import { isPermanentPublicationError, isUnknownPublicationNamespace } from './outbound-pipeline-types.js';

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

/** A live child still needs its parent's board even when that parent has finished. */
export function liveSessionBoardRoots(sessions: Iterable<Pick<Session, 'id' | 'parentSessionId' | 'bridgeId' | 'status'>>, bridgeId: string): Set<string> {
  const roots = new Set<string>();
  for (const session of sessions) {
    if (session.bridgeId === bridgeId && (session.status === 'running' || session.status === 'pending')) roots.add(session.parentSessionId ?? session.id);
  }
  return roots;
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
  const ready = new Set<string>();
  const deferred = new Set<string>();
  const running = new Set<string>();
  const dirty = new Set<string>();
  const retries = new Map<string, number>();
  const sessionRoots = new Map<string, string>();
  for (const session of deps.initialSessions ?? []) sessionRoots.set(session.id, session.parentSessionId ?? session.id);
  // Retain only the latest 256 roots, without keeping large plaintext snapshots.
  const previous = new Map<string, string>();
  let stopped = false;
  let reconciliation = 0;
  let capability: 'unknown' | 'available' | 'unavailable' = 'unknown';
  let continuation: ReturnType<typeof setImmediate> | undefined;
  function publishingEnabled(): boolean { return !stopped && capability !== 'unavailable'; }
  function cancelPending(): void {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear(); ready.clear(); dirty.clear(); retries.clear();
  }
  function drain(): void {
    if (stopped || capability === 'unavailable' || continuation) return;
    // Negotiate one namespace publication at a time; after success, a small
    // ACK-bounded window also keeps large reconnects out of the shared queue.
    const limit = capability === 'unknown' ? 1 : 2;
    while (ready.size > 0 && running.size < limit) {
      const rootId = ready.values().next().value!;
      ready.delete(rootId);
      running.add(rootId);
      void flush(rootId);
    }
  }
  function continueLater(): void {
    if (stopped || continuation || capability === 'unavailable') return;
    continuation = setImmediate(() => { continuation = undefined; drain(); });
  }
  async function flush(rootId: string): Promise<void> {
    const generation = reconciliation;
    let retry = false;
    let deliveryStarted = false;
    try {
      const snapshot = await buildSessionBoardSnapshot(deps.source, rootId);
      // A former root can now be a child. Never label its new parent's data
      // with the old root ID, and do not retry deleted roots indefinitely.
      if (snapshot.board.rootId !== rootId) return;
      if (!publishingEnabled() || generation !== reconciliation) return;
      const serialized = JSON.stringify(snapshot);
      const digest = createHash('sha256').update(serialized).digest('hex');
      if (!stopped && previous.get(rootId) !== digest) {
        deliveryStarted = true;
        await deps.publish(rootId, snapshot);
        if (publishingEnabled() && generation === reconciliation) {
          capability = 'available';
          previous.delete(rootId);
          previous.set(rootId, digest);
          if (previous.size > 256) previous.delete(previous.keys().next().value!);
        }
      }
      retries.delete(rootId);
    } catch (error) {
      if (deliveryStarted && generation === reconciliation && isUnknownPublicationNamespace(error)) {
        if (capability !== 'unavailable') console.warn('[Bridge] Board publication namespace is unavailable until reconnect');
        capability = 'unavailable';
        for (const root of [...pending.keys(), ...ready, ...dirty, ...running]) deferred.add(root);
        cancelPending();
      } else if (!stopped && capability !== 'unavailable') {
        console.warn('[Bridge] Could not publish board snapshot:', error instanceof Error ? error.message : error);
      }
      retry = deliveryStarted && generation === reconciliation && capability !== 'unavailable' && !isPermanentPublicationError(error);
      if (retry && !stopped) retries.set(rootId, Math.min(5, (retries.get(rootId) ?? 0) + 1));
      else retries.delete(rootId);
    } finally {
      running.delete(rootId);
      const changed = dirty.delete(rootId);
      if (changed || retry) schedule(rootId);
      continueLater();
    }
  }
  function schedule(rootId: string): void {
    if (stopped) return;
    if (capability === 'unavailable') { deferred.add(rootId); return; }
    if (pending.has(rootId) || ready.has(rootId)) return;
    if (running.has(rootId)) { dirty.add(rootId); return; }
    const delay = retries.has(rootId) ? Math.min(30_000, 1000 * 2 ** ((retries.get(rootId) ?? 1) - 1)) : deps.debounceMs ?? 1000;
    const timer = setTimeout(() => {
      pending.delete(rootId);
      if (stopped || capability === 'unavailable') return;
      ready.add(rootId);
      drain();
    }, delay);
    timer.unref?.();
    pending.set(rootId, timer);
  }
  async function sessionChanged(sessionId: string): Promise<void> {
    if (stopped) return;
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
      // A stopped root can still have a real card/plan/attention mutation. The
      // sweep adds only live roots, but must not discard work already observed.
      const roots = new Set([...rootIds, ...deferred, ...pending.keys(), ...ready, ...dirty, ...running]);
      reconciliation += 1;
      capability = 'unknown';
      cancelPending();
      deferred.clear();
      previous.clear();
      for (const rootId of roots) schedule(rootId);
    },
    stop() {
      stopped = true;
      cancelPending();
      if (continuation) clearImmediate(continuation);
      continuation = undefined;
      previous.clear(); sessionRoots.clear(); deferred.clear();
    },
  };
}
