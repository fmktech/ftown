// Guest entry point, exec'd by /init with CHAOS_CMD / CHAOS_SEED / CHAOS_LEVEL / CHAOS_PROFILE.
import { EXIT, RUN_PROFILES, type ChaosLevel, type RunProfile } from '../contract.ts';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EXIT_SENT_MARKER, emitExit, emitFile } from './emit.ts';
import { runLongSelftest, runSelftest } from './selftest.ts';

interface SupervisorModule {
  runSeed(opts: { seed: number; level: ChaosLevel; profile: RunProfile }): Promise<number>;
}

export function parseRunEnv(
  env: NodeJS.ProcessEnv,
): { ok: true; seed: number; level: ChaosLevel; profile: RunProfile } | { ok: false; code: number; error: string } {
  const seed = Number(env.CHAOS_SEED);
  const level = env.CHAOS_LEVEL;
  if (!Number.isSafeInteger(seed) || seed < 0 || (level !== 'off' && level !== 'low' && level !== 'high')) {
    return { ok: false, code: EXIT.infra, error: `bad seed/level: ${env.CHAOS_SEED} ${level}` };
  }
  const profile = env.CHAOS_PROFILE;
  if (!RUN_PROFILES.includes(profile as RunProfile)) {
    return { ok: false, code: EXIT.usage, error: `bad profile: ${JSON.stringify(profile)}` };
  }
  if (profile === 'short' && level === 'high') {
    return { ok: false, code: EXIT.usage, error: 'level high is not valid with profile short; use profile soak' };
  }
  return { ok: true, seed, level, profile: profile as RunProfile };
}

async function main(): Promise<number> {
  const cmd = process.env.CHAOS_CMD ?? '';
  if (cmd === 'selftest') {
    const report = await runSelftest();
    emitFile('selftest.json', JSON.stringify(report) + '\n');
    return EXIT.ok;
  }
  if (cmd === 'selftest-long') {
    const seconds = Number(process.env.CHAOS_SEED) || 600;
    emitFile('long.jsonl', await runLongSelftest(seconds, (l) => console.log(l)));
    return EXIT.ok;
  }
  if (cmd === 'run') {
    const parsed = parseRunEnv(process.env);
    if (!parsed.ok) {
      console.error(`chaos-main: ${parsed.error}`);
      return parsed.code;
    }
    let mod: SupervisorModule;
    try {
      const spec = '../supervisor/main.ts';
      mod = (await import(spec)) as SupervisorModule;
      if (typeof mod.runSeed !== 'function') throw new Error('runSeed is not exported');
    } catch (err) {
      console.error(`chaos-main: cannot load supervisor: ${String(err)}`);
      return EXIT.infra;
    }
    return await mod.runSeed({ seed: parsed.seed, level: parsed.level, profile: parsed.profile });
  }
  console.error(`chaos-main: unknown CHAOS_CMD ${JSON.stringify(cmd)}`);
  return EXIT.infra;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let code: number;
  try {
    code = await main();
  } catch (err) {
    console.error(`chaos-main: ${err instanceof Error ? err.stack : String(err)}`);
    code = EXIT.infra;
  }
  try {
    // Exactly one CHAOS-EXIT: the code runSeed returned, unless the supervisor already sent one.
    if (!existsSync(EXIT_SENT_MARKER)) emitExit(code);
  } catch (err) {
    console.error(`chaos-main: cannot emit exit: ${String(err)}`);
  }
  process.exit(code);
}
