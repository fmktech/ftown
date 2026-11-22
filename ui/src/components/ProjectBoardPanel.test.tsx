// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
