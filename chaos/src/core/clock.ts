import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Clock } from '../contract.ts';

/**
 * Shared-epoch clock: now() = floor((process.hrtime.bigint() - t0) / 1e6). t0 defaults to the
 * hrtime at construction; every process of a run passes the supervisor's t0 (see readT0).
 */
export function realClock(opts?: { t0Ns?: bigint }): Clock {
  const t0 = opts?.t0Ns ?? process.hrtime.bigint();
  return {
    now: () => Math.floor(Number(process.hrtime.bigint() - t0) / 1e6),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
  };
}

/** Writes t0 (default: now) as a decimal nanosecond string. Returns the value written. */
export function writeT0(path: string, t0Ns: bigint = process.hrtime.bigint()): bigint {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, t0Ns.toString(10));
  return t0Ns;
}

/** Reads a decimal nanosecond string. Throws (never falls back) when missing or malformed. */
export function readT0(path: string): bigint {
  const text = readFileSync(path, 'utf8').trim();
  if (!/^\d+$/.test(text)) throw new Error(`readT0: ${path} does not hold a decimal nanosecond string`);
  return BigInt(text);
}

export type FakeClock = Clock & { advance(ms: number): Promise<void> };

/** Test clock starting at 0. advance() wakes sleepers in deadline order, ties in call order. */
export function fakeClock(): FakeClock {
  let now = 0;
  let seq = 0;
  const sleepers: { deadline: number; seq: number; resolve: () => void }[] = [];
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  return {
    now: () => now,
    sleep(ms: number): Promise<void> {
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        sleepers.push({ deadline: now + ms, seq: seq++, resolve });
      });
    },
    async advance(ms: number): Promise<void> {
      if (ms < 0) throw new Error('fakeClock.advance: negative');
      const target = now + ms;
      for (;;) {
        let next: (typeof sleepers)[number] | undefined;
        for (const s of sleepers) {
          if (s.deadline <= target && (next === undefined || s.deadline < next.deadline || (s.deadline === next.deadline && s.seq < next.seq))) next = s;
        }
        if (next === undefined) break;
        sleepers.splice(sleepers.indexOf(next), 1);
        now = Math.max(now, next.deadline);
        next.resolve();
        await flush();
      }
      now = target;
    },
  };
}
