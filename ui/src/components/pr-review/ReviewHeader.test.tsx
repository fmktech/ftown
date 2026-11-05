// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrReviewMetadata } from "../../../../bridge/src/pull-request-review-protocol";
import type { PullRequestStatus } from "../../../../bridge/src/pull-request-status-protocol";
import type { PullRequestReference } from "@/lib/pull-request-url";
import { REVIEW_GLYPHS, REVIEW_LABELS, type ReviewHeaderProps } from "@/lib/pr-review-types";
import { ReviewHeader } from "./ReviewHeader";

afterEach(cleanup);

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const URL_PR = "https://github.com/owner/repo/pull/7";
const PR_REF: PullRequestReference = { url: URL_PR, repository: "owner/repo", number: 7 };
const META: PrReviewMetadata = {
  url: URL_PR,
  title: "Add thing",
  body: "",
  author: "alice",
  state: "open",
  baseRef: "main",
  headRef: "feature/x",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
  additions: 12,
  deletions: 3,
  changedFiles: 1,
  fetchedAt: new Date(NOW - 2 * 60_000).toISOString(),
};

function props(over: Partial<ReviewHeaderProps> = {}): ReviewHeaderProps {
  return {
    metadata: META,
    pullRequest: PR_REF,
    checks: undefined,
    refreshing: false,
    canRefresh: true,
    expanded: false,
    now: NOW,
    onRefresh: vi.fn(),
    onToggleExpand: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

function renderHeader(over: Partial<ReviewHeaderProps> = {}) {
  const p = props(over);
  const result = render(<ReviewHeader {...p} />);
  return { ...result, p };
}

function must(container: HTMLElement, selector: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`missing element: ${selector}`);
  return node;
}

describe("ReviewHeader minimal (metadata null)", () => {
  it("falls back to the PR number title and renders only actions", () => {
    const { container } = renderHeader({ metadata: null });
    expect(must(container, "h2.pr-review-title").textContent).toBe("Pull request #7");
    expect(must(container, "h2.pr-review-title").getAttribute("title")).toBe("Pull request #7");
    expect(container.querySelector(".pr-review-state")).toBeNull();
    expect(container.querySelector(".pr-review-number")).toBeNull();
    expect(container.querySelector(".pr-review-meta")).toBeNull();
    expect(container.querySelector(".pr-review-fetched")).toBeNull();
    expect(screen.getByRole("button", { name: REVIEW_LABELS.refresh })).toBeTruthy();
    expect(screen.getByRole("button", { name: REVIEW_LABELS.expand })).toBeTruthy();
    expect(screen.getByRole("button", { name: REVIEW_LABELS.close })).toBeTruthy();
  });

  it("uses the generic title when there is no metadata and no PR reference", () => {
    const { container } = renderHeader({ metadata: null, pullRequest: null });
    expect(must(container, "h2.pr-review-title").textContent).toBe("Pull request");
    expect(container.querySelector(".pr-review-link")).toBeNull();
    expect(container.querySelector(".pr-review-number")).toBeNull();
  });

  it("renders the GitHub link with safe target and rel", () => {
    const { container } = renderHeader({ metadata: null });
    const link = screen.getByRole("link", { name: /Open on GitHub/ });
    expect(link.getAttribute("href")).toBe(URL_PR);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const glyph = must(link, ".pr-review-glyph");
    expect(glyph.textContent).toBe(REVIEW_GLYPHS.external);
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".pr-review-link")).toBe(link);
  });

  it("hides the GitHub link when no PR reference is available", () => {
    const { container } = renderHeader({ metadata: null, pullRequest: null });
    expect(container.querySelector("a.pr-review-link")).toBeNull();
  });

  it("does not render the progress bar when not refreshing", () => {
    const { container } = renderHeader({ metadata: null });
    expect(container.querySelector(".pr-review-progress")).toBeNull();
  });
});

