import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionBoardPublisher, liveSessionBoardRoots, type SessionBoardSource } from './session-board-snapshot.js';
import type { BoardSnapshot } from './coordination/contract-c.js';

const snapshot: BoardSnapshot = {
  board: { rootId: 'root', cursor: 0, cards: [], rollup: { working: 0, blocked: 0, waiting_review: 0, done: 0, failed: 0, unset: 0 } },
  events: [], attention: [],
};

const drain = async () => {
  for (let turn = 0; turn < 3; turn++) {
    for (let n = 0; n < 30; n++) await Promise.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
};
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

test('reconnect sweep includes only own live roots, including a stopped parent with a live child', () => {
  assert.deepEqual([...liveSessionBoardRoots([
    { id: 'live', bridgeId: 'own', status: 'running' },
    { id: 'child-one', parentSessionId: 'stopped-parent', bridgeId: 'own', status: 'running' },
    { id: 'child-two', parentSessionId: 'stopped-parent', bridgeId: 'own', status: 'pending' },
    { id: 'stopped-parent', bridgeId: 'own', status: 'completed' },
    { id: 'historical', bridgeId: 'own', status: 'error' },
    { id: 'foreign', bridgeId: 'other', status: 'running' },
  ], 'own')], ['live', 'stopped-parent']);
});

test('reconnect bursts build only one probe, then at most two ACK-bound deliveries at a time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const data = source(); const builds: string[] = [];
  data.board = async query => { builds.push(query.sessionId); return { ...snapshot.board, rootId: query.sessionId }; };
  let active = 0, maximum = 0; const acknowledgements: Array<() => void> = [];
  const publisher = createSessionBoardPublisher({ source: data, userId: 'user', loadSession: async () => null,
    publish: async () => { active++; maximum = Math.max(maximum, active); await new Promise<void>(resolve => acknowledgements.push(resolve)); active--; } });
  t.after(() => publisher.stop());
  publisher.reconcile(Array.from({ length: 30 }, (_, n) => `root-${n}`));
  t.mock.timers.tick(1000); await drain(); assert.equal(builds.length, 1);
  acknowledgements.splice(0).forEach(resolve => resolve()); await drain();
  assert.equal(builds.length, 3); assert.equal(active, 2);
  for (let n = 0; n < 30 && (builds.length < 30 || active > 0); n++) {
    acknowledgements.splice(0).forEach(resolve => resolve()); await drain();
  }
  assert.equal(builds.length, 30); assert.equal(active, 0); assert.equal(maximum, 2);
});

test('latest changes during reconnect replace queued state and follow an already in-flight snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cursors = new Map([['root', 1], ['queued', 1]]), sent: Array<[string, number]> = [];
  let acknowledge!: () => void;
  const data = source(); data.board = async query => ({ ...snapshot.board, rootId: query.sessionId, cursor: cursors.get(query.sessionId) ?? 0 });
  const publisher = createSessionBoardPublisher({ source: data, userId: 'user', loadSession: async () => null,
    publish: async (root, next) => { sent.push([root, next.board.cursor]); if (sent.length === 1) await new Promise<void>(resolve => { acknowledge = resolve; }); } });
  t.after(() => publisher.stop());
  publisher.reconcile(['root', 'queued']); t.mock.timers.tick(1000); await drain();
  cursors.set('queued', 2); cursors.set('root', 2); publisher.schedule('root');
  acknowledge(); await drain(); t.mock.timers.tick(1000); await drain();
  assert.deepEqual(sent, [['root', 1], ['queued', 2], ['root', 2]]);
});

