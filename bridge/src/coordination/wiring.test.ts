import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Activity, AttentionItem } from '../attention-events.js';
import type { MailMessage, Session } from '../types.js';
import { PARENT_UNAVAILABLE_NOTE, type AttentionRoute, type AttentionRoutingFields } from './contract-b.js';
import {
  CardValidationError,
  type Board,
  type BoardDeps,
  type BoardQuery,
  type BoardServiceApi,
  type CardPatch,
  type CardStoreApi,
  type CardStoreDeps,
  type SessionCard,
  type SessionCardDeclared,
  type TreeEvent,
  type TreeEventInput,
  type TreeEventLogApi,
  type TreeEventPage,
} from './contract.js';
import { createCoordination, rootOf, type CoordinationDeps, type CoordinationPrStatusResult } from './wiring.js';

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: overrides.name ?? id,
    command: 'claude',
    status: 'running',
    bridgeId: 'bridge-1',
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

class FakeTreeEventLog implements TreeEventLogApi {
  readonly byRoot = new Map<string, TreeEvent[]>();
  shouldThrow = false;

  async append(rootId: string, input: TreeEventInput): Promise<TreeEvent> {
    if (this.shouldThrow) throw new Error('append failed');
    const list = this.byRoot.get(rootId) ?? [];
    const seq = (list.at(-1)?.seq ?? 0) + 1;
    const event: TreeEvent = {
      seq,
      ts: '2026-11-13T12:00:00.000Z',
      ...input,
    };
    list.push(event);
    this.byRoot.set(rootId, list);
    return event;
  }

  async read(rootId: string, opts?: { since?: number; limit?: number }): Promise<TreeEventPage> {
    const since = opts?.since ?? 0;
    const limit = opts?.limit ?? 100;
    const events = (this.byRoot.get(rootId) ?? []).filter((e) => e.seq > since).slice(0, limit);
    return { events, cursor: events.at(-1)?.seq ?? since };
  }

  async wait(rootId: string, since: number): Promise<TreeEventPage> {
    return this.read(rootId, { since });
  }

  async head(rootId: string): Promise<number> {
    if (this.shouldThrow) throw new Error('head failed');
    return this.byRoot.get(rootId)?.at(-1)?.seq ?? 0;
  }
}

class FakeCardStore implements CardStoreApi {
  readonly deps: CardStoreDeps;

  constructor(deps: CardStoreDeps) {
    this.deps = deps;
  }

  async get(sessionId: string): Promise<SessionCardDeclared | null> {
    const session = await this.deps.loadSession(sessionId);
    return session?.card ?? null;
  }

  async set(sessionId: string, patch: CardPatch): Promise<SessionCardDeclared> {
    const session = await this.deps.loadSession(sessionId);
    if (!session) throw new Error('Session not found');
    const previous = session.card ?? null;
    const state = patch.state ?? previous?.state;
    const headline = patch.headline ?? previous?.headline;
    if (!state || !headline) throw new CardValidationError('Missing state or headline');
    const nextCard: SessionCardDeclared = {
      state,
      headline,
      updatedAt: new Date(this.deps.now()).toISOString(),
    };
    const progress = patch.progress !== undefined ? (patch.progress ?? undefined) : previous?.progress;
    const blockedOn =
      patch.blockedOn !== undefined
        ? (patch.blockedOn ?? undefined)
        : state === 'blocked'
          ? previous?.blockedOn
          : undefined;
    const next = patch.next !== undefined ? (patch.next ?? undefined) : previous?.next;
    if (progress) nextCard.progress = progress;
    if (blockedOn) nextCard.blockedOn = blockedOn;
    if (next) nextCard.next = next;

    const saved: Session = { ...session, card: nextCard };
    await this.deps.saveSession(saved);
    await this.deps.onChange?.(saved, previous);
    return nextCard;
  }

  async clear(sessionId: string): Promise<void> {
    const session = await this.deps.loadSession(sessionId);
    if (!session) return;
    const previous = session.card ?? null;
    const saved: Session = { ...session };
    delete saved.card;
    await this.deps.saveSession(saved);
    await this.deps.onChange?.(saved, previous);
  }
}

