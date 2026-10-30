// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Command, CommandResponse } from "@/types";
import { statusCandidates, usePullRequestStatuses } from "./usePullRequestStatuses";
import { PullRequestStatusProvider } from "@/components/PullRequestStatusProvider";
import { PullRequestLink } from "@/components/PullRequestLink";
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

it("retains stale running status across bridge readiness loss until the next allowed refresh", async () => {
  const send = vi.fn(async () => reply("in_progress"));
  const hook = renderHook(({ ready }) => usePullRequestStatuses(send, sessions, ready, true), { initialProps: { ready: ["b1"] } });
  await flush(); expect(hook.result.current.get(url)).toMatchObject({ state: "in_progress", stale: false });
  hook.rerender({ ready: [] }); expect(hook.result.current.get(url)).toMatchObject({ state: "in_progress", stale: true, reason: "unavailable" });
  hook.rerender({ ready: ["b1"] }); await flush(); expect(send).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); }); expect(send).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(send).toHaveBeenCalledTimes(2);
  expect(hook.result.current.get(url)).toMatchObject({ state: "in_progress", stale: false });
});
it("keeps last running status stale through a temporary ready-bridge loss", async () => {
  const send = vi.fn(async () => reply("in_progress"));
  const hook = renderHook(({ ready }) => usePullRequestStatuses(send, sessions, ready, true), { initialProps: { ready: ["b1"] } });
  await flush(); hook.rerender({ ready: [] });
  expect(hook.result.current.get(url)).toMatchObject({ state: "in_progress", stale: true });
});
it("renders stale running status with its clock and pending color", async () => {
  const send = vi.fn(async () => { const result = reply("in_progress"); (result.data as { statuses: Array<{ stale: boolean }> }).statuses[0].stale = true; return result; });
  render(<PullRequestStatusProvider send={send} sessions={sessions} readyBridgeIds={["b1"]} connected><PullRequestLink url={url} badge/></PullRequestStatusProvider>);
  await flush(); const link = screen.getByRole("link");
  expect(link.getAttribute("aria-label")).toContain("Last known CI running");
  expect(link.getAttribute("style")).toContain("var(--status-pending)"); expect(link.querySelector("svg")).not.toBeNull();
});
it("keeps last running status stale when a refresh fails with stable inputs", async () => {
  const send = vi.fn().mockResolvedValueOnce(reply("in_progress")).mockRejectedValue(new Error("offline"));
  const hook = renderHook(() => usePullRequestStatuses(send, sessions, ["b1"], true));
  await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(send).toHaveBeenCalledTimes(2); expect(hook.result.current.get(url)).toMatchObject({ state: "in_progress", stale: true, reason: "unavailable" });
});

it("purges the cached owner when the linked PR is removed", async () => {
  const send = vi.fn(async () => reply("in_progress"));
  const hook = renderHook(({ items, ready }) => usePullRequestStatuses(send, items, ready, true), { initialProps: { items: sessions, ready: ["b1"] } });
  await flush(); hook.rerender({ items: sessions, ready: [] }); expect(hook.result.current.get(url)?.state).toBe("in_progress");
  hook.rerender({ items: [], ready: [] }); expect(hook.result.current.get(url)).toBeUndefined();
});
it("retains exact owner across duplicate PRs until another bridge replies, then purges its removed owner", async () => {
  let resolveB2!: (value: CommandResponse) => void;
  const send = vi.fn((command: Command) => {
    const bridgeId = (command.payload as { bridgeId: string }).bridgeId;
    return bridgeId === "b1" ? Promise.resolve(reply("in_progress")) : new Promise<CommandResponse>(resolve => { resolveB2 = resolve; });
  });
  const duplicate = [...sessions, { id: "s2", bridgeId: "b2", pullRequestUrl: url }];
  const hook = renderHook(({ items, ready }) => usePullRequestStatuses(send, items, ready, true), { initialProps: { items: duplicate, ready: ["b1", "b2"] } });
  await flush(); expect(hook.result.current.get(url)).toMatchObject({ state: "in_progress", stale: false });
  hook.rerender({ items: duplicate, ready: ["b2"] });
  expect(hook.result.current.get(url)).toMatchObject({ state: "in_progress", stale: true }); expect(send).toHaveBeenCalledTimes(2);
  const response = reply("passed"); (response.data as { bridgeId: string }).bridgeId = "b2";
  await act(async () => resolveB2(response)); expect(hook.result.current.get(url)).toMatchObject({ state: "passed", stale: false });
  hook.rerender({ items: [sessions[0]], ready: ["b1"] }); expect(hook.result.current.get(url)).toBeUndefined();
});
it("retains immutable merged status when its linked bridge is not ready", async () => {
  const send = vi.fn(async () => reply("merged"));
  const hook = renderHook(({ ready }) => usePullRequestStatuses(send, sessions, ready, true), { initialProps: { ready: ["b1"] } });
  await flush(); hook.rerender({ ready: [] }); expect(hook.result.current.get(url)).toMatchObject({ state: "merged", stale: false });
  hook.rerender({ ready: ["b1"] }); await act(async () => { await vi.advanceTimersByTimeAsync(600_000); }); expect(send).toHaveBeenCalledTimes(1);
});
it("fences a late response when linked owners change even if the ready candidate is unchanged", async () => {
  let resolve!: (value: CommandResponse) => void;
  const send = vi.fn(() => new Promise<CommandResponse>(r => { resolve = r; }));
  const hook = renderHook(({ items }) => usePullRequestStatuses(send, items, ["b1"], true), { initialProps: { items: sessions } });
  hook.rerender({ items: [...sessions, { id: "s2", bridgeId: "b2", pullRequestUrl: url }] });
  await act(async () => resolve(reply("in_progress")));
  expect(hook.result.current.get(url)).toBeUndefined(); expect(send).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); }); expect(send).toHaveBeenCalledTimes(1);
});
it("does not attribute an offline owner's cache to another linked bridge", async () => {
  const send = vi.fn((command: Command) => (command.payload as { bridgeId: string }).bridgeId === "b1" ? Promise.resolve(reply("in_progress")) : new Promise<CommandResponse>(() => {}));
  const second = { id: "s2", bridgeId: "b2", pullRequestUrl: url };
  const hook = renderHook(({ items, ready }) => usePullRequestStatuses(send, items, ready, true), { initialProps: { items: [...sessions, second], ready: ["b1", "b2"] } });
  await flush(); hook.rerender({ items: [...sessions, second], ready: ["b2"] });
  expect(hook.result.current.get(url)).toMatchObject({ state: "in_progress", stale: true });
  hook.rerender({ items: [second], ready: ["b2"] }); expect(hook.result.current.get(url)).toBeUndefined();
});

