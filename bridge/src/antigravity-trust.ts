import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Antigravity (agy) keeps its trusted-folder list in
 * ~/.gemini/antigravity-cli/settings.json as `{ "trustedWorkspaces": [ "<abs realpath>", ... ] }`.
 * Entries are resolved real paths (macOS /tmp -> /private/tmp).
 */
export function antigravitySettingsPath(home: string = homedir()): string {
  return join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

function resolveReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Path may not exist yet; fall back to the absolute input.
    return resolve(path);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Broad system/user roots that must never be trusted as a workdir (exact match). */
const BROAD_DIRS = ['/', '/tmp', '/private/tmp', '/Users', '/home', '/var', '/private'] as const;

/** True when `real` is `/`, a broad system root, the home dir, or home's parent. */
function isRefusedDir(real: string, home: string): boolean {
  const homeReal = resolveReal(home);
  const refused = new Set<string>([...BROAD_DIRS, homeReal, dirname(homeReal), resolveReal(dirname(home))]);
  for (const broad of BROAD_DIRS) refused.add(resolveReal(broad));
  return refused.has(real);
}

/**
 * Ensure Antigravity trusts `dir` so spawned agy sessions skip the blocking
 * "trust this folder?" prompt. Adds exactly the realpath of `dir` — never a
 * parent directory, `/`, a broad system root, or the home directory — and
 * preserves every other key and entry in settings.json. Idempotent. Writes via
 * temp file + rename, keeping an existing file's mode (0600 only when creating).
 * If the existing file is not a JSON object, it is left untouched.
 */
export function ensureAntigravityWorkdirTrust(dir: string): void {
  const home = homedir();
  const real = resolveReal(dir);
  if (isRefusedDir(real, home)) {
    console.log(`[AntigravityTrust] refusing to trust ${real}`);
    return;
  }

  const settingsPath = antigravitySettingsPath(home);

  let settings: Record<string, unknown> = {};
  let mode = 0o600;
  try {
    if (existsSync(settingsPath)) {
      mode = statSync(settingsPath).mode & 0o777;
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (!isPlainObject(parsed)) {
        console.error(`[AntigravityTrust] ${settingsPath} is not a JSON object; left unchanged`);
        return;
      }
      settings = parsed;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[AntigravityTrust] failed to read settings.json: ${msg}`);
    return;
  }

  const current = settings.trustedWorkspaces;
  if (current !== undefined && !Array.isArray(current)) {
    console.error('[AntigravityTrust] trustedWorkspaces is not an array; left unchanged');
    return;
  }
  const trusted: unknown[] = Array.isArray(current) ? current : [];
  if (trusted.includes(real)) return;

  const next = { ...settings, trustedWorkspaces: [...trusted, real] };
  const tmpPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, settingsPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[AntigravityTrust] failed to write settings.json: ${msg}`);
    return;
  }

  console.log(`[AntigravityTrust] trusted workdir ${real}`);
}
