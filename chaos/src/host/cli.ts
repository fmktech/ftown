// Host runner: `npm run test:chaos -- <command>`. See USAGE in args.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../contract.ts';
import { parseArgs, USAGE, UsageError, type Command, type VmOptions } from './args.ts';
import { build, readBuildInfo } from './build.ts';
import { boot, qemuArgs, type GuestParams } from './qemu.ts';
import { OUT_DIR } from './paths.ts';
import { differingKeys, formatSeedLine, normalizeConsole, sha256, summarizeSeed, worstExit, type BootResult, type SeedSummary } from './summary.ts';

/** Runs tasks with at most `jobs` in flight; results keep input order. */
async function pool<T>(jobs: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  return results;
}

function requireBuild(): void {
  const info = readBuildInfo();
  if (info === null) throw new UsageError('no build found: run `npm run test:chaos -- build` first');
  console.log(`image ${info.image}  kernel ${info.kernelVersion}  initramfs sha256 ${info.initramfsSha256} (${info.initramfsBytes} bytes)`);
}

function params(cmd: GuestParams['cmd'], seed: number, level: GuestParams['level'], vm: VmOptions): GuestParams {
  return { cmd, seed, level, memMb: vm.memMb, icountShift: vm.icountShift };
}

async function selftest(times: number, vm: VmOptions): Promise<number> {
  requireBuild();
  console.log(`qemu: ${qemuArgs(params('selftest', 0, 'off', vm)).join(' ')}`);
  const root = join(OUT_DIR, 'selftest');
  const boots = await pool(vm.jobs, Array.from({ length: times }, (_, k) => async () => {
    const dir = join(root, `run${k + 1}`);
    const o = await boot(params('selftest', 0, 'off', vm), dir, vm.timeoutSec);
    console.log(`boot ${k + 1}: ${(o.wallMs / 1000).toFixed(1)}s exit=${o.exitCode}${o.infraError ? ` INFRA: ${o.infraError}` : ''}`);
    return { o, dir };
  }));
  if (boots.some((b) => b.o.infraError !== null || b.o.exitCode !== EXIT.ok || !b.o.files.has('selftest.json'))) {
    console.log('selftest: infra error (see out/selftest/run*/console.log)');
    return EXIT.infra;
  }
  const jsons = boots.map((b) => b.o.files.get('selftest.json')!.toString('utf8'));
  const consoles = boots.map((b) => readFileSync(join(b.dir, 'console.log'), 'latin1'));
  jsons.forEach((j, k) => console.log(`run${k + 1} selftest.json sha256 ${sha256(j)}`));
  console.log(`selftest.json: ${jsons[0].trim()}`);
  let code: number = EXIT.ok;
  for (let k = 1; k < times; k++) {
    if (jsons[k] !== jsons[0]) {
      console.log(`NONDETERMINISM run1 vs run${k + 1}: keys ${differingKeys(JSON.parse(jsons[0]), JSON.parse(jsons[k])).join(', ')}`);
      code = EXIT.nondeterminism;
    }
    const rawSame = consoles[k] === consoles[0];
    if (normalizeConsole(consoles[k]) !== normalizeConsole(consoles[0])) {
      console.log(`NONDETERMINISM console run1 vs run${k + 1} differs`);
      code = EXIT.nondeterminism;
    } else console.log(`console run${k + 1}: ${rawSame ? 'byte-identical' : 'identical modulo printk timestamps'} to run1`);
  }
  const rep = JSON.parse(jsons[0]) as { hasNetworkInterfaceOtherThanLo: boolean; cpuHasRdrand: boolean; cpuHasRdseed: boolean };
  for (const k of ['hasNetworkInterfaceOtherThanLo', 'cpuHasRdrand', 'cpuHasRdseed'] as const) {
    if (rep[k] !== false) { console.log(`selftest: ${k} must be false`); code = worstExit([code, EXIT.infra]); }
  }
  console.log(code === EXIT.ok ? `selftest: ${times} boots byte-identical` : `selftest: exit ${code}`);
  return code;
}

async function runSeeds(c: Extract<Command, { cmd: 'run' | 'campaign' }>): Promise<number> {
  requireBuild();
  mkdirSync(OUT_DIR, { recursive: true });
  const tasks = c.seeds.flatMap((seed) => Array.from({ length: c.times }, (_, k) => ({ seed, k })));
  const results = await pool(c.vm.jobs, tasks.map(({ seed, k }) => async (): Promise<BootResult> => {
    const o = await boot(params('run', seed, c.level, c.vm), join(OUT_DIR, String(seed), `run${k + 1}`), c.vm.timeoutSec);
    const canon = o.files.get('canon.jsonl');
    if (o.infraError === null && canon === undefined) {
      return { exitCode: EXIT.infra, infraError: 'guest sent no canon.jsonl', hash: null, content: null, wallMs: o.wallMs };
    }
    return { exitCode: o.exitCode, infraError: o.infraError, hash: canon ? sha256(canon) : null, content: canon ? canon.toString('utf8') : null, wallMs: o.wallMs };
  }));
  const summaries: SeedSummary[] = c.seeds.map((seed, i) => summarizeSeed(seed, results.slice(i * c.times, (i + 1) * c.times)));
  for (const s of summaries) {
    console.log(formatSeedLine(s));
    if (s.nondeterminism !== null) console.log(`  ${s.nondeterminism}`);
  }
  const exit = worstExit(summaries.map((s) => s.exitCode));
  if (c.cmd === 'campaign') {
    writeFileSync(join(OUT_DIR, 'campaign.json'), JSON.stringify({ level: c.level, times: c.times, exit, seeds: summaries }, null, 2) + '\n');
    console.log(`wrote ${join(OUT_DIR, 'campaign.json')}`);
  }
  return exit;
}

async function main(argv: string[]): Promise<number> {
  let c: Command;
  try { c = parseArgs(argv); } catch (err) {
    if (err instanceof UsageError) { console.error(`${err.message}\n${USAGE}`); return EXIT.infra; }
    throw err;
  }
  switch (c.cmd) {
    case 'help': console.log(USAGE); return EXIT.ok;
    case 'build': {
      const info = await build(c.image);
      console.log(JSON.stringify(info, null, 2));
      return EXIT.ok;
    }
    case 'selftest': return selftest(c.times, c.vm);
    case 'run':
    case 'campaign': return runSeeds(c);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = EXIT.infra;
}
