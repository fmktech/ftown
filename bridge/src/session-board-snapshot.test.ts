import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionBoardPublisher, type SessionBoardSource } from './session-board-snapshot.js';
import type { BoardSnapshot } from './coordination/contract-c.js';

const snapshot: BoardSnapshot = {
  board: { rootId: 'root', cursor: 0, cards: [], rollup: { working: 0, blocked: 0, waiting_review: 0, done: 0, failed: 0, unset: 0 } },
  events: [], attention: [],
};

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(predicate(), true, 'condition did not become true');
}

test('failed board delivery does not cache the digest; retry is sent, then identical snapshots are suppressed', async () => {
  const source: SessionBoardSource = {
    board: async () => snapshot.board,
    events: { head: async () => 0, read: async (_root, opts) => ({ events: [], cursor: opts?.since ?? 0 }) },
    openAttention: async () => [],
  };
  let attempts = 0;
  const publisher = createSessionBoardPublisher({
    source, userId: 'user', debounceMs: 0,
    loadSession: async () => null,
    publish: async () => { attempts += 1; if (attempts === 1) throw new Error('queue full'); },
  });
  try {
    publisher.schedule('root');
    await waitFor(() => attempts === 1);
    publisher.schedule('root');
    await waitFor(() => attempts === 2);
    publisher.schedule('root');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(attempts, 2);
    publisher.reconcile(['root']);
    await waitFor(() => attempts === 3);
  } finally { publisher.stop(); }
});
