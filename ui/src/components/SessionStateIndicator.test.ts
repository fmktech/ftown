// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStateIndicator } from "./SessionStateIndicator";

afterEach(cleanup);

describe("SessionStateIndicator", () => {
  it("uses a static yellow dot for idle sessions", () => {
    render(createElement(SessionStateIndicator, { status: "running", activity: "idle" }));
    const indicator = screen.getByTitle("Idle");
    expect(indicator.className).toContain("status-dot-pending");
    expect(indicator.className).not.toContain("animate-pending");
  });

  it("uses a green dot without a running text label", () => {
    const { container } = render(createElement(SessionStateIndicator, { status: "running" }));
    expect(screen.getByRole("img", { name: "Running" }).className).toContain("status-dot-running");
    expect(container.textContent).toBe("");
  });

  it("spins while the agent is doing work", () => {
    render(createElement(SessionStateIndicator, { status: "running", activity: "thinking" }));
    expect(screen.getByRole("status", { name: "Thinking" }).className).toContain("animate-spin");
  });

  it("uses the same active spinner while a tool is running", () => {
    render(createElement(SessionStateIndicator, { status: "running", activity: "tool_use" }));
    expect(screen.getByRole("status", { name: "Using a tool" }).className).toContain("animate-spin");
  });

  it("shows a dialog icon when input is needed", () => {
    render(createElement(SessionStateIndicator, {
      status: "running",
      activity: "idle",
      needsInput: true,
    }));
    expect(screen.getByRole("img", { name: "Input needed" }).querySelector("svg")).toBeTruthy();
  });

  it("prioritizes an input request over active work", () => {
    render(createElement(SessionStateIndicator, {
      status: "running",
      activity: "thinking",
      needsInput: true,
    }));
    expect(screen.getByRole("img", { name: "Input needed" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Thinking" })).toBeNull();
  });

  it.each([
    ["pending", "Pending", "status-dot-pending"],
    ["completed", "Completed", "status-dot-done"],
    ["disconnected", "Disconnected", "status-dot-done"],
    ["error", "Error", "status-dot-error"],
  ] as const)("renders %s as an accessible static dot", (status, label, className) => {
    render(createElement(SessionStateIndicator, { status }));
    const indicator = screen.getByRole("img", { name: label });
    expect(indicator.className).toContain(className);
    expect(indicator.className).not.toContain("animate-");
  });
});
