// Command-line parsing for `npm run test:chaos -- …`. Pure.
import { DEFAULT_PROFILE, RUN_PROFILES, type ChaosLevel, type RunProfile } from '../contract.ts';
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
  | { cmd: 'selftest'; times: number; vm: VmOptions; longSeconds: number | null; noBuild: boolean }
  | { cmd: 'run' | 'campaign'; seeds: number[]; level: ChaosLevel; profile: RunProfile; times: number; vm: VmOptions; dropFaults: string | null; noBuild: boolean };

export class UsageError extends Error {}

export const USAGE = `usage: npm run test:chaos -- <command> [flags]
  build [--image <tag>] [--check-repro]         build kernel, initramfs and qemu container into chaos/.cache/
  selftest [--times 2] [--long <guest s>]       boot N times, require byte-identical selftest.json (--long: long probe)
  run --seeds 1-4 [--profile short|soak] [--level low] [--times 2]    run seeds, compare runs of each seed
  repro --seed N [--profile short|soak] [--times 5] [--level low]     (also: --repro N) one seed, several times
  run/repro: --drop-faults f2,f4|<kind>         guest skips these faults; output in out/<seed>-<profile>[-drop-<list>]/
  campaign --seeds 1-20 [--profile short|soak] [--times 2]            run + chaos/out/campaign.json
common: --jobs 1  --mem 3072 (selftest 1536)  --timeout <s> (short 2000, soak 3000)  --icount-shift 1  --no-build`;

/** Seed list per core/seeds.ts (e.g. "1-3,2,7"); its errors become usage errors (exit 64). */
export function parseSeedRange(spec: string): number[] {
  try { return parseSeeds(spec); } catch (err) {
    throw new UsageError(`bad seed list ${JSON.stringify(spec)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const BOOL_FLAGS = new Set(['check-repro', 'no-build']);
const VALUE_FLAGS = new Set(['drop-faults', 'long', 'image', 'times', 'seeds', 'seed', 'repro', 'level', 'profile', 'jobs', 'mem', 'timeout', 'icount-shift']);

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
    selftest: ['long', 'times', 'jobs', 'mem', 'timeout', 'icount-shift', 'no-build'],
    run: ['drop-faults', 'seeds', 'level', 'profile', 'times', 'jobs', 'mem', 'timeout', 'icount-shift', 'no-build'],
    campaign: ['seeds', 'level', 'profile', 'times', 'jobs', 'mem', 'timeout', 'icount-shift', 'no-build'],
    repro: ['drop-faults', 'seed', 'repro', 'level', 'profile', 'times', 'jobs', 'mem', 'timeout', 'icount-shift', 'no-build'],
  };
  const ok = allowed[sub];
  if (ok === undefined) throw new UsageError(`unknown command ${sub}`);
  for (const f of flags.keys()) if (!ok.includes(f)) throw new UsageError(`--${f} is not valid for ${sub}`);

  if (sub === 'build') return { cmd: 'build', image: flags.get('image') ?? null, checkRepro: flags.has('check-repro') };

  const isSelftest = sub === 'selftest';
  const profileRaw = flags.get('profile') ?? DEFAULT_PROFILE;
  if (!RUN_PROFILES.includes(profileRaw as RunProfile)) throw new UsageError(`bad --profile ${profileRaw}`);
  const profile = profileRaw as RunProfile;
  const defaultTimeout = isSelftest ? (!flags.has('long') ? 300 : 3600) : profile === 'soak' ? 3000 : 2000;
  const vm: VmOptions = {
    memMb: flags.has('mem') ? posInt('mem', flags.get('mem')!, 1536) : isSelftest ? 1536 : 3072,
    icountShift: flags.has('icount-shift') ? posInt('icount-shift', flags.get('icount-shift')!, 0) : 1,
    timeoutSec: flags.has('timeout') ? posInt('timeout', flags.get('timeout')!) : defaultTimeout,
    jobs: flags.has('jobs') ? posInt('jobs', flags.get('jobs')!) : 1,
  };
  if (vm.icountShift > 10) throw new UsageError('--icount-shift must be 0..10');
  const noBuild = flags.has('no-build');
  const defaultTimes = sub === 'repro' ? 5 : 2;
  const times = flags.has('times') ? posInt('times', flags.get('times')!) : defaultTimes;
  if (isSelftest) return { cmd: 'selftest', times, vm, longSeconds: flags.has('long') ? posInt('long', flags.get('long')!) : null, noBuild };

  const levelRaw = flags.get('level') ?? (profile === 'short' ? 'low' : 'high');
  if (levelRaw !== 'off' && levelRaw !== 'low' && levelRaw !== 'high') throw new UsageError(`bad --level ${levelRaw}`);
  const level: ChaosLevel = levelRaw;
  if (profile === 'short' && level === 'high') {
    throw new UsageError('--level high is not valid with --profile short; use --profile soak');
  }

  const dropFaults = flags.get('drop-faults') ?? null;
  if (dropFaults !== null && !/^[a-z0-9_]+(,[a-z0-9_]+)*$/.test(dropFaults)) {
    throw new UsageError(`bad --drop-faults ${JSON.stringify(dropFaults)}: comma-separated [a-z0-9_] names`);
  }
  let seeds: number[];
  if (sub === 'repro') {
    if (flags.has('seed') && flags.has('repro')) throw new UsageError('give --seed or --repro, not both');
    const s = flags.get('seed') ?? flags.get('repro');
    if (s === undefined) throw new UsageError('repro needs --seed N');
    seeds = [posInt('seed', s, 0)];
    return { cmd: 'run', seeds, level, profile, times, vm, dropFaults, noBuild };
  }
  const spec = flags.get('seeds');
  if (spec === undefined) throw new UsageError(`${sub} needs --seeds`);
  seeds = parseSeedRange(spec);
  return { cmd: sub === 'campaign' ? 'campaign' : 'run', seeds, level, profile, times, vm, dropFaults, noBuild };
}

