import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFtownCommandCli } from './install-ftown-command-cli.js';
import { canonicalNotifyPath, canonicalNotifyReady, installNotifyScript } from './install-notify-script.js';
import { installPiExtension } from './pi-extension-installer.js';
import { installClaudeMod } from './claude-mod-installer.js';
import { installClaudeHooks } from './hook-installer.js';
import { installCursorHooks } from './cursor-hook-installer.js';
import { installGrokHooks } from './grok-hook-installer.js';
import { installAntigravityHooks } from './antigravity-hook-installer.js';
import { codexBinaryAvailable, ensureCodexHooks } from './codex-installer.js';
import { opencodeBinaryAvailable, installOpencodePlugin } from './opencode-plugin-installer.js';
import { ensureMusePlugin } from './muse-plugin-installer.js';
import { installFtownSkill, linkFtownSkillForAccount } from './install-ftown-skill.js';
import { writeHarnessAgentGuide } from './harness-installer.js';
import { ensureFtownOnPath } from './ensure-ftown-path.js';
import { readSetupState, writeSetupState, assertSetupReady, acquireSetupLock, assertSetupVersion } from './setup-state.js';
import { runSetupMigrations } from './setup-migrations.js';
import { loadAccounts, type HarnessAccount } from './accounts.js';
import { claudeConfigDir, codexHome } from './config-dirs.js';
import { assertUpdateReservationAllowed } from './update-handoff.js';
import {
  defaultPreflightEnv,
  formatPreflight,
  runPreflight,
  type PreflightEnv,
  type PreflightReport,
} from './setup-preflight.js';

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
  const grok = installGrokHooks(join(root, 'hooks', 'ftown-grok-hook.sh'));
  const antigravity = installAntigravityHooks(join(root, 'hooks', 'ftown-antigravity-hook.sh'));
  const results: IntegrationResult[] = [{ name: 'claude/cursor/pi', status: 'installed' }];
  results.push(grok ? { name: 'grok', status: 'installed' } : { name: 'grok', status: 'skipped', detail: 'not installed or hook setup skipped' });
  results.push(antigravity ? { name: 'antigravity', status: 'installed' } : { name: 'antigravity', status: 'skipped', detail: 'not installed or hook setup skipped' });
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

export function defaultDependencies(): SetupDependencies {
  const withAccountEnv = async <T>(account: HarnessAccount | undefined, task: () => T | Promise<T>): Promise<T> => {
    if (!account) return await task();
    const oldClaude = process.env.CLAUDE_CONFIG_DIR; const oldCodex = process.env.CODEX_HOME;
    if (account.harness === 'claude') process.env.CLAUDE_CONFIG_DIR = account.configDir;
    else process.env.CODEX_HOME = account.configDir;
    try { return await task(); }
    finally {
      if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
      if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    }
  };
  const targets = () => setupAccountTargets();
  return {
    installRuntime: (root) => { installFtownCommandCli(root); },
    integrations: async (root) => {
      const results: IntegrationResult[] = [];
      for (const account of targets()) {
        const current = await withAccountEnv(account, () => installIntegrations(root));
        results.push(...current.map(result => account ? { ...result, name: `${account.id}/${result.name}` } : result));
      }
      return results;
    },
    skillAndPath: (root) => {
      installFtownSkill('ftown', join(root, 'skills', 'ftown'));
      for (const account of targets().slice(1)) if (account) withAccountEnvSync(account, () => installFtownSkill('ftown', join(root, 'skills', 'ftown')));
      writeHarnessAgentGuide({ wrapperPath: join(homedir(), '.ftown', 'bin', 'ftown-harness') });
      ensureFtownOnPath();
    },
    migrate: (repair) => runSetupMigrations(repair),
  };
}

/** Default harness configs plus each registered account's config directory. */
export function setupAccountTargets(): Array<HarnessAccount | undefined> {
  const home = homedir();
  return [undefined, ...loadAccounts().accounts.filter(account => account.configDir !== (account.harness === 'claude' ? claudeConfigDir(home, {}) : codexHome(home, {})))];
}

