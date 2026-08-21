// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeInfo } from "@/hooks/useBridges";
import type { Loop, Session } from "@/types";
import { LoopList } from "./LoopList";
import { SessionList } from "./SessionList";

const bridges: BridgeInfo[] = [
  { clientId: "client-a", bridgeId: "bridge-a", hostname: "alpha", connectedAt: "2026-08-21T12:00:00Z" },
  { clientId: "client-b", bridgeId: "bridge-b", hostname: "beta", connectedAt: "2026-08-21T12:00:00Z" },
];

function session(id: string, bridgeId: string, name: string): Session {
  return {
    id,
    bridgeId,
    name,
    prompt: `${name} prompt`,
    status: "running",
    shellType: "pi",
    createdAt: "2026-08-21T12:00:00Z",
    updatedAt: "2026-08-21T12:00:00Z",
  };
}

function loop(id: string, bridgeId: string, name: string): Loop {
  return {
    id,
    bridgeId,
    name,
    schedule: { kind: "interval", everyMs: 60_000 },
    harness: "pi",
    task: `${name} task`,
    enabled: true,
    overlapPolicy: "skip",
    retention: { autoClearAfterRuns: 10 },
    runCount: 0,
    skipCount: 0,
    createdAt: "2026-08-21T12:00:00Z",
    updatedAt: "2026-08-21T12:00:00Z",
  };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("compact active sidebars", () => {
  it("expands only the bridge containing the selected session", async () => {
    const sessions = [
      session("session-a", "bridge-a", "Alpha session"),
      session("session-b", "bridge-b", "Beta session"),
    ];
    const props = {
      sessions,
      bridges,
      bridgeOrder: ["bridge-a", "bridge-b"],
      onSelectSession: vi.fn(),
    };
    const { rerender } = render(
      createElement(SessionList, { ...props, selectedSessionId: "session-b" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expand alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Collapse beta" })).toBeTruthy();
    });
    expect(screen.queryByText("Alpha session")).toBeNull();
    expect(screen.getByText("Beta session")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand alpha" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Collapse alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Expand beta" })).toBeTruthy();
    });

    rerender(createElement(SessionList, { ...props, selectedSessionId: "session-a" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Collapse alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Expand beta" })).toBeTruthy();
    });
  });

  it("expands only the bridge containing the selected cron", async () => {
    const loops = [
      loop("loop-a", "bridge-a", "Alpha cron"),
      loop("loop-b", "bridge-b", "Beta cron"),
    ];
    const props = {
      loops,
      bridges,
      onSelectLoop: vi.fn(),
      onRunNow: vi.fn(),
      onToggleEnabled: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
    };
    const { rerender } = render(
      createElement(LoopList, { ...props, selectedLoopId: "loop-b" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expand alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Collapse beta" })).toBeTruthy();
    });
    expect(screen.queryByText("Alpha cron")).toBeNull();
    expect(screen.getByText("Beta cron")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand alpha" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Collapse alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Expand beta" })).toBeTruthy();
    });

    rerender(createElement(LoopList, { ...props, selectedLoopId: "loop-a" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Collapse alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Expand beta" })).toBeTruthy();
    });
  });
});
