import { createHash } from 'node:crypto';
import type { DeriveRng, Rng, StreamLabel } from '../contract.ts';

const TWO32 = 4_294_967_296;

/**
 * Stream = SHA-256 blocks: block_i = sha256(`${seed}:${label}:${i}`), consumed 4 bytes at a
 * time as big-endian u32 (8 values per block). Identical on every platform.
 */
export const deriveRng: DeriveRng = (seed: number, label: StreamLabel): Rng => {
  if (!Number.isSafeInteger(seed)) throw new Error(`deriveRng: seed must be a safe integer, got ${seed}`);
  if (label.includes(':')) throw new Error(`deriveRng: label must not contain ':' (got ${label})`);

  let block: Buffer = Buffer.alloc(0);
  let blockIndex = 0;
  let offset = 0;

  function u32(): number {
    if (offset >= block.length) {
      block = createHash('sha256').update(`${seed}:${label}:${blockIndex}`).digest();
      blockIndex += 1;
      offset = 0;
    }
    const v = block.readUInt32BE(offset);
    offset += 4;
    return v;
  }

  function int(lo: number, hi: number): number {
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi < lo) {
      throw new Error(`rng.int: invalid range [${lo}, ${hi}]`);
    }
    const range = hi - lo + 1;
    if (range > TWO32) throw new Error(`rng.int: range too large [${lo}, ${hi}]`);
    // Rejection sampling: accept only values below the largest multiple of range.
    const limit = Math.floor(TWO32 / range) * range;
    for (;;) {
      const x = u32();
      if (x < limit) return lo + (x % range);
    }
  }

  return {
    u32,
    float: () => u32() / TWO32,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('rng.pick: empty array');
      return items[int(0, items.length - 1)] as T;
    },
    chance: (p: number) => u32() / TWO32 < p,
  };
};
