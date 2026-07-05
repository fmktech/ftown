import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';

const require = createRequire(import.meta.url);
const HARNESS_RUNTIME_DEPS = ['commander'] as const;

function paths(home = homedir()): {
  ftownDir: string;
  binDir: string;
  wrapper: string;
  cliPathFile: string;
  runtimeDir: string;
  cliCopy: string;
  formatCopy: string;
  agentGuide: string;
} {
  const ftownDir = join(home, '.ftown');
  const binDir = join(ftownDir, 'bin');
  return {
    ftownDir,
    binDir,
    wrapper: join(binDir, 'ftown-harness'),
    cliPathFile: join(ftownDir, 'harness-cli.path'),
    runtimeDir: join(ftownDir, 'harness-runtime'),
    cliCopy: join(ftownDir, 'harness-runtime', 'harness-cli.js'),
    formatCopy: join(ftownDir, 'harness-runtime', 'harness-format.js'),
    agentGuide: join(ftownDir, 'harness-agent.md'),
  };
}

function wrapperScript(cliPathFile: string): string {
  return `#!/usr/bin/env bash
# Auto-deployed by ftown-bridge — do not edit
set -euo pipefail
CLI_PATH_FILE="${cliPathFile.replace(/\\/g, '\\\\')}"
if [[ ! -f "$CLI_PATH_FILE" ]]; then
  echo "ftown-harness: bridge not running (missing $CLI_PATH_FILE)" >&2
  exit 1
fi
CLI="$(cat "$CLI_PATH_FILE")"
if [[ ! -f "$CLI" ]]; then
  echo "ftown-harness: harness CLI missing at $CLI — restart ftown-bridge" >&2
  exit 1
fi
exec node "$CLI" "$@"
`;
}

export interface HarnessInstallResult {
  wrapperPath: string;
  cliPath: string;
  binDir: string;
}

function findPackageRoot(entrypoint: string): string {
  let dir = dirname(entrypoint);
  const root = parse(dir).root;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dir === root) {
      throw new Error(`Could not find package root for ${entrypoint}`);
    }
    dir = dirname(dir);
  }
}

function copyRuntimeDependency(dep: (typeof HARNESS_RUNTIME_DEPS)[number], fromDir: string, runtimeDir: string): void {
  const entrypoint = require.resolve(dep, { paths: [fromDir] });
  const packageDir = findPackageRoot(entrypoint);
  const dest = join(runtimeDir, 'node_modules', dep);
  cpSync(packageDir, dest, { recursive: true, force: true });
}

/** Deploy ftown-harness wrapper under ~/.ftown/bin (idempotent). */
export function installHarness(harnessCliPath: string): HarnessInstallResult {
  const p = paths();
  const cliPath = p.cliCopy;

  mkdirSync(p.binDir, { recursive: true, mode: 0o700 });
  mkdirSync(p.runtimeDir, { recursive: true, mode: 0o700 });
  copyFileSync(harnessCliPath, p.cliCopy);
  chmodSync(p.cliCopy, 0o644);
  copyFileSync(join(dirname(harnessCliPath), 'harness-format.js'), p.formatCopy);
  chmodSync(p.formatCopy, 0o644);
  for (const dep of HARNESS_RUNTIME_DEPS) {
    copyRuntimeDependency(dep, dirname(harnessCliPath), p.runtimeDir);
  }
  writeFileSync(p.cliPathFile, cliPath + '\n', { mode: 0o600 });
  writeFileSync(p.wrapper, wrapperScript(p.cliPathFile), { mode: 0o755 });

  return {
    wrapperPath: p.wrapper,
    cliPath,
    binDir: p.binDir,
  };
}

export function harnessOnPath(): boolean {
  const { ftownDir, binDir } = paths();
  const pathEnv = process.env.PATH ?? '';
  return pathEnv.split(':').some((p) => p === binDir || p === join(ftownDir, 'bin'));
}

