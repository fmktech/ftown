// Builds chaos/.cache/: vmlinuz, initramfs.cpio.gz, build.json, and the qemu container image.
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BUILD_INFO, CACHE_DIR, CHAOS_DIR, DEFAULT_BOX_IMAGE, QEMU_DIR, QEMU_IMAGE } from './paths.ts';
import { mustRun, run } from './proc.ts';
import { sha256 } from './summary.ts';

const REPO_ROOT = resolve(CHAOS_DIR, '..');

export const FINGERPRINT_INPUT_ROOTS = [
  'bridge',
  'chaos/src',
  'chaos/box',
  'chaos/qemu',
  'chaos/package.json',
] as const;

export interface SourceFingerprint {
  sha256: string;
  chaosSha256: string;
  head: string;
  dirty: boolean;
  chaosDirty: boolean;
  boxDirty: boolean;
  fileCount: number;
}

export interface FingerprintDeps {
  /** Returns repo-relative POSIX paths of tracked and untracked non-ignored input files. */
  listFiles(): Promise<string[]>;
  /** Returns the sha256 hex digest of a repo-relative file, or null if deleted/missing on disk. */
  hashFile(relPath: string): Promise<string | null>;
  /** Returns the git commit hash of HEAD. */
  getHead(): Promise<string>;
  /** Returns whether any uncommitted path matches `pred`. */
  isDirty(pred: (relPath: string) => boolean): Promise<boolean>;
}

export interface BuildInfo {
  image: string;
  imageId: string;
  kernelVersion: string;
  vmlinuzSha256: string;
  initramfsSha256: string;
  initramfsBytes: number;
  qemuImageId: string;
  qemuVersion: string;
  sourceFingerprint: string;
  chaosFingerprint: string;
  sourceHead: string;
  sourceDirty: boolean;
}

const log = (msg: string) => process.stderr.write(`build: ${msg}\n`);

/**
 * Returns true if a repo-relative path is an input to the chaos image.
 * All of bridge/ (over-invalidation is safe) and all non-test chaos/src/ (including
 * chaos/src/host/, which PACK_SCRIPT packs into /opt/chaos/src) are included.
 */
export function isFingerprintInput(relPath: string): boolean {
  if (relPath === 'chaos/package.json') return true;
  if (relPath.startsWith('bridge/')) return true;
  if (relPath.startsWith('chaos/box/')) return true;
  if (relPath.startsWith('chaos/qemu/')) return true;
  if (relPath.startsWith('chaos/src/')) {
    return !relPath.endsWith('.test.ts');
  }
  return false;
}

/**
 * Returns true if a repo-relative path is a chaos-side input overlaid by pack() on top of any image
 * (chaos/src non-test files, chaos/package.json, chaos/qemu/). Excludes chaos/box/, which comes from
 * inside a custom image and is identified by imageId instead.
 */
export function isChaosFingerprintInput(relPath: string): boolean {
  if (relPath === 'chaos/package.json') return true;
  if (relPath.startsWith('chaos/qemu/')) return true;
  if (relPath.startsWith('chaos/src/')) {
    return !relPath.endsWith('.test.ts');
  }
  return false;
}

/** Parses `git status --porcelain -z` output and returns true if any path matching `pred` is dirty. */
export function hasDirtyInput(porcelainZ: string, pred: (relPath: string) => boolean = isFingerprintInput): boolean {
  const tokens = porcelainZ.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const path1 = entry.slice(3);
    const path2 = (x === 'R' || x === 'C') ? (tokens[++i] ?? '') : '';
    if (pred(path1) || (path2 !== '' && pred(path2))) return true;
  }
  return false;
}

