import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as publisher from './publish-packages.mjs';
import { checkReleaseTag, lookupVersion, packPackages, parsePackResult, publishPackages, releasePlan, waitForPublishedPackages } from './publish-packages.mjs';

const commit = 'a'.repeat(40);
const version = '1.2.3';
const metadata = { name: 'ftown', version, gitHead: commit };

function visibilityClock() {
  let elapsed = 0;
  const sleeps = [];
  const messages = [];
  return { sleeps, messages, now: () => elapsed, advance: (ms) => { elapsed += ms; },
    sleep: async (ms) => { sleeps.push(ms); elapsed += ms; }, log: (message) => messages.push(message) };
}

test('visible same-commit versions need no wait', async () => {
  const clock = visibilityClock();
  await waitForPublishedPackages(version, commit, { ...clock, lookup: () => metadata });
  assert.deepEqual(clock.sleeps, []);
  assert.deepEqual(clock.messages, []);
});

test('tag verification waits for delayed visibility and polls only missing versions', async () => {
  const clock = visibilityClock();
  const calls = [];
  const reads = new Map();
  await waitForPublishedPackages(version, commit, { ...clock, timeoutMs: 100, intervalMs: 20,
    lookup: (name) => {
      calls.push(name);
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      const visible = count >= (name === 'ftown' ? 2 : 3);
      return lookupVersion(name, version, () => ({ status: visible ? 0 : 1, stderr: '',
        stdout: JSON.stringify(visible ? { ...metadata, name } : { error: { code: 'E404' } }) }));
    } });
  assert.deepEqual(calls, ['ftown', 'ftown-bridge', 'ftown', 'ftown-bridge', 'ftown-bridge']);
  assert.deepEqual(clock.sleeps, [20, 20]);
  assert.equal(clock.messages.length, 2);
  assert.match(clock.messages[0], /Waiting for npm visibility: ftown@1\.2\.3, ftown-bridge@1\.2\.3/);
  assert.match(clock.messages[1], /Waiting for npm visibility: ftown-bridge@1\.2\.3/);
});

test('missing versions have a finite deadline and the final sleep respects the remaining budget', async () => {
  const clock = visibilityClock();
  await assert.rejects(waitForPublishedPackages(version, commit, { ...clock,
    timeoutMs: 50, intervalMs: 20, lookup: () => undefined }), /Timed out.*ftown@1\.2\.3.*ftown-bridge@1\.2\.3.*same source commit/);
  assert.deepEqual(clock.sleeps, [20, 20, 10]);
  assert.equal(clock.now(), 50);
});

test('lookup duration consumes the deadline and no fresh request starts after it', async () => {
  const clock = visibilityClock();
  const calls = [];
  await assert.rejects(waitForPublishedPackages(version, commit, { ...clock, timeoutMs: 50,
    lookup: (name, requestedVersion, remaining) => {
      calls.push({ name, requestedVersion, remaining });
      clock.advance(50);
      return metadata;
    } }), /Timed out waiting for npm visibility/);
  assert.deepEqual(calls, [{ name: 'ftown', requestedVersion: version, remaining: 50 }]);
  assert.deepEqual(clock.sleeps, []);
});

test('each lookup receives only its remaining budget and subprocess timeout stops waiting', async () => {
  const clock = visibilityClock();
  const budgets = [];
  await waitForPublishedPackages(version, commit, { ...clock, timeoutMs: 50,
    lookup: (name, requestedVersion, remaining) => {
      budgets.push(remaining);
      clock.advance(10);
      return metadata;
    } });
  assert.deepEqual(budgets, [50, 40]);
  const expired = visibilityClock();
  await assert.rejects(waitForPublishedPackages(version, commit, { ...expired,
    lookup: () => { throw Object.assign(new Error('spawn timeout'), { code: 'ETIMEDOUT' }); } }), /Timed out waiting for npm visibility/);
  assert.deepEqual(expired.sleeps, []);
});

