import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Agent-facing cheat sheet — rewritten on every bridge start. */
export function writeHarnessAgentGuide(opts: {
  wrapperPath: string;
  port?: number;
  bridgeId?: string;
}): void {
  const body = `# ftown agent guide (auto-generated)

Read the installed ftown skill at ~/.ftown/skills/ftown/SKILL.md for session,
mail, terminal, and cleanup guidance. Its references/sessions.md contains the
command reference; references/orchestrator.md adds coordination examples.

Discover commands with \`ftown --help\`, \`ftown sessions --help\`,
\`ftown harness --help\`, and \`ftown env --help\`.
If ftown is not on PATH, use \`~/.ftown/ftown\`.

Bridge connection details live in \`~/.ftown/bridge.json\`.
`;
  const ftownDir = join(homedir(), '.ftown');
  const agentGuide = agentGuidePath();
  mkdirSync(ftownDir, { recursive: true, mode: 0o700 });
  writeFileSync(agentGuide, body, { mode: 0o600 });
}

export function agentGuidePath(): string {
  return join(homedir(), '.ftown', 'harness-agent.md');
}
