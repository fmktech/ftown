import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { migrateLegacyDataDir, resetFtownHomeForTests, resolveDefaultDataDir, resolveFtownHome } from './ftown-home.js';
import {
  configureSessionRegistryHome,
  registerSessionWorkspace,
  resolveSessionIdFromHookPayload,
} from './session-registry.js';

// homedir() reads $HOME at call time; overriding it isolates every read/write
// under a throwaway home — the provider-env-store.test.ts
// pattern.
describe('ftown-home', () => {
  let realHome: string | undefined;
  let home: string;

  beforeEach(() => {
    realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
  });

  afterEach(() => {
    // Reset all injected/memoized home state so no later test inherits a stale
    // custom home or a default cached under a prior test's $HOME.
    resetFtownHomeForTests();
    configureSessionRegistryHome(undefined);
    if (realHome === undefined) delete process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    else process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('resolves without migrating legacy data; only explicit setup moves it', () => {
    const originalCwd = process.cwd(); const workspace = join(home, 'workspace');
    mkdirSync(join(workspace, 'data', 'sessions'), { recursive: true });
    writeFileSync(join(workspace, 'data', 'sessions', 'history'), 'keep'); process.chdir(workspace);
    try {
      const destination = resolveDefaultDataDir();
      assert.equal(existsSync(destination), false);
      assert.equal(existsSync(join(workspace, 'data/sessions/history')), true);
      migrateLegacyDataDir();
      assert.equal(readFileSync(join(destination, 'sessions/history'), 'utf8'), 'keep');
      assert.equal(existsSync(join(workspace, 'data')), false);
      migrateLegacyDataDir();
    } finally { process.chdir(originalCwd); }
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
    it('bridge.json / session-registry.json', () => {
      const ftHome = resolveFtownHome(resolveDefaultDataDir());
      for (const file of ['bridge.json', 'session-registry.json']) {
        assert.strictEqual(join(ftHome, file), join(homedir(), '.ftown', file));
      }
    });
  });

  // A non-default injected home must own its instance files and never touch
  // $HOME/.ftown.
  describe('injected custom home routes writes away from $HOME/.ftown', () => {
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
