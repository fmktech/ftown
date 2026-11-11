// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecureEndpointRuntime } from "@/lib/secure-endpoint-runtime";

type Handler = (ctx: { data?: unknown; info?: { user?: string } }) => void;
interface FakeSub { channel: string; handlers: Map<string, Handler[]>; subscribe: () => void; unsubscribe: () => void; removeAllListeners: () => void; publish: (data: unknown) => Promise<unknown> }
type ClientHandler = (ctx: unknown) => void;
const mocks = vi.hoisted(() => ({
  subs: [] as FakeSub[], removed: [] as string[], secure: [] as { userId: string; request: (command: unknown) => Promise<unknown> }[],
  getToken: [] as (() => Promise<string>)[], clientOn: [] as [string, ClientHandler][], presence: [] as string[],
  presenceResult: null as unknown,
}));
vi.mock("centrifuge", () => ({
  UnauthorizedError: class extends Error {},
  Centrifuge: class {
    constructor(_url: string, options: { getToken: () => Promise<string> }) { mocks.getToken.push(options.getToken); }
    on(event: string, handler: ClientHandler) { mocks.clientOn.push([event, handler]); return this; } off() { return this; } connect() {} disconnect() {}
    presence(channel: string) { mocks.presence.push(channel); return Promise.resolve(mocks.presenceResult); }
    newSubscription(channel: string) {
      const handlers = new Map<string, Handler[]>();
      const sub = { channel, handlers, on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return sub; },
        subscribe: vi.fn(), unsubscribe: vi.fn(), removeAllListeners: vi.fn(), publish: vi.fn(async () => ({})) };
      mocks.subs.push(sub); return sub;
    }
    removeSubscription(sub: FakeSub) { mocks.removed.push(sub.channel); }
    getSubscription() { return null; }
  },
}));
vi.mock("@/lib/secure-message-client", () => ({
  SecureMessageClient: class {
    request = vi.fn(async (command: unknown) => ({ requestId: (command as { requestId: string }).requestId, success: true, data: { echo: command } }));
    constructor(_raw: unknown, public userId: string) { mocks.secure.push(this); }
    dispose() {} publish() { return Promise.resolve(); } getSubscription() { return null; }
    newSubscription() { return { on() {}, off() {}, subscribe() {} }; }
  },
}));
vi.mock("@/lib/direct-transport/hybrid-terminal-transport", () => ({ HybridTerminalTransport: class { dispose() {} } }));
import { LEDGER_PRESENCE_POLL_MS, parseLedgerMessage, useCentrifugo } from "./useCentrifugo";
import type { LedgerPeersTransport } from "@/lib/ledger-peers";

const accountId = "A".repeat(43);
const runtime = {} as SecureEndpointRuntime;
const jwt = `a.${btoa(JSON.stringify({ exp: 4102444800 }))}.c`;
const ledgerChain = { genesis: { payload: {}, signature: {} }, transitions: [] };
function fakeLedger() { return { offer: vi.fn(async () => {}), refresh: vi.fn(async () => {}), noteHead: vi.fn(async () => {}) }; }
function ledgerSub(): FakeSub {
  const found = mocks.subs.filter(sub => sub.channel === `bridges:ledger#${accountId}`);
  expect(found).toHaveLength(1);
  return found[0];
}
const fire = (sub: FakeSub, event: string, ctx: Parameters<Handler>[0] = {}) => { for (const handler of sub.handlers.get(event) ?? []) handler(ctx); };
const fireClient = (event: string, ctx: unknown = {}) => { act(() => { for (const [name, handler] of mocks.clientOn) if (name === event) handler(ctx); }); };
beforeEach(() => {
  mocks.subs.length = 0; mocks.removed.length = 0; mocks.secure.length = 0; mocks.getToken.length = 0; mocks.clientOn.length = 0; mocks.presence.length = 0;
  mocks.presenceResult = null;
});

