// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import { PullRequestReview, reviewDiffSections } from "./PullRequestReview";
vi.mock("@/hooks/usePullRequestReview", () => ({ usePullRequestReview: () => ({ state: { kind: "ready", metadata: { title: "<img src=x onerror=alert(1)>", body: "<script>bad()</script>", author: "alice", state: "open", baseRef: "main", headRef: "branch", changedFiles: 1, additions: 1, deletions: 0, fetchedAt: "2026-11-01T00:00:00.000Z" }, diff: "diff --git a/file b/file\n+<svg onload=bad()>\n" }, refresh: vi.fn() }) }));
afterEach(cleanup);
it("renders untrusted metadata and patch as inert text", () => {
  const session: Session = { id: "one", bridgeId: "bridge", name: "one", status: "running", createdAt: "", updatedAt: "", pullRequestUrl: "https://github.com/owner/repo/pull/12" };
  const { container } = render(<PullRequestReview session={session} client={null} userId="user" visible readable securityGeneration={0} sendCommand={vi.fn()} onClose={vi.fn()} expanded={false} onExpand={vi.fn()} />);
  expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  expect(screen.getByText("<script>bad()</script>")).toBeTruthy();
  expect(container.querySelector("img,script,svg")).toBeNull();
  expect(container.textContent).toContain("+<svg onload=bad()>");
  expect(screen.getByText(/Cached PR status · commit unverified/)).toBeTruthy();
});
it("falls back to raw text for ambiguous boundaries and never loses bytes", () => {
  expect(reviewDiffSections("diff --git a/a b/a\n+x\ndiff --git a/b b/b\n-y\n")?.map(x => x.text).join("")).toBe("diff --git a/a b/a\n+x\ndiff --git a/b b/b\n-y\n");
  expect(reviewDiffSections("diff --git a/space name b/space name\n+x\n")).toBeNull();
  expect(reviewDiffSections("unexpected prefix\ndiff --git a/a b/a\n+x\n")).toBeNull();
});
