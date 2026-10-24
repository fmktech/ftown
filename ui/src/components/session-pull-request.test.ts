// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SessionUsage } from "@/types";
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

  it("shows a passive compact sidebar badge inside the original selection button", () => {
    const onSelectSession = vi.fn();
    const { container } = render(createElement(SessionList, {
      sessions: [session], bridges: [], bridgeOrder: ["bridge"], selectedSessionId: null, onSelectSession,
    }));
    const original = container.querySelector<HTMLButtonElement>('button[draggable="true"]')!;
    const wrapper = original.parentElement!;
    const badge = within(original).getByText("PR #123", { exact: true }).parentElement!;
    expect(wrapper.dataset.sessionRow).toBe(session.id);
    expect(badge.tagName).toBe("SPAN");
    expect(badge.title).toBe(description);
    expect(badge.getAttribute("tabindex")).toBeNull();
    expect(badge.getAttribute("role")).toBeNull();
    expect(within(badge).getByText(description).className).toBe("sr-only");
    expect(wrapper.querySelector("a")).toBeNull();
    expect(original.querySelector("a, button")).toBeNull();
    expect(original.draggable).toBe(true);
    expect(Number.parseFloat(original.style.minWidth)).toBe(0);
    expect(original.style.width).toBe("");
    expect(within(original).getByText(session.name)).toBeTruthy();
    fireEvent.click(badge);
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith(session.id);
  });

  it("opens the native PR menu action without selecting the session or clearing attention", () => {
    const onSelectSession = vi.fn();
    const { container } = render(createElement(SessionList, {
      sessions: [session, { ...session, id: "observer", name: "Observer", pullRequestUrl: undefined }],
      bridges: [], bridgeOrder: ["bridge"], selectedSessionId: "observer", onSelectSession,
      onStopSession: vi.fn(), onRemoveSession: vi.fn(),
      sessionActivity: new Map([[session.id, { activity: "idle" as const, attention: {
        type: "agent_needs_input" as const, title: "Review requested", message: "Please review", receivedAt: 1,
      } }]]),
    }));
    const original = container.querySelector<HTMLButtonElement>('button[draggable="true"]')!;
    const trigger = within(original).getByRole("button", { name: "Session actions" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = screen.getByRole("menu", { name: "Session actions" });
    const action = within(menu).getByRole("menuitem", { name: `Open pull request: ${description}` });
    expect(within(menu).getAllByRole("menuitem")[0]).toBe(action);
    expect(action.tagName).toBe("A");
    expect(action.getAttribute("href")).toBe(prUrl);
    expect(action.getAttribute("target")).toBe("_blank");
    expect(action.getAttribute("rel")).toBe("noopener noreferrer");
    expect(original.contains(action)).toBe(false);
    expect(onSelectSession).not.toHaveBeenCalled();
    // Stop navigation only at the test's browser boundary; E2E exercises the
    // native default action, which production intentionally never cancels.
    action.addEventListener("click", event => event.preventDefault());
    fireEvent.click(action);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("region", { name: "Needs attention" })).toBeTruthy();
    expect(onSelectSession).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: " " });
    expect(screen.getByRole("menu", { name: "Session actions" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("uses replaced metadata and omits the PR action after clearing", () => {
    const props = {
      sessions: [session], bridges: [], bridgeOrder: ["bridge"], selectedSessionId: null,
      onSelectSession: vi.fn(), onStopSession: vi.fn(), onRemoveSession: vi.fn(),
    };
    const view = render(createElement(SessionList, props));
    const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    openMenu();
    expect(screen.getByRole("menuitem", { name: /^Open pull request:/ }).getAttribute("href")).toBe(prUrl);
    fireEvent.keyDown(document, { key: "Escape" });
    view.rerender(createElement(SessionList, { ...props, sessions: [{ ...session, pullRequestUrl: "https://github.com/Org/repo/pull/456/?tab=files" }] }));
    openMenu();
    expect(screen.getByRole("menuitem", { name: /^Open pull request:/ }).getAttribute("href")).toBe("https://github.com/Org/repo/pull/456");
    fireEvent.keyDown(document, { key: "Escape" });
    view.rerender(createElement(SessionList, { ...props, sessions: [{ ...session, pullRequestUrl: undefined }] }));
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /^Open pull request:/ })).toBeNull();
    expect(screen.queryByText("PR #456", { exact: true })).toBeNull();
  });

  it("removes sidebar usage while retaining persisted usage in the terminal header", () => {
    const usage: SessionUsage = {
      inputTokens: 1200, outputTokens: 45, cacheReadTokens: 100, cacheWriteTokens: 0,
      totalTokens: 1345, models: [], harness: "codex", collectedAt: "2026-10-23T12:00:00Z",
    };
    const { container } = render(createElement(SessionList, {
      sessions: [{ ...session, usage }], bridges: [], bridgeOrder: ["bridge"],
      selectedSessionId: session.id, onSelectSession: () => {},
    }));
    expect(container.textContent).not.toContain("1.2K in");
    expect(container.querySelector('[title^="Input:"]')).toBeNull();
    const header = document.createElement("div");
    header.innerHTML = renderToStaticMarkup(createElement(Terminal, {
      transport: null, sessionId: session.id, bridgeId: session.bridgeId, isRunning: true,
      sessionName: session.name, pullRequestUrl: prUrl, persistedUsage: usage,
    }));
    expect(within(header).getByText("1.2K in · 45 out")).toBeTruthy();
    expect(header.querySelector('[title^="Input:"]')).not.toBeNull();
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

  it.each(["javascript:alert(1)", "https://github.com.evil.test/Org/repo/pull/123", ""])("omits unsafe PR menu actions and keeps selection for %s", pullRequestUrl => {
    const onSelectSession = vi.fn();
    const { container } = render(createElement(SessionList, {
      sessions: [{ ...session, pullRequestUrl }], bridges: [],
      bridgeOrder: ["bridge"], selectedSessionId: null, onSelectSession,
      onStopSession: vi.fn(), onRemoveSession: vi.fn(),
    }));
    expect(container.querySelector("a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.queryByRole("menuitem", { name: /^Open pull request:/ })).toBeNull();
    expect(onSelectSession).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByText(session.name));
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(screen.queryByText("PR #123")).toBeNull();
  });
});
