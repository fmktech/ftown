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
  wireTypesCopy: string;
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
    wireTypesCopy: join(ftownDir, 'harness-runtime', 'wire-types.js'),
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
  copyFileSync(join(dirname(harnessCliPath), 'wire-types.js'), p.wireTypesCopy);
  chmodSync(p.wireTypesCopy, 0o644);
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
  const body = `# ftown agent guide (auto-generated)

Read the installed ftown skill at ~/.ftown/skills/ftown/SKILL.md for session,
mail, terminal, and cleanup guidance. Its references/sessions.md contains the
command reference; references/orchestrator.md adds coordination examples.

Discover commands with \`ftown --help\`, \`ftown sessions --help\`,
\`ftown harness --help\`, and \`ftown env --help\`.
If ftown is not on PATH, use \`~/.ftown/ftown\`.

Bridge connection details live in \`~/.ftown/bridge.json\`.
`;
  const { ftownDir, agentGuide } = paths();
  mkdirSync(ftownDir, { recursive: true, mode: 0o700 });
  writeFileSync(agentGuide, body, { mode: 0o600 });
}

export function agentGuidePath(): string {
  return paths().agentGuide;
}
