// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePendingApprovals } from "./usePendingApprovals";
import type { PendingApprovalClient, PendingSnapshot } from "@/lib/pending-approval-client";
import type { AccountSecurityClient } from "@/lib/account-security-client";
const bus = vi.hoisted(() => ({ attached: true, handlers: new Set<() => void>(), off: vi.fn() }));
vi.mock("@/lib/security-nudge-bus", () => ({ securityNudges: {
  get attached() { return bus.attached; },
  on: (_scope: string, handler: () => void) => { bus.handlers.add(handler); return () => { bus.off(); bus.handlers.delete(handler); }; },
} }));
const view = (status: string) => ({ status, requestId: "r1", label: "Browser", code: null, localConfirmed: false, peerConfirmed: false, error: null });
const makeClient = () => {
  let state = { candidate: view("idle"), inbox: [], inboxError: null, review: null } as unknown as PendingSnapshot;
  const listeners = new Set<() => void>();
  return {
    refreshInbox: vi.fn().mockResolvedValue(undefined), refreshInboxFresh: vi.fn().mockResolvedValue(undefined), pollReview: vi.fn().mockResolvedValue(undefined), ensureCandidate: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(),
    snapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setReview: (status: string | null) => { state = { ...state, review: status ? view(status) : null } as unknown as PendingSnapshot; for (const listener of listeners) listener(); },
  };
};
const account = {} as AccountSecurityClient;
const mount = (mode: "candidate" | "reviewer" | "passive", client = makeClient()) => ({ client, hook: renderHook(() => usePendingApprovals(account, mode, client as unknown as PendingApprovalClient)) });
const visibility = (state: "visible" | "hidden") => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state }); document.dispatchEvent(new Event("visibilitychange")); };
beforeEach(() => { vi.useFakeTimers(); bus.attached = true; bus.handlers.clear(); bus.off.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("fetches the idle reviewer inbox exactly once over ten minutes", () => {
  const { client } = mount("reviewer");
  act(() => { vi.advanceTimersByTime(600_000); });
  expect(client.refreshInbox).toHaveBeenCalledTimes(1); expect(client.pollReview).not.toHaveBeenCalled();
});
it("reads fresh once per approvals nudge, separate from the mount read", () => {
  const { client } = mount("reviewer"); expect(bus.handlers.size).toBe(1);
  act(() => { for (const handler of bus.handlers) handler(); });
  expect(client.refreshInboxFresh).toHaveBeenCalledTimes(1); expect(client.refreshInbox).toHaveBeenCalledTimes(1);
});
it("does not fetch on window focus", () => {
  const { client } = mount("reviewer");
  act(() => { window.dispatchEvent(new Event("focus")); });
  expect(client.refreshInbox).toHaveBeenCalledTimes(1);
});
it("polls an active review every 2 seconds and stops when it resolves or clears", () => {
  const { client } = mount("reviewer");
  act(() => { client.setReview("comparing"); });
  act(() => { vi.advanceTimersByTime(6000); }); expect(client.pollReview).toHaveBeenCalledTimes(3);
  act(() => { client.setReview("rejected"); }); act(() => { vi.advanceTimersByTime(10_000); }); expect(client.pollReview).toHaveBeenCalledTimes(3);
  act(() => { client.setReview("waiting"); }); act(() => { vi.advanceTimersByTime(2000); }); expect(client.pollReview).toHaveBeenCalledTimes(4);
  act(() => { client.setReview(null); }); act(() => { vi.advanceTimersByTime(10_000); }); expect(client.pollReview).toHaveBeenCalledTimes(4);
});
it("keeps polling an approved review so delivery renewal can run", () => {
  const { client } = mount("reviewer");
  act(() => { client.setReview("approved"); }); act(() => { vi.advanceTimersByTime(6000); });
  expect(client.pollReview).toHaveBeenCalledTimes(3);
});
it("stops polling a review that never changes after the request lifetime", () => {
  const { client } = mount("reviewer");
  act(() => { client.setReview("waiting"); }); act(() => { vi.advanceTimersByTime(300_000); });
  expect(client.pollReview).toHaveBeenCalledTimes(150);
  act(() => { vi.advanceTimersByTime(60_000); }); expect(client.pollReview).toHaveBeenCalledTimes(150);
});
it("falls back to visibilitychange only while no bus is attached", () => {
  const { client } = mount("reviewer");
  act(() => { visibility("visible"); }); expect(client.refreshInbox).toHaveBeenCalledTimes(1);
  bus.attached = false;
  act(() => { visibility("hidden"); }); expect(client.refreshInbox).toHaveBeenCalledTimes(1);
  act(() => { visibility("visible"); }); expect(client.refreshInbox).toHaveBeenCalledTimes(2);
});
it("keeps candidate mode polling ensureCandidate every 2 seconds and on focus", () => {
  const { client } = mount("candidate");
  expect(client.ensureCandidate).toHaveBeenCalledTimes(1);
  act(() => { vi.advanceTimersByTime(4000); window.dispatchEvent(new Event("focus")); });
  expect(client.ensureCandidate).toHaveBeenCalledTimes(4); expect(client.refreshInbox).not.toHaveBeenCalled(); expect(bus.handlers.size).toBe(0);
});
it("clears the nudge handler, timers and listeners on unmount", async () => {
  const { client, hook } = mount("reviewer");
  act(() => { client.setReview("waiting"); });
  hook.unmount(); await Promise.resolve();
  expect(bus.off).toHaveBeenCalledOnce(); expect(bus.handlers.size).toBe(0);
  vi.advanceTimersByTime(10_000); window.dispatchEvent(new Event("focus")); visibility("visible");
  expect(client.pollReview).not.toHaveBeenCalled(); expect(client.refreshInbox).toHaveBeenCalledTimes(1);
});
