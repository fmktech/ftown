import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function canonicalNotifyPath(): string { return join(homedir(), '.ftown', 'notify.sh'); }

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
  const destination = canonicalNotifyPath();
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(bundledPath, destination);
  chmodSync(destination, 0o755);
  return destination;
}

export function canonicalNotifyReady(): boolean {
  return existsSync(canonicalNotifyPath());
}
