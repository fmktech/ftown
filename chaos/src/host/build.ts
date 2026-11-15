// Builds chaos/.cache/: vmlinuz, initramfs.cpio.gz, build.json, and the qemu container image.
// Guest image content is a function of the fingerprint file list: path, bytes, executable bit.
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { BUILD_INFO, CACHE_DIR, CHAOS_DIR, DEFAULT_BOX_IMAGE, QEMU_IMAGE } from './paths.ts';
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

/** Bytes and the executable bit, both taken from one open of a regular file. */
export interface FileSnapshot {
  bytes: Buffer;
  /** True when fstat shows any execute bit (git mode 100755); otherwise false (100644). */
  executable: boolean;
}

export interface FingerprintDeps {
  /** Returns repo-relative POSIX paths of tracked and untracked non-ignored input files. */
  listFiles(): Promise<string[]>;
  /**
   * Opens `relPath` once and fstats that descriptor. Returns the bytes and the
   * executable bit, or null if the path is missing. A symlink or other
   * non-regular file is not followed; it throws BuildExit (the CLI exits 3).
   */
  readFile(relPath: string): Promise<FileSnapshot | null>;
  /** Returns the git commit hash of HEAD. */
  getHead(): Promise<string>;
  /** Returns whether any uncommitted path matches `pred`. */
  isDirty(pred: (relPath: string) => boolean): Promise<boolean>;
}

/** Failure that the host CLI reports as exit 3 (EXIT.infra). */
export class BuildExit extends Error {
  readonly exitCode = 3;
  constructor(message: string) {
    super(message);
    this.name = 'BuildExit';
  }
}

