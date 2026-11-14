// Builds chaos/.cache/: vmlinuz, initramfs.cpio.gz, build.json, and the qemu container image.
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_INFO, CACHE_DIR, CHAOS_DIR, DEFAULT_BOX_IMAGE, DEVBOX_IMAGE, QEMU_DIR, QEMU_IMAGE } from './paths.ts';
import { mustRun, run } from './proc.ts';
import { sha256 } from './summary.ts';

export interface BuildInfo {
  image: string;
  imageId: string;
  kernelVersion: string;
  vmlinuzSha256: string;
  initramfsSha256: string;
  initramfsBytes: number;
  qemuImageId: string;
  qemuVersion: string;
}

const log = (msg: string) => process.stderr.write(`build: ${msg}\n`);

async function imageExists(tag: string): Promise<boolean> {
  return (await run('docker', ['image', 'inspect', tag])).code === 0;
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
  "find /r/opt/chaos/src -name '*.test.ts' -delete",
  'chown -R 0:0 /r/opt/chaos && chmod -R a+rX,go-w /r/opt/chaos',
  'find /r -exec touch -h -d @0 {} +',
  'cd /r',
  'find . -mindepth 1 -print0 | LC_ALL=C sort -z | cpio --null -o -H newc --reproducible --quiet | gzip -n -6',
].join('\n');

/** Packs `image` into a reproducible initramfs at dest. The archive comes back on stdout
 * (no bind-mounted output: Docker Desktop file sharing may lag behind container exit). */
async function pack(image: string, dest: string): Promise<void> {
  const cid = (await mustRun('docker', ['create', '--platform', 'linux/amd64', image, '/init'])).trim();
  const tmp = `${dest}.tmp`;
  try {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const pipeline = `docker export ${q(cid)} | docker run -i --rm --network none ` +
      `-v ${q(join(QEMU_DIR, 'init'))}:/init.sh:ro -v ${q(join(CHAOS_DIR, 'src'))}:/chaos/src:ro ` +
      `-v ${q(join(CHAOS_DIR, 'package.json'))}:/chaos/package.json:ro ${q(QEMU_IMAGE)} sh -c ${q(PACK_SCRIPT)} > ${q(tmp)}`;
    await mustRun('bash', ['-o', 'pipefail', '-c', pipeline], { echo: true });
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
    await run('docker', ['rm', '-f', cid]);
  }
}

export async function build(imageArg: string | null, checkRepro = false): Promise<BuildInfo> {
  mkdirSync(CACHE_DIR, { recursive: true });

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
    if (await imageExists(DEFAULT_BOX_IMAGE)) image = DEFAULT_BOX_IMAGE;
    else {
      log(`${DEFAULT_BOX_IMAGE} not found; building the dev box ${DEVBOX_IMAGE}`);
      await mustRun('docker', ['build', '-q', '--platform', 'linux/amd64', '-t', DEVBOX_IMAGE,
        '-f', join(QEMU_DIR, 'devbox.Dockerfile'), CHAOS_DIR], { echo: true });
      image = DEVBOX_IMAGE;
    }
  }
  const imageId = (await mustRun('docker', ['image', 'inspect', '-f', '{{.Id}}', image])).trim();
  log(`initramfs from ${image} (${imageId})`);
  const initrd = join(CACHE_DIR, 'initramfs.cpio.gz');
  await pack(image, initrd);
  if (checkRepro) {
    const second = join(CACHE_DIR, 'initramfs.repro-check.cpio.gz');
    await pack(image, second);
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
  };
  writeFileSync(BUILD_INFO, JSON.stringify(info, null, 2) + '\n');
  return info;
}

export function readBuildInfo(): BuildInfo | null {
  try { return JSON.parse(readFileSync(BUILD_INFO, 'utf8')) as BuildInfo; } catch { return null; }
}
