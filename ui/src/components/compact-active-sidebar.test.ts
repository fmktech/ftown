// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("sidebar bridge groups", () => {
  it("selecting a session expands its bridge and never collapses others", async () => {
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
      createElement(SessionList, { ...props, selectedSessionId: null }),
    );

    // Default: everything expanded. Collapse both manually — user's choice.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Collapse alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Collapse beta" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Collapse alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse beta" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expand alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Expand beta" })).toBeTruthy();
    });

    // Selecting a session on beta opens beta; alpha stays as the user left it.
    rerender(createElement(SessionList, { ...props, selectedSessionId: "session-b" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expand alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Collapse beta" })).toBeTruthy();
    });
    expect(screen.getByText("Beta session")).toBeTruthy();

    // Moving the selection back to alpha opens alpha WITHOUT re-collapsing
    // beta — no one-expanded-at-a-time behavior.
    rerender(createElement(SessionList, { ...props, selectedSessionId: "session-a" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Collapse alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Collapse beta" })).toBeTruthy();
    });
  });

  it("manual expansion survives session-list updates (no auto-recollapse)", async () => {
    const sessions = [
      session("session-a", "bridge-a", "Alpha session"),
      session("session-b", "bridge-b", "Beta session"),
    ];
    const props = {
      sessions,
      bridges,
      bridgeOrder: ["bridge-a", "bridge-b"],
      selectedSessionId: null,
      onSelectSession: vi.fn(),
    };
    // Simulate the mobile churn that used to trigger auto-collapse: fresh
    // props identity on every poll cycle.
    const { rerender } = render(createElement(SessionList, { ...props }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Collapse alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Collapse beta" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Collapse alpha" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand alpha" })).toBeTruthy());

    for (let i = 0; i < 3; i += 1) {
      rerender(createElement(SessionList, {
        ...props,
        sessions: sessions.map((s) => ({ ...s, updatedAt: new Date().toISOString() })),
      }));
    }
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expand alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Collapse beta" })).toBeTruthy();
    });
  });

  it("keeps the provider icon beside selected and compact session names", async () => {
    render(createElement(SessionList, {
      sessions: [
        session("session-a", "bridge-a", "Selected session"),
        session("session-b", "bridge-a", "Compact session"),
      ],
      bridges: [bridges[0]],
      bridgeOrder: ["bridge-a"],
      selectedSessionId: "session-a",
      onSelectSession: vi.fn(),
    }));

    await waitFor(() => expect(screen.getAllByRole("img", { name: "Pi agent" })).toHaveLength(2));
    for (const name of ["Selected session", "Compact session"]) {
      const nameElement = screen.getByText(name);
      expect(nameElement.previousElementSibling?.getAttribute("data-harness-icon")).toBe("pi");
    }
  });

  it("groups repeated root-agent folders without regrouping their subagents", async () => {
    render(createElement(SessionList, {
      sessions: [
        session("agent-a", "bridge-a", "Agent A", { workingDir: "/projects/acme" }),
        session("agent-a-child", "bridge-a", "Agent A child", {
          workingDir: "/projects/other",
          parentSessionId: "agent-a",
        }),
        session("agent-b", "bridge-a", "Agent B", { workingDir: "/projects/acme/" }),
        session("agent-c", "bridge-a", "Agent C", { workingDir: "/projects/other" }),
      ],
      bridges: [bridges[0]],
      bridgeOrder: ["bridge-a"],
      selectedSessionId: "agent-a-child",
      onSelectSession: vi.fn(),
    }));

    const acmeGroup = await screen.findByRole("group", { name: "Sessions in acme" });
    expect(within(acmeGroup).getByText("Agent A")).toBeTruthy();
    expect(within(acmeGroup).getByText("Agent A child")).toBeTruthy();
    expect(within(acmeGroup).getByText("Agent B")).toBeTruthy();
    expect(within(acmeGroup).getByLabelText("2 root agents")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Sessions in other" })).toBeNull();
    expect(screen.getByText("Agent C")).toBeTruthy();

    fireEvent.click(within(acmeGroup).getByRole("button", { name: "Collapse folder acme" }));
    expect(within(acmeGroup).queryByText("Agent A")).toBeNull();
    expect(within(acmeGroup).queryByText("Agent B")).toBeNull();
    expect(screen.getByText("Agent C")).toBeTruthy();
    expect(localStorage.getItem("ftown:collapsedSessionFolders")).toContain("bridge-a:/projects/acme");

    fireEvent.click(within(acmeGroup).getByRole("button", { name: "Expand folder acme" }));
    expect(within(acmeGroup).getByText("Agent A")).toBeTruthy();
    expect(within(acmeGroup).getByText("Agent B")).toBeTruthy();
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
      bridgeOrder: ["bridge-a"],
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
      bridgeOrder: ["bridge-a"],
      selectedSessionId: "session-a",
      onSelectSession: vi.fn(),
    }));

    expect(screen.getByText("10d")).toBeTruthy();
    expect(screen.queryByText("8/11/2026")).toBeNull();
  });

  it("selecting a cron expands its bridge and never collapses others", async () => {
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
      createElement(LoopList, { ...props, selectedLoopId: null }),
    );

    // Default: everything expanded. Collapse both manually — user's choice.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Collapse alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Collapse beta" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Collapse alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse beta" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expand alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Expand beta" })).toBeTruthy();
    });

    // Selecting a cron on beta opens beta; alpha stays as the user left it.
    rerender(createElement(LoopList, { ...props, selectedLoopId: "loop-b" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expand alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Collapse beta" })).toBeTruthy();
    });
    expect(screen.getByText("Beta cron")).toBeTruthy();

    // Moving the selection back to alpha opens alpha WITHOUT re-collapsing beta.
    rerender(createElement(LoopList, { ...props, selectedLoopId: "loop-a" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Collapse alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Collapse beta" })).toBeTruthy();
    });
  });

  it("keeps the provider icon beside selected and compact cron names", async () => {
    render(createElement(LoopList, {
      loops: [
        loop("loop-a", "bridge-a", "Selected cron"),
        loop("loop-b", "bridge-a", "Compact cron"),
      ],
      bridges: [bridges[0]],
      selectedLoopId: "loop-a",
      onSelectLoop: vi.fn(),
      onRunNow: vi.fn(),
      onToggleEnabled: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
    }));

    await waitFor(() => expect(screen.getAllByRole("img", { name: "Pi agent" })).toHaveLength(2));
    for (const name of ["Selected cron", "Compact cron"]) {
      const nameElement = screen.getByText(name);
      expect(nameElement.previousElementSibling?.getAttribute("data-harness-icon")).toBe("pi");
    }
  });
});