const newUrl = "https://github.com/Owner/Repo/pull/2";
const longDeadline = (response: CommandResponse) => { (response.data as { nextRefreshAt: string }).nextRefreshAt = new Date(Date.now() + 3_600_000).toISOString(); return response; };
it.each(["replace", "add"] as const)("queries a %s PR after the one-minute minimum even when the prior settled batch was merged-only", async mode => {
  const send = vi.fn(async () => longDeadline(reply("merged")));
  const hook = renderHook(({ items }) => usePullRequestStatuses(send, items, ["b1"], true), { initialProps: { items: sessions } });
  await flush(); expect(hook.result.current.get(url)?.state).toBe("merged"); expect(send).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  const newItem = { id: mode === "replace" ? "s1" : "s2", bridgeId: "b1", pullRequestUrl: newUrl };
  hook.rerender({ items: mode === "replace" ? [newItem] : [...sessions, newItem] }); await flush();
  expect(send).toHaveBeenCalledTimes(2);
});
it("queries a new linked PR after a settled merged batch and then honors its response deadline", async () => {
  const send = vi.fn(async (command: Command) => {
    const ids = (command.payload as { sessionIds: string[] }).sessionIds;
    const response = longDeadline(reply(ids.includes("s2") ? "in_progress" : "merged"));
    if (ids.includes("s2")) (response.data as { statuses: Array<{ url: string }> }).statuses[0].url = newUrl;
    return response;
  });
  const hook = renderHook(({ items }) => usePullRequestStatuses(send, items, ["b1"], true), { initialProps: { items: sessions } });
  await flush(); expect(hook.result.current.get(url)?.state).toBe("merged");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  hook.rerender({ items: [...sessions, { id: "s2", bridgeId: "b1", pullRequestUrl: newUrl }] }); await flush();
  expect(send).toHaveBeenCalledTimes(2); expect(hook.result.current.get(newUrl)?.state).toBe("in_progress");
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); }); expect(send).toHaveBeenCalledTimes(2);
});
it("keeps an unchanged active batch on its longer server deadline while a fresh bridge queries immediately", async () => {
  const send = vi.fn(async (command: Command) => {
    const bridgeId = (command.payload as { bridgeId: string }).bridgeId;
    const response = longDeadline(reply("in_progress")); (response.data as { bridgeId: string }).bridgeId = bridgeId;
    if (bridgeId === "b2") (response.data as { statuses: Array<{ url: string }> }).statuses[0].url = newUrl;
    return response;
  });
  const hook = renderHook(({ items, ready }) => usePullRequestStatuses(send, items, ready, true), { initialProps: { items: sessions, ready: ["b1"] } });
  await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(send).toHaveBeenCalledTimes(1);
  hook.rerender({ items: [...sessions, { id: "s2", bridgeId: "b2", pullRequestUrl: newUrl }], ready: ["b1", "b2"] }); await flush();
  expect(send).toHaveBeenCalledTimes(2); expect((send.mock.calls[1][0].payload as { bridgeId: string }).bridgeId).toBe("b2");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(send).toHaveBeenCalledTimes(2);
});

