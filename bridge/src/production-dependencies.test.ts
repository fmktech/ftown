import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { copyProductionDependencies } from './production-dependencies.js';

function pkg(directory: string, value: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(value));
  writeFileSync(join(directory, 'index.js'), `module.exports = ${JSON.stringify(value.version ?? 'fixture')};`);
}

test('production snapshot preserves npm-cache hoisting, nested versions, scoped/native assets and required peers', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-production-'));
  try {
    const tree = join(temporary, 'cache/node_modules'); const root = join(tree, 'ftown');
    pkg(root, { dependencies: { a: '1', b: '1', '@scope/native': '1' }, devDependencies: { unrelated: '1' } });
    pkg(join(tree, 'a'), { dependencies: { shared: '1' }, optionalDependencies: { absent: '1' }, peerDependencies: { peer: '1' } });
    pkg(join(tree, 'b'), { dependencies: { shared: '2' } });
    pkg(join(tree, 'shared'), { version: '1' }); pkg(join(tree, 'b/node_modules/shared'), { version: '2' });
    pkg(join(tree, 'peer'), { version: '1' }); pkg(join(tree, 'unrelated'), { version: 'dev' });
    const native = join(tree, '@scope/native'); pkg(native, { version: '1' });
    mkdirSync(join(native, 'prebuilds')); writeFileSync(join(native, 'prebuilds/addon.node'), Buffer.from([0, 1, 254, 255]), { mode: 0o755 });
    const target = join(temporary, 'installed');
    const files = copyProductionDependencies(root, target);
    assert.equal(JSON.parse(readFileSync(join(target, 'node_modules/shared/package.json'), 'utf8')).version, '1');
    assert.equal(JSON.parse(readFileSync(join(target, 'node_modules/b/node_modules/shared/package.json'), 'utf8')).version, '2');
    assert.ok(existsSync(join(target, 'node_modules/peer/package.json')));
    assert.equal(existsSync(join(target, 'node_modules/unrelated')), false);
    assert.equal(existsSync(join(target, 'node_modules/absent')), false);
    assert.deepEqual(readFileSync(join(target, 'node_modules/@scope/native/prebuilds/addon.node')), Buffer.from([0, 1, 254, 255]));
    assert.equal(statSync(join(target, 'node_modules/@scope/native/prebuilds/addon.node')).mode & 0o777, 0o755);
    assert.ok(files.includes('node_modules/b/node_modules/shared/package.json'));
    rmSync(join(temporary, 'cache'), { recursive: true });
    assert.ok(existsSync(join(target, 'node_modules/a/index.js')));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('missing required dependencies fail and source/destination symlinks cannot escape', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-production-safe-'));
  try {
    const root = join(temporary, 'source'); pkg(root, { dependencies: { missing: '1' } });
    assert.throws(() => copyProductionDependencies(root, join(temporary, 'target')), /Missing production dependency missing/);
    const outside = join(temporary, 'outside'); pkg(outside, { version: 'private' });
    mkdirSync(join(root, 'node_modules')); symlinkSync(outside, join(root, 'node_modules/missing'));
    assert.throws(() => copyProductionDependencies(root, join(temporary, 'target')), /escapes its module tree/);
    unlinkSync(join(root, 'node_modules/missing')); pkg(join(root, 'node_modules/missing'), { version: '1' });
    const target = join(temporary, 'target'); mkdirSync(dirname(join(target, 'node_modules/missing')), { recursive: true });
    symlinkSync(outside, join(target, 'node_modules/missing'));
    assert.throws(() => copyProductionDependencies(root, target), /symlink/);
    assert.equal(JSON.parse(readFileSync(join(outside, 'package.json'), 'utf8')).version, 'private');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('root-local npm dependencies win while outer hoisted dependencies retain their own versions', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-production-local-'));
  try {
    const tree = join(temporary, 'cache/node_modules'); const root = join(tree, 'ftown');
    pkg(root, { dependencies: { a: '1', b: '1', commander: '1' } });
    pkg(join(root, 'node_modules/a'), { version: '1' });
    pkg(join(root, 'node_modules/commander'), { version: 'local' });
    pkg(join(tree, 'a'), { version: '2' });
    pkg(join(tree, 'b'), { dependencies: { a: '2' } });
    writeFileSync(join(tree, 'b/index.js'), 'module.exports = require("a");');
    const target = join(temporary, 'installed'); copyProductionDependencies(root, target);
    const require = createRequire(join(target, 'entry.js'));
    assert.equal(require('commander'), 'local');
    assert.equal(require('a'), '1');
    assert.equal(require('b'), '2');
    rmSync(join(temporary, 'cache'), { recursive: true });
    assert.equal(require('b'), '2');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
