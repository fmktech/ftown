// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceDisplayNameEditor } from "./DeviceDisplayNameEditor";

afterEach(cleanup);
it("retains failed input, submits trimmed Unicode, and supports Escape", async () => {
  const save = vi.fn().mockResolvedValue(false);
  render(<DeviceDisplayNameEditor target={{ kind: "browser", id: "one" }} label="Browser" saving={false} error="Save failed" setName={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename Browser" }));
  const input = screen.getByLabelText("Display name") as HTMLInputElement;
  expect(document.activeElement).toBe(input); expect(input.maxLength).toBe(80);
  fireEvent.change(input, { target: { value: "  💻 Office  " } }); fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(save).toHaveBeenCalledWith({ kind: "browser", id: "one", name: "💻 Office" }));
  expect(input.value).toBe("  💻 Office  "); expect(screen.getByText("Save failed")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Escape" }); expect(screen.queryByLabelText("Display name")).toBeNull();
});
it("resets an alias and refuses blank or prohibited names", async () => {
  const save = vi.fn().mockResolvedValue(true);
  render(<DeviceDisplayNameEditor target={{ kind: "bridge", id: "pc" }} label="Desk" customName="Desk" saving={false} error={null} setName={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename Desk" }));
  const input = screen.getByLabelText("Display name");
  fireEvent.change(input, { target: { value: "  " } }); expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "name\u202ebad" } }); expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); fireEvent.click(screen.getByRole("button", { name: "Reset name" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ kind: "bridge", id: "pc", name: null }));
  await screen.findByText("Name reset.");
});

it("locks the draft during a pending save and styles success separately from errors", async () => {
  let complete!: (success: boolean) => void;
  const save = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
  render(<DeviceDisplayNameEditor target={{ kind: "browser", id: "one" }} label="Laptop" saving={false} error={null} setName={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename Laptop" }));
  const input = screen.getByLabelText("Display name") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Office" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(input.disabled).toBe(true);
  complete(true);
  const status = await screen.findByText("Display name saved.");
  expect(status.className).toContain("text-[var(--text-muted)]");
  expect(status.className).not.toContain("text-[var(--status-error)]");
});
