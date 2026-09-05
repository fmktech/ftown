import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Default data dir is ~/.ftown/data (machine-stable, like the rest of ~/.ftown).
 * Older bridges defaulted to ./data relative to the launch cwd — if that legacy
 * dir holds sessions and the new default does not exist yet, migrate it once so
 * an upgraded bridge still resurrects its sessions.
 */
export function resolveDefaultDataDir(): string {
  const defaultDir = join(homedir(), '.ftown', 'data');
  const legacyDir = resolve('./data');
  if (!existsSync(defaultDir) && existsSync(join(legacyDir, 'sessions'))) {
    try {
      mkdirSync(dirname(defaultDir), { recursive: true });
      renameSync(legacyDir, defaultDir);
      console.log(`[Bridge] Migrated legacy data dir ${legacyDir} -> ${defaultDir}`);
    } catch (err) {
      console.error(
        `[Bridge] Failed to migrate legacy data dir (${err instanceof Error ? err.message : String(err)}); using ${legacyDir}`,
      );
      return legacyDir;
    }
  }
  return defaultDir;
}

/**
 * Resolve the ".ftown home" — the directory that holds THIS bridge instance's
 * pointer and loop-state files: bridge.json, loops.json, loop-runs.json,
 * session-registry.json.
 *
 * Why this indirection exists:
 * - The DEFAULT install keeps $HOME/.ftown. The harness CLIs
 *   (harness-cli.ts / ftown-sessions-cli.ts / workflow-runner-cli.ts, and their
 *   deployed sibling copies) hardcode `join(homedir(), '.ftown', 'bridge.json')`
 *   to find the primary bridge, so the default MUST stay byte-for-byte at
 *   $HOME/.ftown or those CLIs break.
 * - A NON-default `--data-dir` (a Solo test, Docker, or a second co-resident
 *   bridge) owns its OWN instance files under that dir. It must never write or
 *   delete the primary bridge's pointer/loop state under $HOME/.ftown — a
 *   co-resident primary bridge relies on those files.
 *
 * Semantics: if `dataDir` resolves to the default data dir, return
 * `$HOME/.ftown`; otherwise the custom data dir is its own instance home.
 *
 * `defaultDataDir` lets a caller pass the default it ALREADY resolved (index.ts
 * computes it once for both `dataDir` and this call) so
 * `resolveDefaultDataDir()`'s one-time legacy `./data` migration side effect is
 * never re-triggered. When omitted (standalone callers, tests) the default is
 * computed once and memoized, so a repeated call cannot re-run the migration —
 * where a first-fail-then-succeed sequence could otherwise misroute the home to
 * `./data`. This function performs no fs writes of its own beyond that shared,
 * idempotent migration.
 */
let memoizedDefaultDataDir: string | undefined;

export function resolveFtownHome(dataDir: string, defaultDataDir?: string): string {
  const def = defaultDataDir ?? (memoizedDefaultDataDir ??= resolveDefaultDataDir());
  if (resolve(dataDir) === resolve(def)) return join(homedir(), '.ftown');
  return resolve(dataDir);
}

/**
 * Test-only: clear the memoized default data dir so a $HOME override in a later
 * test is honored instead of a value cached from an earlier one. Never call this
 * in production — index.ts always passes an explicit `defaultDataDir`.
 */
export function resetFtownHomeForTests(): void {
  memoizedDefaultDataDir = undefined;
}
