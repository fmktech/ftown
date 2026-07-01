import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLoop,
  deleteLoop,
  getLoop,
  listLoops,
  mutateLoopRuntime,
  updateLoop,
  upsertLoop,
} from './loop-store.js';
import type { Loop, LoopDraft } from './types.js';

// homedir() reads $HOME at call time, so overriding it points every read/write
// at a throwaway ~/.ftown/loops.json — the provider-env-store.test.ts pattern.
describe('loop-store', () => {
  let realHome: string | undefined;
  let home: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'ftw-loops-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  const loopsDir = () => join(home, '.ftown');
  const loopsPath = () => join(home, '.ftown', 'loops.json');

  function draft(overrides: Partial<LoopDraft> = {}): LoopDraft {
    return {
      name: 'nightly',
      bridgeId: 'bridge-1',
      schedule: { kind: 'interval', everyMs: 60_000 },
      harness: 'claude',
      task: 'do the thing',
      enabled: true,
      overlapPolicy: 'skip',
      retention: { autoClearAfterRuns: 10 },
      ...overrides,
    };
  }

  describe('loadLoops (via listLoops)', () => {
    it('returns [] when loops.json is absent', () => {
      assert.deepStrictEqual(listLoops(), []);
    });

    it('returns [] on corrupt JSON without throwing', () => {
      mkdirSync(loopsDir(), { recursive: true, mode: 0o700 });
      writeFileSync(loopsPath(), '{ not json at all', { mode: 0o600 });
      assert.doesNotThrow(() => listLoops());
      assert.deepStrictEqual(listLoops(), []);
    });
  });

  describe('createLoop', () => {
    it('assigns id, ISO timestamps, zeroed counters, and a computed nextRunAt', () => {
      const before = Date.now();
      const loop = createLoop(draft());
      const after = Date.now();

      assert.match(loop.id, /^[0-9a-f-]{36}$/);
      assert.strictEqual(loop.runCount, 0);
      assert.strictEqual(loop.skipCount, 0);
      assert.ok(!Number.isNaN(Date.parse(loop.createdAt)));
      assert.strictEqual(loop.createdAt, loop.updatedAt);

      // interval nextRunAt == createdAt + everyMs (within the create window).
      const next = Date.parse(loop.nextRunAt as string);
      assert.ok(next >= before + 60_000 && next <= after + 60_000);
    });

    it('computes nextRunAt even when the loop is created disabled', () => {
      const loop = createLoop(draft({ enabled: false }));
      assert.ok(loop.nextRunAt, 'disabled loops still get a nextRunAt target');
      assert.ok(Date.parse(loop.nextRunAt as string) > Date.now());
    });

    it('computes a cron nextRunAt', () => {
      const loop = createLoop(draft({ schedule: { kind: 'cron', expression: '0 * * * *', tz: 'UTC' } }));
      const next = new Date(Date.parse(loop.nextRunAt as string));
      assert.strictEqual(next.getUTCMinutes(), 0);
      assert.strictEqual(next.getUTCSeconds(), 0);
      assert.ok(next.getTime() > Date.now());
    });

    it('persists the loop so listLoops/getLoop find it', () => {
      const loop = createLoop(draft({ name: 'built' }));
      assert.deepStrictEqual(listLoops().map((l) => l.id), [loop.id]);
      assert.deepStrictEqual(getLoop(loop.id), loop);
      assert.strictEqual(getLoop('nope'), undefined);
    });
  });

  describe('persistence', () => {
    it('writes loops.json at mode 0o600 inside a 0o700 dir', () => {
      createLoop(draft());
      assert.strictEqual(statSync(loopsPath()).mode & 0o777, 0o600);
      assert.strictEqual(statSync(loopsDir()).mode & 0o777, 0o700);
    });
  });

  describe('updateLoop', () => {
    it('patches fields, bumps updatedAt, preserves id + createdAt', async () => {
      const loop = createLoop(draft({ name: 'old' }));
      await new Promise((r) => setTimeout(r, 2));
      const updated = updateLoop(loop.id, { name: 'new', enabled: false });

      assert.ok(updated);
      assert.strictEqual(updated!.name, 'new');
      assert.strictEqual(updated!.enabled, false);
      assert.strictEqual(updated!.id, loop.id);
      assert.strictEqual(updated!.createdAt, loop.createdAt);
      assert.notStrictEqual(updated!.updatedAt, loop.createdAt);
      assert.strictEqual(getLoop(loop.id)!.name, 'new');
    });

    it('recomputes nextRunAt when the schedule changes', () => {
      const loop = createLoop(draft({ schedule: { kind: 'interval', everyMs: 60_000 } }));
      const updated = updateLoop(loop.id, { schedule: { kind: 'interval', everyMs: 3_600_000 } });
      const next = Date.parse(updated!.nextRunAt as string);
      assert.ok(next >= Date.now() + 3_600_000 - 5_000, 'nextRunAt tracks the new interval');
    });

    it('returns null for an unknown id', () => {
      assert.strictEqual(updateLoop('missing', { name: 'x' }), null);
    });
  });

  describe('deleteLoop', () => {
    it('removes an existing loop and returns true, then false', () => {
      const loop = createLoop(draft());
      assert.strictEqual(deleteLoop(loop.id), true);
      assert.deepStrictEqual(listLoops(), []);
      assert.strictEqual(deleteLoop(loop.id), false);
    });

    it('only drops the targeted loop', () => {
      const a = createLoop(draft({ name: 'a' }));
      const b = createLoop(draft({ name: 'b' }));
      assert.strictEqual(deleteLoop(a.id), true);
      assert.deepStrictEqual(listLoops().map((l) => l.id), [b.id]);
    });
  });

  describe('upsertLoop', () => {
    it('inserts a new loop', () => {
      const loop = createLoop(draft());
      const fresh: Loop = { ...loop, id: 'external-id', name: 'inserted' };
      upsertLoop(fresh);
      assert.strictEqual(getLoop('external-id')!.name, 'inserted');
      assert.strictEqual(listLoops().length, 2);
    });

    it('replaces an existing loop in place (no duplicate)', () => {
      const loop = createLoop(draft({ name: 'v1' }));
      upsertLoop({ ...loop, name: 'v2', runCount: 5 });
      const stored = listLoops();
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0].name, 'v2');
      assert.strictEqual(stored[0].runCount, 5);
    });
  });

  describe('mutateLoopRuntime', () => {
    it('applies the mutation to only the targeted loop and returns the merged record', () => {
      const loop = createLoop(draft());
      const updated = mutateLoopRuntime(loop.id, (l) => {
        l.lastStatus = 'running';
        l.runCount = 3;
      });
      assert.ok(updated);
      assert.strictEqual(updated!.lastStatus, 'running');
      assert.strictEqual(updated!.runCount, 3);
      assert.strictEqual(getLoop(loop.id)!.runCount, 3);
    });

    it('returns null and writes nothing when the id is absent (a concurrent delete wins)', () => {
      const loop = createLoop(draft());
      deleteLoop(loop.id);
      let called = false;
      const result = mutateLoopRuntime(loop.id, () => {
        called = true;
      });
      assert.strictEqual(result, null);
      assert.strictEqual(called, false);
      assert.deepStrictEqual(listLoops(), []);
    });
  });

  describe('bridge ownership is immutable', () => {
    it('ignores a patch that tries to move a loop to another bridge', () => {
      const loop = createLoop(draft({ bridgeId: 'bridge-A' }));
      const updated = updateLoop(loop.id, { bridgeId: 'bridge-B', name: 'renamed' } as Partial<LoopDraft>);
      assert.ok(updated);
      assert.strictEqual(updated!.bridgeId, 'bridge-A', 'bridgeId is pinned to the owning bridge');
      assert.strictEqual(updated!.name, 'renamed', 'other fields still patch');
    });
  });

  describe('corrupt-cron backstop leaves the store untouched', () => {
    it('createLoop throws on a bad cron and writes no file', () => {
      assert.throws(() => createLoop(draft({ schedule: { kind: 'cron', expression: 'garbage' } })));
      assert.strictEqual(existsSync(loopsPath()), false);
      assert.deepStrictEqual(listLoops(), []);
    });

    it('updateLoop throws on a bad cron and leaves the prior record byte-identical', () => {
      const loop = createLoop(draft({ name: 'stable' }));
      const before = readFileSync(loopsPath(), 'utf8');
      assert.throws(() => updateLoop(loop.id, { schedule: { kind: 'cron', expression: 'garbage' } }));
      assert.strictEqual(readFileSync(loopsPath(), 'utf8'), before, 'loops.json unchanged after the throw');
      assert.strictEqual(getLoop(loop.id)!.name, 'stable');
    });
  });
});
