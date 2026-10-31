// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import { Dashboard } from "./Dashboard";
import { buildBridgeCommand } from "@/lib/bridge-command";
import type { MessageClient } from "@/lib/message-client";
import type { ReactNode } from "react";
import { useBridgeUpdates } from "@/hooks/useBridgeUpdates";

const state = vi.hoisted(() => ({
  sessions: [] as Session[],
  pending: [] as Array<{ status: string }>,
  bridges: [{ clientId: "client-a", bridgeId: "bridge-a", hostname: "alpha", connectedAt: "2026-10-16T00:00:00Z" }],
  activity: new Map<string, SessionActivity>(),
  createSession: vi.fn().mockResolvedValue(undefined),
  stopSession: vi.fn(),
  retrySession: vi.fn(),
  removeSession: vi.fn(),
  bridgeExec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  clearSessionAttention: vi.fn(),
  rpcCommands: [] as string[],
}));

vi.mock("@/hooks/usePendingApprovals", () => ({ usePendingApprovals: () => ({ client: null, snapshot: { inbox: state.pending } }) }));
vi.mock("@/hooks/useSessions", () => ({ useSessions: () => ({
  sessions: state.sessions, createSession: state.createSession, stopSession: state.stopSession,
  retrySession: state.retrySession, removeSession: state.removeSession,
  renameSession: vi.fn(), setSessionParent: vi.fn(), refreshSessions: vi.fn(),
}) }));
vi.mock("@/hooks/useBridgeRpc", () => ({ useBridgeRpc: () => ({ bridgeExec: state.bridgeExec,
  sendCommand: vi.fn().mockImplementation(async command => { state.rpcCommands.push(command.type); return { success: true, data: { sessionId: "ordinary", attention: null, sequence: 0 } }; }),
  onSubscribed: () => () => {},
}) }));
vi.mock("@/hooks/useBridges", () => ({ useBridges: () => ({ bridges: state.bridges, hasBridges: true, prepareLocalAccess: vi.fn() }) }));
vi.mock("@/hooks/useAllSessionEvents", () => ({ useAllSessionEvents: () => ({
  sessionActivity: state.activity, markSessionIdle: vi.fn(), clearSessionAttention: state.clearSessionAttention,
}) }));
vi.mock("./Terminal", () => ({ Terminal: ({ sessionId, headerActions }: { sessionId: string | null; headerActions?: ReactNode }) => <section aria-label="Terminal session header"><div data-testid="terminal">{sessionId}</div>{headerActions}</section> }));
vi.mock("./MobileControlBar", () => ({ MobileControlBar: () => <div>Session controls</div> }));
vi.mock("./NewSessionModal", () => ({ NewSessionModal: ({ isOpen, onSubmit, onClose }: {
  isOpen: boolean; onSubmit: (prompt: string, options: { shellType: "shell" }) => Promise<void>; onClose: () => void;
}) => isOpen ? <div>New Session<button onClick={() => { void onSubmit("", { shellType: "shell" }).then(onClose).catch(() => {}); }}>Submit new session</button></div> : null }));
vi.mock("./CloudConnectionNotice", () => ({ CloudConnectionNotice: ({ children }: { children: ReactNode }) => <button aria-label="Connection status and diagnostics">{children}</button> }));