/** Install only the registered account's harness integration and skill link. */
export async function setupAccount(account: HarnessAccount): Promise<IntegrationResult[]> {
  const release = acquireSetupLock();
  try {
    assertUpdateReservationAllowed(homedir());
    if (!canonicalNotifyReady()) throw new Error('ftown notify script is not installed; run ftown setup');
    const notify = canonicalNotifyPath();
    const result = await withAccountEnv(account, async () => {
      if (account.harness === 'claude') {
        if (!installClaudeHooks(notify)) throw new Error('Claude hook setup failed');
        return { name: 'claude', status: 'installed' } as IntegrationResult;
      }
      if (!await codexBinaryAvailable()) return { name: 'codex', status: 'skipped', detail: 'binary not installed' } as IntegrationResult;
      if (!ensureCodexHooks(join(homedir(), '.ftown', 'bin', 'ftown-harness'), notify)) throw new Error('Codex hook setup failed');
      return { name: 'codex', status: 'installed' } as IntegrationResult;
    });
    linkFtownSkillForAccount(account.configDir);
    return [result, { name: 'skill', status: 'installed' }];
  } finally { release(); }
}

async function withAccountEnv<T>(account: HarnessAccount, task: () => Promise<T>): Promise<T> {
  const oldClaude = process.env.CLAUDE_CONFIG_DIR; const oldCodex = process.env.CODEX_HOME;
  if (account.harness === 'claude') process.env.CLAUDE_CONFIG_DIR = account.configDir;
  else process.env.CODEX_HOME = account.configDir;
  try { return await task(); }
  finally {
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  }
}

function withAccountEnvSync<T>(account: HarnessAccount, task: () => T): T {
  const oldClaude = process.env.CLAUDE_CONFIG_DIR; const oldCodex = process.env.CODEX_HOME;
  if (account.harness === 'claude') process.env.CLAUDE_CONFIG_DIR = account.configDir;
  else process.env.CODEX_HOME = account.configDir;
  try { return task(); }
  finally {
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  }
}

export async function performSetup(options: { root?: string; repair?: boolean; dependencies?: SetupDependencies } = {}): Promise<SetupResult> {
  const root = options.root ?? packageRoot();
  const version = packageVersion(root);
  const release = acquireSetupLock();
  try {
  assertUpdateReservationAllowed(homedir());
  const state = readSetupState();
  let installedVersion = state.packageVersion;
  try { installedVersion = packageVersion(join(homedir(), '.ftown', 'cli')); } catch { /* Fresh runtime; durable ready version still applies. */ }
  assertSetupVersion(version, state.packageVersion);
  assertSetupVersion(version, installedVersion);
  if (!options.repair && state.packageVersion === version && loadAccounts().accounts.length === 0) {
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

export interface SetupCliDeps {
  /** Override the environment probe or the report builder for tests. */
  preflightEnv?: PreflightEnv;
  preflight?: (env: PreflightEnv) => PreflightReport;
  /** Override the installer so a failing preflight can be proven to block it. */
  perform?: typeof performSetup;
}

export async function runSetup(argv: string[], deps: SetupCliDeps = {}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: ftown setup [--repair]\nInstall or upgrade local runtime, integrations, skill and PATH. --repair rechecks current setup and cleanup.\nChecks tmux, git, jq, curl, a usable shell and the Node version first: fails only on required checks, warns on the rest.');
    return 0;
  }
  if (argv.some((arg) => arg !== '--repair')) { console.error('Usage: ftown setup [--repair]'); return 1; }
  try {
    const env = deps.preflightEnv ?? defaultPreflightEnv();
    const report = (deps.preflight ?? runPreflight)(env);
    for (const line of formatPreflight(report)) console.log(line);
    if (!report.ok) {
      for (const problem of report.problems) console.error(`ftown setup: ${problem}`);
      if (report.hint) console.error(`ftown setup: ${report.hint}`);
      return 1;
    }
    const result = await (deps.perform ?? performSetup)({ repair: argv.includes('--repair') });
    console.log(`ftown setup ${result.version}: ${result.action}`);
    for (const integration of result.integrations) console.log(`  ${integration.name}: ${integration.status}${integration.detail ? ` (${integration.detail})` : ''}`);
    console.log('Open a new shell for PATH changes; run ftown start when ready.');
    return 0;
  } catch (error) {
    console.error(`ftown setup: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
