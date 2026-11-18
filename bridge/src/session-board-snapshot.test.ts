import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionBoardPublisher, type SessionBoardSource } from './session-board-snapshot.js';
import type { BoardSnapshot } from './coordination/contract-c.js';

const snapshot: BoardSnapshot = {
  board: { rootId: 'root', cursor: 0, cards: [], rollup: { working: 0, blocked: 0, waiting_review: 0, done: 0, failed: 0, unset: 0 } },
  events: [], attention: [],
};

const drain = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
function source(): SessionBoardSource {
  return {
    board: async () => structuredClone(snapshot.board),
    events: { head: async () => 0, read: async () => ({ events: [], cursor: 0 }) },
    openAttention: async () => [],
  };
}

test('failed board delivery retries without another mutation, then unchanged snapshots are suppressed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source: SessionBoardSource = {
    board: async () => snapshot.board,
    events: { head: async () => 0, read: async (_root, opts) => ({ events: [], cursor: opts?.since ?? 0 }) },
    openAttention: async () => [],
  };
  let attempts = 0;
  const publisher = createSessionBoardPublisher({
    source, userId: 'user',
    loadSession: async () => null,
    publish: async () => { attempts += 1; if (attempts === 1) throw new Error('queue full'); },
  });
  try {
    publisher.schedule('root'); t.mock.timers.tick(1000); await drain();
    assert.equal(attempts, 1);
    t.mock.timers.tick(999); await drain(); assert.equal(attempts, 1);
    t.mock.timers.tick(1); await drain(); assert.equal(attempts, 2);
    publisher.schedule('root'); t.mock.timers.tick(1000); await drain();
    assert.equal(attempts, 2);
    publisher.reconcile(['root']); t.mock.timers.tick(1000); await drain();
    assert.equal(attempts, 3);
  } finally { publisher.stop(); }
});

test('changes while delivery is pending publish the newest snapshot after the acknowledgement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const data = source(); let cursor = 1;
  data.board = async () => ({ ...structuredClone(snapshot.board), cursor });
  const sent: number[] = []; let acknowledge!: () => void;
  const publisher = createSessionBoardPublisher({ source: data, userId: 'user', loadSession: async () => null,
    publish: async (_root, next) => { sent.push(next.board.cursor); if (sent.length === 1) await new Promise<void>(resolve => { acknowledge = resolve; }); } });
  t.after(() => publisher.stop());
  publisher.schedule('root'); t.mock.timers.tick(1000); await drain();
  cursor = 2; publisher.schedule('root'); cursor = 3; publisher.schedule('root');
  t.mock.timers.tick(10_000); await drain(); assert.deepEqual(sent, [1]);
  acknowledge(); await drain(); t.mock.timers.tick(1000); await drain();
  assert.deepEqual(sent, [1, 3]);
});

test('reconnect during delivery still republishes an identical authoritative snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sends = 0, acknowledge!: () => void;
  const publisher = createSessionBoardPublisher({ source: source(), userId: 'user', loadSession: async () => null,
    publish: async () => { sends++; if (sends === 1) await new Promise<void>(resolve => { acknowledge = resolve; }); } });
  t.after(() => publisher.stop());
  publisher.schedule('root'); t.mock.timers.tick(1000); await drain();
  publisher.reconcile(['root']); acknowledge(); await drain();
  t.mock.timers.tick(1000); await drain(); assert.equal(sends, 2);
});

test('old relay namespace refusal has no idle retries and reconnect can try again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let attempts = 0;
  const publisher = createSessionBoardPublisher({ source: source(), userId: 'user', loadSession: async () => null,
    publish: async () => { attempts++; throw { code: 102, message: 'unknown channel' }; } });
  t.after(() => publisher.stop());
  publisher.schedule('root'); t.mock.timers.tick(1000); await drain();
  t.mock.timers.tick(120_000); await drain(); assert.equal(attempts, 1);
  publisher.reconcile(['root']); t.mock.timers.tick(1000); await drain(); assert.equal(attempts, 2);
});

test('reparenting refreshes the previous and new roots; removal still refreshes its old board', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const data = source(); const roots: string[] = [], reads: string[] = [];
  data.board = async query => { reads.push(query.sessionId); return { ...structuredClone(snapshot.board), rootId: query.sessionId }; };
  const publisher = createSessionBoardPublisher({ source: data, userId: 'user', loadSession: async () => null,
    initialSessions: [{ id: 'child', parentSessionId: 'old' }], publish: async root => { roots.push(root); } });
  t.after(() => publisher.stop());
  publisher.observePublication('sessions:updates#user', { type: 'session_update', session: { id: 'child', parentSessionId: 'new', status: 'running' } });
  t.mock.timers.tick(1000); await drain(); assert.deepEqual(roots, ['old', 'new']);
  publisher.observePublication('sessions:updates#user', { type: 'session_update', session: { id: 'child', parentSessionId: 'new', status: 'removed' } });
  t.mock.timers.tick(1000); await drain();
  assert.deepEqual(roots, ['old', 'new']); // unchanged data is still suppressed
  assert.deepEqual(reads, ['old', 'new', 'new']);
});

test('deleted roots and former roots do not retry builds or mislabel a different root snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let builds = 0, sends = 0;
  const data = source(); data.board = async () => { builds++; throw new Error('Session not found'); };
  const publisher = createSessionBoardPublisher({ source: data, userId: 'user', loadSession: async () => null, publish: async () => { sends++; } });
  t.after(() => publisher.stop());
  publisher.schedule('deleted'); t.mock.timers.tick(1000); await drain();
  t.mock.timers.tick(120_000); await drain(); assert.equal(builds, 1);
  data.board = async () => ({ ...snapshot.board, rootId: 'new-parent' });
  publisher.schedule('former-root'); t.mock.timers.tick(1000); await drain(); assert.equal(sends, 0);
});
