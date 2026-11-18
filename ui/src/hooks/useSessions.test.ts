// @vitest-environment jsdom
import { createElement, useLayoutEffect } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Centrifuge } from "centrifuge";
import type { Command, CommandResponse, CreateSessionPayload, Session, ShellType } from "@/types";
import type { BridgeRpc } from "./useBridgeRpc";
import { useSessions, mergeSessionSnapshot } from "./useSessions";
import { useBridgeRpc } from "./useBridgeRpc";
import type { MessageClient, MessageEvents, MessageSubscription } from "@/lib/message-client";
import type { SecureEndpointRuntime } from "@/lib/secure-endpoint-runtime";
import { SessionList } from "@/components/SessionList";

const row = (id: string, bridgeId = "a", extra: Partial<Session> = {}): Session => ({
  id, bridgeId, name: id, status: "completed", createdAt: "2026-09-30", updatedAt: "2026-09-30", ...extra,

});
function harness(immediate = false, commandTimeoutMs?: number) {
  const responses = new Set<(r: CommandResponse) => void>();
  const subscribed = new Set<() => void>();
  const subscriptions: Array<ReturnType<typeof subscription>> = [];
  const subscriptionOptions: unknown[] = [];
  function subscription() {
    const listeners = new Map<string, Array<(data?: any) => void>>();
    return {
      on: vi.fn((event: string, cb: (data?: any) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), cb]); }),
      emit: (event: string, data?: any) => listeners.get(event)?.forEach(cb => cb(data)),
      listeners,
      subscribe: vi.fn(function (this: ReturnType<typeof subscription>) { this.emit("subscribed", { recovered: false, offset: 0, epoch: "epoch" }); }), unsubscribe: vi.fn(), removeAllListeners: vi.fn(() => listeners.clear()),
    };
  }
  const client = { commandTimeoutMs, getSubscription: () => null, newSubscription: (_channel: string, options?: unknown) => { const s = subscription(); subscriptions.push(s); subscriptionOptions.push(options); return s; }, removeSubscription: vi.fn() };
  const commands: Command[] = [];
  const rpc: BridgeRpc = {
    publishCommand: vi.fn(c => { commands.push(c); }),
    sendCommand: vi.fn(async c => ({ requestId: c.requestId, success: true, data: c.type === "create_session"
      ? { session: row("created-session", (c.payload as CreateSessionPayload).bridgeId ?? "a", { status: "running" }) } : { usages: {} } })),
    sendCommandCollect: vi.fn(), bridgeExec: vi.fn(), lastResponse: null,
    onResponse: cb => { responses.add(cb); return () => { responses.delete(cb); }; },
    onSubscribed: cb => { subscribed.add(cb); if (immediate) cb(); return () => { subscribed.delete(cb); }; },
  };
  const reply = (id: string, sessions: unknown[], bridgeId?: string, success = true) => act(() => {
    responses.forEach(cb => cb({ requestId: id, success, data: { sessions, ...(bridgeId === undefined ? {} : { bridgeId }) } }));
  });
  const recover = (recovered = false) => act(() => subscriptions.at(-1)?.emit("subscribed", { recovered, offset: recovered ? 1 : 0, epoch: "epoch" }));
  const publication = (s: Session, status?: string) => act(() => subscriptions.at(-1)!.emit("publication", { data: { type: "session_update", session: { ...s, ...(status ? { status } : {}) } } }));
  const request = () => commands.filter(c => c.type === "list_sessions").at(-1)!.requestId;
  return { client: client as unknown as Centrifuge, rpc, commands, responses, subscribed, subscriptions, subscriptionOptions, reply, recover, publication, request };
}
let visibility = "visible";
beforeEach(() => { vi.useFakeTimers(); visibility = "visible"; Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility }); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(immediate = false, commandTimeoutMs?: number, usageView: string | null = null) {
  const h = harness(immediate, commandTimeoutMs);
  const hook = renderHook(({ userId, selectedUsageView }) => useSessions(h.client, userId, h.rpc, selectedUsageView), { initialProps: { userId: "user" as string | null, selectedUsageView: usageView } });
  const refresh = () => act(() => hook.result.current.refreshSessions());
  const ids = () => hook.result.current.sessions.map(s => s.id);
  const setUsageView = (selectedUsageView: string | null) => hook.rerender({ userId: "user", selectedUsageView });
  return { ...h, ...hook, refresh, ids, setUsageView };
}
describe("structured session creation through the actual hook", () => {
  const shellTypes: ShellType[] = ["claude", "cursor", "codex", "shell", "zai", "kimi", "opencode", "deepseek", "fireworks", "grok", "pi", "kimi-code", "muse", "antigravity"];

  it("sends account selection and child restrictions through the dashboard RPC", async () => {
    const h = setup();
    await act(async () => h.result.current.createSession("", { shellType: "claude", bridgeId: "chosen", account: "work", allowedAccounts: ["work"], parentSessionId: "manager" }));
    const command = vi.mocked(h.rpc.sendCommand).mock.calls.map(([value]) => value).find(value => value.type === "create_session")!;
    expect(command.payload).toMatchObject({ account: "work", allowedAccounts: ["work"], parentSessionId: "manager" });
    h.publication(row("account-session", "a", { account: "work", allowedAccounts: ["work"] }));
    expect(h.result.current.sessions.find(session => session.id === "account-session")).toMatchObject({ account: "work", allowedAccounts: ["work"] });
  });

  it.each(shellTypes)("leaves %s command and task delivery construction to the bridge", async (shellType) => {
    const h = setup();
    const prompt = "inspect today's changes; $(not a command)\nsecond line";
    await act(async () => h.result.current.createSession(prompt, {
      shellType, model: "provider/model 'quoted'", name: "named session", workingDir: "/work/with spaces",
      bridgeId: "chosen-bridge", env: { CUSTOM_VALUE: "kept verbatim" }, createMissingWorkingDir: true,
    }));
    const command = vi.mocked(h.rpc.sendCommand).mock.calls.map(([value]) => value).find(value => value.type === "create_session")!;
    expect(command.payload).toMatchObject({ prompt, shellType, model: "provider/model 'quoted'", name: "named session",
      workingDir: "/work/with spaces", bridgeId: "chosen-bridge", env: { CUSTOM_VALUE: "kept verbatim" }, createMissingWorkingDir: true });
    for (const key of ["command", "initialInput", "initialInputDelay"]) expect(command.payload).not.toHaveProperty(key);
    expect(command.requestId).toEqual(expect.any(String));
  });

  it("defaults to Claude and preserves every native resume identifier without inventing input", async () => {
    const h = setup();
    const resume = { claudeSessionId: "claude-id", cursorSessionId: "cursor-id", codexSessionId: "codex-id",
      museSessionId: "muse-id", grokSessionId: "grok-id", antigravitySessionId: "antigravity-id", piSessionId: "pi-id", piSessionFile: "/work/pi session.jsonl", opencodeSessionId: "opencode-id" };
    await act(async () => h.result.current.createSession("", resume));
    const command = vi.mocked(h.rpc.sendCommand).mock.calls.map(([value]) => value).find(value => value.type === "create_session")!;
    expect(command.payload).toMatchObject({ prompt: "", shellType: "claude", ...resume });
    expect(command.payload).not.toHaveProperty("createMissingWorkingDir");
    expect(command.payload).not.toHaveProperty("initialInput");
    expect(command.payload).not.toHaveProperty("command");
  });
});

