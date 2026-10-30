// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BridgeUpdatesDialog } from "./BridgeUpdatesDialog";
import type { UpdateView } from "@/hooks/useBridgeUpdates";

const view: UpdateView = { loading: false, message: null, operation: null, complete: false, status: {
  schema: 1, bridgeId: "a", currentVersion: "1.0.0", latestVersion: "1.1.0", checkedAt: null, availability: "available", canUpdate: true, blockedReason: null, operation: null, manualCommand: "npx ftown@1.1.0 setup",
} };
const props = { open: true, name: "Workstation", view, onClose: vi.fn(), onCheck: vi.fn(), onUpdate: vi.fn() };
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("shows loading and availability honestly, including initial and failed checks", () => {
  const { rerender } = render(<BridgeUpdatesDialog {...props} view={{ ...view, loading: true }} />);
  expect(screen.getByText("Checking for updates")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Update and restart" })).toBeNull();
  rerender(<BridgeUpdatesDialog {...props} view={view} />);
  expect(screen.getByText("Update available")).toBeTruthy();
  expect(screen.getByText("1.0.0")).toBeTruthy(); expect(screen.getByText("1.1.0")).toBeTruthy();
  rerender(<BridgeUpdatesDialog {...props} view={{ ...view, status: { ...view.status!, availability: "current", canUpdate: false } }} />);
  expect(screen.getByText("Up to date")).toBeTruthy();
  rerender(<BridgeUpdatesDialog {...props} view={{ ...view, status: { ...view.status!, availability: "unknown", canUpdate: false } }} />);
  expect(screen.getByText("Update status unavailable")).toBeTruthy();
  rerender(<BridgeUpdatesDialog {...props} view={{ ...view, status: null }} />);
  expect(screen.getByText("Not checked yet")).toBeTruthy();
  rerender(<BridgeUpdatesDialog {...props} view={{ ...view, status: null, message: "Update information unavailable." }} />);
  expect(screen.getByText("Couldn’t check for updates")).toBeTruthy();
  expect(screen.getByText("Update information unavailable.")).toBeTruthy();
});

it.each([
  ["busy", /Stop running sessions/], ["permission_denied", /does not have control permission/],
  ["not_enabled", /Updates are disabled/], ["unsupported_launch", /Automatic updates aren’t available/],
  ["in_progress", /Another update is already in progress/], ["release_unavailable", /latest release could not be checked/],
  ["node_incompatible", /Upgrade Node on this computer/],
] as const)("shows %s guidance without an update action", (blockedReason, guidance) => {
  render(<BridgeUpdatesDialog {...props} view={{ ...view, status: { ...view.status!, canUpdate: false, blockedReason } }} />);
  expect(screen.getByText(guidance)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Update and restart" })).toBeNull();
});

it("displays independently optional Node details in the compatibility notice or disclosure", () => {
  const { rerender } = render(<BridgeUpdatesDialog {...props} view={{ ...view, status: { ...view.status!, canUpdate: false, blockedReason: "node_incompatible", currentNodeVersion: "24.12.0", requiredNodeEngine: "^24.22.1" } }} />);
  expect(screen.getByText("24.12.0")).toBeTruthy(); expect(screen.getByText("^24.22.1")).toBeTruthy();
  rerender(<BridgeUpdatesDialog {...props} view={{ ...view, status: { ...view.status!, currentNodeVersion: undefined, requiredNodeEngine: ">=24" } }} />);
  expect(screen.queryByText("24.12.0")).toBeNull();
  const details = screen.getByText("Setup & runtime details").closest("details")!;
  expect(details.open).toBe(false); expect(within(details).getByText(">=24")).toBeTruthy();
});

it("shows operation state instead of a misleading current status", () => {
  const operation = { id: "op", targetVersion: "1.1.0", phase: "failed" as const, startedAt: "2026-01-01", updatedAt: "2026-01-01", error: null };
  const { rerender } = render(<BridgeUpdatesDialog {...props} view={{ ...view, status: { ...view.status!, availability: "current", operation } }} />);
  expect(screen.getByText("Update failed")).toBeTruthy(); expect(screen.queryByText("Up to date")).toBeNull();
  rerender(<BridgeUpdatesDialog {...props} view={{ ...view, complete: true, status: { ...view.status!, operation: { ...operation, phase: "succeeded" } } }} />);
  expect(screen.getByText("Update completed")).toBeTruthy();
  rerender(<BridgeUpdatesDialog {...props} view={{ ...view, status: { ...view.status!, operation: { ...operation, phase: "succeeded" } } }} />);
  expect(screen.getByText("Previous operation recorded")).toBeTruthy();
});

it("does not show a previous operation while a different update is pending", () => {
  const previous = { id: "old", targetVersion: "1.0.1", phase: "failed" as const, startedAt: "2026-01-01", updatedAt: "2026-01-01", error: null };
  const pending = { ...view, operation: { id: "new", target: "1.1.0" }, status: { ...view.status!, operation: previous } };
  const { rerender } = render(<BridgeUpdatesDialog {...props} view={pending} />);
  expect(screen.getByText("Update in progress")).toBeTruthy(); expect(screen.queryByText("Update failed")).toBeNull();
  rerender(<BridgeUpdatesDialog {...props} view={{ ...pending, status: { ...pending.status, operation: { ...previous, phase: "succeeded" } } }} />);
  expect(screen.getByText("Update in progress")).toBeTruthy(); expect(screen.queryByText("Previous operation recorded")).toBeNull();
  rerender(<BridgeUpdatesDialog {...props} view={{ ...pending, status: { ...pending.status, operation: { ...previous, id: "new", targetVersion: "1.1.0", phase: "restarting" } } }} />);
  expect(screen.getByText("Update restarting")).toBeTruthy();
});

it("requires confirmation, cancels, and guards a change to ineligible before update", () => {
  const update = vi.fn(); const { rerender } = render(<BridgeUpdatesDialog {...props} onUpdate={update} />);
  fireEvent.click(screen.getByRole("button", { name: "Update and restart" }));
  expect(screen.getByText(/All sessions must be stopped/)).toBeTruthy(); expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(screen.queryByRole("group", { name: "Confirm bridge update" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Update and restart" }));
  rerender(<BridgeUpdatesDialog {...props} onUpdate={update} view={{ ...view, status: { ...view.status!, canUpdate: false, blockedReason: "busy" } }} />);
  expect((screen.getByRole("button", { name: "Confirm update and restart" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Confirm update and restart" })); expect(update).not.toHaveBeenCalled();
  rerender(<BridgeUpdatesDialog {...props} onUpdate={update} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm update and restart" })); expect(update).toHaveBeenCalledOnce();
});

it("validates and copies the manual command with failure feedback", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const { rerender } = render(<BridgeUpdatesDialog {...props} view={{ ...view, status: { ...view.status!, manualCommand: "npx ftown@latest setup; echo unsafe" } }} />);
  fireEvent.click(screen.getByText("Setup & runtime details"));
  expect(screen.getByText("npx ftown@latest setup")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
  await waitFor(() => expect(screen.getByText("Copy unavailable; select the command above.")).toBeTruthy());
  expect(writeText).toHaveBeenCalledWith("npx ftown@latest setup");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
  expect(screen.getByText("Copy unavailable; select the command above.")).toBeTruthy();
  rerender(<BridgeUpdatesDialog {...props} open={false} />);
  rerender(<BridgeUpdatesDialog {...props} />);
  expect(screen.getByText("Setup & runtime details").closest("details")!.open).toBe(false);
  expect(screen.queryByText("Copy unavailable; select the command above.")).toBeNull();
});

it("resets confirmation on reopen and forwards close and check", () => {
  const close = vi.fn(), check = vi.fn(); const { rerender } = render(<BridgeUpdatesDialog {...props} onClose={close} onCheck={check} />);
  fireEvent.click(screen.getByRole("button", { name: "Check again" })); expect(check).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Update and restart" }));
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true })); expect(close).toHaveBeenCalledOnce();
  rerender(<BridgeUpdatesDialog {...props} open={false} onClose={close} />);
  rerender(<BridgeUpdatesDialog {...props} onClose={close} />);
  expect(screen.queryByRole("group", { name: "Confirm bridge update" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close bridge updates" })); expect(close).toHaveBeenCalledTimes(2);
});
