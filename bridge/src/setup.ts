import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFtownCommandCli } from './install-ftown-command-cli.js';
import { installNotifyScript } from './install-notify-script.js';
import { installPiExtension } from './pi-extension-installer.js';
import { installClaudeMod } from './claude-mod-installer.js';
import { installClaudeHooks } from './hook-installer.js';
import { installCursorHooks } from './cursor-hook-installer.js';
import { codexBinaryAvailable, ensureCodexHooks } from './codex-installer.js';
import { opencodeBinaryAvailable, installOpencodePlugin } from './opencode-plugin-installer.js';
import { ensureMusePlugin } from './muse-plugin-installer.js';
import { installFtownSkill } from './install-ftown-skill.js';
import { writeHarnessAgentGuide } from './harness-installer.js';
import { ensureFtownOnPath } from './ensure-ftown-path.js';
import { readSetupState, writeSetupState, assertSetupReady, acquireSetupLock, assertSetupVersion } from './setup-state.js';
import { runSetupMigrations } from './setup-migrations.js';

export interface IntegrationResult { name: string; status: 'installed' | 'skipped'; detail?: string }
export interface SetupDependencies {
  installRuntime: (packageRoot: string) => void;
  integrations: (runtimeRoot: string) => Promise<IntegrationResult[]>;
  skillAndPath: (runtimeRoot: string) => void;
  migrate: (repair: boolean) => string[];
}
export interface SetupResult { version: string; action: 'installed' | 'current'; migrations: string[]; integrations: IntegrationResult[] }

export function packageRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), '..'); }
export function packageVersion(root = packageRoot()): string {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
}

async function installIntegrations(root: string): Promise<IntegrationResult[]> {
  const notify = installNotifyScript(join(root, 'hooks', 'notify.sh'));
  installPiExtension(join(root, 'pi-extension', 'ftown.js'));
  installClaudeMod(join(root, 'claude-mod'));
  if (!installClaudeHooks(notify)) throw new Error('Claude hook setup failed; fix settings.json and rerun ftown setup --repair');
  if (!installCursorHooks(notify)) throw new Error('Cursor hook setup failed; fix hooks.json and rerun ftown setup --repair');
  const results: IntegrationResult[] = [{ name: 'claude/cursor/pi', status: 'installed' }];
  if (await codexBinaryAvailable()) {
    if (!ensureCodexHooks(join(homedir(), '.ftown', 'bin', 'ftown-harness'), notify)) throw new Error('Codex hook setup failed; fix hooks.json and rerun ftown setup --repair');
    results.push({ name: 'codex', status: 'installed' });
  } else results.push({ name: 'codex', status: 'skipped', detail: 'binary not installed' });
  if (await opencodeBinaryAvailable()) {
    installOpencodePlugin(join(root, 'opencode-plugin', 'ftown.js'));
    results.push({ name: 'opencode', status: 'installed' });
  } else results.push({ name: 'opencode', status: 'skipped', detail: 'binary not installed' });
  const muse = await ensureMusePlugin(join(root, 'muse-plugin'));
  if (muse.action === 'skipped') results.push({ name: 'muse', status: 'skipped', detail: muse.warning ?? 'binary not installed' });
  else {
    if (muse.action === 'failed' || !muse.approved || muse.warning) throw new Error(muse.warning ?? 'Muse plugin setup failed; rerun ftown setup --repair');
    results.push({ name: 'muse', status: 'installed' });
  }
  return results;
}

function defaultDependencies(): SetupDependencies {
  return {
    installRuntime: (root) => { installFtownCommandCli(root); },
    integrations: installIntegrations,
    skillAndPath: (root) => {
      installFtownSkill('ftown', join(root, 'skills', 'ftown'));
      writeHarnessAgentGuide({ wrapperPath: join(homedir(), '.ftown', 'bin', 'ftown-harness') });
      ensureFtownOnPath();
    },
    migrate: (repair) => runSetupMigrations(repair),
  };
}

export async function performSetup(options: { root?: string; repair?: boolean; dependencies?: SetupDependencies } = {}): Promise<SetupResult> {
  const root = options.root ?? packageRoot();
  const version = packageVersion(root);
  const release = acquireSetupLock();
  try {
  const state = readSetupState();
  let installedVersion = state.packageVersion;
  try { installedVersion = packageVersion(join(homedir(), '.ftown', 'cli')); } catch { /* Fresh runtime; durable ready version still applies. */ }
  assertSetupVersion(version, state.packageVersion);
  assertSetupVersion(version, installedVersion);
  if (!options.repair && state.packageVersion === version) {
    // Explicit repair is the recovery path for missing assets or new integrations.
    assertSetupReady(version);
    return { version, action: 'current', migrations: [], integrations: [] };
  }
  const deps = options.dependencies ?? defaultDependencies();
  // Invalidate readiness BEFORE changing any integration; a failure remains retryable.
  writeSetupState({ schema: 1, completedMigrations: state.completedMigrations });
  const migrations = deps.migrate(!!options.repair);
  deps.installRuntime(root);
  const installedRoot = join(homedir(), '.ftown', 'cli');
  const integrations = await deps.integrations(installedRoot);
  deps.skillAndPath(installedRoot);
  writeSetupState({ ...readSetupState(), packageVersion: version });
  return { version, action: 'installed', migrations, integrations };
  } finally { release(); }
}

export async function runSetup(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: ftown setup [--repair]\nInstall or upgrade local runtime, integrations, skill and PATH. --repair rechecks current setup and cleanup.');
    return 0;
  }
  if (argv.some((arg) => arg !== '--repair')) { console.error('Usage: ftown setup [--repair]'); return 1; }
  try {
    const result = await performSetup({ repair: argv.includes('--repair') });
    console.log(`ftown setup ${result.version}: ${result.action}`);
    for (const integration of result.integrations) console.log(`  ${integration.name}: ${integration.status}${integration.detail ? ` (${integration.detail})` : ''}`);
    console.log('Open a new shell for PATH changes; run ftown start when ready.');
    return 0;
  } catch (error) {
    console.error(`ftown setup: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
