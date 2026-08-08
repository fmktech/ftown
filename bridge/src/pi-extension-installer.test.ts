import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installPiExtension } from './pi-extension-installer.js';

describe('installPiExtension', () => {
  it('installs the bundled extension at the canonical per-user path', () => {
    const home = mkdtempSync(join(tmpdir(), 'ftown-pi-extension-'));
    const bundled = join(home, 'bundled.js');
    writeFileSync(bundled, 'export default function () {}\n');

    const installed = installPiExtension(bundled, home);

    assert.equal(installed, join(home, '.ftown', 'pi', 'ftown.js'));
    assert.equal(readFileSync(installed, 'utf8'), 'export default function () {}\n');
    assert.equal(statSync(installed).mode & 0o777, 0o600);
  });
});
