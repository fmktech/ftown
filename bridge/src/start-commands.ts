import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debuglog } from 'node:util';
import { assertUpdateReservationAllowed } from './update-handoff.js';
import { acquireSetupLock, assertSetupReady, readSetupState } from './setup-state.js';
import { packageVersion } from './setup.js';

interface BridgeEntry {
  runBridge(argv: string[], commandName?: string): Promise<number>;
}

export interface StartDependencies {
  assertReady(): void;
  loadBridge(): Promise<BridgeEntry>;
  env?: NodeJS.ProcessEnv;
  version?: () => string;
  fetchLatest?: () => Promise<string>;
  spawn?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  debug?: (message: string) => void;
  beginUpgrade?: () => UpgradeTransaction;
}

export interface UpgradeTransaction { commit(): void; rollback(): Promise<'current' | 'installed'> | 'current' | 'installed' }

/** Snapshot the runtime while leaving the live installation in place. */
export function beginUpgrade(home = homedir(), version = packageVersion(), clock: { now(): number; wait(ms: number): Promise<void> } = {
  now: Date.now, wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
}): UpgradeTransaction {
  const parent = join(home, '.ftown'); const runtime = join(parent, 'cli'); const state = join(parent, 'setup-state.json');
  const release = acquireSetupLock(home);
  let backup = '';
  try {
    assertSetupReady(version, home);
    const runtimeStat = lstatSync(runtime); const stateStat = lstatSync(state);
    if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || !stateStat.isFile() || stateStat.isSymbolicLink()) throw new Error('Unsafe existing ftown installation');
    backup = mkdtempSync(join(parent, '.startup-upgrade-'));
    // The private backup survives interruption and contains the exact state bytes.
    cpSync(runtime, join(backup, 'cli'), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    writeFileSync(join(backup, 'setup-state.json'), readFileSync(state), { mode: 0o600, flag: 'wx' });
  } finally { release(); }
  const savedRuntime = join(backup, 'cli');
  // Delete only regular files accounted for by an installer inventory.
  const cleanup = () => {
    try {
      const inventoryFiles = (dir: string): string[] => {
        try {
          const inventory = JSON.parse(readFileSync(join(dir, 'installation.json'), 'utf8')) as { files: unknown };
          return Array.isArray(inventory.files) && inventory.files.every(item => typeof item === 'string') ? inventory.files : [];
        } catch { return []; }
      };
      const failed = join(backup, 'failed-cli');
      const allowed = new Set([...inventoryFiles(savedRuntime), ...inventoryFiles(failed), 'installation.json']);
      const safe = (dir: string, prefix = ''): boolean => readdirSync(dir).every(name => {
        const rel = prefix ? `${prefix}/${name}` : name; const path = join(dir, name); const stat = lstatSync(path);
        return stat.isDirectory() && !stat.isSymbolicLink() ? safe(path, rel) : stat.isFile() && !stat.isSymbolicLink() && allowed.has(rel);
      });
      for (const dir of [savedRuntime, failed]) {
        if (!existsSync(dir)) continue;
        if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink() || !safe(dir)) throw new Error('unrecognized backup contents');
        rmSync(dir, { recursive: true });
      }
      rmSync(join(backup, 'setup-state.json')); rmdirSync(backup);
    } catch { console.warn(`ftown: preserved upgrade recovery data at ${backup}`); }
  };
  return {
    commit: cleanup,
    async rollback() {
      // Another setup can begin after the child exits. Wait for its lock rather
      // than displacing it; an unknown owner or timeout remains a hard failure.
      // Allow up to 60 seconds for a concurrent setup to release its lock.
      const deadline = clock.now() + 60_000;
      let unlock: (() => void) | undefined;
      while (!unlock) {
        try { unlock = acquireSetupLock(home); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('Another ftown setup owns the lock') || clock.now() >= deadline) throw error;
          await clock.wait(Math.min(50, deadline - clock.now()));
        }
      }
      try {
        const stateStat = lstatSync(state);
        if (!stateStat.isFile() || stateStat.isSymbolicLink()) throw new Error(`Unsafe setup state; backup preserved at ${backup}`);
        const rawState = JSON.parse(readFileSync(state, 'utf8')) as { schema?: unknown; completedMigrations?: unknown };
        if (!rawState || rawState.schema !== 1 || !Array.isArray(rawState.completedMigrations) || !rawState.completedMigrations.every(id => typeof id === 'string')) {
          throw new Error(`Invalid setup state; backup preserved at ${backup}`);
        }
        const after = readSetupState(home);
        if (after.packageVersion) {
          try {
            assertSetupReady(after.packageVersion, home);
            const result = after.packageVersion === version ? 'current' : 'installed';
            cleanup();
            return result;
          } catch { /* An incomplete installation needs the preserved snapshot. */ }
        }
        if (existsSync(state)) {
          const stat = lstatSync(state);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe setup state; backup preserved at ${backup}`);
        }
        // Preserve failed content until it has been verified for safe cleanup.
        if (existsSync(runtime)) renameSync(runtime, join(backup, 'failed-cli'));
        cpSync(savedRuntime, runtime, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        const previous = JSON.parse(readFileSync(join(backup, 'setup-state.json'), 'utf8')) as { schema: 1; packageVersion?: string; completedMigrations: string[] };
        previous.completedMigrations = [...new Set([...previous.completedMigrations, ...after.completedMigrations])];
        const temporary = join(backup, 'restore-state.json');
        writeFileSync(temporary, JSON.stringify(previous, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        renameSync(temporary, state);
        assertSetupReady(version, home);
        cleanup();
        return 'current';
      } finally { unlock(); }
    },
  };
}

async function latestVersion(): Promise<string> {
  const response = await fetch('https://registry.npmjs.org/ftown/latest', { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`registry returned ${response.status}`);
  const data = await response.json() as { version?: unknown };
  if (typeof data.version !== 'string') throw new Error('invalid registry response');
  return data.version;
}

// SemVer precedence, including prereleases; invalid versions are rejected.
function parseVersion(value: string): { core: bigint[]; pre: string[] } | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return undefined;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return undefined;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest); const b = parseVersion(current);
  if (!a || !b) throw new Error('invalid semver');
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length && b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return false;
    if (b.pre[i] === undefined) return true;
    if (a.pre[i] === b.pre[i]) continue;
    const an = /^\d+$/.test(a.pre[i]); const bn = /^\d+$/.test(b.pre[i]);
    if (an && bn) return BigInt(a.pre[i]) > BigInt(b.pre[i]);
    if (an !== bn) return !an;
    return a.pre[i] > b.pre[i];
  }
  return false;
}

async function spawnCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const dependencies: StartDependencies = {
  assertReady: () => { assertUpdateReservationAllowed(homedir()); assertSetupReady(packageVersion()); },
  loadBridge: () => import('./index.js'),
};

/** Reject incomplete installations before loading the bridge's native dependencies. */
export async function runStart(argv: string[], deps: StartDependencies = dependencies): Promise<number> {
  const env = deps.env ?? process.env;
  const args = argv.filter(arg => arg !== '--no-update');
  const helpOnly = args.length === 1 && (args[0] === '--help' || args[0] === '-h');
  const skipUpdate = argv.includes('--no-update') || argv.includes('--help') || argv.includes('-h')
    || env.FTOWN_NO_AUTO_UPDATE === '1' || env.FTOWN_UPGRADE_DONE === '1' || !!env.FTOWN_VERSION
    || !!env.CI || !!env.NODE_TEST_CONTEXT || env.NODE_ENV === 'test';
  if (!skipUpdate) {
    let latest: string | undefined;
    try {
      const candidate = await (deps.fetchLatest ?? latestVersion)();
      const current = (deps.version ?? packageVersion)();
      if (isNewerVersion(candidate, current)) {
        latest = candidate;
        console.log(`Upgrading ftown ${current} to ${latest} before starting.`);
      }
    } catch (error) {
      (deps.debug ?? debuglog('ftown'))(`ftown update check skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (latest) {
      // Setup can invalidate readiness or replace files even when it fails.
      // Load the current bridge first so it remains available for fallback.
      deps.assertReady();
      const currentBridge = await deps.loadBridge();
      const transaction = (deps.beginUpgrade ?? beginUpgrade)();
      const run = deps.spawn ?? spawnCommand;
      let setupSucceeded = false;
      try { setupSucceeded = await run('npx', ['-y', `ftown@${latest}`, 'setup'], env) === 0; }
      catch { /* report below and continue with this version */ }
      if (setupSucceeded) {
        transaction.commit();
        return await run(process.execPath, [join(homedir(), '.ftown', 'cli', 'dist', 'ftown-cli.js'), 'start', ...argv], { ...env, FTOWN_UPGRADE_DONE: '1' });
      }
      let restored: 'current' | 'installed';
      try { restored = await transaction.rollback(); }
      catch (error) { throw new Error(`ftown upgrade failed and the previous installation could not be restored: ${error instanceof Error ? error.message : String(error)}`); }
      if (restored === 'installed') {
        console.warn('ftown: upgrade setup failed; starting the valid installed version.');
        return await run(process.execPath, [join(homedir(), '.ftown', 'cli', 'dist', 'ftown-cli.js'), 'start', ...argv], { ...env, FTOWN_UPGRADE_DONE: '1' });
      }
      console.warn('ftown: upgrade setup failed; starting the current version. Run ftown setup to retry.');
      return currentBridge.runBridge(args, 'ftown start');
    }
  }
  if (!helpOnly) deps.assertReady();
  const bridge = await deps.loadBridge();
  const result = await bridge.runBridge(args, 'ftown start');
  if (helpOnly) console.log('  --no-update  Skip the automatic npm version check');
  return result;
}
