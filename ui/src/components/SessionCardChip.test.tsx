// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Session, SessionCard } from "@/types";
import {
  SessionCardChip,
  cardStateLabel,
  formatCardRollup,
  rollupChildCards,
} from "./SessionCardChip";

afterEach(cleanup);

function card(state: SessionCard["state"], extra: Partial<SessionCard> = {}): SessionCard {
  return { state, headline: "", updatedAt: "2026-01-01T00:00:00.000Z", ...extra };
}

describe("SessionCardChip", () => {
  it("renders each state with its label and pairwise distinct colours", () => {
    render(
      <>
        <SessionCardChip card={card("working", { headline: "h" })} />
        <SessionCardChip card={card("blocked", { headline: "h", blockedOn: { kind: "human", text: "needs approval" } })} />
        <SessionCardChip card={card("waiting_review", { headline: "h" })} />
        <SessionCardChip card={card("done", { headline: "h" })} />
        <SessionCardChip card={card("failed", { headline: "h" })} />
      </>,
    );
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.getByText("blocked on human")).toBeTruthy();
    expect(screen.getByText("waiting review")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    const fgColors = [
      screen.getByRole("img", { name: /^working: h$/ }),
      screen.getByRole("img", { name: /^blocked on human: h$/ }),
      screen.getByRole("img", { name: /^waiting review: h$/ }),
      screen.getByRole("img", { name: /^done: h$/ }),
      screen.getByRole("img", { name: /^failed: h$/ }),
    ].map((chip) => chip.style.color);
    expect(new Set(fgColors).size).toBe(5);
  });

  it("shows the headline truncated with the full text as title", () => {
    const headline = "Fix the login redirect loop affecting signed-out users";
    render(<SessionCardChip card={card("working", { headline })} />);
    const chip = screen.getByRole("img", { name: `working: ${headline}` });
    expect(chip.getAttribute("title")).toBe(headline);
    const headlineSpan = screen.getByText(headline);
    expect(headlineSpan.style.textOverflow).toBe("ellipsis");
    expect(headlineSpan.style.whiteSpace).toBe("nowrap");
  });

  it("shows progress as done/total only when there is work to count", () => {
    render(
      <>
        <SessionCardChip card={card("working", { headline: "h", progress: { done: 3, total: 7 } })} />
        <SessionCardChip card={card("working", { headline: "h2", progress: { done: 0, total: 0 } })} />
        <SessionCardChip card={card("working", { headline: "h3" })} />
      </>,
    );
    expect(screen.getByText("3/7")).toBeTruthy();
    expect(screen.queryByText("0/0")).toBeNull();
  });

  it("summarises state, progress and headline in aria-label", () => {
    render(<SessionCardChip card={card("working", { headline: "Ship it", progress: { done: 1, total: 2 } })} />);
    expect(screen.getByRole("img", { name: "working 1/2: Ship it" })).toBeTruthy();
  });

  it("puts the blocked text in the tooltip of the blocked-on label", () => {
    render(<SessionCardChip card={card("blocked", { blockedOn: { kind: "session", ref: "s1", text: "waiting on bridge rebuild" } })} />);
    const label = screen.getByText("blocked on session");
    expect(label.getAttribute("title")).toBe("waiting on bridge rebuild");
  });

  it("renders nothing when card is undefined", () => {
    const { container } = render(<SessionCardChip />);
    expect(container.childElementCount).toBe(0);
  });

  it("omits the headline in compact mode", () => {
    render(<SessionCardChip card={card("working", { headline: "visible?" })} compact />);
    expect(screen.queryByText("visible?")).toBeNull();
    expect(screen.getByText("working")).toBeTruthy();
  });
});

describe("rollupChildCards", () => {
  function session(id: string, parentId?: string, state?: SessionCard["state"]): Session {
    return {
      id,
      name: id,
      status: "running",
      bridgeId: "b1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...(parentId ? { parentSessionId: parentId } : {}),
      ...(state ? { card: card(state, { headline: state }) } : {}),
    };
  }

  it("counts children by card state in contract order and omits zero counts", () => {
    const sessions = [
      session("root"),
      session("c1", "root", "working"),
      session("c2", "root", "working"),
      session("c3", "root", "working"),
      session("c4", "root", "working"),
      session("c5", "root", "working"),
      session("c6", "root", "blocked"),
      session("c7", "root", "done"),
      session("c8", "root", "done"),
      session("c9", "root", "failed"),
    ];
    expect(rollupChildCards(sessions, "root")).toEqual([
      { state: "working", count: 5 },
      { state: "blocked", count: 1 },
      { state: "done", count: 2 },
      { state: "failed", count: 1 },
    ]);
  });

  it("ignores sessions without a card, other parents, and the parent itself", () => {
    const sessions = [
      session("root", undefined, "done"), // parent's own card must not count in its rollup
      session("other-root"),
      session("c1", "root"),
      session("c2", "other-root", "done"),
    ];
    expect(rollupChildCards(sessions, "root")).toEqual([]);
  });

  it("formats the rollup line the way the list renders it", () => {
    expect(formatCardRollup([
      { state: "working", count: 5 },
      { state: "blocked", count: 1 },
      { state: "done", count: 2 },
    ])).toBe("5 working · 1 blocked · 2 done");
    expect(formatCardRollup(rollupChildCards([], "root"))).toBe("");
    expect(cardStateLabel("waiting_review")).toBe("waiting review");
  });
});