test('namespace 102 disables all further builds until reconnect despite bursts and later changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warn = t.mock.method(console, 'warn', () => {});
  const data = source(); let builds = 0, sends = 0;
  data.board = async query => { builds++; return { ...snapshot.board, rootId: query.sessionId }; };
  const publisher = createSessionBoardPublisher({ source: data, userId: 'user', loadSession: async () => null,
    publish: async () => { sends++; throw { code: 102, message: 'unknown channel' }; } });
  t.after(() => publisher.stop());
  for (let n = 0; n < 100; n++) publisher.schedule(`root-${n}`);
  t.mock.timers.tick(1000); await drain(); assert.equal(builds, 1); assert.equal(sends, 1);
  publisher.schedule('changed'); publisher.observePublication('sessions:updates#user', { type: 'session_update', session: { id: 'changed-again' } });
  t.mock.timers.tick(120_000); await drain(); assert.equal(builds, 1); assert.equal(sends, 1);
  assert.equal(warn.mock.callCount(), 1);
  publisher.reconcile(['live']); t.mock.timers.tick(1000); await drain(); assert.equal(builds, 2); assert.equal(sends, 2);
  assert.equal(warn.mock.callCount(), 2);
});

test('stopped-root changes observed while unsupported remain available for the next relay generation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let supported = false; const sent: string[] = [];
  const data = source(); data.board = async query => ({ ...snapshot.board, rootId: query.sessionId });
  const publisher = createSessionBoardPublisher({ source: data, userId: 'user', loadSession: async () => null,
    publish: async root => { if (!supported) throw { code: 102 }; sent.push(root); } });
  t.after(() => publisher.stop());
  publisher.schedule('first'); t.mock.timers.tick(1000); await drain();
  publisher.observePublication('sessions:updates#user', { type: 'session_update', session: { id: 'stopped', status: 'completed' } });
  supported = true; publisher.reconcile([]); t.mock.timers.tick(1000); await drain();
  assert.deepEqual(sent, ['first', 'stopped']);
});

test('other permanent refusals and numeric-looking strings do not disable later board changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const code of [103, 'permission_denied', '102']) {
    let sends = 0;
    const publisher = createSessionBoardPublisher({ source: source(), userId: 'user', loadSession: async () => null,
      publish: async () => { sends++; if (sends === 1) throw { code }; } });
    publisher.schedule('root'); t.mock.timers.tick(1000); await drain(); assert.equal(sends, 1);
    t.mock.timers.tick(30_000); await drain(); assert.equal(sends, 1);
    publisher.schedule('root'); t.mock.timers.tick(1000); await drain(); assert.equal(sends, 2, String(code));
    publisher.stop();
  }
});

test('a late unknown-namespace result from an older reconnect cannot disable the new generation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejectOld!: (error: unknown) => void; const sent: string[] = [];
  const data = source(); data.board = async query => ({ ...snapshot.board, rootId: query.sessionId });
  const publisher = createSessionBoardPublisher({ source: data, userId: 'user', loadSession: async () => null,
    publish: async root => { sent.push(root); if (sent.length === 1) await new Promise<void>((_resolve, reject) => { rejectOld = reject; }); } });
  t.after(() => publisher.stop());
  publisher.schedule('old'); t.mock.timers.tick(1000); await drain();
  publisher.reconcile(['new']); t.mock.timers.tick(1000); await drain(); rejectOld({ code: 102 }); await drain();
  assert.ok(sent.includes('new'));
});

test('reconnect preserves genuine pending stopped-root mutations and builds the latest queued state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cursors = new Map([['stopped', 1], ['live', 1]]), sent: Array<[string, number]> = [];
  const data = source(); data.board = async query => ({ ...snapshot.board, rootId: query.sessionId, cursor: cursors.get(query.sessionId) ?? 0 });
  const publisher = createSessionBoardPublisher({ source: data, userId: 'user', loadSession: async () => null,
    publish: async (root, next) => { sent.push([root, next.board.cursor]); } });
  t.after(() => publisher.stop());
  publisher.schedule('stopped'); cursors.set('stopped', 2); publisher.reconcile(['live']);
  t.mock.timers.tick(1000); await drain();
  assert.deepEqual(sent, [['live', 1], ['stopped', 2]]);
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
