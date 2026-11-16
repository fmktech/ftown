import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { installOpencodePlugin } from './opencode-plugin-installer.js';

describe('installOpencodePlugin', () => {
  it('installs the bundled plugin into the opencode global plugin directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'ftown-opencode-plugin-'));
    const bundled = join(home, 'bundled.js');
    writeFileSync(bundled, 'export const FtownOpencodePlugin = async () => ({});\n');

    const installed = installOpencodePlugin(bundled, home);

    assert.equal(
      installed,
      join(home, '.config', 'opencode', 'plugins', 'ftown.js'),
    );
    assert.equal(readFileSync(installed, 'utf8'), 'export const FtownOpencodePlugin = async () => ({});\n');
    assert.equal(statSync(installed).mode & 0o777, 0o600);
  });

  it('installs under $XDG_CONFIG_HOME/opencode when XDG_CONFIG_HOME is set', () => {
    const home = mkdtempSync(join(tmpdir(), 'ftown-opencode-plugin-'));
    const bundled = join(home, 'bundled.js');
    writeFileSync(bundled, 'plugin\n');
    const xdg = join(home, 'xdg-config');

    const installed = installOpencodePlugin(bundled, home, { XDG_CONFIG_HOME: xdg });

    assert.equal(installed, join(xdg, 'opencode', 'plugins', 'ftown.js'));
    assert.equal(readFileSync(installed, 'utf8'), 'plugin\n');
    assert.equal(existsSync(join(home, '.config', 'opencode', 'plugins', 'ftown.js')), false);
  });

  it('updates the existing global plugin when an additional config directory is set', () => {
    const home = mkdtempSync(join(tmpdir(), 'ftown-opencode-plugin-'));
    const bundled = join(home, 'bundled.js');
    const globalDir = join(home, 'xdg-config', 'opencode', 'plugins');
    const configured = join(home, 'oc-config');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'ftown.js'), 'old plugin\n');
    writeFileSync(bundled, 'new plugin\n');
    const installed = installOpencodePlugin(bundled, home, {
      XDG_CONFIG_HOME: join(home, 'xdg-config'), OPENCODE_CONFIG_DIR: configured,
    });
    assert.equal(installed, join(globalDir, 'ftown.js'));
    assert.equal(readFileSync(installed, 'utf8'), 'new plugin\n');
    assert.equal(existsSync(join(configured, 'plugins', 'ftown.js')), false);
  });

  it('defaults to ~/.config/opencode when the overrides are unset or blank', () => {
    const home = mkdtempSync(join(tmpdir(), 'ftown-opencode-plugin-'));
    const bundled = join(home, 'bundled.js');
    writeFileSync(bundled, 'plugin\n');

    const installed = installOpencodePlugin(bundled, home, {
      XDG_CONFIG_HOME: '   ',
      OPENCODE_CONFIG_DIR: '',
    });

    assert.equal(installed, join(home, '.config', 'opencode', 'plugins', 'ftown.js'));
  });

  it('repairs drift when the installed copy no longer matches the bundle', () => {
    const home = mkdtempSync(join(tmpdir(), 'ftown-opencode-plugin-'));
    const bundled = join(home, 'bundled.js');
    writeFileSync(bundled, 'version-2\n');
    const installed = installOpencodePlugin(bundled, home);
    writeFileSync(installed, 'user-tampered\n');

    installOpencodePlugin(bundled, home);

    assert.equal(readFileSync(installed, 'utf8'), 'version-2\n');
  });

  it('is idempotent — an unchanged install is not rewritten', () => {
    const home = mkdtempSync(join(tmpdir(), 'ftown-opencode-plugin-'));
    const bundled = join(home, 'bundled.js');
    writeFileSync(bundled, 'same\n');

    const first = installOpencodePlugin(bundled, home);
    const before = readFileSync(first, 'utf8');
    installOpencodePlugin(bundled, home);

    assert.equal(readFileSync(first, 'utf8'), before);
  });
});

// Tests in this module own temporary homes and must not access inherited harness paths.
const inheritedPathOverrides: NodeJS.ProcessEnv = {};
const pathOverrideNames = [
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'OPENCODE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
] as const;
before(() => {
  for (const name of pathOverrideNames) {
    inheritedPathOverrides[name] = process.env[name];
    delete process.env[name];
  }
});
after(() => {
  for (const name of pathOverrideNames) {
    const value = inheritedPathOverrides[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
