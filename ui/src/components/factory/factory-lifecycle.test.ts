import { describe, expect, it, vi } from "vitest";
import type { Loop } from "@/types";
import type { FactoryInfo } from "./types";
import {
  loopsForFactory,
  setFactoryLoopsEnabled,
  teardownFactoryLoops,
} from "./factory-lifecycle";

const factory: FactoryInfo = {
  project: "ftown",
  repoRoot: "/repos/ftown",
  bridgeId: "bridge-a",
};

function loop(overrides: Partial<Loop> & Pick<Loop, "id" | "name">): Loop {
  const { id, name, ...rest } = overrides;
  return {
    id,
    name,
    bridgeId: "bridge-a",
    group: "Factory: ftown",
    workdir: "/repos/ftown",
    enabled: true,
    schedule: { kind: "interval", everyMs: 30_000 },
    task: "task",
    shellType: "shell",
    overlapPolicy: "skip",
    retention: 10,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...rest,
  } as Loop;
}

describe("factory lifecycle", () => {
  it("matches loops by bridge, group, and repository", () => {
    const matching = loop({ id: "dispatch", name: "ftown-dispatch" });
    const loops = [
      matching,
      loop({ id: "other-bridge", name: "other", bridgeId: "bridge-b" }),
      loop({ id: "other-repo", name: "other", workdir: "/repos/another-ftown" }),
      loop({ id: "other-group", name: "other", group: "Factory: api" }),
    ];

    expect(loopsForFactory(factory, loops)).toEqual([matching]);
  });

  it("only updates loops whose enabled state needs to change", async () => {
    const update = vi.fn().mockImplementation(async (_bridgeId, _loopId, patch) =>
      loop({ id: _loopId, name: _loopId, enabled: patch.enabled }),
    );
    const loops = [
      loop({ id: "dispatch", name: "dispatch", enabled: true }),
      loop({ id: "triage", name: "triage", enabled: false }),
    ];

    await setFactoryLoopsEnabled(factory, loops, false, update);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("bridge-a", "dispatch", { enabled: false });
  });

  it("pauses every loop before deleting and never touches factory data", async () => {
    const calls: string[] = [];
    const update = vi.fn().mockImplementation(async (_bridgeId, loopId) => {
      calls.push(`pause:${loopId}`);
      return loop({ id: loopId, name: loopId, enabled: false });
    });
    const remove = vi.fn().mockImplementation(async (_bridgeId, loopId) => {
      calls.push(`delete:${loopId}`);
      return true;
    });
    const loops = [
      loop({ id: "dispatch", name: "dispatch" }),
      loop({ id: "triage", name: "triage" }),
    ];

    await teardownFactoryLoops(factory, loops, update, remove);

    expect(calls.slice(0, 2)).toEqual(["pause:dispatch", "pause:triage"]);
    expect(new Set(calls.slice(2))).toEqual(new Set(["delete:dispatch", "delete:triage"]));
  });

  it("does not delete any loops when pausing fails", async () => {
    const update = vi.fn().mockRejectedValue(new Error("offline"));
    const remove = vi.fn();

    await expect(
      teardownFactoryLoops(factory, [loop({ id: "dispatch", name: "dispatch" })], update, remove),
    ).rejects.toThrow("Pause failed for: dispatch");
    expect(remove).not.toHaveBeenCalled();
  });
});