class FakeBoardService implements BoardServiceApi {
  readonly deps: BoardDeps;
  readonly digestCalls: Array<{ sessionId: string; sinceSeq: number }> = [];
  digestHandler?: (sessionId: string, sinceSeq: number) => Promise<{ line: string | null; cursor: number }>;

  constructor(deps: BoardDeps) {
    this.deps = deps;
  }

  async card(sessionId: string): Promise<SessionCard | null> {
    const session = await this.deps.loadSession(sessionId);
    if (!session) return null;
    const att = await this.deps.attention(sessionId);
    const unreadMail = await this.deps.unreadMail(sessionId);
    const pr = session.pullRequestUrl ? await this.deps.prStatus(session.pullRequestUrl) : null;
    return {
      sessionId: session.id,
      name: session.name,
      ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
      declared: session.card ?? null,
      derived: {
        status: session.status,
        activity: att.activity.state,
        openAttention: att.openCount,
        unreadMail,
        ...(session.pullRequestUrl && pr ? { pr: { url: session.pullRequestUrl, ...pr } } : {}),
        previews: [],
      },
      stale: false,
    };
  }

  async board(query: BoardQuery): Promise<Board> {
    return {
      rootId: query.sessionId,
      cursor: await this.deps.events.head(query.sessionId),
      cards: [],
      rollup: { working: 0, blocked: 0, waiting_review: 0, done: 0, failed: 0, unset: 0 },
    };
  }

  async digest(sessionId: string, sinceSeq: number): Promise<{ line: string | null; cursor: number }> {
    this.digestCalls.push({ sessionId, sinceSeq });
    if (this.digestHandler) return this.digestHandler(sessionId, sinceSeq);
    const page = await this.deps.events.read(sessionId, { since: sinceSeq, limit: 500 });
    if (page.events.length === 0) return { line: null, cursor: sinceSeq };
    return {
      line: `[ftown] since 12:00: ${page.events.map((e) => `${e.sessionName} ${e.kind}`).join(' | ')}`,
      cursor: page.cursor,
    };
  }
}

