import type { Activity } from '../attention-events.js';
import type { PullRequestState } from '../pull-request-status-protocol.js';
import type { MailMessage, Session } from '../types.js';
import { BoardService } from './board.js';
import { CardStore } from './card-store.js';
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
import { TreeEventLog } from './tree-events.js';

export interface CoordinationSessionStore {
  loadSession(id: string): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  listSessions(): Promise<Session[]>;
  sessionDir(id: string): string;
}

export interface CoordinationAttentionStore {
  list(id: string): Promise<{ activity: Activity; openCount: number }>;
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
  mail: CoordinationMailStore;
  publishSession: (s: Session) => void;
  now: () => number;
  /** Optional factory seams for unit tests using *Api fakes. */
  createCards?: (deps: CardStoreDeps) => CardStoreApi;
  createEvents?: (deps: TreeEventLogDeps) => TreeEventLogApi;
  createBoard?: (deps: BoardDeps) => BoardServiceApi;
}

export interface Coordination {
  cards: CardStoreApi;
  events: TreeEventLogApi;
  board: BoardServiceApi;
  digest: DigestProvider;
  mailSink: MailEventSink;
  emit(session: Session, kind: TreeEventKind, summary: string, ref?: string): Promise<void>;
  onSessionExit(sessionId: string): Promise<void>;
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
    if (kind === 'exit') {
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

  async function onSessionExit(sessionId: string): Promise<void> {
    if (exitedSessions.has(sessionId)) return;
    await deps.store
      .loadSession(sessionId)
      .then((session) => {
        if (session && (session.status === 'completed' || session.status === 'error')) {
          return emit(session, 'exit', `exited: ${session.status}`);
        }
      })
      .catch((error) => {
        console.warn(
          '[Coordination] Failed to load session on exit:',
          error instanceof Error ? error.message : String(error),
        );
      });
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
    },
  });

  const board: BoardServiceApi = (deps.createBoard ?? ((d) => new BoardService(d)))({
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

  return { cards, events, board, digest, mailSink, emit, onSessionExit, onSessionStart };
}
