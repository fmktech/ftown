// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ShellType } from "@/types";
import { HarnessIcon, harnessLabel } from "./HarnessIcon";

afterEach(cleanup);

describe("HarnessIcon", () => {
  it("renders an accessible provider icon instead of a text badge", () => {
    render(createElement(HarnessIcon, { harness: "codex" }));

    const icon = screen.getByRole("img", { name: "Codex agent" });
    expect(icon.getAttribute("title")).toBe("Codex agent");
    expect(icon.querySelector("svg")).toBeTruthy();
    expect(icon.textContent).toBe("");
  });

  it("renders the compact Pi mark with its provider label", () => {
    render(createElement(HarnessIcon, { harness: "pi" }));

    const icon = screen.getByRole("img", { name: "Pi agent" });
    expect(icon.getAttribute("data-harness-icon")).toBe("pi");
    expect(icon.querySelector('svg[viewBox="0 0 24 24"]')).toBeTruthy();
  });

  it.each([
    ["claude", "Claude"],
    ["cursor", "Cursor"],
    ["codex", "Codex"],
    ["shell", "Shell"],
    ["zai", "Z.ai"],
    ["kimi", "Kimi"],
    ["opencode", "OpenCode"],
    ["deepseek", "DeepSeek"],
    ["fireworks", "Fireworks"],
    ["grok", "Grok"],
    ["pi", "Pi"],
    ["kimi-code", "Kimi Code"],
  ] satisfies Array<[ShellType, string]>)("labels the %s harness", (harness, label) => {
    expect(harnessLabel(harness)).toBe(label);
    render(createElement(HarnessIcon, { harness }));
    expect(screen.getByRole("img", { name: `${label} agent` }).getAttribute("data-harness-icon")).toBe(harness);
  });
});
