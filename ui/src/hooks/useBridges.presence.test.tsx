// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useBridges } from "./useBridges";
import type { MessageClient, MessageSubscription } from "@/lib/message-client";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function presenceClient(name: string) {
  const listeners = new Map<string, () => void>();
  const snapshot = { clients: { device: { connInfo: { bridgeId: name } } } };
  const sub = {
    state: "subscribed",
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    subscribe: () => listeners.get("subscribed")?.(), unsubscribe() {}, removeAllListeners() { listeners.clear(); },
    presence: vi.fn(async () => snapshot),
  };
  const client = { getSubscription: () => null, newSubscription: () => sub as unknown as MessageSubscription, removeSubscription() {} };
  return { sub, snapshot, client };
}

it("keeps presence after a transient read failure, ignores obsolete snapshots and clears a disconnected subscription", async () => {
  vi.useFakeTimers();
  const a = presenceClient("A");
  const b = presenceClient("B");
  const hook = renderHook(({ client }) => useBridges(client, "user"), { initialProps: { client: a.client as MessageClient } });
  const ids = () => hook.result.current.bridges.map(bridge => bridge.bridgeId);
  await act(async () => {});
  expect(ids()).toEqual(["A"]);
  a.sub.presence.mockRejectedValueOnce(Error("timeout"));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(ids()).toEqual(["A"]);

  let complete!: () => void;
  a.sub.presence.mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve(a.snapshot); }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(a.sub.presence).toHaveBeenCalledTimes(3);
  hook.rerender({ client: b.client });
  await act(async () => { complete(); });
  expect(ids()).toEqual(["B"]);
  b.sub.state = "subscribing";
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(ids()).toEqual([]);
});
