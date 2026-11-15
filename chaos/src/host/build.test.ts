import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeSourceFingerprint, defaultFingerprintDeps, hasDirtyInput, isChaosFingerprintInput, isFingerprintInput, type FingerprintDeps } from './build.ts';
import { sha256 } from './summary.ts';

function fakeDeps(
  files: Record<string, string | null>,
  opts: { head?: string; dirty?: boolean; chaosDirty?: boolean; boxDirty?: boolean; listed?: string[] } = {},
): FingerprintDeps {
  const listed = opts.listed ?? Object.keys(files);
  return {
    async listFiles() {
      return listed;
    },
    async hashFile(relPath: string) {
      if (!(relPath in files)) throw new Error(`read error: ${relPath}`);
      const content = files[relPath];
      return content === null ? null : sha256(content);
    },
    async getHead() {
      return opts.head ?? '0123456789abcdef0123456789abcdef01234567';
    },
    async isDirty(pred: (relPath: string) => boolean) {
      if (pred('bridge/src/index.ts')) return opts.dirty ?? false;
      if (pred('chaos/src/guest/main.ts')) return opts.chaosDirty ?? opts.dirty ?? false;
      if (pred('chaos/box/Dockerfile')) return opts.boxDirty ?? opts.dirty ?? false;
      return false;
    },
  };
}

const BASE_FILES: Record<string, string | null> = {
  'bridge/package.json': '{"name":"ftown-bridge"}',
  'bridge/package-lock.json': '{"lockfileVersion":3}',
  'bridge/src/index.ts': 'export const ok = true;\n',
  'chaos/package.json': '{"name":"ftown-chaos"}',
  'chaos/src/contract.ts': 'export const CONTRACT_VERSION = 8;\n',
  'chaos/src/guest/main.ts': 'console.log("guest");\n',
  'chaos/src/host/build.ts': 'host code\n',
  'chaos/box/Dockerfile': 'FROM node:24\n',
  'chaos/qemu/init': '#!/bin/sh\n',
  'chaos/src/guest/main.test.ts': 'test code\n',
  'ui/src/App.tsx': 'export function App() { return null; }\n',
};

test('isFingerprintInput accepts bridge and non-test chaos inputs (including host) and rejects tests/unrelated files', () => {
  assert.equal(isFingerprintInput('bridge/src/index.ts'), true);
  assert.equal(isFingerprintInput('bridge/package-lock.json'), true);
  assert.equal(isFingerprintInput('chaos/package.json'), true);
  assert.equal(isFingerprintInput('chaos/src/contract.ts'), true);
  assert.equal(isFingerprintInput('chaos/src/guest/main.ts'), true);
  assert.equal(isFingerprintInput('chaos/src/host/build.ts'), true);
  assert.equal(isFingerprintInput('chaos/src/supervisor/main.ts'), true);
  assert.equal(isFingerprintInput('chaos/box/Dockerfile'), true);
  assert.equal(isFingerprintInput('chaos/qemu/init'), true);

  assert.equal(isChaosFingerprintInput('chaos/src/guest/main.ts'), true);
  assert.equal(isChaosFingerprintInput('chaos/src/host/build.ts'), true);
  assert.equal(isChaosFingerprintInput('chaos/package.json'), true);
  assert.equal(isChaosFingerprintInput('chaos/qemu/init'), true);
  assert.equal(isChaosFingerprintInput('chaos/box/Dockerfile'), false);
  assert.equal(isChaosFingerprintInput('chaos/box/up.sh'), false);
  assert.equal(isChaosFingerprintInput('chaos/src/guest/main.test.ts'), false);
  assert.equal(isChaosFingerprintInput('bridge/src/index.ts'), false);

  assert.equal(isFingerprintInput('chaos/src/guest/main.test.ts'), false);
  assert.equal(isFingerprintInput('chaos/src/host/build.test.ts'), false);
  assert.equal(isFingerprintInput('ui/src/App.tsx'), false);
  assert.equal(isFingerprintInput('README.md'), false);
});

test('hasDirtyInput detects ??, D, and renamed/copied entries and ignores unrelated files', () => {
  assert.equal(hasDirtyInput(''), false);
  assert.equal(hasDirtyInput(' M ui/src/App.tsx\0?? ui/New.tsx\0'), false);
  assert.equal(hasDirtyInput('?? bridge/src/untracked.ts\0'), true);
  assert.equal(hasDirtyInput(' D bridge/src/index.ts\0'), true);
  assert.equal(hasDirtyInput('D  bridge/src/x.ts\0'), true);
  assert.equal(hasDirtyInput(' D chaos/src/guest/main.ts\0'), true);
  assert.equal(hasDirtyInput('R  ui/new.ts\0bridge/old.ts\0'), true);
  assert.equal(hasDirtyInput('C  bridge/copy.ts\0bridge/src/index.ts\0'), true);
  assert.equal(hasDirtyInput('R  ui/new.ts\0ui/old.ts\0'), false);
});

