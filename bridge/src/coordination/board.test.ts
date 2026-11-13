process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoardService } from './board.js';
import {
  CARD_STALE_MS,
  DIGEST_MAX,
  type BoardDeps,
  type TreeEvent,
  type TreeEventInput,
  type TreeEventLogApi,
  type TreeEventPage,
} from './contract.js';
import type { Activity } from '../attention-events.js';
import type { PullRequestState } from '../pull-request-status-protocol.js';
import type { Session } from '../types.js';

function makeSession(overrides: Partial<Session> & { id: string; name: string }): Session {
  return {
    command: 'claude',
    status: 'running',
    bridgeId: 'bridge-1',
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

class FakeTreeEventLog implements TreeEventLogApi {
  private readonly byRoot = new Map<string, TreeEvent[]>();
  public readCalls = 0;

  seed(rootId: string, events: TreeEvent[]): void {
    this.byRoot.set(rootId, [...events]);
  }

  async append(rootId: string, event: TreeEventInput): Promise<TreeEvent> {
    const list = this.byRoot.get(rootId) ?? [];
    const seq = (list[list.length - 1]?.seq ?? 0) + 1;
    const full: TreeEvent = {
      seq,
      ts: new Date().toISOString(),
      ...event,
    };
    list.push(full);
    this.byRoot.set(rootId, list);
    return full;
  }

  async read(rootId: string, opts?: { since?: number; limit?: number }): Promise<TreeEventPage> {
    this.readCalls += 1;
    const since = opts?.since ?? 0;
    const limit = Math.min(opts?.limit ?? 100, 500);
    const list = (this.byRoot.get(rootId) ?? []).filter((e) => e.seq > since);
    const sliced = list.slice(0, limit);
    const cursor = sliced.length > 0 ? sliced[sliced.length - 1]!.seq : since;
    return { events: sliced, cursor };
  }

  async wait(rootId: string, since: number): Promise<TreeEventPage> {
    return this.read(rootId, { since });
  }

  async head(rootId: string): Promise<number> {
    const list = this.byRoot.get(rootId) ?? [];
    return list.length > 0 ? list[list.length - 1]!.seq : 0;
  }
}

interface FakeEnv {
  sessions: Map<string, Session>;
  attention: Map<string, { activity: Activity; openCount: number }>;
  prStatuses: Map<string, { state: PullRequestState; stale: boolean; checkedAt: string | null } | null>;
  unreadMail: Map<string, number>;
  events: FakeTreeEventLog;
  nowMs: number;
  failAttention?: boolean;
  failPr?: boolean;
  failUnread?: boolean;
  syncThrowAttention?: boolean;
  syncThrowPr?: boolean;
  syncThrowUnread?: boolean;
  deps: BoardDeps;
}

function createFakeEnv(initialSessions: Session[] = []): FakeEnv {
  const sessions = new Map<string, Session>(initialSessions.map((s) => [s.id, s]));
  const attention = new Map<string, { activity: Activity; openCount: number }>();
  const prStatuses = new Map<string, { state: PullRequestState; stale: boolean; checkedAt: string | null } | null>();
  const unreadMail = new Map<string, number>();
  const events = new FakeTreeEventLog();

  const env: FakeEnv = {
    sessions,
    attention,
    prStatuses,
    unreadMail,
    events,
    nowMs: Date.parse('2026-11-13T12:00:00.000Z'),
    deps: {
      async loadSession(id: string) {
        return sessions.get(id) ?? null;
      },
      async listSessions() {
        return Array.from(sessions.values());
      },
      attention(id: string) {
        if (env.syncThrowAttention) throw new Error('sync attention throw');
        if (env.failAttention) return Promise.reject(new Error('attention failed'));
        return Promise.resolve(attention.get(id) ?? { activity: { state: 'thinking' }, openCount: 0 });
      },
      prStatus(url: string) {
        if (env.syncThrowPr) throw new Error('sync prStatus throw');
        if (env.failPr) return Promise.reject(new Error('prStatus failed'));
        return Promise.resolve(prStatuses.get(url) ?? null);
      },
      unreadMail(id: string) {
        if (env.syncThrowUnread) throw new Error('sync unreadMail throw');
        if (env.failUnread) return Promise.reject(new Error('unreadMail failed'));
        return Promise.resolve(unreadMail.get(id) ?? 0);
      },
      events,
      now() {
        return env.nowMs;
      },
    },
  };
  return env;
}

describe('BoardService', () => {
  it('returns null from card() for unknown session, and throws Error("Session not found") in board()/digest()', async () => {
    const env = createFakeEnv();
    const service = new BoardService(env.deps);

    assert.equal(await service.card('missing'), null);
    await assert.rejects(() => service.board({ sessionId: 'missing' }), /Session not found/);
    await assert.rejects(() => service.digest('missing', 0), /Session not found/);
  });

  it('joins session, attention, unreadMail, prStatus, previews, idleSince, and stale flag in card()', async () => {
    const updatedAt = '2026-11-13T12:00:00.000Z';
    const lastActivityAt = new Date(Date.parse(updatedAt) + CARD_STALE_MS + 1_000).toISOString();

    const s = makeSession({
      id: 'c1',
      name: 'worker-1',
      parentSessionId: 'root-1',
      shellType: 'claude',
      model: 'claude-opus-4-6',
      pullRequestUrl: 'https://github.com/org/repo/pull/10',
      preview: {
        id: 'prev-1',
        files: [
          { id: 'f1', fileName: 'index.html', kind: 'html' },
          { id: 'f2', fileName: 'notes.md', kind: 'markdown' },
        ],
      },
      card: {
        state: 'working',
        headline: 'building widget',
        progress: { done: 2, total: 5 },
        updatedAt,
      },
    });

    const env = createFakeEnv([s]);
    env.attention.set('c1', {
      activity: { state: 'idle', lastActivityAt },
      openCount: 3,
    });
    env.unreadMail.set('c1', 4);
    env.prStatuses.set('https://github.com/org/repo/pull/10', {
      state: 'passed',
      stale: false,
      checkedAt: '2026-11-13T12:05:00.000Z',
    });

    const service = new BoardService(env.deps);
    const card = await service.card('c1');
    assert.ok(card);
    assert.equal(card.sessionId, 'c1');
    assert.equal(card.name, 'worker-1');
    assert.equal(card.parentSessionId, 'root-1');
    assert.deepEqual(card.declared, s.card);
    assert.equal(card.derived.status, 'running');
    assert.equal(card.derived.activity, 'idle');
    assert.equal(card.derived.idleSince, lastActivityAt);
    assert.equal(card.derived.openAttention, 3);
    assert.equal(card.derived.unreadMail, 4);
    assert.deepEqual(card.derived.pr, {
      url: 'https://github.com/org/repo/pull/10',
      state: 'passed',
      stale: false,
      checkedAt: '2026-11-13T12:05:00.000Z',
    });
    assert.deepEqual(card.derived.previews, ['index.html', 'notes.md']);
    assert.equal(card.derived.shellType, 'claude');
    assert.equal(card.derived.model, 'claude-opus-4-6');
    assert.equal(card.stale, true);
  });

  it('does not mark card stale when activity is within CARD_STALE_MS or no declared card', async () => {
    const updatedAt = '2026-11-13T12:00:00.000Z';
    const withinStale = new Date(Date.parse(updatedAt) + CARD_STALE_MS).toISOString();

    const s1 = makeSession({
      id: 'c1',
      name: 'w1',
      card: { state: 'working', headline: 'active', updatedAt },
    });
    const s2 = makeSession({
      id: 'c2',
      name: 'w2',
    });

    const env = createFakeEnv([s1, s2]);
    env.attention.set('c1', {
      activity: { state: 'thinking', lastActivityAt: withinStale },
      openCount: 0,
    });
    env.attention.set('c2', {
      activity: { state: 'thinking', lastActivityAt: withinStale },
      openCount: 0,
    });

    const service = new BoardService(env.deps);
    const card1 = await service.card('c1');
    const card2 = await service.card('c2');
    assert.ok(card1);
    assert.equal(card1.stale, false);
    assert.equal(card1.derived.idleSince, undefined);
    assert.ok(card2);
    assert.equal(card2.stale, false);
  });

  it('degrades gracefully when derived dependencies reject or throw synchronously', async () => {
    const s = makeSession({
      id: 'c1',
      name: 'w1',
      pullRequestUrl: 'https://github.com/org/repo/pull/99',
    });
    const env = createFakeEnv([s]);
    env.failAttention = true;
    env.failPr = true;
    env.failUnread = true;

    const service = new BoardService(env.deps);
    const card = await service.card('c1');
    assert.ok(card);
    assert.equal(card.derived.activity, 'unknown');
    assert.equal(card.derived.openAttention, 0);
    assert.equal(card.derived.unreadMail, 0);
    assert.equal(card.derived.pr, undefined);

    env.failAttention = false;
    env.failPr = false;
    env.failUnread = false;
    env.syncThrowAttention = true;
    env.syncThrowPr = true;
    env.syncThrowUnread = true;

    const cardSync = await service.card('c1');
    assert.ok(cardSync);
    assert.equal(cardSync.derived.activity, 'unknown');
    assert.equal(cardSync.derived.openAttention, 0);
    assert.equal(cardSync.derived.unreadMail, 0);
    assert.equal(cardSync.derived.pr, undefined);
  });

  it('resolves root from child or root session, filters children, orders by createdAt asc, and computes rollup', async () => {
    const root = makeSession({
      id: 'root',
      name: 'orchestrator',
      createdAt: '2026-11-13T09:00:00.000Z',
    });
    const cLate = makeSession({
      id: 'c-late',
      name: 'worker-b',
      parentSessionId: 'root',
      status: 'pending',
      createdAt: '2026-11-13T10:10:00.000Z',
      card: {
        state: 'blocked',
        headline: 'blocked on schema',
        updatedAt: '2026-11-13T10:15:00.000Z',
      },
    });
    const cEarly = makeSession({
      id: 'c-early',
      name: 'worker-a',
      parentSessionId: 'root',
      status: 'running',
      createdAt: '2026-11-13T10:01:00.000Z',
      card: {
        state: 'working',
        headline: 'building',
        updatedAt: '2026-11-13T10:05:00.000Z',
      },
    });
    const cCompleted = makeSession({
      id: 'c-done',
      name: 'worker-c',
      parentSessionId: 'root',
      status: 'completed',
      createdAt: '2026-11-13T10:02:00.000Z',
      card: {
        state: 'done',
        headline: 'finished',
        updatedAt: '2026-11-13T10:20:00.000Z',
      },
    });
    const cUnset = makeSession({
      id: 'c-unset',
      name: 'worker-d',
      parentSessionId: 'root',
      status: 'running',
      createdAt: '2026-11-13T10:03:00.000Z',
    });
    const unrelated = makeSession({
      id: 'other',
      name: 'other',
      parentSessionId: 'other-root',
      status: 'running',
    });

    const env = createFakeEnv([root, cLate, cEarly, cCompleted, cUnset, unrelated]);
    await env.events.append('root', {
      sessionId: 'c-early',
      sessionName: 'worker-a',
      kind: 'status',
      summary: 'working: building',
    });

    const service = new BoardService(env.deps);

    // Query using a child session id resolves root
    const boardDefault = await service.board({ sessionId: 'c-early' });
    assert.equal(boardDefault.rootId, 'root');
    assert.equal(boardDefault.cursor, 1);
    assert.deepEqual(
      boardDefault.cards.map((c) => c.sessionId),
      ['c-early', 'c-unset', 'c-late'],
    );
    assert.deepEqual(boardDefault.rollup, {
      working: 1,
      blocked: 1,
      waiting_review: 0,
      done: 0,
      failed: 0,
      unset: 1,
    });

    // Query with all: true includes completed child
    const boardAll = await service.board({ sessionId: 'root', all: true });
    assert.deepEqual(
      boardAll.cards.map((c) => c.sessionId),
      ['c-early', 'c-done', 'c-unset', 'c-late'],
    );
    assert.equal(boardAll.rollup.done, 1);
  });

  it('filters by since (paging >500 events) and includes completed children that have events after since', async () => {
    const root = makeSession({ id: 'root', name: 'root' });
    const c1 = makeSession({
      id: 'c1',
      name: 'w1',
      parentSessionId: 'root',
      status: 'running',
      createdAt: '2026-11-13T10:01:00.000Z',
    });
    const c2Completed = makeSession({
      id: 'c2',
      name: 'w2',
      parentSessionId: 'root',
      status: 'completed',
      createdAt: '2026-11-13T10:02:00.000Z',
    });
    const env = createFakeEnv([root, c1, c2Completed]);

    // Seed 505 events: first 504 on c1 (seq 1..504), event 505 on c2Completed
    const seeded: TreeEvent[] = [];
    for (let i = 1; i <= 504; i++) {
      seeded.push({
        seq: i,
        ts: '2026-11-13T10:10:00.000Z',
        sessionId: 'c1',
        sessionName: 'w1',
        kind: 'status',
        summary: `step ${i}`,
      });
    }
    seeded.push({
      seq: 505,
      ts: '2026-11-13T10:15:00.000Z',
      sessionId: 'c2',
      sessionName: 'w2',
      kind: 'exit',
      summary: 'exited: completed',
    });
    env.events.seed('root', seeded);

    const service = new BoardService(env.deps);
    // since: 504 -> only seq 505 (c2Completed) matches
    const boardSince504 = await service.board({ sessionId: 'root', since: 504 });
    assert.deepEqual(
      boardSince504.cards.map((c) => c.sessionId),
      ['c2'],
    );
    assert.equal(boardSince504.cursor, 505);

    // since: 0 -> pages through all 505 events (2 read calls) and returns both c1 and c2
    env.events.readCalls = 0;
    const boardSince0 = await service.board({ sessionId: 'root', since: 0 });
    assert.equal(env.events.readCalls, 2);
    assert.deepEqual(
      boardSince0.cards.map((c) => c.sessionId),
      ['c1', 'c2'],
    );
  });

  it('filters by ready (derived.pr.state === "passed" && declared?.state !== "done")', async () => {
    const root = makeSession({ id: 'root', name: 'root' });
    const cReady = makeSession({
      id: 'c-ready',
      name: 'w-ready',
      parentSessionId: 'root',
      pullRequestUrl: 'https://github.com/org/repo/pull/1',
      card: { state: 'waiting_review', headline: 'pr green', updatedAt: '2026-11-13T10:00:00.000Z' },
    });
    const cDone = makeSession({
      id: 'c-done',
      name: 'w-done',
      parentSessionId: 'root',
      pullRequestUrl: 'https://github.com/org/repo/pull/2',
      card: { state: 'done', headline: 'already done', updatedAt: '2026-11-13T10:00:00.000Z' },
    });
    const cFailedPr = makeSession({
      id: 'c-failed-pr',
      name: 'w-failed',
      parentSessionId: 'root',
      pullRequestUrl: 'https://github.com/org/repo/pull/3',
      card: { state: 'working', headline: 'fixing ci', updatedAt: '2026-11-13T10:00:00.000Z' },
    });

    const env = createFakeEnv([root, cReady, cDone, cFailedPr]);
    env.prStatuses.set('https://github.com/org/repo/pull/1', {
      state: 'passed',
      stale: false,
      checkedAt: null,
    });
    env.prStatuses.set('https://github.com/org/repo/pull/2', {
      state: 'passed',
      stale: false,
      checkedAt: null,
    });
    env.prStatuses.set('https://github.com/org/repo/pull/3', {
      state: 'failed',
      stale: false,
      checkedAt: null,
    });

    const service = new BoardService(env.deps);
    const readyBoard = await service.board({ sessionId: 'root', ready: true });
    assert.deepEqual(
      readyBoard.cards.map((c) => c.sessionId),
      ['c-ready'],
    );
    assert.equal(readyBoard.rollup.waiting_review, 1);
    assert.equal(readyBoard.rollup.done, 0);
  });

  it('renders digest line with exact format, latest event per child, +N more, questions waiting, and <= DIGEST_MAX truncation', async () => {
    const root = makeSession({ id: 'root', name: 'root' });
    const c1 = makeSession({
      id: 'c1',
      name: 'auth',
      parentSessionId: 'root',
      pullRequestUrl: 'https://github.com/org/repo/pull/11',
      card: {
        state: 'waiting_review',
        headline: 'OAuth callback flow complete',
        updatedAt: '2026-11-13T12:00:00.000Z',
      },
    });
    const c2 = makeSession({
      id: 'c2',
      name: 'db',
      parentSessionId: 'root',
    });

    const env = createFakeEnv([root, c1, c2]);
    env.prStatuses.set('https://github.com/org/repo/pull/11', {
      state: 'passed',
      stale: false,
      checkedAt: null,
    });
    env.attention.set('c1', { activity: { state: 'idle' }, openCount: 1 });
    env.attention.set('c2', { activity: { state: 'thinking' }, openCount: 2 });

    const service = new BoardService(env.deps);

    // No events -> null line
    const emptyDigest = await service.digest('root', 0);
    assert.deepEqual(emptyDigest, { line: null, cursor: 0 });

    const firstTs = '2026-11-13T15:04:00.000Z';
    env.events.seed('root', [
      {
        seq: 1,
        ts: firstTs,
        sessionId: 'c1',
        sessionName: 'auth',
        kind: 'status',
        summary: 'working: starting',
      },
      {
        seq: 2,
        ts: '2026-11-13T15:06:00.000Z',
        sessionId: 'c2',
        sessionName: 'db',
        kind: 'attention',
        summary: 'needs input',
      },
      {
        seq: 3,
        ts: '2026-11-13T15:09:00.000Z',
        sessionId: 'c1',
        sessionName: 'auth',
        kind: 'pr',
        summary: 'PR passed',
      },
    ]);

    const res = await service.digest('root', 0);
    // c1 had event at seq 1 then seq 3, so latest order is c2 (seq 2) then c1 (seq 3)
    assert.equal(res.cursor, 3);
    assert.equal(
      res.line,
      '[ftown] since 15:04: db - | auth waiting_review "OAuth callback flow complete" (PR passed) | 3 question(s) waiting',
    );
  });

  it('slices headlines by code point without splitting surrogate pairs, caps at 6 children with +N more, and truncates to DIGEST_MAX', async () => {
    const root = makeSession({ id: 'root', name: 'root' });
    const children: Session[] = [];
    const seeded: TreeEvent[] = [];
    const firstTs = '2026-11-13T08:09:00.000Z';

    // 59 'A's + 🚀 (surrogate pair, 2 UTF-16 code units, 1 code point) + 'Z' = 61 code points
    const emojiHeadline = 'A'.repeat(59) + '🚀Z';

    for (let i = 1; i <= 8; i++) {
      const id = `c${i}`;
      const name = `worker-${i}-with-long-name`;
      children.push(
        makeSession({
          id,
          name,
          parentSessionId: 'root',
          pullRequestUrl: `https://github.com/org/repo/pull/${i}`,
          card: {
            state: 'working',
            headline: i === 1 ? emojiHeadline : 'X'.repeat(100),
            updatedAt: firstTs,
          },
        }),
      );
      seeded.push({
        seq: i,
        ts: firstTs,
        sessionId: id,
        sessionName: name,
        kind: 'status',
        summary: 'working',
      });
    }

    const env = createFakeEnv([root, ...children]);
    for (let i = 1; i <= 8; i++) {
      env.prStatuses.set(`https://github.com/org/repo/pull/${i}`, {
        state: 'in_progress',
        stale: false,
        checkedAt: null,
      });
    }
    env.events.seed('root', seeded);

    const service = new BoardService(env.deps);
    const res = await service.digest('root', 0);
    assert.ok(res.line);
    assert.equal(res.cursor, 8);
    assert.ok(res.line.length <= DIGEST_MAX);
    // Verify 60 code-point headline kept full 🚀 without lone surrogate and dropped 'Z'
    assert.ok(res.line.includes(`"${'A'.repeat(59)}🚀"`));
    // Verify 100-'X' headline was capped at 60 X's
    assert.ok(res.line.includes(`"${'X'.repeat(60)}"`));
    assert.ok(!res.line.includes(`"${'X'.repeat(61)}"`));

    // Verify +2 more and literal 08:09 when line is short enough not to cut it off
    const shortChildren = children.map((c, idx) => ({
      ...c,
      name: `w${idx + 1}`,
      pullRequestUrl: undefined,
      card: { state: 'done' as const, headline: 'ok', updatedAt: firstTs },
    }));
    const envShort = createFakeEnv([root, ...shortChildren]);
    envShort.events.seed(
      'root',
      seeded.map((e, idx) => ({ ...e, sessionName: `w${idx + 1}` })),
    );
    const serviceShort = new BoardService(envShort.deps);
    const resShort = await serviceShort.digest('root', 0);
    assert.equal(
      resShort.line,
      '[ftown] since 08:09: w1 done "ok" | w2 done "ok" | w3 done "ok" | w4 done "ok" | w5 done "ok" | w6 done "ok" | +2 more',
    );
  });
});
