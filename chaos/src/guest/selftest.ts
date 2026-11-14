// Guest selftest: samples every source of nondeterminism we know of. The host boots twice and
// requires byte-identical output. This file deliberately reads host-meaningful time and randomness.
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { SelftestReport } from '../contract.ts';

function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

/** Interface names from /proc/net/dev other than lo exist. Pure on its input. */
export function hasNonLoInterface(procNetDev: string, sysClassNet: readonly string[]): boolean {
  const fromProc = procNetDev.split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter((n) => n !== '');
  return [...fromProc, ...sysClassNet].some((n) => n !== 'lo');
}

/** Whether /proc/cpuinfo flags list the given flag. Pure. */
export function cpuHasFlag(cpuinfo: string, flag: string): boolean {
  return cpuinfo.split('\n').some((l) => /^flags\s*:/.test(l) && l.split(':')[1].trim().split(/\s+/).includes(flag));
}

/** Fixed shuffle of 0..49 (a constant LCG, independent of any runtime source). */
export function fixedShuffle(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  let s = 12345;
  for (let i = n - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSelftest(): Promise<SelftestReport> {
  const wallClockAtStart = new Date().toISOString();
  let sysNet: string[] = [];
  try { sysNet = readdirSync('/sys/class/net').sort(); } catch { sysNet = []; }
  const cpuinfo = read('/proc/cpuinfo');
  const timingProbe: number[] = [];
  for (let step = 0; step < 20; step++) {
    await sleep(1);
    let x = 0;
    for (let i = 0; i < 10_000; i++) x = (x + i * 7) % 1_000_003;
    if (x < 0) throw new Error('unreachable');
    spawnSync('/bin/true');
    timingProbe.push(Math.round(performance.now() * 1000) / 1000);
  }
  const dir = '/tmp/chaos-readdir';
  mkdirSync(dir, { recursive: true });
  for (const n of fixedShuffle(50)) writeFileSync(`${dir}/${n}`, '');
  return {
    hasNetworkInterfaceOtherThanLo: hasNonLoInterface(read('/proc/net/dev'), sysNet),
    cpuHasRdrand: cpuHasFlag(cpuinfo, 'rdrand'),
    cpuHasRdseed: cpuHasFlag(cpuinfo, 'rdseed'),
    clocksource: read('/sys/devices/system/clocksource/clocksource0/current_clocksource').trim(),
    wallClockAtStart,
    bootId: read('/proc/sys/kernel/random/boot_id').trim(),
    random32: randomBytes(32).toString('hex'),
    uuid: randomUUID(),
    timingProbe,
    readdirOrder: readdirSync(dir),
    nodeVersion: process.version,
  };
}

/**
 * Long determinism probe (bridge-free reproducer for run-length divergence). For `seconds` of
 * guest time it mixes CPU bursts, timers, process spawns (node startups, shell pipelines),
 * tmpfs writes, memory growth and steady console output, and logs process.hrtime at every step.
 * One JSON line per step: {"i":n,"step":"…","t":"<ns>"}. Two boots must give identical bytes.
 */
export async function runLongSelftest(seconds: number, log: (line: string) => void, scratchDir = '/tmp/chaos-long'): Promise<string> {
  const { spawn } = await import('node:child_process');
  const t0 = process.hrtime.bigint();
  const lines: string[] = [];
  const keep: Buffer[] = [];
  const mark = (i: number, step: string) => {
    const line = JSON.stringify({ i, step, t: String(process.hrtime.bigint() - t0) });
    lines.push(line);
    if (i % 10 === 0) log(`long-probe ${line}`);
  };
  const run = (cmd: string, args: string[]) => new Promise<void>((res) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout.on('data', () => {});
    c.on('close', () => res());
  });
  mkdirSync(scratchDir, { recursive: true });
  let s = 7;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648);
  for (let i = 0; process.hrtime.bigint() - t0 < BigInt(seconds) * 1_000_000_000n; i++) {
    const kind = next() % 11;
    if (kind === 0) { await run('node', ['-e', 'let x=0;for(let i=0;i<2e5;i++)x+=i;process.stdout.write(String(x))']); mark(i, 'node'); }
    else if (kind === 1) { await run('sh', ['-c', 'seq 1 2000 | sort -r | head -c 100000 | wc -c']); mark(i, 'pipe'); }
    else if (kind === 2) { await sleep(1 + (next() % 500)); mark(i, 'timer'); }
    else if (kind === 3) { writeFileSync(`${scratchDir}/f${i % 64}`, Buffer.alloc(256 * 1024, i % 256)); mark(i, 'write'); }
    else if (kind === 4) { let x = 0; for (let k = 0; k < 3e6; k++) x = (x + k * 13) % 1_000_003; mark(i, x < 0 ? 'x' : 'cpu'); }
    else if (kind === 5) { if (keep.length < 400) keep.push(Buffer.alloc(1024 * 1024, 1)); mark(i, 'mem'); }
    else if (kind === 6) { log(`long-probe burst ${'x'.repeat(2000)}`); mark(i, 'console'); }
    else { await sleep(200 + (next() % 2800)); mark(i, 'idle'); }
  }
  return lines.join('\n') + '\n';
}
