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
  head: string;
  dirty: boolean;
  fileCount: number;
}

export interface FingerprintDeps {
  listTrackedFiles(): Promise<string[]>;
  hashFile(relPath: string): Promise<string>;
  getHead(): Promise<string>;
  isDirty(inputPaths: readonly string[]): Promise<boolean>;
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
  sourceHead: string;
  sourceDirty: boolean;
}

const log = (msg: string) => process.stderr.write(`build: ${msg}\n`);

/** Returns true if a repo-relative path is a guest/bridge input to the chaos image. */
export function isFingerprintInput(relPath: string): boolean {
  if (relPath === 'chaos/package.json') return true;
  if (relPath.startsWith('bridge/')) return true;
  if (relPath.startsWith('chaos/box/')) return true;
  if (relPath.startsWith('chaos/qemu/')) return true;
  if (relPath.startsWith('chaos/src/')) {
    return !relPath.startsWith('chaos/src/host/') && !relPath.endsWith('.test.ts');
  }
  return false;
}

/** Parses `git status --porcelain -z` output and returns true if any fingerprint input is dirty. */
export function hasDirtyInput(porcelainZ: string): boolean {
  const tokens = porcelainZ.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const path1 = entry.slice(3);
    const path2 = (x === 'R' || x === 'C') ? (tokens[++i] ?? '') : '';
    if (isFingerprintInput(path1) || (path2 !== '' && isFingerprintInput(path2))) return true;
  }
  return false;
}

export function defaultFingerprintDeps(repoRoot = REPO_ROOT): FingerprintDeps {
  return {
    async listTrackedFiles(): Promise<string[]> {
      const out = await mustRun('git', ['-C', repoRoot, 'ls-files', '-z', '--', ...FINGERPRINT_INPUT_ROOTS]);
      return out.split('\0').filter((p) => p.length > 0);
    },
    async hashFile(relPath: string): Promise<string> {
      return sha256(readFileSync(join(repoRoot, relPath)));
    },
    async getHead(): Promise<string> {
      return (await mustRun('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])).trim();
    },
    async isDirty(): Promise<boolean> {
      const out = await mustRun('git', ['-C', repoRoot, 'status', '--porcelain', '-z', '--', ...FINGERPRINT_INPUT_ROOTS]);
      return hasDirtyInput(out);
    },
  };
}

/** Computes a deterministic sha256 fingerprint over sorted (path, sha256) pairs, HEAD commit, and dirty flag. */
export async function computeSourceFingerprint(deps: FingerprintDeps = defaultFingerprintDeps()): Promise<SourceFingerprint> {
  const tracked = await deps.listTrackedFiles();
  const inputFiles = [...new Set(tracked.filter(isFingerprintInput))].sort();
  const entries = await Promise.all(inputFiles.map(async (p) => [p, await deps.hashFile(p)] as const));
  const head = await deps.getHead();
  const dirty = await deps.isDirty(inputFiles);
  const payload = JSON.stringify({ head, dirty, files: entries });
  return {
    sha256: sha256(payload),
    head,
    dirty,
    fileCount: entries.length,
  };
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
  log(`source fingerprint ${fp.sha256} (head=${fp.head.slice(0, 12)} dirty=${fp.dirty} files=${fp.fileCount})`);
  const fpFile = join(CACHE_DIR, 'source-fingerprint.json');
  writeFileSync(fpFile, JSON.stringify(fp, null, 2) + '\n');

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
    sourceFingerprint: fp.sha256,
    sourceHead: fp.head,
    sourceDirty: fp.dirty,
  };
  writeFileSync(BUILD_INFO, JSON.stringify(info, null, 2) + '\n');
  return info;
}

export function readBuildInfo(): BuildInfo | null {
  try { return JSON.parse(readFileSync(BUILD_INFO, 'utf8')) as BuildInfo; } catch { return null; }
}
