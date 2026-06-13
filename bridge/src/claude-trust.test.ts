import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ensureClaudeWorkdirTrust } from './claude-trust.js';

// Overrides $HOME so the helper writes a throwaway ~/.claude.json, never the real one.
describe('ensureClaudeWorkdirTrust', () => {
  let realHome: string | undefined;
  let home: string;
  let workdir: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    workdir = mkdtempSync(join(tmpdir(), 'ftw-wd-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  });

  const cfgPath = () => join(home, '.claude.json');
  const readCfg = () => JSON.parse(readFileSync(cfgPath(), 'utf8'));
  // The config keys projects by REAL path (e.g. /private/var/... on macOS).
  const key = () => realpathSync(workdir);

  it('creates ~/.claude.json and trusts the realpath when none exists', () => {
    ensureClaudeWorkdirTrust(workdir);
    assert.strictEqual(readCfg().projects[key()].hasTrustDialogAccepted, true);
  });

  it('preserves existing top-level fields and other projects', () => {
    writeFileSync(
      cfgPath(),
      JSON.stringify({ userID: 'abc', projects: { '/other': { hasTrustDialogAccepted: true, foo: 1 } } }),
    );
    ensureClaudeWorkdirTrust(workdir);
    const cfg = readCfg();
    assert.strictEqual(cfg.userID, 'abc');
    assert.deepStrictEqual(cfg.projects['/other'], { hasTrustDialogAccepted: true, foo: 1 });
    assert.strictEqual(cfg.projects[key()].hasTrustDialogAccepted, true);
  });

  it('is idempotent when already trusted (keeps sibling fields untouched)', () => {
    writeFileSync(
      cfgPath(),
      JSON.stringify({ projects: { [key()]: { hasTrustDialogAccepted: true, history: ['x'] } } }),
    );
    ensureClaudeWorkdirTrust(workdir);
    assert.deepStrictEqual(readCfg().projects[key()], { hasTrustDialogAccepted: true, history: ['x'] });
  });

  it('does not throw on a garbage config and rewrites it cleanly (best-effort)', () => {
    writeFileSync(cfgPath(), 'not json {');
    assert.doesNotThrow(() => ensureClaudeWorkdirTrust(workdir));
    assert.strictEqual(readCfg().projects[key()].hasTrustDialogAccepted, true);
  });
});
