// @vitest-environment jsdom
import { StrictMode, createElement } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAccountSecurity } from "./useAccountSecurity";
const clients = vi.hoisted(() => ({ created: [] as { ownerId: string; refresh: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] }));
vi.mock("@/lib/account-security-client", () => ({ AccountSecurityClient: class {
  ownerId: string; refresh = vi.fn(); dispose = vi.fn(); flushObservation = vi.fn().mockResolvedValue(undefined);
  private state = { status: "checking", identity: null, signing: null, trust: null, legacyBridges: [], historyExists: false, code: null, offline: false };
  constructor(ownerId: string) { this.ownerId = ownerId; clients.created.push(this); }
  snapshot = () => this.state; subscribe = () => () => {};
} }));
afterEach(() => { cleanup(); vi.useRealTimers(); clients.created.length = 0; });
it("never opens account trust for an anonymous consumer", () => { const view = renderHook(() => useAccountSecurity(null)); expect(view.result.current.client).toBeNull(); expect(clients.created).toHaveLength(0); });
it("refreshes every 30 seconds/focus and disposes an old account without disposing its StrictMode remount", async () => {
  vi.useFakeTimers();
  const view = renderHook(({ ownerId }) => useAccountSecurity(ownerId), { initialProps: { ownerId: "owner-one" }, wrapper: ({ children }) => createElement(StrictMode, null, children) });
  const active = view.result.current.client as unknown as typeof clients.created[number]; expect(active.ownerId).toBe("owner-one");
  await act(async () => { await Promise.resolve(); }); expect(active.dispose).not.toHaveBeenCalled();
  const previous = active.refresh.mock.calls.length;
  act(() => { vi.advanceTimersByTime(30000); window.dispatchEvent(new Event("focus")); });
  expect(active.refresh.mock.calls.length).toBe(previous + 2);
  view.rerender({ ownerId: "owner-two" }); await act(async () => { await Promise.resolve(); });
  expect(active.dispose).toHaveBeenCalledOnce(); expect(view.result.current.client?.ownerId).toBe("owner-two");
  const second = view.result.current.client as unknown as typeof clients.created[number];
  view.unmount(); await act(async () => { await Promise.resolve(); }); expect(second.dispose).toHaveBeenCalledOnce();
});
