// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { CommandResponse } from "@/types";
import { ProjectBoardPanel } from "./ProjectBoardPanel";

afterEach(() => { cleanup(); localStorage.clear(); });
it("retains an attention-blocked ticket in the offline, read-only board after reopening it", async () => {
  const project = { id: "p", bridgeId: "home", name: "Tooling" };
  const send = vi.fn(async () => ({
    success: true, requestId: "board", data: { project, tickets: [
      { id: "ticket", title: "Ship picker", stage: "Review", sessionIds: ["remote-worker"] },
    ] },
  }));
  const props = { project, send, cacheKey: "account", sessions: [], close: vi.fn() };
  const first = render(<ProjectBoardPanel {...props} online attentionIds={new Set(["remote-worker"])} />);
  const firstColumn = await screen.findByRole("region", { name: "Blocked" });
  expect(within(firstColumn).getByText("Ship picker")).toBeTruthy();
  first.unmount();
  render(<ProjectBoardPanel {...props} online={false} attentionIds={new Set()} />);
  expect(screen.getByRole("status").textContent).toContain("offline");
  const offlineColumn = screen.getByRole("region", { name: "Blocked" });
  expect(within(offlineColumn).getByText("Ship picker")).toBeTruthy();
  const stage = within(offlineColumn).getByRole("combobox", { name: "Stage for Ship picker" }) as HTMLSelectElement;
  expect(stage.value).toBe("Review");
  expect(stage.disabled).toBe(true);
});

it("discards an interrupted snapshot and displays both pages from the new revision", async () => {
  const project = { id: "p", bridgeId: "home", name: "Tooling" };
  const ticket = (id: string) => ({ id, title: id, stage: "Backlog", sessionIds: [] });
  const pages = [
    { success: true, data: { project, tickets: [ticket("Obsolete")], nextCursor: "before" } },
    { success: false, data: { code: "project_board_changed" } },
    { success: true, data: { project, tickets: [ticket("New first")], nextCursor: "after" } },
    { success: true, data: { project, tickets: [ticket("New second")] } },
  ];
  const send = vi.fn(async () => ({ requestId: "read", ...pages.shift()! }));
  render(<ProjectBoardPanel project={project} online attentionIds={new Set()} send={send} cacheKey="account" sessions={[]} close={vi.fn()} />);
  const column = await screen.findByRole("region", { name: "Backlog" });
  expect(within(column).getByText("New first")).toBeTruthy();
  expect(within(column).getByText("New second")).toBeTruthy();
  expect(screen.queryByText("Obsolete")).toBeNull();
});


beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

it("requires a destination before removing an occupied column and renders the saved names and order", async () => {
  const project = { id: "p", bridgeId: "home", name: "Tooling" };
  const original = [{ id: "Review", label: "Review" }, { id: "Done", label: "Done" }];
  const updated = [{ id: "Done", label: "Shipped" }];
  const ticket = { id: "t", title: "Build", sessionIds: [] };
  const send = vi.fn()
    .mockResolvedValueOnce({ success: true, data: { project, boardEnabled: true, columns: original, tickets: [{ ...ticket, stage: "Review" }] } })
    .mockResolvedValueOnce({ success: true, data: { project, boardEnabled: true, columns: updated, tickets: [{ ...ticket, stage: "Done" }] } });
  render(<ProjectBoardPanel project={project} online attentionIds={new Set()} send={send} cacheKey="account" sessions={[]} close={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Board settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Review" }));
  fireEvent.change(screen.getByLabelText("Column 1 name"), { target: { value: "Shipped" } });
  const save = screen.getByRole("button", { name: "Save columns" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: /Move tickets from Review/ }), { target: { value: "Done" } });
  fireEvent.click(save);
  const shipped = await screen.findByRole("region", { name: "Shipped" });
  expect(within(shipped).getByText("Build")).toBeTruthy();
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({
    action: "configure_columns", columns: updated, previousColumns: original, moveTo: { Review: "Done" },
  }) }));
});

