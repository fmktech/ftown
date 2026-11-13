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
import { formatLocalHHMM } from './format.js';
import type { Activity } from '../attention-events.js';
import type { Session } from '../types.js';

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

    const [allSessions, cursor, eventsPage] = await Promise.all([
      this.deps.listSessions(),
      this.deps.events.head(rootId),
      query.since !== undefined
        ? readAllEventsSince(this.deps, rootId, query.since)
        : Promise.resolve(null),
    ]);

    const sinceSessionIds = eventsPage
      ? new Set(eventsPage.events.map((e) => e.sessionId))
      : null;

    let children = allSessions.filter(
      (s) => s.parentSessionId === rootId && s.id !== rootId,
    );

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

    let cards = await Promise.all(children.map((c) => this.buildCardForSession(c)));

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

    return {
      rootId,
      cursor,
      cards,
      rollup,
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
