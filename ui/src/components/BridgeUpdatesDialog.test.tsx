// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BridgeUpdatesDialog } from "./BridgeUpdatesDialog";
import type { UpdateView } from "@/hooks/useBridgeUpdates";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => cleanup());
const view: UpdateView = { loading: false, message: null, operation: null, complete: false, status: {
  schema: 1, bridgeId: "a", currentVersion: "1.0.0", latestVersion: "1.1.0", checkedAt: null, availability: "available", canUpdate: true, blockedReason: null, operation: null, manualCommand: "npx ftown@1.1.0 setup",
} };
it("requires explicit confirmation and displays a busy reason without a stop-all action", () => {
  const update = vi.fn(); const { rerender } = render(<BridgeUpdatesDialog open name="Workstation" view={view} onClose={() => {}} onCheck={() => {}} onUpdate={update} />);
  fireEvent.click(screen.getByRole("button", { name: "Update and restart" }));
  expect(screen.getByText(/All sessions must be stopped/)).toBeTruthy(); expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm update and restart" })); expect(update).toHaveBeenCalledOnce();
  rerender(<BridgeUpdatesDialog open name="Workstation" view={{ ...view, status: { ...view.status!, canUpdate: false, blockedReason: "busy" } }} onClose={() => {}} onCheck={() => {}} onUpdate={update} />);
  expect(screen.getByText("Stop running sessions before updating")).toBeTruthy(); expect((screen.getByRole("button", { name: "Update and restart" }) as HTMLButtonElement).disabled).toBe(true);
});