describe("account ledger channel", () => {
  it("subscribes once to bridges:ledger#<accountId> and feeds only this account's own publications to the ledger client", () => {
    const ledger = fakeLedger();
    const { unmount } = renderHook(() => useCentrifugo(jwt, "wss://relay.test", accountId, { securityRuntime: runtime, ledger }));
    const sub = ledgerSub(); expect(sub.subscribe).toHaveBeenCalledOnce();
    fire(sub, "publication", { data: { type: "ledger", ledger: ledgerChain }, info: { user: accountId } });
    expect(ledger.offer).toHaveBeenCalledExactlyOnceWith(ledgerChain);
    // A head is a throttled hint for the client, never a direct refresh (flooding must not exhaust the read limit).
    fire(sub, "publication", { data: { type: "ledger_head", head: "h".repeat(43), revision: 3 }, info: { user: accountId } });
    expect(ledger.noteHead).toHaveBeenCalledExactlyOnceWith("h".repeat(43), 3); expect(ledger.refresh).not.toHaveBeenCalled();
    // Another account's publication, a server-API publish without client info, and malformed shapes are dropped.
    fire(sub, "publication", { data: { type: "ledger", ledger: ledgerChain }, info: { user: "B".repeat(43) } });
    fire(sub, "publication", { data: { type: "ledger", ledger: ledgerChain } });
    fire(sub, "publication", { data: { type: "ledger", ledger: ledgerChain, extra: true }, info: { user: accountId } });
    fire(sub, "publication", { data: { type: "ledger_head", head: "h", revision: -1 }, info: { user: accountId } });
    fire(sub, "publication", { data: ledgerChain, info: { user: accountId } });
    expect(ledger.offer).toHaveBeenCalledOnce(); expect(ledger.noteHead).toHaveBeenCalledOnce(); expect(ledger.refresh).not.toHaveBeenCalled();
    unmount(); expect(mocks.removed).toContain(`bridges:ledger#${accountId}`);
  });

  it("every (re)subscribe refreshes the ledger, since pushes may have been missed", () => {
    const ledger = fakeLedger();
    renderHook(() => useCentrifugo(jwt, "wss://relay.test", accountId, { securityRuntime: runtime, ledger }));
    const sub = ledgerSub(); fire(sub, "subscribed"); fire(sub, "subscribed");
    expect(ledger.refresh).toHaveBeenCalledTimes(2); expect(ledger.offer).not.toHaveBeenCalled();
  });

  it("every relay token renewal re-reads the ledger after the token is minted; Solo renewals do not", async () => {
    const ledger = fakeLedger(); const refresher = vi.fn(async () => "fresh-token");
    renderHook(() => useCentrifugo(jwt, "wss://relay.test", accountId, { securityRuntime: runtime, ledger, tokenRefresher: refresher }));
    expect(ledger.refresh).not.toHaveBeenCalled();
    await expect(mocks.getToken[0]()).resolves.toBe("fresh-token");
    expect(refresher).toHaveBeenCalledOnce(); expect(ledger.refresh).toHaveBeenCalledOnce();
    refresher.mockRejectedValueOnce(new Error("unauthorized"));
    await expect(mocks.getToken[0]()).rejects.toThrow("unauthorized"); expect(ledger.refresh).toHaveBeenCalledOnce();
    const soloRefresher = vi.fn(async () => "solo-token");
    renderHook(() => useCentrifugo(jwt, "ws://lan.test", "solo", { securityRuntime: runtime, tokenRefresher: soloRefresher }));
    expect(mocks.getToken[1]).toBe(soloRefresher);
  });

  it("a failing ledger client never breaks the connection", async () => {
    const ledger = { offer: vi.fn(async () => { throw new Error("invalid_ledger"); }), refresh: vi.fn(async () => { throw new Error("network_unavailable"); }),
      noteHead: vi.fn(() => { throw new Error("ledger_head_invalid"); }) };
    renderHook(() => useCentrifugo(jwt, "wss://relay.test", accountId, { securityRuntime: runtime, ledger }));
    const sub = ledgerSub();
    expect(() => fire(sub, "publication", { data: { type: "ledger", ledger: ledgerChain }, info: { user: accountId } })).not.toThrow();
    expect(() => fire(sub, "publication", { data: { type: "ledger_head", head: "h", revision: 1 }, info: { user: accountId } })).not.toThrow();
    expect(() => fire(sub, "subscribed")).not.toThrow();
    await Promise.resolve();
  });

  it("Solo/local (no ledger) never subscribe to a ledger channel; the commands channel uses the shared helper", () => {
    renderHook(() => useCentrifugo(jwt, "ws://lan.test", "solo", { securityRuntime: runtime }));
    expect(mocks.subs.some(sub => sub.channel.startsWith("bridges:ledger"))).toBe(false);
    expect(mocks.secure[0]?.userId).toBe("solo");
  });
});

