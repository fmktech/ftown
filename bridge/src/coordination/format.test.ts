process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatBoard,
  formatBoardRow,
  formatEvent,
} from './format.js';
import type { Board, SessionCard, TreeEvent } from './contract.js';

function makeCard(overrides: Partial<SessionCard> = {}): SessionCard {
  return {
    sessionId: 'child-1',
    name: 'worker-a',
    parentSessionId: 'root-1',
    declared: {
      state: 'working',
      headline: 'implementing parser',
      updatedAt: '2026-11-13T12:00:00.000Z',
    },
    derived: {
      status: 'running',
      activity: 'thinking',
      openAttention: 0,
      unreadMail: 0,
      previews: [],
    },
    stale: false,
    ...overrides,
  };
}

describe('format.ts', () => {
  it('formats a basic board row', () => {
    const card = makeCard();
    const row = formatBoardRow(card, Date.parse('2026-11-13T12:05:00.000Z'));
    assert.equal(row, 'worker-a working thinking  implementing parser');
  });

  it('formats a board row with no declared card (- state and - headline)', () => {
    const card = makeCard({ declared: null });
    const row = formatBoardRow(card, Date.parse('2026-11-13T12:05:00.000Z'));
    assert.equal(row, 'worker-a - thinking  -');
  });

  it('shows idle minutes only when activity === "idle"', () => {
    const idleCard = makeCard({
      derived: {
        status: 'running',
        activity: 'idle',
        idleSince: '2026-11-13T12:00:00.000Z',
        openAttention: 0,
        unreadMail: 0,
        previews: [],
      },
    });
    const now = Date.parse('2026-11-13T12:07:45.000Z'); // 7m 45s -> floor 7m
    assert.equal(
      formatBoardRow(idleCard, now),
      'worker-a working idle idle 7m  implementing parser',
    );

    const activeCardWithIdleSince = makeCard({
      derived: {
        status: 'running',
        activity: 'tool_use',
        idleSince: '2026-11-13T12:00:00.000Z',
        openAttention: 0,
        unreadMail: 0,
        previews: [],
      },
    });
    assert.equal(
      formatBoardRow(activeCardWithIdleSince, now),
      'worker-a working tool_use  implementing parser',
    );
  });

  it('formats optional PR, attention, unread mail, and stale markers in exact order', () => {
    const card = makeCard({
      declared: {
        state: 'waiting_review',
        headline: 'ready for review',
        updatedAt: '2026-11-13T11:00:00.000Z',
      },
      derived: {
        status: 'running',
        activity: 'idle',
        idleSince: '2026-11-13T11:50:00.000Z',
        openAttention: 2,
        unreadMail: 3,
        pr: {
          url: 'https://github.com/org/repo/pull/42',
          state: 'passed',
          stale: false,
          checkedAt: '2026-11-13T12:00:00.000Z',
        },
        previews: ['index.html'],
      },
      stale: true,
    });
    const now = Date.parse('2026-11-13T12:00:00.000Z');
    assert.equal(
      formatBoardRow(card, now),
      'worker-a waiting_review idle idle 10m  ready for review  PR:passed  !2  ✉3  (stale)',
    );
  });

  it('formats an empty board as "no child sessions"', () => {
    const board: Board = {
      rootId: 'root-1',
      cursor: 0,
      cards: [],
      rollup: {
        working: 0,
        blocked: 0,
        waiting_review: 0,
        done: 0,
        failed: 0,
        unset: 0,
      },
    };
    assert.equal(formatBoard(board, Date.now()), 'no child sessions');
  });

  it('formats a board with multiple rows and non-zero rollup keys only', () => {
    const c1 = makeCard({
      sessionId: 'c1',
      name: 'w1',
      declared: {
        state: 'working',
        headline: 'task 1',
        updatedAt: '2026-11-13T12:00:00.000Z',
      },
    });
    const c2 = makeCard({
      sessionId: 'c2',
      name: 'w2',
      declared: {
        state: 'blocked',
        headline: 'waiting on API',
        updatedAt: '2026-11-13T12:00:00.000Z',
      },
    });
    const c3 = makeCard({
      sessionId: 'c3',
      name: 'w3',
      declared: null,
    });
    const board: Board = {
      rootId: 'root-1',
      cursor: 5,
      cards: [c1, c2, c3],
      rollup: {
        working: 1,
        blocked: 1,
        waiting_review: 0,
        done: 0,
        failed: 0,
        unset: 1,
      },
    };
    const now = Date.parse('2026-11-13T12:00:00.000Z');
    const expected = [
      'w1 working thinking  task 1',
      'w2 blocked thinking  waiting on API',
      'w3 - thinking  -',
      '1 working, 1 blocked, 1 unset',
    ].join('\n');
    assert.equal(formatBoard(board, now), expected);
  });

  it('formats a tree event as #<seq> HH:MM <sessionName> <kind>: <summary>', () => {
    const ts = '2026-11-13T14:05:09.000Z';
    const ev: TreeEvent = {
      seq: 17,
      ts,
      sessionId: 'child-1',
      sessionName: 'worker-a',
      kind: 'status',
      summary: 'working: implementing parser',
    };
    assert.equal(
      formatEvent(ev),
      '#17 14:05 worker-a status: working: implementing parser',
    );
  });
});