test('visibility wait fails immediately for commit collisions or non-E404 registry failures', async () => {
  for (const gitHead of [undefined, 'other-commit']) {
    const clock = visibilityClock();
    await assert.rejects(waitForPublishedPackages(version, commit, { ...clock,
      lookup: () => ({ ...metadata, gitHead }) }), /different or missing gitHead/);
    assert.deepEqual(clock.sleeps, []);
  }
  for (const response of [
    { status: 1, stdout: '{"error":{"code":"E401"}}', stderr: 'auth' },
    { status: 1, stdout: '{"error":{"code":"ENETUNREACH"}}', stderr: 'network' },
    { status: 0, stdout: 'invalid metadata', stderr: '' },
  ]) {
    const clock = visibilityClock();
    await assert.rejects(waitForPublishedPackages(version, commit, { ...clock,
      lookup: (name) => lookupVersion(name, version, () => response) }), /Cannot inspect|Invalid registry metadata/);
    assert.deepEqual(clock.sleeps, []);
  }
});

test('npm pack supports npm11 arrays and npm12 package maps with one exact safe artifact', () => {
  const artifact = { name: 'ftown', version, filename: `ftown-${version}.tgz` };
  for (const value of [[artifact], { ftown: artifact }]) {
    assert.deepEqual(parsePackResult(JSON.stringify(value), 'ftown', version), artifact);
  }
  const invalid = [null, false, 'text', [], {}, [artifact, artifact], artifact,
    { other: artifact }, { ftown: artifact, extra: artifact }, { ftown: [artifact] },
    [{ ...artifact, name: 'other' }], [{ ...artifact, version: '9.9.9' }],
    [{ ...artifact, filename: '../escape.tgz' }], [{ ...artifact, filename: '/tmp/escape.tgz' }],
    [{ ...artifact, filename: undefined }], [{ ...artifact, filename: '' }]];
  for (const value of invalid) {
    assert.throws(() => parsePackResult(JSON.stringify(value), 'ftown', version), /Invalid npm pack result/);
  }
  assert.throws(() => parsePackResult('not JSON', 'ftown', version), /Invalid npm pack result/);
});

test('exact registry versions accept npm12 singleton arrays and reject ambiguous or mismatched records', () => {
  const run = (value) => () => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  assert.deepEqual(lookupVersion('ftown', version, run([metadata])), metadata);
  for (const value of [[], [metadata, metadata], [null], { ...metadata, name: 'other' }, { ...metadata, version: '1.2.4' }]) {
    assert.throws(() => lookupVersion('ftown', version, run(value)), /Invalid registry metadata/);
  }
});

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
    const manifest = JSON.parse(readFileSync(new URL('../../bridge/package.json', import.meta.url), 'utf8'));
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


test('PR version availability rejects either published name including same commit and propagates lookup errors', () => {
  const seen = [];
  assert.equal(publisher.assertUnpublishedVersion(version, (name, requestedVersion) => { seen.push([name, requestedVersion]); return undefined; }), undefined);
  assert.deepEqual(seen, [['ftown', version], ['ftown-bridge', version]]);
  for (const collision of ['ftown', 'ftown-bridge']) {
    assert.throws(() => publisher.assertUnpublishedVersion(version, name => name === collision ? { ...metadata, name } : undefined), /already published/);
  }
  assert.throws(() => publisher.assertUnpublishedVersion(version, () => { throw new Error('network'); }), /network/);
  for (const response of [
    { status: 1, stdout: '{"error":{"code":"E401"}}', stderr: 'auth' },
    { status: 1, stdout: '{"error":{"code":"ENETUNREACH"}}', stderr: 'network' },
    { status: 0, stdout: 'invalid', stderr: '' },
  ]) assert.throws(() => publisher.assertUnpublishedVersion(version, name => lookupVersion(name, version, () => response)), /Cannot inspect|Invalid registry metadata/);
  assert.deepEqual(releasePlan(version, commit, () => metadata).map(entry => entry.publish), [false, false]);
});
