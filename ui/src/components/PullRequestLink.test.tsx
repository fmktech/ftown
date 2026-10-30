// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PullRequestBadgePlaceholder, PullRequestLink } from "./PullRequestLink";
import { PullRequestStatusProvider } from "./PullRequestStatusProvider";
import type { PullRequestStatus } from "../../../bridge/src/pull-request-status-protocol";
const url = "https://github.com/Owner/Repo/pull/42";
afterEach(cleanup);
async function display(status?: Partial<PullRequestStatus>) {
  const send = vi.fn(async () => ({ requestId: "x", success: true, data: { bridgeId: "b", nextRefreshAt: new Date(Date.now() + 60_000).toISOString(), statuses: status ? [{ url, checkedAt: "2026-01-01T00:00:00Z", stale: false, ...status }] : [] } }));
  render(<PullRequestStatusProvider send={send} connected readyBridgeIds={["b"]} sessions={[{ id: "s", bridgeId: "b", pullRequestUrl: url }]}><PullRequestBadgePlaceholder url={url}/><PullRequestLink url={url} badge/><PullRequestLink url={url}/></PullRequestStatusProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
it.each([
  [undefined, null], [{ state: "unknown", checkedAt: null }, null], [{ state: "in_progress" }, "CI running"], [{ state: "failed" }, "CI failed"], [{ state: "passed" }, "CI passed"], [{ state: "merged" }, "Merged"], [{ state: "closed" }, "Closed"], [{ state: "unknown", reason: "no_checks" }, "No checks"], [{ state: "unknown", reason: "unavailable" }, "CI unavailable"],
] as [Partial<PullRequestStatus> | undefined, string | null][])("renders a compact icon and accessible status for %s", async (status, text) => {
  await display(status); const links = screen.getAllByRole("link");
  const placeholder = document.querySelector("[data-pull-request-placeholder]");
  for (const link of links) {
    expect(link.textContent).toBe("#42"); expect(link.getAttribute("href")).toBe(url); expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("aria-label")).toContain("Owner/Repo"); expect(link.getAttribute("title")).toBe(link.getAttribute("aria-label"));
    if (text) { expect(link.getAttribute("aria-label")).toContain(text); expect(link.getAttribute("aria-label")).toContain("Checked"); }
    const icon = link.querySelector("svg");
    expect(Boolean(icon)).toBe(Boolean(text));
    if (icon) { expect(icon.getAttribute("aria-hidden")).toBe("true"); expect(icon.getAttribute("width")).toBe("10"); expect(icon.getAttribute("height")).toBe("10"); expect(link.firstChild).toBe(icon); expect(icon.style.marginRight).toBe("4px"); }
    expect(link.innerHTML).toBe(placeholder?.innerHTML);
  }
  expect(placeholder?.textContent).toBe("#42"); expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
});
it("describes stale last-known state and checked time", async () => { await display({ state: "passed", stale: true, reason: "unavailable" }); expect(screen.getAllByRole("link")[0].getAttribute("title")).toContain("Last known CI passed; update unavailable"); expect(screen.getAllByRole("link")[0].getAttribute("aria-label")).toContain("Checked"); });
it("rejects unsafe URLs", () => { render(<PullRequestLink url="https://evil.example/a/b/pull/1" badge/>); expect(screen.queryByRole("link")).toBeNull(); });

it("describes age-expired cached state without claiming a failed update", async () => { await display({ state: "passed", stale: true }); expect(screen.getAllByRole("link")[0].getAttribute("title")).toContain("Last known CI passed; status may be out of date"); });

it("preserves the existing neutral accessible link description", async () => { await display({ state: "unknown", checkedAt: null }); for (const link of screen.getAllByRole("link")) expect(link.getAttribute("aria-label")).toBe(`PR #42 in Owner/Repo: ${url}`); });
