import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { CLI_LAUNCHERS, REQUIRED_RUNTIME_FILES, RUNTIME_DIRECTORIES, RUNTIME_INVENTORY_FILE, parseRuntimeInventory } from './installation-manifest.js';
import { assertNoSymlinks, copyProductionDependencies, copyRuntimeTree } from './production-dependencies.js';
export { CLI_RUNTIME_MODULES } from './installation-manifest.js';

function assertRealDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error(`Setup refuses symlink directory: ${path}`);
}

/** Install one self-contained CLI; legacy launchers only select a command group. */
export function installFtownCommandCli(packageRoot: string, home = homedir()): string {
  const ftown = join(home, '.ftown');
  const runtime = join(ftown, 'cli');
  assertRealDirectory(ftown);
  assertRealDirectory(runtime);
  assertNoSymlinks(runtime);
  if (realpathSync(packageRoot).startsWith(`${realpathSync(runtime)}${sep}`)) throw new Error('Setup source must not be nested inside its managed runtime');
  if (realpathSync(packageRoot) !== realpathSync(runtime)) {
    const packageInfo = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string };
    if (typeof packageInfo.version !== 'string') throw new Error('Package version is missing');
    const files = ['package.json'];
    for (const asset of [...RUNTIME_DIRECTORIES, 'node_modules']) rmSync(join(runtime, asset), { recursive: true, force: true });
    for (const directory of RUNTIME_DIRECTORIES) {
      files.push(...copyRuntimeTree(join(packageRoot, directory), join(runtime, directory), runtime));
    }
    files.push(...copyProductionDependencies(packageRoot, runtime));
    const inventory = parseRuntimeInventory({ schema: 1, packageVersion: packageInfo.version, files: [...new Set(files)].sort() });
    writeFileSync(join(runtime, 'package.json'), JSON.stringify(packageInfo) + '\n', { mode: 0o600 });
    writeFileSync(join(runtime, RUNTIME_INVENTORY_FILE), JSON.stringify(inventory) + '\n', { mode: 0o600 });
  } else {
    const inventory = parseRuntimeInventory(JSON.parse(readFileSync(join(runtime, RUNTIME_INVENTORY_FILE), 'utf8')));
    for (const file of [...REQUIRED_RUNTIME_FILES, ...inventory.files]) {
      if (!existsSync(join(runtime, file)) || !lstatSync(join(runtime, file)).isFile()) throw new Error('Installed FTown runtime is incomplete. Repair from the matching npx ftown@VERSION setup --repair package.');
    }
  }
  assertRealDirectory(join(ftown, 'bin'));
  const entry = join(runtime, 'dist', 'ftown-cli.js');
  const quoted = `'${entry.replace(/'/g, `'\\''`)}'`;
  for (const { path: relative, group } of CLI_LAUNCHERS) {
    const path = join(ftown, relative);
    try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Setup refuses foreign launcher symlink: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    writeFileSync(path, `#!/usr/bin/env bash\n# Managed by ftown setup\nset -euo pipefail\nexec node ${quoted}${group ? ` ${group}` : ''} "$@"\n`, { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  return join(ftown, 'ftown');
}
