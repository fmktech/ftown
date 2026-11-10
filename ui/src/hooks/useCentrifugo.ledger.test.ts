// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecureEndpointRuntime } from "@/lib/secure-endpoint-runtime";

type Handler = (ctx: { data?: unknown; info?: { user?: string } }) => void;
interface FakeSub { channel: string; handlers: Map<string, Handler[]>; subscribe: () => void; unsubscribe: () => void; removeAllListeners: () => void }
const mocks = vi.hoisted(() => ({ subs: [] as FakeSub[], removed: [] as string[], secure: [] as { userId: string }[], getToken: [] as (() => Promise<string>)[] }));
vi.mock("centrifuge", () => ({
  UnauthorizedError: class extends Error {},
  Centrifuge: class {
    constructor(_url: string, options: { getToken: () => Promise<string> }) { mocks.getToken.push(options.getToken); }
    on() { return this; } off() { return this; } connect() {} disconnect() {}
    newSubscription(channel: string) {
      const handlers = new Map<string, Handler[]>();
      const sub = { channel, handlers, on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return sub; },
        subscribe: vi.fn(), unsubscribe: vi.fn(), removeAllListeners: vi.fn() };
      mocks.subs.push(sub); return sub;
    }
    removeSubscription(sub: FakeSub) { mocks.removed.push(sub.channel); }
    getSubscription() { return null; }
  },
}));
vi.mock("@/lib/secure-message-client", () => ({
  SecureMessageClient: class {
    constructor(_raw: unknown, public userId: string) { mocks.secure.push(this); }
    dispose() {} publish() { return Promise.resolve(); } getSubscription() { return null; }
    newSubscription() { return { on() {}, off() {}, subscribe() {} }; }
  },
}));
vi.mock("@/lib/direct-transport/hybrid-terminal-transport", () => ({ HybridTerminalTransport: class { dispose() {} } }));
import { parseLedgerMessage, useCentrifugo } from "./useCentrifugo";

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
beforeEach(() => { mocks.subs.length = 0; mocks.removed.length = 0; mocks.secure.length = 0; mocks.getToken.length = 0; });

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