describe("session-list transport deadlines through the actual hook", () => {
  it.each([
    { signalRpc: false, readyBeforeFailure: false, hidden: false, persistentDenial: false },
    { signalRpc: true, readyBeforeFailure: false, hidden: false, persistentDenial: false },
    { signalRpc: false, readyBeforeFailure: true, hidden: false, persistentDenial: false },
    { signalRpc: false, readyBeforeFailure: false, hidden: true, persistentDenial: false },
    { signalRpc: false, readyBeforeFailure: false, hidden: false, persistentDenial: true },
  ])("reconciles pending initial inventory after security readiness: %o", async ({ signalRpc, readyBeforeFailure, hidden, persistentDenial }) => {
    type Listener = (context: never) => void;
    const sent: Command[] = [];
    const states = new Map([["a", "ready"], ["b", "offline"]]);
    const changed = new Set<() => void>();
    let rejectInitial!: () => void;
    const runtime = {
      onChange: (listener: () => void) => { changed.add(listener); return () => { changed.delete(listener); }; },
      state: (bridgeId: string) => ({ bridgeId, status: states.get(bridgeId) }),
      snapshot: () => [...states].map(([bridgeId, status]) => ({ bridgeId, status })),
      pinnedBridges: () => [...states.keys()].map(bridgeId => ({ bridgeId })),
    } as unknown as SecureEndpointRuntime;
    const subscriptions = new Map<string, Subscription>();
    class Subscription implements MessageSubscription {
      state = "subscribed";
      private listeners = new Map<keyof MessageEvents, Set<Listener>>();
      constructor(readonly channel: string) {}
      subscribe() { if (this.channel.startsWith("sessions:")) this.emit("subscribed", { recovered: false, offset: 0, epoch: "epoch" }); }
      unsubscribe() {}
      async presence() { return { clients: {} }; }
      on<E extends keyof MessageEvents>(event: E, listener: (context: MessageEvents[E]) => void) {
        const listeners = this.listeners.get(event) ?? new Set<Listener>(); listeners.add(listener as Listener); this.listeners.set(event, listeners); return this;
      }
      off<E extends keyof MessageEvents>(event: E, listener: (context: MessageEvents[E]) => void) { this.listeners.get(event)?.delete(listener as Listener); return this; }
      removeAllListeners() { this.listeners.clear(); }
      emit<E extends keyof MessageEvents>(event: E, context: MessageEvents[E]) { for (const listener of this.listeners.get(event) ?? []) listener(context as never); }
      async publish(value: unknown) {
        const command = value as Command; sent.push(command);
        // Both bridges are known targets, matching the secure adapter. The
        // first empty reply succeeds while the other target's publish fails.
        const targets = [...states.keys()];
        await Promise.resolve();
        let failed = false;
        for (const bridgeId of targets) {
          if (states.get(bridgeId) !== "ready" || persistentDenial && bridgeId === "b") { failed = true; continue; }
          this.emit("publication", { info: { user: "user" }, data: { type: "command_response", response: {
            requestId: command.requestId, success: true, data: { bridgeId, sessions: bridgeId === "b" ? [row("existing-b", "b", { status: "running" })] : [] },
          } } });
        }
        if (failed) {
          if (readyBeforeFailure && sent.length === 1) await new Promise<void>((_, reject) => { rejectInitial = () => reject(new Error("Initial bridge handshake failed")); });
          throw new Error("Initial bridge handshake failed");
        }
      }
    }
    const client: MessageClient = {
      securityRuntime: runtime,
      getSubscription: channel => subscriptions.get(channel) ?? null,
      newSubscription: channel => { const sub = new Subscription(channel); subscriptions.set(channel, sub); return sub; },
      removeSubscription: () => {},
    };
    const hook = renderHook(() => { const rpc = useBridgeRpc(client, "user"); return useSessions(client, "user", rpc); });
    await act(async () => {});
    expect(sent).toHaveLength(1);
    expect(hook.result.current.sessions).toEqual([]);
    if (hidden) visibility = "hidden";
    await act(async () => {
      states.set("b", "ready"); changed.forEach(listener => listener());
      if (readyBeforeFailure) rejectInitial();
      if (signalRpc) subscriptions.get("commands:rpc#user")!.emit("subscribed", {});
    });
    if (hidden) {
      expect(sent).toHaveLength(1);
      expect(hook.result.current.sessions).toEqual([]);
      await act(async () => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
    }
    expect(hook.result.current.sessions.map(session => session.id)).toEqual(persistentDenial ? [] : ["existing-b"]);
    expect(sent).toHaveLength(2);
    await act(async () => { changed.forEach(listener => listener()); await vi.advanceTimersByTimeAsync(60_000); });
    expect(sent).toHaveLength(2);
    if (!persistentDenial) {
      await act(async () => {
        states.set("b", "offline"); changed.forEach(listener => listener());
        states.set("b", "ready"); changed.forEach(listener => listener());
        subscriptions.get("sessions:updates#user")!.emit("subscribed", { recovered: true, positioned: true, offset: 1, epoch: "epoch" });
        subscriptions.get("commands:rpc#user")!.emit("subscribed", {});
      });
      expect(sent).toHaveLength(2);
    }
  });

  it.each(["user", "client"])("ignores a retained ready callback during a %s change before effect cleanup", async boundary => {
    const h = harness(true);
    const changed = new Set<() => void>();
    let ready = false;
    const runtime = {
      onChange: (listener: () => void) => { changed.add(listener); return () => { changed.delete(listener); }; },
      snapshot: () => [{ bridgeId: "a", status: ready ? "ready" : "offline" }],
      state: () => ({ status: ready ? "ready" : "offline" }),
    } as unknown as SecureEndpointRuntime;
    const first: MessageClient = { securityRuntime: runtime, getSubscription: () => null,
      newSubscription: (...args) => h.client.newSubscription(...args) as unknown as MessageSubscription, removeSubscription: vi.fn() };
    const replacement = { ...first };
    let retained: (() => void) | undefined;
    const hook = renderHook(({ client, user }) => {
      const result = useSessions(client, user, h.rpc);
      useLayoutEffect(() => { if (client !== first || user !== "user") { ready = true; retained?.(); } }, [client, user]);
      return result;
    }, { initialProps: { client: first, user: "user" } });
    retained = [...changed][0];
    act(() => h.responses.forEach(listener => listener({ requestId: h.request(), success: false })));
    expect(h.commands.filter(command => command.type === "list_sessions")).toHaveLength(1);
    hook.rerender({ client: boundary === "client" ? replacement : first, user: boundary === "user" ? "other" : "user" });
    expect(h.commands.filter(command => command.type === "list_sessions")).toHaveLength(2);
    expect(hook.result.current.sessions).toEqual([]);
  });

  it("retains independent broadcast replies after 35 seconds with a 40-second transport budget", () => {
    const h = setup(true, 40_000); const request = h.request(); visibility = "hidden";
    act(() => vi.advanceTimersByTime(35_000));
    h.reply(request, [row("delayed-a")], "a");
    h.reply(request, [row("delayed-b", "b")], "b");
    expect(h.ids()).toEqual(["delayed-a", "delayed-b"]);
  });

  it.each([40_000, 40_001])("rejects a snapshot at or after the 40-second transport deadline (%s ms)", delay => {
    const h = setup(false, 40_000); h.publication(row("keep")); h.recover(); const request = h.request(); visibility = "hidden";
    act(() => vi.advanceTimersByTime(delay));
    h.reply(request, [row("unexpected")], "a");
    expect(h.ids()).toEqual(["keep"]);
  });

  it("honors a finite positive transport budget shorter than the fallback", () => {
    const h = setup(true, 5_000); const early = h.request(); visibility = "hidden";
    act(() => vi.advanceTimersByTime(4_999)); h.reply(early, [row("keep")], "a");
    expect(h.ids()).toEqual(["keep"]);
    h.refresh(); const late = h.request(); act(() => vi.advanceTimersByTime(5_000));
    h.reply(late, [row("unexpected")], "a");
    expect(h.ids()).toEqual(["keep"]);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1])("retains the 30-second fallback for an absent or invalid budget (%s)", budget => {
    const h = setup(true, budget); const early = h.request(); visibility = "hidden";
    act(() => vi.advanceTimersByTime(29_999)); h.reply(early, [row("keep")], "a");
    expect(h.ids()).toEqual(["keep"]);
    h.refresh(); const late = h.request(); act(() => vi.advanceTimersByTime(30_000));
    h.reply(late, [row("unexpected")], "a");
    expect(h.ids()).toEqual(["keep"]);
  });
});

describe("retirement reconciliation through actual hook callbacks", () => {
  it("never refreshes visible usage or session lists from an idle timer", async () => {
    const h = setup(true, undefined, "one");
    const usage = { inputTokens: 9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 9, models: [], harness: "codex", collectedAt: "2026-09-30T12:00:00Z" };
    vi.mocked(h.rpc.sendCommand).mockImplementation(async c => ({ requestId: c.requestId, success: true, data: { usages: { one: usage } } }));
    h.reply(h.request(), [row("one", "a", { status: "running", codexSessionId: "resume-one" })], "a");
    await act(async () => {});
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(1);
    expect(h.result.current.sessions[0].usage).toEqual(usage);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(1);
    expect(h.commands.filter(c => c.type === "list_sessions")).toHaveLength(1);
  });

  it("coalesces relevant session changes and does not refresh for another session or a usage reply", async () => {
    const h = setup(true, undefined, "one");
    let finish!: (response: CommandResponse) => void;
    vi.mocked(h.rpc.sendCommand).mockImplementation(c => new Promise(resolve => { finish = resolve; }));
    const selected = row("one", "a", { status: "running", codexSessionId: "resume-one" });
    h.reply(h.request(), [selected, row("two", "a", { status: "running", codexSessionId: "resume-two" })], "a");
    await act(async () => {});
    h.publication(row("two", "a", { status: "running", updatedAt: "changed" }));
    await act(async () => {});
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(1);
    act(() => { for (let i = 0; i < 20; i++) h.publication({ ...selected, updatedAt: `change-${i}` }); });
    await act(async () => {});
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(1);
    await act(async () => finish({ requestId: "usage", success: true, data: { usages: {} } }));
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(2);
    await act(async () => finish({ requestId: "usage", success: true, data: { usages: {} } }));
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("reads usage immediately for only the visible selected running session and follows selection", async () => {
    const h = setup(true, undefined, "one");
    h.reply(h.request(), [row("one", "a", { status: "running", codexSessionId: "resume-one" }), row("two", "a", { status: "running", codexSessionId: "resume-two" })], "a");
    await act(async () => { await Promise.resolve(); });
    const usageCalls = () => vi.mocked(h.rpc.sendCommand).mock.calls.map(([command]) => command).filter(command => command.type === "get_sessions_usage");
    expect(usageCalls()).toHaveLength(1);
    expect(usageCalls()[0].payload).toMatchObject({ bridgeId: "a", sessionIds: ["one"] });
    h.setUsageView("two");
    await act(async () => { await Promise.resolve(); });
    expect(usageCalls()).toHaveLength(2);
    expect(usageCalls()[1].payload).toMatchObject({ bridgeId: "a", sessionIds: ["two"] });
    visibility = "hidden"; act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(usageCalls()).toHaveLength(2);
  });
  it("refreshes when the visible session acquires a collector resume id without a timestamp change", async () => {
    const h = setup(true, undefined, "one");
    const selected = row("one", "a", { status: "running" });
    h.reply(h.request(), [selected], "a"); await act(async () => {});
    expect(h.rpc.sendCommand).not.toHaveBeenCalled();
    h.publication({ ...selected, codexSessionId: "new-resume-id" }); await act(async () => {});
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.rpc.sendCommand).mock.calls[0][0]).toMatchObject({ type: "get_sessions_usage", payload: { sessionIds: ["one"] } });
  });

  it("applies create, status, rename, and remove publications without periodic list reads", () => {
    const h = setup();
    const listReads = () => h.commands.filter(command => command.type === "list_sessions").length;
    expect(listReads()).toBe(1); // initial subscription requests its authoritative snapshot
    const created = row("pushed", "a", { status: "running", name: "before" });
    h.publication(created);
    expect(h.result.current.sessions).toEqual([created]);
    h.publication({ ...created, status: "completed", updatedAt: "2026-11-18T00:01:00.000Z" });
    expect(h.result.current.sessions[0]).toMatchObject({ id: "pushed", status: "completed" });
    h.publication({ ...created, name: "renamed", updatedAt: "2026-11-18T00:02:00.000Z" });
    expect(h.result.current.sessions[0]).toMatchObject({ id: "pushed", name: "renamed" });
    h.publication(created, "removed");
    expect(h.ids()).toEqual([]);
    expect(listReads()).toBe(1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(listReads()).toBe(1);
  });

  it("heals missed self/parent removal on reconnect with empty owner and isolates offline owners", () => {
    const h = setup(true); h.reply(h.request(), [row("self"), row("parent-child")], "a");
    h.reply(h.request(), [row("offline", "b")], "b");
    h.recover(false); h.reply(h.request(), [], "a"); expect(h.ids()).toEqual(["offline"]);
  });
  it("does not issue blind list reads while visible", () => {
    const h = setup(true); h.reply(h.request(), [row("retired")], "a");
    act(() => vi.advanceTimersByTime(120_000)); expect(h.commands.filter(c => c.type === "list_sessions")).toHaveLength(1); expect(h.ids()).toEqual(["retired"]);
  });
  it("retains normal completed sessions", () => {
    const h = setup(true); h.reply(h.request(), [row("done")], "a"); h.refresh(); h.reply(h.request(), [row("done")], "a"); expect(h.ids()).toEqual(["done"]);
  });
  it("confirmed publication stays removed beyond 12 seconds across every merge path", () => {
    const h = setup(true); const old = h.request(); h.reply(old, [row("gone")], "a");
    h.publication(row("gone"), "removed"); act(() => vi.advanceTimersByTime(13_000));
    h.publication(row("gone")); h.reply("partial", [row("gone")]); h.refresh(); h.reply(h.request(), [row("gone")], "a"); expect(h.ids()).toEqual([]);
    h.publication(row("revived-new-id")); expect(h.ids()).toEqual(["revived-new-id"]);
  });
  it("tombstones snapshot-pruned IDs against delayed status", () => {
    const h = setup(true); h.reply(h.request(), [row("gone")], "a"); h.refresh(); h.reply(h.request(), [], "a");
    act(() => vi.advanceTimersByTime(13_000)); h.publication(row("gone")); expect(h.ids()).toEqual([]);
  });
  it("rejects reversed and duplicate owner replies while keeping the broadcast record for other owners", () => {
    const h = setup(true); const old = h.request(); h.refresh(); const latest = h.request();
    h.reply(latest, [row("new")], "a"); h.reply(old, [row("old")], "a"); h.reply(latest, [], "a");
    h.reply(latest, [row("b", "b")], "b"); expect(h.ids()).toEqual(["new", "b"]);
  });
  it("preserves all row fields and new membership observed after the request", () => {
    const h = setup(true); h.reply(h.request(), [row("active")], "a"); h.refresh();
    const fresh = row("active", "a", { name: "fresh", status: "running", parentSessionId: "new-parent" });
    h.publication(fresh); h.publication(row("new")); h.reply(h.request(), [row("active")], "a");
    expect(h.result.current.sessions.find(s => s.id === "active")).toEqual(fresh); expect(h.ids()).toContain("new");
  });
  it("partial, legacy, malformed, mixed-owner, failed and unknown replies are never absence evidence", () => {
    const h = setup(true); h.reply(h.request(), [row("keep")], "a");
    h.refresh(); h.reply(h.request(), []); h.reply("partial", [row("partial")]);
    h.reply(h.request(), [null, row("valid")], "a"); h.reply(h.request(), [row("other", "b")], "a");
    h.reply(h.request(), [], "a", false); h.reply("unknown", [row("unknown")], "a");
    expect(h.ids()).toEqual(expect.arrayContaining(["keep", "partial", "valid", "other"]));
    expect(h.ids()).not.toContain("unknown");
  });
  it("expired request IDs cannot prune", () => {
    const h = setup(true); const old = h.request(); h.reply(old, [row("keep")]);
    act(() => vi.advanceTimersByTime(31_000)); h.reply(old, [], "a"); expect(h.ids()).toContain("keep");
  });
  it("resets state/tombstones and ignores captured callbacks on user-context switch", () => {
    const h = setup(true); h.publication(row("gone"), "removed"); h.publication(row("previous"));
    const oldResponse = [...h.responses][0]; const oldPub = h.subscriptions[0].listeners.get("publication")![0];
    h.rerender({ userId: "other-user", selectedUsageView: null }); expect(h.ids()).toEqual([]);
    act(() => { oldResponse({ requestId: "old", success: true, data: { sessions: [row("leak")] } }); oldPub({ data: { type: "session_update", session: row("leak") } }); });
    h.publication(row("gone")); expect(h.ids()).toEqual(["gone"]);
    h.rerender({ userId: null, selectedUsageView: null }); expect(h.ids()).toEqual([]);
  });
  it("optimistic expiry reconciles retained sessions without a reload", () => {
    const h = setup(true); h.reply(h.request(), [row("retained")], "a"); act(() => h.result.current.removeSession("retained")); expect(h.ids()).toEqual([]);
    act(() => vi.advanceTimersByTime(12_000)); h.reply(h.request(), [row("retained")], "a"); expect(h.ids()).toEqual(["retained"]);
  });
  it("failed optimistic publish reconciles, but confirmed removal dominates rollback", () => {
    const h = setup(true); h.reply(h.request(), [row("retained")], "a"); act(() => h.result.current.removeSession("retained"));
    const removal = h.commands.at(-1)!;
    act(() => h.responses.forEach(cb => cb({ requestId: removal.requestId, success: false })));
    h.reply(h.request(), [row("retained")], "a"); expect(h.ids()).toEqual(["retained"]);
    act(() => h.result.current.removeSession("retained")); h.publication(row("retained"), "removed");
    act(() => vi.advanceTimersByTime(13_000)); h.reply(h.request(), [row("retained")], "a"); expect(h.ids()).toEqual([]);
  });
  it("generic remove success is not authoritative and guarded/offline removal is not optimistic", () => {
    const h = setup(true); h.reply(h.request(), [row("keep")], "a");
    act(() => h.result.current.removeSession("keep", true)); expect(h.ids()).toEqual(["keep"]);
    act(() => h.result.current.removeSession("keep", false, false)); expect(h.ids()).toEqual(["keep"]);
    act(() => h.result.current.removeSession("keep"));
    act(() => h.responses.forEach(cb => cb({ requestId: h.commands.at(-1)!.requestId, success: true, data: { removed: false } })));
    act(() => vi.advanceTimersByTime(12_000)); h.reply(h.request(), [row("keep")], "a"); expect(h.ids()).toEqual(["keep"]);
  });
  it("reloads only on failed recovery and visibility return", () => {
    const h = setup(true); const count = () => h.commands.filter(c => c.type === "list_sessions").length;
    expect(h.subscriptionOptions[0]).toMatchObject({ recoverable: true, positioned: true, since: { offset: 0, epoch: "" } });
    expect(count()).toBe(1);
    act(() => h.subscriptions[0].emit("subscribed", { recovered: true, positioned: true, wasRecovering: true, offset: 1, epoch: "epoch" })); expect(count()).toBe(1);
    act(() => h.subscriptions[0].emit("subscribed", { recovered: false, offset: 0, epoch: "new-epoch" })); expect(count()).toBe(2);
    visibility = "hidden"; act(() => document.dispatchEvent(new Event("visibilitychange")));
    visibility = "visible"; act(() => document.dispatchEvent(new Event("visibilitychange"))); expect(count()).toBe(3);
  });
  it("does not read when the RPC channel reconnects after successful sessions recovery", () => {
    const h = setup(true);
    h.reply(h.request(), [row("keep")], "a");
    act(() => {
      h.subscribed.forEach(callback => callback());
      h.subscriptions[0].emit("subscribed", { recovered: true, positioned: true, offset: 5, epoch: "epoch" });
      h.subscribed.forEach(callback => callback());
    });
    expect(h.commands.filter(c => c.type === "list_sessions")).toHaveLength(1);
    for (const context of [{ recovered: true, positioned: true, offset: 6, epoch: "changed" },
      { recovered: true, positioned: true, offset: 3, epoch: "changed" }, { recovered: true, positioned: false, offset: 3, epoch: "changed" }]) {
      act(() => h.subscriptions[0].emit("subscribed", context));
    }
    expect(h.commands.filter(c => c.type === "list_sessions")).toHaveLength(4);
  });
  it("retries the first list after security readiness when its first publication was rejected", () => {
    const h = setup(true);
    act(() => h.responses.forEach(callback => callback({ requestId: h.request(), success: false, data: { code: "approval_required" } })));
    act(() => h.subscribed.forEach(callback => callback()));
    expect(h.commands.filter(c => c.type === "list_sessions")).toHaveLength(2);
  });
  it("cleans up timers, listeners and stale callbacks on unmount", () => {
    const h = setup(true); const cb = [...h.responses][0]; h.unmount(); const count = h.commands.length;
    act(() => { vi.advanceTimersByTime(60_000); document.dispatchEvent(new Event("visibilitychange")); cb({ requestId: "old", success: true, data: { sessions: [row("leak")] } }); });
    expect(h.commands).toHaveLength(count); expect(h.responses.size).toBe(0); expect(h.subscriptions[0].unsubscribe).toHaveBeenCalled();
  });
  it("renders retirement in the real SessionList fed by hook state", () => {
    const h = harness(true);
    function Sidebar() { const { sessions } = useSessions(h.client, "user", h.rpc); return createElement(SessionList, { sessions, bridges: [], bridgeOrder: ["a"], selectedSessionId: null, onSelectSession: () => {} }); }
    render(createElement(Sidebar)); h.reply(h.request(), [row("visible-retired")], "a"); expect(screen.queryByText("visible-retired")).not.toBeNull();
    h.recover(); h.reply(h.request(), [], "a"); expect(screen.queryByText("visible-retired")).toBeNull();
  });
  it("registers request metadata before a synchronous publish response", () => {
    const h = setup(); h.publication(row("gone"));
    vi.mocked(h.rpc.publishCommand).mockImplementation(c => {
      h.commands.push(c);
      if (c.type === "list_sessions") h.responses.forEach(cb => cb({ requestId: c.requestId, success: true, data: { bridgeId: "a", sessions: [] } }));
    });
    h.recover(false); expect(h.ids()).toEqual([]);
  });
  it("bounds request records even with a flood of unanswered refreshes", () => {
    const h = setup(true); const evicted = h.request(); h.reply(evicted, [row("keep")]);
    act(() => { for (let i = 0; i < 65; i++) h.result.current.refreshSessions(); });
    h.reply(evicted, [], "a"); expect(h.ids()).toEqual(["keep"]);
  });
  it("evicted scoped list cannot overwrite fresher fields or add rows", () => {
    const h = setup(true); const old = h.request();
    const fresh = row("keep", "a", { name: "fresh", status: "running", parentSessionId: "fresh-parent" });
    h.publication(fresh);
    act(() => { for (let i = 0; i < 65; i++) h.result.current.refreshSessions(); });
    h.reply(old, [row("keep"), row("unexpected")], "a");
    expect(h.result.current.sessions).toEqual([fresh]);
  });
  it("failed or unidentified replies do not consume another owner's broadcast response", () => {
    const h = setup(true); const request = h.request();
    h.reply(request, [], "a", false); h.reply(request, []);
    h.reply(request, [row("a")], "a"); h.reply(request, [row("b", "b")], "b"); expect(h.ids()).toEqual(["a", "b"]);
    h.refresh(); h.reply(h.request(), [], "a", false); expect(h.ids()).toEqual(["a", "b"]);
  });
  it("protects confirmed optimism after authoritative empty list and subsequent expiry", () => {
    const h = setup(true); h.reply(h.request(), [row("gone")], "a");
    act(() => h.result.current.removeSession("gone")); h.refresh(); h.reply(h.request(), [], "a");
    act(() => vi.advanceTimersByTime(13_000)); h.publication(row("gone")); h.reply("partial", [row("gone")]); expect(h.ids()).toEqual([]);
  });
  it("retains fresher usage when a completed snapshot has stale usage", () => {
    const h = setup(true);
    const usage = { inputTokens: 9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 9, models: [], harness: "codex", collectedAt: "2026-09-30T12:00:00Z" };
    h.reply(h.request(), [row("done", "a", { usage })], "a");
    h.refresh(); h.reply(h.request(), [row("done", "a", { usage: { ...usage, collectedAt: "2026-09-30T11:00:00Z", totalTokens: 1 } })], "a");
    expect(h.result.current.sessions[0].usage).toEqual(usage);
  });
  it("live usage observations protect membership and fields from an in-flight snapshot", async () => {
    const h = setup(true, undefined, "running"); h.reply(h.request(), [row("running", "a", { status: "running", codexSessionId: "scratch-codex" })], "a"); h.refresh(); const inflight = h.request();
    const usage = { inputTokens: 9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 9, models: [], harness: "codex", collectedAt: "2026-09-30T12:00:00Z" };
    vi.mocked(h.rpc.sendCommand).mockImplementation(async c => ({ requestId: c.requestId, success: true, data: { usages: { running: usage } } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    h.reply(inflight, [], "a"); expect(h.ids()).toEqual(["running"]); expect(h.result.current.sessions[0].usage).toEqual(usage);
  });

  it("malformed optional fields cannot turn a snapshot into absence evidence", () => {
    const h = setup(true); h.reply(h.request(), [row("keep")], "a"); h.refresh();
    h.reply(h.request(), [{ ...row("malformed"), usage: { collectedAt: "bad" } }], "a");
    expect(h.ids()).toEqual(["keep"]);
  });

  it("malformed array status is not authoritative absence evidence", () => {
    const h = setup(true); h.reply(h.request(), [row("keep")], "a"); h.refresh();
    h.reply(h.request(), [{ ...row("bad"), status: ["completed"] }], "a");
    expect(h.ids()).toEqual(["keep"]);
  });
  it("expired list does not overwrite fields observed after issuance", () => {
    const h = setup(true); const old = h.request();
    const fresh = row("keep", "a", { name: "fresh", status: "running" });
    h.publication(fresh);
    act(() => vi.advanceTimersByTime(31_000)); h.reply(old, [row("keep")], "a");
    expect(h.result.current.sessions[0]).toEqual(fresh);
  });

});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "session",
    status: "running",
    bridgeId: "bridge-1",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("mergeSessionSnapshot", () => {
  it("canonicalizes PR metadata without changing the incoming snapshot", () => {
    const incoming = makeSession({ pullRequestUrl: "https://github.com/Org/repo/pull/0123/?tab=files" });
    expect(mergeSessionSnapshot(undefined, incoming).pullRequestUrl).toBe("https://github.com/Org/repo/pull/123");
    expect(incoming.pullRequestUrl).toContain("?tab=files");
  });

  it("clears a previous PR when a complete snapshot omits the field", () => {
    expect(mergeSessionSnapshot(makeSession({ pullRequestUrl: "https://github.com/a/b/pull/1" }), makeSession())).not.toHaveProperty("pullRequestUrl");
  });
  it("keeps the existing bridgeId when the incoming row omits it", () => {
    const current = makeSession({ id: "s1", bridgeId: "bridge-1" });
    const incoming = makeSession({
      id: "s1",
      bridgeId: undefined,
    } as unknown as Partial<Session>) as Session;

    const result = mergeSessionSnapshot(current, incoming);
    expect(result.bridgeId).toBe("bridge-1");
  });

  it("replaces bridgeId when the incoming row provides a new one", () => {
    const current = makeSession({ id: "s1", bridgeId: "bridge-1" });
    const incoming = makeSession({ id: "s1", bridgeId: "bridge-2" });

    const result = mergeSessionSnapshot(current, incoming);
    expect(result.bridgeId).toBe("bridge-2");
  });

  it("leaves a brand-new session without a bridgeId when there is no existing row to merge against", () => {
    const incoming = makeSession({
      id: "s1",
      bridgeId: undefined,
    } as unknown as Partial<Session>) as Session;

    const result = mergeSessionSnapshot(undefined, incoming);
    expect(result.bridgeId).toBeFalsy();
  });

  it("preserves bridgeId across a full-list snapshot merge", () => {
    const prev = [makeSession({ id: "s1", bridgeId: "bridge-1" })];
    const incomingList = [
      makeSession({
        id: "s1",
        bridgeId: undefined,
      } as unknown as Partial<Session>) as Session,
    ];

    const merged = new Map(prev.map((s) => [s.id, s]));
    for (const s of incomingList) {
      merged.set(s.id, mergeSessionSnapshot(merged.get(s.id), s));
    }

    expect(merged.get("s1")!.bridgeId).toBe("bridge-1");
  });

  it("returns the incoming session unchanged when current is undefined", () => {
    const incoming = makeSession({
      id: "s2",
      name: "new-session",
      bridgeId: "bridge-new",
    });

    const result = mergeSessionSnapshot(undefined, incoming);
    expect(result).toEqual(incoming);
  });
});

describe("PR snapshots through actual session ingestion", () => {
  it.each([null, 123, {}, "javascript:alert(1)", "https://evil.test/a/b/pull/1"])("retains a session with malformed optional PR metadata %#", pullRequestUrl => {
    const h = setup(true);
    h.reply(h.request(), [{ ...row("safe-session"), pullRequestUrl }], "a");
    expect(h.ids()).toEqual(["safe-session"]);
    expect(h.result.current.sessions[0]).not.toHaveProperty("pullRequestUrl");
  });

  it("replaces and clears live PR snapshots while preserving other sessions", () => {
    const h = setup(true);
    h.reply(h.request(), [row("target"), row("other")], "a");
    h.publication(row("target", "a", { pullRequestUrl: "https://github.com/a/b/pull/1" }));
    expect(h.result.current.sessions.find(s => s.id === "target")?.pullRequestUrl).toBe("https://github.com/a/b/pull/1");
    h.publication(row("target", "a", { pullRequestUrl: "https://github.com/a/b/pull/2" }));
    expect(h.result.current.sessions.find(s => s.id === "target")?.pullRequestUrl).toBe("https://github.com/a/b/pull/2");
    h.publication(row("target"));
    expect(h.result.current.sessions.find(s => s.id === "target")).not.toHaveProperty("pullRequestUrl");
    expect(h.result.current.sessions.find(s => s.id === "other")).toEqual(row("other"));
  });

  it("clears a stored PR after a full list reload without that metadata", () => {
    const h = setup(true);
    h.reply(h.request(), [row("target", "a", { pullRequestUrl: "https://github.com/a/b/pull/1" })], "a");
    h.refresh();
    h.reply(h.request(), [row("target")], "a");
    expect(h.result.current.sessions[0]).not.toHaveProperty("pullRequestUrl");
  });
});

it("reconciles correlated local transport snapshots using its bridge scope", () => {
  const h = harness(true);
  Object.assign(h.client, { sessionSnapshotBridgeId: "a" });
  const hook = renderHook(() => useSessions(h.client, "user", h.rpc));
  h.reply(h.request(), [row("local")]);
  act(() => hook.result.current.refreshSessions());
  h.reply(h.request(), []);
  expect(hook.result.current.sessions).toEqual([]);
});

describe("create response identity before session publications", () => {
  it("returns and reconciles the exact successful session before its publication arrives", async () => {
    const h = setup();
    const created = row("created-id", "a", { status: "running", name: "Created session" });
    vi.mocked(h.rpc.sendCommand).mockImplementation(async command => ({ requestId: command.requestId, success: true, data: { session: created } }));
    let result: unknown;
    await act(async () => { result = await h.result.current.createSession("", { shellType: "shell", bridgeId: "a" }); });
    expect(result).toEqual(created);
    expect(h.result.current.sessions).toEqual([created]);
  });
});

describe("create result reconciliation boundaries", () => {
  function pendingCreate() {
    const h = setup(true);
    let resolve!: (response: CommandResponse) => void;
    vi.mocked(h.rpc.sendCommand).mockImplementation(() => new Promise<CommandResponse>(done => { resolve = done; }));
    const pending = h.result.current.createSession("", { shellType: "shell", bridgeId: "a" });
    return { ...h, pending, resolve: (session: Session) => resolve({ requestId: "create", success: true, data: { session } }) };
  }

  it("keeps a reply-before-publication row through an older list and merges a duplicate publication once", async () => {
    const h = setup(true); const oldList = h.request();
    const created = row("created", "a", { status: "running" });
    vi.mocked(h.rpc.sendCommand).mockResolvedValue({ requestId: "create", success: true, data: { session: created } });
    await act(async () => { await h.result.current.createSession("", { shellType: "shell" }); });
    h.reply(oldList, [], "a");
    expect(h.ids()).toEqual(["created"]);
    h.publication(created);
    expect(h.result.current.sessions).toEqual([created]);
  });

  it("preserves a newer publication when the older create response resolves", async () => {
    const h = pendingCreate();
    const older = row("created", "a", { status: "running", name: "Original" });
    const newer = { ...older, status: "completed" as const, name: "Renamed", updatedAt: "2026-10-22" };
    h.publication(newer);
    let returned: unknown;
    await act(async () => { h.resolve(older); returned = await h.pending; });
    expect(returned).toEqual(newer);
    expect(h.result.current.sessions).toEqual([newer]);
  });

  it.each(["confirmed", "optimistic"])("does not resurrect a %s removed row from a late create result", async kind => {
    const h = pendingCreate(); const created = row("created", "a", { status: "running" });
    h.publication(created);
    if (kind === "confirmed") h.publication(created, "removed");
    else act(() => h.result.current.removeSession(created.id));
    await act(async () => { h.resolve(created); await expect(h.pending).rejects.toThrow("no longer available"); });
    expect(h.ids()).toEqual([]);
  });

  it.each(["account switch", "unmount"])("rejects an old-context create response after %s", async boundary => {
    const h = pendingCreate();
    if (boundary === "account switch") h.rerender({ userId: "other-user", selectedUsageView: null }); else h.unmount();
    await act(async () => { h.resolve(row("created")); await expect(h.pending).rejects.toThrow("context changed"); });
    expect(h.ids()).toEqual([]);
  });

  it.each([undefined, null, {}, { session: { id: "partial" } }, { session: row("wrong-owner", "b") }])("rejects malformed or wrong-owner success data %# without changing rows", async data => {
    const h = setup(); h.publication(row("existing"));
    vi.mocked(h.rpc.sendCommand).mockResolvedValue({ requestId: "create", success: true, data });
    await act(async () => { await expect(h.result.current.createSession("", { bridgeId: "a" })).rejects.toThrow("invalid created session"); });
    expect(h.ids()).toEqual(["existing"]);
  });

  it("preserves bridge error details and rows on unsuccessful creation", async () => {
    const h = setup(); h.publication(row("existing"));
    vi.mocked(h.rpc.sendCommand).mockResolvedValue({ requestId: "create", success: false, error: "Missing directory", data: { code: "working_dir_missing", workingDir: "/missing", canCreate: true } });
    await act(async () => { await expect(h.result.current.createSession("", {})).rejects.toMatchObject({ message: "Missing directory", code: "working_dir_missing", workingDir: "/missing", canCreate: true }); });
    expect(h.ids()).toEqual(["existing"]);
  });
});


describe("session preview metadata", () => {
  it("accepts a valid descriptor, clears it on omission and fails closed on invalid registration", () => {
    const h = setup();
    const preview = { id: "12345678-1234-4234-8234-123456789abc", files: [{ id: "22345678-2234-4234-8234-123456789abc", fileName: "view.html", kind: "html" as const }] };
    h.publication(row("one", "a", { preview }));
    expect(h.result.current.sessions[0].preview).toEqual(preview);
    h.publication(row("one"));
    expect(h.result.current.sessions[0].preview).toBeUndefined();
    h.publication(row("one", "a", { preview }));
    h.publication(row("one", "a", { preview: { ...preview, files: [{ id: "22345678-2234-4234-8234-123456789abc", fileName: "../private", kind: "html" as const }] } }));
    expect(h.result.current.sessions[0].preview).toBeUndefined();
  });
});

describe("native session id validation through the actual hook", () => {
  it("accepts snapshot rows carrying string grok and antigravity session ids", () => {
    const h = setup(true);
    h.reply(h.request(), [row("grok", "a", { shellType: "grok", grokSessionId: "grok-native" }),
      row("agy", "a", { shellType: "antigravity", antigravitySessionId: "agy-native" })], "a");
    expect(h.ids()).toEqual(["grok", "agy"]);
    expect(h.result.current.sessions.find(s => s.id === "grok")?.grokSessionId).toBe("grok-native");
    expect(h.result.current.sessions.find(s => s.id === "agy")?.antigravitySessionId).toBe("agy-native");
  });

  it.each(["grokSessionId", "antigravitySessionId"])("rejects a snapshot row whose %s is not a string", key => {
    const h = setup(true);
    h.reply(h.request(), [row("valid"), { ...row("invalid"), [key]: 42 }], "a");
    expect(h.ids()).toEqual(["valid"]);
  });
});
