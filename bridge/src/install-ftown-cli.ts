import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CANONICAL_CLI_PATH = join(homedir(), '.ftown', 'ftown-sessions');

/** Copy CLI bundle and install ~/.ftown/ftown-sessions launcher. */
export function installFtownSessionsCli(compiledCliPath: string): string {
  const ftownDir = join(homedir(), '.ftown');
  const cliJsPath = join(ftownDir, 'ftown-sessions-cli.js');

  mkdirSync(ftownDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(ftownDir, 'package.json'), '{"type":"module"}\n', { mode: 0o644 });
  copyFileSync(compiledCliPath, cliJsPath);
  chmodSync(cliJsPath, 0o644);

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
exec node "${cliJsPath}" "$@"
`;
  writeFileSync(CANONICAL_CLI_PATH, launcher, { mode: 0o755 });

  return CANONICAL_CLI_PATH;
}
