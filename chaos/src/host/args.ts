// Command-line parsing for `npm run test:chaos -- …`. Pure.
import type { ChaosLevel } from '../contract.ts';

export interface VmOptions {
  /** Guest RAM in MiB. */
  memMb: number;
  /** -icount shift (ns per instruction = 2^shift). */
  icountShift: number;
  /** Host wall-clock watchdog per boot, seconds. */
  timeoutSec: number;
  /** Concurrent VMs; null = default (2, capped by Docker memory). */
  jobs: number | null;
}

export type Command =
  | { cmd: 'help' }
  | { cmd: 'build'; image: string | null }
  | { cmd: 'selftest'; times: number; vm: VmOptions }
  | { cmd: 'run' | 'campaign'; seeds: number[]; level: ChaosLevel; times: number; vm: VmOptions };

export class UsageError extends Error {}

export const USAGE = `usage: npm run test:chaos -- <command> [flags]
  build [--image <tag>]                         build kernel, initramfs and qemu container into chaos/.cache/
  selftest [--times 2]                          boot N times, require byte-identical selftest.json
  run --seeds 1-4 [--level high] [--times 2]    run seeds, compare runs of each seed
  repro --seed N [--times 5] [--level high]     (also: --repro N) one seed, several times
  campaign --seeds 1-20 [--times 2]             run + chaos/out/campaign.json
common: --jobs N (default 2, capped by Docker memory)  --mem 3072 (selftest 1536)  --timeout <s>  --icount-shift 1`;

/** Parses "1-4", "7", "1,3,5-7". Result sorted and unique. */
export function parseSeedRange(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new UsageError(`bad seed range: ${JSON.stringify(spec)}`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi < lo) throw new UsageError(`bad seed range: ${JSON.stringify(spec)}`);
    if (hi - lo > 100_000) throw new UsageError(`seed range too large: ${spec}`);
    for (let s = lo; s <= hi; s++) out.add(s);
  }
  return [...out].sort((a, b) => a - b);
}

const VALUE_FLAGS = new Set(['image', 'times', 'seeds', 'seed', 'repro', 'level', 'jobs', 'mem', 'timeout', 'icount-shift']);

function posInt(flag: string, v: string, min = 1): number {
  if (!/^\d+$/.test(v) || Number(v) < min) throw new UsageError(`--${flag} needs an integer >= ${min}, got ${JSON.stringify(v)}`);
  return Number(v);
}

export function parseArgs(argv: readonly string[]): Command {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { cmd: 'help' };
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown flag --${name}`);
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      if (flags.has(name)) throw new UsageError(`--${name} given twice`);
      flags.set(name, value);
    } else positional.push(a);
  }
  let sub = positional.shift();
  if (positional.length > 0) throw new UsageError(`unexpected argument ${positional[0]}`);
  if (sub === undefined && flags.has('repro')) sub = 'repro';
  if (sub === undefined || sub === 'help') return { cmd: 'help' };

  const allowed: Record<string, string[]> = {
    build: ['image'],
    selftest: ['times', 'jobs', 'mem', 'timeout', 'icount-shift'],
    run: ['seeds', 'level', 'times', 'jobs', 'mem', 'timeout', 'icount-shift'],
    campaign: ['seeds', 'level', 'times', 'jobs', 'mem', 'timeout', 'icount-shift'],
    repro: ['seed', 'repro', 'level', 'times', 'jobs', 'mem', 'timeout', 'icount-shift'],
  };
  const ok = allowed[sub];
  if (ok === undefined) throw new UsageError(`unknown command ${sub}`);
  for (const f of flags.keys()) if (!ok.includes(f)) throw new UsageError(`--${f} is not valid for ${sub}`);

  if (sub === 'build') return { cmd: 'build', image: flags.get('image') ?? null };

  const isSelftest = sub === 'selftest';
  const vm: VmOptions = {
    memMb: flags.has('mem') ? posInt('mem', flags.get('mem')!, 1536) : isSelftest ? 1536 : 3072,
    icountShift: flags.has('icount-shift') ? posInt('icount-shift', flags.get('icount-shift')!, 0) : 1,
    timeoutSec: flags.has('timeout') ? posInt('timeout', flags.get('timeout')!) : isSelftest ? 900 : 3600,
    jobs: flags.has('jobs') ? posInt('jobs', flags.get('jobs')!) : null,
  };
  if (vm.icountShift > 10) throw new UsageError('--icount-shift must be 0..10');
  const defaultTimes = sub === 'repro' ? 5 : 2;
  const times = flags.has('times') ? posInt('times', flags.get('times')!) : defaultTimes;
  if (isSelftest) return { cmd: 'selftest', times, vm };

  const levelRaw = flags.get('level') ?? 'high';
  if (levelRaw !== 'off' && levelRaw !== 'low' && levelRaw !== 'high') throw new UsageError(`bad --level ${levelRaw}`);
  const level: ChaosLevel = levelRaw;

  let seeds: number[];
  if (sub === 'repro') {
    if (flags.has('seed') && flags.has('repro')) throw new UsageError('give --seed or --repro, not both');
    const s = flags.get('seed') ?? flags.get('repro');
    if (s === undefined) throw new UsageError('repro needs --seed N');
    seeds = [posInt('seed', s, 0)];
    return { cmd: 'run', seeds, level, times, vm };
  }
  const spec = flags.get('seeds');
  if (spec === undefined) throw new UsageError(`${sub} needs --seeds`);
  seeds = parseSeedRange(spec);
  return { cmd: sub === 'campaign' ? 'campaign' : 'run', seeds, level, times, vm };
}

/** Default concurrency: 2, but only as many VMs as fit in Docker's memory (guest RAM + 512 MiB each, 80% of total). Pure. */
export function defaultJobs(dockerMemBytes: number, memMb: number): number {
  const perVm = (memMb + 512) * 1024 * 1024;
  return Math.max(1, Math.min(2, Math.floor((dockerMemBytes * 0.8) / perVm)));
}
