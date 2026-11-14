// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Session, SessionCard } from "@/types";
import {
  SessionCardChip,
  cardStateLabel,
  cardStateStyle,
  formatCardRollup,
  rollupChildCards,
} from "./SessionCardChip";

afterEach(cleanup);

function card(state: SessionCard["state"], extra: Partial<SessionCard> = {}): SessionCard {
  return { state, headline: "", updatedAt: "2026-01-01T00:00:00.000Z", ...extra };
}

describe("SessionCardChip", () => {
  it("renders each state as a plain icon line with pairwise distinct colours", () => {
    render(
      <>
        <SessionCardChip card={card("working", { headline: "h" })} />
        <SessionCardChip card={card("blocked", { headline: "h", blockedOn: { kind: "human", text: "needs approval" } })} />
        <SessionCardChip card={card("waiting_review", { headline: "h" })} />
        <SessionCardChip card={card("done", { headline: "h" })} />
        <SessionCardChip card={card("failed", { headline: "h" })} />
      </>,
    );
    const icons: Record<SessionCard["state"], string> = {
      working: "▸",
      blocked: "⚠",
      waiting_review: "◷",
      done: "✓",
      failed: "✗",
    };
    for (const state of Object.keys(icons) as SessionCard["state"][]) {
      const chip = screen.getByRole("img", { name: `${state === "blocked" ? "blocked on human" : state === "waiting_review" ? "waiting review" : state}: h` });
      expect(chip.children[0].textContent).toBe(icons[state]);
    }
    expect(screen.getByText("working · h")).toBeTruthy();
    expect(screen.getByText("blocked on human: h")).toBeTruthy();
    expect(screen.getByText("waiting review · h")).toBeTruthy();
    expect(screen.getByText("done · h")).toBeTruthy();
    expect(screen.getByText("failed · h")).toBeTruthy();
    const fgColors = [
      screen.getByRole("img", { name: /^working: h$/ }),
      screen.getByRole("img", { name: /^blocked on human: h$/ }),
      screen.getByRole("img", { name: /^waiting review: h$/ }),
      screen.getByRole("img", { name: /^done: h$/ }),
      screen.getByRole("img", { name: /^failed: h$/ }),
    ].map((chip) => chip.style.color);
    expect(new Set(fgColors).size).toBe(5);
  });

  it("renders as a plain text line without pill styling", () => {
    render(<SessionCardChip card={card("working", { headline: "h" })} />);
    const chip = screen.getByRole("img", { name: "working: h" });
    expect(chip.style.border).toBe("");
    expect(chip.style.background).toBe("");
    expect(chip.style.fontSize).toBe("10px");
  });

  it("shows the full line truncated with the whole text as title", () => {
    const headline = "Fix the login redirect loop affecting signed-out users";
    render(<SessionCardChip card={card("working", { headline })} />);
    const chip = screen.getByRole("img", { name: `working: ${headline}` });
    expect(chip.getAttribute("title")).toBe(`working · ${headline}`);
    const textSpan = screen.getByText(`working · ${headline}`);
    expect(textSpan.style.textOverflow).toBe("ellipsis");
    expect(textSpan.style.whiteSpace).toBe("nowrap");
  });

  it("shows progress as done/total only when there is work to count", () => {
    render(
      <>
        <SessionCardChip card={card("working", { headline: "with progress", progress: { done: 3, total: 7 } })} />
        <SessionCardChip card={card("working", { headline: "no progress", progress: { done: 0, total: 0 } })} />
        <SessionCardChip card={card("working", { headline: "no count" })} />
      </>,
    );
    expect(screen.getByText("working 3/7 · with progress")).toBeTruthy();
    expect(screen.getByText("working · no progress")).toBeTruthy();
    expect(screen.getByText("working · no count")).toBeTruthy();
  });

  it("summarises state, progress and headline in aria-label", () => {
    render(<SessionCardChip card={card("working", { headline: "Ship it", progress: { done: 1, total: 2 } })} />);
    expect(screen.getByRole("img", { name: "working 1/2: Ship it" })).toBeTruthy();
  });

  it("puts the blocked-on text in the tooltip of the blocked line", () => {
    render(<SessionCardChip card={card("blocked", { blockedOn: { kind: "session", ref: "s1", text: "waiting on bridge rebuild" } })} />);
    const chip = screen.getByRole("img", { name: "blocked on session: waiting on bridge rebuild" });
    expect(chip.getAttribute("title")).toBe("blocked on session: waiting on bridge rebuild");
    expect(screen.getByText("blocked on session: waiting on bridge rebuild")).toBeTruthy();
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

it("hides progress on a done card", () => {
  render(<SessionCardChip card={card("done", { headline: "Finished", progress: { done: 3, total: 7 } })} />);
  expect(screen.getByText("done · Finished")).toBeTruthy();
  expect(screen.queryByText("done 3/7 · Finished")).toBeNull();
  expect(screen.getByRole("img", { name: "done: Finished" })).toBeTruthy();
});

it("exposes the glyph and colour token per card state", () => {
  expect(cardStateStyle("working")).toEqual({ icon: "▸", color: "var(--accent)" });
  expect(cardStateStyle("failed")).toEqual({ icon: "✗", color: "var(--status-error)" });
  expect(cardStateStyle("waiting_review").icon).toBe("◷");
});
