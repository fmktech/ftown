import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installFtownWorkflowsCli } from './install-ftown-workflows-cli.js';

// These tests override $HOME so installFtownWorkflowsCli (which resolves everything
// from homedir() at call time) writes into a throwaway dir instead of the real ~/.ftown.
describe('installFtownWorkflowsCli', () => {
  let realHome: string | undefined;
  let tmp: string;
  let fakeCli: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    tmp = mkdtempSync(join(tmpdir(), 'ftw-install-'));
    // A fake compiled dist dir containing the cli and its sibling runtime modules.
    const dist = join(tmp, 'dist');
    mkdirSync(dist, { recursive: true });
    fakeCli = join(dist, 'workflow-runner-cli.js');
    writeFileSync(
      fakeCli,
      "#!/usr/bin/env node\nimport './workflow-runner.js';\nimport './claude-trust.js';\n",
    );
    writeFileSync(join(dist, 'workflow-runner.js'), 'export const ENGINE = true;\n');
    writeFileSync(join(dist, 'claude-trust.js'), 'export const TRUST = true;\n');
    process.env.HOME = tmp;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('copies the cli and sibling modules so runtime imports resolve', () => {
    installFtownWorkflowsCli(fakeCli);
    const ftown = join(tmp, '.ftown');
    assert.strictEqual(existsSync(join(ftown, 'ftown-workflows-cli.js')), true);
    // The critical regression: without the sibling engine copy the installed CLI is
    // dead on arrival ("Cannot find module './workflow-runner.js'").
    assert.strictEqual(existsSync(join(ftown, 'workflow-runner.js')), true);
    assert.ok(readFileSync(join(ftown, 'workflow-runner.js'), 'utf8').includes('ENGINE'));
    assert.strictEqual(existsSync(join(ftown, 'claude-trust.js')), true);
    assert.ok(readFileSync(join(ftown, 'claude-trust.js'), 'utf8').includes('TRUST'));
  });

  it('writes an executable launcher under $HOME/.ftown and returns its path', () => {
    const launcher = installFtownWorkflowsCli(fakeCli);
    assert.strictEqual(launcher, join(tmp, '.ftown', 'ftown-workflows'));
    assert.strictEqual(existsSync(launcher), true);
    // executable bit set for at least the owner
    assert.ok(statSync(launcher).mode & 0o100);
    assert.ok(readFileSync(launcher, 'utf8').includes('ftown-workflows-cli.js'));
  });

  it('writes the shared ~/.ftown/package.json ESM marker', () => {
    installFtownWorkflowsCli(fakeCli);
    assert.deepStrictEqual(JSON.parse(readFileSync(join(tmp, '.ftown', 'package.json'), 'utf8')), {
      type: 'module',
    });
  });
});
