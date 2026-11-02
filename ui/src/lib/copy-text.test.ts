// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copy-text";

function setClipboard(value: unknown): void {
  Object.defineProperty(window.navigator, "clipboard", { value, configurable: true, writable: true });
}

function setExecCommand(value: unknown): void {
  Object.defineProperty(document, "execCommand", { value, configurable: true, writable: true });
}

afterEach(() => {
  delete (window.navigator as unknown as { clipboard?: unknown }).clipboard;
  delete (document as unknown as { execCommand?: unknown }).execCommand;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("resolves true when writeText succeeds and writes the text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);

    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("calls writeText synchronously, before the returned promise is awaited", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    const p = copyText("x");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("x");
    await expect(p).resolves.toBe(true);
  });

  it("falls back to execCommand when writeText rejects, and removes the textarea", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard({ writeText });
    let textareaDuringCopy: HTMLTextAreaElement | null = null;
    const execCommand = vi.fn((command: string) => {
      textareaDuringCopy = document.querySelector("textarea");
      return command === "copy";
    });
    setExecCommand(execCommand);

    await expect(copyText("fallback text")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("fallback text");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(writeText.mock.invocationCallOrder[0]).toBeLessThan(execCommand.mock.invocationCallOrder[0]);
    expect(textareaDuringCopy).not.toBeNull();
    expect((textareaDuringCopy as HTMLTextAreaElement | null)?.value).toBe("fallback text");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when writeText throws synchronously and resolves the execCommand result", async () => {
    const writeText = vi.fn(() => {
      throw new Error("sync failure");
    });
    setClipboard({ writeText });
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);

    await expect(copyText("sync throw")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("sync throw");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("resolves false and removes the textarea when execCommand returns false", async () => {
    setClipboard(undefined);
    setExecCommand(vi.fn(() => false));

    await expect(copyText("not copied")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("resolves false when writeText rejects and the fallback fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard({ writeText });
    setExecCommand(vi.fn(() => false));

    await expect(copyText("both fail")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("configures the textarea (readonly, 16px font, full selection) before execCommand", async () => {
    setClipboard(undefined);
    const text = "select me";
    let seen: { readOnly: boolean; fontSize: string; selectionStart: number | null; selectionEnd: number | null } | null = null;
    setExecCommand(vi.fn(() => {
      const ta = document.querySelector("textarea");
      seen = {
        readOnly: ta?.readOnly ?? false,
        fontSize: ta?.style.fontSize ?? "",
        selectionStart: ta?.selectionStart ?? null,
        selectionEnd: ta?.selectionEnd ?? null,
      };
      return true;
    }));

    await expect(copyText(text)).resolves.toBe(true);
    expect(seen).toEqual({ readOnly: true, fontSize: "16px", selectionStart: 0, selectionEnd: text.length });
  });

  it("without a clipboard API, calls execCommand synchronously and returns its result", async () => {
    setClipboard(undefined);
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);

    const p = copyText("sync");
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith("copy");
    await expect(p).resolves.toBe(true);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("resolves false when execCommand throws, and removes the textarea", async () => {
    setClipboard(undefined);
    setExecCommand(vi.fn(() => {
      throw new Error("not allowed");
    }));

    await expect(copyText("boom")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("resolves false for empty text and touches neither clipboard nor execCommand", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);

    await expect(copyText("")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("restores focus to the previously focused input", async () => {
    setClipboard(undefined);
    setExecCommand(vi.fn(() => true));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    await expect(copyText("focus me back")).resolves.toBe(true);
    expect(document.activeElement).toBe(input);
    expect(document.querySelector("textarea")).toBeNull();
  });
});
