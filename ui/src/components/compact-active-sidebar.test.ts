// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeInfo } from "@/hooks/useBridges";
import type { Session } from "@/types";
import { SessionList } from "./SessionList";

const bridges: BridgeInfo[] = [
  { clientId: "client-a", bridgeId: "bridge-a", hostname: "alpha", connectedAt: "2026-08-21T12:00:00Z" },
  { clientId: "client-b", bridgeId: "bridge-b", hostname: "beta", connectedAt: "2026-08-21T12:00:00Z" },
];

function session(id: string, bridgeId: string, name: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    bridgeId,
    name,
    prompt: `${name} prompt`,
    status: "running",
    shellType: "pi",
    createdAt: "2026-08-21T12:00:00Z",
    updatedAt: "2026-08-21T12:00:00Z",
    ...overrides,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("sidebar project groups", () => {
  it("keeps the provider icon beside selected and compact session names", async () => {
    render(createElement(SessionList, {
      sessions: [
        session("session-a", "bridge-a", "Selected session"),
        session("session-b", "bridge-a", "Compact session"),
      ],
      bridges: [bridges[0]],
      selectedSessionId: "session-a",
      onSelectSession: vi.fn(),
    }));

    await waitFor(() => expect(screen.getAllByRole("img", { name: "Pi agent" })).toHaveLength(2));
    for (const name of ["Selected session", "Compact session"]) {
      const nameElement = screen.getByText(name);
      expect(nameElement.previousElementSibling?.getAttribute("data-harness-icon")).toBe("pi");
    }
  });

  it("retains hidden projects on remount and allows restoring them in compact mode", () => {
    const props = { sessions: [session("root", "bridge-a", "Manager", { projectName: "Shared" })],
      bridges, selectedSessionId: null, onSelectSession: vi.fn() };
    const first = render(createElement(SessionList, props));
    fireEvent.click(screen.getByRole("button", { name: "More actions for Shared" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide project" }));
    first.unmount();
    render(createElement(SessionList, { ...props, collapsed: true }));
    expect(screen.queryByRole("region", { name: "Shared" })).toBeNull();
    fireEvent.click(screen.getByText("Hidden projects"));
    fireEvent.click(screen.getByRole("button", { name: "Show Shared" }));
    expect(screen.getByRole("region", { name: "Shared" })).toBeTruthy();
  });

  it("hides and restores a project with sessions on two computers", () => {
    render(createElement(SessionList, {
      sessions: [
        session("parent", "bridge-a", "Manager", { projectName: "Shared" }),
        session("child", "bridge-b", "Remote child", { parentSessionId: "parent" }),
        session("legacy", "bridge-a", "Legacy session"),
      ], bridges, selectedSessionId: "child", onSelectSession: vi.fn(),
    }));
    expect(within(screen.getByRole("region", { name: "Shared" })).getByText("Remote child")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Shared" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide project" }));
    expect(screen.queryByText("Remote child")).toBeNull();
    expect(screen.getByText("Legacy session")).toBeTruthy();
    fireEvent.click(screen.getByText("Hidden projects"));
    fireEvent.click(screen.getByRole("button", { name: "Show Shared" }));
    expect(screen.getByText("Remote child")).toBeTruthy();
  });

  it("shows verbose activity only for the expanded row and keeps age beside its indicator", async () => {
    const sessionActivity = new Map([
      ["session-a", { activity: "tool_use" as const, toolName: "Bash" }],
      ["session-b", { activity: "tool_use" as const, toolName: "Bash" }],
    ]);
    render(createElement(SessionList, {
      sessions: [
        session("session-a", "bridge-a", "Selected session"),
        session("session-b", "bridge-a", "Compact session"),
      ],
      bridges: [bridges[0]],
      selectedSessionId: "session-a",
      onSelectSession: vi.fn(),
      sessionActivity,
    }));

    await waitFor(() => expect(screen.getAllByRole("status", { name: "Using a tool" })).toHaveLength(2));
    expect(screen.getAllByText("using Bash")).toHaveLength(1);
    for (const indicator of screen.getAllByRole("status", { name: "Using a tool" })) {
      expect(indicator.nextElementSibling?.textContent).not.toBe("");
    }
  });

  it("uses compact relative days instead of full dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
    render(createElement(SessionList, {
      sessions: [session("session-a", "bridge-a", "Older session", {
        createdAt: "2026-08-11T12:00:00Z",
      })],
      bridges: [bridges[0]],
      selectedSessionId: "session-a",
      onSelectSession: vi.fn(),
    }));

    expect(screen.getByText("10d")).toBeTruthy();
    expect(screen.queryByText("8/11/2026")).toBeNull();
  });

});

it("preserves the chosen project order across reloads and a changed session inventory", () => {
  const sessions = ["Alpha", "Beta", "Gamma"].map(project => session(project, "bridge-a", project, { projectName: project }));
  const props = { sessions, selectedSessionId: null, onSelectSession: vi.fn() };
  const view = render(createElement(SessionList, props));
  fireEvent.click(screen.getByRole("button", { name: "More actions for Beta" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
  const names = () => screen.getAllByRole("region").map(region => region.getAttribute("aria-label"));
  expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
  view.unmount();
  render(createElement(SessionList, { ...props, sessions: [...sessions].reverse() }));
  expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
});
