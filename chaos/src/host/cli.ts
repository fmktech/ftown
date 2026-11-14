// Host runner: `npm run test:chaos -- <command>`. See USAGE in args.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PROFILE, EXIT } from '../contract.ts';
import { parseArgs, USAGE, UsageError, type Command, type VmOptions } from './args.ts';
import { build, computeSourceFingerprint, inspectImageId, readBuildInfo, type BuildInfo, type SourceFingerprint } from './build.ts';
import { boot, cleanupContainers, qemuArgs, RTC_BASE, type GuestParams } from './qemu.ts';
import { OUT_DIR, seedOutDir } from './paths.ts';
import { selftestAssertions, differingKeys, formatSeedLine, normalizeConsole, sha256, summarizeSeed, worstExit, type BootResult, type SeedSummary } from './summary.ts';

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

export interface EnsureBuildDeps {
  readBuildInfo(): BuildInfo | null;
  computeFingerprint(): Promise<SourceFingerprint>;
  build(imageArg: string | null, checkRepro?: boolean): Promise<BuildInfo>;
  inspectImageId(image: string): Promise<string | null>;
  log(msg: string): void;
}

const defaultEnsureDeps: EnsureBuildDeps = {
  readBuildInfo,
  computeFingerprint: () => computeSourceFingerprint(),
  build,
  inspectImageId,
  log: (msg) => console.log(msg),
};

export async function ensureBuild(noBuild: boolean, deps: EnsureBuildDeps = defaultEnsureDeps): Promise<BuildInfo> {
  const cached = deps.readBuildInfo();
  const current = await deps.computeFingerprint();
  let info: BuildInfo;
  if (cached === null) {
    if (noBuild) throw new Error('no cached build: run `npm run test:chaos -- build` first');
    deps.log('no cached build: building');
    info = await deps.build(null);
  } else if (cached.sourceFingerprint.startsWith('custom-image:')) {
    const currentImageId = await deps.inspectImageId(cached.image);
    const chaosMatch = cached.chaosFingerprint === current.chaosSha256;
    const imageMatch = currentImageId !== null && currentImageId === cached.imageId;
    if (!chaosMatch || !imageMatch) {
      const cachedHex = (cached.chaosFingerprint || 'unknown').slice(0, 8);
      const currentHex = current.chaosSha256.slice(0, 8);
      if (noBuild) {
        throw new Error(`chaos build is stale (cached ${cachedHex} != current ${currentHex}): run \`npm run test:chaos -- build --image ${cached.image}\` first`);
      }
      deps.log(`chaos build is stale (cached ${cachedHex} != current ${currentHex}): rebuilding`);
      info = await deps.build(cached.image);
    } else {
      info = cached;
    }
  } else if (cached.sourceFingerprint !== current.sha256) {
    const cachedHex = (cached.sourceFingerprint || 'unknown').slice(0, 8);
    const currentHex = current.sha256.slice(0, 8);
    if (noBuild) {
      throw new Error(`chaos build is stale (cached ${cachedHex} != current ${currentHex}): run \`npm run test:chaos -- build\` first`);
    }
    deps.log(`chaos build is stale (cached ${cachedHex} != current ${currentHex}): rebuilding`);
    info = await deps.build(null);
  } else {
    info = cached;
  }
  deps.log(`image ${info.image}  kernel ${info.kernelVersion}  initramfs sha256 ${info.initramfsSha256} (${info.initramfsBytes} bytes)  source ${info.sourceFingerprint.slice(0, 12)}`);
  return info;
}

function params(
  cmd: GuestParams['cmd'],
  seed: number,
  level: GuestParams['level'],
  profile: GuestParams['profile'],
  vm: VmOptions,
  dropFaults: string | null = null,
): GuestParams {
  return { cmd, seed, level, profile, memMb: vm.memMb, icountShift: vm.icountShift, dropFaults };
}

