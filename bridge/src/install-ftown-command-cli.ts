import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';

const require = createRequire(import.meta.url);
export const CLI_RUNTIME_MODULES = [
  'ftown-cli', 'cli-entry', 'cli-client', 'sessions-commands', 'harness-commands', 'env-commands',
  'ftown-home', 'wire-types', 'harness-format', 'provider-env-store', 'setup', 'setup-state', 'setup-migrations',
  'install-ftown-command-cli', 'install-notify-script', 'hook-installer', 'cursor-hook-installer',
  'codex-installer', 'pi-extension-installer', 'opencode-plugin-installer', 'muse-plugin-installer',
  'install-ftown-skill', 'retired-skill-assets', 'harness-installer', 'ensure-ftown-path',
] as const;
const ASSETS = ['hooks', 'pi-extension', 'opencode-plugin', 'muse-plugin', 'skills'] as const;

function assertRealDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error(`Setup refuses symlink directory: ${path}`);
}

function dependencyRoot(path: string): string {
  let dir = dirname(path);
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) throw new Error('Cannot locate CLI dependency package');
    dir = parent;
  }
  return dir;
}

/** Install one self-contained CLI; legacy launchers only select a command group. */
export function installFtownCommandCli(packageRoot: string, home = homedir()): string {
  const ftown = join(home, '.ftown');
  const runtime = join(ftown, 'cli');
  assertRealDirectory(ftown);
  assertRealDirectory(runtime);
  assertRealDirectory(join(runtime, 'dist'));
  if (realpathSync(packageRoot) !== realpathSync(runtime)) {
    for (const module of CLI_RUNTIME_MODULES) {
      const target = join(runtime, 'dist', `${module}.js`);
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`Setup refuses symlink file: ${target}`);
      cpSync(join(packageRoot, 'dist', `${module}.js`), target);
    }
    const packageInfo = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string };
    writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'ftown-cli-runtime', type: 'module', version: packageInfo.version }) + '\n', { mode: 0o600 });
    for (const asset of ASSETS) {
      const target = join(runtime, asset);
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`Setup refuses symlink directory: ${target}`);
      cpSync(join(packageRoot, asset), target, { recursive: true, force: true });
    }
    assertRealDirectory(join(runtime, 'node_modules'));
    const commander = dependencyRoot(require.resolve('commander', { paths: [packageRoot] }));
    const target = join(runtime, 'node_modules', 'commander');
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`Setup refuses symlink dependency: ${target}`);
    cpSync(commander, target, { recursive: true, force: true });
  }
  assertRealDirectory(join(ftown, 'bin'));
  const entry = join(runtime, 'dist', 'ftown-cli.js');
  const quoted = `'${entry.replace(/'/g, `'\\''`)}'`;
  for (const [relative, group] of [['ftown', ''], ['ftown-sessions', 'sessions'], ['ftown-env', 'env'], ['bin/ftown-harness', 'harness']] as const) {
    const path = join(ftown, relative);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Setup refuses foreign launcher symlink: ${path}`);
    writeFileSync(path, `#!/usr/bin/env bash\n# Managed by ftown setup\nset -euo pipefail\nexec node ${quoted}${group ? ` ${group}` : ''} "$@"\n`, { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  return join(ftown, 'ftown');
}
