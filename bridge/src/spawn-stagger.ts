/**
 * Per-key spawn stagger: serializes concurrent callers of the same key so
 * their spawns land at least `minGapMs` apart.
 *
 * Why: some harness CLIs (cursor-agent) refresh an auth token on startup with
 * a read-modify-write against the macOS Keychain. Two or more concurrent
 * startups race that write (pure last-writer-wins) and corrupt the stored
 * credential. Spacing spawns by a small gap fully eliminates the race.
 *
 * Algorithm: a monotonic slot reservation per key. Each caller SYNCHRONOUSLY
 * (before any await — this is what makes it lock-free under the single-threaded
 * event loop) reserves `slot = max(now, lastSlot + minGapMs)`, records it as
 * the new lastSlot, then sleeps until its slot. N concurrent callers therefore
 * serialize at exactly `minGapMs` intervals; a caller arriving after the queue
 * has drained (now >= lastSlot + minGapMs) gets slot = now and no delay.
 */

const lastSlotByKey = new Map<string, number>();

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function staggerSpawn(
  key: string,
  minGapMs: number,
  opts?: { now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const now = opts?.now ?? Date.now;
  const sleep = opts?.sleep ?? defaultSleep;

  // Reserve the slot synchronously — no await may happen before this point.
  const arrival = now();
  const lastSlot = lastSlotByKey.get(key);
  const slot = lastSlot === undefined ? arrival : Math.max(arrival, lastSlot + minGapMs);
  lastSlotByKey.set(key, slot);

  const waitMs = slot - arrival;
  return waitMs > 0 ? sleep(waitMs) : Promise.resolve();
}

/** Clears all reserved slots. Test seam only. */
export function resetSpawnStaggerForTest(): void {
  lastSlotByKey.clear();
}