function createHarness(options?: {
  createPlan?: CoordinationDeps['createPlan'];
  listArchived?: boolean;
}) {
  const sessions = new Map<string, Session>();
  const archived: Session[] = [];
  const published: Session[] = [];
  const attentionMap = new Map<string, { activity: Activity; openCount: number }>();
  const routedMap = new Map<string, AttentionItem[]>();
  const setRouteCalls: Array<{ sessionId: string; eventId: string; fields: AttentionRoutingFields; expectRoute?: AttentionRoute }> = [];
  const escalatedCallbacks: Array<{ sessionId: string; item: AttentionItem }> = [];
  const unreadMap = new Map<string, number>();
  const prMap = new Map<string, CoordinationPrStatusResult | null>();
  let nowMs = Date.parse('2026-11-13T12:00:00.000Z');
  let publishShouldThrow = false;
  let listSessionsShouldThrow = false;
  let loadSessionShouldThrow = false;

  let fakeEvents!: FakeTreeEventLog;
  let fakeCards!: FakeCardStore;
  let fakeBoard!: FakeBoardService;

  const coord = createCoordination({
    store: {
      loadSession: async (id) => {
        if (loadSessionShouldThrow) throw new Error('loadSession failed');
        const s = sessions.get(id);
        return s ? structuredClone(s) : null;
      },
      saveSession: async (s) => {
        sessions.set(s.id, structuredClone(s));
      },
      listSessions: async () => {
        if (listSessionsShouldThrow) throw new Error('listSessions failed');
        return [...sessions.values()].map((s) => structuredClone(s));
      },
      ...(options?.listArchived === false
        ? {}
        : {
            listArchived: async () => archived.map((s) => structuredClone(s)),
          }),
      sessionDir: (id) => `/tmp/fake-sessions/${id}`,
    },
    attention: {
      list: async (id) => attentionMap.get(id) ?? { activity: { state: 'idle' }, openCount: 0 },
      listRouted: async (childId) => routedMap.get(childId) ?? [],
      setRoute: async (sessionId, eventId, fields, expectRoute) => {
        setRouteCalls.push({ sessionId, eventId, fields, expectRoute });
        const list = routedMap.get(sessionId) ?? [];
        const idx = list.findIndex((item) => item.id === eventId);
        if (idx < 0) return undefined;
        if (expectRoute !== undefined && list[idx].route !== expectRoute) return undefined;
        const updated: AttentionItem = { ...list[idx], ...fields };
        list.splice(idx, 1);
        routedMap.set(sessionId, list);
        return updated;
      },
    },
    prStatus: async (url) => prMap.get(url) ?? null,
    mail: {
      unreadCount: async (id) => unreadMap.get(id) ?? 0,
    },
    publishSession: (s) => {
      if (publishShouldThrow) throw new Error('publish failed');
      published.push(structuredClone(s));
    },
    now: () => nowMs,
    onAttentionEscalated: (sessionId, item) => {
      escalatedCallbacks.push({ sessionId, item });
    },
    createEvents: () => {
      fakeEvents = new FakeTreeEventLog();
      return fakeEvents;
    },
    createCards: (deps) => {
      fakeCards = new FakeCardStore(deps);
      return fakeCards;
    },
    createBoard: (deps) => {
      fakeBoard = new FakeBoardService(deps);
      return fakeBoard;
    },
    ...(options?.createPlan ? { createPlan: options.createPlan } : {}),
  });

  return {
    coord,
    sessions,
    archived,
    published,
    attentionMap,
    routedMap,
    setRouteCalls,
    escalatedCallbacks,
    unreadMap,
    prMap,
    get fakeEvents() {
      return fakeEvents;
    },
    get fakeCards() {
      return fakeCards;
    },
    get fakeBoard() {
      return fakeBoard;
    },
    setNow: (ms: number) => {
      nowMs = ms;
    },
    setPublishThrow: (v: boolean) => {
      publishShouldThrow = v;
    },
    setListSessionsThrow: (v: boolean) => {
      listSessionsShouldThrow = v;
    },
    setLoadSessionThrow: (v: boolean) => {
      loadSessionShouldThrow = v;
    },
  };
}

