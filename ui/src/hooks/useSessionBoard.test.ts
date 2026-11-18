// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, CommandResponse, SessionCard } from "@/types";
import type { MessageClient, MessageEvents, MessageSubscription } from "@/lib/message-client";
import type { SnapshotCard } from "@/components/SessionOverview";
import { parseBoardPublication, parseSnapshot, useSessionBoard, type SessionBoardSnapshot } from "./useSessionBoard";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const card = (sessionId: string, state: SessionCard["state"] = "working", archived = false): SnapshotCard => ({
  ...(archived ? { archived: true } : {}),
  sessionId, name: `child-${sessionId}`,
  declared: { state, headline: "row", updatedAt: "2026-11-13T10:00:00.000Z" },
  derived: { status: "running", activity: "thinking", openAttention: 0, unreadMail: 0, previews: [] },
  stale: false,
});

const snapshotValue = (): SessionBoardSnapshot => ({
  board: {
    rootId: "manager",
    cards: [card("child-1"), card("child-2", "done", true)],
    plan: {
      items: [{ id: "p1", title: "first", after: [], priority: 2, state: "todo", createdAt: "2026-11-13T09:00:00.000Z", updatedAt: "2026-11-13T09:00:00.000Z" }],
      ready: ["p1"],
    },
  },
  events: [{ seq: 1, ts: "2026-11-13T09:30:00.000Z", sessionId: "child-1", sessionName: "child-1", kind: "status", summary: "working: row" }],
  attention: [{ sessionId: "child-1", event: { id: "a1", title: "Need input", message: "hello", route: "human" } }],
});

const reply = (data: unknown): CommandResponse => ({ requestId: "r", success: true, data });

describe("parseSnapshot", () => {
  it("accepts a full board snapshot with plan, events and attention", () => {
    const value = snapshotValue();
    const parsed = parseSnapshot(value);
    expect(parsed).toEqual(value);
  });

  it("rejects junk and partial shapes", () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot({})).toBeNull();
    expect(parseSnapshot({ board: { rootId: "r", cards: "no" }, events: [], attention: [] })).toBeNull();
    const broken = snapshotValue();
    (broken.board.cards[0] as unknown as Record<string, unknown>).derived = undefined;
    expect(parseSnapshot(broken)).toBeNull();
  });

  it("keeps a snapshot without a plan", () => {
    const value = snapshotValue();
    delete (value.board as { plan?: unknown }).plan;
    expect(parseSnapshot(value)?.board.plan).toBeUndefined();
  });

  it("keeps only the Overview's attention fields", () => {
    const value = snapshotValue();
    value.attention[0].event.escalationNote = "routed to you";
    const parsed = parseSnapshot(value);
    expect(parsed?.attention[0].event).toEqual({ id: "a1", title: "Need input", message: "hello", route: "human", escalationNote: "routed to you" });
  });
});


function messageClient() {
  const subscriptions: Array<MessageSubscription & { emit<E extends keyof MessageEvents>(event: E, context: MessageEvents[E]): void }> = [];
  let streamPosition: { offset: number; epoch: string } | null = null;
  const client = {
    newSubscription: vi.fn((_channel: string, _options?: unknown) => {
      const listeners = new Map<string, (context: never) => void>();
      const sub = {
        state: "subscribed", subscribe: vi.fn(() => sub.emit("subscribed", { recovered: false, positioned: true, offset: 0, epoch: "epoch" } as never)), unsubscribe: vi.fn(), publish: vi.fn(), presence: vi.fn(),
        on: (event: string, listener: (context: never) => void) => { listeners.set(event, listener); }, off: vi.fn(),
        removeAllListeners: () => listeners.clear(),
        streamPosition: () => streamPosition,
        emit: (event: string, context: never) => {
          const value = context as { offset?: number; epoch?: string; streamPosition?: { offset: number; epoch: string } };
          const position = value.streamPosition ?? (typeof value.offset === "number" && typeof value.epoch === "string" ? { offset: value.offset, epoch: value.epoch } : null);
          if (position && (!streamPosition || position.epoch !== streamPosition.epoch || position.offset > streamPosition.offset)) streamPosition = position;
          listeners.get(event)?.(context);
        },
      } as unknown as typeof subscriptions[number];
      subscriptions.push(sub); return sub;
    }),
    getSubscription: vi.fn(() => null), removeSubscription: vi.fn(),
  } satisfies MessageClient;
  return { client, subscriptions, get sub() { return subscriptions.at(-1)!; } };
}
const push = (snapshot = snapshotValue(), bridgeId = "bridge", rootId = "manager") => ({ type: "session_board_snapshot", bridgeId, rootId, snapshot });
const visible = async () => { await act(async () => { document.dispatchEvent(new Event("visibilitychange")); }); };

