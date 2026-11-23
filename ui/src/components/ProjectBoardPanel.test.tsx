// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
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
  fireEvent.click(await screen.findByRole("button", { name: "Publish", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Delete ticket", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(send).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Delete ticket", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete ticket" }));
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  expect(within(backlog).queryByText("Publish")).toBeNull();
  expect(within(backlog).getByText("Check release")).toBeTruthy();
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ action: "delete_ticket", ticketId: "a" }) }));
});
