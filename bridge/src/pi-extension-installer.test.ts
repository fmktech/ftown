import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installPiExtensions } from './pi-extension-installer.js';

describe('installPiExtensions', () => {
  it('installs the Pi and OMP launch assets together at their per-user paths', () => {
    const home = mkdtempSync(join(tmpdir(), 'ftown-pi-extension-'));
    const bundled = fileURLToPath(new URL('../pi-extension/', import.meta.url));
    installPiExtensions(bundled, home);

    for (const filename of ['ftown.js', 'omp.js', 'omp.yml']) {
      const installed = join(home, '.ftown', 'pi', filename);
      assert.equal(readFileSync(installed, 'utf8'), readFileSync(join(bundled, filename), 'utf8'));
      assert.equal(statSync(installed).mode & 0o777, 0o600);
    }
  });
});
