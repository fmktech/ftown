// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Command, CommandResponse } from "@/types";
import { statusCandidates, usePullRequestStatuses } from "./usePullRequestStatuses";
const url = "https://github.com/Owner/Repo/pull/1";
const sessions = [{ id: "s1", bridgeId: "b1", pullRequestUrl: url }];
let visibility = "visible", online = true;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); visibility = "visible"; online = true; Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility }); Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const reply = (state = "passed"): CommandResponse => ({ requestId: "r", success: true, data: { bridgeId: "b1", nextRefreshAt: new Date(Date.now() + 60_000).toISOString(), statuses: [{ url, state, checkedAt: new Date().toISOString(), stale: false }] } });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
it("deduplicates canonical URLs across sessions and chooses a deterministic ready bridge", () => {
  expect(statusCandidates([{ id: "z", bridgeId: "b2", pullRequestUrl: url }, { id: "x", bridgeId: "b1", pullRequestUrl: url.toLowerCase() }, { id: "y", bridgeId: "b1", pullRequestUrl: url }], ["b2", "b1"])).toEqual([{ bridgeId: "b1", sessionId: "x", url: url.toLowerCase() }]);
});
it("pauses hidden and offline, resumes only when due, and marks cached data stale", async () => {
  const send = vi.fn(async () => reply()); const hook = renderHook(() => usePullRequestStatuses(send, sessions, ["b1"], true));
  await flush(); expect(send).toHaveBeenCalledTimes(1); expect(hook.result.current.get(url)?.state).toBe("passed");
  visibility = "hidden"; act(() => document.dispatchEvent(new Event("visibilitychange"))); expect(hook.result.current.get(url)?.stale).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); }); expect(send).toHaveBeenCalledTimes(1);
  online = false; visibility = "visible"; act(() => { window.dispatchEvent(new Event("offline")); document.dispatchEvent(new Event("visibilitychange")); }); await flush(); expect(send).toHaveBeenCalledTimes(1);
  online = true; act(() => window.dispatchEvent(new Event("online"))); await flush(); expect(send).toHaveBeenCalledTimes(2); expect(hook.result.current.get(url)?.stale).toBe(false);
  visibility = "hidden"; act(() => document.dispatchEvent(new Event("visibilitychange"))); visibility = "visible"; act(() => document.dispatchEvent(new Event("visibilitychange"))); await flush(); expect(send).toHaveBeenCalledTimes(2);
});
it("discards late replies after PR removal or URL change", async () => {
  let resolve!: (value: CommandResponse) => void; const send = vi.fn(() => new Promise<CommandResponse>(r => { resolve = r; }));
  const hook = renderHook(({ items }) => usePullRequestStatuses(send, items, ["b1"], true), { initialProps: { items: sessions } });
  hook.rerender({ items: [{ ...sessions[0], pullRequestUrl: "https://github.com/owner/repo/pull/2" }] }); await act(async () => resolve(reply()));
  expect(hook.result.current.get(url)).toBeUndefined(); expect(send).toHaveBeenCalledTimes(1);
  hook.rerender({ items: [] }); await act(async () => { await vi.advanceTimersByTimeAsync(120_000); }); expect(send).toHaveBeenCalledTimes(1);
});
it("preserves last state on failure and backs off five minutes", async () => {
  const send = vi.fn().mockResolvedValueOnce(reply()).mockRejectedValue(new Error("offline")); const hook = renderHook(() => usePullRequestStatuses(send, sessions, ["b1"], true));
  await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(hook.result.current.get(url)).toMatchObject({ state: "passed", stale: true, reason: "unavailable" });
  await act(async () => { await vi.advanceTimersByTimeAsync(299_999); }); expect(send).toHaveBeenCalledTimes(2);
});
it("does not poll a bridge solely for a merged PR", async () => { const send = vi.fn(async () => reply("merged")); renderHook(() => usePullRequestStatuses(send, sessions, ["b1"], true)); await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(600_000); }); expect(send).toHaveBeenCalledTimes(1); });
it("rotates batches of up to 100 unique sessions without starving the remainder", async () => {
  const many = Array.from({ length: 101 }, (_, i) => ({ id: `s${String(i).padStart(3, "0")}`, bridgeId: "b1", pullRequestUrl: `https://github.com/o/r/pull/${i + 1}` }));
  const send = vi.fn(async (_command: Command) => ({ requestId: "r", success: true, data: { bridgeId: "b1", nextRefreshAt: new Date(Date.now() + 60_000).toISOString(), statuses: [] } }));
  renderHook(() => usePullRequestStatuses(send, many, ["b1"], true)); await flush();
  expect((send.mock.calls[0][0] as { payload: { sessionIds: string[] } }).payload.sessionIds).toHaveLength(100);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect((send.mock.calls[1][0] as { payload: { sessionIds: string[] } }).payload.sessionIds).toContain("s100");
});

it("does not mark immutable merged status stale when the dashboard pauses", async () => {
  const send = vi.fn(async () => reply("merged")); const hook = renderHook(() => usePullRequestStatuses(send, sessions, ["b1"], true));
  await flush(); visibility = "hidden"; act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(hook.result.current.get(url)).toMatchObject({ state: "merged", stale: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000); }); visibility = "visible"; act(() => document.dispatchEvent(new Event("visibilitychange"))); await flush();
  expect(hook.result.current.get(url)).toMatchObject({ state: "merged", stale: false }); expect(send).toHaveBeenCalledTimes(1);
});
it.each([["in_progress", 60_000], ["unknown", 60_000], ["passed", 300_000], ["failed", 300_000], ["closed", 3_600_000]] as const)("ages %s after its TTL without an extra RPC", async (state, ttl) => {
  const send = vi.fn(async () => { const result = reply(state); (result.data as { nextRefreshAt: string }).nextRefreshAt = new Date(Date.now() + 7_200_000).toISOString(); return result; });
  let renders = 0; const hook = renderHook(() => { renders++; return usePullRequestStatuses(send, sessions, ["b1"], true); });
  await flush(); expect(hook.result.current.get(url)?.stale).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(ttl - 1); }); expect(hook.result.current.get(url)?.stale).toBe(false); const beforeExpiry = renders;
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(hook.result.current.get(url)?.stale).toBe(true); expect(renders).toBeGreaterThan(beforeExpiry); expect(send).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(send).toHaveBeenCalledTimes(1); expect(renders).toBe(beforeExpiry + 1);
});