describe("account ledger agreement step (LedgerPeers)", () => {
  const endpoint = { version: 1, id: "E".repeat(43), ownerId: accountId, kind: "browser", publicKey: "P".repeat(87) };
  const accountRuntime = { identity: { endpoint } } as unknown as SecureEndpointRuntime;
  /** A signed head announcement's exact shape (parseHeadAnnouncement accepts it; its signature is never checked here). */
  const announcement = { type: "ledger_head", version: 1, accountId, kind: "bridge", keyId: "studio", head: `${"h".repeat(42)}A`, revision: 3, at: 1, signature: `${"s".repeat(85)}A` };
  function fakePeers() {
    const detach = vi.fn();
    return { detach, attach: vi.fn((_transport: LedgerPeersTransport) => detach), setOnline: vi.fn(), receive: vi.fn(), channelSubscribed: vi.fn() };
  }

  it("attaches this connection (its endpoint, encrypted RPC, ledger channel), feeds it announcements, subscribes and presence; detaches on unmount", async () => {
    const ledger = fakeLedger(); const peers = fakePeers();
    const { unmount } = renderHook(() => useCentrifugo(jwt, "wss://relay.test", accountId, { securityRuntime: accountRuntime, ledger, ledgerPeers: peers }));
    expect(peers.attach).toHaveBeenCalledOnce();
    const transport = peers.attach.mock.calls[0][0];
    expect(transport.self).toBe(endpoint);
    // One encrypted request/response command to one computer, through this connection's SecureMessageClient.
    const answer = await transport.request("studio", "ledger_head", { bridgeId: "studio" }) as { data: { echo: { requestId: string } } };
    expect(mocks.secure[0].request).toHaveBeenCalledExactlyOnceWith({ type: "ledger_head", requestId: expect.any(String), payload: { bridgeId: "studio" } });
    expect(answer.data.echo.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // This browser's own announcement goes out on the ledger subscription.
    const sub = ledgerSub();
    await transport.publish(announcement as never);
    expect(sub.publish).toHaveBeenCalledExactlyOnceWith(announcement);
    // Every (re)subscribe: the client refreshes and the agreement step announces/compares.
    fire(sub, "subscribed");
    expect(ledger.refresh).toHaveBeenCalledOnce(); expect(peers.channelSubscribed).toHaveBeenCalledOnce();
    // Announcements of this account go to the agreement step only; others' and server-API ones are dropped like any publication.
    fire(sub, "publication", { data: announcement, info: { user: accountId } });
    fire(sub, "publication", { data: announcement, info: { user: "B".repeat(43) } });
    fire(sub, "publication", { data: announcement });
    fire(sub, "publication", { data: { ...announcement, extra: 1 }, info: { user: accountId } });
    expect(peers.receive).toHaveBeenCalledExactlyOnceWith(announcement);
    expect(ledger.noteHead).not.toHaveBeenCalled(); expect(ledger.offer).not.toHaveBeenCalled();
    // The bare head hint is still the client's.
    fire(sub, "publication", { data: { type: "ledger_head", head: "h".repeat(43), revision: 3 }, info: { user: accountId } });
    expect(ledger.noteHead).toHaveBeenCalledOnce(); expect(peers.receive).toHaveBeenCalledOnce();
    // Presence of bridges:presence#<accountId> on connect (and every 10 s); a disconnect means nobody is reachable.
    mocks.presenceResult = { clients: { c1: { connInfo: { bridgeId: "studio" } }, c2: { connInfo: { user: "x" } } } };
    fireClient("connected");
    await act(async () => { await Promise.resolve(); });
    expect(mocks.presence).toEqual([`bridges:presence#${accountId}`]);
    expect(peers.setOnline).toHaveBeenLastCalledWith(["studio"]);
    fireClient("disconnected", { code: 0, reason: "clean disconnect" });
    expect(peers.setOnline).toHaveBeenLastCalledWith([]);
    unmount();
    expect(peers.detach).toHaveBeenCalledOnce();
  });

  it("re-reads presence every 10 s while mounted, never after unmount", async () => {
    vi.useFakeTimers();
    try {
      const peers = fakePeers(); const ledger = fakeLedger();
      mocks.presenceResult = { clients: {} };
      const { unmount } = renderHook(() => useCentrifugo(jwt, "wss://relay.test", accountId, { securityRuntime: accountRuntime, ledger, ledgerPeers: peers }));
      await act(async () => { await vi.advanceTimersByTimeAsync(LEDGER_PRESENCE_POLL_MS * 2); });
      expect(mocks.presence).toHaveLength(2);
      unmount();
      await vi.advanceTimersByTimeAsync(LEDGER_PRESENCE_POLL_MS * 3);
      expect(mocks.presence).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a ledger client without an agreement step (not the page's) attaches nothing; announcements are still never given to the client", () => {
    const ledger = fakeLedger();
    renderHook(() => useCentrifugo(jwt, "wss://relay.test", accountId, { securityRuntime: accountRuntime, ledger }));
    const sub = ledgerSub();
    fire(sub, "publication", { data: announcement, info: { user: accountId } });
    expect(ledger.noteHead).not.toHaveBeenCalled(); expect(ledger.offer).not.toHaveBeenCalled();
    fireClient("connected");
    expect(mocks.presence).toEqual([]);
  });

  it("a failing agreement step never breaks the connection", () => {
    const ledger = fakeLedger();
    const peers = { attach: vi.fn(() => () => {}), setOnline: vi.fn(), receive: vi.fn(() => { throw new Error("boom"); }), channelSubscribed: vi.fn(() => { throw new Error("boom"); }) };
    renderHook(() => useCentrifugo(jwt, "wss://relay.test", accountId, { securityRuntime: accountRuntime, ledger, ledgerPeers: peers }));
    const sub = ledgerSub();
    expect(() => fire(sub, "publication", { data: announcement, info: { user: accountId } })).not.toThrow();
    expect(() => fire(sub, "subscribed")).not.toThrow();
    expect(ledger.refresh).toHaveBeenCalledOnce();
  });

  it("Solo/local (no ledger) never attach one, even when given", () => {
    const peers = fakePeers();
    renderHook(() => useCentrifugo(jwt, "ws://lan.test", "solo", { securityRuntime: runtime, ledgerPeers: peers }));
    expect(peers.attach).not.toHaveBeenCalled();
  });
});

describe("parseLedgerMessage", () => {
  it("accepts exactly the two publication shapes", () => {
    expect(parseLedgerMessage({ type: "ledger", ledger: ledgerChain })).toEqual({ type: "ledger", ledger: ledgerChain });
    expect(parseLedgerMessage({ type: "ledger_head", head: "abc", revision: 0 })).toEqual({ type: "ledger_head", head: "abc", revision: 0 });
    for (const value of [null, [], "ledger", { type: "ledger" }, { type: "ledger", ledger: null }, { type: "ledger", ledger: {}, x: 1 },
      { type: "ledger_head", head: "", revision: 1 }, { type: "ledger_head", head: "a", revision: 1.5 }, { type: "ledger_head", head: "a" },
      { type: "ledger_head", head: "a", revision: 1, extra: 1 }, { type: "security_nudge", scope: "account" }]) {
      expect(parseLedgerMessage(value)).toBeNull();
    }
  });
});
