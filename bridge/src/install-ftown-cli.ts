import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CANONICAL_CLI_PATH = join(homedir(), '.ftown', 'ftown-sessions');

/** Copy CLI bundle and install ~/.ftown/ftown-sessions launcher. */
export function installFtownSessionsCli(compiledCliPath: string): string {
  const ftownDir = join(homedir(), '.ftown');
  const cliJsPath = join(ftownDir, 'ftown-sessions-cli.js');
  // Resolve the launcher path from ftownDir (not the module-level constant) so the
  // whole install is consistent with homedir() at call time and HOME-override-safe.
  const launcherPath = join(ftownDir, 'ftown-sessions');

  mkdirSync(ftownDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(ftownDir, 'package.json'), '{"type":"module"}\n', { mode: 0o644 });
  copyFileSync(compiledCliPath, cliJsPath);
  chmodSync(cliJsPath, 0o644);

  // The compiled CLI imports the shared wire-types module at runtime, so it must sit
  // alongside it in ~/.ftown.
  const wireTypesSrc = join(dirname(compiledCliPath), 'wire-types.js');
  const wireTypesDest = join(ftownDir, 'wire-types.js');
  copyFileSync(wireTypesSrc, wireTypesDest);
  chmodSync(wireTypesDest, 0o644);

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
exec node "${cliJsPath}" "$@"
`;
  writeFileSync(launcherPath, launcher, { mode: 0o755 });

  return launcherPath;
}