function session(id: string, name: string, fields: Partial<Session> = {}): Session {
  return { id, name, bridgeId: "bridge-a", status: "running", shellType: "shell", createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", ...fields };
}
function dashboard(localMode = false, readyAccount = false) {
  const client = { securityRuntime: { ownerId: "00000000-0000-4000-8000-000000000001", state: (bridgeId: string) => ({ bridgeId, status: "ready", endpoint: null }),
    snapshot: () => [], onChange: () => () => {}, bridge: () => ({ permissions: ["read", "control"] }), identity: { endpoint: { id: "approved-browser" } } } } as unknown as MessageClient;
  return render(<Dashboard client={client} connectionStatus="connected" connectionError={null}
    userId="user" token="test" centrifugoUrl="ws://localhost" transport={null} onDisconnect={vi.fn()} localMode={localMode} accountState={readyAccount ? { status: "ready", identity: null, signing: null, trust: null, legacyBridges: [], historyExists: false, code: null, offline: false } : undefined} />);
}

beforeEach(() => {
  // jsdom has no layout observer. Deliver an initial measurement like a browser
  // so workspace effects exercise their normal setup and cleanup path.
  class TestResizeObserver implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: target.getBoundingClientRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  localStorage.clear();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  vi.clearAllMocks();
  state.activity = new Map();
  state.pending = [];
  state.rpcCommands = [];
  state.createSession.mockResolvedValue(undefined);
  state.clearSessionAttention.mockResolvedValue(undefined);
  state.sessions = [
    session("ordinary", "Regular shell"),
    session("legacy", "Preserved run", { loopId: "retired-loop", status: "error" }),
    session("worker", "project-t42-implement"),
  ];
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  window.requestAnimationFrame = vi.fn(() => 1);
  window.cancelAnimationFrame = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, "clipboard"); Reflect.deleteProperty(document, "execCommand"); });

