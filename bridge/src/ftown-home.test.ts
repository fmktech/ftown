import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resetFtownHomeForTests, resolveDefaultDataDir, resolveFtownHome } from './ftown-home.js';
import { configureLoopStoreHome, createLoop, listLoops } from './loop-store.js';
import { configureLoopRunStoreHome, listLoopRunRecords, upsertLoopRunRecord } from './loop-run-store.js';
import {
  configureSessionRegistryHome,
  registerSessionWorkspace,
  resolveSessionIdFromHookPayload,
} from './session-registry.js';
import type { LoopDraft, LoopRunRecord } from './types.js';

// homedir() reads $HOME at call time; overriding it isolates every read/write
// under a throwaway home — the loop-store.test.ts / provider-env-store.test.ts
// pattern.
describe('ftown-home', () => {
  let realHome: string | undefined;
  let home: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    // Reset all injected/memoized home state so no later test inherits a stale
    // custom home or a default cached under a prior test's $HOME.
    resetFtownHomeForTests();
    configureLoopStoreHome(undefined);
    configureLoopRunStoreHome(undefined);
    configureSessionRegistryHome(undefined);
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  describe('resolveFtownHome', () => {
    it('maps the DEFAULT data dir to $HOME/.ftown', () => {
      assert.strictEqual(resolveFtownHome(resolveDefaultDataDir()), join(homedir(), '.ftown'));
    });

    it('maps the default passed EXPLICITLY (resolve-equal) to $HOME/.ftown', () => {
      // The literal default path, as a caller would pass it via --data-dir.
      const explicitDefault = join(homedir(), '.ftown', 'data');
      assert.strictEqual(resolve(explicitDefault), resolve(resolveDefaultDataDir()));
      assert.strictEqual(resolveFtownHome(explicitDefault), join(homedir(), '.ftown'));
    });

    it('returns a custom absolute data dir as its own instance home', () => {
      const custom = join(tmpdir(), 'ftw-custom-abs-xyz');
      assert.strictEqual(resolveFtownHome(custom), resolve(custom));
    });

    it('resolves a relative data dir against cwd', () => {
      assert.strictEqual(resolveFtownHome('./some/rel/dir'), resolve('./some/rel/dir'));
    });
  });

  // Guards the backward-compat contract: with the DEFAULT data dir, every routed
  // instance file must land at EXACTLY the old join(homedir(),'.ftown',<file>).
  describe('backward-compat: default paths are byte-for-byte unchanged', () => {
    it('bridge.json / loops.json / loop-runs.json / session-registry.json', () => {
      const ftHome = resolveFtownHome(resolveDefaultDataDir());
      for (const file of ['bridge.json', 'loops.json', 'loop-runs.json', 'session-registry.json']) {
        assert.strictEqual(join(ftHome, file), join(homedir(), '.ftown', file));
      }
    });
  });

  // A non-default injected home must own its instance files and never touch
  // $HOME/.ftown.
  describe('injected custom home routes writes away from $HOME/.ftown', () => {
    function draft(): LoopDraft {
      return {
        name: 'nightly',
        bridgeId: 'bridge-1',
        schedule: { kind: 'interval', everyMs: 60_000 },
        harness: 'claude',
        task: 'do the thing',
        enabled: true,
        overlapPolicy: 'skip',
        retention: { autoClearAfterRuns: 10 },
      };
    }

    it('loop-store writes loops.json under the injected home, not $HOME/.ftown', () => {
      const custom = mkdtempSync(join(tmpdir(), 'ftw-custom-home-'));
      try {
        configureLoopStoreHome(custom);
        createLoop(draft());
        assert.ok(existsSync(join(custom, 'loops.json')), 'loops.json under custom home');
        assert.ok(!existsSync(join(home, '.ftown', 'loops.json')), '$HOME/.ftown/loops.json untouched');
        assert.strictEqual(listLoops().length, 1);
      } finally {
        rmSync(custom, { recursive: true, force: true });
      }
    });

    it('loop-run-store writes loop-runs.json under the injected home, not $HOME/.ftown', () => {
      const custom = mkdtempSync(join(tmpdir(), 'ftw-custom-runs-'));
      try {
        configureLoopRunStoreHome(custom);
        const rec: LoopRunRecord = {
          id: 'run-1',
          loopId: 'loop-1',
          bridgeId: 'bridge-1',
          name: 'nightly · run-1',
          status: 'ok',
          startedAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
        upsertLoopRunRecord(rec);
        assert.ok(existsSync(join(custom, 'loop-runs.json')), 'loop-runs.json under custom home');
        assert.ok(
          !existsSync(join(home, '.ftown', 'loop-runs.json')),
          '$HOME/.ftown/loop-runs.json untouched',
        );
        assert.strictEqual(listLoopRunRecords('loop-1').length, 1);
      } finally {
        rmSync(custom, { recursive: true, force: true });
      }
    });

    it('session-registry writes under the injected home, not $HOME/.ftown', () => {
      const custom = mkdtempSync(join(tmpdir(), 'ftw-custom-reg-'));
      try {
        configureSessionRegistryHome(custom);
        registerSessionWorkspace('sess-1', '/tmp/ws-abc');
        assert.ok(existsSync(join(custom, 'session-registry.json')), 'registry under custom home');
        assert.ok(
          !existsSync(join(home, '.ftown', 'session-registry.json')),
          '$HOME/.ftown/session-registry.json untouched',
        );
        const resolved = resolveSessionIdFromHookPayload({ workspace_roots: ['/tmp/ws-abc'] });
        assert.strictEqual(resolved?.sessionId, 'sess-1');
      } finally {
        rmSync(custom, { recursive: true, force: true });
      }
    });
  });
});
