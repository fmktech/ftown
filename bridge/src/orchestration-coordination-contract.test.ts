import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const bridgeRoot = resolve(import.meta.dirname, '..');

function bundled(relativePath: string): string {
  return readFileSync(resolve(bridgeRoot, relativePath), 'utf8');
}

describe('bundled orchestration coordination contract', () => {
  it('documents FTS as primary and mail as fallback for orchestrators', () => {
    const playbook = bundled('skills/ftown/references/orchestrator.md');

    assert.match(playbook, /FTS.*primary coordination plane/i);
    assert.match(playbook, /context.*status.*resource/is);
    assert.match(playbook, /mail.*fallback/i);
  });

  it('bundles the fticket skill used by orchestration prompts', () => {
    const skill = bundled('skills/fticket/SKILL.md');

    assert.match(skill, /^name: fticket$/m);
    assert.match(skill, /Resources \(leases with FIFO waitlists\)/);
  });

});
