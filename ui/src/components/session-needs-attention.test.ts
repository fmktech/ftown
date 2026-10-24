// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import type { BridgeInfo } from "@/hooks/useBridges";
import type { Session } from "@/types";
import { SessionList } from "./SessionList";

const bridges: BridgeInfo[] = [
  { clientId: "client-a", bridgeId: "bridge-a", hostname: "alpha", connectedAt: "2026-10-23T12:00:00Z" },
  { clientId: "client-b", bridgeId: "bridge-b", hostname: "beta", connectedAt: "2026-10-23T12:00:00Z" },
];

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id, bridgeId: "bridge-a", name: id, prompt: `${id} prompt`,
    status: "running", shellType: "pi",
    createdAt: "2026-10-20T12:00:00Z", updatedAt: "2026-10-23T12:00:00Z",
    ...overrides,
  };
}

function attention(receivedAt = Date.now(), activity: SessionActivity["activity"] = "idle"): SessionActivity {
  return {
    activity,
    attention: { type: "agent_needs_input", title: "Approval requested", message: "Review the complete deployment plan before proceeding.", receivedAt },
  };
}

const baseProps = {
  bridges,
  bridgeOrder: ["bridge-a", "bridge-b"],
  selectedSessionId: null,
  onSelectSession: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Needs attention shortcuts", () => {
  it("duplicates sessions above their original groups with the full request and request age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const longName = "Review the deployment plan and approve the database changes";
    const { container } = render(createElement(SessionList, {
      ...baseProps,
      sessions: [session("review", { name: longName })],
      sessionActivity: new Map([["review", attention(Date.now() - 120_000)]]),
    }));

    const region = screen.getByRole("region", { name: "Needs attention" });
    const shortcut = within(region).getByRole("button", {
      name: `${longName}: Approval requested. Review the complete deployment plan before proceeding.`,
    });
    expect(screen.getAllByText(longName)).toHaveLength(2);
    expect(container.firstElementChild?.firstElementChild).toBe(region);
    expect(within(region).getByRole("img", { name: "Pi agent" })).toBeTruthy();
    expect(within(shortcut).getByText("2m")).toBeTruthy();
    expect(within(shortcut).getByText(longName).style.textOverflow).toBe("ellipsis");
    expect(shortcut.style.minHeight).toBe("44px");
    expect(shortcut.hasAttribute("draggable")).toBe(false);
    expect(within(shortcut).queryAllByRole("button")).toHaveLength(0);
    expect(within(shortcut).queryByText("review prompt")).toBeNull();
    expect(within(shortcut).getByText("Review the complete deployment plan before proceeding.")).toBeTruthy();
    const original = container.querySelector<HTMLButtonElement>('button[draggable="true"]')!;
    expect(within(original).queryByText("Review the complete deployment plan before proceeding.")).toBeNull();
    expect(within(original).getByRole("img", { name: "Input needed" })).toBeTruthy();
  });

  it("wraps long unbroken messages in a three-line upper preview with full accessible text", () => {
    const message = "x".repeat(2000);
    const { container } = render(createElement(SessionList, {
      ...baseProps, sessions: [session("review")],
      sessionActivity: new Map([["review", { activity: "idle" as const, attention: {
        type: "agent_needs_input" as const, title: "Review requested", message, receivedAt: 1,
      } }]]),
    }));
    const region = screen.getByRole("region", { name: "Needs attention" });
    const shortcut = within(region).getByRole("button", { name: `review: Review requested. ${message}` });
    const preview = within(shortcut).getByText(message);
    expect(preview.style.overflowWrap).toBe("anywhere");
    expect(preview.style.whiteSpace).toBe("normal");
    expect(preview.style.getPropertyValue("-webkit-line-clamp")).toBe("3");
    expect(shortcut.title).toBe(`review: Review requested. ${message}`);
    expect(container.querySelector('button[draggable="true"]')?.textContent).not.toContain(message);
  });

  it("includes manual attention in every activity state but never idle alone or removed sessions", () => {
    render(createElement(SessionList, {
      ...baseProps,
      sessions: [session("idle-request"), session("thinking-request"), session("tool-request"), session("idle-only")],
      sessionActivity: new Map<string, SessionActivity>([
        ["idle-request", attention()], ["thinking-request", attention(Date.now(), "thinking")],
        ["tool-request", attention(Date.now(), "tool_use")], ["idle-only", { activity: "idle" }],
        ["removed", attention()],
      ]),
    }));
    const region = screen.getByRole("region", { name: "Needs attention" });
    expect(within(region).getAllByRole("button")).toHaveLength(3);
    for (const name of ["idle-request", "thinking-request", "tool-request"]) {
      expect(within(region).getByText(name)).toBeTruthy();
    }
    expect(within(region).queryByText("idle-only")).toBeNull();
    expect(within(region).queryByText("removed")).toBeNull();
  });

  it("sorts newest requests first and preserves incoming session order on ties", () => {
    const items = [session("older"), session("tie-first"), session("newest"), session("tie-second")];
    render(createElement(SessionList, {
      ...baseProps, sessions: items,
      // Deliberately different map order: ties follow sessions, not event-map insertion.
      sessionActivity: new Map([
        ["tie-second", attention(2000)], ["newest", attention(3000)],
        ["older", attention(1000)], ["tie-first", attention(2000)],
      ]),
    }));
    const rows = within(screen.getByRole("region", { name: "Needs attention" })).getAllByRole("button");
    expect(rows.map((row) => row.getAttribute("aria-label")?.split(":")[0]))
      .toEqual(["newest", "tie-first", "tie-second", "older"]);
  });

  it("keeps shortcuts through collapsed parents, folders and bridges while excluding hidden items", () => {
    const sessions = [
      session("parent", { workingDir: "/projects/acme" }),
      session("child", { parentSessionId: "parent" }),
      session("peer", { workingDir: "/projects/acme" }),
      session("other-folder", { workingDir: "/projects/other" }),
      session("hidden-session"), session("hidden-bridge", { bridgeId: "bridge-b" }),
    ];
    render(createElement(SessionList, {
      ...baseProps, sessions,
      hiddenSessionIds: new Set(["hidden-session"]), hiddenBridgeIds: new Set(["bridge-b"]),
      sessionActivity: new Map(["child", "peer", "hidden-session", "hidden-bridge"].map((id) => [id, attention()])),
    }));
    const region = screen.getByRole("region", { name: "Needs attention" });
    const folder = screen.getByRole("group", { name: "Sessions in acme" });
    expect(within(folder).queryByText("child")).toBeNull(); // Existing parent default collapse.
    expect(within(region).getByText("child")).toBeTruthy();
    fireEvent.click(within(folder).getByRole("button", { name: "Collapse folder acme" }));
    expect(within(folder).queryByText("peer")).toBeNull();
    expect(within(region).getByText("peer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse alpha" }));
    expect(within(region).getAllByRole("button")).toHaveLength(2);
    expect(within(region).queryByText("hidden-session")).toBeNull();
    expect(within(region).queryByText("hidden-bridge")).toBeNull();
  });

  it("calls only selection, reflects selection compactly, and follows external clearing and hiding", () => {
    const onSelectSession = vi.fn();
    const props = {
      ...baseProps, onSelectSession, sessions: [session("review")], selectedSessionId: "review",
      sessionActivity: new Map([["review", attention()]]),
    };
    const { rerender } = render(createElement(SessionList, props));
    const shortcut = within(screen.getByRole("region", { name: "Needs attention" })).getByRole("button");
    expect(shortcut.getAttribute("aria-current")).toBe("true");
    expect(shortcut.style.background).toBe("var(--bg-elevated)");
    expect(shortcut.style.minHeight).toBe("44px");
    expect(shortcut.querySelector("p")).toBeNull();
    fireEvent.click(shortcut);
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith("review");
    expect(screen.getByRole("region", { name: "Needs attention" })).toBeTruthy();
    rerender(createElement(SessionList, { ...props, sessionActivity: new Map([["review", { activity: "idle" as const }]]) }));
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
    expect(screen.getByText("review")).toBeTruthy();
    rerender(createElement(SessionList, { ...props, hiddenSessionIds: new Set(["review"]) }));
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  });

  it("renders nothing for the attention section when empty or the sidebar is collapsed", () => {
    const props = { ...baseProps, sessions: [session("review")] };
    const { rerender } = render(createElement(SessionList, props));
    expect(screen.queryByText("Needs attention")).toBeNull();
    rerender(createElement(SessionList, {
      ...props, collapsed: true, sessionActivity: new Map([["review", attention()]]),
    }));
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.getByText("review")).toBeTruthy();
    rerender(createElement(SessionList, {
      ...props, sessions: [session("fallback", { name: "", prompt: "A prompt used as the session display name" })],
      sessionActivity: new Map([["fallback", attention()]]),
    }));
    expect(within(screen.getByRole("region", { name: "Needs attention" })).getByRole("button")
      .getAttribute("aria-label")).toBe(`A prompt used as the session display name`.slice(0, 36) + ": Approval requested. Review the complete deployment plan before proceeding.");
  });
});
