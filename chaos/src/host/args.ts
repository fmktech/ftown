// Command-line parsing for `npm run test:chaos -- …`. Pure.
import type { ChaosLevel } from '../contract.ts';
import { parseSeeds } from '../core/seeds.ts';

export interface VmOptions {
  /** Guest RAM in MiB. */
  memMb: number;
  /** -icount shift (ns per instruction = 2^shift). */
  icountShift: number;
  /** Host wall-clock watchdog per boot, seconds. */
  timeoutSec: number;
  /** Concurrent VMs. */
  jobs: number;
}

export type Command =
  | { cmd: 'help' }
  | { cmd: 'build'; image: string | null; checkRepro: boolean }
  | { cmd: 'selftest'; times: number; vm: VmOptions; longSeconds: number | null }
  | { cmd: 'run' | 'campaign'; seeds: number[]; level: ChaosLevel; times: number; vm: VmOptions };

export class UsageError extends Error {}

export const USAGE = `usage: npm run test:chaos -- <command> [flags]
  build [--image <tag>] [--check-repro]         build kernel, initramfs and qemu container into chaos/.cache/
  selftest [--times 2] [--long <guest s>]       boot N times, require byte-identical selftest.json (--long: long probe)
  run --seeds 1-4 [--level high] [--times 2]    run seeds, compare runs of each seed
  repro --seed N [--times 5] [--level high]     (also: --repro N) one seed, several times
  campaign --seeds 1-20 [--times 2]             run + chaos/out/campaign.json
common: --jobs 1  --mem 3072 (selftest 1536)  --timeout <s>  --icount-shift 1`;

/** Seed list per core/seeds.ts (e.g. "1-3,2,7"); its errors become usage errors (exit 64). */
export function parseSeedRange(spec: string): number[] {
  try { return parseSeeds(spec); } catch (err) {
    throw new UsageError(`bad seed list ${JSON.stringify(spec)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const BOOL_FLAGS = new Set(['check-repro']);
const VALUE_FLAGS = new Set(['long', 'image', 'times', 'seeds', 'seed', 'repro', 'level', 'jobs', 'mem', 'timeout', 'icount-shift']);

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
      if (BOOL_FLAGS.has(name) && eq === -1) {
        if (flags.has(name)) throw new UsageError(`--${name} given twice`);
        flags.set(name, 'true');
        continue;
      }
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
    build: ['image', 'check-repro'],
    selftest: ['long', 'times', 'jobs', 'mem', 'timeout', 'icount-shift'],
    run: ['seeds', 'level', 'times', 'jobs', 'mem', 'timeout', 'icount-shift'],
    campaign: ['seeds', 'level', 'times', 'jobs', 'mem', 'timeout', 'icount-shift'],
    repro: ['seed', 'repro', 'level', 'times', 'jobs', 'mem', 'timeout', 'icount-shift'],
  };
  const ok = allowed[sub];
  if (ok === undefined) throw new UsageError(`unknown command ${sub}`);
  for (const f of flags.keys()) if (!ok.includes(f)) throw new UsageError(`--${f} is not valid for ${sub}`);

  if (sub === 'build') return { cmd: 'build', image: flags.get('image') ?? null, checkRepro: flags.has('check-repro') };

  const isSelftest = sub === 'selftest';
  const vm: VmOptions = {
    memMb: flags.has('mem') ? posInt('mem', flags.get('mem')!, 1536) : isSelftest ? 1536 : 3072,
    icountShift: flags.has('icount-shift') ? posInt('icount-shift', flags.get('icount-shift')!, 0) : 1,
    timeoutSec: flags.has('timeout') ? posInt('timeout', flags.get('timeout')!) : isSelftest && !flags.has('long') ? 300 : 3600,
    jobs: flags.has('jobs') ? posInt('jobs', flags.get('jobs')!) : 1,
  };
  if (vm.icountShift > 10) throw new UsageError('--icount-shift must be 0..10');
  const defaultTimes = sub === 'repro' ? 5 : 2;
  const times = flags.has('times') ? posInt('times', flags.get('times')!) : defaultTimes;
  if (isSelftest) return { cmd: 'selftest', times, vm, longSeconds: flags.has('long') ? posInt('long', flags.get('long')!) : null };

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

