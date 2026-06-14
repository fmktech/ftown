/**
 * Idempotent shell-profile PATH setup for the top-level `ftown` command.
 *
 * The bridge installs the `ftown` launcher at ~/.ftown/ftown. For it to be
 * runnable as a bare `ftown`, ~/.ftown must be on PATH. This module manages a
 * clearly-fenced block in the user's shell profiles, never touching content
 * outside its BEGIN..END markers, and is safe to call on every bridge start.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BEGIN = '# >>> ftown (managed by ftown-bridge) >>>';
const END = '# <<< ftown (managed by ftown-bridge) <<<';

/** The exact managed block: BEGIN marker, the PATH export, END marker. */
export function buildManagedBlock(): string {
  return `${BEGIN}\nexport PATH="$HOME/.ftown:$PATH"\n${END}`;
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
  if (changed) writeFileSync(path, content, { mode: 0o644 });
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
 * Always targets ~/.zshenv (created if missing). Also targets ~/.bashrc, but
 * ONLY when it already exists (never creates bash config). Honors
 * `FTOWN_SKIP_PATH_SETUP` as a boolean kill-switch (unset or one of
 * 0/false/no/off -> not skipped; any other value -> no-op). Returns the
 * profiles actually written; idempotent across calls.
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
  if (existsSync(bashrc) && writeIfChanged(bashrc, block)) updated.push(bashrc);

  return { updated, skipped: false };
}
