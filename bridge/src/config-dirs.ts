import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Harness config/data/cache directory resolution.
 *
 * Every resolver is pure: it reads only the supplied `env` and `home`, so
 * installers and readers share one source of truth for where a harness keeps
 * its state. A blank (whitespace-only) override falls back to the default,
 * matching the long-standing OPENCODE_CONFIG_DIR behaviour in
 * install-ftown-skill.ts.
 */
function override(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') return undefined;
  return value.trim().length > 0 ? value : undefined;
}

/** XDG paths may be relative: OpenCode accepts them, so preserve them for compatibility.
 * XDG base directory for user configuration: `$XDG_CONFIG_HOME` or `$HOME/.config`. */
export function xdgConfigHome(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'XDG_CONFIG_HOME') ?? join(home, '.config');
}

/** XDG base directory for user cache: `$XDG_CACHE_HOME` or `$HOME/.cache`. */
export function xdgCacheHome(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'XDG_CACHE_HOME') ?? join(home, '.cache');
}

/**
 * opencode's config directory. `OPENCODE_CONFIG_DIR` replaces the directory
 * itself; otherwise it is `$XDG_CONFIG_HOME/opencode` (or `~/.config/opencode`).
 */
export function opencodeConfigDir(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'OPENCODE_CONFIG_DIR')?.trim() ?? join(xdgConfigHome(home, env), 'opencode');
}

/** XDG data directory. */
export function xdgDataHome(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'XDG_DATA_HOME') ?? join(home, '.local', 'share');
}

/** Claude rejects empty and relative config paths; retain its exact path for keychain hashing. */
export function claudeConfigOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.CLAUDE_CONFIG_DIR;
  return typeof value === 'string' && value.trim() !== '' && isAbsolute(value) ? value.normalize('NFC') : undefined;
}

export function claudeConfigDir(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return claudeConfigOverride(env) ?? join(home, '.claude');
}

export function codexHome(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return override(env, 'CODEX_HOME') ?? join(home, '.codex');
}
