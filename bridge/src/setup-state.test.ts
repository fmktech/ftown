import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assertSetupReady, acquireSetupLock, assertSetupVersion, readSetupState, setupHint, setupStatePath, writeSetupState, REQUIRED_SETUP_ASSETS } from './setup-state.js';

test('readiness is versioned and missing assets require explicit repair', () => {
  const home = mkdtempSync(join(tmpdir(), 'ftown-ready-'));
  try {
    assert.throws(() => assertSetupReady('1.2.3', home), /ftown-bridge@1\.2\.3 -- ftown setup/);
    writeSetupState({ schema: 1, packageVersion: '1.2.3', completedMigrations: ['stable-v1'] }, home);
    assert.throws(() => assertSetupReady('1.2.3', home), /--repair/);
    for (const path of REQUIRED_SETUP_ASSETS) {
      const full = join(home, '.ftown', path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, 'asset');
    }
    assert.doesNotThrow(() => assertSetupReady('1.2.3', home));
    rmSync(join(home, '.ftown/cli/dist/harness-commands.js'));
    assert.throws(() => assertSetupReady('1.2.3', home), /--repair/);
    writeFileSync(join(home, '.ftown/cli/dist/harness-commands.js'), 'restored');
    assert.throws(() => assertSetupReady('1.2.4', home), /ftown-bridge@1\.2\.4/);
    assert.deepEqual(readSetupState(home).completedMigrations, ['stable-v1']);
    assert.equal(JSON.parse(readFileSync(setupStatePath(home), 'utf8')).packageVersion, '1.2.3');
    assert.equal(setupHint('1.2.4'), 'npm exec --yes --package ftown-bridge@1.2.4 -- ftown setup');
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('setup lock preserves active/unknown owners and recovers only a provably dead owner', () => {
  const home = mkdtempSync(join(tmpdir(), 'ftown-lock-'));
  try {
    const release = acquireSetupLock(home);
    assert.throws(() => acquireSetupLock(home), /Another ftown setup/);
    release();
    const lock = join(home, '.ftown/setup.lock'); mkdirSync(lock);
    writeFileSync(join(lock, 'unknown-owner'), 'keep');
    assert.throws(() => acquireSetupLock(home), /unknown owner/);
    assert.equal(readFileSync(join(lock, 'unknown-owner'), 'utf8'), 'keep');
    rmSync(lock, { recursive: true }); mkdirSync(lock);
    writeFileSync(join(lock, 'owner-2147483647-deadbeef.json'), '{"pid":2147483647,"token":"deadbeef"}');
    const recovered = acquireSetupLock(home); recovered();
    assert.doesNotThrow(() => { const again = acquireSetupLock(home); again(); });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('older cached packages cannot overwrite a newer installed setup', () => {
  assert.throws(() => assertSetupVersion('0.19.40', '0.19.41'), /newer.*ftown-bridge@0\.19\.41.*--repair/);
  assert.doesNotThrow(() => assertSetupVersion('0.19.41', '0.19.40'));
});


test('null, primitive and array state roots are recoverable invalid state', () => {
  const home = mkdtempSync(join(tmpdir(), 'ftown-state-invalid-'));
  try {
    mkdirSync(join(home, '.ftown'));
    for (const raw of ['null', 'false', '42', '"text"', '[]']) {
      writeFileSync(setupStatePath(home), raw);
      assert.deepEqual(readSetupState(home), { schema: 1, completedMigrations: [] });
    }
    writeSetupState({ schema: 1, packageVersion: '1.2.3', completedMigrations: [] }, home);
    assert.equal(readSetupState(home).packageVersion, '1.2.3');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
