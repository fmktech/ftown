// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalCopySheet } from "./TerminalCopySheet";

const TEXT = "hello mobile copy\nsecond line";

function sheet(props: { open?: boolean; text?: string; onClose?: () => void } = {}) {
  return createElement(TerminalCopySheet, { open: props.open ?? true, text: props.text ?? TEXT, onClose: props.onClose ?? (() => {}) });
}

function select(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  Object.defineProperty(document, "execCommand", { value: undefined, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

describe("TerminalCopySheet", () => {
  it("renders nothing when closed", () => {
    render(sheet({ open: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("shows the dialog and text in a pre portaled to document.body", () => {
    const { container } = render(sheet());
    const dialog = screen.getByRole("dialog", { name: "Copy terminal text" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    const pre = screen.getByTestId("terminal-copy-text");
    expect(pre.tagName).toBe("PRE");
    expect(pre.textContent).toBe(TEXT);
  });

  it("Copy all calls writeText synchronously and reports Copied", async () => {
    render(sheet());
    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    expect(writeText).toHaveBeenCalledWith(TEXT);
    expect(await screen.findByText("Copied")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("shows the failure message when writeText rejects and execCommand is unavailable", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    render(sheet());
    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    expect(await screen.findByText("Copy failed. Long-press the text and choose Copy.")).toBeTruthy();
  });

  it("enables Copy selection for a selection inside the pre and copies exactly that substring", async () => {
    render(sheet());
    const button = screen.getByRole("button", { name: "Copy selection" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const textNode = screen.getByTestId("terminal-copy-text").firstChild!;
    select(textNode, 0, 5);
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("keeps Copy selection disabled for a selection outside the pre", () => {
    const outside = document.createElement("p");
    outside.textContent = "outside text";
    document.body.appendChild(outside);
    render(sheet());
    select(outside.firstChild!, 0, 7);
    expect((screen.getByRole("button", { name: "Copy selection" }) as HTMLButtonElement).disabled).toBe(true);
    outside.remove();
  });

  it("shows an empty message and disables both copy buttons for empty text", () => {
    render(sheet({ text: "" }));
    expect(screen.getByText("Nothing to copy yet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Copy selection" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Copy all" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls onClose from Close and Escape", () => {
    const onClose = vi.fn();
    render(sheet({ onClose }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("clears the status message when reopened", async () => {
    const { rerender } = render(sheet());
    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    await screen.findByText("Copied");
    rerender(sheet({ open: false }));
    rerender(sheet());
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("closes on a backdrop click but not a panel click or a drag from the pre to the backdrop", () => {
    const onClose = vi.fn();
    render(sheet({ onClose }));
    const dialog = screen.getByRole("dialog");
    const overlay = dialog.parentElement!;
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("terminal-copy-text"));
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("scrolls the pre to the bottom on open", () => {
    const spy = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(480);
    render(sheet());
    expect(screen.getByTestId("terminal-copy-text").scrollTop).toBe(480);
    spy.mockRestore();
  });

  it("focuses Close on open and restores focus on close", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { rerender } = render(sheet());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    rerender(sheet({ open: false }));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("wraps Tab and Shift+Tab among the sheet controls", () => {
    render(sheet());
    const close = screen.getByRole("button", { name: "Close" });
    const all = screen.getByRole("button", { name: "Copy all" });
    all.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(all);
  });

  it("removes the selectionchange listener on close", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { rerender } = render(sheet());
    rerender(sheet({ open: false }));
    expect(remove.mock.calls.some(([type]) => type === "selectionchange")).toBe(true);
    remove.mockRestore();
  });

  it("applies native selection styles to the pre", () => {
    render(sheet());
    const style = screen.getByTestId("terminal-copy-text").style as CSSStyleDeclaration & Record<string, string>;
    expect(style.userSelect || style.getPropertyValue("user-select")).toBe("text");
    // jsdom (cssstyle) drops -webkit-touch-callout, so it cannot be asserted here.
    expect(style.touchAction || style.getPropertyValue("touch-action")).toBe("pan-y");
  });
});
