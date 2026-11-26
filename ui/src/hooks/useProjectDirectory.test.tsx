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

it("keeps the acknowledged home after stale peer replies and a dashboard reload", async () => {
  vi.useFakeTimers();
  const original = { id: "tools", name: "Tools", bridgeId: "A" };
  const moved = { ...original, bridgeId: "B", homeRevision: 1 };
  let receipt = false;
  let calls = 0;
  const send = async (command: Command) => {
    const { bridgeId, targetBridgeId, waitForMove, poll } = command.payload as { bridgeId: string; targetBridgeId?: string; waitForMove?: boolean; poll?: boolean };
    if (command.type === "mutate_project_board") {
      if (bridgeId !== original.bridgeId || targetBridgeId !== moved.bridgeId) throw Error("Invalid move destination");
      expect(waitForMove).toBe(true);
      expect(poll).toBe(calls ? true : undefined);
      if (++calls <= 2) return { requestId: command.requestId, success: true, data: { moving: true } };
      receipt = true;
      return { requestId: command.requestId, success: true, data: { project: moved } };
    }
    const projects = bridgeId === "C" ? [original] : bridgeId === "B" ? (receipt ? [moved] : []) : (receipt ? [] : [original]);
    return { requestId: command.requestId, success: true, data: { projects } };
  };
  const hook = renderHook(() => useProjectDirectory("account", ["A", "B"], send));
  await act(async () => {});
  expect(hook.result.current.projects).toEqual([original]);
  await act(async () => { await hook.result.current.move(original, "B"); });
  expect(calls).toBe(3);
  expect(hook.result.current.projects).toEqual([moved]);
  hook.unmount();
  const reload = renderHook(() => useProjectDirectory("account", ["C"], send));
  await act(async () => {});
  expect(reload.result.current.projects).toEqual([moved]);
});

it("follows a selected board moved by another client when only the old home is connected", async () => {
  const oldHome = { id: "p", name: "Project", bridgeId: "A" };
  const newHome = { ...oldHome, bridgeId: "B", homeRevision: 2 };
  const send = async (command: Command) => ({
    requestId: command.requestId, success: true,
    data: { projects: (command.payload as { projectId?: string }).projectId === oldHome.id ? [newHome] : [oldHome] },
  });
  const initialProps: { selected: typeof oldHome | null } = { selected: null };
  const hook = renderHook(({ selected }) => useProjectDirectory("account", ["A"], send, selected), { initialProps });
  await act(async () => {});
  expect(hook.result.current.projects).toEqual([oldHome]);
  hook.rerender({ selected: oldHome });
  await act(async () => {});
  expect(hook.result.current.projects).toEqual([newHome]);
});

it("stops polling a pending move when its account changes", async () => {
  const original = { id: "tools", name: "Tools", bridgeId: "A" };
  const pollStarted = Promise.withResolvers<void>();
  const finishPoll = Promise.withResolvers<void>();
  let calls = 0;
  const send = async (command: Command) => {
    if (++calls === 2) {
      pollStarted.resolve();
      await finishPoll.promise;
    }
    if (calls > 2) throw Error("Unexpected additional poll");
    return { requestId: command.requestId, success: true, data: { moving: true } };
  };
  const hook = renderHook(({ account }) => useProjectDirectory(account, [], send), { initialProps: { account: "one" } });
  const move = hook.result.current.move(original, "B");
  await pollStarted.promise;
  hook.rerender({ account: "two" });
  finishPoll.resolve();
  await expect(move).rejects.toThrow("The active account changed.");
  expect(calls).toBe(2);
  expect(hook.result.current.projects).toEqual([]);
});
