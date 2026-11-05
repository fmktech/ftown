// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import type { ReviewState } from "@/lib/pr-review-types";
import { PullRequestReview } from "./PullRequestReview";

const hook = vi.hoisted(() => ({ state: null as unknown, refresh: null as unknown }));
vi.mock("@/hooks/usePullRequestReview", () => ({ usePullRequestReview: () => ({ state: hook.state, refresh: hook.refresh }) }));

const PR_URL = "https://github.com/owner/repo/pull/12";
const DIFF = "diff --git a/example.txt b/example.txt\nindex 1111111..2222222 100644\n--- a/example.txt\n+++ b/example.txt\n@@ -1,1 +1,1 @@\n-old\n+<svg onload=bad()>\n";
const metadata = { url: PR_URL, title: "<img src=x onerror=alert(1)>", body: "<script>bad()</script>", author: "alice", state: "open" as const, baseRef: "main", headRef: "branch", baseOid: "a".repeat(40), headOid: "b".repeat(40), additions: 1, deletions: 1, changedFiles: 7, fetchedAt: "2026-11-01T00:00:00.000Z" };
const ready = (over: Partial<Extract<ReviewState, { kind: "ready" }>> = {}, meta: Partial<typeof metadata> = {}): ReviewState => ({ kind: "ready", metadata: { ...metadata, ...meta }, diff: DIFF, refreshing: false, refreshFailed: null, ...over });
const session: Session = { id: "one", bridgeId: "bridge", name: "one", status: "running", createdAt: "", updatedAt: "", pullRequestUrl: PR_URL };
const renderPanel = () => render(<PullRequestReview session={session} client={null} userId="user" visible readable securityGeneration={0} sendCommand={vi.fn()} onClose={vi.fn()} expanded={false} onExpand={vi.fn()} />);

beforeEach(() => { hook.state = ready(); hook.refresh = vi.fn(); });
afterEach(cleanup);

it("keeps the panel landmark and root class", () => {
  const { container } = renderPanel();
  const panel = screen.getByRole("tabpanel", { name: "PR review" });
  expect(panel.id).toBe("session-review-panel");
  expect(panel.classList.contains("pr-review-root")).toBe(true);
  expect(container.querySelector("section")).toBe(panel);
});

it("renders untrusted metadata and patch as inert text", () => {
  const { container } = renderPanel();
  expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  expect(container.textContent).toContain("+<svg onload=bad()>");
  fireEvent.click(screen.getByRole("tab", { name: /Description/ }));
  expect(screen.getByText("<script>bad()</script>")).toBeTruthy();
  expect(container.querySelector("img,script,svg")).toBeNull();
  expect(screen.queryByText(/Cached PR status/)).toBeNull();
});

it("shows the parsed file count on the Files changed tab and defaults to it", () => {
  const { container } = renderPanel();
  const tab = screen.getByRole("tab", { name: /Files changed/ });
  expect(tab.getAttribute("aria-selected")).toBe("true");
  expect(tab.querySelector(".pr-review-count")?.textContent).toBe("1");
  expect(container.querySelector(".pr-review-main")?.getAttribute("aria-labelledby")).toBe("pr-review-tab-files");
});

it("shows the description body, or a note when it is blank", () => {
  const { container, rerender } = renderPanel();
  fireEvent.click(screen.getByRole("tab", { name: "Description" }));
  expect(container.querySelector(".pr-review-description .pr-review-body")?.textContent).toBe("<script>bad()</script>");
  hook.state = ready({}, { body: "  \n " });
  rerender(<PullRequestReview session={session} client={null} userId="user" visible readable securityGeneration={0} sendCommand={vi.fn()} onClose={vi.fn()} expanded={false} onExpand={vi.fn()} />);
  expect(container.querySelector(".pr-review-body")).toBeNull();
  expect(screen.getByText("No description provided.").classList.contains("pr-review-empty-note")).toBe(true);
});

it("switches sections with the arrow keys", () => {
  renderPanel();
  const files = screen.getByRole("tab", { name: /Files changed/ });
  const description = screen.getByRole("tab", { name: "Description" });
  fireEvent.keyDown(files, { key: "ArrowRight" });
  expect(description.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(description);
  fireEvent.keyDown(description, { key: "ArrowLeft" });
  expect(files.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(files);
});

it("falls back to raw text with diff line classes when the diff cannot be parsed", () => {
  hook.state = ready({ diff: "junk before header\n+added\n-removed\n@@ -1 +1 @@\n context\n" });
  const { container } = renderPanel();
  expect(screen.getByText("This diff couldn't be parsed, so it's shown as raw text.").classList.contains("pr-review-raw-notice")).toBe(true);
  expect(container.querySelector(".pr-review-raw .pr-diff-add")?.textContent).toBe("+added\n");
  expect(container.querySelector(".pr-review-raw .pr-diff-delete")?.textContent).toBe("-removed\n");
  expect(container.querySelector(".pr-review-raw .pr-diff-hunk")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /Files changed/ }).querySelector(".pr-review-count")?.textContent).toBe("7");
});

it("shows a soft refresh failure banner whose Retry refreshes", () => {
  hook.state = ready({ refreshFailed: "timeout" });
  const { container } = renderPanel();
  const banner = container.querySelector(".pr-review-banner");
  expect(banner?.getAttribute("role")).toBe("status");
  expect(banner?.querySelector(".pr-review-banner-text")?.textContent).toMatch(/^Couldn't refresh: GitHub timed out\. Showing the version fetched .+\.$/);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(hook.refresh).toHaveBeenCalledTimes(1);
});

it("disables the refresh button while refreshing", () => {
  hook.state = ready({ refreshing: true });
  renderPanel();
  expect((screen.getByRole("button", { name: "Refresh PR review" }) as HTMLButtonElement).disabled).toBe(true);
});

it("renders the status view for non-ready states without tabs or banner", () => {
  hook.state = { kind: "unavailable", reason: "rate_limited" } satisfies ReviewState;
  const { container } = renderPanel();
  expect(screen.getByText("GitHub rate limit reached. Try again later.")).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(container.querySelector(".pr-review-banner")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(hook.refresh).toHaveBeenCalledTimes(1);
});

it("links the header to the pull request on GitHub", () => {
  renderPanel();
  const link = screen.getByRole("link", { name: /Open on GitHub/ });
  expect(link.getAttribute("href")).toBe(PR_URL);
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});
