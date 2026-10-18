import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Inputs that can alter the npm payload or its build; unrelated tooling stays outside bridge. */
export function isPackageChange(path) {
  if (!path.startsWith('bridge/')) return false;
  const relative = path.slice('bridge/'.length);
  if (/^(dist|bin|hooks|pi-extension|opencode-plugin|muse-plugin|skills)\//.test(relative)) return true;
  if (/^src\//.test(relative)) return !/\.test\.ts$|\.(md|txt|rst)$/i.test(relative);
  if (/^(README|LICENSE|LICENCE|COPYING)(\.|$)/i.test(relative)) return true;
  if (/^(docs|tests?|e2e)\//.test(relative) || relative === 'AGENTS.md' || /\.test\.[cm]?[jt]s$/.test(relative)) return false;
  if (/\.md$/i.test(relative) || /(^|\/)(eslint|vitest|jest|prettier)\.config\./.test(relative)) return false;
  return true; // New build/package inputs fail conservatively rather than silently missing a release.
}

export function changedPackageFiles(base, head, run = execFileSync) {
  return run('git', ['diff', '--name-only', '--no-renames', '-z', base, head, '--', 'bridge/'], { encoding: 'utf8' })
    .split('\0').filter((path) => path && isPackageChange(path));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [base, head] = process.argv.slice(2);
    if (base !== '--force' && (!base || !head)) throw new Error('Expected BASE HEAD, or --force for an explicit release');
    const files = base === '--force' ? [] : changedPackageFiles(base, head);
    const packageChanged = base === '--force' || files.length > 0;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `package_changed=${packageChanged}\n`);
    console.log(JSON.stringify({ packageChanged, files }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
