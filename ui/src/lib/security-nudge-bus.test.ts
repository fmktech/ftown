import type { Centrifuge } from "centrifuge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecurityNudgeBus } from "./security-nudge-bus";

const USER = "owner@example.com";
const CHANNEL = `bridges:security#${USER}`;
const payload = (scope: string) => ({ type: "ftown_security_changed", version: 1, scope });

class Emitter {
  private listeners = new Map<string, Set<(ctx: unknown) => void>>();
  on(event: string, fn: (ctx: unknown) => void) { (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)!).add(fn); return this; }
  emit(event: string, ctx: unknown = {}) { for (const fn of Array.from(this.listeners.get(event) ?? [])) fn(ctx); }
}
class FakeSub extends Emitter { subscribe = vi.fn(); unsubscribe = vi.fn(); }
class FakeClient extends Emitter {
  state = "connected";
  subs: FakeSub[] = [];
  publish = vi.fn(async (_channel: string, _data: unknown) => ({}));
  newSubscription = vi.fn((channel: string) => { void channel; const s = new FakeSub(); this.subs.push(s); return s; });
  removeSubscription = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
}
const asCentrifuge = (c: FakeClient) => c as unknown as Centrifuge;
const jwt = (sub: string) => {
  const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64({ sub })}.sig`;
};
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function attached() {
  const bus = new SecurityNudgeBus();
  const client = new FakeClient();
  const detach = bus.attach(asCentrifuge(client), USER);
  const sub = client.subs[0]!;
  return { bus, client, sub, detach };
}

describe("receiving", () => {
  it("subscribes to the nudge channel", () => {
    const { client, sub } = attached();
    expect(client.newSubscription).toHaveBeenCalledWith(CHANNEL);
    expect(sub.subscribe).toHaveBeenCalledTimes(1);
  });

  it("ignores publications from another user, without info, or with invalid data", () => {
    const { bus, sub } = attached();
    const handler = vi.fn(); bus.on("approvals", handler);
    sub.emit("publication", { data: payload("approvals"), info: { user: "attacker@example.com" } });
    sub.emit("publication", { data: payload("approvals") });
    sub.emit("publication", { data: { ...payload("approvals"), extra: 1 }, info: { user: USER } });
    sub.emit("publication", { data: payload("bogus"), info: { user: USER } });
    sub.emit("publication", { data: "approvals", info: { user: USER } });
    vi.advanceTimersByTime(5000);
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches a valid nudge to its own scope only", () => {
    const { bus, sub } = attached();
    const approvals = vi.fn(); const account = vi.fn();
    bus.on("approvals", approvals); bus.on("account", account);
    sub.emit("publication", { data: payload("approvals"), info: { user: USER } });
    expect(approvals).toHaveBeenCalledTimes(1);
    expect(account).not.toHaveBeenCalled();
  });

  it("coalesces a burst of 20 into at most two runs", () => {
    const { bus, sub } = attached();
    const handler = vi.fn(); bus.on("account", handler);
    for (let i = 0; i < 20; i++) sub.emit("publication", { data: payload("account"), info: { user: USER } });
    vi.advanceTimersByTime(5000);
    expect(handler.mock.calls.length).toBeLessThanOrEqual(2);
    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("resyncs both scopes on every subscribed event", () => {
    const { bus, sub } = attached();
    const approvals = vi.fn(); const account = vi.fn();
    bus.on("approvals", approvals); bus.on("account", account);
    sub.emit("subscribed");
    expect(approvals).toHaveBeenCalledTimes(1);
    expect(account).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    sub.emit("subscribed");
    expect(approvals).toHaveBeenCalledTimes(2);
    expect(account).toHaveBeenCalledTimes(2);
  });

  it("ignores join and leave, and a throwing handler does not stop the others", () => {
    const { bus, sub } = attached();
    const good = vi.fn();
    bus.on("approvals", () => { throw new Error("boom"); }); bus.on("approvals", good);
    sub.emit("join", { info: { user: USER } }); sub.emit("leave", { info: { user: USER } });
    expect(good).not.toHaveBeenCalled();
    sub.emit("publication", { data: payload("approvals"), info: { user: USER } });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("unregistering a handler stops delivery", () => {
    const { bus, sub } = attached();
    const handler = vi.fn(); const off = bus.on("approvals", handler); off();
    sub.emit("publication", { data: payload("approvals"), info: { user: USER } });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("publishing while attached", () => {
  it("publishes the exact payload on the exact channel when connected", () => {
    const { bus, client } = attached();
    bus.publish("approvals");
    expect(client.publish).toHaveBeenCalledTimes(1);
    expect(client.publish).toHaveBeenCalledWith(CHANNEL, { type: "ftown_security_changed", version: 1, scope: "approvals" });
  });

  it("queues while disconnected and flushes once, de-duplicated, on subscribed", () => {
    const { bus, client, sub } = attached();
    client.state = "disconnected";
    bus.publish("approvals"); bus.publish("approvals"); bus.publish("account");
    expect(client.publish).not.toHaveBeenCalled();
    client.state = "connected";
    sub.emit("subscribed");
    expect(client.publish.mock.calls.map((c) => (c[1] as { scope: string }).scope).sort()).toEqual(["account", "approvals"]);
    sub.emit("subscribed");
    expect(client.publish).toHaveBeenCalledTimes(2);
  });

  it("queues a rejected publish and retries on the next subscribed", async () => {
    const { bus, client, sub } = attached();
    client.publish.mockRejectedValueOnce(new Error("nope"));
    bus.publish("account");
    await flush();
    expect(client.publish).toHaveBeenCalledTimes(1);
    sub.emit("subscribed");
    expect(client.publish).toHaveBeenCalledTimes(2);
  });

  it("never throws when the client throws", () => {
    const { bus, client } = attached();
    client.publish.mockImplementationOnce(() => { throw new Error("sync"); });
    expect(() => bus.publish("account")).not.toThrow();
  });
});

describe("one-shot publishing when not attached", () => {
  function oneShot(overrides: { fetchBootstrap?: () => Promise<{ token: string; centrifugoUrl: string }> } = {}) {
    const client = new FakeClient(); client.state = "disconnected";
    const fetchBootstrap = overrides.fetchBootstrap ?? vi.fn(async () => ({ token: jwt(USER), centrifugoUrl: "wss://c.example/ws" }));
    const createClient = vi.fn((_url: string, _token: string) => asCentrifuge(client));
    return { bus: new SecurityNudgeBus({ fetchBootstrap, createClient }), client, fetchBootstrap, createClient };
  }

  it("bootstraps, publishes on connected using the JWT sub, then disconnects", async () => {
    const { bus, client, createClient } = oneShot();
    bus.publish("approvals");
    await flush();
    expect(createClient).toHaveBeenCalledWith("wss://c.example/ws", jwt(USER));
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.publish).not.toHaveBeenCalled();
    client.emit("connected");
    await flush();
    expect(client.publish).toHaveBeenCalledWith(CHANNEL, { type: "ftown_security_changed", version: 1, scope: "approvals" });
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it("shares one one-shot between concurrent publishes", async () => {
    const { bus, client, fetchBootstrap, createClient } = oneShot();
    bus.publish("approvals"); bus.publish("account"); bus.publish("approvals");
    await flush();
    client.emit("connected");
    await flush();
    expect(fetchBootstrap).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.publish.mock.calls.map((c) => (c[1] as { scope: string }).scope).sort()).toEqual(["account", "approvals"]);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it("times out after 10s, disconnects and drops the queue", async () => {
    const { bus, client } = oneShot();
    bus.publish("account");
    await flush();
    vi.advanceTimersByTime(10_000);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    client.emit("connected");
    await flush();
    expect(client.publish).not.toHaveBeenCalled();
  });

  it("swallows a bootstrap failure and allows a later one-shot", async () => {
    const fetchBootstrap = vi.fn().mockRejectedValueOnce(new Error("401"))
      .mockResolvedValue({ token: jwt(USER), centrifugoUrl: "wss://c.example/ws" });
    const { bus, client, createClient } = oneShot({ fetchBootstrap });
    expect(() => bus.publish("account")).not.toThrow();
    await flush();
    expect(createClient).not.toHaveBeenCalled();
    bus.publish("account");
    await flush();
    expect(createClient).toHaveBeenCalledTimes(1);
    client.emit("connected");
    await flush();
    expect(client.publish).toHaveBeenCalledTimes(1);
  });

  it("drops the nudge when the token has no usable sub", async () => {
    const { bus, client, createClient } = oneShot({ fetchBootstrap: async () => ({ token: "not-a-jwt", centrifugoUrl: "wss://x" }) });
    bus.publish("account");
    await flush();
    expect(createClient).not.toHaveBeenCalled();
    expect(client.publish).not.toHaveBeenCalled();
  });
});

describe("queue handoff and token decoding", () => {
  const boot = (token: string) => vi.fn(async () => ({ token, centrifugoUrl: "wss://c.example/ws" }));

  it("never uses the one-shot while attached but disconnected", async () => {
    const fetchBootstrap = boot(jwt(USER));
    const createClient = vi.fn();
    const bus = new SecurityNudgeBus({ fetchBootstrap, createClient });
    const client = new FakeClient(); client.state = "disconnected";
    bus.attach(asCentrifuge(client), USER);
    bus.publish("account");
    await flush();
    expect(fetchBootstrap).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("hands a non-empty queue to the one-shot on detach", async () => {
    const oneClient = new FakeClient(); oneClient.state = "disconnected";
    const fetchBootstrap = boot(jwt(USER));
    const bus = new SecurityNudgeBus({ fetchBootstrap, createClient: () => asCentrifuge(oneClient) });
    const client = new FakeClient(); client.state = "disconnected";
    const detach = bus.attach(asCentrifuge(client), USER);
    bus.publish("approvals"); bus.publish("account");
    detach();
    await flush();
    expect(fetchBootstrap).toHaveBeenCalledTimes(1);
    oneClient.emit("connected");
    await flush();
    expect(oneClient.publish.mock.calls.map((c) => (c[1] as { scope: string }).scope).sort()).toEqual(["account", "approvals"]);
    expect(oneClient.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not start a one-shot on detach with an empty queue", async () => {
    const fetchBootstrap = boot(jwt(USER));
    const bus = new SecurityNudgeBus({ fetchBootstrap, createClient: vi.fn() });
    bus.attach(asCentrifuge(new FakeClient()), USER)();
    await flush();
    expect(fetchBootstrap).not.toHaveBeenCalled();
  });

  it("decodes a sub needing padding and containing - and _ in base64url", async () => {
    const sub = "a?b>c~d@example.com?>?";
    const raw = btoa(JSON.stringify({ sub })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(raw).toMatch(/[-_]/);
    expect(raw.length % 4).not.toBe(0);
    const client = new FakeClient(); client.state = "disconnected";
    const bus = new SecurityNudgeBus({ fetchBootstrap: boot(`h.${raw}.s`), createClient: () => asCentrifuge(client) });
    bus.publish("account");
    await flush();
    client.emit("connected");
    await flush();
    expect(client.publish).toHaveBeenCalledWith(`bridges:security#${sub}`, expect.anything());
  });
});

describe("detach", () => {
  it("removes the subscription and clears attached", () => {
    const { bus, client, sub, detach } = attached();
    expect(bus.attached).toBe(true);
    detach();
    expect(bus.attached).toBe(false);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(client.removeSubscription).toHaveBeenCalledWith(sub);
  });

  it("stops delivering after detach, and a stale detach does not undo a re-attach", () => {
    const { bus, client, sub, detach } = attached();
    const handler = vi.fn(); bus.on("approvals", handler);
    const second = new FakeClient();
    bus.attach(asCentrifuge(second), USER);
    expect(client.removeSubscription).toHaveBeenCalledWith(sub);
    sub.emit("publication", { data: payload("approvals"), info: { user: USER } });
    expect(handler).not.toHaveBeenCalled();
    detach();
    expect(bus.attached).toBe(true);
  });
});
