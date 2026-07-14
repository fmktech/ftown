import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LoopController } from './loop-controller.js';
import type { LoopRunStoreApi, LoopStoreApi } from './loop-controller.js';
import type { Loop, LoopDraft } from './types.js';

function makeLoop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-1',
    name: 'nightly',
    bridgeId: 'bridge-1',
    schedule: { kind: 'interval', everyMs: 60_000 },
    harness: 'codex',
    task: 'run checks',
    enabled: true,
    overlapPolicy: 'skip',
    retention: { autoClearAfterRuns: 3 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    runCount: 0,
    skipCount: 0,
    ...overrides,
  };
}

/** In-memory LoopStoreApi fake that mimics the file-backed module semantics. */
function makeFakeLoopStore(initial: Loop[] = []): LoopStoreApi & { loops: Loop[]; created: LoopDraft[] } {
  const loops = [...initial];
  const created: LoopDraft[] = [];
  return {
    loops,
    created,
    createLoop(draft) {
      created.push(draft);
      const loop = makeLoop({ ...draft, id: `loop-${loops.length + 1}` });
      loops.push(loop);
      return loop;
    },
    getLoop: (id) => loops.find((l) => l.id === id),
    listLoops: () => loops,
    updateLoop(id, patch) {
      const loop = loops.find((l) => l.id === id);
      if (!loop) return null;
      Object.assign(loop, patch, { updatedAt: new Date().toISOString() });
      return loop;
    },
    deleteLoop(id) {
      const index = loops.findIndex((l) => l.id === id);
      if (index === -1) return false;
      loops.splice(index, 1);
      return true;
    },
    mutateLoopRuntime(id, fn) {
      const loop = loops.find((l) => l.id === id);
      if (!loop) return null;
      fn(loop);
      return loop;
    },
  };
}

interface Harness {
  controller: LoopController;
  store: ReturnType<typeof makeFakeLoopStore>;
  published: Loop[];
  removed: string[];
  deleted: Loop[];
  deletedRunRecords: string[];
  kicks: () => number;
  setRunning: (running: boolean) => void;
}

function setup(initial: Loop[] = []): Harness {
  const store = makeFakeLoopStore(initial);
  const published: Loop[] = [];
  const removed: string[] = [];
  const deleted: Loop[] = [];
  const deletedRunRecords: string[] = [];
  let kicks = 0;
  let running = false;

  const loopRunStore: LoopRunStoreApi = {
    deleteLoopRunRecords: (loopId) => {
      deletedRunRecords.push(loopId);
    },
    listLoopRunRecordsWithFallback: async () => [],
  };

  const controller = new LoopController({
    bridgeId: 'bridge-1',
    scheduler: {
      kick: () => {
        kicks += 1;
      },
      onLoopDeleted: (loop) => {
        deleted.push(loop);
      },
    },
    isSessionRunning: () => running,
    publishLoopUpdate: async (loop) => {
      published.push(loop);
    },
    publishLoopRemoved: async (loopId) => {
      removed.push(loopId);
    },
    listWireSessions: async () => [],
    loadTerminalLog: async () => '',
    loopStore: store,
    loopRunStore,
  });

  return {
    controller,
    store,
    published,
    removed,
    deleted,
    deletedRunRecords,
    kicks: () => kicks,
    setRunning: (r) => {
      running = r;
    },
  };
}