it("does not reissue bridge update reads when Dashboard rerenders with a fresh RPC callback", async () => {
  dashboard();
  await waitFor(() => expect(state.rpcCommands.filter(type => type === "get_bridge_update")).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Connect a bridge" }));
  expect(screen.getByText("Connect a bridge:")).toBeTruthy();
  await act(async () => { await Promise.resolve(); });
  expect(state.rpcCommands.filter(type => type === "get_bridge_update")).toHaveLength(1);
});

it("preserves the controller and forwards later calls through the latest RPC callback", async () => {
  const data = { schema: 1, bridgeId: "a", currentVersion: "1.0.0", latestVersion: "1.1.0", checkedAt: null, availability: "available", canUpdate: true, blockedReason: null, operation: null, manualCommand: "npx ftown@1.1.0 setup" };
  const first = vi.fn().mockResolvedValue({ success: true, data });
  const second = vi.fn().mockResolvedValue({ success: true, data });
  const { result, rerender } = renderHook(({ send }) => useBridgeUpdates(send, ["a"]), { initialProps: { send: first } });
  await waitFor(() => expect(result.current.get("a").status?.currentVersion).toBe("1.0.0"));
  const original = result.current; rerender({ send: second });
  expect(result.current).toBe(original); expect(first).toHaveBeenCalledTimes(1); expect(second).not.toHaveBeenCalled();
  await act(async () => { await result.current.check("a", true); });
  expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
  let resolveMutation!: (value: { success: boolean; data: { code: string } }) => void;
  second.mockImplementationOnce(() => new Promise(resolve => { resolveMutation = resolve; }));
  act(() => { void result.current.update("a"); });
  const operation = result.current.get("a").operation;
  expect(operation).not.toBeNull();
  rerender({ send: first });
  expect(result.current).toBe(original); expect(result.current.get("a").operation).toEqual(operation);
  await act(async () => { resolveMutation({ success: false, data: { code: "permission_denied" } }); await Promise.resolve(); });
});

describe("dashboard after recurring automation retirement", () => {
  it.each([null, "crons", "factory"])("shows all session history with sidebar setting %s", async (storedTab) => {
    if (storedTab) localStorage.setItem("ftown:sidebarTab", storedTab);
    localStorage.setItem("ftown:paths:alpha", '["/projects"]');
    dashboard();

    for (const name of ["Regular shell", "Preserved run", "project-t42-implement"]) {
      expect(await screen.findByRole("button", { name: new RegExp(name) })).toBeTruthy();
    }
    expect(screen.queryByRole("tablist", { name: "Sidebar sections" })).toBeNull();
    expect(screen.queryByTitle("Create a new loop")).toBeNull();
    expect(screen.queryByText("New Factory")).toBeNull();
    expect(localStorage.getItem("ftown:sidebarTab")).toBe(storedTab);
    expect(localStorage.getItem("ftown:paths:alpha")).toBe('["/projects"]');

    fireEvent.click(screen.getByRole("button", { name: /Preserved run/ }));
    await waitFor(() => expect(screen.getByTestId("terminal").textContent).toBe("legacy"));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Relaunch" })).toBeNull();
  });

  it("keeps ordinary session creation, selection and stop controls", async () => {
    dashboard();
    fireEvent.click(screen.getByRole("button", { name: "Create a new session" }));
    expect(screen.getByText("New Session")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
    expect(screen.getByTestId("terminal").textContent).toBe("ordinary");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(state.stopSession).toHaveBeenCalledWith("ordinary");
  });
});

describe("bridge connection command", () => {
  it("copies exactly the canonical command displayed for the current origin", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    dashboard();
    fireEvent.click(screen.getByRole("button", { name: "Connect a bridge" }));
    const command = buildBridgeCommand({ apiUrl: window.location.origin });
    expect(screen.getByText(command).tagName).toBe("CODE");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
  });
  it("preserves clipboard fallback with the same displayed command", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    const copy = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: copy });
    let copied = "";
    copy.mockImplementation(() => { copied = document.querySelector("textarea")?.value ?? ""; return true; });
    dashboard();
    fireEvent.click(screen.getByRole("button", { name: "Connect a bridge" }));
    const command = screen.getByText(buildBridgeCommand({ apiUrl: window.location.origin })).textContent;
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("copy"));
    expect(copied).toBe(command); expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("new-session navigation", () => {
  it.each([
    { desktop: true, local: false }, { desktop: false, local: false },
    { desktop: true, local: true }, { desktop: false, local: true },
  ])("opens the exact create result (desktop=$desktop, local=$local) without a sidebar click", async ({ desktop, local }) => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const created = session("created-id", "New session");
    // Both rows are already available: delayed publication cannot explain a failure.
    state.sessions.push(created, session("unrelated-later-id", "Another new session"));
    state.createSession.mockResolvedValue(created);
    dashboard(local);
    fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a new session" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit new session" }));
    await waitFor(() => expect(screen.getByTestId("terminal").textContent).toBe("created-id"));
    expect(screen.getByRole("tab", { name: "Terminal" }).classList.contains("mobile-tab-active")).toBe(true);
    expect(screen.getByRole("button", { name: /Regular shell/ })).toBeTruthy();
    expect(state.clearSessionAttention).not.toHaveBeenCalled();
  });

  it("keeps the selected session and mobile workspace when creation fails", async () => {
    state.createSession.mockRejectedValue(new Error("Create rejected"));
    dashboard();
    fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a new session" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit new session" }));
    await waitFor(() => expect(state.createSession).toHaveBeenCalled());
    expect(screen.getByTestId("terminal").textContent).toBe("ordinary");
    expect(screen.getByRole("tab", { name: "Workspace" }).classList.contains("mobile-tab-active")).toBe(true);
    expect(screen.getByText("New Session")).toBeTruthy();
    expect(state.clearSessionAttention).not.toHaveBeenCalled();
  });
});

