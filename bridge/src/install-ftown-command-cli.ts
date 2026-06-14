import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CANONICAL_FTOWN_CLI_PATH = join(homedir(), '.ftown', 'ftown');

/** Copy the CLI bundle and install the top-level ~/.ftown/ftown launcher. */
export function installFtownCommandCli(compiledCliPath: string): string {
  const ftownDir = join(homedir(), '.ftown');
  const cliJsPath = join(ftownDir, 'ftown-cli.js');
  // Resolve the launcher path from ftownDir (not the module-level constant) so the
  // whole install is consistent with homedir() at call time and HOME-override-safe.
  const launcherPath = join(ftownDir, 'ftown');

  mkdirSync(ftownDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(ftownDir, 'package.json'), '{"type":"module"}\n', { mode: 0o644 });

  // The dispatcher imports ONLY node builtins, so a single bundle copy suffices —
  // no sibling module needs to sit alongside it (unlike the env/workflows CLIs).
  copyFileSync(compiledCliPath, cliJsPath);
  chmodSync(cliJsPath, 0o644);

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
exec node "${cliJsPath}" "$@"
`;
  writeFileSync(launcherPath, launcher, { mode: 0o755 });

  return launcherPath;
}
