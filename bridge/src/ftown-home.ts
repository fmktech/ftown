import { existsSync, mkdirSync, renameSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Resolve the default without migrating data or touching global state. */
export function resolveDefaultDataDir(): string { return join(homedir(), '.ftown', 'data'); }

/** Explicit setup-only migration of the historical cwd-relative data directory. */
export function migrateLegacyDataDir(): void {
  const destination = resolveDefaultDataDir();
  const legacy = resolve('./data');
  if (existsSync(destination) || !existsSync(join(legacy, 'sessions'))) return;
  if (lstatSync(legacy).isSymbolicLink() || lstatSync(join(legacy, 'sessions')).isSymbolicLink()) return;
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(legacy, destination);
  console.log(`[Setup] Migrated legacy data dir ${legacy} -> ${destination}`);
}

/**
 * Resolve the ".ftown home" — the directory that holds THIS bridge instance's
 * pointer and registry files: bridge.json,
 * session-registry.json.
 *
 * Why this indirection exists:
 * - The DEFAULT install keeps $HOME/.ftown. The harness CLIs
 *   (harness-cli.ts / ftown-sessions-cli.ts, and their
 *   deployed sibling copies) hardcode `join(homedir(), '.ftown', 'bridge.json')`
 *   to find the primary bridge, so the default MUST stay byte-for-byte at
 *   $HOME/.ftown or those CLIs break.
 * - A NON-default `--data-dir` (a Solo test, Docker, or a second co-resident
 *   bridge) owns its OWN instance files under that dir. It must never write or
 *   delete the primary bridge's pointer/registry state under $HOME/.ftown — a
 *   co-resident primary bridge relies on those files.
 *
 * Semantics: if `dataDir` resolves to the default data dir, return
 * `$HOME/.ftown`; otherwise the custom data dir is its own instance home.
 *
 * `defaultDataDir` can pass the already-resolved default. Resolution is read-only.
 */
export function resolveFtownHome(dataDir: string, defaultDataDir?: string): string {
  const def = defaultDataDir ?? resolveDefaultDataDir();
  if (resolve(dataDir) === resolve(def)) return join(homedir(), '.ftown');
  return resolve(dataDir);
}

/** Compatibility helper for tests; default resolution no longer caches HOME. */
export function resetFtownHomeForTests(): void {}