describe("full-page inbox navigation", () => {
  it.each([true, false])("preserves the mounted workspace and restores focus on back (desktop=%s)", async desktop => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const { container } = dashboard();
    fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
    const terminal = screen.getByTestId("terminal");
    if (!desktop) fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    const trigger = screen.getByRole("button", { name: "Inbox, 0 messages" });
    trigger.focus(); fireEvent.click(trigger);
    expect(screen.getByRole("heading", { name: "Inbox" })).toBe(document.activeElement);
    expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull();
    expect(container.querySelector('[data-testid="terminal"]')).toBe(terminal);
    expect(terminal.closest('[aria-hidden="true"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(screen.queryByRole("region", { name: "Inbox" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('[data-testid="terminal"]')).toBe(terminal);
    if (!desktop) expect(screen.getByRole("tab", { name: "Workspace" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.queryByRole("region", { name: "Inbox" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("attention navigation preserves the request", () => {
  it.each([true, false])("keeps notices when selecting sessions and only dismisses explicitly (desktop=%s)", async desktop => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const { container } = dashboard();
    const original = Array.from(container.querySelectorAll<HTMLButtonElement>('button[draggable="true"]')).find(row => row.textContent?.includes("Regular shell"))!;
    fireEvent.click(original);
    const notice = { type: "agent_needs_input" as const, title: "Review requested", message: "Inspect the result before continuing", receivedAt: 10 };
    state.activity = new Map([["ordinary", { activity: "idle", attention: notice }]]);
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    for (let i = 0; i < 2; i++) {
      fireEvent.click(original); expect(screen.getByTestId("terminal").textContent).toBe("ordinary");
      fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
      fireEvent.click(screen.getByRole("button", { name: "Inbox, 1 message" }));
      expect(screen.getByText("Inspect the result before continuing")).toBeTruthy();
      expect(state.clearSessionAttention).not.toHaveBeenCalled();
      const openSession = screen.getByRole("button", { name: "Open session" }); openSession.focus(); expect(document.activeElement).toBe(openSession);
      fireEvent.click(openSession);
      expect(screen.getByRole("region", { name: "Session workspace: Regular shell" })).toBe(document.activeElement);
      expect(screen.getByTestId("terminal").textContent).toBe("ordinary");
      fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Inbox, 1 message" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(state.clearSessionAttention).toHaveBeenCalledExactlyOnceWith("ordinary", notice));
  });
});


describe("reconnect and refresh", () => {
  it.each([
    { desktop: true, local: false }, { desktop: false, local: false },
    { desktop: true, local: true }, { desktop: false, local: true },
  ])("reloads the current page on explicit action (desktop=$desktop, local=$local)", ({ desktop, local }) => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    // jsdom does not navigate documents, but emits this event when Location.reload
    // attempts a real reload. That checks the production handler without replacing it.
    const virtualConsole = (window as unknown as { _virtualConsole: {
      on(event: "jsdomError", handler: (error: Error) => void): void;
      off(event: "jsdomError", handler: (error: Error) => void): void;
    } })._virtualConsole;
    const errors: Error[] = [];
    const record = (error: Error) => errors.push(error);
    virtualConsole.on("jsdomError", record);
    try {
      localStorage.setItem("ftown:test-trust", "keep");
      sessionStorage.setItem("ftown:test-local-port", "keep");
      const { container } = dashboard(local);
      const desktopButton = container.querySelector<HTMLButtonElement>('.hidden button[aria-label="Reconnect and refresh"]')!;
      let action: HTMLButtonElement;
      if (desktop) {
        action = desktopButton;
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
        action = within(screen.getByRole("navigation", { name: "Dashboard actions" })).getByRole("button", { name: "Reconnect and refresh" });
      }
      if (desktop) {
        fireEvent.mouseEnter(action);
        expect(screen.getByRole("tooltip").textContent).toBe("Reconnect and refresh this page");
        fireEvent.mouseLeave(action);
      } else expect(action.title).toContain("reload this page");
      fireEvent.click(action);
      expect(errors.filter(error => error.message.includes("Not implemented: navigation"))).toHaveLength(1);
      expect(localStorage.getItem("ftown:test-trust")).toBe("keep");
      expect(sessionStorage.getItem("ftown:test-local-port")).toBe("keep");
      expect(state.stopSession).not.toHaveBeenCalled();
      expect(state.retrySession).not.toHaveBeenCalled();
    } finally {
      virtualConsole.off("jsdomError", record);
      sessionStorage.removeItem("ftown:test-local-port");
    }
  });
});

describe("navigation and selected-session actions", () => {
  it("keeps one notification controller in a dismissible mobile disclosure and restores focus", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    dashboard();
    const trigger = screen.getByRole("button", { name: "Open navigation menu" });
    expect(screen.queryByRole("navigation", { name: "Dashboard actions" })).toBeNull();
    expect(document.querySelectorAll("[data-push-state]")).toHaveLength(1);
    fireEvent.click(trigger);
    const nav = screen.getByRole("navigation", { name: "Dashboard actions" });
    const security = within(nav).getByRole("button", { name: "Open security" });
    fireEvent.mouseEnter(security);
    expect(screen.getByRole("tooltip").textContent).toBe("Security: computer and browser access");
    fireEvent.mouseLeave(security);
    expect(within(nav).getByRole("link", { name: "Use This computer" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Enable push notifications" })).toBeTruthy();
    expect(nav.getAttribute("role")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelectorAll("[data-push-state]")).toHaveLength(1);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole("button", { name: "Connection status and diagnostics" }).querySelector("button")).toBeNull();
  });

  it("closes navigation before opening Security and preserves its return focus", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    dashboard();
    const trigger = screen.getByRole("button", { name: "Open navigation menu" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Open security" }));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(await screen.findByRole("dialog", { name: "Security" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close security" }));
    expect(document.activeElement).toBe(trigger);
  });

  it.each([true, false])("targets the selected session in its header, with exclusive status actions (desktop=%s)", async desktop => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    state.sessions = [session("ordinary", "Regular shell"), session("completed", "Completed session", { status: "completed" }), session("failed", "Failed session", { status: "error" }), session("legacy", "Preserved run", { status: "error", loopId: "retired" })];
    dashboard();
    for (const [name, id, action] of [["Regular shell", "ordinary", "Stop"], ["Completed session", "completed", "Rerun"], ["Failed session", "failed", "Retry"]]) {
      fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
      const header = screen.getByRole("group", { name: "Selected session actions" });
      expect(within(header).getAllByRole("button")).toHaveLength(1);
      fireEvent.click(within(header).getByRole("button", { name: action }));
      expect(action === "Stop" ? state.stopSession : state.retrySession).toHaveBeenLastCalledWith(id);
      if (!desktop) {
        fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
        const workspaceHeader = screen.getByRole("region", { name: "Selected session header" });
        expect(screen.getAllByRole("group", { name: "Selected session actions" })).toHaveLength(1);
        fireEvent.click(within(workspaceHeader).getByRole("button", { name: action }));
        expect(action === "Stop" ? state.stopSession : state.retrySession).toHaveBeenLastCalledWith(id);
      }
    }
    fireEvent.click(screen.getByRole("button", { name: /Preserved run/ }));
    expect(screen.queryByRole("button", { name: /^(Stop|Rerun|Retry)$/ })).toBeNull();
    const nav = document.getElementById("dashboard-navigation")!;
    expect(within(nav).queryByRole("button", { name: /^(Stop|Rerun|Retry)$/ })).toBeNull();
  });
});

describe("device review navigation", () => {
  it.each([true, false])("shows the pending count and opens devices (desktop=%s)", async desktop => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    state.pending = [{status: "pending"}, {status: "approved"}, {status: "pending"}];
    dashboard(false, true);
    if (!desktop) fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
    const review = screen.getByRole("button", { name: "Review 2 pending device approvals" });
    expect(review.textContent).toContain("2");
    expect(review.querySelector("svg")).toBeTruthy();
    fireEvent.click(review);
    expect(await screen.findByRole("dialog", { name: "Security" })).toBeTruthy();
    if (!desktop) expect(screen.getByRole("button", { name: "Open navigation menu" }).getAttribute("aria-expanded")).toBe("false");
  });
});

it("keeps terminal controls mounted when a compact desktop switches from preview to Terminal", async () => {
  state.sessions = [session("ordinary", "Regular shell", { preview: { id: "12345678-1234-4234-8234-123456789abc", fileName: "demo.html" } })];
  dashboard();
  fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
  const tabs = screen.getByRole("tablist", { name: "Session view" });
  expect(within(tabs).getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(within(tabs).getByRole("tab", { name: "Terminal" }));
  expect(within(screen.getByRole("tabpanel", { name: "Terminal" })).getByText("Session controls")).toBeTruthy();
});
