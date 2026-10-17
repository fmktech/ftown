import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSetupMigrations } from './setup-migrations.js';
import { readSetupState, writeSetupState } from './setup-state.js';

test('stable migration IDs run once across package versions; repair deliberately repeats', () => {
  const home = mkdtempSync(join(tmpdir(), 'ftown-migrate-')); let runs = 0;
  try {
    const migrations = [{ id: 'owned-assets-v1', run: () => { runs++; } }];
    assert.deepEqual(runSetupMigrations(false, migrations, home), ['owned-assets-v1']);
    writeSetupState({ ...readSetupState(home), packageVersion: 'next-version' }, home);
    assert.deepEqual(runSetupMigrations(false, migrations, home), []);
    assert.equal(runs, 1);
    assert.deepEqual(runSetupMigrations(true, migrations, home), ['owned-assets-v1']); assert.equal(runs, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('failure records only successful predecessors and retry resumes pending cleanup', () => {
  const home = mkdtempSync(join(tmpdir(), 'ftown-migrate-retry-')); let fail = true; const calls: string[] = [];
  try {
    const migrations = [{ id: 'first', run: () => { calls.push('first'); } }, { id: 'second', run: () => { calls.push('second'); if (fail) throw new Error('filesystem failure'); } }];
    assert.throws(() => runSetupMigrations(false, migrations, home), /filesystem failure/);
    assert.deepEqual(readSetupState(home).completedMigrations, ['first']);
    assert.equal(readSetupState(home).packageVersion, undefined);
    fail = false; runSetupMigrations(false, migrations, home);
    assert.deepEqual(calls, ['first', 'second', 'second']);
    assert.deepEqual(readSetupState(home).completedMigrations, ['first', 'second']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
