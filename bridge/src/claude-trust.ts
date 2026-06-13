import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface ClaudeConfig {
  projects?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Pre-trust `dir` for Claude Code so a spawned worker does not block on the
 * interactive "Do you trust this folder?" dialog — which `--dangerously-skip-permissions`
 * does NOT dismiss. Sets `projects[dir].hasTrustDialogAccepted = true` in `~/.claude.json`,
 * preserving every other field, via an atomic temp+rename. Best-effort: never throws.
 *
 * Scoped to ftown-workflows workers (non-interactive automation). The claude config keys
 * projects by REAL path (e.g. `/private/tmp`, not `/tmp`), so we trust the realpath.
 * Mirrors the bridge's `ensureCodexWorkdirTrust`.
 */
export function ensureClaudeWorkdirTrust(dir: string): void {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // Path may not exist yet; fall back to the input verbatim.
  }

  const configPath = join(homedir(), '.claude.json');

  let cfg: ClaudeConfig = {};
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8')) as ClaudeConfig;
  } catch {
    // Missing or unreadable — start fresh; claude fills in the rest on launch.
    cfg = {};
  }
  if (!cfg.projects || typeof cfg.projects !== 'object') cfg.projects = {};

  const existing = cfg.projects[real];
  if (existing && existing.hasTrustDialogAccepted === true) return; // already trusted

  cfg.projects[real] = { ...(existing ?? {}), hasTrustDialogAccepted: true };

  const tmpPath = `${configPath}.ftw-tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
    renameSync(tmpPath, configPath);
  } catch {
    // Best-effort: if we cannot persist trust the worker may hit the dialog, but the
    // workflow run must not crash.
  }
}
