// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Centrifuge } from "centrifuge";
import type { Command, CommandResponse, Session } from "@/types";
import type { BridgeRpc } from "./useBridgeRpc";
import { useSessions, mergeSessionSnapshot } from "./useSessions";
import { SessionList } from "@/components/SessionList";

const row = (id: string, bridgeId = "a", extra: Partial<Session> = {}): Session => ({
  id, bridgeId, name: id, status: "completed", createdAt: "2026-09-30", updatedAt: "2026-09-30", ...extra,

});
function harness(immediate = false) {
  const responses = new Set<(r: CommandResponse) => void>();
  const subscribed = new Set<() => void>();
  const subscriptions: Array<ReturnType<typeof subscription>> = [];
  function subscription() {
    const listeners = new Map<string, Array<(data?: any) => void>>();
    return {
      on: vi.fn((event: string, cb: (data?: any) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), cb]); }),
      emit: (event: string, data?: any) => listeners.get(event)?.forEach(cb => cb(data)),
      listeners,
      subscribe: vi.fn(), unsubscribe: vi.fn(), removeAllListeners: vi.fn(() => listeners.clear()),
    };
  }
  const client = { getSubscription: () => null, newSubscription: () => { const s = subscription(); subscriptions.push(s); return s; }, removeSubscription: vi.fn() };
  const commands: Command[] = [];
  const rpc: BridgeRpc = {
    publishCommand: vi.fn(c => { commands.push(c); }),
    sendCommand: vi.fn(async c => ({ requestId: c.requestId, success: true, data: { usages: {} } })),
    sendCommandCollect: vi.fn(), bridgeExec: vi.fn(), lastResponse: null,
    onResponse: cb => { responses.add(cb); return () => { responses.delete(cb); }; },
    onSubscribed: cb => { subscribed.add(cb); if (immediate) cb(); return () => { subscribed.delete(cb); }; },
  };
  const reply = (id: string, sessions: unknown[], bridgeId?: string, success = true) => act(() => {
    responses.forEach(cb => cb({ requestId: id, success, data: { sessions, ...(bridgeId === undefined ? {} : { bridgeId }) } }));
  });
  const recover = () => act(() => subscribed.forEach(cb => cb()));
  const publication = (s: Session, status?: string) => act(() => subscriptions.at(-1)!.emit("publication", { data: { type: "session_update", session: { ...s, ...(status ? { status } : {}) } } }));
  const request = () => commands.filter(c => c.type === "list_sessions").at(-1)!.requestId;
  return { client: client as unknown as Centrifuge, rpc, commands, responses, subscriptions, reply, recover, publication, request };
}
let visibility = "visible";
beforeEach(() => { vi.useFakeTimers(); visibility = "visible"; Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility }); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(immediate = false) {
  const h = harness(immediate);
  const hook = renderHook(({ userId }) => useSessions(h.client, userId, h.rpc), { initialProps: { userId: "user" as string | null } });
  const refresh = () => act(() => hook.result.current.refreshSessions());
  const ids = () => hook.result.current.sessions.map(s => s.id);
  return { ...h, ...hook, refresh, ids };
}
describe("retirement reconciliation through actual hook callbacks", () => {
  it("heals missed self/parent removal on reconnect with empty owner and isolates offline owners", () => {
    const h = setup(true); h.reply(h.request(), [row("self"), row("parent-child")], "a");
    h.reply(h.request(), [row("offline", "b")], "b");
    h.recover(); h.reply(h.request(), [], "a"); expect(h.ids()).toEqual(["offline"]);
  });
  it("heals missed removal through visible periodic refresh", () => {
    const h = setup(true); h.reply(h.request(), [row("retired")], "a");
    act(() => vi.advanceTimersByTime(15_000)); h.reply(h.request(), [], "a"); expect(h.ids()).toEqual([]);
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
    h.rerender({ userId: "other-user" }); expect(h.ids()).toEqual([]);
    act(() => { oldResponse({ requestId: "old", success: true, data: { sessions: [row("leak")] } }); oldPub({ data: { type: "session_update", session: row("leak") } }); });
    h.publication(row("gone")); expect(h.ids()).toEqual(["gone"]);
    h.rerender({ userId: null }); expect(h.ids()).toEqual([]);
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
  it("recovers independently on session subscription, coalesces simultaneous triggers, and avoids hidden churn", () => {
    const h = setup(true); const count = () => h.commands.filter(c => c.type === "list_sessions").length;
    const initial = count(); act(() => h.subscriptions[0].emit("subscribed")); expect(count()).toBe(initial);
    act(() => vi.advanceTimersByTime(1)); act(() => h.subscriptions[0].emit("subscribed")); expect(count()).toBe(initial + 1);
    visibility = "hidden"; act(() => vi.advanceTimersByTime(30_000)); expect(count()).toBe(initial + 1);
    visibility = "visible"; act(() => document.dispatchEvent(new Event("visibilitychange"))); expect(count()).toBe(initial + 2);
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
    h.recover(); expect(h.ids()).toEqual([]);
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
    const h = setup(true); h.reply(h.request(), [row("running", "a", { status: "running", codexSessionId: "scratch-codex" })], "a"); h.refresh(); const inflight = h.request();
    const usage = { inputTokens: 9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 9, models: [], harness: "codex", collectedAt: "2026-09-30T12:00:00Z" };
    vi.mocked(h.rpc.sendCommand).mockImplementation(async c => ({ requestId: c.requestId, success: true, data: { usages: { running: usage } } }));
    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
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

it("reconciles correlated local transport snapshots using its bridge scope", () => {
  const h = harness(true);
  Object.assign(h.client, { sessionSnapshotBridgeId: "a" });
  const hook = renderHook(() => useSessions(h.client, "user", h.rpc));
  h.reply(h.request(), [row("local")]);
  act(() => hook.result.current.refreshSessions());
  h.reply(h.request(), []);
  expect(hook.result.current.sessions).toEqual([]);
});
