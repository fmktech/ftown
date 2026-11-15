import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { acquireBuildLock, collectSourceInputs, computeSourceFingerprint, defaultFingerprintDeps, hasDirtyInput, isChaosFingerprintInput, isFingerprintInput, listFingerprintInputs, releaseBuildLock, stageSourceTree, type FingerprintDeps, type LockOps } from './build.ts';

function fakeDeps(
  files: Record<string, string | null>,
  opts: { head?: string; dirty?: boolean; chaosDirty?: boolean; boxDirty?: boolean; listed?: string[]; exec?: Record<string, boolean> } = {},
): FingerprintDeps {
  const listed = opts.listed ?? Object.keys(files);
  return {
    async listFiles() {
      return listed;
    },
    async readFile(relPath: string) {
      if (!(relPath in files)) throw new Error(`read error: ${relPath}`);
      const content = files[relPath];
      if (content === null) return null;
      return { bytes: Buffer.from(content), executable: opts.exec?.[relPath] ?? false };
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

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out.push(relative(root, abs).split('\\').join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function memLock(): LockOps {
  const dirs = new Set<string>();
  const files = new Map<string, string>();
  return {
    mkdir(path: string) {
      if (dirs.has(path)) {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      dirs.add(path);
    },
    writeFile(path: string, data: string) { files.set(path, data); },
    readFile(path: string) {
      const data = files.get(path);
      if (data === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return data;
    },
    rm(path: string) {
      dirs.delete(path);
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      }
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

test('staging list equals the fingerprint list; an ignored path is in neither and an untracked path is in both', async () => {
  const ignored = 'bridge/data/ignored.txt';
  const untracked = 'bridge/src/untracked.ts';
  const files: Record<string, string | null> = {
    ...BASE_FILES,
    [untracked]: 'export const extra = 1;\n',
    [ignored]: 'should-not-be-listed\n',
  };
  // listFiles is git ls-files --exclude-standard: the ignored path is absent, the untracked path is present.
  const deps = fakeDeps(files, {
    listed: Object.keys(files).filter((p) => p !== ignored),
    exec: { 'chaos/qemu/init': true },
  });
  const inputs = await collectSourceInputs(deps);
  const fingerprintPaths = await listFingerprintInputs(deps);
  assert.deepEqual(inputs.map((f) => f.path), fingerprintPaths);
  assert.equal(fingerprintPaths.includes(ignored), false);
  assert.equal(fingerprintPaths.includes(untracked), true);

  const dest = mkdtempSync(join(tmpdir(), 'chaos-stage-'));
  try {
    const staged = stageSourceTree(dest, inputs);
    assert.deepEqual(staged, fingerprintPaths);
    assert.equal(existsSync(join(dest, ignored)), false);
    assert.equal(readFileSync(join(dest, untracked), 'utf8'), 'export const extra = 1;\n');
    assert.equal(statSync(join(dest, 'chaos/qemu/init')).mode & 0o777, 0o755);
    assert.equal(statSync(join(dest, 'chaos/box/Dockerfile')).mode & 0o777, 0o644);
    assert.deepEqual(walkFiles(dest), fingerprintPaths);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }

  const withUntracked = await computeSourceFingerprint(deps);
  const without = await computeSourceFingerprint(fakeDeps(BASE_FILES, { exec: { 'chaos/qemu/init': true } }));
  assert.notEqual(withUntracked.sha256, without.sha256);
  assert.equal(withUntracked.fileCount, fingerprintPaths.length);
});

test('an executable-bit flip changes the fingerprint; the same bit does not', async () => {
  const base = await computeSourceFingerprint(fakeDeps(BASE_FILES));
  const boxExec = await computeSourceFingerprint(fakeDeps(BASE_FILES, { exec: { 'chaos/box/Dockerfile': true } }));
  const chaosExec = await computeSourceFingerprint(fakeDeps(BASE_FILES, { exec: { 'chaos/src/guest/main.ts': true } }));
  const again = await computeSourceFingerprint(fakeDeps(BASE_FILES));
  const nonInput = await computeSourceFingerprint(fakeDeps(BASE_FILES, {
    exec: { 'chaos/src/guest/main.test.ts': true, 'ui/src/App.tsx': true },
  }));

  assert.notEqual(base.sha256, boxExec.sha256);
  assert.equal(base.chaosSha256, boxExec.chaosSha256);
  assert.notEqual(base.sha256, chaosExec.sha256);
  assert.notEqual(base.chaosSha256, chaosExec.chaosSha256);
  assert.equal(base.sha256, again.sha256);
  assert.equal(base.chaosSha256, again.chaosSha256);
  assert.equal(base.sha256, nonInput.sha256);
});

test('stageSourceTree refuses a path that escapes the stage directory', () => {
  const dest = mkdtempSync(join(tmpdir(), 'chaos-stage-escape-'));
  try {
    assert.throws(() => stageSourceTree(dest, [{
      path: 'bridge/../../chaos-stage-escaped-probe.txt',
      digest: null,
      executable: false,
      bytes: Buffer.from('x'),
    }]), /unsafe path/);
    assert.equal(existsSync(join(dest, '..', 'chaos-stage-escaped-probe.txt')), false);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('defaultFingerprintDeps omits gitignored files, includes untracked file bytes, and an x-bit flip changes the fingerprint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-list-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'core.filemode', 'true');
    mkdirSync(join(dir, 'bridge/src'), { recursive: true });
    mkdirSync(join(dir, 'chaos/box'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), 'data/\n');
    writeFileSync(join(dir, 'bridge/src/x.ts'), 'export const x = 1;\n', { mode: 0o644 });
    chmodSync(join(dir, 'bridge/src/x.ts'), 0o644);
    writeFileSync(join(dir, 'chaos/box/Dockerfile'), 'FROM scratch\n', { mode: 0o644 });
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    const deps = defaultFingerprintDeps(dir);
    const basePaths = await listFingerprintInputs(deps);
    const baseInputs = await collectSourceInputs(deps);
    assert.deepEqual(baseInputs.map((f) => f.path), basePaths);
    const base = await computeSourceFingerprint(deps, baseInputs);

    mkdirSync(join(dir, 'bridge/data'), { recursive: true });
    writeFileSync(join(dir, 'bridge/data/secret.txt'), 'ignored\n');
    assert.match(git('check-ignore', '-v', 'bridge/data/secret.txt'), /data\//);
    const withIgnored = await collectSourceInputs(deps);
    assert.deepEqual(withIgnored.map((f) => f.path), basePaths);
    assert.equal((await computeSourceFingerprint(deps, withIgnored)).sha256, base.sha256);

    const untracked = join(dir, 'bridge/src/extra.ts');
    writeFileSync(untracked, 'export const extra = 1;\n');
    assert.throws(() => git('check-ignore', '-q', 'bridge/src/extra.ts'));
    const added = await collectSourceInputs(deps);
    assert.equal(added.some((f) => f.path === 'bridge/src/extra.ts'), true);
    assert.deepEqual(added.map((f) => f.path), await listFingerprintInputs(deps));
    const addedFp = await computeSourceFingerprint(deps, added);
    assert.notEqual(addedFp.sha256, base.sha256);

    writeFileSync(untracked, 'export const extra = 2;\n');
    const edited = await computeSourceFingerprint(deps);
    assert.notEqual(edited.sha256, addedFp.sha256);

    const stage = mkdtempSync(join(tmpdir(), 'chaos-list-stage-'));
    try {
      const staged = stageSourceTree(stage, await collectSourceInputs(deps));
      assert.deepEqual(staged, await listFingerprintInputs(deps));
      assert.equal(existsSync(join(stage, 'bridge/data/secret.txt')), false);
      assert.equal(readFileSync(join(stage, 'bridge/src/extra.ts'), 'utf8'), 'export const extra = 2;\n');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }

    rmSync(untracked);
    assert.equal((await computeSourceFingerprint(deps)).sha256, base.sha256);

    chmodSync(join(dir, 'bridge/src/x.ts'), 0o755);
    const flipped = await computeSourceFingerprint(deps);
    assert.notEqual(flipped.sha256, base.sha256);
    const flippedInputs = await collectSourceInputs(deps);
    assert.equal(flippedInputs.find((f) => f.path === 'bridge/src/x.ts')?.executable, true);
    chmodSync(join(dir, 'bridge/src/x.ts'), 0o644);
    assert.equal((await computeSourceFingerprint(deps)).sha256, base.sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-staging drops a path removed from the list and the on-disk set matches', () => {
  const dest = mkdtempSync(join(tmpdir(), 'chaos-restage-'));
  const keep = { path: 'bridge/src/keep.ts', digest: null, executable: false, bytes: Buffer.from('keep\n') };
  const drop = { path: 'bridge/src/drop.ts', digest: null, executable: false, bytes: Buffer.from('drop\n') };
  try {
    stageSourceTree(dest, [keep, drop]);
    assert.deepEqual(walkFiles(dest), ['bridge/src/drop.ts', 'bridge/src/keep.ts']);
    stageSourceTree(dest, [keep]);
    assert.deepEqual(walkFiles(dest), ['bridge/src/keep.ts']);
    assert.equal(existsSync(join(dest, 'bridge/src/drop.ts')), false);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('defaultFingerprintDeps rejects a symlink instead of following it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-link-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(dir, 'bridge/src'), { recursive: true });
    writeFileSync(join(dir, 'bridge/src/x.ts'), 'export const x = 1;\n');
    symlinkSync('x.ts', join(dir, 'bridge/src/link.ts'));
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    await assert.rejects(collectSourceInputs(defaultFingerprintDeps(dir)), /not a regular file: bridge\/src\/link\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireBuildLock rejects a live holder, reclaims a dead pid, and release drops only our lock', () => {
  const dir = '/cache/build.lock';
  const alive = memLock();
  acquireBuildLock(dir, 10, alive, () => true);
  assert.throws(() => acquireBuildLock(dir, 11, alive, (pid) => pid === 10), /exits 3/);
  assert.equal(alive.readFile(`${dir}/pid`).trim(), '10');

  const dead = memLock();
  dead.mkdir(dir);
  dead.writeFile(`${dir}/pid`, '99\n');
  acquireBuildLock(dir, 12, dead, () => false);
  assert.equal(dead.readFile(`${dir}/pid`).trim(), '12');
  releaseBuildLock(dir, 12, dead);
  assert.throws(() => dead.readFile(`${dir}/pid`));

  const other = memLock();
  acquireBuildLock(dir, 13, other, () => true);
  releaseBuildLock(dir, 14, other);
  assert.equal(other.readFile(`${dir}/pid`).trim(), '13');

  const unread = memLock();
  unread.mkdir(dir);
  assert.throws(() => acquireBuildLock(dir, 15, unread, () => false), /no readable pid/);
  assert.throws(() => unread.readFile(`${dir}/pid`));
});
