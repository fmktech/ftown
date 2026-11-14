// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, CommandResponse, Session, SessionCard } from "@/types";
import type { SnapshotCard } from "@/components/SessionOverview";
import { BOARD_POLL_MS, parseSnapshot, treeUpdateKey, useSessionBoard, type SessionBoardSnapshot } from "./useSessionBoard";

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

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id, bridgeId: "bridge", name: id, status: "running", createdAt: "2026-11-13T09:00:00.000Z", updatedAt: "2026-11-13T09:00:00.000Z",
  ...overrides,
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

describe("treeUpdateKey", () => {
  it("changes when a tree session updates", () => {
    const base = treeUpdateKey([session("child-1"), session("child-2")]);
    expect(treeUpdateKey([session("child-1"), session("child-2")])).toBe(base);
    expect(treeUpdateKey([session("child-1", { updatedAt: "2026-11-13T09:05:00.000Z" }), session("child-2")])).not.toBe(base);
    expect(treeUpdateKey([session("child-1"), session("child-2", { status: "completed" })])).not.toBe(base);
    expect(treeUpdateKey([session("child-1"), session("child-2", { card: { state: "done", headline: "x", updatedAt: "2026-11-13T09:06:00.000Z" } })])).not.toBe(base);
    expect(treeUpdateKey([session("child-1")])).not.toBe(base);
  });
});

describe("useSessionBoard", () => {
  it("fetches on mount while enabled and stores the parsed snapshot", async () => {
    const send = vi.fn(async (_command: Command) => reply(snapshotValue()));
    const { result } = renderHook(() => useSessionBoard(send, "bridge", "manager", true));
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].type).toBe("get_session_board");
    expect(send.mock.calls[0][0].payload).toEqual({ bridgeId: "bridge", sessionId: "manager" });
    expect(result.current.snapshot?.board.rootId).toBe("manager");
    expect(result.current.snapshot?.attention[0].sessionId).toBe("child-1");
  });

  it("never fetches while disabled", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_command: Command) => reply(snapshotValue()));
    const { result, rerender } = renderHook(({ enabled }) => useSessionBoard(send, "bridge", "manager", enabled), { initialProps: { enabled: false } });
    await act(async () => {});
    expect(send).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
    rerender({ enabled: true });
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(BOARD_POLL_MS * 3); });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("polls every 15 s while enabled and the document is visible", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_command: Command) => reply(snapshotValue()));
    renderHook(() => useSessionBoard(send, "bridge", "manager", true));
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(BOARD_POLL_MS - 1); });
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(send).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(BOARD_POLL_MS * 2); });
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("keeps the 15 s poll running while tree updates arrive between polls", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_command: Command) => reply(snapshotValue()));
    const { rerender } = renderHook(({ tree }) => useSessionBoard(send, "bridge", "manager", true, tree), { initialProps: { tree: [session("child-1")] } });
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
    // Updates at t=5s and t=10s.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    rerender({ tree: [session("child-1", { updatedAt: "2026-11-13T09:05:00.000Z" })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    rerender({ tree: [session("child-1", { updatedAt: "2026-11-13T09:10:00.000Z" })] });
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(3);
    // No update at t=15s, yet the untouched interval still fires there.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(send).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("refetches when a session in the tree updates", async () => {
    const send = vi.fn(async () => reply(snapshotValue()));
    const initial = [session("child-1"), session("child-2")];
    const { rerender } = renderHook(({ tree }) => useSessionBoard(send, "bridge", "manager", true, tree), { initialProps: { tree: initial } });
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
    // Same content, new array: no refetch.
    rerender({ tree: [...initial] });
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
    rerender({ tree: [session("child-1", { updatedAt: "2026-11-13T09:09:00.000Z" }), session("child-2")] });
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("drops a stale response after the fetch epoch is superseded", async () => {
    const pending: Array<(response: CommandResponse) => void> = [];
    const send = vi.fn((command: Command): Promise<CommandResponse> => new Promise(resolve => pending.push(resolve)));
    const { rerender, result } = renderHook(({ tree }) => useSessionBoard(send, "bridge", "manager", true, tree), { initialProps: { tree: [session("child-1")] } });
    await act(async () => {});
    expect(pending).toHaveLength(1);
    rerender({ tree: [session("child-1", { updatedAt: "2026-11-13T09:10:00.000Z" })] });
    await act(async () => {});
    // The rerender landed while the first fetch was in flight: it queues one follow-up.
    expect(send).toHaveBeenCalledTimes(1);
    const stale = snapshotValue();
    const fresh = { ...snapshotValue(), board: { ...snapshotValue().board, rootId: "fresh" } };
    await act(async () => { pending[0](reply(stale)); });
    // The first request resolved late with its snapshot; it must be ignored…
    expect(result.current.snapshot).toBeNull();
    // …and its completion issues the queued follow-up fetch.
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1](reply(fresh)); });
    expect(result.current.snapshot?.board.rootId).toBe("fresh");
  });

  it("coalesces updates that arrive while a fetch is in flight into one follow-up fetch", async () => {
    const pending: Array<(response: CommandResponse) => void> = [];
    const send = vi.fn((command: Command): Promise<CommandResponse> => new Promise(resolve => pending.push(resolve)));
    const { rerender } = renderHook(({ tree }) => useSessionBoard(send, "bridge", "manager", true, tree), { initialProps: { tree: [session("child-1")] } });
    await act(async () => {});
    rerender({ tree: [session("child-1", { updatedAt: "2026-11-13T09:11:00.000Z" })] });
    rerender({ tree: [session("child-1", { updatedAt: "2026-11-13T09:12:00.000Z" })] });
    await act(async () => {});
    // Two epochs supersede each other while busy; only one follow-up request is queued.
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => { pending[0](reply(snapshotValue())); });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous snapshot when the command fails or the reply is junk", async () => {
    vi.useFakeTimers();
    let next = reply(snapshotValue());
    const send = vi.fn(async (_command: Command) => next);
    const { result } = renderHook(() => useSessionBoard(send, "bridge", "manager", true));
    await act(async () => {});
    expect(result.current.snapshot?.board.rootId).toBe("manager");
    next = { requestId: "r", success: false, error: "unknown_command" };
    await act(async () => { await vi.advanceTimersByTimeAsync(BOARD_POLL_MS + 1); });
    expect(result.current.snapshot?.board.rootId).toBe("manager");
    next = reply({ nope: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(BOARD_POLL_MS + 1); });
    expect(result.current.snapshot?.board.rootId).toBe("manager");
  });

  it("clears the snapshot when the selected session changes", async () => {
    const send = vi.fn(async (_command: Command) => reply(snapshotValue()));
    const { result, rerender } = renderHook(({ id }) => useSessionBoard(send, "bridge", id, true), { initialProps: { id: "manager" } });
    await act(async () => {});
    expect(result.current.snapshot).not.toBeNull();
    rerender({ id: "other" });
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].payload).toEqual({ bridgeId: "bridge", sessionId: "other" });
    expect(result.current.snapshot).not.toBeNull();
  });

  it("does nothing without a session", async () => {
    const send = vi.fn(async (_command: Command) => reply(snapshotValue()));
    renderHook(() => useSessionBoard(send, "bridge", null, true));
    await act(async () => {});
    expect(send).not.toHaveBeenCalled();
  });
});
