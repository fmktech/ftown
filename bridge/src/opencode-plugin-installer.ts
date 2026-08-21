import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const execAsync = promisify(exec);

/** True when the `opencode` binary is reachable on PATH (cheap probe). */
export async function opencodeBinaryAvailable(): Promise<boolean> {
  try {
    await execAsync('command -v opencode', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the bundled ftown opencode plugin into opencode's global plugin
 * directory (~/.config/opencode/plugins/), where it is auto-loaded by every
 * opencode instance. The plugin is inert unless FTOWN_SESSION_ID is set, so
 * manual `opencode` runs are unaffected.
 *
 * Unlike the Pi extension (loaded per-launch via --extension), a global-dir
 * install cannot be scoped per session — so the installer rewrites on every
 * bridge start to keep the deployed copy in sync with the bundled one.
 */
export function installOpencodePlugin(bundledPath: string, home: string = homedir()): string {
  const destination = join(home, '.config', 'opencode', 'plugins', 'ftown.js');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  // Repair drift: skip the write when contents already match to avoid churn,
  // so opencode's plugin watcher does not reload an identical file.
  const next = readFileSync(bundledPath, 'utf8');
  if (!existsSync(destination) || readFileSync(destination, 'utf8') !== next) {
    writeFileSync(destination, next, { mode: 0o600 });
  }
  return destination;
}
