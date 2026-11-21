import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Install both entrypoints together with their shared implementation and launch config. */
export function installPiExtensions(bundledDir: string, home: string = homedir()): void {
  const dir = join(home, '.ftown', 'pi');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of ['ftown.js', 'omp.js', 'omp.yml']) {
    const destination = join(dir, file);
    copyFileSync(join(bundledDir, file), destination);
    chmodSync(destination, 0o600);
  }
}