export function pathHint(): string {
  const { wrapper, binDir } = paths();
  return existsSync(wrapper)
    ? `Add to PATH: export PATH="${binDir}:$PATH"`
    : '';
}

/** Agent-facing cheat sheet — rewritten on every bridge start. */
export function writeHarnessAgentGuide(opts: {
  wrapperPath: string;
  port: number;
  bridgeId?: string;
}): void {
  const h = opts.wrapperPath;
  const body = `# ftown bridge harness (auto-generated)

Bridge is running. Use the harness CLI — **do not** use curl, lsof, or raw HTTP for the local bridge API.

## Command

\`\`\`bash
${h} <subcommand>
\`\`\`

Wrapper path is stable; bridge port/token live in \`~/.ftown/bridge.json\` (current port: ${opts.port}).

## Default workflow (run in order)

\`\`\`bash
${h} status          # bridge up?
${h} here -n 25      # workspace session + tail (works when process dead if log exists)
${h} ls --tail 3     # all sessions; log=N lines; preview dead sessions too
${h} grep <name> "error|FAIL" -C 2
\`\`\`

## Subcommands

| Subcommand | Example |
|------------|---------|
| \`status\` | \`${h} status\` |
| \`ls\` | \`${h} ls --tail 3\` |
| \`here\` | \`${h} here -n 30\` — walks up from cwd to find workspace |
| \`tail\` | \`${h} tail ftown -n 40\` |
| \`grep\` | \`${h} grep legbi "pattern" -C 2\` |
| \`mail send\` | \`${h} mail send <session> --type task "do X"\` — inter-agent mail |
| \`mail read\` | \`${h} mail read\` (\`--peek\`, \`--limit N\`, \`--all\`) |
| \`send\` | \`${h} send ftown "text" -s --dry-run\` first; **only if user asked** |
| \`--json\` | \`${h} --json ls\` — machine-readable output |

## Session names

Resolve by exact name → unique substring → id prefix. Ambiguous names print choices.

## Mail (per-session inbox)

\`\`\`bash
${h} mail send <session> "message"            # plain message
${h} mail send <child> --type task "do X"     # task for a worker
${h} mail send --parent --type result "done"  # report to parent (uses FTOWN_PARENT_SESSION_ID)
${h} mail read                                # pending mail; --peek keeps it undelivered
\`\`\`

Types: \`message | task | result | escalation\`; \`--thread <id>\` groups replies.
Mail reaches the recipient automatically: a synchronous \`hook-pump\` hook
(Stop / UserPromptSubmit / SessionStart in \`~/.claude/settings.json\` for claude,
\`~/.codex/hooks.json\` for codex) checks the inbox at turn boundaries and
injects pending mail as \`[ftown mail]\` context —
on Stop it holds the agent's turn open so messages get handled immediately.
Cursor and shell sessions have no hooks; when idle they get a one-line nudge
to run \`ftown-harness mail read\` instead.
Prefer mail over \`send\` (keystroke injection) for agent-to-agent communication.

## Submit keys (\`-s\`)

- \`cursor\` / \`claude\`: Escape+Enter (\`\\x1b\\r\`)
- \`shell\`: Enter (\`\\r\`)

## Registry

\`~/.ftown/session-registry.json\` maps workspace roots → session id. \`here\` uses it.

## When bridge is down

\`${h}\` exits with a clear error. Start bridge from ftown UI → Connect a bridge → copy the bootstrap token → \`npx ftown-bridge --token ... --api-url ...\`

## context-mode

Allowed Bash: \`${h}\` subcommands (short output). Do not use curl/wget/fetch to \`127.0.0.1\` for bridge API.
`;
  const { ftownDir, agentGuide } = paths();
  mkdirSync(ftownDir, { recursive: true, mode: 0o700 });
  writeFileSync(agentGuide, body, { mode: 0o600 });
}

export function agentGuidePath(): string {
  return paths().agentGuide;
}
