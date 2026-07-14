import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installFtownSessionsCli } from './install-ftown-cli.js';

// These tests override $HOME so installFtownSessionsCli (which resolves everything from
// homedir() at call time) writes into a throwaway dir instead of the real ~/.ftown.
describe('installFtownSessionsCli', () => {
  let realHome: string | undefined;
  let tmp: string;
  let fakeCli: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    tmp = mkdtempSync(join(tmpdir(), 'ftw-install-sessions-'));
    const dist = join(tmp, 'dist');
    mkdirSync(dist, { recursive: true });
    fakeCli = join(dist, 'ftown-sessions-cli.js');
    writeFileSync(fakeCli, "#!/usr/bin/env node\nimport './wire-types.js';\n");
    writeFileSync(join(dist, 'wire-types.js'), 'export const WIRE_TYPES = true;\n');
    process.env.HOME = tmp;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('copies the cli and the shared wire-types module so runtime imports resolve', () => {
    installFtownSessionsCli(fakeCli);
    const ftown = join(tmp, '.ftown');
    assert.strictEqual(existsSync(join(ftown, 'ftown-sessions-cli.js')), true);
    // The critical regression: without the sibling wire-types copy the installed CLI is
    // dead on arrival ("Cannot find module './wire-types.js'").
    assert.strictEqual(existsSync(join(ftown, 'wire-types.js')), true);
    assert.ok(readFileSync(join(ftown, 'wire-types.js'), 'utf8').includes('WIRE_TYPES'));
  });

  it('writes an executable launcher under $HOME/.ftown and returns its path', () => {
    const launcher = installFtownSessionsCli(fakeCli);
    assert.strictEqual(launcher, join(tmp, '.ftown', 'ftown-sessions'));
    assert.strictEqual(existsSync(launcher), true);
    assert.ok(statSync(launcher).mode & 0o100);
    assert.ok(readFileSync(launcher, 'utf8').includes('ftown-sessions-cli.js'));
  });

  it('writes the shared ~/.ftown/package.json ESM marker', () => {
    installFtownSessionsCli(fakeCli);
    assert.deepStrictEqual(JSON.parse(readFileSync(join(tmp, '.ftown', 'package.json'), 'utf8')), {
      type: 'module',
    });
  });
});