describe('LoopController.runNow', () => {
  it('reports overlap for a skip-policy loop with a live run — no write, no publish, no kick', async () => {
    const loop = makeLoop({ lastStatus: 'running', lastSessionId: 'sess-1' });
    const h = setup([loop]);
    h.setRunning(true);

    const outcome = await h.controller.runNow('loop-1');

    assert.deepEqual(outcome, { fired: false, reason: 'overlap' });
    assert.equal(loop.runNowRequested, undefined, 'manual-fire flag must not be written');
    assert.equal(h.published.length, 0);
    assert.equal(h.kicks(), 0);
  });

  it('fires when the last run is dead even under skip policy: flags, publishes, kicks', async () => {
    const loop = makeLoop({ lastStatus: 'running', lastSessionId: 'sess-1' });
    const h = setup([loop]);
    h.setRunning(false); // stale lastStatus, but the session is gone

    const outcome = await h.controller.runNow('loop-1');

    assert.ok(outcome.fired);
    assert.equal(outcome.loop.runNowRequested, true);
    assert.deepEqual(h.published, [loop]);
    assert.equal(h.kicks(), 1);
  });

  it('allow-policy loops fire even while the last run is still live', async () => {
    const loop = makeLoop({ overlapPolicy: 'allow', lastStatus: 'running', lastSessionId: 'sess-1' });
    const h = setup([loop]);
    h.setRunning(true);

    const outcome = await h.controller.runNow('loop-1');
    assert.ok(outcome.fired);
  });

  it('returns not_found for an unknown loop id', async () => {
    const h = setup();
    assert.deepEqual(await h.controller.runNow('nope'), { fired: false, reason: 'not_found' });
    assert.equal(h.published.length, 0);
    assert.equal(h.kicks(), 0);
  });

  it('returns not_found (and never publishes/kicks) when the loop is deleted between the read and the write', async () => {
    const loop = makeLoop();
    const h = setup([loop]);
    // Simulate a concurrent delete_loop winning the race: getLoop sees the
    // loop, mutateLoopRuntime does not.
    const realMutate = h.store.mutateLoopRuntime.bind(h.store);
    h.store.mutateLoopRuntime = (id, fn) => {
      h.store.deleteLoop(id);
      return realMutate(id, fn);
    };

    const outcome = await h.controller.runNow('loop-1');

    assert.deepEqual(outcome, { fired: false, reason: 'not_found' });
    assert.equal(h.published.length, 0, 'a deleted loop must never be re-published');
    assert.equal(h.kicks(), 0);
  });
});

describe('LoopController.create', () => {
  it('maps a validation failure to { ok: false, code: invalid } without writing or publishing', async () => {
    const h = setup();

    const result = await h.controller.create({ name: '   ' }); // no schedule/harness/task either

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'invalid');
      assert.ok(result.message.length > 0, 'carries the validator message');
    }
    assert.equal(h.store.created.length, 0, 'nothing persisted');
    assert.equal(h.published.length, 0, 'nothing published');
  });

  it('forces bridgeId to this bridge, trims the name, persists, and publishes once', async () => {
    const h = setup();

    const result = await h.controller.create({
      name: '  nightly  ',
      bridgeId: 'someone-elses-bridge',
      schedule: { kind: 'interval', everyMs: 60_000 },
      harness: 'codex',
      task: 'run checks',
      enabled: true,
      overlapPolicy: 'skip',
      retention: { autoClearAfterRuns: 3 },
    });

    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.loop.bridgeId, 'bridge-1');
      assert.equal(result.loop.name, 'nightly');
    }
    assert.equal(h.store.created.length, 1);
    assert.equal(h.store.created[0].bridgeId, 'bridge-1');
    assert.equal(h.published.length, 1);
  });

  it('maps a store/publish throw to { ok: false, code: failed } with the error message', async () => {
    const h = setup();
    h.store.createLoop = () => {
      throw new Error('bad cron expression');
    };

    const result = await h.controller.create({
      name: 'nightly',
      schedule: { kind: 'cron', expression: '* * * * *' },
      harness: 'codex',
      task: 'run checks',
      enabled: true,
      overlapPolicy: 'skip',
      retention: { autoClearAfterRuns: 3 },
    });

    assert.deepEqual(result, { ok: false, code: 'failed', message: 'bad cron expression' });
  });
});

describe('LoopController.update / delete', () => {
  it('update returns not_found for an unknown loop and invalid for a bad patch', async () => {
    const h = setup([makeLoop()]);

    const missing = await h.controller.update('nope', { enabled: false });
    assert.deepEqual(missing, { ok: false, code: 'not_found', message: 'Loop not found' });

    const invalid = await h.controller.update('loop-1', { name: '   ' });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.code, 'invalid');
    assert.equal(h.published.length, 0);
  });

  it('delete stops scheduler tracking, drops run records, and publishes removal — only when the loop existed', async () => {
    const loop = makeLoop();
    const h = setup([loop]);

    assert.deepEqual(await h.controller.delete('loop-1'), { removed: true });
    assert.deepEqual(h.deleted, [loop]);
    assert.deepEqual(h.deletedRunRecords, ['loop-1']);
    assert.deepEqual(h.removed, ['loop-1']);

    assert.deepEqual(await h.controller.delete('loop-1'), { removed: false });
    assert.equal(h.removed.length, 1, 'no second publish for an already-deleted loop');
  });
});
