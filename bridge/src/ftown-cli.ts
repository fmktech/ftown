#!/usr/bin/env node
/**
 * `ftown` — top-level dispatcher that routes subcommands to the sibling
 * launchers installed by ftown-bridge under ~/.ftown.
 *
 * Installed to ~/.ftown/ftown by ftown-bridge. Imports ONLY node builtins, so
 * no extra sibling copy is needed alongside the compiled CLI. Each subcommand
 * is forwarded verbatim to its dedicated launcher with stdio inherited, and the
 * child's exit code is propagated unchanged.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FTOWN_DIR = join(homedir(), '.ftown');

/** Subcommand -> sibling launcher path (relative to a given ftownDir). */
const SUBCOMMANDS = ['env', 'sessions', 'workflows', 'harness'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(sub: string): sub is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(sub);
}

/**
 * Resolve a subcommand to its absolute sibling launcher path under `ftownDir`.
 * Throws a clear Error (listing the valid subcommands) on undefined/unknown.
 */
export function resolveSubcommandTarget(sub: string | undefined, ftownDir: string): string {
  if (sub === undefined || !isSubcommand(sub)) {
    const got = sub === undefined ? '(none)' : `"${sub}"`;
    throw new Error(
      `Unknown subcommand ${got} — use one of: ${SUBCOMMANDS.join(', ')}`,
    );
  }
  switch (sub) {
    case 'env':
      return join(ftownDir, 'ftown-env');
    case 'sessions':
      return join(ftownDir, 'ftown-sessions');
    case 'workflows':
      return join(ftownDir, 'ftown-workflows');
    case 'harness':
      return join(ftownDir, 'bin', 'ftown-harness');
  }
}

/** Multi-line usage text listing every routed subcommand. */
export function usage(): string {
  return `Usage: ftown <env|sessions|workflows|harness> [args...]

Subcommands:
  env        Manage per-provider machine tokens (~/.ftown/env.json)
  sessions   List, create, read and drive ftown agent sessions
  workflows  Run deterministic, resumable multi-session workflows
  harness    Inspect and drive the local ftown-bridge harness`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(usage());
    process.exit(0);
  }

  let target: string;
  try {
    target = resolveSubcommandTarget(sub, FTOWN_DIR);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ftown: ${msg}`);
    console.error(usage());
    process.exit(1);
  }

  try {
    execFileSync(target, rest, { stdio: 'inherit' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null };
    if (typeof e.status === 'number') process.exit(e.status);
    if (e.code === 'ENOENT') {
      console.error(`ftown ${sub}: not installed (restart the bridge)`);
      process.exit(1);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ftown ${sub}: ${msg}`);
    process.exit(1);
  }
}

// Only run as a script (installed CLI / `node dist/ftown-cli.js`), never on
// import — tests import the exported helpers without triggering the dispatcher.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main();
}
