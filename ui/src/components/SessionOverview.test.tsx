// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, CommandResponse, Session, SessionCard } from "@/types";
import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import { PullRequestStatusProvider } from "./PullRequestStatusProvider";
import { SessionOverview, childSessionsOf, orderPlan, partitionChildren, type AttentionOwner, type OpenAttentionCount, type OverviewEntry, type OverviewSnapshot, type PlanItem, type PlanView, type SnapshotCard } from "./SessionOverview";
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


function snapCard(id: string, name: string, declared: SessionCard | undefined, extra: Partial<SnapshotCard> = {}): SnapshotCard {
  return { sessionId: id, name, declared: declared ?? null, derived: { status: "running", activity: "unknown", openAttention: 0, unreadMail: 0, previews: [] }, stale: false, ...extra };
}

function send(): Promise<CommandResponse> {
  return Promise.resolve({ requestId: "r", success: true });
}

function renderOverview(manager: Session, sessions: Session[], options: { activityBySession?: Map<string, SessionActivity>; openAttentionBySession?: Map<string, OpenAttentionCount>; snapshot?: OverviewSnapshot } = {}) {
  return render(
    <PullRequestStatusProvider send={send} sessions={sessions} readyBridgeIds={["bridge"]} connected={false}>
      <SessionOverview session={manager} sessions={sessions} now={NOW} activityBySession={options.activityBySession} openAttentionBySession={options.openAttentionBySession} snapshot={options.snapshot} />
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
  const worktree = { repoRoot: "/repo", path: "/repo/.claude/worktrees/child-one", branch: "ftown/child-one", base: "main", createdByBridge: true as const };

  it("renders the manager line and one line per child grouped by active", () => {
    const manager = managerSession({ card: card("waiting_review", { headline: "reviewing" }) });
    const children = [
      session("child-1", { name: "Child one", parentSessionId: "manager", card: card("working", { headline: "Fixing the login loop" }) }),
      session("child-2", { name: "Child two", parentSessionId: "manager" }),
    ];
    renderOverview(manager, [manager, ...children, session("unrelated", { name: "Unrelated" })]);
    expect(screen.getByTestId("manager-line").textContent).toContain("Manager");
    expect(screen.getByRole("img", { name: "waiting review: reviewing" })).toBeTruthy();
    const active = screen.getByRole("region", { name: "Active" });
    expect(active.textContent).toContain("active · 2");
    expect(active.textContent).toContain("Fixing the login loop");
    expect(screen.queryByText("Unrelated")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Notes")).toBeNull();
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  });

  it("orders active rows waiting review, then working newest first, then no card", () => {
    const manager = managerSession({ brief: undefined });
    const children = [
      session("none", { name: "None", parentSessionId: "manager" }),
      session("old", { name: "Old", parentSessionId: "manager", card: card("working", { updatedAt: minutesAgo(30) }) }),
      session("new", { name: "New", parentSessionId: "manager", card: card("working", { updatedAt: minutesAgo(1) }) }),
      session("rev", { name: "Rev", parentSessionId: "manager", card: card("waiting_review") }),
    ];
    renderOverview(manager, [manager, ...children]);
    const names = screen.getAllByRole("button", { expanded: false }).map(button => button.textContent ?? "");
    const order = ["Rev", "New", "Old", "None"].map(name => names.findIndex(text => text.includes(name)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every(index => index >= 0)).toBe(true);
  });

  it("lists failed, blocked and human-question children under needs attention with owners, you first", () => {
    const manager = managerSession({ brief: undefined });
    const children = [
      session("failed", { name: "Failed", parentSessionId: "manager", card: card("failed", { headline: "tests red" }) }),
      session("human", { name: "Human", parentSessionId: "manager", card: card("blocked", { headline: "need call", blockedOn: { kind: "human", text: "pick one" } }) }),
      session("asker", { name: "Asker", parentSessionId: "manager", card: card("working") }),
      session("quiet", { name: "Quiet", parentSessionId: "manager", card: card("working") }),
    ];
    const openAttentionBySession = new Map<string, OpenAttentionCount>([["asker", { open: 1, withParent: 0 }], ["quiet", { open: 1, withParent: 1 }]]);
    renderOverview(manager, [manager, ...children], { openAttentionBySession });
    const group = screen.getByRole("region", { name: "Needs attention" });
    expect(group.textContent).toContain("needs attention · 3");
    const rows = within(group).getAllByRole("button").map(button => button.textContent ?? "");
    expect(rows[0]).toContain("you");
    expect(rows[1]).toContain("you");
    expect(rows[2]).toContain("Failed");
    expect(rows[2]).toContain("Manager");
    expect(screen.getByRole("region", { name: "Active" }).textContent).toContain("Quiet");
    expect(group.textContent).not.toContain("Quiet");
  });

  it("puts done and archived children in a folded done group with a peek", () => {
    const manager = managerSession({ brief: undefined });
    const children = [
      session("a", { name: "Alpha", parentSessionId: "manager", card: card("done", { headline: "shipped" }) }),
      session("b", { name: "Beta", parentSessionId: "manager", status: "completed" }),
      session("c", { name: "Gamma", parentSessionId: "manager", card: card("working") }),
    ];
    renderOverview(manager, [manager, ...children]);
    const fold = screen.getByRole("button", { name: /done · 2/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toContain("Alpha, Beta");
    expect(screen.queryByText("shipped")).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("shipped")).toBeTruthy();
  });

  it("expands a row to details: state, blocked, next, activity with idle duration, pr, worktree, agent", () => {
    const manager = managerSession({ brief: undefined });
    const child = session("child-1", {
      name: "Child one", parentSessionId: "manager", shellType: "claude", model: "opus", pullRequestUrl: "https://github.com/acme/repo/pull/7", worktree,
      card: card("blocked", { headline: "stuck", progress: { done: 1, total: 4 }, blockedOn: { kind: "session", text: "waiting on peer" }, next: "retry build" }),
    });
    const activityBySession = new Map<string, SessionActivity>([["child-1", { activity: "idle" }]]);
    render(
      <PullRequestStatusProvider send={send} sessions={[manager, child]} readyBridgeIds={["bridge"]} connected={false}>
        <SessionOverview session={manager} sessions={[manager, child]} now={NOW} activityBySession={activityBySession} idleSince={{ "child-1": minutesAgo(9) }} />
      </PullRequestStatusProvider>,
    );
    const row = screen.getByRole("button", { name: /Child one/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("retry build")).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("retry build")).toBeTruthy();
    expect(screen.getByText("waiting on peer")).toBeTruthy();
    expect(screen.getByText("◦ idle 9m")).toBeTruthy();
    expect(screen.getByText(/blocked on session 1\/4 · updated 4m ago/)).toBeTruthy();
    expect(screen.getByText("#7").closest("a")?.getAttribute("href")).toBe("https://github.com/acme/repo/pull/7");
    expect(screen.getByText("ftown/child-one").getAttribute("title")).toContain("/repo/.claude/worktrees/child-one");
    expect(screen.getByText("claude · opus")).toBeTruthy();
    fireEvent.click(row);
    expect(screen.queryByText("retry build")).toBeNull();
  });

  it("falls back to the open question count without a snapshot and shows question details with one", () => {
    const manager = managerSession({ brief: undefined });
    const child = session("child-1", { name: "Child one", parentSessionId: "manager", card: card("working") });
    const withoutSnapshot = renderOverview(manager, [manager, child], { openAttentionBySession: new Map([["child-1", { open: 2, withParent: 0 }]]) });
    fireEvent.click(screen.getByRole("button", { name: /Child one/ }));
    expect(screen.getByText("2 open")).toBeTruthy();
    withoutSnapshot.unmount();

    const snapshot: OverviewSnapshot = {
      board: { rootId: "manager", cards: [snapCard("child-1", "Child one", card("working"))] },
      events: [],
      attention: [{ sessionId: "child-1", event: { id: "e1", title: "Which DB?", route: "human", escalationNote: "manager unsure", prompt: { questions: [{ options: [{ label: "pg" }, { label: "sqlite" }] }] } } }],
    };
    renderOverview(manager, [manager, child], { snapshot });
    expect(within(screen.getByRole("region", { name: "Needs attention" })).getByText("you")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Child one/ }));
    expect(screen.getByText(/Which DB\? · you · manager unsure · pg \/ sqlite/)).toBeTruthy();
  });

  it("uses the snapshot for retired children, the planned fold, and the events fold", () => {
    const manager = managerSession({ brief: undefined });
    const live = session("live", { name: "Live", parentSessionId: "manager", card: card("working", { headline: "going" }) });
    const planItem = (id: string, title: string, state: PlanItem["state"], after: string[] = [], extra: Partial<PlanItem> = {}): PlanItem => ({ id, title, after, priority: 2, state, createdAt: minutesAgo(50), updatedAt: minutesAgo(40), ...extra });
    const plan: PlanView = { items: [planItem("p2", "write tests", "todo"), planItem("p3", "ship", "todo", ["p2"]), planItem("p1", "scaffold", "done")], ready: ["p2"] };
    const snapshot: OverviewSnapshot = {
      board: { rootId: "manager", cards: [snapCard("live", "Live", live.card), snapCard("old", "Retired", card("working", { headline: "merged" }), { archived: true })], plan },
      events: [
        { seq: 1, ts: minutesAgo(20), sessionId: "live", sessionName: "Live", kind: "status", summary: "working | extra" },
        { seq: 2, ts: minutesAgo(10), sessionId: "live", sessionName: "Live", kind: "pr", summary: "PR opened" },
        { seq: 3, ts: minutesAgo(10), sessionId: "live", sessionName: "Live", kind: "pr", summary: "PR opened" },
      ],
      attention: [],
    };
    renderOverview(manager, [manager, live], { snapshot });
    const doneFold = screen.getByRole("button", { name: /done · 1/ });
    expect(doneFold.textContent).toContain("Retired");
    fireEvent.click(doneFold);
    const retiredRow = within(screen.getByRole("region", { name: "done" })).getByRole("button", { name: /Retired/ });
    expect(retiredRow.textContent).toContain("⌀");
    expect(retiredRow.textContent).toContain("retired");
    expect(retiredRow.textContent).not.toContain("working");
    expect(retiredRow.textContent).not.toContain("▸");
    const glyph = retiredRow.querySelector("span[aria-hidden]");
    expect(glyph?.textContent).toBe("⌀");
    expect((glyph as HTMLElement).style.color).toBe("var(--text-faint)");
    fireEvent.click(retiredRow);
    expect(within(screen.getByRole("region", { name: "done" })).getAllByText("retired").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("region", { name: "done" })).queryByText(/^working/)).toBeNull();

    const planned = screen.getByRole("button", { name: /planned · 2/ });
    expect(planned.textContent).toContain("next: write tests");
    fireEvent.click(planned);
    const items = within(screen.getByRole("region", { name: "planned" })).getAllByRole("listitem");
    expect(items.map(item => item.textContent ?? "")).toEqual([
      expect.stringContaining("→p2write tests"),
      expect.stringContaining("·p3ship"),
      expect.stringContaining("✓p1scaffold"),
    ]);
    fireEvent.click(within(items[1]!).getByRole("button"));
    expect(screen.getByText("after write tests")).toBeTruthy();
    fireEvent.click(within(items[0]!).getByRole("button"));
    expect(screen.getByText("ready to start")).toBeTruthy();

    const events = screen.getByRole("button", { name: /events · 3/ });
    expect(events.textContent).toContain("last");
    fireEvent.click(events);
    const lines = within(screen.getByRole("region", { name: "events" })).getAllByRole("button").slice(1).map(button => button.textContent ?? "");
    expect(lines[0]).toContain("PR opened ×2");
    expect(lines[1]).toContain("working");
    expect(lines[1]).not.toContain("extra");
    fireEvent.click(within(screen.getByRole("region", { name: "events" })).getAllByRole("button")[2]!);
    expect(within(screen.getByRole("region", { name: "events" })).getByText(/working \| extra/)).toBeTruthy();
  });

  it("keeps the brief in a closed fold holding the sandboxed iframe", () => {
    const manager = managerSession();
    renderOverview(manager, [manager, session("child-1", { parentSessionId: "manager" })]);
    expect(screen.queryByTitle("Brief: Manager")).toBeNull();
    const fold = screen.getByRole("button", { name: /brief/ });
    expect(fold.textContent).toContain("updated 2m ago");
    fireEvent.click(fold);
    const frame = screen.getByTitle("Brief: Manager") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const srcDoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("Content-Security-Policy");
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain("Ship the thing");
  });

  it("omits the brief fold when there is no brief and renders a remote-image brief under the blocking CSP", () => {
    const none = managerSession({ brief: undefined });
    const { unmount } = renderOverview(none, [none, session("child-1", { parentSessionId: "manager" })]);
    expect(screen.queryByRole("button", { name: /brief/ })).toBeNull();
    unmount();
    const manager = managerSession({ brief: { text: 'Remote image:\n\n<img src="https://example.com/x.png">', notes: [], updatedAt: minutesAgo(2) } });
    renderOverview(manager, [manager, session("child-1", { parentSessionId: "manager" })]);
    fireEvent.click(screen.getByRole("button", { name: /brief/ }));
    const srcDoc = (screen.getByTitle("Brief: Manager") as HTMLIFrameElement).getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("https://example.com/x.png");
    expect(srcDoc).toContain("img-src data:");
  });

  it("supports j/k/enter/d/e/esc from the keyboard", () => {
    const manager = managerSession({ brief: undefined });
    const children = [
      session("a", { name: "Alpha", parentSessionId: "manager", card: card("working", { headline: "first", next: "n-a", updatedAt: minutesAgo(1) }) }),
      session("b", { name: "Beta", parentSessionId: "manager", card: card("working", { headline: "second", next: "n-b", updatedAt: minutesAgo(9) }) }),
    ];
    const snapshot: OverviewSnapshot = { board: { rootId: "manager", cards: [] }, events: [{ seq: 1, ts: minutesAgo(1), sessionId: "a", sessionName: "Alpha", kind: "status", summary: "go" }], attention: [] };
    renderOverview(manager, [manager, ...children], { snapshot });
    const section = screen.getByRole("region", { name: "Overview: Manager" });
    const [alpha, beta] = screen.getAllByRole("button").filter(button => button.hasAttribute("data-overview-row"));
    alpha!.focus();
    fireEvent.keyDown(alpha!, { key: "j" });
    expect(document.activeElement).toBe(beta);
    fireEvent.keyDown(beta!, { key: "k" });
    expect(document.activeElement).toBe(alpha);
    fireEvent.keyDown(alpha!, { key: "Enter" });
    expect(alpha!.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("n-a")).toBeTruthy();
    fireEvent.keyDown(section, { key: "d" });
    expect(screen.getByText("n-b")).toBeTruthy();
    fireEvent.keyDown(section, { key: "e" });
    expect(screen.getByRole("button", { name: /events · 1/ }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(section, { key: "Escape" });
    expect(alpha!.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("n-b")).toBeNull();
    expect(screen.getByRole("button", { name: /events · 1/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("derives a grey stale glyph for a working card not updated for over 10 minutes", () => {
    const manager = managerSession({ brief: undefined });
    renderOverview(manager, [manager, session("a", { name: "Alpha", parentSessionId: "manager", card: card("working", { updatedAt: minutesAgo(20) }) })]);
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(screen.getByText(/· stale/)).toBeTruthy();
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

describe("partitionChildren and orderPlan", () => {
  const entry = (id: string, state?: SessionCard["state"], extra: Partial<OverviewEntry> = {}): OverviewEntry => ({
    id, name: id, archived: false, createdAt: "", card: state ? card(state) : undefined, stale: false, humanQuestions: 0, openAttention: 0, unreadMail: 0, previews: [], agent: "", ...extra,
  });

  it("splits attention, active and done without repeating rows", () => {
    const result = partitionChildren(
      [entry("w", "working"), entry("f", "failed"), entry("d", "done"), entry("r", "archived" as never, { archived: true }), entry("h", "working")],
      new Map<string, AttentionOwner>([["f", "manager"], ["h", "you"]]),
    );
    expect(result.attention.map(item => item.id)).toEqual(["h", "f"]);
    expect(result.active.map(item => item.id)).toEqual(["w"]);
    expect(result.done.map(item => item.id)).toEqual(["d", "r"]);
  });

  it("orders plan items ready, waiting, started, done, dropped", () => {
    const item = (id: string, state: PlanItem["state"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, title: id, after: [], priority: 2, state, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra });
    const view = orderPlan([
      item("dropped", "dropped"), item("done", "done"), item("started", "started"),
      item("waiting", "todo", { after: ["started"] }), item("low", "todo", { priority: 3 }), item("high", "todo", { priority: 1 }),
      item("afterdone", "todo", { after: ["done"], priority: 3, createdAt: "2026-01-02T00:00:00Z" }),
    ]);
    expect(view.items.map(i => i.id)).toEqual(["high", "low", "afterdone", "waiting", "started", "done", "dropped"]);
    expect(view.ready).toEqual(["high", "low", "afterdone"]);
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
