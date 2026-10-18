import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLI_RUNTIME_MODULES, installFtownCommandCli } from './install-ftown-command-cli.js';
import { RUNTIME_DIRECTORIES } from './installation-manifest.js';

function fixture(root: string): string {
  const source = join(root, 'cache', 'package');
  mkdirSync(join(source, 'dist'), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"name":"ftown","version":"1.2.3","type":"module","dependencies":{"commander":"1"}}');
  for (const name of CLI_RUNTIME_MODULES) writeFileSync(join(source, 'dist', `${name}.js`), `export const NAME = '${name}';`);
  for (const asset of RUNTIME_DIRECTORIES) {
    mkdirSync(join(source, asset), { recursive: true }); writeFileSync(join(source, asset, 'asset'), asset);
  }
  const dependency = join(source, 'node_modules', 'commander'); mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, 'package.json'), '{"name":"commander","main":"index.js"}');
  writeFileSync(join(dependency, 'index.js'), 'module.exports = {};');
  return source;
}

test('one copied runtime owns every group, assets and dependency; aliases are delegates', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-runtime-'));
  try {
    const source = fixture(temporary); const home = join(temporary, "user's home"); mkdirSync(home);
    const command = installFtownCommandCli(source, home);
    const runtime = join(home, '.ftown', 'cli');
    rmSync(join(temporary, 'cache'), { recursive: true });
    assert.equal(existsSync(source), false);
    for (const name of CLI_RUNTIME_MODULES) assert.ok(readFileSync(join(runtime, 'dist', `${name}.js`), 'utf8').includes(name));
    assert.equal(JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version, '1.2.3');
    assert.deepEqual(JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).dependencies, { commander: '1' });
    assert.equal(readFileSync(join(runtime, 'node_modules/commander/index.js'), 'utf8'), 'module.exports = {};');
    for (const [relative, group] of [['ftown', ''], ['ftown-sessions', 'sessions'], ['ftown-env', 'env'], ['bin/ftown-harness', 'harness']]) {
      const path = join(home, '.ftown', relative); const body = readFileSync(path, 'utf8');
      assert.match(body, /cli\/dist\/ftown-cli\.js/);
      if (group) assert.ok(body.includes(` ${group} "$@"`));
      assert.equal(statSync(path).mode & 0o777, 0o755);
    }
    assert.equal(command, join(home, '.ftown', 'ftown'));
    assert.equal(installFtownCommandCli(runtime, home), command, 'repair can use the durable runtime as its own source');
    assert.equal(readFileSync(join(runtime, 'hooks', 'asset'), 'utf8'), 'hooks');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('does not overwrite a foreign runtime symlink', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-runtime-link-'));
  try {
    const source = fixture(temporary); const home = join(temporary, 'home'); const external = join(temporary, 'outside');
    mkdirSync(join(home, '.ftown'), { recursive: true }); mkdirSync(external);
    writeFileSync(join(external, 'keep'), 'private'); symlinkSync(external, join(home, '.ftown', 'cli'));
    assert.throws(() => installFtownCommandCli(source, home), /symlink/);
    assert.equal(readFileSync(join(external, 'keep'), 'utf8'), 'private');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('a dangling launcher symlink cannot redirect setup writes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-runtime-launcher-'));
  try {
    const source = fixture(temporary); const home = join(temporary, 'home');
    mkdirSync(join(home, '.ftown'), { recursive: true });
    const outside = join(temporary, 'unowned-file'); symlinkSync(outside, join(home, '.ftown/ftown'));
    assert.throws(() => installFtownCommandCli(source, home), /launcher symlink/);
    assert.equal(existsSync(outside), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
