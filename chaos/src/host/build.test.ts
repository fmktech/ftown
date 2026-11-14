import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSourceFingerprint, hasDirtyInput, isFingerprintInput, type FingerprintDeps } from './build.ts';
import { sha256 } from './summary.ts';

function fakeDeps(
  files: Record<string, string>,
  opts: { head?: string; dirty?: boolean; tracked?: string[] } = {},
): FingerprintDeps {
  const tracked = opts.tracked ?? Object.keys(files);
  return {
    async listTrackedFiles() {
      return tracked;
    },
    async hashFile(relPath: string) {
      if (!(relPath in files)) throw new Error(`missing file: ${relPath}`);
      return sha256(files[relPath]);
    },
    async getHead() {
      return opts.head ?? '0123456789abcdef0123456789abcdef01234567';
    },
    async isDirty() {
      return opts.dirty ?? false;
    },
  };
}

const BASE_FILES: Record<string, string> = {
  'bridge/package.json': '{"name":"ftown-bridge"}',
  'bridge/package-lock.json': '{"lockfileVersion":3}',
  'bridge/src/index.ts': 'export const ok = true;\n',
  'chaos/package.json': '{"name":"ftown-chaos"}',
  'chaos/src/contract.ts': 'export const CONTRACT_VERSION = 8;\n',
  'chaos/src/guest/main.ts': 'console.log("guest");\n',
  'chaos/box/Dockerfile': 'FROM node:24\n',
  'chaos/qemu/init': '#!/bin/sh\n',
  'chaos/src/host/build.ts': 'host code\n',
  'chaos/src/guest/main.test.ts': 'test code\n',
  'ui/src/App.tsx': 'export function App() { return null; }\n',
};

test('isFingerprintInput accepts guest/bridge/box/qemu inputs and rejects host/test/unrelated files', () => {
  assert.equal(isFingerprintInput('bridge/src/index.ts'), true);
  assert.equal(isFingerprintInput('bridge/package-lock.json'), true);
  assert.equal(isFingerprintInput('chaos/package.json'), true);
  assert.equal(isFingerprintInput('chaos/src/contract.ts'), true);
  assert.equal(isFingerprintInput('chaos/src/guest/main.ts'), true);
  assert.equal(isFingerprintInput('chaos/src/supervisor/main.ts'), true);
  assert.equal(isFingerprintInput('chaos/box/Dockerfile'), true);
  assert.equal(isFingerprintInput('chaos/qemu/init'), true);

  assert.equal(isFingerprintInput('chaos/src/host/build.ts'), false);
  assert.equal(isFingerprintInput('chaos/src/guest/main.test.ts'), false);
  assert.equal(isFingerprintInput('ui/src/App.tsx'), false);
  assert.equal(isFingerprintInput('README.md'), false);
});

test('hasDirtyInput detects dirty bridge/guest files and ignores host/unrelated files', () => {
  assert.equal(hasDirtyInput(''), false);
  assert.equal(hasDirtyInput(' M ui/src/App.tsx\0 M chaos/src/host/build.ts\0'), false);
  assert.equal(hasDirtyInput(' M bridge/src/index.ts\0'), true);
  assert.equal(hasDirtyInput(' M chaos/src/guest/main.ts\0'), true);
  assert.equal(hasDirtyInput('R  ui/new.ts\0bridge/old.ts\0'), true);
  assert.equal(hasDirtyInput('R  ui/new.ts\0ui/old.ts\0'), false);
});

test('computeSourceFingerprint is deterministic across tracked file listing order', async () => {
  const a = await computeSourceFingerprint(fakeDeps(BASE_FILES));
  const reversed = Object.keys(BASE_FILES).reverse();
  const b = await computeSourceFingerprint(fakeDeps(BASE_FILES, { tracked: reversed }));
  assert.deepEqual(a, b);
  assert.equal(a.fileCount, 8);
});

test('computeSourceFingerprint changes when a bridge file changes', async () => {
  const a = await computeSourceFingerprint(fakeDeps(BASE_FILES));
  const b = await computeSourceFingerprint(fakeDeps({
    ...BASE_FILES,
    'bridge/src/index.ts': 'export const ok = false;\n',
  }));
  assert.notEqual(a.sha256, b.sha256);
});

test('computeSourceFingerprint changes when a chaos guest file changes', async () => {
  const a = await computeSourceFingerprint(fakeDeps(BASE_FILES));
  const b = await computeSourceFingerprint(fakeDeps({
    ...BASE_FILES,
    'chaos/src/guest/main.ts': 'console.log("guest v2");\n',
  }));
  assert.notEqual(a.sha256, b.sha256);
});

test('computeSourceFingerprint changes when HEAD or dirty flag changes', async () => {
  const a = await computeSourceFingerprint(fakeDeps(BASE_FILES, { head: 'aaa', dirty: false }));
  const b = await computeSourceFingerprint(fakeDeps(BASE_FILES, { head: 'bbb', dirty: false }));
  const c = await computeSourceFingerprint(fakeDeps(BASE_FILES, { head: 'aaa', dirty: true }));
  assert.notEqual(a.sha256, b.sha256);
  assert.notEqual(a.sha256, c.sha256);
});

test('computeSourceFingerprint does NOT change when an unrelated file (e.g. ui/) or host/test file changes', async () => {
  const a = await computeSourceFingerprint(fakeDeps(BASE_FILES));
  const b = await computeSourceFingerprint(fakeDeps({
    ...BASE_FILES,
    'ui/src/App.tsx': 'export function App() { return "changed"; }\n',
    'chaos/src/host/build.ts': 'changed host code\n',
    'chaos/src/guest/main.test.ts': 'changed test code\n',
    'docs/notes.md': 'added doc\n',
  }));
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.fileCount, b.fileCount);
});

test('computeSourceFingerprint fails loudly when a tracked input file cannot be hashed', async () => {
  const deps = fakeDeps(BASE_FILES, { tracked: [...Object.keys(BASE_FILES), 'bridge/src/missing.ts'] });
  await assert.rejects(computeSourceFingerprint(deps), /missing file: bridge\/src\/missing\.ts/);
});