describe('coordination wiring', () => {
  it('computes rootOf(session) as parentSessionId ?? id and emits onto the root log without throwing', async () => {
    const h = createHarness();
    const root = makeSession('root-1', { name: 'Root' });
    const child = makeSession('child-1', { name: 'Worker 1', parentSessionId: 'root-1' });
    assert.equal(rootOf(root), 'root-1');
    assert.equal(rootOf(child), 'root-1');

    await h.coord.emit(child, 'idle', 'Worker 1 idle for 2m');
    await h.coord.emit(root, 'attention', 'Need approval', 'att-9');

    const events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], {
      seq: 1,
      ts: '2026-11-13T12:00:00.000Z',
      sessionId: 'child-1',
      sessionName: 'Worker 1',
      kind: 'idle',
      summary: 'Worker 1 idle for 2m',
    });
    assert.deepEqual(events[1], {
      seq: 2,
      ts: '2026-11-13T12:00:00.000Z',
      sessionId: 'root-1',
      sessionName: 'Root',
      kind: 'attention',
      summary: 'Need approval',
      ref: 'att-9',
    });

    h.fakeEvents.shouldThrow = true;
    await assert.doesNotReject(() => h.coord.emit(child, 'exit', 'exited: error'));
  });

  it('CardStore onChange publishes session and emits status only when state, headline, or blockedOn changes', async () => {
    const h = createHarness();
    const child = makeSession('child-1', { name: 'Builder', parentSessionId: 'root-1' });
    h.sessions.set(child.id, child);

    // 1. First card write → publishes + emits status
    await h.coord.cards.set('child-1', {
      state: 'working',
      headline: 'Implementing parser',
      progress: { done: 1, total: 5 },
    });
    assert.equal(h.published.length, 1);
    let events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'status');
    assert.equal(events[0].summary, 'working: Implementing parser');

    // 2. Updating only progress or next → publishes session, does NOT emit status
    await h.coord.cards.set('child-1', {
      progress: { done: 2, total: 5 },
      next: 'Run unit tests',
    });
    assert.equal(h.published.length, 2);
    events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.length, 1);

    // 3. Same state and headline repeated → publishes session, does NOT emit status
    await h.coord.cards.set('child-1', {
      state: 'working',
      headline: 'Implementing parser',
    });
    assert.equal(h.published.length, 3);
    assert.equal((h.fakeEvents.byRoot.get('root-1') ?? []).length, 1);

    // 4. Headline change → emits status
    await h.coord.cards.set('child-1', {
      headline: 'Writing parser tests',
    });
    events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.length, 2);
    assert.equal(events[1].summary, 'working: Writing parser tests');

    // 5. Transition to blocked with blockedOn → includes " — blocked on <kind>: <text>"
    await h.coord.cards.set('child-1', {
      state: 'blocked',
      headline: 'Waiting on schema',
      blockedOn: { kind: 'session', ref: 'child-2', text: 'Need contract types' },
    });
    events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.length, 3);
    assert.equal(
      events[2].summary,
      'blocked: Waiting on schema — blocked on session: Need contract types',
    );

    // 6. Changing blockedOn text while staying blocked → emits status
    await h.coord.cards.set('child-1', {
      blockedOn: { kind: 'human', text: 'Need API key' },
    });
    events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.length, 4);
    assert.equal(events[3].summary, 'blocked: Waiting on schema — blocked on human: Need API key');

    // 7. publishSession throwing does not prevent status event emission
    h.setPublishThrow(true);
    await h.coord.cards.set('child-1', {
      state: 'done',
      headline: 'Parser complete',
    });
    h.setPublishThrow(false);
    events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.length, 5);
    assert.equal(events[4].summary, 'done: Parser complete');

    // 8. Clearing card → publishes session, does not emit status
    const beforePublishCount = h.published.length;
    await h.coord.cards.clear('child-1');
    assert.equal(h.published.length, beforePublishCount + 1);
    assert.equal(h.published.at(-1)?.card, undefined);
    assert.equal((h.fakeEvents.byRoot.get('root-1') ?? []).length, 5);
  });

  it('DigestProvider.digestFor only runs for sessions with children and tracks per-recipient cursor from first-seen head', async () => {
    const h = createHarness();
    const root = makeSession('root-1', { name: 'Root' });
    const solo = makeSession('solo-1', { name: 'Solo' });
    h.sessions.set(root.id, root);
    h.sessions.set(solo.id, solo);

    // Session without children returns null and never calls board.digest
    assert.equal(await h.coord.digest.digestFor('solo-1'), null);
    assert.equal(await h.coord.digest.digestFor('root-1'), null);
    assert.equal(h.fakeBoard.digestCalls.length, 0);

    // Add a child to root-1 and pre-populate 2 historical events before first digestFor call
    const child = makeSession('child-1', { name: 'w1', parentSessionId: 'root-1' });
    h.sessions.set(child.id, child);
    await h.coord.emit(child, 'status', 'working: step 1');
    await h.coord.emit(child, 'status', 'working: step 2');
    assert.equal(await h.fakeEvents.head('root-1'), 2);

    // First ask starts cursor at current head (2) → nothing new since first seen → returns null
    const first = await h.coord.digest.digestFor('root-1');
    assert.equal(first, null);
    assert.deepEqual(h.fakeBoard.digestCalls, [{ sessionId: 'root-1', sinceSeq: 2 }]);

    // Append new events (seq 3, 4) after first seen
    await h.coord.emit(child, 'status', 'done: finished');
    await h.coord.emit(child, 'result', 'All green');

    // Second ask requests digest since 2 and advances cursor to 4
    const second = await h.coord.digest.digestFor('root-1');
    assert.equal(second, '[ftown] since 12:00: w1 status | w1 result');
    assert.deepEqual(h.fakeBoard.digestCalls.at(-1), { sessionId: 'root-1', sinceSeq: 2 });

    // Third ask with no further events queries since 4 and returns null
    const third = await h.coord.digest.digestFor('root-1');
    assert.equal(third, null);
    assert.deepEqual(h.fakeBoard.digestCalls.at(-1), { sessionId: 'root-1', sinceSeq: 4 });

    // Errors return null and never throw
    h.fakeEvents.shouldThrow = true;
    assert.equal(await h.coord.digest.digestFor('root-2'), null);
    h.fakeEvents.shouldThrow = false;

    h.setListSessionsThrow(true);
    assert.equal(await h.coord.digest.digestFor('root-1'), null);
    h.setListSessionsThrow(false);

    h.fakeBoard.digestHandler = async () => {
      throw new Error('digest boom');
    };
    assert.equal(await h.coord.digest.digestFor('root-1'), null);
  });

  it('MailEventSink.onAccepted emits result event (first line <= 200 chars) only when child sends result to its root', async () => {
    const h = createHarness();
    const root = makeSession('root-1', { name: 'Root' });
    const otherRoot = makeSession('root-2', { name: 'OtherRoot' });
    const child = makeSession('child-1', { name: 'WorkerA', parentSessionId: 'root-1' });
    h.sessions.set(root.id, root);
    h.sessions.set(otherRoot.id, otherRoot);
    h.sessions.set(child.id, child);

    const makeMail = (overrides: Partial<MailMessage>): MailMessage => ({
      id: 'm-1',
      ts: '2026-11-13T12:00:00.000Z',
      from: 'child-1',
      to: 'root-1',
      type: 'result',
      body: 'A1 DONE | files: foo.ts\nsecond line ignored',
      ...overrides,
    });

    // Non-result mail is ignored
    await h.coord.mailSink.onAccepted(makeMail({ type: 'message' }), root);
    await h.coord.mailSink.onAccepted(makeMail({ type: 'task' }), root);
    await h.coord.mailSink.onAccepted(makeMail({ type: 'escalation' }), root);
    await h.coord.mailSink.onAccepted(makeMail({ type: 'fyi' }), root);
    assert.equal(h.fakeEvents.byRoot.get('root-1'), undefined);

    // Result mail to a recipient that is NOT sender's root is ignored
    await h.coord.mailSink.onAccepted(makeMail({ to: 'root-2' }), otherRoot);
    assert.equal(h.fakeEvents.byRoot.get('root-1'), undefined);
    assert.equal(h.fakeEvents.byRoot.get('root-2'), undefined);

    // Unknown sender is ignored
    await h.coord.mailSink.onAccepted(makeMail({ from: 'missing-session' }), root);
    assert.equal(h.fakeEvents.byRoot.get('root-1'), undefined);

    // Valid result mail from child to its root emits first line (<= 200 chars)
    const longFirstLine = 'X'.repeat(250);
    await h.coord.mailSink.onAccepted(
      makeMail({ body: `${longFirstLine}\nsecond line` }),
      root,
    );
    const events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.length, 1);
    assert.equal(events[0].sessionId, 'child-1');
    assert.equal(events[0].sessionName, 'WorkerA');
    assert.equal(events[0].kind, 'result');
    assert.equal(events[0].summary.length, 200);
    assert.equal(events[0].summary, 'X'.repeat(200));
  });

  it('wires store, attention, prStatus, and mail.unreadCount into BoardDeps', async () => {
    const h = createHarness();
    const child = makeSession('child-1', {
      name: 'Worker',
      parentSessionId: 'root-1',
      pullRequestUrl: 'https://github.com/org/repo/pull/42',
    });
    h.sessions.set(child.id, child);
    h.attentionMap.set('child-1', { activity: { state: 'thinking' }, openCount: 3 });
    h.unreadMap.set('child-1', 7);
    h.prMap.set('https://github.com/org/repo/pull/42', {
      state: 'passed',
      stale: false,
      checkedAt: '2026-11-13T12:00:00.000Z',
    });

    const card = await h.coord.board.card('child-1');
    assert.ok(card);
    assert.equal(card.derived.activity, 'thinking');
    assert.equal(card.derived.openAttention, 3);
    assert.equal(card.derived.unreadMail, 7);
    assert.deepEqual(card.derived.pr, {
      url: 'https://github.com/org/repo/pull/42',
      state: 'passed',
      stale: false,
      checkedAt: '2026-11-13T12:00:00.000Z',
    });
  });

  it('onSessionExit emits exit once per session incarnation, resets on onSessionStart, and catches loadSession errors', async () => {
    const h = createHarness();
    const child = makeSession('child-1', {
      name: 'Worker',
      parentSessionId: 'root-1',
      status: 'running',
    });
    h.sessions.set(child.id, child);

    // Non-terminal session does not emit exit and does not consume the incarnation slot
    await h.coord.onSessionExit('child-1');
    await h.coord.onSessionExit('missing-session');
    assert.equal(h.fakeEvents.byRoot.get('root-1'), undefined);

    // Transition to completed; concurrent stop + terminal-pump unregister calls emit exit only once
    h.sessions.set(child.id, { ...child, status: 'completed' });
    await Promise.all([h.coord.onSessionExit('child-1'), h.coord.onSessionExit('child-1')]);
    await h.coord.onSessionExit('child-1');

    let events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'exit');
    assert.equal(events[0].summary, 'exited: completed');

    // Restart/revive clears the emitted set for that session id so the next incarnation can emit exit
    h.coord.onSessionStart('child-1');
    h.sessions.set(child.id, { ...child, status: 'error' });
    await Promise.all([h.coord.onSessionExit('child-1'), h.coord.onSessionExit('child-1')]);

    events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.length, 2);
    assert.equal(events[1].kind, 'exit');
    assert.equal(events[1].summary, 'exited: error');

    // loadSession rejection is caught and logged without throwing
    h.coord.onSessionStart('child-1');
    h.setLoadSessionThrow(true);
    await assert.doesNotReject(() => h.coord.onSessionExit('child-1'));
    h.setLoadSessionThrow(false);
  });

  it('onSessionExit on a parent session escalates all open parent-routed child attention items with PARENT_UNAVAILABLE_NOTE', async () => {
    const h = createHarness();
    const parent = makeSession('parent-1', { name: 'Parent', status: 'completed' });
    const child1 = makeSession('child-1', { name: 'Worker 1', parentSessionId: 'parent-1' });
    const child2 = makeSession('child-2', { name: 'Worker 2', parentSessionId: 'parent-1' });
    h.sessions.set(parent.id, parent);
    h.sessions.set(child1.id, child1);
    h.sessions.set(child2.id, child2);

    h.routedMap.set('child-1', [
      {
        id: 'att-1',
        sequence: 1,
        type: 'agent_needs_input',
        title: 'Question 1',
        message: 'Help 1',
        createdAt: '2026-11-13T10:00:00.000Z',
        lastSeenAt: '2026-11-13T10:00:00.000Z',
        occurrences: 1,
        route: 'parent',
        routedTo: 'parent-1',
      },
    ]);
    h.routedMap.set('child-2', [
      {
        id: 'att-2',
        sequence: 2,
        type: 'ask_user',
        title: 'Question 2',
        message: 'Help 2',
        createdAt: '2026-11-13T10:01:00.000Z',
        lastSeenAt: '2026-11-13T10:01:00.000Z',
        occurrences: 1,
        route: 'parent',
        routedTo: 'parent-1',
      },
    ]);

    await h.coord.onSessionExit('parent-1');

    assert.equal(h.setRouteCalls.length, 2);
    assert.equal(h.setRouteCalls.every((call) => call.expectRoute === 'parent'), true);
    assert.deepEqual(
      h.setRouteCalls.map((c) => ({
        sessionId: c.sessionId,
        eventId: c.eventId,
        route: c.fields.route,
        note: c.fields.escalationNote,
      })),
      [
        { sessionId: 'child-1', eventId: 'att-1', route: 'human', note: PARENT_UNAVAILABLE_NOTE },
        { sessionId: 'child-2', eventId: 'att-2', route: 'human', note: PARENT_UNAVAILABLE_NOTE },
      ],
    );
    assert.equal(h.escalatedCallbacks.length, 2);
    assert.equal(h.escalatedCallbacks[0].sessionId, 'child-1');
    assert.equal(h.escalatedCallbacks[0].item.route, 'human');
    assert.equal(h.escalatedCallbacks[0].item.escalationNote, PARENT_UNAVAILABLE_NOTE);
  });

  it('escalates from a running snapshot and from a deleted parent without a second notice', async () => {
    const h = createHarness();
    const parent = makeSession('parent-1', { name: 'Parent', status: 'running' });
    const child = makeSession('child-1', { name: 'Worker', parentSessionId: 'parent-1' });
    h.sessions.set(parent.id, parent);
    h.sessions.set(child.id, child);
    h.routedMap.set('child-1', [
      {
        id: 'att-1',
        sequence: 1,
        type: 'agent_needs_input',
        title: 'Question',
        message: 'Help',
        createdAt: '2026-11-13T10:00:00.000Z',
        lastSeenAt: '2026-11-13T10:00:00.000Z',
        occurrences: 1,
        route: 'parent',
        routedTo: 'parent-1',
      },
    ]);

    // A live non-terminal session is not an exit.
    await h.coord.onSessionExit('parent-1');
    assert.equal(h.setRouteCalls.length, 0);
    assert.equal(h.fakeEvents.byRoot.get('parent-1'), undefined);

    // Remove/stop passes the snapshot it already holds. loadSession must not be required.
    h.setLoadSessionThrow(true);
    await h.coord.onSessionExit('parent-1', parent);
    h.setLoadSessionThrow(false);
    assert.equal(h.setRouteCalls.length, 1);
    assert.equal(h.setRouteCalls[0].fields.escalationNote, PARENT_UNAVAILABLE_NOTE);
    assert.equal(h.escalatedCallbacks.length, 1);
    assert.equal(h.fakeEvents.byRoot.get('parent-1'), undefined);

    // The record is gone. A later exit handler must still try, and must not publish again.
    h.sessions.delete('parent-1');
    h.routedMap.set('child-1', [
      {
        id: 'att-1',
        sequence: 1,
        type: 'agent_needs_input',
        title: 'Question',
        message: 'Help',
        createdAt: '2026-11-13T10:00:00.000Z',
        lastSeenAt: '2026-11-13T10:00:00.000Z',
        occurrences: 1,
        route: 'parent',
        routedTo: 'parent-1',
      },
    ]);
    h.setRouteCalls.length = 0;
    h.escalatedCallbacks.length = 0;
    await h.coord.onSessionExit('parent-1');
    assert.equal(h.setRouteCalls.length, 1);
    assert.equal(h.escalatedCallbacks.length, 1);
    await h.coord.onSessionExit('parent-1');
    assert.equal(h.escalatedCallbacks.length, 1);
  });

  it('passes sanitized archive records to the board and omits the dep when the store has none', async () => {
    const h = createHarness();
    const tombstone = makeSession('gone', {
      name: 'Retired',
      parentSessionId: 'root-1',
      status: 'completed',
      env: { TOKEN: 'secret' },
      previewSource: { version: 2, id: 'prev', root: '/tmp/secret', files: [{ id: 'f', filePath: '/tmp/secret/a.html' }] },
    });
    (tombstone as Session & { removedAt: string }).removedAt = '2026-11-13T11:00:00.000Z';
    h.archived.push(tombstone);

    assert.equal(typeof h.fakeBoard.deps.listArchived, 'function');
    const listed = await h.fakeBoard.deps.listArchived!();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'gone');
    assert.equal(listed[0].name, 'Retired');
    assert.equal(listed[0].parentSessionId, 'root-1');
    assert.equal(listed[0].status, 'completed');
    assert.equal((listed[0] as Session & { removedAt?: string }).removedAt, '2026-11-13T11:00:00.000Z');
    assert.equal(listed[0].env, undefined);
    assert.equal(listed[0].previewSource, undefined);
    assert.equal(h.archived[0].env?.TOKEN, 'secret');

    const bare = createHarness({ listArchived: false });
    assert.equal(bare.fakeBoard.deps.listArchived, undefined);
  });

  it('completes the parent plan item when a child card becomes done, and emits plan events through the store', async () => {
    const calls: Array<{ parentId: string; childId: string }> = [];
    let planDeps: { emit: (parent: Session, summary: string) => Promise<void> } | undefined;
    const h = createHarness({
      createPlan: (deps) => {
        planDeps = deps;
        return {
          get: async () => null,
          add: async () => { throw new Error('not used'); },
          patch: async () => { throw new Error('not used'); },
          remove: async () => {},
          startForChild: async () => {},
          completeForChild: async (parentId: string, childId: string) => {
            calls.push({ parentId, childId });
          },
        } as unknown as ReturnType<NonNullable<CoordinationDeps['createPlan']>>;
      },
    });
    const child = makeSession('child-1', { name: 'Builder', parentSessionId: 'root-1' });
    const root = makeSession('root-1', { name: 'Root' });
    h.sessions.set(child.id, child);
    h.sessions.set(root.id, root);

    await h.coord.cards.set('child-1', { state: 'working', headline: 'In progress' });
    assert.deepEqual(calls, []);

    await h.coord.cards.set('child-1', { state: 'done', headline: 'Shipped' });
    assert.deepEqual(calls, [{ parentId: 'root-1', childId: 'child-1' }]);

    await h.coord.cards.set('child-1', { headline: 'Shipped again' });
    assert.equal(calls.length, 1);

    await h.coord.cards.set('root-1', { state: 'done', headline: 'Manager done' });
    assert.equal(calls.length, 1);

    const failing = createHarness({
      createPlan: () => ({
        get: async () => null,
        add: async () => { throw new Error('not used'); },
        patch: async () => { throw new Error('not used'); },
        remove: async () => {},
        startForChild: async () => {},
        completeForChild: async () => { throw new Error('plan down'); },
      }) as unknown as ReturnType<NonNullable<CoordinationDeps['createPlan']>>,
    });
    failing.sessions.set('child-1', makeSession('child-1', { parentSessionId: 'root-1' }));
    await assert.doesNotReject(() => failing.coord.cards.set('child-1', { state: 'done', headline: 'Still saved' }));
    assert.equal(failing.sessions.get('child-1')?.card?.state, 'done');
    assert.equal((failing.fakeEvents.byRoot.get('root-1') ?? []).some((event) => event.kind === 'status'), true);

    assert.ok(planDeps);
    await planDeps.emit(root, 'p1 done: Ship');
    const planEvents = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(planEvents.at(-1)?.kind, 'plan');
    assert.equal(planEvents.at(-1)?.summary, 'p1 done: Ship');
  });

  it('emits removed once when a live child is archived, and not for an exit or a root', async () => {
    const h = createHarness();
    const root = makeSession('root-1', { name: 'Root', status: 'running' });
    const child = makeSession('child-1', { name: 'Worker', parentSessionId: 'root-1', status: 'running' });
    h.sessions.set(root.id, root);
    h.sessions.set(child.id, child);

    await h.coord.onSessionExit('child-1', child);
    await h.coord.onSessionExit('child-1', child);
    let events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'removed');
    assert.equal(events[0].summary, 'removed');
    assert.equal(events[0].sessionId, 'child-1');

    h.coord.onSessionStart('child-1');
    await Promise.all([
      h.coord.onSessionExit('child-1', child),
      h.coord.onSessionExit('child-1', child),
    ]);
    events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.filter((event) => event.kind === 'removed').length, 2);

    const stopped = makeSession('child-2', { name: 'Stopped', parentSessionId: 'root-1', status: 'completed' });
    h.sessions.set(stopped.id, stopped);
    await h.coord.onSessionExit('child-2', stopped);
    events = h.fakeEvents.byRoot.get('root-1') ?? [];
    assert.equal(events.filter((event) => event.sessionId === 'child-2' && event.kind === 'exit').length, 1);
    assert.equal(events.filter((event) => event.sessionId === 'child-2' && event.kind === 'removed').length, 0);

    await h.coord.onSessionExit('root-1', root);
    assert.equal((h.fakeEvents.byRoot.get('root-1') ?? []).some((event) => event.sessionId === 'root-1' && event.kind === 'removed'), false);
  });
});
