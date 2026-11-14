import {
  CARD_STATES,
  CARD_STALE_MS,
  DIGEST_MAX,
  type Board,
  type BoardDeps,
  type BoardQuery,
  type BoardRollupKey,
  type BoardServiceApi,
  type CardDerived,
  type SessionCard,
  type TreeEvent,
} from './contract.js';
import { orderPlan } from './plan.js';
import { formatLocalHHMM } from './format.js';
import type { Activity } from '../attention-events.js';
import type { Session } from '../types.js';

/** Archived children included by board({ all: true }), newest first. */
const ARCHIVED_CHILD_CAP = 50;

function emptyRollup(): Record<BoardRollupKey, number> {
  const rollup: Record<BoardRollupKey, number> = {
    working: 0,
    blocked: 0,
    waiting_review: 0,
    done: 0,
    failed: 0,
    unset: 0,
  };
  for (const state of CARD_STATES) {
    rollup[state] = 0;
  }
  return rollup;
}

function sliceCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('') : s;
}

async function readAllEventsSince(
  deps: BoardDeps,
  rootId: string,
  since: number,
): Promise<{ events: TreeEvent[]; cursor: number }> {
  const all: TreeEvent[] = [];
  let cursor = since;
  while (true) {
    const page = await deps.events.read(rootId, { since: cursor, limit: 500 });
    if (page.events.length === 0) {
      break;
    }
    all.push(...page.events);
    if (page.cursor <= cursor) {
      break;
    }
    cursor = page.cursor;
    if (page.events.length < 500) {
      break;
    }
  }
  return { events: all, cursor };
}

function archivedTime(session: Session): string {
  const removedAt = (session as { removedAt?: unknown }).removedAt;
  return typeof removedAt === 'string' ? removedAt : '';
}

