import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync, rmdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { CLI_RUNTIME_MODULES } from './install-ftown-command-cli.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SetupState { schema: 1; packageVersion?: string; completedMigrations: string[] }
export function setupStatePath(home = homedir()): string { return join(home, '.ftown', 'setup-state.json'); }

export function readSetupState(home = homedir()): SetupState {
  try {
    const value = JSON.parse(readFileSync(setupStatePath(home), 'utf8')) as Partial<SetupState>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1 || !Array.isArray(value.completedMigrations) || !value.completedMigrations.every((id) => typeof id === 'string')) return { schema: 1, completedMigrations: [] };
    return { schema: 1, ...(typeof value.packageVersion === 'string' ? { packageVersion: value.packageVersion } : {}), completedMigrations: value.completedMigrations };
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return { schema: 1, completedMigrations: [] };
    throw error;
  }
}

export function writeSetupState(state: SetupState, home = homedir()): void {
  const dir = join(home, '.ftown');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('Setup directory must be a real directory');
  const path = setupStatePath(home);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Setup state must not be a symlink');
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

export function setupHint(version: string): string {
  return `npx ftown@${version} setup`;
}

export function assertSetupReady(version: string, home = homedir()): void {
  const state = readSetupState(home);
  const missing = REQUIRED_SETUP_ASSETS.some((asset) => {
    try { return !lstatSync(join(home, '.ftown', asset)).isFile(); } catch { return true; }
  });
  if (state.packageVersion !== version || missing) {
    const repair = state.packageVersion === version ? ' --repair' : '';
    throw new Error(`FTown setup is missing, incomplete or outdated. Run: ${setupHint(version)}${repair}`);
  }
}

/** Existence/type inventory; startup never repairs or hashes global integrations. */
export const REQUIRED_SETUP_ASSETS: readonly string[] = [
  'ftown', 'ftown-sessions', 'ftown-env', 'bin/ftown-harness', 'notify.sh',
  'pi/ftown.js', 'harness-agent.md', 'skills/ftown/SKILL.md',
  'cli/package.json', 'cli/node_modules/commander/package.json', 'cli/node_modules/commander/index.js',
  'cli/hooks/notify.sh', 'cli/pi-extension/ftown.js', 'cli/opencode-plugin/ftown.js',
  'cli/muse-plugin/.muse-plugin/plugin.json', 'cli/skills/ftown/SKILL.md',
  ...CLI_RUNTIME_MODULES.map((name) => `cli/dist/${name}.js`),
];

/** Reject stale npm-cache setup rather than overwrite a newer installed runtime. */
export function assertSetupVersion(version: string, installed: string | undefined): void {
  if (installed && installed.localeCompare(version, undefined, { numeric: true }) > 0) {
    throw new Error(`Installed FTown ${installed} is newer than ${version}. Run matching setup: ${setupHint(installed)} --repair`);
  }
}

/** Atomic nonempty-directory lock. Reclaim only an exact provably dead owner. */
export function acquireSetupLock(home = homedir()): () => void {
  const parent = join(home, '.ftown'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink()) throw new Error('Setup directory must be real');
  const token = randomBytes(12).toString('hex');
  const owner = `owner-${process.pid}-${token}.json`;
  const candidate = join(parent, `.setup-pending-${process.pid}-${token}`);
  const lock = join(parent, 'setup.lock');
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(join(candidate, owner), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { renameSync(candidate, lock); acquired = true; break; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        const stat = lstatSync(lock);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Setup lock has an unknown owner; preserved');
        const entries = readdirSync(lock);
        if (entries.length === 0) continue; // owner is releasing; never recursively remove a lock
        const match = entries.length === 1 ? /^owner-(\d+)-([a-f0-9]+)\.json$/.exec(entries[0]) : null;
        if (!match) throw new Error('Setup lock has an unknown owner; preserved');
        const marker = join(lock, entries[0]);
        let recorded: { pid?: number; token?: string };
        try {
          if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) throw new Error('unknown marker');
          recorded = JSON.parse(readFileSync(marker, 'utf8')) as { pid?: number; token?: string };
        } catch { throw new Error('Setup lock has an unknown owner; preserved'); }
        const pid = Number(match[1]);
        if (!recorded || recorded.pid !== pid || recorded.token !== match[2]) throw new Error('Setup lock has an unknown owner; preserved');
        let dead = false;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (probe) { dead = (probe as NodeJS.ErrnoException).code === 'ESRCH'; }
        }
        if (!dead) throw new Error(`Another ftown setup owns the lock (pid ${pid}); retry after it finishes`);
        // An active successor uses a different owner filename. Removing this exact
        // dead marker and rmdir of an empty dir cannot displace a successor.
        try { unlinkSync(join(lock, entries[0])); } catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError; }
        try { rmdirSync(lock); } catch (removeError) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((removeError as NodeJS.ErrnoException).code ?? '')) throw removeError; }
      }
    }
    if (!acquired) throw new Error('Setup lock changed; retry after the other setup finishes');
    return () => {
      try { unlinkSync(join(lock, owner)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { rmdirSync(lock); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    };
  } finally { if (!acquired) rmSync(candidate, { recursive: true, force: true }); }
}
