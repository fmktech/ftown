import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkReleaseTag, lookupVersion, packPackages, publishPackages, releasePlan } from './publish-packages.mjs';

const commit = 'a'.repeat(40);
const version = '1.2.3';
const metadata = { version, gitHead: commit };

test('exact versions absent or from the same commit form retryable release plans', () => {
  assert.deepEqual(releasePlan(version, commit, () => undefined), [
    { name: 'ftown', publish: true }, { name: 'ftown-bridge', publish: true },
  ]);
  assert.deepEqual(releasePlan(version, commit, () => metadata), [
    { name: 'ftown', publish: false }, { name: 'ftown-bridge', publish: false },
  ]);
  for (const gitHead of [undefined, 'b'.repeat(40)]) {
    assert.throws(() => releasePlan(version, commit, () => ({ version, gitHead })), /Bump bridge\/package.json/);
  }
});

test('registry absence is distinct from authentication, network and malformed responses', () => {
  const run = (status, value, stderr = '') => (program, args) => {
    assert.equal(program, 'npm');
    assert.deepEqual(args, ['view', 'ftown@1.2.3', '--json']);
    return { status, stdout: JSON.stringify(value), stderr };
  };
  assert.equal(lookupVersion('ftown', version, run(1, { error: { code: 'E404' } })), undefined);
  assert.deepEqual(lookupVersion('ftown', version, run(0, metadata)), metadata);
  for (const code of ['E401', 'E403', 'ENETUNREACH', 'ETIMEDOUT', 'E500']) {
    assert.throws(() => lookupVersion('ftown', version, run(1, { error: { code } })), /Cannot inspect/);
  }
  assert.throws(() => lookupVersion('ftown', version, () => ({ status: 1, stdout: 'E404 in unstructured output', stderr: '' })), /Cannot inspect/);
  assert.throws(() => lookupVersion('ftown', version, run(0, { version: '1.2.4' })), /Invalid registry metadata/);
  assert.throws(() => releasePlan(version, commit, () => { throw new Error('network'); }), /network/);
});

test('publication is ftown first and a partial failure retries only the missing package', () => {
  const registry = new Map();
  const artifacts = [{ name: 'ftown', path: 'ftown.tgz' }, { name: 'ftown-bridge', path: 'bridge.tgz' }];
  const published = [];
  assert.throws(() => publishPackages(releasePlan(version, commit, (name) => registry.get(name)), artifacts, (path) => {
    published.push(path);
    if (path === 'bridge.tgz') throw new Error('temporary npm failure');
    registry.set('ftown', metadata);
  }), /temporary npm failure/);
  assert.deepEqual(published, ['ftown.tgz', 'bridge.tgz']);
  const retry = [];
  publishPackages(releasePlan(version, commit, (name) => registry.get(name)), artifacts, (path) => retry.push(path));
  assert.deepEqual(retry, ['bridge.tgz']);
  const reversePartial = releasePlan(version, commit, (name) => name === 'ftown-bridge' ? metadata : undefined);
  assert.deepEqual(reversePartial.map(({ publish }) => publish), [true, false]);
});

test('release tags allow same-commit retries including annotated tags and reject collisions/errors', () => {
  const run = (stdout, status = 0) => () => ({ stdout, status, stderr: 'remote error' });
  assert.equal(checkReleaseTag(version, commit, run('')), false);
  assert.equal(checkReleaseTag(version, commit, run(`${commit}\trefs/tags/bridge-v${version}\n`)), true);
  assert.equal(checkReleaseTag(version, commit, run(`tag-object\trefs/tags/bridge-v${version}\n${commit}\trefs/tags/bridge-v${version}^{}\n`)), true);
  assert.throws(() => checkReleaseTag(version, commit, run(`other\trefs/tags/bridge-v${version}\n`)), /another commit/);
  assert.throws(() => checkReleaseTag(version, commit, run('', 1)), /Cannot inspect release tag/);
});

test('both real npm artifacts have identical files, modes and manifest fields except package name', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-artifact-test-'));
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const artifacts = packPackages(manifest.version, commit, temporary);
    const snapshots = artifacts.map(({ name, path }) => {
      const directory = join(temporary, name); mkdirSync(directory);
      execFileSync('tar', ['-xzf', path, '-C', directory]);
      const root = join(directory, 'package');
      const files = [];
      function visit(relative = '') {
        for (const entry of readdirSync(join(root, relative)).sort()) {
          const file = join(relative, entry);
          const stat = statSync(join(root, file));
          if (stat.isDirectory()) visit(file);
          else {
            let content = readFileSync(join(root, file));
            if (file === 'package.json') {
              const packed = JSON.parse(content);
              assert.equal(packed.name, name);
              assert.equal(packed.version, manifest.version);
              assert.equal(packed.gitHead, commit);
              assert.equal(packed.bin.ftown, 'dist/ftown-cli.js');
              delete packed.name;
              content = Buffer.from(JSON.stringify(packed));
            }
            files.push({ file, mode: stat.mode & 0o777, content });
          }
        }
      }
      visit();
      assert.ok(files.some(({ file }) => file === 'dist/ftown-cli.js'), 'build the package before the artifact check');
      assert.ok(files.some(({ file }) => file === 'skills/ftown/SKILL.md'));
      return files;
    });
    assert.deepEqual(snapshots[0], snapshots[1]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
