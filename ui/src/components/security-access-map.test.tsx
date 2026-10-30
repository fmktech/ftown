// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeviceDisplayNameEditor } from "./DeviceDisplayNameEditor";
import { SecurityAccessMap, type SecurityAccessMapProps } from "./SecurityAccessMap";
import { bridgeConnectionLock } from "./SecurityLockIcon";
import { SessionList } from "./SessionList";
import { deriveCurrentComputerIds } from "./Dashboard";
import type { SecurityBridge } from "./SecurityPanel";
import type { TerminalTransportMode } from "@/lib/direct-transport/contract";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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
it("labels computer scope explicitly while keeping default account authority separate", () => {
  const data = props(); const view = render(<SecurityAccessMap {...data} scope="computer" />);
  expect(screen.getByRole("heading", { name: "Computer access" })).toBeTruthy();
  expect(screen.getByRole("list", { name: "Approved devices" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Account access" })).toBeNull();
  expect(screen.getByText(/Approvals apply only to this computer/)).toBeTruthy();
  view.rerender(<SecurityAccessMap {...data} />);
  expect(screen.getByRole("heading", { name: "Account access" })).toBeTruthy();
  expect(screen.getByRole("list", { name: "Account devices" })).toBeTruthy();
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

it("embeds toolbar and selected controls as siblings of the selector, with independent current and selection markers", () => {
  const data = props(); const action = vi.fn(); data.bridges = data.bridges.map(node => ({ ...node, current: node.id === "independent" }));
  const view = render(<SecurityAccessMap {...data} toolbar={<button type="button">Refresh preview</button>}
    selectedDetails={<button type="button" onClick={action}>Remove preview browser</button>} />);
  const remove = screen.getByRole("button", { name: "Remove preview browser" });
  expect(remove.closest("[data-access-card]")?.getAttribute("data-access-card")).toBe("browser:self-browser");
  expect(view.container.querySelector("button button")).toBeNull();
  fireEvent.click(remove); expect(action).toHaveBeenCalledOnce(); expect(data.onSelect).not.toHaveBeenCalled();
  expect(screen.getByText("This computer")).toBeTruthy();
  const current = view.container.querySelector('[data-current-device="bridge"]');
  expect(current?.getAttribute("data-access-card")).toBe("bridge:independent");
  expect(view.container.querySelector('[data-access-edge="bridge:independent"]')).toBeNull();
  expect(view.container.querySelector('[data-current-device="browser"]')?.getAttribute("data-access-card")).toBe("browser:self-browser");
  view.rerender(<SecurityAccessMap {...data} bridges={data.bridges.map(node => ({ ...node, current: false }))} />);
  expect(view.container.querySelector('[data-current-device="bridge"]')).toBeNull();
});

const localityBridges: SecurityBridge[] = ["local", "remote"].map(bridgeId => ({ bridgeId, label: bridgeId,
  security: { bridgeId, status: "ready", endpoint: null } }));
const localitySessions = [{ id: "local-session", bridgeId: "local" }, { id: "remote-session", bridgeId: "remote" }];
it.each(["local", "direct", "centrifugo", "connecting"] as const)("marks only verified same-machine transport mode %s", mode => {
  const transport = { getMode: (id: string): TerminalTransportMode => id === "local-session" ? mode : "direct" };
  expect([...deriveCurrentComputerIds({ localMode: false, connectionStatus: "connected", sessions: localitySessions, transport, bridges: localityBridges })]).toEqual(mode === "local" ? ["local"] : []);
});
it("drops locality on mode, session removal, connection, or secure state changes and accepts a verified local controller", () => {
  let mode: TerminalTransportMode = "local";
  const data = { localMode: false, connectionStatus: "connected" as const, sessions: localitySessions, transport: { getMode: () => mode }, bridges: localityBridges };
  expect([...deriveCurrentComputerIds(data)]).toEqual(["local", "remote"]);
  mode = "direct"; expect([...deriveCurrentComputerIds(data)]).toEqual([]);
  mode = "local"; expect([...deriveCurrentComputerIds({ ...data, sessions: [] })]).toEqual([]);
  expect([...deriveCurrentComputerIds({ ...data, connectionStatus: "connecting" })]).toEqual([]);
  expect([...deriveCurrentComputerIds({ ...data, bridges: localityBridges.map(node => ({ ...node, security: { ...node.security, status: "offline" as const } })) })]).toEqual([]);
  expect([...deriveCurrentComputerIds({ ...data, transport: null, sessions: [], localMode: true, localBridgeId: "local" })]).toEqual(["local"]);
  expect([...deriveCurrentComputerIds({ ...data, transport: null, sessions: [], localMode: false, localBridgeId: "local" })]).toEqual([]);
});

it("reanchors connectors when inline card or hub expansion moves nodes without resizing the root", () => {
  const observed = new Set<Element>(); let notify!: (element: Element) => void;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { notify = element => { if (observed.has(element)) callback([], this as unknown as ResizeObserver); }; }
    observe(element: Element) { observed.add(element); }
    unobserve(element: Element) { observed.delete(element); }
    disconnect() { observed.clear(); }
  });
  const data = props();
  const view = render(<SecurityAccessMap {...data} selectedDetails={<button>Details action</button>} />);
  const hub = screen.getByRole("heading", { name: "Account access" }).parentElement!;
  const canvas = hub.parentElement!;
  const node = view.container.querySelector<HTMLButtonElement>('[data-access-node="alpha-browser-abcdef"]')!;
  let top = 80; let hubHeight = 60;
  vi.spyOn(canvas, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 900, 400));
  vi.spyOn(hub, "getBoundingClientRect").mockImplementation(() => new DOMRect(400, 100, 100, hubHeight));
  vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => new DOMRect(10, top, 200, 60));
  act(() => notify(canvas));
  const edge = view.container.querySelector('[data-access-edge="browser:alpha-browser-abcdef"]')!;
  const before = edge.getAttribute("d");
  // A preceding selected card expands; this button moves but keeps its size.
  top = 180; act(() => notify(node.parentElement!));
  expect(edge.getAttribute("d")).not.toBe(before);
  const afterCard = edge.getAttribute("d");
  hubHeight = 100; act(() => notify(hub));
  expect(edge.getAttribute("d")).not.toBe(afterCard);
});

it("preserves a deliberate generic browser nickname instead of replacing it", () => {
  const data = props(); data.browsers = [{ ...data.browsers[0], current: false, label: "This browser", customLabel: true }];
  render(<SecurityAccessMap {...data} />);
  expect(screen.getByRole("button", { name: /^Browser This browser:/ })).toBeTruthy();
});

it("keeps an inline browser editor separate from selection and preserves its draft", () => {
  const data = props(); const select = vi.fn();
  const renderName = (node: SecurityAccessMapProps["browsers"][number], label: string) => <DeviceDisplayNameEditor key={node.id} variant="inline" target={{ kind: "browser", id: node.id }} label={label} saving={false} error={null} setName={vi.fn()} />;
  const view = render(<SecurityAccessMap {...data} onSelect={select} renderBrowserName={renderName} />);
  const card = view.container.querySelector('[data-access-card="browser:self-browser"]')!;
  expect(card.querySelector("button button, button input")).toBeNull();
  const metadata = within(card as HTMLElement).getByText("Approved for your account"); expect(metadata.className).not.toContain("truncate");
  const pencil = screen.getByRole("button", { name: "Rename This browser" }); fireEvent.click(pencil);
  const input = screen.getByLabelText("Display name") as HTMLInputElement; fireEvent.change(input, { target: { value: "Draft" } });
  expect(select).not.toHaveBeenCalled();
  view.rerender(<SecurityAccessMap {...data} onSelect={select} renderBrowserName={renderName} selected={{ kind: "browser", id: data.browsers[1].id }} />);
  expect(input.value).toBe("Draft"); expect(card.querySelector("button input, button button")).toBeNull();
  fireEvent.keyDown(input, { key: "Escape" }); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename This browser" }));
  fireEvent.click(screen.getByRole("button", { name: /^Browser This browser/ })); expect(select).toHaveBeenCalledExactlyOnceWith({ kind: "browser", id: "self-browser" });
});
