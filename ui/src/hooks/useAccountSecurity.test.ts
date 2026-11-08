// @vitest-environment jsdom
import { StrictMode, createElement } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAccountSecurity } from "./useAccountSecurity";
const clients = vi.hoisted(() => ({ created: [] as { ownerId: string; refresh: ReturnType<typeof vi.fn>; refreshFresh: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] }));
vi.mock("@/lib/account-security-client", () => ({ AccountSecurityClient: class {
  ownerId: string; refresh = vi.fn(); refreshFresh = vi.fn(); dispose = vi.fn(); flushObservation = vi.fn().mockResolvedValue(undefined);
  private state = { status: "checking", identity: null, signing: null, trust: null, legacyBridges: [], historyExists: false, code: null, offline: false };
  constructor(ownerId: string) { this.ownerId = ownerId; clients.created.push(this); }
  snapshot = () => this.state; subscribe = () => () => {};
} }));
const bus = vi.hoisted(() => ({ attached: true, handlers: new Set<() => void>() }));
vi.mock("@/lib/security-nudge-bus", () => ({ securityNudges: {
  get attached() { return bus.attached; },
  on: (_scope: string, handler: () => void) => { bus.handlers.add(handler); return () => { bus.handlers.delete(handler); }; },
} }));
const setVisibility = (state: string) => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state }); document.dispatchEvent(new Event("visibilitychange")); };
afterEach(() => { bus.attached = true; bus.handlers.clear(); setVisibility("visible"); cleanup(); vi.useRealTimers(); clients.created.length = 0; });
it("never opens account trust for an anonymous consumer", () => { const view = renderHook(() => useAccountSecurity(null)); expect(view.result.current.client).toBeNull(); expect(clients.created).toHaveLength(0); });
it("disposes an old account without disposing its StrictMode remount", async () => {
  vi.useFakeTimers();
  const view = renderHook(({ ownerId }) => useAccountSecurity(ownerId), { initialProps: { ownerId: "owner-one" }, wrapper: ({ children }) => createElement(StrictMode, null, children) });
  const active = view.result.current.client as unknown as typeof clients.created[number]; expect(active.ownerId).toBe("owner-one");
  await act(async () => { await Promise.resolve(); }); expect(active.dispose).not.toHaveBeenCalled();
  view.rerender({ ownerId: "owner-two" }); await act(async () => { await Promise.resolve(); });
  expect(active.dispose).toHaveBeenCalledOnce(); expect(view.result.current.client?.ownerId).toBe("owner-two");
  const second = view.result.current.client as unknown as typeof clients.created[number];
  view.unmount(); await act(async () => { await Promise.resolve(); }); expect(second.dispose).toHaveBeenCalledOnce();
});
const mount = () => { const view = renderHook(() => useAccountSecurity("owner")); return { view, client: view.result.current.client as unknown as typeof clients.created[number] }; };
it("refreshes once on mount and never on a timer or focus while idle for 10 minutes", () => {
  vi.useFakeTimers();
  const { client } = mount();
  act(() => { vi.advanceTimersByTime(10 * 60_000); window.dispatchEvent(new Event("focus")); });
  expect(client.refresh).toHaveBeenCalledTimes(1);
});
it("refreshes once more per account nudge and stops after unmount", () => {
  const { view, client } = mount();
  act(() => { bus.handlers.forEach((handler) => handler()); });
  expect(client.refresh).toHaveBeenCalledTimes(1); expect(client.refreshFresh).toHaveBeenCalledTimes(1);
  view.unmount(); expect(bus.handlers.size).toBe(0);
});
it("falls back to visibilitychange only when no bus is attached", () => {
  const { client } = mount();
  setVisibility("visible"); expect(client.refresh).toHaveBeenCalledTimes(1);
  bus.attached = false; setVisibility("hidden"); expect(client.refresh).toHaveBeenCalledTimes(1);
  setVisibility("visible"); expect(client.refresh).toHaveBeenCalledTimes(2);
});