it("deletes a board only after confirmation and restores an empty board in the same project", async () => {
  const project = { id: "p", bridgeId: "home", name: "Tooling" };
  const enabled = { project, boardEnabled: true, columns: [{ id: "Backlog", label: "Ideas" }], tickets: [] };
  const send = vi.fn().mockResolvedValueOnce({ success: true, data: enabled })
    .mockResolvedValueOnce({ success: true, data: { ...enabled, boardEnabled: false, columns: [] } })
    .mockResolvedValueOnce({ success: true, data: enabled });
  render(<ProjectBoardPanel project={project} online attentionIds={new Set()} send={send} cacheKey="account" sessions={[]} close={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Board settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete board" }));
  expect(send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete board" }));
  const create = await screen.findByRole("button", { name: "Create board" });
  expect(screen.queryByRole("region", { name: "Ideas" })).toBeNull();
  fireEvent.click(create);
  expect(await screen.findByRole("region", { name: "Ideas" })).toBeTruthy();
  expect(send.mock.calls.map(([cmd]) => cmd.payload.action)).toEqual([undefined, "delete_board", "create_board"]);
});

it("confirms ticket deletion in its detail and keeps its subtask on the board", async () => {
  const project = { id: "p", bridgeId: "home", name: "Tooling" };
  const parent = { id: "a", title: "Publish", stage: "Backlog", sessionIds: [] };
  const child = { ...parent, id: "b", title: "Check release", parentTicketId: parent.id };
  const send = vi.fn().mockResolvedValueOnce({ success: true, data: { project, tickets: [parent, child] } })
    .mockResolvedValueOnce({ success: true, data: { comments: [] } })
    .mockResolvedValueOnce({ success: true, data: { project, tickets: [{ ...child, parentTicketId: null }] } });
  render(<ProjectBoardPanel project={project} online attentionIds={new Set()} send={send} cacheKey="account" sessions={[]} close={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete ticket" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(send).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Delete ticket" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete ticket" }));
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  expect(within(backlog).queryByText("Publish")).toBeNull();
  expect(within(backlog).getByText("Check release")).toBeTruthy();
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ action: "delete_ticket", ticketId: "a" }) }));
});

