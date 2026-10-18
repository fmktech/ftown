import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CLAUDE_MOD_FILES, claudeModLaunchPath, installClaudeMod, supportsClaudeMods } from './claude-mod-installer.js';

test('Claude Mod assets install independently of the original package and repair in place', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-claude-mod-'));
  try {
    const source = join(temporary, 'source');
    const home = join(temporary, 'home');
    for (const file of CLAUDE_MOD_FILES) {
      mkdirSync(dirname(join(source, file)), { recursive: true });
      writeFileSync(join(source, file), file);
    }
    const destination = installClaudeMod(source, home);
    writeFileSync(join(destination, 'hooks/register.js'), 'damaged');
    assert.equal(installClaudeMod(source, home), destination);
    rmSync(source, { recursive: true });
    for (const file of CLAUDE_MOD_FILES) {
      assert.equal(readFileSync(join(destination, file), 'utf8'), file);
      assert.equal(statSync(join(destination, file)).mode & 0o777, 0o600);
    }
    assert.equal(claudeModLaunchPath({ home, probeVersion: () => '2.1.302 (Claude Code)' }), destination);
    assert.equal(claudeModLaunchPath({ home, probeVersion: () => '2.1.286 (Claude Code)' }), undefined);
    assert.equal(claudeModLaunchPath({ home, probeVersion: () => { throw new Error('missing'); } }), undefined);
    rmSync(join(destination, 'hooks/register.js'));
    assert.equal(claudeModLaunchPath({ home, probeVersion: () => { throw new Error('must not probe missing assets'); } }), undefined);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('Claude Mod installation refuses foreign symlink destinations', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-claude-symlink-'));
  try {
    const home = join(temporary, 'home');
    const outside = join(temporary, 'outside');
    mkdirSync(join(home, '.ftown'), { recursive: true }); mkdirSync(outside);
    symlinkSync(outside, join(home, '.ftown/claude-plugin'));
    assert.throws(() => installClaudeMod('/unused', home), /symlink/);
    assert.deepEqual(readdirSync(outside), []);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('Claude Mod version gate rejects unknown and prerelease versions', () => {
  for (const version of ['2.1.287', '2.1.302 (Claude Code)', '2.2.0', '3.0.0']) assert.equal(supportsClaudeMods(version), true, version);
  for (const version of ['', 'unknown', '2.1.286', '2.0.999', '1.99.999', '2.1.287-beta.1', 'bad 2.1.302']) assert.equal(supportsClaudeMods(version), false, version);
});