it("waits for the hard one-minute floor when a new PR is linked early", async () => {
  const send = vi.fn(async () => longDeadline(reply("merged")));
  const hook = renderHook(({ items }) => usePullRequestStatuses(send, items, ["b1"], true), { initialProps: { items: sessions } });
  await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  hook.rerender({ items: [...sessions, { id: "s2", bridgeId: "b1", pullRequestUrl: newUrl }] }); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(58_999); }); expect(send).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(send).toHaveBeenCalledTimes(2);
});
it("queries new work at one minute even if the prior passed batch refreshes after five minutes", async () => {
  const send = vi.fn(async () => { const result = reply("passed"); (result.data as { nextRefreshAt: string }).nextRefreshAt = new Date(Date.now() + 300_000).toISOString(); return result; });
  const hook = renderHook(({ items }) => usePullRequestStatuses(send, items, ["b1"], true), { initialProps: { items: sessions } });
  await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  hook.rerender({ items: [...sessions, { id: "s2", bridgeId: "b1", pullRequestUrl: newUrl }] }); await flush(); expect(send).toHaveBeenCalledTimes(2);
});
it("preserves a five-minute failed-read cooldown when the PR changes", async () => {
  const send = vi.fn().mockResolvedValueOnce(reply("in_progress")).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(reply("in_progress"));
  const hook = renderHook(({ items }) => usePullRequestStatuses(send, items, ["b1"], true), { initialProps: { items: sessions } });
  await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(send).toHaveBeenCalledTimes(2);
  hook.rerender({ items: [{ ...sessions[0], pullRequestUrl: newUrl }] }); await act(async () => { await vi.advanceTimersByTimeAsync(299_999); }); expect(send).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(send).toHaveBeenCalledTimes(3);
});
it("retains new work while its bridge is unready and dispatches once it becomes ready", async () => {
  const send = vi.fn(async () => reply("in_progress"));
  const hook = renderHook(({ ready }) => usePullRequestStatuses(send, sessions, ready, true), { initialProps: { ready: [] as string[] } });
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); }); expect(send).not.toHaveBeenCalled();
  hook.rerender({ ready: ["b1"] }); await flush(); expect(send).toHaveBeenCalledTimes(1);
});
it("does not treat duplicate sessions or a readiness roundtrip as new work", async () => {
  const send = vi.fn(async () => longDeadline(reply("passed")));
  const hook = renderHook(({ items, ready }) => usePullRequestStatuses(send, items, ready, true), { initialProps: { items: sessions, ready: ["b1"] } });
  await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  hook.rerender({ items: [...sessions, { ...sessions[0], id: "s2" }], ready: ["b1"] });
  hook.rerender({ items: [...sessions, { ...sessions[0], id: "s2" }], ready: [] });
  hook.rerender({ items: [...sessions, { ...sessions[0], id: "s2" }], ready: ["b1"] }); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); }); expect(send).toHaveBeenCalledTimes(1);
});
it("consumes new work after an attempted unknown response", async () => {
  const send = vi.fn().mockResolvedValueOnce(longDeadline(reply("merged"))).mockImplementation(async () => {
    const result = longDeadline(reply("unknown")); const status = (result.data as { statuses: Array<{ url: string; checkedAt: string | null }> }).statuses[0]; status.url = newUrl; status.checkedAt = null; return result;
  });
  const hook = renderHook(({ items }) => usePullRequestStatuses(send, items, ["b1"], true), { initialProps: { items: sessions } });
  await flush(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  hook.rerender({ items: [...sessions, { id: "s2", bridgeId: "b1", pullRequestUrl: newUrl }] }); await flush(); expect(send).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); }); expect(send).toHaveBeenCalledTimes(2);
});
it("keeps unattempted owners pending beyond a 100-session batch", async () => {
  const many = Array.from({ length: 101 }, (_, i) => ({ id: `s${String(i).padStart(3, "0")}`, bridgeId: "b1", pullRequestUrl: `https://github.com/o/r/pull/${i + 1}` }));
  const send = vi.fn(async (command: Command) => ({ requestId: command.requestId, success: true, data: { bridgeId: "b1", nextRefreshAt: new Date(Date.now() + 3_600_000).toISOString(), statuses: [] } }));
  renderHook(() => usePullRequestStatuses(send, many, ["b1"], true)); await flush();
  expect((send.mock.calls[0][0].payload as { sessionIds: string[] }).sessionIds).toHaveLength(100);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(send).toHaveBeenCalledTimes(2); expect((send.mock.calls[1][0].payload as { sessionIds: string[] }).sessionIds).toContain("s100");
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); }); expect(send).toHaveBeenCalledTimes(2);
});
