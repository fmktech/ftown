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

it("shows the account-wide helper when editing and preserves the mobile action minimum", () => {
  render(<DeviceDisplayNameEditor target={{ kind: "bridge", id: "pc" }} label="Desk" customName="Desk" saving={false} error={null} setName={vi.fn()} />);
  const helper = screen.getByText("Display names appear across your signed-in browsers.");
  expect(helper.className).toContain("md:hidden");
  for (const name of ["Rename Desk", "Reset name"]) {
    const classes = screen.getByRole("button", { name }).className;
    expect(classes).toContain("min-h-11"); expect(classes).toContain("md:min-h-8");
  }
  fireEvent.click(screen.getByRole("button", { name: "Rename Desk" }));
  expect(helper.className).not.toContain("md:hidden");
});

it("edits inline, preserves a draft on label changes, and restores pencil focus", async () => {
  const save = vi.fn().mockResolvedValue(true);
  const props = { target: { kind: "browser" as const, id: "one" }, label: "Laptop", saving: false, error: null, setName: save, variant: "inline" as const };
  const view = render(<DeviceDisplayNameEditor {...props} />);
  const pencil = screen.getByRole("button", { name: "Rename Laptop" });
  expect(pencil.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  fireEvent.click(pencil); const input = screen.getByLabelText("Display name") as HTMLInputElement; expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "  Office 💻  " } });
  view.rerender(<DeviceDisplayNameEditor {...props} label="Updated remotely" />); expect(input.value).toBe("  Office 💻  ");
  fireEvent.submit(input.closest("form")!); await waitFor(() => expect(save).toHaveBeenCalledWith({ kind: "browser", id: "one", name: "Office 💻" }));
  const updated = await screen.findByRole("button", { name: "Rename Updated remotely" }); expect(document.activeElement).toBe(updated);
  fireEvent.click(updated); fireEvent.keyDown(screen.getByLabelText("Display name"), { key: "Escape" }); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename Updated remotely" }));
});
it("keeps inline reset in edit mode and retains failure and disabled feedback", async () => {
  const save = vi.fn().mockResolvedValue(false);
  const props = { target: { kind: "browser" as const, id: "one" }, label: "Desk", customName: "Desk", saving: false, error: "Save failed", setName: save, variant: "inline" as const };
  const view = render(<DeviceDisplayNameEditor {...props} />);
  expect(screen.queryByText("Save failed")).toBeNull(); expect(screen.queryByRole("button", { name: "Reset name" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Rename Desk" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset name" })); await waitFor(() => expect(save).toHaveBeenCalledWith({ kind: "browser", id: "one", name: null }));
  expect(screen.getByLabelText("Display name")).toBeTruthy(); expect(screen.getByText("Save failed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename Desk" }));
  view.rerender(<DeviceDisplayNameEditor {...props} disabledReason="Reconnect before renaming" />);
  const disabled = screen.getByRole("button", { name: "Rename Desk" }) as HTMLButtonElement;
  expect(disabled.disabled).toBe(true); expect(disabled.title).toBe("Reconnect before renaming");
});

it("explains and disables an inline save if eligibility is lost during editing", () => {
  const save = vi.fn().mockResolvedValue(true);
  const props = { target: { kind: "browser" as const, id: "one" }, label: "Desk", saving: false, error: null, setName: save, variant: "inline" as const };
  const view = render(<DeviceDisplayNameEditor {...props} />); fireEvent.click(screen.getByRole("button", { name: "Rename Desk" }));
  const input = screen.getByLabelText("Display name") as HTMLInputElement; fireEvent.change(input, { target: { value: "Draft" } });
  view.rerender(<DeviceDisplayNameEditor {...props} disabledReason="Reconnect before renaming" />);
  expect(input.disabled).toBe(true); expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  const reason = screen.getByText("Reconnect before renaming"); expect(reason.className).not.toContain("sr-only"); expect(input.getAttribute("aria-describedby")).toBe(reason.id);
  fireEvent.submit(input.closest("form")!); expect(save).not.toHaveBeenCalled();
});
