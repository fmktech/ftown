// Entry point: node /opt/chaos/src/fake-agent/main.ts --role <role> --script <path.json> [ignored args]
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { GUEST } from '../contract.ts';
import type { AgentScript } from '../contract.ts';
import { runAgent } from './agent.ts';
import { epochClock, parseArgs, fileLogger, fileStateStore, idsFromFile, isRole, rawFailureWriter, realCli, realHook } from './cli.ts';

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
    rawFailure: rawFailureWriter(logDir, role, clock),
    stdinLines: rl,
    resolveId: idsFromFile(process.env.CHAOS_IDS_FILE || GUEST.idsFile),
    state: fileStateStore(logDir, role),
  });
  if (result.exitCode !== null) return;
  // Steps done (and stdin closed): stay alive, idle, until killed.
  setInterval(() => undefined, 1 << 30);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
