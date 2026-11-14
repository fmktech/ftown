import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttentionItem } from '../attention-events.js';
import { AttentionStore } from '../attention-store.js';
import { SessionStore } from '../session-store.js';
import type { Session } from '../types.js';
import {
  decideRoute,
  deliverAttentionAnswer,
  escalateParentChildren,
  formatParentQuestionMail,
  markArchivedWorktreeRetained,
} from './attention-routing.js';
import { PARENT_UNAVAILABLE_NOTE, type AttentionRoutingFields } from './contract-b.js';

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

function makeItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'att-1',
    sequence: 1,
    type: 'agent_needs_input',
    title: 'Pick DB',
    message: 'Which database should we use?',
    createdAt: '2026-11-13T10:01:00.000Z',
    lastSeenAt: '2026-11-13T10:01:00.000Z',
    occurrences: 1,
    ...overrides,
  };
}

describe('attention-routing', () => {
  it('decideRoute routes to parent only when child has running non-shell parent and to is not human', () => {
    const parent = makeSession('parent-1', { name: 'Parent', status: 'running', shellType: 'claude' });
    const child = makeSession('child-1', { name: 'Child', parentSessionId: 'parent-1' });

    assert.equal(decideRoute(child, parent, true), 'parent');
    assert.equal(decideRoute(child, parent, true, 'human'), 'human');
    assert.equal(decideRoute(child, parent, false), 'human');
    assert.equal(decideRoute(child, null, true), 'human');
    assert.equal(decideRoute(makeSession('solo'), parent, true), 'human');
    assert.equal(
      decideRoute(child, makeSession('parent-1', { status: 'completed' }), true),
      'human',
    );
    assert.equal(
      decideRoute(child, makeSession('parent-1', { status: 'error' }), true),
      'human',
    );
    assert.equal(
      decideRoute(child, makeSession('parent-1', { shellType: 'shell' }), true),
      'human',
    );
  });

  it('formatParentQuestionMail formats plain, single-question, and multi-question items per contract', () => {
    const child = makeSession('child-1', { name: 'worker-a', parentSessionId: 'parent-1' });

    const plain = formatParentQuestionMail(child, makeItem());
    assert.equal(
      plain,
      '[ftown question id=att-1 from=worker-a (child-1)] Pick DB\n' +
        'Which database should we use?\n' +
        'Answer: ftown attention answer child-1 att-1 --option <n> | --text "<reply>"\n' +
        'Escalate to the human: ftown attention escalate child-1 att-1 --note "<context>"',
    );

    const single = formatParentQuestionMail(
      child,
      makeItem({
        prompt: {
          channel: 'mail',
          questions: [
            {
              question: 'Which database should we use?',
              options: [{ label: 'Postgres' }, { label: 'SQLite' }],
              multiSelect: false,
              allowText: true,
            },
          ],
        },
      }),
    );
    assert.equal(
      single,
      '[ftown question id=att-1 from=worker-a (child-1)] Pick DB\n' +
        'Which database should we use?\n' +
        'Options: 1) Postgres 2) SQLite\n' +
        'Answer: ftown attention answer child-1 att-1 --option <n> | --text "<reply>"\n' +
        'Escalate to the human: ftown attention escalate child-1 att-1 --note "<context>"',
    );

    const multi = formatParentQuestionMail(
      child,
      makeItem({
        prompt: {
          channel: 'mail',
          questions: [
            {
              question: 'Database engine?',
              options: [{ label: 'Postgres' }, { label: 'SQLite' }],
              multiSelect: false,
              allowText: false,
            },
            {
              question: 'Enable caching?',
              options: [{ label: 'Yes' }, { label: 'No' }],
              multiSelect: false,
              allowText: true,
            },
          ],
        },
      }),
    );
    assert.equal(
      multi,
      '[ftown question id=att-1 from=worker-a (child-1)] Pick DB\n' +
        'Which database should we use?\n' +
        'Q1: Database engine?\n' +
        'Options: 1) Postgres 2) SQLite\n' +
        'Q2: Enable caching?\n' +
        'Options: 1) Yes 2) No\n' +
        'Answer: ftown attention answer child-1 att-1 --option <n> | --text "<reply>"\n' +
        'Escalate to the human: ftown attention escalate child-1 att-1 --note "<context>"',
    );
  });

  it('deliverAttentionAnswer delivers via waiter or mail fallback with parent sender', async () => {
    const child = makeSession('child-1', { name: 'Child', parentSessionId: 'parent-1' });
    const item = makeItem({
      prompt: {
        channel: 'mail',
        questions: [
          {
            question: 'Which DB?',
            options: [{ label: 'Postgres' }, { label: 'SQLite' }],
            multiSelect: false,
            allowText: true,
          },
        ],
      },
      answer: {
        answers: [{ selected: [0] }],
        answeredAt: '2026-11-13T10:02:00.000Z',
      },
    });

    const mailed: Array<{ session: Session; body: Record<string, unknown> }> = [];
    const waiterResult = await deliverAttentionAnswer({
      child,
      item,
      waiterLive: true,
      sender: { from: 'parent-1', fromName: 'Parent' },
      acceptMail: async (s, b) => {
        mailed.push({ session: s, body: b });
        return { ok: true, id: 'm-1' };
      },
    });
    assert.equal(waiterResult, 'waiter');
    assert.equal(mailed.length, 0);

    const mailResult = await deliverAttentionAnswer({
      child,
      item,
      waiterLive: false,
      sender: { from: 'parent-1', fromName: 'Parent' },
      acceptMail: async (s, b) => {
        mailed.push({ session: s, body: b });
        return { ok: true, id: 'm-1' };
      },
    });
    assert.equal(mailResult, 'mail');
    assert.equal(mailed.length, 1);
    assert.equal(mailed[0].body.from, 'parent-1');
    assert.equal(mailed[0].body.fromName, 'Parent');
    assert.equal(mailed[0].body.threadId, 'attention:att-1');
  });

  it('escalateParentChildren escalates all open parent-routed items across children with PARENT_UNAVAILABLE_NOTE', async () => {
    const parent = makeSession('parent-1');
    const c1 = makeSession('c1', { parentSessionId: 'parent-1' });
    const c2 = makeSession('c2', { parentSessionId: 'parent-1' });
    const other = makeSession('other', { parentSessionId: 'parent-2' });

    const routedByChild = new Map<string, AttentionItem[]>([
      ['c1', [makeItem({ id: 'a1', route: 'parent', routedTo: 'parent-1' })]],
      ['c2', [makeItem({ id: 'a2', route: 'parent', routedTo: 'parent-1' })]],
      ['other', [makeItem({ id: 'a3', route: 'parent', routedTo: 'parent-2' })]],
    ]);
    const setRouteCalls: Array<{ sessionId: string; eventId: string; fields: AttentionRoutingFields }> = [];
    const escalatedEvents: Array<{ childId: string; item: AttentionItem }> = [];

    const escalated = await escalateParentChildren('parent-1', {
      listSessions: async () => [parent, c1, c2, other],
      attention: {
        listRouted: async (childId) => routedByChild.get(childId) ?? [],
        setRoute: async (sessionId, eventId, fields) => {
          setRouteCalls.push({ sessionId, eventId, fields });
          const found = (routedByChild.get(sessionId) ?? []).find((e) => e.id === eventId);
          return found ? { ...found, ...fields } : undefined;
        },
      },
      now: () => Date.parse('2026-11-13T12:30:00.000Z'),
      onEscalated: (childId, item) => escalatedEvents.push({ childId, item }),
    });

    assert.equal(escalated.length, 2);
    assert.equal(setRouteCalls.length, 2);
    assert.deepEqual(
      setRouteCalls.map((c) => ({
        sessionId: c.sessionId,
        eventId: c.eventId,
        route: c.fields.route,
        note: c.fields.escalationNote,
      })),
      [
        { sessionId: 'c1', eventId: 'a1', route: 'human', note: PARENT_UNAVAILABLE_NOTE },
        { sessionId: 'c2', eventId: 'a2', route: 'human', note: PARENT_UNAVAILABLE_NOTE },
      ],
    );
    assert.equal(escalatedEvents.length, 2);
    assert.equal(setRouteCalls.every((call) => call.fields.route === 'human'), true);
  });

  it('escalates a parent-routed item once when two escalations race', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftown-att-race-'));
    try {
      const store = new SessionStore(dir);
      const attention = new AttentionStore((id) => store.sessionDir(id));
      const parent = makeSession('parent-1', { name: 'Parent' });
      const child = makeSession('c1', { name: 'Child', parentSessionId: 'parent-1' });
      await store.saveSession(parent);
      await store.saveSession(child);
      const created = await attention.record('c1', 'Notification', {
        notification_type: 'agent_needs_input',
        title: 'Q',
        message: 'Need a decision please',
      });
      assert.ok(created);
      await attention.setRoute('c1', created.id, { route: 'parent', routedTo: 'parent-1' });
      let callbacks = 0;
      const deps = {
        listSessions: async () => [parent, child],
        attention,
        now: () => Date.parse('2026-11-13T12:30:00.000Z'),
        onEscalated: () => { callbacks += 1; },
      };
      const [first, second] = await Promise.all([
        escalateParentChildren('parent-1', deps),
        escalateParentChildren('parent-1', deps),
      ]);
      assert.equal(first.length + second.length, 1);
      assert.equal(callbacks, 1);
      const stored = (await attention.list('c1')).events.find((event) => event.id === created.id);
      assert.equal(stored?.route, 'human');
      assert.equal(stored?.escalationNote, PARENT_UNAVAILABLE_NOTE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('markArchivedWorktreeRetained updates the archived tombstone worktree.retained field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ftown-att-routing-'));
    try {
      const store = new SessionStore(dir);
      const s = makeSession('s-wt', {
        worktree: {
          repoRoot: '/repo',
          path: '/repo/.claude/worktrees/s-wt',
          branch: 'ftown/s-wt',
          base: 'main',
          createdByBridge: true,
        },
      });
      await store.archiveSession(s);
      await markArchivedWorktreeRetained(
        (id) => store.sessionDir(id),
        's-wt',
        'uncommitted changes',
        () => Date.parse('2026-11-13T13:00:00.000Z'),
      );
      const archived = await store.listArchived();
      assert.equal(archived.length, 1);
      assert.deepEqual(archived[0].worktree?.retained, {
        reason: 'uncommitted changes',
        at: '2026-11-13T13:00:00.000Z',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
