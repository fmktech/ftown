import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installFtownSkill, removeFtownSkill } from './install-ftown-skill.js';

function pathExistsForLstat(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

describe('ftown skill installer', () => {
  let realHome: string | undefined;
  let home: string;
  let bundled: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'ftw-skill-install-'));
    bundled = join(home, 'bundled-skill');
    mkdirSync(join(bundled, 'scripts'), { recursive: true });
    writeFileSync(join(bundled, 'SKILL.md'), '---\nname: test\ndescription: test\n---\n# test\n');
    writeFileSync(join(bundled, 'scripts', 'tool'), '#!/usr/bin/env bash\n');
    process.env.HOME = home;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('installs one canonical skill and executable bundled scripts', () => {
    installFtownSkill('ftown', bundled);

    const canonical = join(home, '.ftown', 'skills', 'ftown');
    assert.ok(readFileSync(join(canonical, 'SKILL.md'), 'utf8').includes('# test'));
    assert.ok(statSync(join(canonical, 'scripts', 'tool')).mode & 0o100);
    assert.strictEqual(existsSync(join(home, '.agents', 'skills', 'ftown')), true);
    assert.strictEqual(existsSync(join(home, '.claude', 'skills', 'ftown')), true);
  });

  it('removes legacy split skills from the canonical store and agent link dirs', () => {
    installFtownSkill('ftown-sessions', bundled);

    removeFtownSkill('ftown-sessions');

    assert.strictEqual(existsSync(join(home, '.ftown', 'skills', 'ftown-sessions')), false);
    assert.strictEqual(pathExistsForLstat(join(home, '.agents', 'skills', 'ftown-sessions')), false);
    assert.strictEqual(pathExistsForLstat(join(home, '.claude', 'skills', 'ftown-sessions')), false);
  });
});
