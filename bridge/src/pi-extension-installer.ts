import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Copy the bundled ftown Pi extension to the stable path used by launch commands. */
export function installPiExtension(bundledPath: string, home: string = homedir()): string {
  const destination = join(home, '.ftown', 'pi', 'ftown.js');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(bundledPath, destination);
  chmodSync(destination, 0o600);
  return destination;
}
