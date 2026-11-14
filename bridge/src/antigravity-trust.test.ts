import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { antigravitySettingsPath, ensureAntigravityWorkdirTrust } from './antigravity-trust.js';

describe('ensureAntigravityWorkdirTrust', () => {
  let home: string;
  let workspace: string;
  let originalHome: string | undefined;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = realpathSync(mkdtempSync(join(tmpdir(), 'agy-trust-home-')));
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'agy-trust-ws-')));
    process.env.HOME = home;
    originalLog = console.log;
    originalError = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const settingsPath = () => antigravitySettingsPath(home);
  const readSettings = () => JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;

  function writeSettings(value: unknown): void {
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(value, null, 2));
  }

  it('creates settings.json with the workdir realpath when missing', () => {
    ensureAntigravityWorkdirTrust(workspace);
    assert.deepEqual(readSettings(), { trustedWorkspaces: [workspace] });
  });

  it('is idempotent: a second call does not duplicate the entry', () => {
    ensureAntigravityWorkdirTrust(workspace);
    const first = readFileSync(settingsPath(), 'utf8');
    ensureAntigravityWorkdirTrust(workspace);
    assert.equal(readFileSync(settingsPath(), 'utf8'), first);
    assert.deepEqual(readSettings().trustedWorkspaces, [workspace]);
  });

  it('preserves other top-level keys and existing trusted entries', () => {
    const other = join(workspace, 'other');
    mkdirSync(other);
    const otherReal = realpathSync(other);
    writeSettings({ theme: 'dark', trustedWorkspaces: [otherReal] });

    ensureAntigravityWorkdirTrust(workspace);

    assert.deepEqual(readSettings(), { theme: 'dark', trustedWorkspaces: [otherReal, workspace] });
  });

  it('adds the realpath when the workdir is reached through a symlink', () => {
    const real = join(workspace, 'real');
    const link = join(workspace, 'link');
    mkdirSync(real);
    symlinkSync(real, link);

    ensureAntigravityWorkdirTrust(link);

    assert.deepEqual(readSettings().trustedWorkspaces, [realpathSync(real)]);
  });

  it('never adds a parent of the workdir', () => {
    const child = join(workspace, 'child');
    mkdirSync(child);

    ensureAntigravityWorkdirTrust(child);

    assert.deepEqual(readSettings().trustedWorkspaces, [realpathSync(child)]);
  });

  it('never trusts the filesystem root', () => {
    ensureAntigravityWorkdirTrust('/');
    assert.equal(existsSync(settingsPath()), false);
  });

  it('never trusts the home directory', () => {
    ensureAntigravityWorkdirTrust(home);
    assert.equal(existsSync(settingsPath()), false);
  });

  it('never trusts the home directory parent or broad system roots', () => {
    for (const dir of [dirname(home), '/tmp', '/private/tmp', '/Users', '/home', '/var', '/private']) {
      ensureAntigravityWorkdirTrust(dir);
    }
    assert.equal(existsSync(settingsPath()), false);
  });

  it('creates a new settings.json with mode 0600', () => {
    ensureAntigravityWorkdirTrust(workspace);
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o600);
  });

  it('keeps an existing settings.json mode when rewriting', () => {
    writeSettings({ trustedWorkspaces: [] });
    chmodSync(settingsPath(), 0o644);

    ensureAntigravityWorkdirTrust(workspace);

    assert.equal(statSync(settingsPath()).mode & 0o777, 0o644);
    assert.deepEqual(readSettings().trustedWorkspaces, [workspace]);
  });

  it('leaves an unparseable settings.json untouched', () => {
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(settingsPath(), '{ not json');

    ensureAntigravityWorkdirTrust(workspace);

    assert.equal(readFileSync(settingsPath(), 'utf8'), '{ not json');
  });

  it('leaves a non-array trustedWorkspaces untouched', () => {
    writeSettings({ trustedWorkspaces: 'nope' });

    ensureAntigravityWorkdirTrust(workspace);

    assert.deepEqual(readSettings(), { trustedWorkspaces: 'nope' });
  });

  it('writes atomically and leaves no temp file behind', () => {
    ensureAntigravityWorkdirTrust(workspace);
    const dirEntries = readdirSync(join(home, '.gemini', 'antigravity-cli'));
    assert.deepEqual(
      dirEntries.filter((name) => name.endsWith('.tmp')),
      [],
    );
    assert.deepEqual(readSettings().trustedWorkspaces, [workspace]);
  });
});
