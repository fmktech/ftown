// Guest entry point, exec'd by /init with CHAOS_CMD / CHAOS_SEED / CHAOS_LEVEL.
import { EXIT, type ChaosLevel } from '../contract.ts';
import { existsSync } from 'node:fs';
import { EXIT_SENT_MARKER, emitExit, emitFile } from './emit.ts';
import { runSelftest } from './selftest.ts';

interface SupervisorModule {
  runSeed(opts: { seed: number; level: ChaosLevel }): Promise<number>;
}

async function main(): Promise<number> {
  const cmd = process.env.CHAOS_CMD ?? '';
  if (cmd === 'selftest') {
    const report = await runSelftest();
    emitFile('selftest.json', JSON.stringify(report) + '\n');
    return EXIT.ok;
  }
  if (cmd === 'run') {
    const seed = Number(process.env.CHAOS_SEED);
    const level = process.env.CHAOS_LEVEL;
    if (!Number.isSafeInteger(seed) || seed < 0 || (level !== 'off' && level !== 'low' && level !== 'high')) {
      console.error(`chaos-main: bad seed/level: ${process.env.CHAOS_SEED} ${level}`);
      return EXIT.infra;
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
    return await mod.runSeed({ seed, level });
  }
  console.error(`chaos-main: unknown CHAOS_CMD ${JSON.stringify(cmd)}`);
  return EXIT.infra;
}

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
