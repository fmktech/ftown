import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const CANONICAL_NOTIFY_PATH = join(homedir(), '.ftown', 'notify.sh');

/** True for legacy package paths and the canonical ~/.ftown copy. */
export function isFtownNotifyCommand(command: string): boolean {
  if (!command.endsWith('notify.sh')) return false;
  return (
    command.includes('.ftown/') ||
    command.includes('/ftown/bridge/hooks/') ||
    command.endsWith('/hooks/notify.sh')
  );
}

/** Copy bundled notify.sh to ~/.ftown/notify.sh (mode 0755). Returns canonical path. */
export function installNotifyScript(bundledPath: string): string {
  mkdirSync(dirname(CANONICAL_NOTIFY_PATH), { recursive: true, mode: 0o700 });
  copyFileSync(bundledPath, CANONICAL_NOTIFY_PATH);
  chmodSync(CANONICAL_NOTIFY_PATH, 0o755);
  return CANONICAL_NOTIFY_PATH;
}

export function canonicalNotifyReady(): boolean {
  return existsSync(CANONICAL_NOTIFY_PATH);
}
