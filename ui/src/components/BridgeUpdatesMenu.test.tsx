// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { bridgeLetter } from "./BridgeBadge";
import { BridgesDialog } from "./BridgesDialog";

afterEach(cleanup);
it("opens updates for the chosen computer and shows its load", () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const updates = vi.fn();
  const GiB = 2 ** 30;
  render(<BridgesDialog computers={[{ id: "bridge-a", label: "Workstation", number: 2, ready: true, online: true },
    { id: "bridge-b", label: "Laptop", ready: false, online: false, update: { status: null, lastKnownVersion: "1.2.3" } }]}
    resources={new Map([["bridge-a", { sampledAt: 1, cpuPercent: 42, freeRamBytes: 2 * GiB, totalRamBytes: 16 * GiB, freeDiskBytes: 3 * GiB, memoryPressure: "normal" }]])}
    instructions={vi.fn()} create={vi.fn()} updates={updates} security={vi.fn()} routing={vi.fn()} close={vi.fn()} />);
  expect(screen.getByText("B")).toBeTruthy();
  expect(screen.getByRole("toolbar", { name: "Actions for Workstation" }).querySelectorAll("button")).toHaveLength(5);
  expect(screen.getByText("42%")).toBeTruthy();
  expect(screen.getByText("2 GiB")).toBeTruthy();
  expect(screen.getByText("of 16 GiB total")).toBeTruthy();
  expect(screen.getByText("Memory pressure").nextElementSibling?.textContent).toBe("normal");
  expect(screen.getByText("Unknown")).toBeTruthy();
  expect(screen.getByText("1.2.3").parentElement?.textContent).toContain("last reported");
  fireEvent.click(within(screen.getByRole("region", { name: "Workstation" })).getByRole("button", { name: "Updates…" }));
  expect(updates).toHaveBeenCalledWith("bridge-a");
});

it("continues bridge letters after Z without changing earlier assignments", () => {
  expect([1, 4, 26, 27, 52, 53].map(bridgeLetter)).toEqual(["A", "D", "Z", "AA", "AZ", "BA"]);
});
