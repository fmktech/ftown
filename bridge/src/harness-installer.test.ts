import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentGuidePath, writeHarnessAgentGuide } from './harness-installer.js';

test('setup guide stays a short pointer and resolves HOME at call time', () => {
  const previous = process.env.HOME; const home = mkdtempSync(join(tmpdir(), 'ftown-guide-'));
  process.env.HOME = home;
  try {
    writeHarnessAgentGuide({ wrapperPath: join(home, '.ftown/bin/ftown-harness') });
    assert.equal(agentGuidePath(), join(home, '.ftown/harness-agent.md'));
    const guide = readFileSync(agentGuidePath(), 'utf8');
    assert.match(guide, /skills\/ftown\/SKILL\.md/); assert.match(guide, /ftown --help/); assert.ok(guide.length < 900);
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; rmSync(home, { recursive: true, force: true }); }
});
