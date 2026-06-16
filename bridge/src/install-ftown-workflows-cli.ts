import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CANONICAL_WORKFLOWS_CLI_PATH = join(homedir(), '.ftown', 'ftown-workflows');

/** Copy CLI bundle and install ~/.ftown/ftown-workflows launcher. */
export function installFtownWorkflowsCli(compiledCliPath: string): string {
  const ftownDir = join(homedir(), '.ftown');
  const cliJsPath = join(ftownDir, 'ftown-workflows-cli.js');
  // Resolve the launcher path from ftownDir (not the module-level constant) so the
  // whole install is consistent with homedir() at call time and HOME-override-safe.
  const launcherPath = join(ftownDir, 'ftown-workflows');

  mkdirSync(ftownDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(ftownDir, 'package.json'), '{"type":"module"}\n', { mode: 0o644 });
  copyFileSync(compiledCliPath, cliJsPath);
  chmodSync(cliJsPath, 0o644);

  // The compiled CLI imports sibling modules at runtime, so each local dependency
  // must sit alongside it in ~/.ftown.
  const engineSrc = join(dirname(compiledCliPath), 'workflow-runner.js');
  const engineDest = join(ftownDir, 'workflow-runner.js');
  copyFileSync(engineSrc, engineDest);
  chmodSync(engineDest, 0o644);

  const claudeTrustSrc = join(dirname(compiledCliPath), 'claude-trust.js');
  const claudeTrustDest = join(ftownDir, 'claude-trust.js');
  copyFileSync(claudeTrustSrc, claudeTrustDest);
  chmodSync(claudeTrustDest, 0o644);

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
exec node "${cliJsPath}" "$@"
`;
  writeFileSync(launcherPath, launcher, { mode: 0o755 });

  return launcherPath;
}
