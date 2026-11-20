// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BridgesDialog } from "./BridgesDialog";

afterEach(cleanup);
it("opens updates for the chosen computer and shows its load", () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const updates = vi.fn();
  render(<BridgesDialog computers={[{ id: "bridge-a", label: "Workstation", ready: true, online: true }]}
    resources={new Map([["bridge-a", { sampledAt: 1, cpuPercent: 42, freeRamBytes: 1, totalRamBytes: 2, freeDiskBytes: 3 }]])}
    selected={null} onSelect={vi.fn()} create={vi.fn()} updates={updates} security={vi.fn()} routing={vi.fn()} close={vi.fn()} />);
  expect(screen.getByText(/CPU 42%/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Updates…" }));
  expect(updates).toHaveBeenCalledWith("bridge-a");
});
