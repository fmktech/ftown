// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEW_LABELS, REVIEW_STATE_COPY, REVIEW_UNAVAILABLE_COPY } from "@/lib/pr-review-types";
import type { ReviewNonReadyState } from "@/lib/pr-review-types";
import { ReviewStatusView } from "./ReviewStatusView";

afterEach(cleanup);

const URL = "https://github.com/owner/repo/pull/12";
const plainKinds = ["no_link", "old_bridge", "offline", "error"] as const;
const reasons = Object.keys(REVIEW_UNAVAILABLE_COPY) as Array<keyof typeof REVIEW_UNAVAILABLE_COPY>;

function renderView(state: ReviewNonReadyState, pullRequestUrl: string | null = URL, onRetry = vi.fn()) {
  const utils = render(<ReviewStatusView state={state} pullRequestUrl={pullRequestUrl} onRetry={onRetry} />);
  return { ...utils, onRetry };
}

describe("ReviewStatusView loading", () => {
  it("renders the skeleton with role=status, aria-busy and sr-only text", () => {
    const { container } = renderView({ kind: "loading" });
    const skeleton = container.querySelector(".pr-review-skeleton");
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("role")).toBe("status");
    expect(skeleton?.getAttribute("aria-busy")).toBe("true");
    expect(skeleton?.querySelector(".pr-review-sr-only")?.textContent).toBe(REVIEW_STATE_COPY.loading.title);
    expect(screen.getByText(REVIEW_STATE_COPY.loading.title)).toBeTruthy();
  });

  it("marks skeleton blocks aria-hidden with the catalogued shape", () => {
    const { container } = renderView({ kind: "loading" });
    expect(container.querySelector(".pr-review-skel-line.is-title")).not.toBeNull();
    expect(container.querySelector(".pr-review-skel-line.is-short")).not.toBeNull();
    expect(container.querySelectorAll(".pr-review-skel-card")).toHaveLength(3);
    expect(container.querySelectorAll(".pr-review-skel-card > .pr-review-skel-line")).toHaveLength(12);
    const blocks = container.querySelectorAll(".pr-review-skeleton > div");
    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      expect(block.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("shows no retry button and no view-on-GitHub link while loading", () => {
    const { container } = renderView({ kind: "loading" });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(REVIEW_LABELS.viewOnGitHub)).toBeNull();
    expect(container.querySelector(".pr-review-empty-actions")).toBeNull();
  });
});

describe("ReviewStatusView state copy", () => {
  it.each(plainKinds)("renders title, detail and aria-hidden glyph for %s", (kind) => {
    const copy = REVIEW_STATE_COPY[kind];
    const { container } = renderView({ kind });
    const root = container.querySelector(".pr-review-empty");
    expect(root?.getAttribute("role")).toBe("status");
    expect(container.querySelector(".pr-review-empty-title")?.textContent).toBe(copy.title);
    expect(container.querySelector(".pr-review-empty-detail")?.textContent).toBe(copy.detail.replace(/`/g, ""));
    const glyph = container.querySelector(".pr-review-empty-glyph");
    expect(glyph?.textContent).toBe(copy.glyph);
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
  });

  it.each(reasons)("renders title and detail for unavailable reason %s", (reason) => {
    const copy = REVIEW_UNAVAILABLE_COPY[reason];
    const { container } = renderView({ kind: "unavailable", reason });
    expect(container.querySelector(".pr-review-empty-title")?.textContent).toBe(copy.title);
    expect(container.querySelector(".pr-review-empty-detail")?.textContent).toBe(copy.detail.replace(/`/g, ""));
    expect(container.querySelector(".pr-review-empty-glyph")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders backtick-delimited text as <code> for the gh auth login hint", () => {
    const { container } = renderView({ kind: "unavailable", reason: "unauthenticated" });
    const detail = container.querySelector(".pr-review-empty-detail");
    const code = detail?.querySelector("code");
    expect(code?.textContent).toBe("gh auth login");
    expect(detail?.textContent).toBe("Run gh auth login on the bridge machine, then retry.");
  });

  it("renders plain text without <code> when no backticks are present", () => {
    const { container } = renderView({ kind: "error" });
    expect(container.querySelector(".pr-review-empty-detail code")).toBeNull();
  });
});

describe("ReviewStatusView retry visibility", () => {
  const retryCases: Array<[string, ReviewNonReadyState, boolean]> = [
    ["error", { kind: "error" }, true],
    ["offline", { kind: "offline" }, false],
    ["no_link", { kind: "no_link" }, false],
    ["old_bridge", { kind: "old_bridge" }, false],
    ["unavailable:unlinked", { kind: "unavailable", reason: "unlinked" }, false],
    ...reasons
      .filter((reason) => reason !== "unlinked")
      .map((reason): [string, ReviewNonReadyState, boolean] => [`unavailable:${reason}`, { kind: "unavailable", reason }, true]),
  ];
  it.each(retryCases)("retry button for %s is visible=%s", (_label, state, visible) => {
    renderView(state);
    const retry = screen.queryByRole("button", { name: "Retry" });
    if (visible) {
      expect(retry).not.toBeNull();
      expect(retry?.className).toContain("btn-ghost");
      expect(retry?.className).toContain("pr-review-button");
    } else {
      expect(retry).toBeNull();
    }
  });

  it("calls onRetry when Retry is clicked", () => {
    const { onRetry } = renderView({ kind: "error" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("omits .pr-review-empty-actions when there are no actions", () => {
    const { container } = renderView({ kind: "offline" }, null);
    expect(container.querySelector(".pr-review-empty-actions")).toBeNull();
  });
});

describe("ReviewStatusView view-on-GitHub link", () => {
  it("shows the link with href, target and rel for error with a URL", () => {
    renderView({ kind: "error" }, URL);
    const link = screen.getByRole("link", { name: REVIEW_LABELS.viewOnGitHub });
    expect(link.getAttribute("href")).toBe(URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.className).toContain("pr-review-link");
  });

  it("shows the link for an unavailable reason other than unlinked", () => {
    renderView({ kind: "unavailable", reason: "timeout" }, URL);
    expect(screen.getByRole("link", { name: REVIEW_LABELS.viewOnGitHub }).getAttribute("href")).toBe(URL);
  });

  it("hides the link when pullRequestUrl is null", () => {
    renderView({ kind: "error" }, null);
    expect(screen.queryByRole("link", { name: REVIEW_LABELS.viewOnGitHub })).toBeNull();
  });

  it("hides the link for no_link even with a URL", () => {
    renderView({ kind: "no_link" }, URL);
    expect(screen.queryByRole("link", { name: REVIEW_LABELS.viewOnGitHub })).toBeNull();
  });

  it("hides the link for unavailable:unlinked even with a URL", () => {
    renderView({ kind: "unavailable", reason: "unlinked" }, URL);
    expect(screen.queryByRole("link", { name: REVIEW_LABELS.viewOnGitHub })).toBeNull();
  });

  it("keeps Retry and the link together in .pr-review-empty-actions", () => {
    const { container } = renderView({ kind: "error" }, URL);
    const actions = container.querySelector(".pr-review-empty-actions");
    expect(actions?.querySelector("button")?.textContent).toBe("Retry");
    expect(actions?.querySelector("a")?.textContent).toContain(REVIEW_LABELS.viewOnGitHub);
  });
});

describe("ReviewStatusView untrusted text", () => {
  it("renders hostile URL text as an inert attribute without creating elements", () => {
    const hostile = `${URL}<img src=x onerror=bad()><svg onload=bad()>`;
    const { container } = renderView({ kind: "error" }, hostile);
    expect(container.querySelector("img,script,svg")).toBeNull();
    expect(screen.getByRole("link", { name: REVIEW_LABELS.viewOnGitHub }).getAttribute("href")).toBe(hostile);
  });
});
