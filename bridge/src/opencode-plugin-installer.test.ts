import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
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
