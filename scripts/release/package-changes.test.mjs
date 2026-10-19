import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.ok(args.includes('--no-relative')); assert.equal(args.at(-1), ':(top)bridge/');
    return 'bridge/src/removed.ts\0bridge/src/new.ts\0bridge/src/new.test.ts\0bridge/AGENTS.md\0';
  });
  assert.deepEqual(files, ['bridge/src/removed.ts', 'bridge/src/new.ts']);
  assert.throws(() => changedPackageFiles('base', 'head', () => { throw new Error('missing Git revision'); }), /missing Git revision/);
});

test('real Git detects the same package paths from root and bridge despite diff.relative', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ftown-package-changes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  // A fixture must never inherit another repository's index/worktree selectors
  // or run user hooks, signing programs or global Git configuration.
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = devNull;
  const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${devNull}`,
    '-c', 'commit.gpgsign=false', '-c', 'user.name=Release fixture',
    '-c', 'user.email=release-fixture@example.test', ...args], { cwd: root, env, encoding: 'utf8' });
  git('init', '--quiet');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  mkdirSync(join(root, 'bridge', 'src'), { recursive: true });
  mkdirSync(join(root, 'bridge', 'docs'));
  writeFileSync(join(root, 'bridge', 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(join(root, 'bridge', 'src', 'runtime.ts'), 'export const fixture = true;\n');
  writeFileSync(join(root, 'bridge', 'src', 'runtime.test.ts'), '// test only\n');
  writeFileSync(join(root, 'bridge', 'docs', 'notes.md'), 'documentation only\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'package and excluded changes');
  const head = git('rev-parse', 'HEAD').trim();
  const expected = ['bridge/package.json', 'bridge/src/runtime.ts'];
  for (const relative of ['false', 'true']) {
    git('config', 'diff.relative', relative);
    for (const cwd of [root, join(root, 'bridge')]) {
      const actual = changedPackageFiles(base, head, (program, args, options) =>
        execFileSync(program, args, { ...options, cwd, env }));
      assert.deepEqual(actual, expected, `cwd=${cwd}, diff.relative=${relative}`);
    }
  }
});