export function defaultFingerprintDeps(repoRoot = REPO_ROOT): FingerprintDeps {
  return {
    async listFiles(): Promise<string[]> {
      const out = await mustRun('git', [
        '-C', repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...FINGERPRINT_INPUT_ROOTS,
      ]);
      return out.split('\0').filter((p) => p.length > 0);
    },
    async hashFile(relPath: string): Promise<string | null> {
      try {
        return sha256(readFileSync(join(repoRoot, relPath)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async getHead(): Promise<string> {
      return (await mustRun('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])).trim();
    },
    async isDirty(pred: (relPath: string) => boolean): Promise<boolean> {
      const out = await mustRun('git', ['-C', repoRoot, 'status', '--porcelain', '-z', '--', ...FINGERPRINT_INPUT_ROOTS]);
      return hasDirtyInput(out, pred);
    },
  };
}

/** Computes a deterministic sha256 fingerprint over sorted (path, sha256|null) pairs, HEAD commit, and dirty flag. */
export async function computeSourceFingerprint(deps: FingerprintDeps = defaultFingerprintDeps()): Promise<SourceFingerprint> {
  const listed = await deps.listFiles();
  const inputFiles = [...new Set(listed.filter(isFingerprintInput))].sort();
  const entries = await Promise.all(inputFiles.map(async (p) => [p, await deps.hashFile(p)] as const));
  const chaosEntries = entries.filter(([p]) => isChaosFingerprintInput(p));
  const head = await deps.getHead();
  const dirty = await deps.isDirty(isFingerprintInput);
  const chaosDirty = await deps.isDirty(isChaosFingerprintInput);
  const boxDirty = await deps.isDirty((p) => p.startsWith('chaos/box/'));
  return {
    sha256: sha256(JSON.stringify({ head, dirty, files: entries })),
    chaosSha256: sha256(JSON.stringify({ head, dirty: chaosDirty, files: chaosEntries })),
    head,
    dirty,
    chaosDirty,
    boxDirty,
    fileCount: entries.length,
  };
}

export async function inspectImageId(image: string): Promise<string | null> {
  const r = await run('docker', ['image', 'inspect', '-f', '{{.Id}}', image]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Shell run inside the qemu container: tar stream on stdin -> reproducible initramfs on /out. */
export const PACK_SCRIPT = [
  'set -eu',
  'mkdir /r',
  'tar --numeric-owner -xpf - -C /r',
  'rm -f /r/.dockerenv',
  'cp /init.sh /r/init && chmod 0755 /r/init',
  // The guest always runs this checkout's chaos code, whatever the image baked in.
  'rm -rf /r/opt/chaos/src && mkdir -p /r/opt/chaos && cp -R /chaos/src /r/opt/chaos/src && cp /chaos/package.json /r/opt/chaos/package.json',
  'cp /source-fingerprint.json /r/opt/chaos/source-fingerprint.json',
  "find /r/opt/chaos/src -name '*.test.ts' -delete",
  'chown -R 0:0 /r/opt/chaos && chmod -R a+rX,go-w /r/opt/chaos',
  'find /r -exec touch -h -d @0 {} +',
  'cd /r',
  'find . -mindepth 1 -print0 | LC_ALL=C sort -z | cpio --null -o -H newc --reproducible --quiet | gzip -n -6',
].join('\n');

/** Packs `image` into a reproducible initramfs at dest. The archive comes back on stdout
 * (no bind-mounted output: Docker Desktop file sharing may lag behind container exit). */
async function pack(image: string, dest: string, fingerprintFile: string): Promise<void> {
  const cid = (await mustRun('docker', ['create', '--platform', 'linux/amd64', image, '/init'])).trim();
  const tmp = `${dest}.tmp`;
  try {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const pipeline = `docker export ${q(cid)} | docker run -i --rm --network none ` +
      `-v ${q(join(QEMU_DIR, 'init'))}:/init.sh:ro -v ${q(join(CHAOS_DIR, 'src'))}:/chaos/src:ro ` +
      `-v ${q(join(CHAOS_DIR, 'package.json'))}:/chaos/package.json:ro ` +
      `-v ${q(fingerprintFile)}:/source-fingerprint.json:ro ${q(QEMU_IMAGE)} sh -c ${q(PACK_SCRIPT)} > ${q(tmp)}`;
    await mustRun('bash', ['-o', 'pipefail', '-c', pipeline], { echo: true });
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
    await run('docker', ['rm', '-f', cid]);
  }
}

export async function build(imageArg: string | null, checkRepro = false): Promise<BuildInfo> {
  mkdirSync(CACHE_DIR, { recursive: true });

  const fp = await computeSourceFingerprint();

  log(`qemu container ${QEMU_IMAGE} (native arch)`);
  await mustRun('docker', ['build', '-q', '-t', QEMU_IMAGE, '-f', join(QEMU_DIR, 'qemu.Dockerfile'), QEMU_DIR], { echo: true });

  log('guest kernel (linux/amd64)');
  const kdir = join(CACHE_DIR, 'kernel');
  await mustRun('docker', ['build', '-q', '--platform', 'linux/amd64', '-f', join(QEMU_DIR, 'kernel.Dockerfile'),
    '--output', `type=local,dest=${kdir}`, QEMU_DIR], { echo: true });
  copyFileSync(join(kdir, 'vmlinuz'), join(CACHE_DIR, 'vmlinuz'));
  const kernelVersion = readFileSync(join(kdir, 'kernel-version'), 'utf8').trim();

  let image = imageArg;
  if (image === null) {
    log(`box container ${DEFAULT_BOX_IMAGE} (linux/amd64)`);
    await mustRun('docker', ['build', '-q', '--platform', 'linux/amd64', '-t', DEFAULT_BOX_IMAGE,
      '-f', join(CHAOS_DIR, 'box', 'Dockerfile'), REPO_ROOT], { echo: true });
    image = DEFAULT_BOX_IMAGE;
  }
  const imageId = (await mustRun('docker', ['image', 'inspect', '-f', '{{.Id}}', image])).trim();
  const isCustomImage = imageArg !== null;
  const sourceFingerprint = isCustomImage ? `custom-image:${imageId}` : fp.sha256;
  const sourceDirty = isCustomImage ? fp.chaosDirty : fp.dirty;
  if (isCustomImage) {
    log(`notice: custom image ${image} (${imageId}); sourceFingerprint=${sourceFingerprint} chaos=${fp.chaosSha256.slice(0, 8)}`);
  } else {
    log(`source fingerprint ${sourceFingerprint} (head=${fp.head.slice(0, 12)} dirty=${sourceDirty} files=${fp.fileCount})`);
  }

  const fpFile = join(CACHE_DIR, 'source-fingerprint.json');
  writeFileSync(fpFile, JSON.stringify({
    sha256: sourceFingerprint,
    chaosSha256: fp.chaosSha256,
    head: fp.head,
    dirty: sourceDirty,
    fileCount: fp.fileCount,
  }, null, 2) + '\n');

  log(`initramfs from ${image} (${imageId})`);
  const initrd = join(CACHE_DIR, 'initramfs.cpio.gz');
  await pack(image, initrd, fpFile);
  if (checkRepro) {
    const second = join(CACHE_DIR, 'initramfs.repro-check.cpio.gz');
    await pack(image, second, fpFile);
    const a = sha256(readFileSync(initrd));
    const b = sha256(readFileSync(second));
    rmSync(second, { force: true });
    if (a !== b) throw new Error(`initramfs is not reproducible: ${a} vs ${b}`);
    log(`check-repro: two packs identical (${a})`);
  }

  const info: BuildInfo = {
    image,
    imageId,
    kernelVersion,
    vmlinuzSha256: sha256(readFileSync(join(CACHE_DIR, 'vmlinuz'))),
    initramfsSha256: sha256(readFileSync(initrd)),
    initramfsBytes: statSync(initrd).size,
    qemuImageId: (await mustRun('docker', ['image', 'inspect', '-f', '{{.Id}}', QEMU_IMAGE])).trim(),
    qemuVersion: (await mustRun('docker', ['run', '--rm', QEMU_IMAGE, 'qemu-system-x86_64', '--version'])).split('\n')[0].trim(),
    sourceFingerprint,
    chaosFingerprint: fp.chaosSha256,
    sourceHead: fp.head,
    sourceDirty,
  };
  writeFileSync(BUILD_INFO, JSON.stringify(info, null, 2) + '\n');
  return info;
}

export function readBuildInfo(): BuildInfo | null {
  try { return JSON.parse(readFileSync(BUILD_INFO, 'utf8')) as BuildInfo; } catch { return null; }
}
