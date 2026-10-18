import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CLAUDE_MOD_FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js'] as const;

export function installClaudeMod(bundledPath: string, home = homedir()): string {
  const destination = join(home, '.ftown', 'claude-plugin');
  for (const relative of CLAUDE_MOD_FILES) {
    const target = join(destination, relative);
    for (const directory of [join(home, '.ftown'), destination, dirname(target)]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink()) throw new Error(`Setup refuses symlink directory: ${directory}`);
    }
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`Setup refuses symlink asset: ${target}`);
    copyFileSync(join(bundledPath, relative), target);
    chmodSync(target, 0o600);
  }
  return destination;
}

export function supportsClaudeMods(version: string): boolean {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 287)));
}

let cached: { key: string; expires: number; compatible: boolean } | undefined;

/** Read-only, bounded compatibility probe; a missing/old CLI retains classic hooks. */
export function claudeModLaunchPath(options: { home?: string; probeVersion?: () => string; now?: () => number } = {}): string | undefined {
  const home = options.home ?? homedir();
  const destination = join(home, '.ftown', 'claude-plugin');
  if (!CLAUDE_MOD_FILES.every((file) => existsSync(join(destination, file)))) return undefined;
  const key = `${home}\0${process.env.PATH ?? ''}`;
  const now = options.now?.() ?? Date.now();
  let compatible: boolean;
  if (!options.probeVersion && cached?.key === key && now < cached.expires) compatible = cached.compatible;
  else {
    try {
      compatible = supportsClaudeMods(options.probeVersion ? options.probeVersion() : execFileSync('claude', ['--version'], {
        encoding: 'utf8', timeout: 1500, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      }));
    } catch { compatible = false; }
    if (!options.probeVersion) cached = { key, expires: now + 60_000, compatible };
  }
  return compatible ? destination : undefined;
}
