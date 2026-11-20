// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import { SessionAccountBadge, SessionList } from "./SessionList";

afterEach(cleanup);

it("only labels non-default accounts", () => {
  const { rerender } = render(<SessionAccountBadge />);
  expect(screen.queryByLabelText(/Account:/)).toBeNull();
  rerender(<SessionAccountBadge account="default" />);
  expect(screen.queryByLabelText(/Account:/)).toBeNull();
  rerender(<SessionAccountBadge account="work" />);
  expect(screen.getByLabelText("Account: work").textContent).toBe("work");
});

it("renders the account badge on the owning session row only", () => {
  const sessions: Session[] = ["default", "work"].map((account, index) => ({ id: `s${index}`, name: `Session ${index}`, account,
    bridgeId: "a", shellType: "claude", status: "running", createdAt: "2026-11-16", updatedAt: "2026-11-16" }));
  render(<SessionList sessions={sessions}
    selectedSessionId={null} onSelectSession={() => {}} />);
  const workRow = screen.getByText("Session 1", { exact: true }).closest('[role="button"]') ?? screen.getByText("Session 1", { exact: true }).closest("button");
  expect(workRow).toBeTruthy();
  expect(within(workRow as HTMLElement).getByLabelText("Account: work")).toBeTruthy();
  expect(screen.queryByLabelText("Account: default")).toBeNull();
});


it("offers dismissal for the displayed incident", () => {
  const onDismissBlock = vi.fn().mockResolvedValue(undefined);
  const session: Session = { id: "s1", name: "Blocked", bridgeId: "a", shellType: "claude", status: "running", createdAt: "2026-11-16", updatedAt: "2026-11-16", block: { reason: "auth", screenTail: "", detectedAt: "2026-11-16", transitionKey: "auth||running" } };
  render(<SessionList sessions={[session]} selectedSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onRemoveSession={() => {}} onDismissBlock={onDismissBlock} />);
  fireEvent.contextMenu(screen.getByText("Blocked", { exact: true }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Dismiss badge" }));
  expect(onDismissBlock).toHaveBeenCalledWith(session);
});

it("keeps a just-opened context menu through the scroll that was already under way, then closes on a later scroll", async () => {
  // Frames are driven by the test: the scroll listener is armed on the first frame after the menu opens.
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  try {
    const session: Session = { id: "s1", name: "Scrolled", bridgeId: "a", shellType: "claude", status: "running", createdAt: "2026-11-16", updatedAt: "2026-11-16" };
    const { container } = render(<SessionList sessions={[session]}
      selectedSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onRemoveSession={() => {}} />);
    fireEvent.contextMenu(screen.getByText("Scrolled", { exact: true }));
    expect(screen.getByRole("menu", { name: "Session actions" })).toBeTruthy();
    // The list reports a scroll that began before the menu opened (same frame): the menu stays.
    fireEvent.scroll(container.firstElementChild ?? container);
    expect(screen.getByRole("menu", { name: "Session actions" })).toBeTruthy();
    // From the next frame on, scrolling away dismisses it.
    for (const frame of frames.splice(0)) frame(0);
    fireEvent.scroll(container.firstElementChild ?? container);
    expect(screen.queryByRole("menu", { name: "Session actions" })).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

it("remembers a collapsed project while keeping its header available", () => {
  localStorage.clear();
  const props = { sessions: [{ id: "s1", name: "Worker", projectName: "Build", bridgeId: "bridge", shellType: "shell", status: "running", createdAt: "", updatedAt: "" } as Session],
    selectedSessionId: null, onSelectSession: vi.fn() };
  const view = render(<SessionList {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Build", expanded: true }));
  expect(screen.queryByText("Worker")).toBeNull();
  view.unmount();
  render(<SessionList {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Build", expanded: false }));
  expect(screen.getByText("Worker")).toBeTruthy();
  localStorage.clear();
});

it("keeps an empty project across reloads and offers placement and session creation", () => {
  localStorage.clear();
  const add = vi.fn();
  const change = vi.fn();
  const props = { sessions: [], selectedSessionId: null, onSelectSession: vi.fn(), onAddSession: add,
    projectComputers: [{ id: "desk", label: "Desk" }, { id: "studio", label: "Studio" }], onProjectBridgesChange: change };
  const first = render(<SessionList {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Create project/ }));
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Launch" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  first.unmount();
  render(<SessionList {...props} />);
  fireEvent.click(screen.getByLabelText("Add session to Launch"));
  expect(add).toHaveBeenCalledWith("Launch");
  fireEvent.click(screen.getByLabelText("More actions for Launch"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Bridge settings" }));
  fireEvent.click(screen.getByLabelText("Studio"));
  expect(change).toHaveBeenCalledWith("Launch", ["desk"]);
  localStorage.clear();
});

it("offers an empty project in session actions when the project allows the owning bridge", () => {
  localStorage.setItem("ftown:projects", JSON.stringify(["Launch", "Restricted", "Occupied"]));
  const session: Session = { id: "root", name: "Unassigned session", bridgeId: "desk", shellType: "shell",
    status: "completed", createdAt: "", updatedAt: "" };
  const onMoveSessionToProject = vi.fn().mockResolvedValue(undefined);
  render(<SessionList sessions={[session, { ...session, id: "occupied", projectName: "Occupied" }]}
    selectedSessionId={null} onSelectSession={vi.fn()} onStopSession={vi.fn()} onRemoveSession={vi.fn()}
    projectBridges={new Map([["Restricted", ["studio"]]])} onMoveSessionToProject={onMoveSessionToProject} />);

  const section = within(screen.getByRole("region", { name: "No project" }));
  fireEvent.keyDown(section.getByLabelText("Session actions"), { key: "Enter" });
  const menu = within(screen.getByRole("menu", { name: "Session actions" }));
  expect(menu.queryByRole("menuitem", { name: "Move to Restricted" })).toBeNull();
  expect(menu.queryByRole("menuitem", { name: "Move to Occupied" })).toBeNull();
  fireEvent.click(menu.getByRole("menuitem", { name: "Move to Launch" }));
  expect(onMoveSessionToProject).toHaveBeenCalledWith(session, "Launch");
  localStorage.clear();
});
