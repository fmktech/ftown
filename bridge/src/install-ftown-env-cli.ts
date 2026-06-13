import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CANONICAL_ENV_CLI_PATH = join(homedir(), '.ftown', 'ftown-env');

/** Copy the CLI bundle and install the ~/.ftown/ftown-env launcher. */
export function installFtownEnvCli(compiledCliPath: string): string {
  const ftownDir = join(homedir(), '.ftown');
  const cliJsPath = join(ftownDir, 'ftown-env-cli.js');
  // Resolve the launcher path from ftownDir (not the module-level constant) so the
  // whole install is consistent with homedir() at call time and HOME-override-safe.
  const launcherPath = join(ftownDir, 'ftown-env');

  mkdirSync(ftownDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(ftownDir, 'package.json'), '{"type":"module"}\n', { mode: 0o644 });

  copyFileSync(compiledCliPath, cliJsPath);
  chmodSync(cliJsPath, 0o644);

  // The compiled CLI does `import './provider-env-store.js'` at runtime, so the
  // store module must sit alongside it. The store has no further local imports,
  // so a single sibling copy is sufficient.
  const storeSrc = join(dirname(compiledCliPath), 'provider-env-store.js');
  const storeDest = join(ftownDir, 'provider-env-store.js');
  copyFileSync(storeSrc, storeDest);
  chmodSync(storeDest, 0o644);

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
exec node "${cliJsPath}" "$@"
`;
  writeFileSync(launcherPath, launcher, { mode: 0o755 });

  return launcherPath;
}
