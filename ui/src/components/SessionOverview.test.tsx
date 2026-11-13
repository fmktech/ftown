// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, CommandResponse, Session, SessionCard } from "@/types";
import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import { PullRequestStatusProvider } from "./PullRequestStatusProvider";
import { SessionOverview, childSessionsOf, type OpenAttentionCount } from "./SessionOverview";
import { SessionWorkspace } from "./SessionWorkspace";

afterEach(cleanup);

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, bridgeId: "bridge", name: id, status: "running", createdAt: "2025-12-01T00:00:00.000Z", updatedAt: minutesAgo(1), ...extra };
}

function card(state: SessionCard["state"], extra: Partial<SessionCard> = {}): SessionCard {
  return { state, headline: "", updatedAt: minutesAgo(4), ...extra };
}

function send(): Promise<CommandResponse> {
  return Promise.resolve({ requestId: "r", success: true });
}

function renderOverview(manager: Session, sessions: Session[], options: { activityBySession?: Map<string, SessionActivity>; openAttentionBySession?: Map<string, OpenAttentionCount> } = {}) {
  return render(
    <PullRequestStatusProvider send={send} sessions={sessions} readyBridgeIds={["bridge"]} connected={false}>
      <SessionOverview session={manager} sessions={sessions} now={NOW} activityBySession={options.activityBySession} openAttentionBySession={options.openAttentionBySession} />
    </PullRequestStatusProvider>,
  );
}

function managerSession(extra: Partial<Session> = {}): Session {
  return session("manager", {
    name: "Manager",
    brief: {
      text: "# Plan\n\nShip the thing",
      notes: Array.from({ length: 11 }, (_, i) => ({ ts: `2026-01-01T0${Math.floor(i / 10)}:${String(i % 60).padStart(2, "0")}:00`, text: `note ${i}` })),
      updatedAt: minutesAgo(2),
    },
    ...extra,
  });
}

