import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installFtownSkill, removeFtownSkill, retireBundledAutomationAssets } from './install-ftown-skill.js';

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
    realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    home = mkdtempSync(join(tmpdir(), 'ftw-skill-install-'));
    bundled = join(home, 'bundled-skill');
    mkdirSync(join(bundled, 'scripts'), { recursive: true });
    writeFileSync(join(bundled, 'SKILL.md'), '---\nname: test\ndescription: test\n---\n# test\n');
    writeFileSync(join(bundled, 'scripts', 'tool'), '#!/usr/bin/env bash\n');
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    else process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = realHome;
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

  it('installs a second skill name to its own canonical dir and agent links', () => {
    installFtownSkill('factory', bundled);

    const canonical = join(home, '.ftown', 'skills', 'factory');
    assert.ok(readFileSync(join(canonical, 'SKILL.md'), 'utf8').includes('# test'));
    assert.strictEqual(existsSync(join(home, '.agents', 'skills', 'factory')), true);
    assert.strictEqual(existsSync(join(home, '.claude', 'skills', 'factory')), true);
  });

  it('removes legacy split skills from the canonical store and agent link dirs', () => {
    installFtownSkill('ftown-sessions', bundled);

    removeFtownSkill('ftown-sessions');

    assert.strictEqual(existsSync(join(home, '.ftown', 'skills', 'ftown-sessions')), false);
    assert.strictEqual(pathExistsForLstat(join(home, '.agents', 'skills', 'ftown-sessions')), false);
    assert.strictEqual(pathExistsForLstat(join(home, '.claude', 'skills', 'ftown-sessions')), false);
  });

  it('removes only recognized shipped automation copies and exact bridge-owned links', () => {
    const factory = join(home, '.ftown', 'skills', 'factory');
    const ftown = join(home, '.ftown', 'skills', 'ftown');
    mkdirSync(factory, { recursive: true });
    mkdirSync(join(ftown, 'references'), { recursive: true });
    writeFileSync(join(factory, 'SKILL.md'), 'shipped factory');
    writeFileSync(join(ftown, 'references', 'loops.md'), 'shipped reference');
    for (const dir of ['.agents', '.claude']) {
      mkdirSync(join(home, dir, 'skills'), { recursive: true });
      symlinkSync('../../.ftown/skills/factory', join(home, dir, 'skills', 'factory'));
    }
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    retireBundledAutomationAssets({ factory: { 'SKILL.md': hash('shipped factory') }, loopReference: hash('shipped reference') });
    assert.equal(existsSync(factory), false);
    assert.equal(existsSync(join(ftown, 'references', 'loops.md')), false);
    for (const dir of ['.agents', '.claude']) assert.equal(pathExistsForLstat(join(home, dir, 'skills', 'factory')), false);
    retireBundledAutomationAssets(); // repeat is harmless
  });

  it('preserves customized copies, arbitrary real directories, and foreign symlink targets', () => {
    const factory = join(home, '.ftown', 'skills', 'factory');
    const refs = join(home, '.ftown', 'skills', 'ftown', 'references');
    mkdirSync(factory, { recursive: true }); mkdirSync(refs, { recursive: true });
    writeFileSync(join(factory, 'SKILL.md'), 'my factory');
    writeFileSync(join(factory, 'custom.txt'), 'private');
    writeFileSync(join(refs, 'loops.md'), 'my custom instructions');
    const agentDir = join(home, '.agents', 'skills', 'factory');
    mkdirSync(agentDir, { recursive: true }); writeFileSync(join(agentDir, 'SKILL.md'), 'my skill');
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(factory, join(home, '.claude', 'skills', 'factory'));
    retireBundledAutomationAssets();
    assert.equal(readFileSync(join(factory, 'custom.txt'), 'utf8'), 'private');
    assert.equal(readFileSync(join(refs, 'loops.md'), 'utf8'), 'my custom instructions');
    assert.equal(readFileSync(join(agentDir, 'SKILL.md'), 'utf8'), 'my skill');
    assert.equal(pathExistsForLstat(join(home, '.claude', 'skills', 'factory')), true);
    removeFtownSkill('factory');
    assert.equal(readFileSync(join(factory, 'SKILL.md'), 'utf8'), 'my factory');
  });

  it('recognizes unchanged real factory copies in legacy agent directories but preserves custom extras and symlink parents', () => {
    const hash = createHash('sha256').update('shipped factory').digest('hex');
    const known = { factory: { 'SKILL.md': hash }, loopReference: 'unused' };
    for (const dir of ['.agents', '.claude']) {
      const factory = join(home, dir, 'skills', 'factory');
      mkdirSync(factory, { recursive: true }); writeFileSync(join(factory, 'SKILL.md'), 'shipped factory');
    }
    retireBundledAutomationAssets(known);
    for (const dir of ['.agents', '.claude']) assert.equal(existsSync(join(home, dir, 'skills', 'factory')), false);
    const custom = join(home, '.agents', 'skills', 'factory');
    mkdirSync(custom); writeFileSync(join(custom, 'SKILL.md'), 'shipped factory');
    writeFileSync(join(custom, 'custom.md'), 'keep');
    const outside = join(home, 'external-skills'); mkdirSync(join(outside, 'factory'), { recursive: true });
    writeFileSync(join(outside, 'factory', 'SKILL.md'), 'shipped factory');
    rmSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(outside, join(home, '.claude', 'skills'));
    retireBundledAutomationAssets(known);
    assert.equal(readFileSync(join(custom, 'custom.md'), 'utf8'), 'keep');
    assert.equal(readFileSync(join(outside, 'factory', 'SKILL.md'), 'utf8'), 'shipped factory');
  });
});
