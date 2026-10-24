// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import { PullRequestLink } from "./PullRequestLink";
import { SessionList } from "./SessionList";
import { Terminal } from "./Terminal";

const prUrl = "https://github.com/Org/repo/pull/123";
const description = `PR #123 in Org/repo: ${prUrl}`;
const session: Session = {
  id: "target", bridgeId: "bridge", name: "Review migration", status: "running",
  createdAt: "2026-10-23T12:00:00Z", updatedAt: "2026-10-23T12:00:00Z", pullRequestUrl: prUrl,
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("session PR destinations", () => {
  it("renders the real terminal header link with repository context and safe new-tab attributes", () => {
    // Static rendering exercises the real header without starting a terminal,
    // browser socket, or xterm's canvas renderer.
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(createElement(Terminal, {
      transport: null, sessionId: session.id, bridgeId: session.bridgeId,
      isRunning: true, sessionName: session.name, pullRequestUrl: prUrl,
    }));
    const link = within(container).getByRole("link", { name: description });
    expect(link.textContent).toBe("PR #123");
    expect(link.getAttribute("href")).toBe(prUrl);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")?.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    expect(link.style.minHeight).toBe("44px");
    expect(link.style.minWidth).toBe("44px");
    expect(link.className).toContain("focus-visible:outline-2");
    expect(within(container).getByText(session.name)).toBeTruthy();
  });

  it("shows a noninteractive sidebar badge and keeps row selection", () => {
    const onSelectSession = vi.fn();
    const { container } = render(createElement(SessionList, {
      sessions: [session], bridges: [], bridgeOrder: ["bridge"], selectedSessionId: null, onSelectSession,
    }));
    const original = container.querySelector<HTMLButtonElement>('button[draggable="true"]')!;
    const badge = within(original).getByText("PR #123", { exact: true }).parentElement!;
    expect(badge.tagName).toBe("SPAN");
    expect(badge.title).toBe(description);
    expect(within(original).getByText(description).className).toBe("sr-only");
    expect(badge.getAttribute("tabindex")).toBeNull();
    expect(badge.getAttribute("role")).toBeNull();
    expect(original.querySelector("a, button")).toBeNull();
    expect(within(original).getByText(session.name)).toBeTruthy();
    fireEvent.click(badge);
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith(session.id);
  });

  it("removes replaced and cleared header destinations", () => {
    const view = render(createElement(PullRequestLink, { url: prUrl }));
    expect(screen.getByRole("link").getAttribute("href")).toBe(prUrl);
    view.rerender(createElement(PullRequestLink, { url: "https://github.com/Org/other/pull/456" }));
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://github.com/Org/other/pull/456");
    expect(screen.queryByText("PR #123")).toBeNull();
    view.rerender(createElement(PullRequestLink));
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each(["javascript:alert(1)", "https://github.com.evil.test/Org/repo/pull/123", '<img src=x onerror="alert(1)">'])("does not render unsafe PR metadata %s", url => {
    const { container } = render(createElement(PullRequestLink, { url }));
    expect(container.childElementCount).toBe(0);
    expect(container.querySelector("a, img, script")).toBeNull();
  });

  it("keeps malformed-metadata sessions selectable without an unsafe sidebar link", () => {
    const onSelectSession = vi.fn();
    const { container } = render(createElement(SessionList, {
      sessions: [{ ...session, pullRequestUrl: "javascript:alert(1)" }], bridges: [],
      bridgeOrder: ["bridge"], selectedSessionId: null, onSelectSession,
    }));
    expect(container.querySelector("a")).toBeNull();
    fireEvent.click(screen.getByText(session.name));
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(screen.queryByText("PR #123")).toBeNull();
  });
});