describe("SessionOverview", () => {
  it("renders the brief as a sandboxed markdown document, the last 10 notes and one row per child", () => {
    const manager = managerSession();
    const children = [
      session("child-1", { name: "Child one", parentSessionId: "manager", card: card("working", { headline: "Fixing the login loop" }), pullRequestUrl: "https://github.com/acme/repo/pull/7", worktree: { repoRoot: "/repo", path: "/repo/.claude/worktrees/child-one", branch: "ftown/child-one", base: "main", createdByBridge: true } }),
      session("child-2", { name: "Child two", parentSessionId: "manager", status: "completed" }),
    ];
    renderOverview(manager, [manager, ...children, session("unrelated", { name: "Unrelated" })]);

    const frame = screen.getByTitle("Brief: Manager") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const srcDoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("Content-Security-Policy");
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain("Ship the thing");

    const notes = screen.getByRole("region", { name: "Brief notes" });
    expect(notes.textContent).toContain("note 10");
    expect(notes.textContent).not.toContain("note 0");
    for (const text of ["note 1", "note 5"]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getAllByText(/\d{2}:\d{2}/).length).toBeGreaterThanOrEqual(10);

    expect(screen.getByText("Child one")).toBeTruthy();
    expect(screen.getByText("Child two")).toBeTruthy();
    expect(screen.queryByText("Unrelated")).toBeNull();
    expect(screen.getByRole("img", { name: "working: Fixing the login loop" })).toBeTruthy();
    expect(screen.getByText("#7").closest("a")?.getAttribute("href")).toBe("https://github.com/acme/repo/pull/7");
    expect(screen.getByText("ftown/child-one").getAttribute("title")).toContain("/repo/.claude/worktrees/child-one");
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("region", { name: "Overview: Manager" }).textContent).toContain("1 working");
  });

  it("shows each child card's age as 'updated Xm ago'", () => {
    const manager = managerSession({ brief: { notes: [], updatedAt: minutesAgo(2) } });
    renderOverview(manager, [manager, session("child-1", { name: "Child one", parentSessionId: "manager", card: card("working") })]);
    expect(screen.getByText("updated 4m ago")).toBeTruthy();
  });

  it("shows per-child activity, idle state and open questions with with-parent counts separately", () => {
    const manager = managerSession({ brief: undefined });
    const children = [
      session("child-1", { name: "Child one", parentSessionId: "manager" }),
      session("child-2", { name: "Child two", parentSessionId: "manager" }),
      session("child-3", { name: "Child three", parentSessionId: "manager", status: "completed" as const }),
    ];
    const activityBySession = new Map<string, SessionActivity>([
      ["child-1", { activity: "tool_use" }],
      ["child-2", { activity: "idle" }],
    ]);
    const openAttentionBySession = new Map<string, OpenAttentionCount>([
      ["child-1", { open: 2, withParent: 1 }],
      ["child-2", { open: 1, withParent: 0 }],
    ]);
    renderOverview(manager, [manager, ...children], { activityBySession, openAttentionBySession });

    expect(screen.getByText("Using a tool")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByTitle("Using a tool")).toBeTruthy();
    expect(screen.getByText("2 (1 with parent)")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("renders placeholder dashes when activity and attention maps are absent", () => {
    const manager = managerSession({ brief: undefined });
    renderOverview(manager, [manager, session("child-1", { name: "Child one", parentSessionId: "manager" })]);
    expect(screen.getByText("Running")).toBeTruthy();
    const questionsHeader = screen.getByRole("columnheader", { name: "Questions" });
    const row = questionsHeader.closest("table")!.querySelector("tbody tr")!;
    expect(row.textContent).toContain("—");
  });

  it("renders empty-state hints when no brief or notes exist", () => {
    const manager = managerSession({ brief: undefined });
    renderOverview(manager, [manager, session("child-1", { parentSessionId: "manager" })]);
    expect(screen.getByText(/No brief yet/)).toBeTruthy();
    expect(screen.getByText(/No notes yet/)).toBeTruthy();
  });

  it("renders a remote-image brief under the preview CSP that blocks remote loading", () => {
    const manager = managerSession({ brief: { text: 'Remote image:\n\n<img src="https://example.com/x.png">', notes: [], updatedAt: minutesAgo(2) } });
    renderOverview(manager, [manager, session("child-1", { parentSessionId: "manager" })]);
    const srcDoc = (screen.getByTitle("Brief: Manager") as HTMLIFrameElement).getAttribute("srcdoc") ?? "";
    // Markup passes through untouched; the preview CSP only permits data: images, so the remote image never loads.
    expect(srcDoc).toContain("https://example.com/x.png");
    expect(srcDoc).toContain("img-src data:");
  });

  it("renders nothing for a session without children", () => {
    const manager = managerSession();
    const { container } = renderOverview(manager, [manager]);
    expect(container.textContent).toBe("");
  });

  it("orders children oldest first by createdAt", () => {
    const manager = managerSession({ brief: undefined });
    const late = session("late", { name: "Late", parentSessionId: "manager", createdAt: "2026-01-01T00:00:00.000Z" });
    const early = session("early", { name: "Early", parentSessionId: "manager", createdAt: "2025-06-01T00:00:00.000Z" });
    expect(childSessionsOf(manager, [manager, late, early]).map(child => child.id)).toEqual(["early", "late"]);
    expect(childSessionsOf(manager, [manager, { ...late, parentSessionId: "other" }])).toEqual([]);
  });
});

describe("SessionWorkspace overview toggle", () => {
  let observedWidth = 500;
  class TestResizeObserver implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: DOMRect.fromRect({ width: observedWidth }), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this); }
    unobserve() {}
    disconnect() {}
  }

  it("on a compact workspace the Overview is the default tab and covers the still-mounted terminal without refitting it", () => {
    observedWidth = 500;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const manager = managerSession({ brief: undefined });
    const child = session("child-1", { name: "Child one", parentSessionId: "manager" });
    const onRefit = vi.fn();
    render(
      <SessionWorkspace session={manager} sessions={[manager, child]} client={null} userId="user" readable={false} sendCommand={vi.fn()} securityGeneration={0} open={false} onClose={vi.fn()} isDesktop mobileTab="terminal" onMobileTab={vi.fn()} onRefit={onRefit}>
        <div data-testid="terminal-node">Terminal content</div>
      </SessionWorkspace>,
    );
    const tablist = screen.getByRole("tablist", { name: "Session view" });
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-controls")).toBe("session-overview-panel");
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toBeTruthy();
    const terminal = screen.getByTestId("terminal-node");
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.queryByRole("tabpanel", { name: "Overview" })).toBeNull();
    expect(screen.getByTestId("terminal-node")).toBe(terminal);
    expect(onRefit).toHaveBeenCalled();
    onRefit.mockClear();
    const terminalTab = screen.getByRole("tab", { name: "Terminal" });
    terminalTab.focus();
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toBeTruthy();
    expect(screen.getByTestId("terminal-node")).toBe(terminal);
    expect(onRefit).not.toHaveBeenCalled();
  });

  it("on a desktop workspace the Overview gets its own column beside the fitted terminal", () => {
    observedWidth = 900;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const manager = managerSession({ brief: undefined });
    const child = session("child-1", { name: "Child one", parentSessionId: "manager" });
    const onRefit = vi.fn();
    render(
      <SessionWorkspace session={manager} sessions={[manager, child]} client={null} userId="user" readable={false} sendCommand={vi.fn()} securityGeneration={0} open={false} onClose={vi.fn()} isDesktop mobileTab="terminal" onMobileTab={vi.fn()} onRefit={onRefit}>
        <div data-testid="terminal-node">Terminal content</div>
      </SessionWorkspace>,
    );
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel", { name: "Overview" });
    expect(panel.closest(".session-aux-pane")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Auxiliary view" }).textContent).toBe("OverviewTerminal");
    const terminal = screen.getByTestId("terminal-node");
    expect((terminal.closest("[aria-label='Terminal']") as HTMLElement).hidden).toBe(false);
    expect(onRefit).toHaveBeenCalled();
    onRefit.mockClear();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.queryByRole("tabpanel", { name: "Overview" })).toBeNull();
    expect(screen.getByTestId("terminal-node")).toBe(terminal);
    expect(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toBeTruthy();
    expect(screen.getByTestId("terminal-node")).toBe(terminal);
  });

  it("shows no Overview tab for a session without children", () => {
    observedWidth = 900;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const plain = session("plain", { name: "Plain" });
    render(
      <SessionWorkspace session={plain} sessions={[plain]} client={null} userId="user" readable={false} sendCommand={vi.fn()} securityGeneration={0} open={false} onClose={vi.fn()} isDesktop mobileTab="terminal" onMobileTab={vi.fn()} onRefit={vi.fn()}>
        <div data-testid="terminal-node">Terminal content</div>
      </SessionWorkspace>,
    );
    expect(screen.queryByRole("tab", { name: "Overview" })).toBeNull();
    expect(screen.queryByRole("tabpanel", { name: "Overview" })).toBeNull();
  });
});
