import type { Loop } from "@/types";
import { FACTORY_GROUP_PREFIX, type FactoryInfo } from "./types";

export type UpdateFactoryLoop = (
  bridgeId: string,
  loopId: string,
  patch: { enabled: boolean },
) => Promise<Loop>;

export type DeleteFactoryLoop = (bridgeId: string, loopId: string) => Promise<boolean>;

/** Exact factory membership: group alone is not enough because two repositories
 * with the same project name can exist on the same bridge. */
export function loopsForFactory(factory: FactoryInfo, loops: Loop[]): Loop[] {
  const group = `${FACTORY_GROUP_PREFIX}${factory.project}`;
  return loops.filter(
    (loop) =>
      loop.bridgeId === factory.bridgeId
      && loop.group === group
      && loop.workdir === factory.repoRoot,
  );
}

export async function setFactoryLoopsEnabled(
  factory: FactoryInfo,
  loops: Loop[],
  enabled: boolean,
  updateLoop: UpdateFactoryLoop,
): Promise<void> {
  const targets = loopsForFactory(factory, loops).filter((loop) => loop.enabled !== enabled);
  const results = await Promise.allSettled(
    targets.map((loop) => updateLoop(loop.bridgeId, loop.id, { enabled })),
  );
  const failed = targets.filter((_, index) => results[index].status === "rejected");
  if (failed.length > 0) {
    throw new Error(
      `${enabled ? "Resume" : "Pause"} failed for: ${failed.map((loop) => loop.name).join(", ")}`,
    );
  }
}

/** Pause every scheduler first, then remove all of them. If pausing is not
 * completely successful, nothing is deleted. Ticket/runtime files are never
 * touched by this operation. */
export async function teardownFactoryLoops(
  factory: FactoryInfo,
  loops: Loop[],
  updateLoop: UpdateFactoryLoop,
  deleteLoop: DeleteFactoryLoop,
): Promise<void> {
  const targets = loopsForFactory(factory, loops);
  await setFactoryLoopsEnabled(factory, targets, false, updateLoop);

  const results = await Promise.allSettled(
    targets.map(async (loop) => {
      const removed = await deleteLoop(loop.bridgeId, loop.id);
      if (!removed) throw new Error("Loop was not removed");
    }),
  );
  const failed = targets.filter((_, index) => results[index].status === "rejected");
  if (failed.length > 0) {
    const deletedCount = targets.length - failed.length;
    throw new Error(
      `Deleted ${deletedCount} of ${targets.length} scheduling loops. Could not delete: ${failed.map((loop) => loop.name).join(", ")}`,
    );
  }
}
