// Periodic checkpoints (every checkpointEveryMs of the profile) and the final checkpoint.
import type { Clock, Rec, Snapshot } from '../contract.ts';

/** Poll interval of the stop flag between checkpoints (fixed). */
export const CHECKPOINT_POLL_MS = 1_000;

export interface CheckpointDeps {
  clock: Clock;
  take: () => Promise<Snapshot>;
  log: (rec: Rec) => void;
}

export async function checkpoint(deps: CheckpointDeps, name: string, final: boolean): Promise<void> {
  const t = deps.clock.now();
  const snap = await deps.take();
  deps.log({ k: 'checkpoint', t, name, final, snap });
}

/**
 * Takes `cp<n>` at n * everyMs (n = 1, 2, …) until stop() returns true. A checkpoint
 * whose instant has passed while the previous one ran is taken late, never skipped.
 */
export async function runCheckpoints(deps: CheckpointDeps, everyMs: number, stop: () => boolean): Promise<void> {
  for (let n = 1; ; n++) {
    const due = n * everyMs;
    for (;;) {
      if (stop()) return;
      const wait = due - deps.clock.now();
      if (wait <= 0) break;
      await deps.clock.sleep(Math.min(CHECKPOINT_POLL_MS, wait));
    }
    await checkpoint(deps, `cp${n}`, false);
  }
}
