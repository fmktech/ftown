import type { Activity, AttentionItem } from '../attention-events.js';
import type { PullRequestState } from '../pull-request-status-protocol.js';
import type { MailMessage, Session } from '../types.js';
import { escalateParentChildren } from './attention-routing.js';
import { BoardService } from './board.js';
import { CardStore } from './card-store.js';
import type { AttentionRoute, AttentionRoutingFields } from './contract-b.js';
import type {
  BoardDeps,
  BoardServiceApi,
  CardBlockedOn,
  CardStoreApi,
  CardStoreDeps,
  DigestProvider,
  MailEventSink,
  SessionCardDeclared,
  TreeEventKind,
  TreeEventLogApi,
  TreeEventLogDeps,
} from './contract.js';
import { PlanStore } from './plan.js';
import { TreeEventLog } from './tree-events.js';

export interface CoordinationSessionStore {
  loadSession(id: string): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  listSessions(): Promise<Session[]>;
  /** Archive tombstones, same source the worktree routes read. */
  listArchived?(): Promise<Session[]>;
  sessionDir(id: string): string;
}

export interface CoordinationAttentionStore {
  list(id: string): Promise<{ activity: Activity; openCount: number }>;
  listRouted?(childId: string): Promise<AttentionItem[]>;
  setRoute?(
    sessionId: string,
    eventId: string,
    fields: AttentionRoutingFields,
    expectRoute?: AttentionRoute,
  ): Promise<AttentionItem | undefined>;
}

export interface CoordinationPrStatusResult {
  state: PullRequestState;
  stale: boolean;
  checkedAt: string | null;
}

export interface CoordinationMailStore {
  unreadCount(id: string): Promise<number>;
}

export interface CoordinationDeps {
  store: CoordinationSessionStore;
  attention: CoordinationAttentionStore;
  prStatus: (url: string) => Promise<CoordinationPrStatusResult | null>;
  /** Gate-time status that must be fresh (see PullRequestStatusService.getFresh). */
  prStatusFresh?: (url: string) => Promise<{ status: CoordinationPrStatusResult; fresh: boolean } | null>;
  mail: CoordinationMailStore;
  publishSession: (s: Session) => void;
  now: () => number;
  onAttentionEscalated?: (sessionId: string, item: AttentionItem) => void;
  /** Optional factory seams for unit tests using *Api fakes. */
  createCards?: (deps: CardStoreDeps) => CardStoreApi;
  createEvents?: (deps: TreeEventLogDeps) => TreeEventLogApi;
  createBoard?: (deps: BoardDeps) => BoardServiceApi;
  createPlan?: (deps: ConstructorParameters<typeof PlanStore>[0]) => PlanStore;
}

export interface Coordination {
  cards: CardStoreApi;
  events: TreeEventLogApi;
  board: BoardServiceApi;
  /** Same instance handed to session create (`--plan-item`) and the plan routes. */
  plan: PlanStore;
  digest: DigestProvider;
  mailSink: MailEventSink;
  prStatus(url: string): Promise<CoordinationPrStatusResult | null>;
  prStatusFresh(url: string): Promise<{ status: CoordinationPrStatusResult; fresh: boolean } | null>;
  emit(session: Session, kind: TreeEventKind, summary: string, ref?: string): Promise<void>;
  /**
   * `snapshot`, when passed, is the session as it existed before the record was
   * deleted. Callers that already hold it (stop, remove/archive) must pass it:
   * reloading after delete returns null and skips escalation.
   */
  onSessionExit(sessionId: string, snapshot?: Session): Promise<void>;
  onSessionStart(sessionId: string): void;
}

export function rootOf(session: Pick<Session, 'id' | 'parentSessionId'>): string {
  return session.parentSessionId ?? session.id;
}

function sameBlockedOn(a: CardBlockedOn | undefined, b: CardBlockedOn | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.kind === b.kind && a.text === b.text && a.ref === b.ref;
}

function statusChanged(current: SessionCardDeclared, previous: SessionCardDeclared | null): boolean {
  if (!previous) return true;
  if (current.state !== previous.state) return true;
  if (current.headline !== previous.headline) return true;
  return !sameBlockedOn(current.blockedOn, previous.blockedOn);
}

function formatStatusSummary(card: SessionCardDeclared): string {
  const base = `${card.state}: ${card.headline}`;
  if (card.state === 'blocked' && card.blockedOn) {
    return `${base} — blocked on ${card.blockedOn.kind}: ${card.blockedOn.text}`;
  }
  return base;
}

/** Archive records keep env for revive. The board must not hold those secrets. */
function boardArchivedSession(record: Session): Session {
  const sanitized: Session = { ...record };
  delete sanitized.env;
  delete sanitized.previewSource;
  return sanitized;
}

