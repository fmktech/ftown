// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Command } from "@/types";
import { useProjectDirectory } from "./useProjectDirectory";

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

it("reads only a joining bridge and keeps a home bridge's directory authoritative until disconnect", async () => {
  vi.useFakeTimers();
  const stale = { bridgeId: "A", id: "old", name: "Deleted project" };
  const remote = { bridgeId: "B", id: "remote", name: "Tools" };
  const reads: string[] = [];
  const send = async (command: Command) => {
    const id = (command.payload as { bridgeId: string }).bridgeId;
    reads.push(id);
    return { requestId: command.requestId, success: true, data: { projects: id === "A" ? [] : [remote, stale] } };
  };
  const hook = renderHook(({ ids }) => useProjectDirectory("account", ids, send), { initialProps: { ids: ["A"] } });
  await act(async () => {});
  for (const ids of [["A", "B"], ["A"], ["B", "A"]]) {
    hook.rerender({ ids });
    await act(async () => {});
    expect(hook.result.current.projects).toEqual([remote]);
  }
  expect(reads).toEqual(["A", "B", "B"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(reads.slice(3).sort()).toEqual(["A", "B"]);
});
