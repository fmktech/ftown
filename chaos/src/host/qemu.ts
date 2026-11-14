// Boots the guest once under QEMU (inside the qemu container) and collects its outputs.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, type ChaosLevel } from '../contract.ts';
import { FrameError, parseFrames } from './frames.ts';
import { consoleFailure } from './summary.ts';
import { CACHE_DIR, QEMU_IMAGE } from './paths.ts';
import { run } from './proc.ts';

export interface GuestParams {
  cmd: 'selftest' | 'run';
  seed: number;
  level: ChaosLevel;
  memMb: number;
  icountShift: number;
}

export const RTC_BASE = '2026-01-01T00:00:00';

/** The full qemu-system-x86_64 argument vector. Paths are inside the container. Pure. */
export function qemuArgs(p: GuestParams): string[] {
  const append = [
    'console=ttyS0', 'panic=-1', 'oops=panic', 'random.trust_cpu=off', 'random.trust_bootloader=off',
    'nokaslr', 'norandmaps', 'tsc=reliable', 'clocksource=tsc', 'no_timer_check', 'mitigations=off',
    'quiet', 'loglevel=4', 'rdinit=/init',
    `chaos.cmd=${p.cmd}`, `chaos.seed=${p.seed}`, `chaos.level=${p.level}`,
  ].join(' ');
  return [
    'qemu-system-x86_64',
    '-machine', 'q35',
    '-accel', 'tcg,thread=single',
    '-smp', '1',
    '-m', `${p.memMb}M`,
    '-cpu', 'Nehalem,-rdrand,-rdseed',
    '-icount', `shift=${p.icountShift},sleep=off,align=off`,
    '-rtc', `base=${RTC_BASE},clock=vm`,
    '-nic', 'none',
    '-nodefaults',
    '-no-reboot',
    '-display', 'none',
    '-serial', 'file:/out/console.log',
    '-serial', 'file:/out/frames.txt',
    '-kernel', '/in/vmlinuz',
    '-initrd', '/in/initramfs.cpio.gz',
    '-append', append,
  ];
}

export interface BootOutcome {
  /** Guest exit code from CHAOS-EXIT, or EXIT.infra. */
  exitCode: number;
  infraError: string | null;
  files: Map<string, Buffer>;
  wallMs: number;
}

let counter = 0;
/** Containers started by this process and not yet removed. */
const live = new Set<string>();

/** Kills and removes every container this process started (SIGINT/SIGTERM path). */
export async function cleanupContainers(): Promise<void> {
  await Promise.all([...live].map((n) => run('docker', ['rm', '-f', n])));
  live.clear();
}

/** Boots once. Writes console.log, frames.txt and every received file into outDir. */
export async function boot(p: GuestParams, outDir: string, timeoutSec: number): Promise<BootOutcome> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const name = `ftown-chaos-${process.pid}-${++counter}-${randomBytes(4).toString('hex')}`;
  live.add(name);
  // Outputs stay inside the container and are fetched with `docker cp` after it exits:
  // a bind-mounted /out is not guaranteed to be visible on the host (Docker Desktop file
  // sharing) at the moment the container exits.
  const dockerArgs = [
    'run', '--name', name, '--network', 'none', '-v', `${CACHE_DIR}:/in:ro`,
    QEMU_IMAGE, 'sh', '-c', 'mkdir -p /out && : > /out/console.log && : > /out/frames.txt && exec "$@"', 'sh', ...qemuArgs(p),
  ];
  const started = performance.now();
  let timedOut = false;
  let killing: Promise<unknown> = Promise.resolve();
  const watchdog = setTimeout(() => {
    timedOut = true;
    killing = run('docker', ['kill', name]);
  }, timeoutSec * 1000);
  let r;
  let oom = false;
  let copied;
  try {
    r = await run('docker', dockerArgs);
    clearTimeout(watchdog);
    await killing;
    oom = (await run('docker', ['inspect', '-f', '{{.State.OOMKilled}}', name])).stdout.trim() === 'true';
    copied = await run('docker', ['cp', `${name}:/out/.`, outDir]);
  } finally {
    clearTimeout(watchdog);
    await killing;
    await run('docker', ['rm', '-f', name]);
    live.delete(name);
  }
  const wallMs = performance.now() - started;
  const infra = (msg: string): BootOutcome => ({ exitCode: EXIT.infra, infraError: msg, files: new Map(), wallMs });
  if (timedOut) return infra(`watchdog: no poweroff within ${timeoutSec}s (host wall clock)`);
  if (oom) return infra('qemu container was OOM-killed: lower --jobs or --mem, or give Docker more memory');
  if (r.code !== 0) return infra(`qemu container exited ${r.code}: ${r.stderr.trim().slice(-500)}`);
  if (copied.code !== 0) return infra(`docker cp of guest outputs failed: ${copied.stderr.trim()}`);
  try {
    const parsed = parseFrames(readFileSync(join(outDir, 'frames.txt'), 'latin1'));
    for (const [file, data] of parsed.files) writeFileSync(join(outDir, file), data);
    return { exitCode: parsed.exitCode, infraError: null, files: parsed.files, wallMs };
  } catch (err) {
    if (err instanceof FrameError) {
      let cons = '';
      try { cons = readFileSync(join(outDir, 'console.log'), 'latin1'); } catch { cons = ''; }
      const why = consoleFailure(cons);
      return infra(why !== null ? `guest: ${why}` : `frames: ${err.message}`);
    }
    throw err;
  }
}
