// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MobileControlBar } from "./MobileControlBar";

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

function setup() {
  const onSendInput = vi.fn();
  const onPaste = vi.fn();
  const onSelectText = vi.fn();
  render(<MobileControlBar onSendInput={onSendInput} onPaste={onPaste} onSelectText={onSelectText} />);
  return { onSendInput, onPaste, onSelectText };
}

afterEach(() => {
  cleanup();
  setClipboard(undefined);
});

describe("MobileControlBar", () => {
  it("key buttons send their bytes", () => {
    const { onSendInput } = setup();
    fireEvent.click(screen.getByLabelText("Control C"));
    fireEvent.click(screen.getByLabelText("Up arrow"));
    expect(onSendInput).toHaveBeenNthCalledWith(1, "\x03");
    expect(onSendInput).toHaveBeenNthCalledWith(2, "\x1b[A");
  });

  it("Paste routes clipboard text to onPaste, never onSendInput", async () => {
    setClipboard({ readText: vi.fn().mockResolvedValue("a\nb") });
    const { onSendInput, onPaste } = setup();
    fireEvent.click(screen.getByLabelText("Paste clipboard into terminal"));
    expect((navigator.clipboard as unknown as { readText: ReturnType<typeof vi.fn> }).readText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onPaste).toHaveBeenCalledWith("a\nb"));
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it("empty clipboard shows a status and sends nothing", async () => {
    setClipboard({ readText: vi.fn().mockResolvedValue("") });
    const { onSendInput, onPaste } = setup();
    fireEvent.click(screen.getByLabelText("Paste clipboard into terminal"));
    expect(await screen.findByText("Clipboard is empty.")).toBeTruthy();
    expect(onPaste).not.toHaveBeenCalled();
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it("missing clipboard API opens the fallback; Send pastes and closes", () => {
    setClipboard(undefined);
    const { onSendInput, onPaste } = setup();
    fireEvent.click(screen.getByLabelText("Paste clipboard into terminal"));
    const area = screen.getByLabelText("Text to paste") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(area);
    fireEvent.change(area, { target: { value: "hello\nworld" } });
    expect(onPaste).not.toHaveBeenCalled();
    expect(onSendInput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Send"));
    expect(onPaste).toHaveBeenCalledWith("hello\nworld");
    expect(onSendInput).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Text to paste")).toBeNull();
  });

  it("Cancel closes the fallback without sending", () => {
    setClipboard(undefined);
    const { onSendInput, onPaste } = setup();
    fireEvent.click(screen.getByLabelText("Paste clipboard into terminal"));
    fireEvent.change(screen.getByLabelText("Text to paste"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByLabelText("Text to paste")).toBeNull();
    expect(onPaste).not.toHaveBeenCalled();
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it("readText rejecting opens the fallback", async () => {
    setClipboard({ readText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) });
    setup();
    fireEvent.click(screen.getByLabelText("Paste clipboard into terminal"));
    expect(await screen.findByLabelText("Text to paste")).toBeTruthy();
  });

  it("native paste on the hidden input goes to onPaste and is prevented", () => {
    const { onSendInput, onPaste } = setup();
    const input = screen.getByLabelText("Terminal input");
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { getData: () => "x\ny" } });
    input.dispatchEvent(ev);
    expect(onPaste).toHaveBeenCalledWith("x\ny");
    expect(ev.defaultPrevented).toBe(true);
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it("native paste with empty clipboardData does nothing", () => {
    const { onSendInput, onPaste } = setup();
    const input = screen.getByLabelText("Terminal input");
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { getData: () => "" } });
    input.dispatchEvent(ev);
    expect(onPaste).not.toHaveBeenCalled();
    expect(onSendInput).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("Select calls onSelectText", () => {
    const { onSelectText } = setup();
    fireEvent.click(screen.getByLabelText("Select terminal text to copy"));
    expect(onSelectText).toHaveBeenCalledTimes(1);
  });

  it("typing in the fallback textarea sends nothing until Send", () => {
    setClipboard(undefined);
    const { onSendInput, onPaste } = setup();
    fireEvent.click(screen.getByLabelText("Paste clipboard into terminal"));
    const area = screen.getByLabelText("Text to paste");
    fireEvent.keyDown(area, { key: "Enter" });
    fireEvent.change(area, { target: { value: "abc" } });
    fireEvent.input(area, { target: { value: "abcd" } });
    expect(onSendInput).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("readText throwing synchronously opens the fallback", () => {
    setClipboard({ readText: () => { throw new Error("x"); } });
    setup();
    fireEvent.click(screen.getByLabelText("Paste clipboard into terminal"));
    expect(screen.getByLabelText("Text to paste")).toBeTruthy();
  });

  it("Paste key title is the phone-clipboard default", () => {
    setup();
    expect(screen.getByLabelText("Paste clipboard into terminal").getAttribute("title")).toBe(
      "Paste this phone's clipboard into the terminal",
    );
  });

  it("no Host key when onHostPaste is not passed", () => {
    setup();
    expect(screen.queryByLabelText("Paste from host clipboard")).toBeNull();
  });

  it("Host key renders right after the Paste key with the host title", () => {
    setupWithHost();
    const paste = screen.getByLabelText("Paste clipboard into terminal");
    const host = screen.getByLabelText("Paste from host clipboard");
    expect(host.textContent).toBe("Host");
    expect(host.getAttribute("title")).toBe(
      "Paste the host computer's clipboard (Claude Code reads it on Ctrl+V)",
    );
    expect(paste.nextElementSibling).toBe(host);
    expect(host.parentElement).toBe(paste.parentElement);
  });

  it("Host click calls onHostPaste once and nothing else", () => {
    setClipboard({ readText: vi.fn().mockResolvedValue("phone text") });
    const { onSendInput, onPaste, onHostPaste } = setupWithHost();
    fireEvent.click(screen.getByLabelText("Paste from host clipboard"));
    expect(onHostPaste).toHaveBeenCalledTimes(1);
    expect((navigator.clipboard as unknown as { readText: ReturnType<typeof vi.fn> }).readText).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
    expect(onSendInput).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Text to paste")).toBeNull();
  });

  it("Host touchEnd calls onHostPaste once and nothing else", () => {
    setClipboard({ readText: vi.fn().mockResolvedValue("phone text") });
    const { onSendInput, onPaste, onHostPaste } = setupWithHost();
    fireEvent.touchEnd(screen.getByLabelText("Paste from host clipboard"));
    expect(onHostPaste).toHaveBeenCalledTimes(1);
    expect((navigator.clipboard as unknown as { readText: ReturnType<typeof vi.fn> }).readText).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
    expect(onSendInput).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Text to paste")).toBeNull();
  });
});

function setupWithHost() {
  const onSendInput = vi.fn();
  const onPaste = vi.fn();
  const onSelectText = vi.fn();
  const onHostPaste = vi.fn();
  render(
    <MobileControlBar
      onSendInput={onSendInput}
      onPaste={onPaste}
      onSelectText={onSelectText}
      onHostPaste={onHostPaste}
    />,
  );
  return { onSendInput, onPaste, onSelectText, onHostPaste };
}
