import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const bridgeRoot = resolve(import.meta.dirname, '..');
const bundled = (relativePath: string): string => readFileSync(resolve(bridgeRoot, relativePath), 'utf8');

describe('bundled agent surface contract', () => {
  it('provides canonical command discovery, peer help and explicit cleanup in the skill', () => {
    const skill = bundled('skills/ftown/SKILL.md');
    for (const command of ['ftown --help', 'ftown sessions', 'ftown harness', 'ftown env']) {
      assert.ok(skill.includes(command));
    }
    assert.match(skill, /cleanup is an explicit user or orchestrator action/i);
    assert.match(skill, /ftown sessions screen/);
    assert.doesNotMatch(skill, /FTS.*primary|remove themselves|very last command/i);
  });

  it('retains a terse coordination reference pointing to authoritative guidance', () => {
    const reference = bundled('skills/ftown/references/orchestrator.md');
    assert.match(reference, /SKILL\.md/);
    assert.match(reference, /sessions\.md/);
    assert.ok(reference.length < 2200);
    assert.doesNotMatch(reference, /ftown-sessions|ftown-harness|fticket|FTS/);
  });

  it('ships no retired ticket or workflow feature', () => {
    for (const file of ['skills/fticket', 'skills/ftown/references/workflows.md', 'skills/ftown/scripts/example.flow.mjs', 'src/workflow-runner.ts', 'src/workflow-runner-cli.ts', 'src/install-ftown-workflows-cli.ts']) {
      assert.equal(existsSync(resolve(bridgeRoot, file)), false, file);
    }
    const pkg = JSON.parse(bundled('package.json'));
    assert.equal(pkg.bin['ftown-workflows'], undefined);
    const startup = bundled('src/index.ts');
    assert.doesNotMatch(startup, /installFtownSkill|installFtownWorkflowsCli|retireBundled/);
    assert.ok(startup.indexOf('assertSetupReady(BRIDGE_VERSION)') < startup.indexOf('const defaultDataDir = resolveDefaultDataDir()'));
  });
});
