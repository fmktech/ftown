import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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


test('default compatibility cache ignores wall steps at its exact expiry', () => {
  if (process.platform === 'win32') return;
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-claude-cache-'));
  const originalPath = process.env.PATH, originalDateNow = Date.now;
  const originalPerformanceNow = Object.getOwnPropertyDescriptor(performance, 'now');
  let wall = 1_000_000, elapsed = 0;
  Date.now = () => wall;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed });
  try {
    for (const jump of [-600_000, 600_000]) for (const supported of [true, false]) {
      const home = join(temporary, `${jump}-${supported}`), bin = join(home, 'bin');
      const destination = join(home, '.ftown/claude-plugin');
      for (const file of CLAUDE_MOD_FILES) { mkdirSync(dirname(join(destination, file)), { recursive: true }); writeFileSync(join(destination, file), 'asset'); }
      mkdirSync(bin, { recursive: true });
      const version = join(home, 'version'), calls = join(home, 'calls');
      writeFileSync(join(bin, 'claude'), `#!/bin/sh\nread -r version < '${version}'\necho \"$version\"\necho x >> '${calls}'\n`);
      chmodSync(join(bin, 'claude'), 0o755); process.env.PATH = bin;
      const initial = supported ? '2.1.302' : '2.1.286';
      const changed = supported ? '2.1.286' : '2.1.302';
      writeFileSync(version, initial); wall = 1_000_000; elapsed = 0;
      assert.equal(claudeModLaunchPath({ home }), supported ? destination : undefined);
      writeFileSync(version, changed); wall += jump; elapsed = 59_999;
      assert.equal(claudeModLaunchPath({ home }), supported ? destination : undefined);
      assert.equal(readFileSync(calls, 'utf8'), 'x\n');
      elapsed = 60_000;
      assert.equal(claudeModLaunchPath({ home }), supported ? undefined : destination);
      assert.equal(readFileSync(calls, 'utf8'), 'x\nx\n');
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    Date.now = originalDateNow;
    if (originalPerformanceNow) Object.defineProperty(performance, 'now', originalPerformanceNow);
    else delete (performance as { now?: () => number }).now;
    rmSync(temporary, { recursive: true, force: true });
  }
});