test('defaultFingerprintDeps.isDirty detects staged deletion and rename in a real git repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-dirty-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(dir, 'bridge/src'), { recursive: true });
    mkdirSync(join(dir, 'ui'), { recursive: true });
    writeFileSync(join(dir, 'bridge/src/x.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'bridge/src/old.ts'), 'export const old = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    const deps = defaultFingerprintDeps(dir);
    assert.equal(await deps.isDirty(isFingerprintInput), false);

    // Staged deletion: 'D  bridge/src/x.ts'
    git('rm', '-q', 'bridge/src/x.ts');
    assert.equal(await deps.isDirty(isFingerprintInput), true);
    git('reset', '-q', 'HEAD');
    git('checkout', '-q', '--', 'bridge/src/x.ts');
    assert.equal(await deps.isDirty(isFingerprintInput), false);

    // Staged rename: 'R  bridge/src/old.ts -> ui/new.ts'
    git('mv', 'bridge/src/old.ts', 'ui/new.ts');
    assert.equal(await deps.isDirty(isFingerprintInput), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeSourceFingerprint is deterministic across file listing order', async () => {
  const a = await computeSourceFingerprint(fakeDeps(BASE_FILES));
  const reversed = Object.keys(BASE_FILES).reverse();
  const b = await computeSourceFingerprint(fakeDeps(BASE_FILES, { listed: reversed }));
  assert.deepEqual(a, b);
  assert.equal(a.fileCount, 9);
});

test('computeSourceFingerprint changes when a bridge file changes, is added (untracked), or is deleted', async () => {
  const base = await computeSourceFingerprint(fakeDeps(BASE_FILES));
  const edited = await computeSourceFingerprint(fakeDeps({
    ...BASE_FILES,
    'bridge/src/index.ts': 'export const ok = false;\n',
  }));
  const added = await computeSourceFingerprint(fakeDeps({
    ...BASE_FILES,
    'bridge/src/untracked.ts': 'export const extra = 1;\n',
  }));
  const deleted = await computeSourceFingerprint(fakeDeps({
    ...BASE_FILES,
    'bridge/src/index.ts': null,
  }, { dirty: true }));

  assert.notEqual(base.sha256, edited.sha256);
  assert.notEqual(base.sha256, added.sha256);
  assert.notEqual(base.sha256, deleted.sha256);
  assert.equal(base.chaosSha256, edited.chaosSha256);
});

test('computeSourceFingerprint changes when a chaos guest or host file changes', async () => {
  const base = await computeSourceFingerprint(fakeDeps(BASE_FILES));
  const guestEdited = await computeSourceFingerprint(fakeDeps({
    ...BASE_FILES,
    'chaos/src/guest/main.ts': 'console.log("guest v2");\n',
  }));
  const hostEdited = await computeSourceFingerprint(fakeDeps({
    ...BASE_FILES,
    'chaos/src/host/build.ts': 'host code v2\n',
  }));
  assert.notEqual(base.sha256, guestEdited.sha256);
  assert.notEqual(base.chaosSha256, guestEdited.chaosSha256);
  assert.notEqual(base.sha256, hostEdited.sha256);
  assert.notEqual(base.chaosSha256, hostEdited.chaosSha256);
});

test('computeSourceFingerprint: chaos/box edit changes sha256 (default image) but NOT chaosSha256 (custom image)', async () => {
  const base = await computeSourceFingerprint(fakeDeps(BASE_FILES));
  const boxEdited = await computeSourceFingerprint(fakeDeps({
    ...BASE_FILES,
    'chaos/box/up.sh': '#!/bin/sh\necho changed\n',
  }, { dirty: true, chaosDirty: false, boxDirty: true }));
  assert.notEqual(base.sha256, boxEdited.sha256);
  assert.equal(base.chaosSha256, boxEdited.chaosSha256);
  assert.equal(boxEdited.boxDirty, true);
  assert.equal(boxEdited.chaosDirty, false);
});

test('computeSourceFingerprint changes when HEAD or dirty flag changes', async () => {
  const a = await computeSourceFingerprint(fakeDeps(BASE_FILES, { head: 'aaa', dirty: false }));
  const b = await computeSourceFingerprint(fakeDeps(BASE_FILES, { head: 'bbb', dirty: false }));
  const c = await computeSourceFingerprint(fakeDeps(BASE_FILES, { head: 'aaa', dirty: true }));
  assert.notEqual(a.sha256, b.sha256);
  assert.notEqual(a.sha256, c.sha256);
});

test('computeSourceFingerprint does NOT change when an unrelated file (e.g. ui/) or test file changes', async () => {
  const a = await computeSourceFingerprint(fakeDeps(BASE_FILES));
  const b = await computeSourceFingerprint(fakeDeps({
    ...BASE_FILES,
    'ui/src/App.tsx': 'export function App() { return "changed"; }\n',
    'chaos/src/guest/main.test.ts': 'changed test code\n',
    'docs/notes.md': 'added doc\n',
  }));
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.chaosSha256, b.chaosSha256);
  assert.equal(a.fileCount, b.fileCount);
});

test('computeSourceFingerprint fails loudly on unexpected file read errors', async () => {
  const deps = fakeDeps(BASE_FILES, { listed: [...Object.keys(BASE_FILES), 'bridge/src/unreadable.ts'] });
  await assert.rejects(computeSourceFingerprint(deps), /read error: bridge\/src\/unreadable\.ts/);
});
