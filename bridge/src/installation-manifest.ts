/** One installation inventory for copying, launchers and read-only readiness. */
export const CLI_RUNTIME_MODULES = [
  'ftown-cli', 'start-commands', 'index', 'cli-entry', 'cli-client', 'sessions-commands', 'harness-commands', 'env-commands',
  'ftown-home', 'wire-types', 'harness-format', 'provider-env-store', 'setup', 'setup-state', 'setup-migrations',
  'installation-manifest', 'production-dependencies', 'attention-store', 'push-notifier',
  'install-ftown-command-cli', 'install-notify-script', 'hook-installer', 'cursor-hook-installer',
  'codex-installer', 'pi-extension-installer', 'opencode-plugin-installer', 'muse-plugin-installer',
  'install-ftown-skill', 'retired-skill-assets', 'harness-installer', 'ensure-ftown-path',
] as const;
export const RUNTIME_DIRECTORIES = ['dist', 'bin', 'hooks', 'pi-extension', 'opencode-plugin', 'muse-plugin', 'skills'] as const;
export const CLI_LAUNCHERS = [
  { path: 'ftown', group: '' }, { path: 'ftown-sessions', group: 'sessions' },
  { path: 'ftown-env', group: 'env' }, { path: 'bin/ftown-harness', group: 'harness' },
] as const;
export const RUNTIME_INVENTORY_FILE = 'installation.json';
export const REQUIRED_RUNTIME_FILES: readonly string[] = ['package.json', ...CLI_RUNTIME_MODULES.map((name) => `dist/${name}.js`)];
export const REQUIRED_SETUP_ASSETS: readonly string[] = [
  ...CLI_LAUNCHERS.map(({ path }) => path), 'notify.sh', 'pi/ftown.js', 'harness-agent.md', 'skills/ftown/SKILL.md',
  ...REQUIRED_RUNTIME_FILES.map((path) => `cli/${path}`), `cli/${RUNTIME_INVENTORY_FILE}`,
  'cli/hooks/notify.sh', 'cli/pi-extension/ftown.js', 'cli/opencode-plugin/ftown.js',
  'cli/muse-plugin/.muse-plugin/plugin.json', 'cli/skills/ftown/SKILL.md',
];

export interface RuntimeInventory { schema: 1; packageVersion: string; files: string[] }
export function parseRuntimeInventory(value: unknown): RuntimeInventory {
  if (!value || typeof value !== 'object') throw new Error('Invalid installed runtime inventory');
  const data = value as Partial<RuntimeInventory>;
  if (data.schema !== 1 || typeof data.packageVersion !== 'string' || !Array.isArray(data.files)
    || !data.files.every((path) => typeof path === 'string' && path.length > 0 && !path.includes('\\')
      && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))
    || new Set(data.files).size !== data.files.length
    || REQUIRED_RUNTIME_FILES.some((path) => !data.files?.includes(path))) throw new Error('Invalid installed runtime inventory');
  return { schema: 1, packageVersion: data.packageVersion, files: data.files };
}
