// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecurityAccessMap, type SecurityAccessMapProps } from "./SecurityAccessMap";
import { bridgeConnectionLock } from "./SecurityLockIcon";
import { SessionList } from "./SessionList";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => localStorage.clear());
const props = (): SecurityAccessMapProps => ({
  browsers: [
    { id: "self-browser", label: "Browser", current: true, accessText: "Approved for your account", lockState: "secured", edge: "current" },
    { id: "alpha-browser-abcdef", label: "Browser", current: false, accessText: "Approved for your account", lockState: "secured", edge: "current" },
    { id: "beta-browser-abcdef", label: "Browser", current: false, accessText: "Approved for your account", lockState: "secured", edge: "current" },
  ], bridges: [
    { id: "shared", label: "Foads-MacBook-Air.local", accessText: "Shared with your approved browsers", connectionText: "Connected", lockState: "secured", edge: "current" },
    { id: "independent", label: "Foad-Kesheh-FNN4KX5FHY.local", accessText: "Only separately approved browsers", connectionText: "Connected", lockState: "approval_needed", edge: "none" },
  ], account: { statusText: "Verified account approvals", lockState: "secured" }, selected: { kind: "browser", id: "self-browser" }, onSelect: vi.fn(),
});
it("draws only supplied access edges, distinguishes generic browsers and uses selectable native buttons", () => {
  const data = props(); const view = render(<SecurityAccessMap {...data} />);
  expect(view.container.querySelectorAll('[data-certainty="current"]')).toHaveLength(4);
  expect(view.container.querySelector('[data-access-edge="bridge:independent"]')).toBeNull();
  const browsers = screen.getAllByRole("button", { name: /^Browser / });
  expect(new Set(browsers.map(button => button.getAttribute("aria-label"))).size).toBe(3);
  expect(browsers[0].getAttribute("aria-pressed")).toBe("true");
  expect(browsers[1].textContent).not.toContain(data.browsers[1].id);
  expect(browsers[2].textContent).not.toContain(data.browsers[2].id);
  for (const button of browsers) expect(button.tagName).toBe("BUTTON");
  browsers[1].focus(); fireEvent.click(browsers[1]);
  expect(data.onSelect).toHaveBeenCalledExactlyOnceWith({ kind: "browser", id: data.browsers[1].id });
  view.rerender(<SecurityAccessMap {...data} selected={{ kind: "browser", id: data.browsers[1].id }} />);
  expect(browsers[1].getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText(/Lines show access, not network connections/)).toBeTruthy();
});
it("keeps historical links dashed and never invents an edge from a closed lock or connection text", () => {
  const data = props(); data.browsers = [];
  data.bridges = [{ ...data.bridges[0], accessText: "Previously shared · reconnect to verify", connectionText: "Offline", lockState: "unknown", edge: "historical" },
    { ...data.bridges[1], lockState: "secured", edge: "none" }];
  const view = render(<SecurityAccessMap {...data} />);
  expect(view.container.querySelectorAll('[data-certainty="current"]')).toHaveLength(0);
  expect(view.container.querySelector('[data-certainty="historical"]')?.getAttribute("stroke-dasharray")).toBe("4 4");
  expect(view.container.querySelector('[data-access-edge="bridge:independent"]')).toBeNull();
  expect(screen.getByText("Dashed: last verified, reconnect to check")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Computer Foad-Kesheh/ }));
  expect(data.onSelect).toHaveBeenCalledExactlyOnceWith({ kind: "bridge", id: "independent" });
});
it.each([
  ["ready", "secured", "Encrypted connection"], ["unpaired", "approval_needed", "Approval required"],
  ["revoked", "approval_needed", "Access revoked"], ["key_changed", "approval_needed", "Computer key changed"],
  ["upgrade_required", "approval_needed", "Computer upgrade required"], ["offline", "unknown", "Computer offline — connection not verified"],
  ["connecting", "unknown", "Checking encrypted connection"], [undefined, "unknown", "Connection status unknown"],
] as const)("uses connection evidence only for sidebar lock %s", (status, state, title) => {
  expect(bridgeConnectionLock(status)).toEqual({ state, title });
});
it("passes actual sidebar state independently of bridge presence and preserves the security navigation action", () => {
  const open = vi.fn();
  const data = { sessions: [], bridges: [{ clientId: "client", bridgeId: "bridge", hostname: "alpha", connectedAt: "2026-10-26T12:00:00Z" }],
    bridgeOrder: ["bridge"], selectedSessionId: null, onSelectSession: vi.fn(), onOpenSecurity: open };
  const view = render(<SessionList {...data} />);
  const button = screen.getByRole("button", { name: "Security log for alpha" });
  expect(button.title).toContain("Connection status unknown");
  expect(button.querySelector("svg")?.getAttribute("data-lock-state")).toBe("unknown");
  view.rerender(<SessionList {...data} bridgeSecurityStates={new Map([["bridge", "unpaired"]])} />);
  expect(button.title).toContain("Approval required");
  expect(button.querySelector("svg")?.getAttribute("data-lock-state")).toBe("approval_needed");
  view.rerender(<SessionList {...data} bridgeSecurityStates={new Map([["bridge", "ready"]])} />);
  expect(button.title).toContain("Encrypted connection");
  expect(button.querySelector("svg")?.getAttribute("data-lock-state")).toBe("secured");
  expect(button.style.color).toBe("var(--text-muted)");
  fireEvent.click(button); expect(open).toHaveBeenCalledExactlyOnceWith("bridge");
  expect(data.onSelectSession).not.toHaveBeenCalled();
});