export function createCoordination(deps: CoordinationDeps): Coordination {
  const events: TreeEventLogApi = (deps.createEvents ?? ((d) => new TreeEventLog(d)))({
    sessionDir: (id) => deps.store.sessionDir(id),
    now: deps.now,
  });

  const exitedSessions = new Set<string>();

  function onSessionStart(sessionId: string): void {
    exitedSessions.delete(sessionId);
  }

  async function emit(session: Session, kind: TreeEventKind, summary: string, ref?: string): Promise<void> {
    // exit and removed each fire once per incarnation. onSessionStart clears the slot.
    if (kind === 'exit' || kind === 'removed') {
      if (exitedSessions.has(session.id)) return;
      exitedSessions.add(session.id);
    }
    try {
      const rootId = rootOf(session);
      await events.append(rootId, {
        sessionId: session.id,
        sessionName: session.name,
        kind,
        summary,
        ...(ref !== undefined ? { ref } : {}),
      });
    } catch (error) {
      console.warn(
        '[Coordination] Failed to emit tree event:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const plan: PlanStore = (deps.createPlan ?? ((d) => new PlanStore(d)))({
    loadSession: (id) => deps.store.loadSession(id),
    saveSession: (session) => deps.store.saveSession(session),
    publishSession: (session) => deps.publishSession(session),
    emit: (parent, summary) => emit(parent, 'plan', summary),
    now: deps.now,
  });

  async function escalateExitingParent(sessionId: string): Promise<void> {
    if (!deps.attention.listRouted || !deps.attention.setRoute) return;
    await escalateParentChildren(sessionId, {
      listSessions: () => deps.store.listSessions(),
      attention: {
        listRouted: (id) => deps.attention.listRouted!(id),
        setRoute: (id, eventId, fields, expectRoute) => deps.attention.setRoute!(id, eventId, fields, expectRoute),
      },
      now: deps.now,
      onEscalated: deps.onAttentionEscalated,
    });
  }

  async function onSessionExit(sessionId: string, snapshot?: Session): Promise<void> {
    if (exitedSessions.has(sessionId)) return;
    try {
      // A caller-supplied snapshot is authoritative. loadSession after remove/archive
      // returns null, which used to skip escalateParentChildren entirely.
      const session = snapshot !== undefined ? snapshot : await deps.store.loadSession(sessionId);
      const terminal = !!session && (session.status === 'completed' || session.status === 'error');
      if (terminal && session) {
        await emit(session, 'exit', `exited: ${session.status}`);
      }
      // Running snapshot: stop/remove is ending the session before its status
      // write is visible. Null load: the record was deleted before this ran.
      // A live non-terminal session with no snapshot is not an exit.
      if (terminal || snapshot !== undefined || !session) {
        await escalateExitingParent(sessionId);
      }
      // Remove/archive passes the pre-delete snapshot. A child that has not
      // already exited (terminal status, or an exit already emitted) gets one
      // `removed` event. Stop passes a completed snapshot and stays an exit.
      if (session && snapshot !== undefined && !terminal && session.parentSessionId) {
        await emit(session, 'removed', 'removed');
        // A started plan item was bound to this child. Put it back on the list.
        try {
          await plan.releaseForChild(session.parentSessionId, session.id);
        } catch (error) {
          console.warn(
            '[Coordination] Failed to release plan item for removed child:',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } catch (error) {
      console.warn(
        '[Coordination] Failed to load session on exit:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const cards: CardStoreApi = (deps.createCards ?? ((d) => new CardStore(d)))({
    loadSession: (id) => deps.store.loadSession(id),
    saveSession: (session) => deps.store.saveSession(session),
    now: deps.now,
    onChange: async (saved, previous) => {
      try {
        deps.publishSession(saved);
      } catch (error) {
        console.warn(
          '[Coordination] Failed to publish session update:',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (saved.card && statusChanged(saved.card, previous)) {
        await emit(saved, 'status', formatStatusSummary(saved.card));
      }
      // A child card that becomes done completes the parent's started plan item.
      // 'failed' stays 'started' — the manager decides. A plan failure must not
      // undo the card write.
      if (saved.card?.state === 'done' && previous?.state !== 'done' && saved.parentSessionId) {
        try {
          await plan.completeForChild(saved.parentSessionId, saved.id);
        } catch (error) {
          console.warn(
            '[Coordination] Failed to complete plan item for child:',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    },
  });

  const board: BoardServiceApi = (deps.createBoard ?? ((d) => new BoardService(d)))({
    ...(deps.store.listArchived
      ? {
          listArchived: async () => {
            const records = await deps.store.listArchived!();
            return records.map(boardArchivedSession);
          },
        }
      : {}),
    loadSession: (id) => deps.store.loadSession(id),
    listSessions: () => deps.store.listSessions(),
    attention: async (id) => {
      const page = await deps.attention.list(id);
      return { activity: page.activity, openCount: page.openCount };
    },
    prStatus: (url) => deps.prStatus(url),
    unreadMail: (id) => deps.mail.unreadCount(id),
    events,
    now: deps.now,
  });

  const digestCursors = new Map<string, number>();

  const digest: DigestProvider = {
    async digestFor(recipientSessionId: string): Promise<string | null> {
      try {
        const sessions = await deps.store.listSessions();
        const hasChildren = sessions.some(
          (s) => s.parentSessionId === recipientSessionId && s.id !== recipientSessionId,
        );
        if (!hasChildren) return null;

        let since = digestCursors.get(recipientSessionId);
        if (since === undefined) {
          since = await events.head(recipientSessionId);
          digestCursors.set(recipientSessionId, since);
        }

        const result = await board.digest(recipientSessionId, since);
        digestCursors.set(recipientSessionId, result.cursor);
        return result.line;
      } catch {
        return null;
      }
    },
  };

  const mailSink: MailEventSink = {
    async onAccepted(message: MailMessage, recipient: Session): Promise<void> {
      try {
        if (message.type !== 'result') return;
        const sender = await deps.store.loadSession(message.from);
        if (!sender) return;
        if (rootOf(sender) !== recipient.id) return;
        const firstLine = (message.body.split(/\r?\n/, 1)[0] ?? '').slice(0, 200);
        await emit(sender, 'result', firstLine);
      } catch (error) {
        console.warn(
          '[Coordination] Failed to handle accepted mail event:',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };

  return {
    cards,
    events,
    board,
    plan,
    digest,
    mailSink,
    prStatus: (url) => deps.prStatus(url),
    prStatusFresh: async (url) => {
      if (deps.prStatusFresh) return deps.prStatusFresh(url);
      const status = await deps.prStatus(url);
      return status ? { status, fresh: true } : null;
    },
    emit,
    onSessionExit,
    onSessionStart,
  };
}
