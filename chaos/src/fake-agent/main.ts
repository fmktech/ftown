// Entry point: node /opt/chaos/src/fake-agent/main.ts --role <role> --script <path.json> [ignored args]
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { GUEST } from '../contract.ts';
import type { AgentScript } from '../contract.ts';
import { runAgent } from './agent.ts';
import { epochClock, fileLogger, idsFromFile, isRole, realCli, realHook } from './cli.ts';

function parseArgs(argv: string[]): { role: string | undefined; script: string | undefined } {
  let role: string | undefined;
  let script: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--role') role = argv[++i];
    else if (a.startsWith('--role=')) role = a.slice('--role='.length);
    else if (a === '--script') script = argv[++i];
    else if (a.startsWith('--script=')) script = a.slice('--script='.length);
    // Unknown arguments (added by the bridge) are ignored.
  }
  return { role, script };
}

async function main(): Promise<void> {
  const { role, script: scriptPath } = parseArgs(process.argv.slice(2));
  if (!role || !isRole(role) || !scriptPath) {
    process.stderr.write('usage: main.ts --role <root|child1|child2|child3> --script <path.json>\n');
    process.exit(2);
  }
  const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as AgentScript;
  const logDir = process.env.CHAOS_AGENT_LOG_DIR || GUEST.agentLogDir;
  // Throws (and the process fails loudly) when the shared epoch file is unreadable.
  const clock = epochClock(process.env.CHAOS_T0_FILE || GUEST.t0File);
  const log = fileLogger(logDir, role, clock);

  process.on('SIGTERM', () => {
    log({ ev: 'exit', code: 143 });
    process.exit(143);
  });

  // readline's iterator ends when stdin closes; the agent must keep running after that.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const result = await runAgent({
    script,
    clock,
    cli: realCli(),
    hook: realHook(),
    log,
    stdinLines: rl,
    resolveId: idsFromFile(process.env.CHAOS_IDS_FILE || GUEST.idsFile),
  });
  if (result.exitCode !== null) return;
  // Steps done (and stdin closed): stay alive, idle, until killed.
  setInterval(() => undefined, 1 << 30);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