async function selftest(times: number, vm: VmOptions, noBuild: boolean): Promise<number> {
  await ensureBuild(noBuild);
  console.log(`qemu: ${qemuArgs(params('selftest', 0, 'off', DEFAULT_PROFILE, vm)).join(' ')}`);
  const root = join(OUT_DIR, 'selftest');
  const boots = await pool(vm.jobs, Array.from({ length: times }, (_, k) => async () => {
    const dir = join(root, `run${k + 1}`);
    const o = await boot(params('selftest', 0, 'off', DEFAULT_PROFILE, vm), dir, vm.timeoutSec);
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
      code = EXIT.reproDiverged;
    }
    const rawSame = consoles[k] === consoles[0];
    if (normalizeConsole(consoles[k]) !== normalizeConsole(consoles[0])) {
      console.log(`NONDETERMINISM console run1 vs run${k + 1} differs`);
      code = EXIT.reproDiverged;
    } else console.log(`console run${k + 1}: ${rawSame ? 'byte-identical' : 'identical modulo printk timestamps'} to run1`);
  }
  for (const failed of selftestAssertions(JSON.parse(jsons[0]) as Record<string, unknown>, RTC_BASE.slice(0, 10))) {
    console.log(`selftest: ASSERTION FAILED: ${failed}`);
    code = worstExit([code, EXIT.infra]);
  }
  console.log(code === EXIT.ok ? `selftest: ${times} boots byte-identical` : `selftest: exit ${code}`);
  return code;
}

async function selftestLong(times: number, seconds: number, vm: VmOptions, noBuild: boolean): Promise<number> {
  await ensureBuild(noBuild);
  const p: GuestParams = { cmd: 'selftest-long', seed: seconds, level: 'off', profile: DEFAULT_PROFILE, memMb: vm.memMb, icountShift: vm.icountShift };
  console.log(`qemu: ${qemuArgs(p).join(' ')}`);
  const results = await pool(vm.jobs, Array.from({ length: times }, (_, k) => async (): Promise<BootResult> => {
    const o = await boot(p, join(OUT_DIR, 'selftest-long', `run${k + 1}`), vm.timeoutSec);
    const f = o.files.get('long.jsonl');
    console.log(`boot ${k + 1}: ${(o.wallMs / 1000).toFixed(1)}s exit=${o.exitCode}${o.infraError ? ` INFRA: ${o.infraError}` : ''}${f ? ` steps=${f.toString().split('\n').length - 1} sha256 ${sha256(f)}` : ''}`);
    if (o.infraError === null && f === undefined) return { exitCode: EXIT.infra, infraError: 'no long.jsonl', hash: null, content: null, wallMs: o.wallMs };
    return { exitCode: o.exitCode, infraError: o.infraError, hash: f ? sha256(f) : null, content: f ? f.toString('utf8') : null, wallMs: o.wallMs };
  }));
  const s = summarizeSeed(0, results);
  if (s.nondeterminism !== null) console.log(s.nondeterminism);
  console.log(s.exitCode === EXIT.ok ? `selftest --long: ${times} boots byte-identical` : `selftest --long: exit ${s.exitCode}${s.infraError ? ` ${s.infraError}` : ''}`);
  return s.exitCode;
}

async function runSeeds(c: Extract<Command, { cmd: 'run' | 'campaign' }>): Promise<number> {
  await ensureBuild(c.noBuild);
  mkdirSync(OUT_DIR, { recursive: true });
  const tasks = c.seeds.flatMap((seed) => Array.from({ length: c.times }, (_, k) => ({ seed, k })));
  const results = await pool(c.vm.jobs, tasks.map(({ seed, k }) => async (): Promise<BootResult> => {
    const o = await boot(params('run', seed, c.level, c.profile, c.vm, c.dropFaults), join(seedOutDir(seed, c.profile, c.dropFaults), `run${k + 1}`), c.vm.timeoutSec);
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
    writeFileSync(join(OUT_DIR, 'campaign.json'), JSON.stringify({ level: c.level, profile: c.profile, times: c.times, exit, seeds: summaries }, null, 2) + '\n');
    console.log(`wrote ${join(OUT_DIR, 'campaign.json')}`);
  }
  return exit;
}

async function main(argv: string[]): Promise<number> {
  let c: Command;
  try { c = parseArgs(argv); } catch (err) {
    if (err instanceof UsageError) { console.error(`${err.message}\n${USAGE}`); return EXIT.usage; }
    throw err;
  }
  switch (c.cmd) {
    case 'help': console.log(USAGE); return EXIT.ok;
    case 'build': {
      const info = await build(c.image, c.checkRepro);
      console.log(JSON.stringify(info, null, 2));
      return EXIT.ok;
    }
    case 'selftest': return c.longSeconds === null ? selftest(c.times, c.vm, c.noBuild) : selftestLong(c.times, c.longSeconds, c.vm, c.noBuild);
    case 'run':
    case 'campaign': return runSeeds(c);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      console.error(`${sig}: removing chaos containers`);
      void cleanupContainers().finally(() => process.exit(EXIT.infra));
    });
  }

  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = EXIT.infra;
  }
}
