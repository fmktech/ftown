import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listLoopRunRecords, upsertLoopRunRecord } from './loop-run-store.js';
import type { LoopRunRecord } from './types.js';

// homedir() reads $HOME at call time, so overriding it points every read/write
// at a throwaway ~/.ftown/loop-runs.json — mirrors loop-store.test.ts.
describe('loop-run-store — legacy skipped-record cleanup', () => {
  let realHome: string | undefined;
  let home: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'ftw-loop-runs-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  const runsDir = () => join(home, '.ftown');
  const runsPath = () => join(home, '.ftown', 'loop-runs.json');

  function record(overrides: Partial<LoopRunRecord> = {}): LoopRunRecord {
    return {
      id: 'run-1',
      loopId: 'loop-1',
      bridgeId: 'bridge-1',
      name: 'nightly · run-1',
      status: 'ok',
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      ...overrides,
    };
  }

  it('filters legacy skipped records out of listLoopRunRecords', () => {
    mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
    const runs: LoopRunRecord[] = [
      record({ id: 'run-ok', status: 'ok' }),
      record({ id: 'run-skipped', status: 'skipped', sessionId: undefined }),
    ];
    writeFileSync(runsPath(), JSON.stringify({ runs }), { mode: 0o600 });

    const loaded = listLoopRunRecords('loop-1');

    assert.deepStrictEqual(
      loaded.map((r) => r.id).sort(),
      ['run-ok'],
    );
  });

  it('shrinks the on-disk file on next save after loading legacy skipped records', () => {
    mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
    const runs: LoopRunRecord[] = [
      record({ id: 'run-ok', status: 'ok' }),
      record({ id: 'run-skipped', status: 'skipped', sessionId: undefined }),
    ];
    writeFileSync(runsPath(), JSON.stringify({ runs }), { mode: 0o600 });

    // Any write path re-saves the already-filtered in-memory state.
    upsertLoopRunRecord(record({ id: 'run-ok', status: 'ok', updatedAt: new Date(1).toISOString() }));

    const onDisk = JSON.parse(readFileSync(runsPath(), 'utf8')) as { runs: LoopRunRecord[] };
    assert.deepStrictEqual(
      onDisk.runs.map((r) => r.id).sort(),
      ['run-ok'],
    );
  });

  it('returns [] when loop-runs.json is absent', () => {
    assert.deepStrictEqual(listLoopRunRecords('loop-1'), []);
  });
});
