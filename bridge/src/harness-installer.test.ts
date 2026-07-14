import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { agentGuidePath, harnessOnPath, installHarness, pathHint, writeHarnessAgentGuide } from './harness-installer.js';

describe('installHarness', () => {
  let realHome: string | undefined;
  let realPath: string | undefined;
  let tmp: string;
  let fakeCli: string;
  let dist: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    realPath = process.env.PATH;
    tmp = mkdtempSync(join(tmpdir(), 'ftw-harness-'));
    dist = join(tmp, 'npx-cache', 'node_modules', 'ftown-bridge', 'dist');
    mkdirSync(dist, { recursive: true });
    fakeCli = join(dist, 'harness-cli.js');
    writeFileSync(fakeCli, "#!/usr/bin/env node\nimport './harness-format.js';\nimport './wire-types.js';\n");
    writeFileSync(join(dist, 'harness-format.js'), 'export const FORMAT = true;\n');
    writeFileSync(join(dist, 'wire-types.js'), 'export const WIRE_TYPES = true;\n');
    const commander = join(tmp, 'npx-cache', 'node_modules', 'commander');
    mkdirSync(commander, { recursive: true });
    writeFileSync(join(commander, 'package.json'), '{"name":"commander","type":"module","main":"index.js"}\n');
    writeFileSync(join(commander, 'index.js'), 'export const COMMANDER = true;\n');
    process.env.HOME = tmp;
    process.env.PATH = '/usr/bin:/bin';
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realPath === undefined) delete process.env.PATH;
    else process.env.PATH = realPath;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('copies the harness cli and sibling formatter into ~/.ftown/bin', () => {
    const result = installHarness(fakeCli);
    const ftown = join(tmp, '.ftown');
    const bin = join(ftown, 'bin');
    const runtime = join(ftown, 'harness-runtime');

    assert.equal(result.wrapperPath, join(bin, 'ftown-harness'));
    assert.equal(result.cliPath, join(runtime, 'harness-cli.js'));
    assert.equal(result.binDir, bin);
    assert.equal(readFileSync(join(ftown, 'harness-cli.path'), 'utf8'), `${result.cliPath}\n`);
    assert.ok(readFileSync(result.cliPath, 'utf8').includes('harness-format.js'));
    assert.ok(readFileSync(join(runtime, 'harness-format.js'), 'utf8').includes('FORMAT'));
    // The critical regression: without the sibling wire-types copy the installed CLI is
    // dead on arrival ("Cannot find module './wire-types.js'").
    assert.ok(readFileSync(join(runtime, 'wire-types.js'), 'utf8').includes('WIRE_TYPES'));
    assert.ok(readFileSync(join(runtime, 'node_modules', 'commander', 'package.json'), 'utf8').includes('commander'));
    assert.equal(statSync(result.wrapperPath).mode & 0o777, 0o755);
  });

  it('does not leave the wrapper dependent on the transient source path', () => {
    const result = installHarness(fakeCli);
    rmSync(join(tmp, 'npx-cache'), { recursive: true, force: true });

    assert.equal(existsSync(fakeCli), false);
    assert.equal(existsSync(result.cliPath), true);
    assert.ok(readFileSync(result.wrapperPath, 'utf8').includes(join(tmp, '.ftown', 'harness-cli.path')));
    assert.ok(!readFileSync(join(tmp, '.ftown', 'harness-cli.path'), 'utf8').includes('npx-cache'));
  });

  it('reports PATH state and writes the agent guide using the current HOME', () => {
    const result = installHarness(fakeCli);

    assert.equal(harnessOnPath(), false);
    assert.equal(pathHint(), `Add to PATH: export PATH="${result.binDir}:$PATH"`);

    process.env.PATH = `${result.binDir}:/usr/bin`;
    assert.equal(harnessOnPath(), true);

    writeHarnessAgentGuide({ wrapperPath: result.wrapperPath, port: 12345, bridgeId: 'bridge-1' });
    assert.equal(agentGuidePath(), join(tmp, '.ftown', 'harness-agent.md'));
    assert.ok(readFileSync(agentGuidePath(), 'utf8').includes(result.wrapperPath));
  });
});