/** One fingerprint input. `bytes` is null when the path was listed and then disappeared. */
export interface SourceInput {
  path: string;
  digest: string | null;
  executable: boolean;
  bytes: Buffer | null;
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
    async readFile(relPath: string): Promise<FileSnapshot | null> {
      return readRegularFile(join(repoRoot, relPath), relPath);
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

interface InputFileStat {
  isFile(): boolean;
  size: number;
  mode: number;
}

/** Real filesystem, or a test double when mkfifo cannot be created. */
export interface InputFs {
  open(path: string, flags: number): number;
  fstat(fd: number): InputFileStat;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  close(fd: number): void;
}

const defaultInputFs: InputFs = {
  open: openSync,
  fstat: fstatSync,
  read(fd, buffer, offset, length, position) {
    return readSync(fd, buffer, offset, length, position);
  },
  close: closeSync,
};

export function readRegularFile(abs: string, relPath: string, fs: InputFs = defaultInputFs): FileSnapshot | null {
  let fd: number;
  try {
    // O_NOFOLLOW: a symlink is not opened as its target (macOS and Linux return ELOOP).
    // O_NONBLOCK: an untracked FIFO must not wait for a writer.
    fd = fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EISDIR' || code === 'ENXIO') {
      throw new BuildExit(`fingerprint input is not a regular file: ${relPath}`);
    }
    throw err;
  }
  try {
    const st = fs.fstat(fd);
    if (!st.isFile()) throw new BuildExit(`fingerprint input is not a regular file: ${relPath}`);
    const bytes = Buffer.alloc(st.size);
    let off = 0;
    while (off < bytes.length) {
      const n = fs.read(fd, bytes, off, bytes.length - off, null);
      if (n === 0) break;
      off += n;
    }
    return {
      bytes: off === bytes.length ? bytes : bytes.subarray(0, off),
      executable: (st.mode & 0o111) !== 0,
    };
  } finally {
    fs.close(fd);
  }
}

/** Sorted repo-relative paths the fingerprint hashes. Image inputs are this list and nothing else. */
export async function listFingerprintInputs(deps: FingerprintDeps = defaultFingerprintDeps()): Promise<string[]> {
  const listed = await deps.listFiles();
  return [...new Set(listed.filter(isFingerprintInput))].sort();
}

function byPath(inputs: readonly SourceInput[]): SourceInput[] {
  return [...inputs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Reads the fingerprint list once. Staging writes these bytes; the hash covers path, digest, and executable bit. */
export async function collectSourceInputs(deps: FingerprintDeps = defaultFingerprintDeps()): Promise<SourceInput[]> {
  const paths = await listFingerprintInputs(deps);
  return Promise.all(paths.map(async (path) => {
    const snap = await deps.readFile(path);
    if (snap === null) return { path, digest: null, executable: false, bytes: null };
    return { path, digest: sha256(snap.bytes), executable: snap.executable, bytes: snap.bytes };
  }));
}

/** Mode copied into the staged tree and the image. Git only records the executable bit, so the mode is 0755 or 0644. */
export function fingerprintFileMode(executable: boolean): number {
  return executable ? 0o755 : 0o644;
}

/** Computes a deterministic sha256 over HEAD, the dirty flag, and sorted [path, sha256|null, executable] entries. */
export async function computeSourceFingerprint(
  deps: FingerprintDeps = defaultFingerprintDeps(),
  inputs?: readonly SourceInput[],
): Promise<SourceFingerprint> {
  const files = byPath(inputs ?? await collectSourceInputs(deps)).filter((f) => isFingerprintInput(f.path));
  const entries = files.map((f) => [f.path, f.digest, f.executable] as const);
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

function stagePath(dest: string, relPath: string): string {
  if (relPath.length === 0 || isAbsolute(relPath)) throw new Error(`refusing to stage unsafe path: ${relPath}`);
  const abs = resolve(dest, relPath);
  const back = relative(dest, abs);
  if (back === '' || back.startsWith('..') || isAbsolute(back)) throw new Error(`refusing to stage unsafe path: ${relPath}`);
  return abs;
}

/** Directory mode only. File mtimes stay at write time; pinning them hides same-size edits from BuildKit. */
function chmodDirectories(root: string): void {
  const dirs: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = join(dir, ent.name);
      dirs.push(p);
      walk(p);
    }
  };
  walk(root);
  for (const d of dirs) chmodSync(d, 0o755);
  chmodSync(root, 0o755);
}

/**
 * Writes `inputs` under `dest` and returns their paths (the fingerprint list).
 *
 * A directory, not a tar on stdin: pack() has to mount a tree, and a second copy of the
 * bytes could drift from the docker context. One tree under chaos/.cache/context is the
 * snapshot both use. Docker builds take that tree (the box) or its chaos/qemu prefix
 * (qemu and kernel; those Dockerfiles address paths like `patches/`, so the COPY lines
 * stay as written). The prefix is exactly the listed files under chaos/qemu.
 *
 * Each file is mode 0755 or 0644, matching the executable bit in the fingerprint entry.
 * mtimes are left at write time. BuildKit's context sync does not read bytes when
 * size, mtime, mode, and uid/gid match the previous upload, so an epoch mtime would
 * keep the old COPY bytes for a same-size edit while the fingerprint hashed the new
 * ones. After upload, the COPY layer cache is content-keyed, so unchanged content
 * still hits. Docker does not apply a host .dockerignore to this tree unless the
 * staged list itself contains one. chaos/box/Dockerfile.dockerignore matches nothing.
 */
export function stageSourceTree(dest: string, inputs: readonly SourceInput[]): string[] {
  const files = byPath(inputs).filter((f) => isFingerprintInput(f.path));
  const tmp = `${dest}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const paths: string[] = [];
    for (const f of files) {
      paths.push(f.path);
      if (f.bytes === null) continue;
      const abs = stagePath(tmp, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.bytes);
      chmodSync(abs, fingerprintFileMode(f.executable));
    }
    chmodDirectories(tmp);
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
    return paths;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
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
  // /chaos/src and /chaos/package.json are the staged fingerprint list, not the live tree.
  'rm -rf /r/opt/chaos/src && mkdir -p /r/opt/chaos && cp -R /chaos/src /r/opt/chaos/src && cp /chaos/package.json /r/opt/chaos/package.json',
  'cp /source-fingerprint.json /r/opt/chaos/source-fingerprint.json',
  "find /r/opt/chaos/src -name '*.test.ts' -delete",
  'chown -R 0:0 /r/opt/chaos && chmod -R a+rX,go-w /r/opt/chaos',
  'find /r -exec touch -h -d @0 {} +',
  'cd /r',
  'find . -mindepth 1 -print0 | LC_ALL=C sort -z | cpio --null -o -H newc --reproducible --quiet | gzip -n -6',
].join('\n');

function requireStaged(stageDir: string, relPath: string): string {
  const abs = join(stageDir, relPath);
  if (!existsSync(abs)) throw new Error(`staged fingerprint context is missing ${relPath}`);
  return abs;
}

/** Packs `image` into a reproducible initramfs at dest. The archive comes back on stdout
 * (no bind-mounted output: Docker Desktop file sharing may lag behind container exit).
 * chaos/src, chaos/package.json, and chaos/qemu/init are mounted from `stageDir`. */
async function pack(image: string, dest: string, fingerprintFile: string, stageDir: string): Promise<void> {
  const cid = (await mustRun('docker', ['create', '--platform', 'linux/amd64', image, '/init'])).trim();
  const tmp = `${dest}.tmp`;
  try {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const pipeline = `docker export ${q(cid)} | docker run -i --rm --network none ` +
      `-v ${q(requireStaged(stageDir, 'chaos/qemu/init'))}:/init.sh:ro ` +
      `-v ${q(requireStaged(stageDir, 'chaos/src'))}:/chaos/src:ro ` +
      `-v ${q(requireStaged(stageDir, 'chaos/package.json'))}:/chaos/package.json:ro ` +
      `-v ${q(fingerprintFile)}:/source-fingerprint.json:ro ${q(QEMU_IMAGE)} sh -c ${q(PACK_SCRIPT)} > ${q(tmp)}`;
    await mustRun('bash', ['-o', 'pipefail', '-c', pipeline], { echo: true });
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
    await run('docker', ['rm', '-f', cid]);
  }
}

/** mkdir-based lock. Tests inject these so they never touch chaos/.cache. */
export interface LockOps {
  /** Creates `path` as a directory. Throws EEXIST when it already exists. */
  mkdir(path: string): void;
  writeFile(path: string, data: string): void;
  readFile(path: string): string;
  rm(path: string): void;
}

export const defaultLockOps: LockOps = {
  mkdir(path: string) { mkdirSync(path); },
  writeFile(path: string, data: string) { writeFileSync(path, data); },
  readFile(path: string) { return readFileSync(path, 'utf8'); },
  rm(path: string) { rmSync(path, { recursive: true, force: true }); },
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/** A live pid older than this is stale. A full build finishes well under an hour. */
export const BUILD_LOCK_STALE_MS = 60 * 60 * 1000;

function lockMeta(ops: LockOps, pidPath: string): { pid: number; createdAt: number | null } | null {
  let text: string;
  try {
    text = ops.readFile(pidPath);
  } catch {
    return null;
  }
  const [pidLine, timeLine] = text.split('\n');
  const pid = Number(pidLine);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (timeLine === undefined || timeLine.length === 0) return { pid, createdAt: null };
  const createdAt = Number(timeLine);
  return { pid, createdAt: Number.isFinite(createdAt) ? createdAt : null };
}

/**
 * Exclusive lock around one build. A second build exits 3 instead of waiting:
 * the holder is using docker, and a waiter would stack another image build.
 * A lock whose recorded pid is dead is removed and the acquire is retried.
 * A lock whose pid is alive but whose age exceeds 60 minutes is stale: it is
 * removed with a one-line notice and the acquire is retried. A full build
 * finishes well under that. A lock with no readable pid is treated as held,
 * so a mkdir that has not written its pid yet is not stolen. Remove
 * chaos/.cache/build.lock by hand only when no build is running and the pid
 * file is missing.
 */
export function acquireBuildLock(
  lockDir: string,
  pid: number,
  ops: LockOps,
  isAlive: (pid: number) => boolean,
  now: () => number = Date.now,
  notice: (line: string) => void = log,
): void {
  const pidPath = join(lockDir, 'pid');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      ops.mkdir(lockDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const meta = lockMeta(ops, pidPath);
      const ageMs = meta?.createdAt === null || meta === null ? null : now() - meta.createdAt;
      const stale = ageMs !== null && ageMs > BUILD_LOCK_STALE_MS;
      if (meta !== null && (!isAlive(meta.pid) || stale)) {
        if (stale && isAlive(meta.pid)) {
          notice(`reclaiming stale lock at ${lockDir} (pid ${meta.pid} alive, age exceeds 60 minutes)`);
        }
        ops.rm(lockDir);
        continue;
      }
      const who = meta === null ? 'no readable pid' : `pid ${meta.pid}`;
      throw new BuildExit(`chaos build already running (${who}) at ${lockDir}; a second build exits 3 instead of waiting`);
    }
    try {
      ops.writeFile(pidPath, `${pid}\n${now()}\n`);
      return;
    } catch (err) {
      ops.rm(lockDir);
      throw err;
    }
  }
  throw new BuildExit(`could not acquire ${lockDir}; exit 3`);
}

/** Removes the lock only when `pid` still owns it. */
export function releaseBuildLock(lockDir: string, pid: number, ops: LockOps): void {
  if (lockMeta(ops, join(lockDir, 'pid'))?.pid !== pid) return;
  ops.rm(lockDir);
}

async function dockerBuild(args: string[]): Promise<void> {
  // --progress=plain (not -q) so a second unchanged build shows CACHED layers.
  // stdout is not echoed by mustRun; keep it visible when BuildKit writes there.
  const out = await mustRun('docker', ['build', '--progress=plain', ...args], { echo: true });
  if (out.trim()) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
}

export async function build(imageArg: string | null, checkRepro = false): Promise<BuildInfo> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const lockDir = join(CACHE_DIR, 'build.lock');
  acquireBuildLock(lockDir, process.pid, defaultLockOps, pidAlive);
  try {
    return await runBuild(imageArg, checkRepro);
  } finally {
    releaseBuildLock(lockDir, process.pid, defaultLockOps);
  }
}

async function runBuild(imageArg: string | null, checkRepro: boolean): Promise<BuildInfo> {
  const deps = defaultFingerprintDeps();
  const inputs = await collectSourceInputs(deps);
  const fp = await computeSourceFingerprint(deps, inputs);
  // Same `inputs` the fingerprint just hashed. Custom --image still stages this list;
  // pack() mounts only the chaos-side paths, and the published id stays custom-image:<imageId>.
  const stageDir = join(CACHE_DIR, 'context');
  stageSourceTree(stageDir, inputs);
  const qemuCtx = join(stageDir, 'chaos/qemu');

  log(`qemu container ${QEMU_IMAGE} (native arch)`);
  await dockerBuild(['-t', QEMU_IMAGE, '-f', join(qemuCtx, 'qemu.Dockerfile'), qemuCtx]);

  log('guest kernel (linux/amd64)');
  const kdir = join(CACHE_DIR, 'kernel');
  await dockerBuild(['--platform', 'linux/amd64', '-f', join(qemuCtx, 'kernel.Dockerfile'),
    '--output', `type=local,dest=${kdir}`, qemuCtx]);
  copyFileSync(join(kdir, 'vmlinuz'), join(CACHE_DIR, 'vmlinuz'));
  const kernelVersion = readFileSync(join(kdir, 'kernel-version'), 'utf8').trim();

  let image = imageArg;
  if (image === null) {
    log(`box container ${DEFAULT_BOX_IMAGE} (linux/amd64)`);
    await dockerBuild(['--platform', 'linux/amd64', '-t', DEFAULT_BOX_IMAGE,
      '-f', join(stageDir, 'chaos/box/Dockerfile'), stageDir]);
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
  await pack(image, initrd, fpFile, stageDir);
  if (checkRepro) {
    const second = join(CACHE_DIR, 'initramfs.repro-check.cpio.gz');
    await pack(image, second, fpFile, stageDir);
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
  const tmpBuildInfo = `${BUILD_INFO}.tmp`;
  writeFileSync(tmpBuildInfo, JSON.stringify(info, null, 2) + '\n');
  renameSync(tmpBuildInfo, BUILD_INFO);
  return info;
}

export function readBuildInfo(): BuildInfo | null {
  try { return JSON.parse(readFileSync(BUILD_INFO, 'utf8')) as BuildInfo; } catch { return null; }
}
