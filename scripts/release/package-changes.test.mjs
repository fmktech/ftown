import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedPackageFiles, isPackageChange } from './package-changes.mjs';

test('all shipped assets, build configuration and runtime sources require a package release', () => {
  for (const path of ['src/index.ts', 'src/installation-manifest.ts', 'package.json', 'package-lock.json', 'tsconfig.json',
    'bin/ftown-sessions', 'hooks/notify.sh', 'skills/ftown/SKILL.md', 'pi-extension/ftown.js',
    'opencode-plugin/ftown.js', 'muse-plugin/.muse-plugin/plugin.json', 'README.md', '.npmignore', 'scripts/build.mjs']) {
    assert.equal(isPackageChange(`bridge/${path}`), true, path);
  }
});
test('tests, agent documentation and external release tooling do not force npm publication', () => {
  for (const path of ['bridge/src/setup-state.test.ts', 'bridge/src/README.md', 'bridge/AGENTS.md', 'bridge/docs/design.md', 'bridge/tests/fixture.js',
    'scripts/release/publish-packages.mjs', '.github/workflows/publish-bridge.yml', 'docs/npm-release.md', 'README.md']) {
    assert.equal(isPackageChange(path), false, path);
  }
});
test('changed paths include deletions and both sides of renames, and Git errors fail closed', () => {
  const files = changedPackageFiles('base', 'head', (program, args) => {
    assert.equal(program, 'git'); assert.ok(args.includes('--no-renames'));
    return 'bridge/src/removed.ts\0bridge/src/new.ts\0bridge/src/new.test.ts\0bridge/AGENTS.md\0';
  });
  assert.deepEqual(files, ['bridge/src/removed.ts', 'bridge/src/new.ts']);
  assert.throws(() => changedPackageFiles('base', 'head', () => { throw new Error('missing Git revision'); }), /missing Git revision/);
});
