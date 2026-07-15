import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resetSpawnStaggerForTest, staggerSpawn } from './spawn-stagger.js';

interface FakeClock {
  now: () => number;
  advanceTo: (t: number) => void;
  /** sleep(ms) records the caller's absolute wake time (now + ms). */
  sleep: (ms: number) => Promise<void>;
  wakeTimes: number[];
}

function makeFakeClock(start = 0): FakeClock {
  let current = start;
  const wakeTimes: number[] = [];
  return {
    now: () => current,
    advanceTo: (t: number) => { current = t; },
    sleep: async (ms: number) => { wakeTimes.push(current + ms); },
    wakeTimes,
  };
}

describe('staggerSpawn', () => {
  beforeEach(() => resetSpawnStaggerForTest());

  it('serializes 9 concurrent callers at exactly 0, 300, 600, ... intervals', async () => {
    const clock = makeFakeClock(0);
    const slots: number[] = [];

    await Promise.all(
      Array.from({ length: 9 }, (_, i) => {
        let slept = false;
        return staggerSpawn('spawn:cursor', 300, {
          now: clock.now,
          // now() is frozen at 0, so the sleep duration IS the absolute slot.
          sleep: async (ms) => { slept = true; slots[i] = ms; },
        }).then(() => {
          if (!slept) slots[i] = clock.now(); // zero-wait caller: slot = now
        });
      }),
    );

    assert.deepEqual(slots, [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400]);
  });

  it('a caller arriving after the queue drained gets slot=now (no residual delay)', async () => {
    const clock = makeFakeClock(0);
    await Promise.all(
      Array.from({ length: 3 }, () =>
        staggerSpawn('spawn:cursor', 300, { now: clock.now, sleep: clock.sleep }),
      ),
    );
    assert.deepEqual(clock.wakeTimes, [300, 600]);

    // Queue drained at t=600; arrive well after lastSlot + gap.
    clock.advanceTo(10_000);
    await staggerSpawn('spawn:cursor', 300, { now: clock.now, sleep: clock.sleep });
    // No new sleep — resolved immediately at now.
    assert.deepEqual(clock.wakeTimes, [300, 600]);

    // And the next concurrent caller staggers off the NEW slot, not the old one.
    await staggerSpawn('spawn:cursor', 300, { now: clock.now, sleep: clock.sleep });
    assert.deepEqual(clock.wakeTimes, [300, 600, 10_300]);
  });

  it('different keys do not serialize each other', async () => {
    const clock = makeFakeClock(0);
    await Promise.all([
      staggerSpawn('spawn:cursor', 300, { now: clock.now, sleep: clock.sleep }),
      staggerSpawn('spawn:other', 300, { now: clock.now, sleep: clock.sleep }),
    ]);
    // Each key's first caller waits zero — no sleeps at all.
    assert.deepEqual(clock.wakeTimes, []);
  });
});