describe("ReviewHeader full (metadata present)", () => {
  it("renders state pill, title, number and author", () => {
    const { container } = renderHeader();
    const pill = must(container, "span.pr-review-state");
    expect(pill.textContent).toBe("Open");
    expect(pill.classList.contains("is-open")).toBe(true);
    const title = must(container, "h2.pr-review-title");
    expect(title.textContent).toBe("Add thing");
    expect(title.getAttribute("title")).toBe("Add thing");
    expect(must(container, "span.pr-review-number").textContent).toBe("#7");
    expect(must(container, "span.pr-review-author").textContent).toBe("@alice");
  });

  it.each([
    ["open", "Open"],
    ["merged", "Merged"],
    ["closed", "Closed"],
  ] as const)("state %s renders pill label %s with is-%s class", (state, label) => {
    const { container } = renderHeader({ metadata: { ...META, state } });
    const pill = must(container, "span.pr-review-state");
    expect(pill.textContent).toBe(label);
    expect(pill.classList.contains(`is-${state}`)).toBe(true);
  });

  it("renders head and base branches in order around the arrow", () => {
    const { container } = renderHeader();
    const branches = must(container, ".pr-review-branches");
    const codes = branches.querySelectorAll("code.pr-review-branch");
    expect(codes).toHaveLength(2);
    expect(codes[0]?.textContent).toBe("feature/x");
    expect(codes[1]?.textContent).toBe("main");
    expect(must(branches, ".pr-review-arrow").textContent).toBe(REVIEW_GLYPHS.arrow);
  });

  it("renders diffstat with U+2212 minus and locale-formatted counts", () => {
    const { container } = renderHeader({ metadata: { ...META, additions: 1234, deletions: 3 } });
    expect(must(container, ".pr-review-add").textContent).toBe(`+${(1234).toLocaleString()}`);
    expect(must(container, ".pr-review-del").textContent).toBe("−3");
    expect(must(container, ".pr-review-del").textContent).toContain("−");
  });

  it("renders a five-segment diff bar that matches diffBarSegments", () => {
    const { container } = renderHeader();
    const bar = must(container, ".pr-review-bar");
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    const segs = bar.querySelectorAll("span.pr-review-bar-seg");
    expect(segs).toHaveLength(5);
    // 12 additions / 3 deletions over 5 blocks: 4 add, 1 del, 0 neutral.
    expect(bar.querySelectorAll(".pr-review-bar-seg.is-add")).toHaveLength(4);
    expect(bar.querySelectorAll(".pr-review-bar-seg.is-del")).toHaveLength(1);
    expect(bar.querySelectorAll(".pr-review-bar-seg.is-neutral")).toHaveLength(0);
  });

  it("pluralises the file count", () => {
    const one = renderHeader({ metadata: { ...META, changedFiles: 1 } });
    expect(one.container.textContent).toContain("1 file");
    expect(one.container.textContent).not.toContain("1 files");
    cleanup();
    const three = renderHeader({ metadata: { ...META, changedFiles: 3 } });
    expect(three.container.textContent).toContain("3 files");
  });

  it("renders the fetched time relative to now with dateTime and local title", () => {
    const { container } = renderHeader();
    const time = must(container, "time.pr-review-fetched");
    expect(time.textContent).toBe("Fetched 2m ago");
    expect(time.getAttribute("dateTime")).toBe(META.fetchedAt);
    expect(time.getAttribute("title")).toBe(new Date(META.fetchedAt).toLocaleString());
  });

  it("omits the fetched time when fetchedAt is not a valid date", () => {
    const { container } = renderHeader({ metadata: { ...META, fetchedAt: "not-a-date" } });
    expect(container.querySelector("time.pr-review-fetched")).toBeNull();
  });
});

describe("ReviewHeader checks chip", () => {
  const checkedAt = "2026-11-03T11:00:00.000Z";
  const status = (over: Partial<PullRequestStatus>): PullRequestStatus => ({
    url: URL_PR,
    state: "passed",
    checkedAt,
    stale: false,
    ...over,
  });

  it.each([
    ["passed", "Checks passed", "is-passed"],
    ["failed", "Checks failing", "is-failed"],
    ["in_progress", "Checks running", "is-running"],
    ["unknown", "Checks unknown", "is-unknown"],
  ] as const)("state %s renders '%s' with %s", (state, label, cls) => {
    const { container } = renderHeader({ checks: status({ state }) });
    const chip = must(container, ".pr-review-checks");
    expect(chip.classList.contains(cls)).toBe(true);
    expect(chip.textContent).toContain(label);
  });

  it("renders 'Checks unknown' when checks is undefined", () => {
    const { container } = renderHeader({ checks: undefined });
    const chip = must(container, ".pr-review-checks");
    expect(chip.classList.contains("is-unknown")).toBe(true);
    expect(chip.textContent).toContain("Checks unknown");
  });

  it("renders no checks chip for merged or closed statuses", () => {
    const merged = renderHeader({ checks: status({ state: "merged" }) });
    expect(merged.container.querySelector(".pr-review-checks")).toBeNull();
    cleanup();
    const closed = renderHeader({ checks: status({ state: "closed" }) });
    expect(closed.container.querySelector(".pr-review-checks")).toBeNull();
  });

  it("appends ' · stale' when the status is stale", () => {
    const { container } = renderHeader({ checks: status({ state: "failed", stale: true }) });
    expect(must(container, ".pr-review-checks").textContent).toContain("Checks failing · stale");
  });

  it("sets the title to the checked time and the reason", () => {
    const { container } = renderHeader({ checks: status({ state: "unknown", reason: "rate_limited" }) });
    expect(must(container, ".pr-review-checks").getAttribute("title")).toBe(
      `Checked ${new Date(checkedAt).toLocaleString()} · rate limited`,
    );
  });

  it("sets the title to 'Not checked yet' when checkedAt is null", () => {
    const { container } = renderHeader({ checks: status({ state: "unknown", checkedAt: null }) });
    expect(must(container, ".pr-review-checks").getAttribute("title")).toBe("Not checked yet");
  });
});

