import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const FTOWN_DIR = join(homedir(), '.ftown');
const BIN_DIR = join(FTOWN_DIR, 'bin');
const HARNESS_WRAPPER = join(BIN_DIR, 'ftown-harness');
const HARNESS_CLI_PATH_FILE = join(FTOWN_DIR, 'harness-cli.path');

const WRAPPER_SCRIPT = `#!/usr/bin/env bash
# Auto-deployed by ftown-bridge — do not edit
set -euo pipefail
CLI_PATH_FILE="${HARNESS_CLI_PATH_FILE.replace(/\\/g, '\\\\')}"
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

export interface HarnessInstallResult {
  wrapperPath: string;
  cliPath: string;
  binDir: string;
}

/** Deploy ftown-harness wrapper under ~/.ftown/bin (idempotent). */
export function installHarness(harnessCliPath: string): HarnessInstallResult {
  const cliPath = harnessCliPath;

  mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(HARNESS_CLI_PATH_FILE, cliPath + '\n', { mode: 0o600 });
  writeFileSync(HARNESS_WRAPPER, WRAPPER_SCRIPT, { mode: 0o755 });

  return {
    wrapperPath: HARNESS_WRAPPER,
    cliPath,
    binDir: BIN_DIR,
  };
}

export function harnessOnPath(): boolean {
  const pathEnv = process.env.PATH ?? '';
  return pathEnv.split(':').some((p) => p === BIN_DIR || p === join(FTOWN_DIR, 'bin'));
}

export function pathHint(): string {
  return existsSync(HARNESS_WRAPPER)
    ? `Add to PATH: export PATH="${BIN_DIR}:$PATH"`
    : '';
}

const AGENT_GUIDE = join(FTOWN_DIR, 'harness-agent.md');

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
| \`send\` | \`${h} send ftown "text" -s --dry-run\` first; **only if user asked** |
| \`--json\` | \`${h} --json ls\` — machine-readable output |

## Session names

Resolve by exact name → unique substring → id prefix. Ambiguous names print choices.

## Submit keys (\`-s\`)

- \`cursor\` / \`claude\`: Escape+Enter (\`\\x1b\\r\`)
- \`shell\`: Enter (\`\\r\`)

## Registry

\`~/.ftown/session-registry.json\` maps workspace roots → session id. \`here\` uses it.

## When bridge is down

\`${h}\` exits with a clear error. Start bridge from ftown UI → CLI Token → \`npx ftown-bridge --token ... --api-url ...\`

## context-mode

Allowed Bash: \`${h}\` subcommands (short output). Do not use curl/wget/fetch to \`127.0.0.1\` for bridge API.
`;
  mkdirSync(FTOWN_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(AGENT_GUIDE, body, { mode: 0o600 });
}

export function agentGuidePath(): string {
  return AGENT_GUIDE;
}
