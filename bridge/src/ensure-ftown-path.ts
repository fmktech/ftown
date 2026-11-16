/**
 * Idempotent shell-profile PATH setup for the top-level `ftown` command.
 *
 * The bridge installs the `ftown` launcher at ~/.ftown/ftown. For it to be
 * runnable as a bare `ftown`, ~/.ftown must be on PATH. This module manages a
 * clearly-fenced block in the user's shell profiles, never touching content
 * outside its BEGIN..END markers, and runs only during explicit ftown setup.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const BEGIN = '# >>> ftown (managed by ftown-bridge) >>>';
const END = '# <<< ftown (managed by ftown-bridge) <<<';

/** The exact managed block: BEGIN marker, the PATH export, END marker. */
export function buildManagedBlock(): string {
  return `${BEGIN}\nexport PATH="$HOME/.ftown:$PATH"\n${END}`;
}

/**
 * Fish-flavoured managed block. The BEGIN/END markers are `#` comments in fish
 * too, so the same upsert logic applies; only the PATH assignment differs
 * (fish uses `set -gx`, not `export`).
 */
export function buildFishManagedBlock(): string {
  return `${BEGIN}\nset -gx PATH "$HOME/.ftown" $PATH\n${END}`;
}

/**
 * PURE. Upsert the managed `block` into `existing` shell-profile content.
 *
 * - If the BEGIN..END region already exists, replace exactly that region with
 *   `block` (changed=false iff the result is identical to `existing`).
 * - Otherwise append `block`, ensuring exactly one blank line of separation
 *   from any preceding content and a single trailing newline.
 */
export function upsertManagedBlock(
  existing: string,
  block: string,
): { content: string; changed: boolean } {
  const beginIdx = existing.indexOf(BEGIN);
  if (beginIdx !== -1) {
    const endIdx = existing.indexOf(END, beginIdx);
    if (endIdx !== -1) {
      const regionEnd = endIdx + END.length;
      const content = existing.slice(0, beginIdx) + block + existing.slice(regionEnd);
      return { content, changed: content !== existing };
    }
  }

  const trimmed = existing.replace(/\n+$/, '');
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : '';
  const content = `${prefix}${block}\n`;
  return { content, changed: content !== existing };
}

/** Write `block` into the profile at `path`, only when the file would change. */
function writeIfChanged(path: string, block: string): boolean {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const { content, changed } = upsertManagedBlock(existing, block);
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o644 });
  }
  return changed;
}

/** Boolean env-flag convention: unset / 0 / false / no / off are all "not set". */
function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Ensure ~/.ftown is on PATH via the user's shell profiles.
 *
 * Targets, all created if missing and all idempotent across calls:
 * - ~/.zshenv (zsh, read by both login and non-login shells).
 * - Bash: ~/.bashrc when it exists (interactive non-login shells, which most
 *   login profiles source). When it does NOT exist, a login shell instead
 *   reads the first of ~/.bash_profile, ~/.bash_login or ~/.profile, so we
 *   target ~/.bash_profile if present and otherwise ~/.profile. This keeps
 *   login semantics correct: writing only ~/.profile would be ignored when a
 *   ~/.bash_profile exists.
 * - ~/.config/fish/conf.d/ftown.fish (sourced by every fish shell), using fish
 *   syntax rather than `export`.
 *
 * Honors `FTOWN_SKIP_PATH_SETUP` as a boolean kill-switch (unset or one of
 * 0/false/no/off -> not skipped; any other value -> no-op). Returns the
 * profiles actually written.
 */
export function ensureFtownOnPath(opts?: {
  home?: string;
  env?: Record<string, string | undefined>;
}): { updated: string[]; skipped: boolean } {
  const env = opts?.env ?? process.env;
  if (isTruthyFlag(env.FTOWN_SKIP_PATH_SETUP)) return { updated: [], skipped: true };

  const home = opts?.home ?? homedir();
  const block = buildManagedBlock();
  const updated: string[] = [];

  const zshenv = join(home, '.zshenv');
  if (writeIfChanged(zshenv, block)) updated.push(zshenv);

  const bashrc = join(home, '.bashrc');
  const bashProfile = join(home, '.bash_profile');
  const profile = join(home, '.profile');
  if (existsSync(bashrc)) {
    if (writeIfChanged(bashrc, block)) updated.push(bashrc);
  } else {
    // No .bashrc: the only way a bash shell sees us is via a login file, and
    // bash reads .bash_profile in preference to .profile.
    const loginProfile = existsSync(bashProfile) ? bashProfile : profile;
    if (writeIfChanged(loginProfile, block)) updated.push(loginProfile);
  }

  const fishConf = join(home, '.config', 'fish', 'conf.d', 'ftown.fish');
  if (writeIfChanged(fishConf, buildFishManagedBlock())) updated.push(fishConf);

  return { updated, skipped: false };
}
