import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunProfile } from '../contract.ts';

/** The chaos/ directory. */
export const CHAOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = join(CHAOS_DIR, '.cache');
export const OUT_DIR = join(CHAOS_DIR, 'out');
export const QEMU_DIR = join(CHAOS_DIR, 'qemu');
export const BUILD_INFO = join(CACHE_DIR, 'build.json');
export const QEMU_IMAGE = 'ftown-chaos-qemu:dev';
export const DEVBOX_IMAGE = 'ftown-chaos-devbox:dev';
export const DEFAULT_BOX_IMAGE = 'ftown-chaos-box:dev';

export function seedOutDir(seed: number, profile: RunProfile, dropFaults: string | null): string {
  const dir = dropFaults === null ? `${seed}-${profile}` : `${seed}-${profile}-drop-${dropFaults}`;
  return join(OUT_DIR, dir);
}
