import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SessionResurrection, shouldResurrectStoredSession } from './session-resurrection.js';
import type { Session } from './types.js';
import { escalateParentChildren } from './coordination/attention-routing.js';
import { PARENT_UNAVAILABLE_NOTE, type AttentionRoutingFields } from './coordination/contract-b.js';
import type { AttentionItem } from './attention-events.js';

function session(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    name: 'session',
    command: 'cmd',
    status: 'running',
    bridgeId: 'b1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('shouldResurrectStoredSession', () => {
  it('resurrects only live top-level sessions', () => {
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'running' })), true);
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'pending' })), true);
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'completed' })), false);
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'error' })), false);
  });

  it('never resurrects historical automation', () => {
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'running', loopId: 'loop-1' })), false);
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'pending', loopId: 'loop-1' })), false);
  });
});

import type { SessionResurrectionDeps } from './session-resurrection.js';

function retirementHarness(records: Session[], tmuxIds: string[], killOk = true) {
  const stored = new Map(records.map((record) => [record.id, structuredClone(record)]));
  const killed: string[] = []; const published: Session[] = []; const reattached: string[] = [];
  const deps = {
    store: {
      listSessions: async () => [...stored.values()].map((record) => structuredClone(record)),
      listArchived: async () => [],
      loadSession: async (id: string) => stored.has(id) ? structuredClone(stored.get(id)!) : null,
      saveSession: async (record: Session) => { stored.set(record.id, structuredClone(record)); },
    },
    runner: {
      isRunning: (id: string) => id === 'ordinary' || id === 'factory-stage',
      reattach: (id: string) => { reattached.push(id); throw new Error('Unexpected reattach'); },
      run: () => { throw new Error('Retired automation must not launch'); },
    },
    bridgeId: 'b1', sessionFactoryDeps: {},
    publishSessionUpdate: async (record: Session) => { published.push(record); },
    wireTerminalInput: () => { throw new Error('Unexpected terminal wiring'); },
    tmux: { available: () => true, list: () => tmuxIds,
      kill: async (id: string) => { killed.push(id); return killOk; } },
  } as unknown as SessionResurrectionDeps;
  return { stored, killed, published, reattached, deps };
}

describe('retired automation startup reconciliation', () => {
  it('stops only proven exact tmux jobs and preserves ordinary/factory stage sessions and history', async () => {
    const records = [
      session({ id: 'run-1', loopId: 'old-loop', prompt: 'legacy task', env: { KEEP: 'value' } }),
      session({ id: 'run-2', status: 'pending', loopId: 'other-loop' }),
      session({ id: 'ordinary', name: 'factory-looking', prompt: 'FTS_DB=example factory/skills' }),
      session({ id: 'factory-stage', name: 'project-t1-review' }),
    ];
    const h = retirementHarness(records, ['run-1', 'ordinary', 'factory-stage', 'unknown']);
    await new SessionResurrection(h.deps).resurrectSessions();
    assert.deepEqual(h.killed, ['run-1']);
    assert.deepEqual(h.reattached, []);
    for (const id of ['run-1', 'run-2']) {
      const retired = h.stored.get(id)!;
      assert.equal(retired.status, 'error');
      assert.equal(retired.errorReason, 'Recurring loops and factory automation have been removed');
      const original = records.find((record) => record.id === id)!;
      assert.deepEqual({ ...retired, status: original.status, errorReason: undefined, updatedAt: original.updatedAt },
        { ...original, errorReason: undefined });
    }
    assert.deepEqual(h.stored.get('ordinary'), records[2]);
    assert.deepEqual(h.stored.get('factory-stage'), records[3]);
  });

  it('retains a specific stop failure, retries it on next startup, then becomes idempotent', async () => {
    const h = retirementHarness([session({ id: 'run-1', loopId: 'loop-1' })], ['run-1'], false);
    await new SessionResurrection(h.deps).resurrectSessions();
    assert.match(h.stored.get('run-1')!.errorReason!, /failed to stop retired tmux session run-1/);
    assert.equal(h.stored.get('run-1')!.status, 'error');
    h.deps.tmux!.kill = async (id) => { h.killed.push(id); return true; };
    await new SessionResurrection(h.deps).resurrectSessions();
    assert.deepEqual(h.killed, ['run-1', 'run-1']);
    assert.equal(h.stored.get('run-1')!.errorReason, 'Recurring loops and factory automation have been removed');
    h.deps.tmux!.list = () => [];
    const stable = structuredClone(h.stored.get('run-1'));
    await new SessionResurrection(h.deps).resurrectSessions();
    assert.deepEqual(h.stored.get('run-1'), stable);
  });

  it('retries exact archived automation cleanup without rewriting archives or touching current ordinary records', async () => {
    const ordinary = session({ id: 'ordinary' });
    const archived = [{ ...session({ id: 'archived-run', loopId: 'old-loop' }), removedAt: '2026-01-02' },
      { ...session({ id: 'ordinary', loopId: 'stale-loop' }), removedAt: '2026-01-02' }];
    const unchanged = structuredClone(archived);
    const h = retirementHarness([ordinary], ['archived-run', 'ordinary', 'foreign'], false);
    h.deps.store.listArchived = async () => archived;
    const messages: unknown[][] = [];
    const previousError = console.error;
    console.error = (...args: unknown[]) => { messages.push(args); };
    try {
      await new SessionResurrection(h.deps).resurrectSessions();
      assert.match(messages.flat().join(' '), /failed to stop archived retired tmux session archived-run/);
      await new SessionResurrection(h.deps).resurrectSessions();
      assert.deepEqual(h.killed, ['archived-run', 'archived-run']);
      assert.deepEqual(archived, unchanged);
      assert.deepEqual(h.stored.get('ordinary'), ordinary);
    } finally { console.error = previousError; }
  });
});

function routedItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'att-1',
    sequence: 1,
    type: 'agent_needs_input',
    title: 'Question',
    message: 'Need a decision please',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    occurrences: 1,
    route: 'parent',
    routedTo: 'parent-1',
    ...overrides,
  };
}

/** Resurrection harness whose dead-hook runs the real parent-children escalation. */
function deadParentHarness(records: Session[], options: {
  runningIds?: string[];
  deadHook?: (session: Session) => Promise<void>;
} = {}) {
  const stored = new Map(records.map((record) => [record.id, structuredClone(record)]));
  const published: Session[] = [];
  const deadCalls: Session[] = [];
  const routed = new Map<string, AttentionItem[]>();
  const escalatedNotices: Array<{ sessionId: string; item: AttentionItem }> = [];
  const attention = {
    listRouted: async (childId: string) => (routed.get(childId) ?? [])
      .filter((item) => item.route === 'parent' && !item.resolvedAt)
      .map((item) => ({ ...item })),
    setRoute: async (sessionId: string, eventId: string, fields: AttentionRoutingFields, expectRoute?: 'parent' | 'human') => {
      const item = (routed.get(sessionId) ?? []).find((candidate) => candidate.id === eventId);
      if (!item || item.resolvedAt) return undefined;
      if (expectRoute !== undefined && item.route !== expectRoute) return undefined;
      Object.assign(item, fields);
      return { ...item };
    },
  };
  const escalate = async (dead: Session) => {
    await escalateParentChildren(dead.id, {
      listSessions: async () => [...stored.values()].map((record) => structuredClone(record)),
      attention,
      now: () => Date.parse('2026-01-01T01:00:00.000Z'),
      onEscalated: (childId, item) => { escalatedNotices.push({ sessionId: childId, item }); },
    });
  };
  const deps = {
    store: {
      listSessions: async () => [...stored.values()].map((record) => structuredClone(record)),
      listArchived: async () => [],
      loadSession: async (id: string) => stored.has(id) ? structuredClone(stored.get(id)!) : null,
      saveSession: async (record: Session) => { stored.set(record.id, structuredClone(record)); },
    },
    runner: {
      isRunning: (id: string) => (options.runningIds ?? []).includes(id),
      reattach: () => false,
    },
    bridgeId: 'b1', sessionFactoryDeps: {},
    publishSessionUpdate: async (record: Session) => { published.push(structuredClone(record)); },
    wireTerminalInput: () => {},
    tmux: { available: () => false, list: () => [] as string[], kill: async () => true },
    onSessionDead: async (dead: Session) => {
      deadCalls.push(structuredClone(dead));
      await (options.deadHook ? options.deadHook(dead) : escalate(dead));
    },
  } as unknown as SessionResurrectionDeps;
  return { stored, published, deadCalls, routed, escalatedNotices, deps };
}

describe('dead-parent escalation on resurrection (F2)', () => {
  it('escalates open parent-routed child items when resurrection marks the parent dead', async () => {
    const parent = session({ id: 'parent-1' });
    const child = session({ id: 'child-1', parentSessionId: 'parent-1' });
    const h = deadParentHarness([parent, child], { runningIds: ['child-1'] });
    h.routed.set('child-1', [routedItem({ id: 'att-1', routedTo: 'parent-1' })]);
    await new SessionResurrection(h.deps).resurrectSessions();
    assert.equal(h.stored.get('parent-1')!.status, 'error');
    assert.equal(h.deadCalls.length, 1);
    assert.equal(h.deadCalls[0].id, 'parent-1');
    assert.equal(h.deadCalls[0].status, 'error');
    const item = h.routed.get('child-1')![0];
    assert.equal(item.route, 'human');
    assert.equal(item.escalationNote, PARENT_UNAVAILABLE_NOTE);
    assert.equal(item.escalatedAt, '2026-01-01T01:00:00.000Z');
    assert.deepEqual(h.escalatedNotices.map((notice) => `${notice.sessionId}:${notice.item.id}`), ['child-1:att-1']);
  });

  it('does not escalate when the parent is still running at resurrection', async () => {
    const parent = session({ id: 'parent-1' });
    const child = session({ id: 'child-1', parentSessionId: 'parent-1' });
    const h = deadParentHarness([parent, child], { runningIds: ['parent-1', 'child-1'] });
    h.routed.set('child-1', [routedItem({ id: 'att-1', routedTo: 'parent-1' })]);
    await new SessionResurrection(h.deps).resurrectSessions();
    assert.equal(h.stored.get('parent-1')!.status, 'running');
    assert.equal(h.deadCalls.length, 0);
    assert.equal(h.routed.get('child-1')![0].route, 'parent');
    assert.equal(h.escalatedNotices.length, 0);
  });

  it('keeps the dead marking when the parent-children escalation hook fails', async () => {
    const parent = session({ id: 'parent-1' });
    const child = session({ id: 'child-1', parentSessionId: 'parent-1' });
    const h = deadParentHarness([parent, child], {
      runningIds: ['child-1'],
      deadHook: async () => { throw new Error('escalation unavailable'); },
    });
    const previousError = console.error;
    console.error = () => {};
    try {
      await new SessionResurrection(h.deps).resurrectSessions();
    } finally { console.error = previousError; }
    assert.equal(h.stored.get('parent-1')!.status, 'error');
    assert.equal(h.deadCalls.length, 1);
  });
});