describe("parseBoardPublication", () => {
  it("strictly parses snapshots and markers and rejects root mismatch/extra fields", () => {
    expect(parseBoardPublication(push())).toEqual(push());
    expect(parseBoardPublication({ type: "session_board_changed", bridgeId: "bridge", rootId: "manager" })).not.toBeNull();
    for (const value of [null, {}, { ...push(), rootId: "wrong" }, { ...push(), extra: true }, { ...push(), snapshot: {} },
      { type: "session_board_changed", bridgeId: "bridge", rootId: "manager", snapshot: snapshotValue() }]) expect(parseBoardPublication(value)).toBeNull();
  });
});

describe("useSessionBoard", () => {
  it("reads initially and never polls at idle", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_command: Command) => reply(snapshotValue()));
    const f = messageClient();
    const { result } = renderHook(() => useSessionBoard(send, "bridge", "manager", true, f.client, "user"));
    await act(async () => {});
    expect(result.current.snapshot).toEqual(snapshotValue());
    expect(send.mock.calls[0][0].payload).toEqual({ bridgeId: "bridge", sessionId: "manager" });
    expect(f.client.newSubscription).toHaveBeenCalledWith("session-board:updates#user", { since: { offset: 0, epoch: "" }, recoverable: true, positioned: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("subscribes and reads only while enabled, cleaning up when leaving Overview", async () => {
    const f = messageClient(); const send = vi.fn(async () => reply(snapshotValue()));
    const { rerender, result } = renderHook(({ enabled }) => useSessionBoard(send, "bridge", "manager", enabled, f.client, "user"), { initialProps: { enabled: false } });
    expect(send).not.toHaveBeenCalled(); expect(f.client.newSubscription).not.toHaveBeenCalled();
    rerender({ enabled: true }); await act(async () => {});
    const sub = f.sub; rerender({ enabled: false }); await visible();
    expect(sub.unsubscribe).toHaveBeenCalledOnce(); expect(f.client.removeSubscription).toHaveBeenCalledWith(sub);
    expect(send).toHaveBeenCalledTimes(1); expect(result.current.snapshot).not.toBeNull();
  });
  it("applies snapshots without reads and filters wrong bridge/root or malformed pushes", async () => {
    const f = messageClient(); const send = vi.fn(async () => reply(snapshotValue()));
    const { result } = renderHook(() => useSessionBoard(send, "bridge", "manager", true, f.client, "user"));
    await act(async () => {});
    const fresh = snapshotValue(); fresh.board.cards[0].name = "new name";
    await act(async () => { f.sub.emit("publication", { data: push(fresh) }); });
    expect(result.current.snapshot?.board.cards[0].name).toBe("new name");
    await act(async () => {
      f.sub.emit("publication", { data: push(snapshotValue(), "other") });
      f.sub.emit("publication", { data: push(snapshotValue(), "bridge", "other") });
      f.sub.emit("publication", { data: { ...push(), snapshot: {} } });
    });
    expect(result.current.snapshot?.board.cards[0].name).toBe("new name"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("reads on unrecovered/position-lost subscriptions but avoids reads on recovered reconnect", async () => {
    const f = messageClient(); const send = vi.fn(async () => reply(snapshotValue()));
    const { result } = renderHook(() => useSessionBoard(send, "bridge", "manager", true, f.client, "user"));
    await act(async () => {});
    await act(async () => { f.sub.emit("subscribed", { recovered: false, positioned: true, offset: 1, epoch: "e" }); });
    expect(send).toHaveBeenCalledTimes(2);
    const fresh = snapshotValue(); fresh.events[0].summary = "recovered event";
    await act(async () => {
      f.sub.emit("subscribed", { recovered: true, positioned: true, offset: 2, epoch: "e" });
      f.sub.emit("publication", { data: push(fresh), offset: 2 });
    });
    expect(result.current.snapshot?.events[0].summary).toBe("recovered event"); expect(send).toHaveBeenCalledTimes(2);
    for (const context of [undefined as unknown as MessageEvents["subscribed"], { recovered: true }, { recovered: true, offset: 3, epoch: "new" }, { recovered: false, offset: 4, epoch: "new" }]) {
      await act(async () => { f.sub.emit("subscribed", context); });
    }
    expect(send).toHaveBeenCalledTimes(6);
  });
  it("persists offset and epoch for the next subscription", async () => {
    const f = messageClient(); const send = vi.fn(async () => reply(snapshotValue()));
    const { rerender } = renderHook(({ enabled }) => useSessionBoard(send, "bridge", "manager", enabled, f.client, "user"), { initialProps: { enabled: true } });
    await act(async () => { f.sub.emit("subscribed", { offset: 3, epoch: "epoch" }); });
    await act(async () => { f.sub.emit("publication", { data: push(), offset: 4 }); });
    rerender({ enabled: false }); rerender({ enabled: true }); await act(async () => {});
    expect(f.client.newSubscription).toHaveBeenLastCalledWith("session-board:updates#user", { since: { offset: 4, epoch: "epoch" }, recoverable: true, positioned: true });
  });
  it("reads on visibility return and matching oversized markers only", async () => {
    const f = messageClient(); const send = vi.fn(async () => reply(snapshotValue()));
    renderHook(() => useSessionBoard(send, "bridge", "manager", true, f.client, "user")); await act(async () => {});
    await visible(); expect(send).toHaveBeenCalledTimes(2);
    await act(async () => { f.sub.emit("publication", { data: { type: "session_board_changed", bridgeId: "bridge", rootId: "other" } }); });
    expect(send).toHaveBeenCalledTimes(2);
    await act(async () => { f.sub.emit("publication", { data: { type: "session_board_changed", bridgeId: "bridge", rootId: "manager" } }); });
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("keeps initial and visibility reads working when an old relay rejects the new channel", async () => {
    const f = messageClient(); f.client.newSubscription.mockImplementation(() => { throw new Error("unknown channel namespace"); });
    const send = vi.fn(async () => reply(snapshotValue()));
    const { result } = renderHook(() => useSessionBoard(send, "bridge", "manager", true, f.client, "user")); await act(async () => {});
    expect(result.current.snapshot).not.toBeNull(); await visible(); expect(send).toHaveBeenCalledTimes(2);
  });
  it("never overwrites a newer push with an older in-flight RPC response", async () => {
    const f = messageClient(); let resolve!: (value: CommandResponse) => void;
    const send = vi.fn(() => new Promise<CommandResponse>(r => { resolve = r; }));
    const { result } = renderHook(() => useSessionBoard(send, "bridge", "manager", true, f.client, "user"));
    const fresh = snapshotValue(); fresh.board.cards[0].name = "pushed";
    await act(async () => { f.sub.emit("publication", { data: push(fresh) }); resolve(reply(snapshotValue())); });
    expect(result.current.snapshot?.board.cards[0].name).toBe("pushed");
  });
  it("ignores a delayed recovered snapshot at or behind the authoritative stream position", async () => {
    const f = messageClient(); const send = vi.fn(async () => reply(snapshotValue()));
    const { result } = renderHook(() => useSessionBoard(send, "bridge", "manager", true, f.client, "user"));
    await act(async () => {});
    await act(async () => { f.sub.emit("subscribed", { recovered: true, positioned: true, offset: 10, epoch: "epoch" }); });
    await visible();
    const stale = snapshotValue(); stale.board.cards[0].name = "stale replay";
    await act(async () => { f.sub.emit("publication", { data: push(stale), offset: 9 }); });
    expect(result.current.snapshot?.board.cards[0].name).not.toBe("stale replay");
    const fresh = snapshotValue(); fresh.board.cards[0].name = "newer live push";
    await act(async () => { f.sub.emit("publication", { data: push(fresh), offset: 11 }); });
    expect(result.current.snapshot?.board.cards[0].name).toBe("newer live push");
  });
  it("coalesces marker requests during an in-flight read and ignores the superseded response", async () => {
    const f = messageClient(); const pending: Array<(value: CommandResponse) => void> = [];
    const send = vi.fn(() => new Promise<CommandResponse>(resolve => pending.push(resolve)));
    const { result } = renderHook(() => useSessionBoard(send, "bridge", "manager", true, f.client, "user"));
    await act(async () => {
      for (let n = 0; n < 2; n++) f.sub.emit("publication", { data: { type: "session_board_changed", bridgeId: "bridge", rootId: "manager" } });
      pending[0](reply(snapshotValue()));
    });
    expect(result.current.snapshot).toBeNull(); expect(send).toHaveBeenCalledTimes(2);
    await act(async () => { pending[1](reply(snapshotValue())); }); expect(result.current.snapshot).not.toBeNull();
  });
  it("clears the previous root and rejects delayed replies after target changes or unmount", async () => {
    const pending: Array<(value: CommandResponse) => void> = [];
    const send = vi.fn(() => new Promise<CommandResponse>(resolve => pending.push(resolve)));
    const { result, rerender, unmount } = renderHook(({ id }) => useSessionBoard(send, "bridge", id, true), { initialProps: { id: "manager" } });
    rerender({ id: "other" });
    await act(async () => { pending[0](reply(snapshotValue())); }); expect(result.current.snapshot).toBeNull();
    const other = snapshotValue(); other.board.rootId = "other";
    await act(async () => { pending[1](reply(other)); }); expect(result.current.snapshot?.board.rootId).toBe("other");
    unmount();
  });
  it("preserves the last snapshot on command error or malformed response", async () => {
    let next = reply(snapshotValue()); const send = vi.fn(async () => next);
    const { result } = renderHook(() => useSessionBoard(send, "bridge", "manager", true)); await act(async () => {});
    next = { requestId: "r", success: false }; await visible(); expect(result.current.snapshot).not.toBeNull();
    next = reply({ nope: true }); await visible(); expect(result.current.snapshot).not.toBeNull();
  });
  it("does nothing without a target session", async () => {
    const send = vi.fn(async () => reply(snapshotValue()));
    renderHook(() => useSessionBoard(send, "bridge", null, true)); await act(async () => {}); expect(send).not.toHaveBeenCalled();
  });
});