describe("ReviewHeader progress and refresh", () => {
  it("shows the progress bar and spinning glyph only while refreshing", () => {
    const idle = renderHeader({ refreshing: false });
    expect(idle.container.querySelector(".pr-review-progress")).toBeNull();
    expect(idle.container.querySelector(".pr-review-glyph.is-spinning")).toBeNull();
    cleanup();

    const busy = renderHeader({ refreshing: true });
    const progress = must(busy.container, ".pr-review-progress");
    expect(progress.getAttribute("aria-hidden")).toBe("true");
    expect(must(busy.container, ".pr-review-glyph.is-spinning").textContent).toBe(REVIEW_GLYPHS.refresh);
  });

  it("disables refresh when canRefresh is false", () => {
    renderHeader({ canRefresh: false });
    const button = screen.getByRole("button", { name: REVIEW_LABELS.refresh });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables refresh while refreshing", () => {
    renderHeader({ canRefresh: true, refreshing: true });
    const button = screen.getByRole("button", { name: REVIEW_LABELS.refresh });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables refresh and calls onRefresh when clicked", () => {
    const { p } = renderHeader({ canRefresh: true, refreshing: false });
    const button = screen.getByRole("button", { name: REVIEW_LABELS.refresh });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("title")).toBe(REVIEW_LABELS.refresh);
    fireEvent.click(button);
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("ReviewHeader expand, close and callbacks", () => {
  it("shows the expand label and aria-pressed=false when collapsed", () => {
    renderHeader({ expanded: false });
    const button = screen.getByRole("button", { name: REVIEW_LABELS.expand });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("title")).toBe(REVIEW_LABELS.expand);
    expect(must(button, ".pr-review-glyph").textContent).toBe(REVIEW_GLYPHS.expand);
  });

  it("shows the collapse label and aria-pressed=true when expanded", () => {
    renderHeader({ expanded: true });
    const button = screen.getByRole("button", { name: REVIEW_LABELS.collapse });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("title")).toBe(REVIEW_LABELS.collapse);
    expect(must(button, ".pr-review-glyph").textContent).toBe(REVIEW_GLYPHS.collapse);
  });

  it("calls onToggleExpand when the expand button is clicked", () => {
    const { p } = renderHeader({ expanded: false });
    fireEvent.click(screen.getByRole("button", { name: REVIEW_LABELS.expand }));
    expect(p.onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the close button is clicked", () => {
    const { p } = renderHeader();
    const button = screen.getByRole("button", { name: REVIEW_LABELS.close });
    expect(button.getAttribute("title")).toBe(REVIEW_LABELS.close);
    expect(must(button, ".pr-review-glyph").textContent).toBe(REVIEW_GLYPHS.close);
    fireEvent.click(button);
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(p.onRefresh).not.toHaveBeenCalled();
  });
});

describe("ReviewHeader untrusted text", () => {
  it("renders hostile metadata and branch names as inert text", () => {
    const hostile: PrReviewMetadata = {
      ...META,
      title: "<img src=x onerror=alert(1)>",
      author: "<script>bad()</script>",
      headRef: "<svg onload=bad()>",
      baseRef: "main",
    };
    const { container } = renderHeader({ metadata: hostile });
    expect(container.querySelector("img,script,svg")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(screen.getByText("@<script>bad()</script>")).toBeTruthy();
    expect(screen.getByText("<svg onload=bad()>")).toBeTruthy();
  });
});