/** Newest archived time first. Valid timestamps beat missing ones; id breaks ties. */
function compareArchivedNewestFirst(a: Session, b: Session): number {
  const aTime = archivedTime(a);
  const bTime = archivedTime(b);
  const ta = Date.parse(aTime);
  const tb = Date.parse(bTime);
  const aOk = aTime !== '' && !Number.isNaN(ta);
  const bOk = bTime !== '' && !Number.isNaN(tb);
  if (aOk && bOk && ta !== tb) return tb - ta;
  if (aOk !== bOk) return aOk ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function selectArchivedChildren(
  archived: readonly Session[],
  rootId: string,
  liveIds: ReadonlySet<string>,
): Session[] {
  const newestById = new Map<string, Session>();
  for (const session of archived) {
    if (session.id === rootId || session.parentSessionId !== rootId) continue;
    if (liveIds.has(session.id)) continue;
    const prev = newestById.get(session.id);
    if (!prev || compareArchivedNewestFirst(session, prev) <= 0) {
      newestById.set(session.id, session);
    }
  }
  return Array.from(newestById.values())
    .sort(compareArchivedNewestFirst)
    .slice(0, ARCHIVED_CHILD_CAP);
}

function buildArchivedCard(session: Session): SessionCard {
  const previews = session.preview ? session.preview.files.map((f) => f.fileName) : [];
  const derived: CardDerived = {
    status: session.status,
    activity: 'unknown',
    openAttention: 0,
    unreadMail: 0,
    previews,
    ...(session.shellType !== undefined ? { shellType: session.shellType } : {}),
    ...(session.model !== undefined ? { model: session.model } : {}),
  };
  return {
    archived: true,
    sessionId: session.id,
    name: session.name,
    ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
    declared: session.card ?? null,
    derived,
    stale: false,
  };
}

export class BoardService implements BoardServiceApi {
  private readonly deps: BoardDeps;

  constructor(deps: BoardDeps) {
    this.deps = deps;
  }

  private buildCardForSession(session: Session): Promise<SessionCard> {
    return (async () => {
      const [attentionRes, unreadRes, prRes] = await Promise.all([
        Promise.resolve()
          .then(() => this.deps.attention(session.id))
          .catch((): { activity: Activity; openCount: number } => ({
            activity: { state: 'unknown' },
            openCount: 0,
          })),
        Promise.resolve()
          .then(() => this.deps.unreadMail(session.id))
          .catch(() => 0),
        session.pullRequestUrl
          ? Promise.resolve()
              .then(() => this.deps.prStatus(session.pullRequestUrl!))
              .catch(() => null)
          : Promise.resolve(null),
      ]);

      const activity = attentionRes.activity;
      const openAttention = attentionRes.openCount;
      const unreadMail = unreadRes;
      const previews = session.preview ? session.preview.files.map((f) => f.fileName) : [];

      const derived: CardDerived = {
        status: session.status,
        activity: activity.state,
        ...(activity.state === 'idle' && activity.lastActivityAt !== undefined
          ? { idleSince: activity.lastActivityAt }
          : {}),
        openAttention,
        unreadMail,
        ...(session.pullRequestUrl && prRes
          ? {
              pr: {
                url: session.pullRequestUrl,
                state: prRes.state,
                stale: prRes.stale,
                checkedAt: prRes.checkedAt,
              },
            }
          : {}),
        previews,
        ...(session.shellType !== undefined ? { shellType: session.shellType } : {}),
        ...(session.model !== undefined ? { model: session.model } : {}),
      };

      const declared = session.card ?? null;
      let stale = false;
      if (declared && activity.lastActivityAt) {
        const lastActMs = Date.parse(activity.lastActivityAt);
        const updMs = Date.parse(declared.updatedAt);
        if (!Number.isNaN(lastActMs) && !Number.isNaN(updMs) && lastActMs - updMs > CARD_STALE_MS) {
          stale = true;
        }
      }

      const card: SessionCard = {
        sessionId: session.id,
        name: session.name,
        ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
        declared,
        derived,
        stale,
      };
      return card;
    })();
  }

  async card(sessionId: string): Promise<SessionCard | null> {
    const session = await this.deps.loadSession(sessionId);
    if (!session) return null;
    return this.buildCardForSession(session);
  }

  async board(query: BoardQuery): Promise<Board> {
    const session = await this.deps.loadSession(query.sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const rootId = session.parentSessionId ?? session.id;
    const listArchived = this.deps.listArchived;

    const [allSessions, cursor, eventsPage, archivedSessions, rootSession] = await Promise.all([
      this.deps.listSessions(),
      this.deps.events.head(rootId),
      query.since !== undefined
        ? readAllEventsSince(this.deps, rootId, query.since)
        : Promise.resolve(null),
      query.all && listArchived ? listArchived() : Promise.resolve([] as Session[]),
      session.id === rootId ? Promise.resolve(session) : this.deps.loadSession(rootId),
    ]);

    const sinceSessionIds = eventsPage
      ? new Set(eventsPage.events.map((e) => e.sessionId))
      : null;

    const liveChildren = allSessions.filter(
      (s) => s.parentSessionId === rootId && s.id !== rootId,
    );
    const liveIds = new Set(liveChildren.map((s) => s.id));
    let children = liveChildren;

    if (!query.all) {
      children = children.filter(
        (s) =>
          s.status === 'running' ||
          s.status === 'pending' ||
          (sinceSessionIds !== null && sinceSessionIds.has(s.id)),
      );
    }

    if (sinceSessionIds !== null) {
      children = children.filter((s) => sinceSessionIds.has(s.id));
    }

    children.sort((a, b) => {
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) {
        return ta - tb;
      }
      return a.createdAt.localeCompare(b.createdAt);
    });

    let archivedChildren: Session[] = [];
    if (query.all) {
      archivedChildren = selectArchivedChildren(archivedSessions, rootId, liveIds);
      if (sinceSessionIds !== null) {
        archivedChildren = archivedChildren.filter((s) => sinceSessionIds.has(s.id));
      }
    }

    let cards = [
      ...(await Promise.all(children.map((c) => this.buildCardForSession(c)))),
      ...archivedChildren.map((c) => buildArchivedCard(c)),
    ];

    if (query.ready) {
      cards = cards.filter(
        (c) => c.derived.pr?.state === 'passed' && c.declared?.state !== 'done',
      );
    }

    const rollup = emptyRollup();
    for (const c of cards) {
      const key: BoardRollupKey = c.declared?.state ?? 'unset';
      rollup[key] += 1;
    }

    const plan = rootSession?.plan ? orderPlan(rootSession.plan.items) : undefined;

    return {
      rootId,
      cursor,
      cards,
      rollup,
      ...(plan !== undefined ? { plan } : {}),
    };
  }

  async digest(
    sessionId: string,
    sinceSeq: number,
  ): Promise<{ line: string | null; cursor: number }> {
    const session = await this.deps.loadSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const rootId = session.parentSessionId ?? session.id;
    const { events } = await readAllEventsSince(this.deps, rootId, sinceSeq);
    if (events.length === 0) {
      return { line: null, cursor: sinceSeq };
    }

    const lastEvent = events[events.length - 1]!;
    const cursor = lastEvent.seq;
    const hhmm = formatLocalHHMM(events[0]!.ts);

    // Latest event per child wins; order by latest event appearance
    const latestByChild = new Map<string, TreeEvent>();
    for (const ev of events) {
      if (ev.sessionId === rootId) continue;
      if (latestByChild.has(ev.sessionId)) {
        latestByChild.delete(ev.sessionId);
      }
      latestByChild.set(ev.sessionId, ev);
    }

    const childEvents = Array.from(latestByChild.values());
    if (childEvents.length === 0) {
      return { line: null, cursor };
    }

    const cardsById = new Map<string, SessionCard | null>();
    await Promise.all(
      childEvents.map(async (ev) => {
        const c = await this.card(ev.sessionId);
        cardsById.set(ev.sessionId, c);
      }),
    );

    const visibleEvents = childEvents.slice(0, 6);
    const extraCount = childEvents.length - visibleEvents.length;

    const parts: string[] = [];
    for (const ev of visibleEvents) {
      const card = cardsById.get(ev.sessionId) ?? null;
      const name = card?.name ?? ev.sessionName;
      const state = card?.declared?.state ?? '-';
      const rawHeadline = card?.declared?.headline ?? '';
      const headline = sliceCodePoints(rawHeadline, 60);
      const prState = card?.derived.pr?.state;

      let part = `${name} ${state}`;
      if (headline) {
        part += ` "${headline}"`;
      }
      if (prState) {
        part += ` (PR ${prState})`;
      }
      parts.push(part);
    }

    if (extraCount > 0) {
      parts.push(`+${extraCount} more`);
    }

    let totalQuestions = 0;
    for (const ev of childEvents) {
      const card = cardsById.get(ev.sessionId);
      if (card) {
        totalQuestions += card.derived.openAttention;
      }
    }
    if (totalQuestions > 0) {
      parts.push(`${totalQuestions} question(s) waiting`);
    }

    let line = `[ftown] since ${hhmm}: ${parts.join(' | ')}`;
    if (line.length > DIGEST_MAX) {
      let cut = DIGEST_MAX;
      const code = line.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        cut -= 1;
      }
      line = line.slice(0, cut);
    }

    return { line, cursor };
  }
}