it("creates a project channel and thread, replies, and opens a linked thread from its ticket", async () => {
  const project = { id: "p", name: "Tooling", bridgeId: "home" };
  const ticket = { id: "t", title: "Review build", stage: "Review", sessionIds: [] };
  const channels = [{ id: "general", name: "general", archived: false }];
  const rows: { id: string; channelId: string; title: string; ticketId: string | null; author: {name: string}; seq: number; createdAt: string }[] = [];
  const posts: { id: string; threadId: string; text: string; seq: number; author: {name: string}; createdAt: string }[] = [];
  const author = { name: "User" }, createdAt = new Date().toISOString();
  const send = vi.fn(async (cmd: import("@/types").Command) => {
    const p = cmd.payload as Record<string, string>;
    let data: unknown = {};
    if (cmd.type === "get_project_board") data = { project, tickets: [ticket] };
    else if (cmd.type === "get_ticket_comments") data = { comments: [] };
    else if (p.action === "channels") data = { channels: [...channels] };
    else if (p.action === "threads") data = { threads: rows.filter(row => p.ticketId ? row.ticketId === p.ticketId : row.channelId === p.channelId) };
    else if (p.action === "thread") data = { thread: rows.find(r => r.id === p.threadId) };
    else if (p.action === "posts") data = { posts: posts.filter(post => post.seq > Number(p.after ?? 0)) };
    else if (p.action === "create_channel") channels.push({ id: p.channelId, name: p.name, archived: false });
    else if (p.action === "create_thread" || p.action === "reply") {
      if (p.action === "create_thread") rows.push({ id: p.threadId, channelId: p.channelId, title: p.title, author, createdAt, seq: 1, ticketId: null });
      posts.push({ id: p.postId, threadId: p.threadId, text: p.text, seq: posts.length + 1, author, createdAt });
    } else if (p.action === "link_ticket") rows[0].ticketId = p.ticketId;
    return { success: true, requestId: cmd.requestId, data };
  });
  render(<ProjectBoardPanel project={project} send={send} online sessions={[]} attentionIds={new Set()} cacheKey="account" close={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
  await screen.findByRole("button", {name: "#general"});
  fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
  const channelDialog = screen.getByRole("dialog", { name: "Create channel" });
  fireEvent.change(within(channelDialog).getByLabelText("Channel name"), { target: { value: "builds" } });
  fireEvent.click(within(channelDialog).getByRole("button", { name: "Create channel" }));
  await screen.findByRole("heading", {name: "#builds"});
  fireEvent.click(await screen.findByRole("button", { name: "New thread" }));
  fireEvent.change(screen.getByLabelText("Thread title"), { target: { value: "ARM build" } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Check this log" } });
  fireEvent.click(screen.getByRole("button", { name: "Post thread" }));
  await screen.findByText("Check this log");
  fireEvent.change(screen.getByLabelText("Your reply"), { target: { value: "Verified" } });
  fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
  await screen.findByText("Verified");
  fireEvent.click(screen.getByRole("button", { name: "Link existing ticket" }));
  fireEvent.change(screen.getByLabelText("Ticket", { selector: "select" }), { target: { value: "t" } });
  fireEvent.click(screen.getByRole("button", { name: "Link ticket" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open ticket · Review build" }));
  fireEvent.click(await screen.findByRole("button", { name: "Linked discussions" }));
  fireEvent.click(await screen.findByRole("button", { name: "ARM build" }));
  await screen.findByText("Verified");
  expect(screen.getByRole("heading", { name: "#builds" })).toBeTruthy();
});

it("appends incoming threads and replies without overlapping reads or polling a hidden discussion", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  try {
    const project = { id: "p", name: "Tooling", bridgeId: "home" };
    const common = { author: { name: "Worker" }, createdAt: new Date().toISOString() };
    const thread = (seq: number) => ({ ...common, id: String(seq), seq, channelId: "general", ticketId: null, title: "Thread " + seq });
    const post = (seq: number) => ({ ...common, id: String(seq), seq, threadId: "2", text: "Reply " + seq });
    let finishPoll!: () => void;
    const send = vi.fn(async (cmd: import("@/types").Command) => {
      const p = cmd.payload as Record<string, unknown>;
      let data: unknown;
      if (cmd.type === "get_project_board") data = { project, tickets: [] };
      if (p.action === "channels") data = { channels: [{ id: "general", name: "general", archived: false }] };
      if (p.action === "threads") data = { threads: typeof p.after === "number" ? [thread(2)] : [thread(1)] };
      if (p.action === "posts" && !p.after) data = { posts: [post(1)], nextAfter: 1 };
      if (p.action === "posts" && p.after === 1) data = { posts: [post(2)] };
      if (p.action === "posts" && p.after === 2) {
        await new Promise<void>(resolve => { finishPoll = resolve; });
        data = { posts: [post(3)] };
      }
      if (p.action === "posts" && p.after === 3) data = { posts: [] };
      return { success: true, requestId: cmd.requestId, data };
    });
    const props = { project, send, sessions: [], attentionIds: new Set<string>(), cacheKey: "account", close: vi.fn() };
    const panel = render(<ProjectBoardPanel {...props} online />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Discussion" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole("button", { name: "Thread 1" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Thread 2" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more" })); });
    const before = send.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(send).toHaveBeenCalledTimes(before + 1);
    await act(async () => { finishPoll(); });
    for (const seq of [1, 2, 3]) expect(screen.getByText("Reply " + seq)).toBeTruthy();
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(send).toHaveBeenCalledTimes(before + 1);
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ action: "posts", after: 3 }) }));
    panel.rerender(<ProjectBoardPanel {...props} online={false} />);
    const offline = send.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(send).toHaveBeenCalledTimes(offline);
    expect(screen.getByText("Reply 1")).toBeTruthy();
    await act(async () => { panel.rerender(<ProjectBoardPanel {...props} online />); });
    expect(send.mock.calls.slice(offline).map(([cmd]) => cmd.payload)).toContainEqual(expect.objectContaining({ action: "posts", after: 3 }));
    panel.unmount();
    const stopped = send.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(send).toHaveBeenCalledTimes(stopped);
  } finally {
    hidden.mockRestore();
    vi.useRealTimers();
  }
});

it("keeps the saved tickets visible and directs a database version error to the home bridge update dialog", async () => {
  const project = { id: "p", bridgeId: "home", name: "Tooling" };
  const board = { project, tickets: [{ id: "t", title: "Ship release", stage: "Review", sessionIds: [] }] };
  const openUpdates = vi.fn();
  const props = { project, sessions: [], cacheKey: "account", attentionIds: new Set<string>(), close: vi.fn(),
    bridgeNames: new Map([["home", "Build Mac"]]), onOpenUpdates: openUpdates };
  const first = render(<ProjectBoardPanel {...props} online send={vi.fn().mockResolvedValue({ success: true, data: board })} />);
  await screen.findByText("Ship release");
  first.unmount();

  let reply!: (response: CommandResponse) => void;
  const send = vi.fn(() => new Promise<CommandResponse>(resolve => { reply = resolve; }));
  render(<ProjectBoardPanel {...props} online send={send} />);
  expect(screen.getByText("Ship release")).toBeTruthy();
  expect(screen.queryByText("Loading board…")).toBeNull();
  await act(async () => reply({ requestId: "refresh", success: false, error: "Unsupported project database version" }));
  expect(screen.getByRole("alert").textContent).toContain("Build Mac");
  fireEvent.click(screen.getByRole("button", { name: "Bridge updates" }));
  expect(openUpdates).toHaveBeenCalledOnce();
  fireEvent(document, new Event("visibilitychange"));
  expect(screen.getByRole("alert")).toBeTruthy();
  await act(async () => reply({ requestId: "refresh", success: true, data: board }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Ship release")).toBeTruthy();
});
