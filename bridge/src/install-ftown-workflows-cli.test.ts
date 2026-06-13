import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    // A fake compiled dist dir containing BOTH the cli and its sibling engine module.
    const dist = join(tmp, 'dist');
    mkdirSync(dist, { recursive: true });
    fakeCli = join(dist, 'workflow-runner-cli.js');
    writeFileSync(fakeCli, "#!/usr/bin/env node\nimport './workflow-runner.js';\n");
    writeFileSync(join(dist, 'workflow-runner.js'), 'export const ENGINE = true;\n');
    process.env.HOME = tmp;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('copies BOTH the cli and the engine module so the runtime import resolves (FIX B)', () => {
    installFtownWorkflowsCli(fakeCli);
    const ftown = join(tmp, '.ftown');
    expect(existsSync(join(ftown, 'ftown-workflows-cli.js'))).toBe(true);
    // The critical regression: without the sibling engine copy the installed CLI is
    // dead on arrival ("Cannot find module './workflow-runner.js'").
    expect(existsSync(join(ftown, 'workflow-runner.js'))).toBe(true);
    expect(readFileSync(join(ftown, 'workflow-runner.js'), 'utf8')).toContain('ENGINE');
  });

  it('writes an executable launcher under $HOME/.ftown and returns its path', () => {
    const launcher = installFtownWorkflowsCli(fakeCli);
    expect(launcher).toBe(join(tmp, '.ftown', 'ftown-workflows'));
    expect(existsSync(launcher)).toBe(true);
    // executable bit set for at least the owner
    expect(statSync(launcher).mode & 0o100).toBeTruthy();
    expect(readFileSync(launcher, 'utf8')).toContain('ftown-workflows-cli.js');
  });

  it('writes the shared ~/.ftown/package.json ESM marker', () => {
    installFtownWorkflowsCli(fakeCli);
    expect(JSON.parse(readFileSync(join(tmp, '.ftown', 'package.json'), 'utf8'))).toEqual({
      type: 'module',
    });
  });
});
