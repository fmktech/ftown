import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

interface PackageMetadata {
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bundledDependencies?: string[]; bundleDependencies?: string[];
}
interface Dependency { source: string; target: string }

function metadata(directory: string): PackageMetadata {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as PackageMetadata;
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}
function moduleTreeRoot(packageRoot: string): string {
  const parent = dirname(packageRoot);
  if (basename(parent) === 'node_modules') return parent;
  if (basename(parent).startsWith('@') && basename(dirname(parent)) === 'node_modules') return dirname(parent);
  return join(packageRoot, 'node_modules');
}
function findDependency(from: string, name: string): string | undefined {
  if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) || name.split('/').some((part) => part === '.' || part === '..')) throw new Error(`Invalid production dependency name: ${name}`);
  let current = from;
  for (;;) {
    const candidate = join(current, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Preserve each resolved production edge, including root-local/outer-hoisted version conflicts. */
export function productionDependencies(packageRoot: string): Dependency[] {
  const root = realpathSync(packageRoot); const tree = moduleTreeRoot(root);
  const packages = new Map<string, Dependency>(); const queue: Dependency[] = [];
  function edges(directory: string): Array<{ name: string; source: string }> {
    const pkg = metadata(directory);
    const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}), ...(pkg.bundledDependencies ?? pkg.bundleDependencies ?? [])]);
    const result: Array<{ name: string; source: string }> = [];
    for (const name of names) {
      const source = findDependency(directory, name);
      const optional = Object.hasOwn(pkg.optionalDependencies ?? {}, name) || pkg.peerDependenciesMeta?.[name]?.optional;
      if (!source) {
        if (optional) continue;
        throw new Error(`Missing production dependency ${name} required by ${directory}`);
      }
      if (!inside(tree, source) || !inside(tree, realpathSync(source))) throw new Error(`Production dependency escapes its module tree: ${name}`);
      result.push({ name, source });
    }
    return result;
  }
  function add(source: string, target: string): void {
    const previous = packages.get(target);
    if (previous) {
      if (previous.source !== source) throw new Error(`Production dependency placement conflict: ${target}`);
      return;
    }
    const dependency = { source, target }; packages.set(target, dependency); queue.push(dependency);
  }
  function accessible(from: string, name: string): Dependency | undefined {
    let current = from;
    for (;;) {
      if (basename(current) !== 'node_modules') {
        const dependency = packages.get(join(current, 'node_modules', name));
        if (dependency) return dependency;
      }
      const parent = dirname(current);
      if (current === '.' || parent === current) return undefined;
      current = parent;
    }
  }
  // Reserve direct dependencies before hoisting transitive ones: the application wins its own slots.
  for (const edge of edges(root)) add(edge.source, join('node_modules', edge.name));
  for (let index = 0; index < queue.length; index++) {
    const owner = queue[index];
    for (const edge of edges(owner.source)) {
      const existing = accessible(owner.target, edge.name);
      if (existing?.source === edge.source) continue;
      const sourceLocal = inside(join(owner.source, 'node_modules'), edge.source);
      const target = existing || sourceLocal ? join(owner.target, 'node_modules', edge.name) : join('node_modules', edge.name);
      add(edge.source, target);
    }
  }
  return [...packages.values()].sort((a, b) => a.target.localeCompare(b.target));
}

export function assertSafeDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error(`Setup refuses symlink or non-directory: ${path}`);
}

export function assertNoSymlinks(path: string): void {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) throw new Error(`Setup refuses symlink: ${path}`);
  if (stat.isDirectory()) for (const name of readdirSync(path)) assertNoSymlinks(join(path, name));
}

/** Copy own package files and native assets; node_modules are reconstructed from the production graph. */
export function copyRuntimeTree(source: string, target: string, inventoryRoot: string): string[] {
  if (!inside(inventoryRoot, target)) throw new Error('Runtime target escapes installation directory');
  const files: string[] = [];
  function copy(from: string, to: string): void {
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`Setup refuses source symlink: ${from}`);
    if (stat.isDirectory()) {
      assertSafeDirectory(to);
      for (const name of readdirSync(from).sort()) {
        if (name !== 'node_modules') copy(join(from, name), join(to, name));
      }
    } else if (stat.isFile()) {
      let targetStat;
      try { targetStat = lstatSync(to); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile())) throw new Error(`Setup refuses unsafe runtime file: ${to}`);
      writeFileSync(to, readFileSync(from), { mode: stat.mode & 0o777 });
      chmodSync(to, stat.mode & 0o777);
      files.push(relative(inventoryRoot, to).split(sep).join('/'));
    } else throw new Error(`Unsupported runtime asset: ${from}`);
  }
  copy(source, target);
  return files;
}

/** Public fixture/installer helper: package metadata is copied separately by its caller. */
export function copyProductionDependencies(packageRoot: string, targetRoot: string): string[] {
  const dependencies = productionDependencies(packageRoot); const files: string[] = [];
  assertSafeDirectory(targetRoot);
  assertSafeDirectory(join(targetRoot, 'node_modules'));
  for (const dependency of dependencies) {
    const target = join(targetRoot, dependency.target);
    // Check every ancestor before mkdir/copy so a nested/scoped symlink cannot redirect writes.
    let directory = targetRoot;
    for (const part of dependency.target.split(sep)) { directory = join(directory, part); assertSafeDirectory(directory); }
    files.push(...copyRuntimeTree(dependency.source, target, targetRoot));
  }
  return files;
}
