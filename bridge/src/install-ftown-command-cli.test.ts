import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installFtownCommandCli } from './install-ftown-command-cli.js';

// These tests override $HOME so installFtownCommandCli (which resolves everything
// from homedir() at call time) writes into a throwaway dir instead of the real ~/.ftown.
describe('installFtownCommandCli', () => {
  let realHome: string | undefined;
  let tmp: string;
  let fakeCli: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    tmp = mkdtempSync(join(tmpdir(), 'ftw-install-cmd-'));
    // A fake compiled dist dir containing the top-level dispatcher CLI. It imports
    // ONLY node builtins, so no sibling module copy is needed alongside it.
    const dist = join(tmp, 'dist');
    mkdirSync(dist, { recursive: true });
    fakeCli = join(dist, 'ftown-cli.js');
    writeFileSync(fakeCli, "#!/usr/bin/env node\nconsole.log('dispatch');\n");
    process.env.HOME = tmp;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('copies the compiled ftown-cli.js into $HOME/.ftown at mode 0644', () => {
    installFtownCommandCli(fakeCli);
    const cliJs = join(tmp, '.ftown', 'ftown-cli.js');
    assert.strictEqual(existsSync(cliJs), true);
    assert.ok(readFileSync(cliJs, 'utf8').includes('dispatch'));
    assert.strictEqual(statSync(cliJs).mode & 0o777, 0o644);
  });

  it('writes an executable ftown launcher (0755) under $HOME/.ftown and returns its path', () => {
    const launcher = installFtownCommandCli(fakeCli);
    assert.strictEqual(launcher, join(tmp, '.ftown', 'ftown'));
    assert.strictEqual(existsSync(launcher), true);
    assert.strictEqual(statSync(launcher).mode & 0o777, 0o755);
    const body = readFileSync(launcher, 'utf8');
    assert.ok(body.startsWith('#!/usr/bin/env bash'));
    // The launcher execs `node <dir>/ftown-cli.js "$@"`.
    assert.ok(body.includes(`node "${join(tmp, '.ftown', 'ftown-cli.js')}" "$@"`));
  });

  it('writes the shared ~/.ftown/package.json ESM marker', () => {
    installFtownCommandCli(fakeCli);
    assert.deepStrictEqual(JSON.parse(readFileSync(join(tmp, '.ftown', 'package.json'), 'utf8')), {
      type: 'module',
    });
  });
});
