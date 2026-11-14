// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import { Dashboard, trackIdleSince } from "./Dashboard";
import { buildBridgeCommand, buildBridgeStartCommand } from "@/lib/bridge-command";
import type { MessageClient } from "@/lib/message-client";
import type { ReactNode } from "react";
import { useBridgeUpdates } from "@/hooks/useBridgeUpdates";

const state = vi.hoisted(() => ({
  sessions: [] as Session[],
  bridges: [{ clientId: "client-a", bridgeId: "bridge-a", hostname: "alpha", connectedAt: "2026-10-16T00:00:00Z" }],
  activity: new Map<string, SessionActivity>(),
  createSession: vi.fn().mockResolvedValue(undefined),
  stopSession: vi.fn(),
  retrySession: vi.fn(),
  removeSession: vi.fn(),
  bridgeExec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  clearSessionAttention: vi.fn(),
  answerSessionAttention: vi.fn(),
  refreshSessionAttention: vi.fn(),
  rpcCommands: [] as string[],
  terminalGetText: vi.fn(() => "terminal output"),
  terminalPaste: vi.fn(),
  terminalSendInput: vi.fn(),
  terminalFocus: vi.fn(),
}));

vi.mock("@/hooks/useSessions", () => ({ useSessions: () => ({
  sessions: state.sessions, createSession: state.createSession, stopSession: state.stopSession,
  retrySession: state.retrySession, removeSession: state.removeSession,
  renameSession: vi.fn(), setSessionParent: vi.fn(), refreshSessions: vi.fn(),
}) }));
vi.mock("@/hooks/useBridgeRpc", () => ({ useBridgeRpc: () => ({ bridgeExec: state.bridgeExec,
  sendCommand: vi.fn().mockImplementation(async command => { state.rpcCommands.push(command.type); return command.type === "send_message" ? { success: true, data: { sessionId: "ordinary", messageId: "m1", status: "queued" } } : { success: true, data: { sessionId: "ordinary", attention: null, sequence: 0 } }; }),
  onSubscribed: () => () => {},
}) }));
vi.mock("@/hooks/useBridges", () => ({ useBridges: () => ({ bridges: state.bridges, hasBridges: true, prepareLocalAccess: vi.fn() }) }));
vi.mock("@/hooks/useAllSessionEvents", () => ({ useAllSessionEvents: () => ({
  sessionActivity: state.activity, markSessionIdle: vi.fn(), clearSessionAttention: state.clearSessionAttention, answerSessionAttention: state.answerSessionAttention, refreshSessionAttention: state.refreshSessionAttention,
}) }));
vi.mock("./Terminal", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Terminal: forwardRef(function Terminal({ sessionId, headerActions }: { sessionId: string | null; headerActions?: ReactNode }, ref) {
    useImperativeHandle(ref, () => ({ sendInput: state.terminalSendInput, focus: state.terminalFocus, refit: vi.fn(), getText: state.terminalGetText, paste: state.terminalPaste }));
    return <section aria-label="Terminal session header"><div data-testid="terminal" tabIndex={-1}>{sessionId}</div>{headerActions}</section>;
  }) };
});
vi.mock("./MobileControlBar", async () => {
  const { forwardRef } = await import("react");
  return { MobileControlBar: forwardRef(function MobileControlBar({ onPaste, onSelectText, onHostPaste }: { onPaste: (text: string) => void; onSelectText: () => void; onHostPaste?: () => void }, _ref) {
    return <div>Session controls<button onClick={onSelectText}>Select</button><button onClick={() => onPaste("pasted\ntext")}>Paste</button>{onHostPaste ? <button onClick={onHostPaste}>Host</button> : null}</div>;
  }) };
});
vi.mock("./NewSessionModal", () => ({ NewSessionModal: ({ isOpen, onSubmit, onClose }: {
  isOpen: boolean; onSubmit: (prompt: string, options: { shellType: "shell" }) => Promise<void>; onClose: () => void;
}) => isOpen ? <div>New Session<button onClick={() => { void onSubmit("", { shellType: "shell" }).then(onClose).catch(() => {}); }}>Submit new session</button></div> : null }));
vi.mock("./CloudConnectionNotice", () => ({ CloudConnectionNotice: ({ children }: { children: ReactNode }) => <button aria-label="Connection status and diagnostics">{children}</button> }));

function session(id: string, name: string, fields: Partial<Session> = {}): Session {
  return { id, name, bridgeId: "bridge-a", status: "running", shellType: "shell", createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", ...fields };
}
function dashboard(localMode = false, accountId: string | null = null) {
  const client = { securityRuntime: { ownerId: "00000000-0000-4000-8000-000000000001", state: (bridgeId: string) => ({ bridgeId, status: "ready", endpoint: null }),
    snapshot: () => [], onChange: () => () => {}, bridge: () => ({ permissions: ["read", "control"] }), identity: { endpoint: { id: "approved-browser" } } } } as unknown as MessageClient;
  return render(<Dashboard client={client} connectionStatus="connected" connectionError={null}
    userId="user" token="test" centrifugoUrl="ws://localhost" transport={null} onDisconnect={vi.fn()} localMode={localMode} accountId={accountId} />);
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
  state.rpcCommands = [];
  state.createSession.mockResolvedValue(undefined);
  state.clearSessionAttention.mockResolvedValue(undefined);
  state.refreshSessionAttention.mockResolvedValue(undefined);
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
  const setupCommand = () => buildBridgeCommand({ apiUrl: window.location.origin });
  const startCommand = () => buildBridgeStartCommand({ apiUrl: window.location.origin });
  const openPanel = () => fireEvent.click(screen.getByRole("button", { name: "Connect a bridge" }));

  it("shows the setup and start commands as separate code blocks", () => {
    dashboard();
    openPanel();
    const setup = screen.getByText(setupCommand());
    const start = screen.getByText(startCommand());
    expect(setup.tagName).toBe("CODE");
    expect(start.tagName).toBe("CODE");
    expect(setup.textContent).toBe(setupCommand());
    expect(start.textContent).toBe(startCommand());
    expect(setup).not.toBe(start);
  });
  it("labels both steps, the npx hint and the approval footer", () => {
    dashboard();
    openPanel();
    expect(screen.getByText("Connect a bridge:")).toBeTruthy();
    expect(screen.getByText("1. First time on this computer — install and start")).toBeTruthy();
    expect(screen.getByText("Setup copies ftown into ~/.ftown and adds the ftown command to your PATH.")).toBeTruthy();
    expect(screen.getByText("2. Every start after that")).toBeTruthy();
    expect(screen.getByText("Use this instead of npx — the installed copy is what lets the bridge install updates from this dashboard. Open a new terminal if ftown isn't found.")).toBeTruthy();
    expect(screen.getByText(/After the first start, approve the computer here:/)).toBeTruthy();
    expect(screen.queryByText(/Run this on the machine/)).toBeNull();
    expect(screen.getByRole("link", { name: "Approve a device" }).getAttribute("href")).toBe("/pair");
  });
  it("copies exactly the setup command and marks only that button copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    dashboard();
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Copy setup command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(setupCommand()));
    expect(writeText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy setup command" }).textContent).toBe("✓ Copied"));
    expect(screen.getByRole("button", { name: "Copy start command" }).textContent).toBe("Copy");
  });
  it("copies exactly the start command and marks only that button copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    dashboard();
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Copy start command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(startCommand()));
    expect(writeText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy start command" }).textContent).toBe("✓ Copied"));
    expect(screen.getByRole("button", { name: "Copy setup command" }).textContent).toBe("Copy");
  });
  it("keeps the latest copied state when an earlier reset timer is pending", async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      dashboard();
      openPanel();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy setup command" })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy start command" })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(screen.getByRole("button", { name: "Copy start command" }).textContent).toBe("✓ Copied");
      expect(screen.getByRole("button", { name: "Copy setup command" }).textContent).toBe("Copy");
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      expect(screen.getByRole("button", { name: "Copy start command" }).textContent).toBe("Copy");
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    { button: "Copy setup command", expected: () => buildBridgeCommand({ apiUrl: window.location.origin }) },
    { button: "Copy start command", expected: () => buildBridgeStartCommand({ apiUrl: window.location.origin }) },
  ])("preserves clipboard fallback for $button with the displayed command", async ({ button, expected }) => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    const copy = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: copy });
    let copied = "";
    copy.mockImplementation(() => { copied = document.querySelector("textarea")?.value ?? ""; return true; });
    dashboard();
    openPanel();
    const command = screen.getByText(expected()).textContent;
    fireEvent.click(screen.getByRole("button", { name: button }));
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
    fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
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
    fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create a new session" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit new session" }));
    await waitFor(() => expect(state.createSession).toHaveBeenCalled());
    expect(screen.getByTestId("terminal").textContent).toBe("ordinary");
    expect(screen.getByRole("tab", { name: /^Workspace/ }).classList.contains("mobile-tab-active")).toBe(true);
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
    if (!desktop) fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
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
    if (!desktop) expect(screen.getByRole("tab", { name: /^Workspace/ }).getAttribute("aria-selected")).toBe("true");
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
    fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
    for (let i = 0; i < 2; i++) {
      fireEvent.click(original); expect(screen.getByTestId("terminal").textContent).toBe("ordinary");
      fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
      fireEvent.click(screen.getByRole("button", { name: "Inbox, 1 waiting" }));
      expect(within(screen.getByRole("region", { name: "Inbox" })).getByText("Inspect the result before continuing")).toBeTruthy();
      expect(state.clearSessionAttention).not.toHaveBeenCalled();
      const openSession = within(screen.getByRole("region", { name: "Inbox" })).getByRole("button", { name: "Open session" }); openSession.focus(); expect(document.activeElement).toBe(openSession);
      fireEvent.click(openSession);
      expect(screen.getByRole("region", { name: "Session workspace: Regular shell" })).toBe(document.activeElement);
      expect(screen.getByTestId("terminal").textContent).toBe("ordinary");
      fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Inbox, 1 waiting" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(state.clearSessionAttention).toHaveBeenCalledExactlyOnceWith("ordinary", notice));
  });
});


describe("inbox document title", () => {
  it("prefixes the title with the waiting count and restores it at zero", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    document.title = "ftown base";
    dashboard();
    expect(document.title).toBe("ftown base");
    const notice = { type: "agent_needs_input" as const, title: "Review", message: "Inspect", receivedAt: 10 };
    state.activity = new Map([["ordinary", { activity: "idle", attention: notice }]]);
    fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
    await waitFor(() => expect(document.title).toBe("(1) ftown base"));
    state.activity = new Map();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    await waitFor(() => expect(document.title).toBe("ftown base"));
  });
  it("derives the base by stripping the prefix so a later title change is kept", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    document.title = "ftown base";
    dashboard();
    expect(document.title).toBe("ftown base");
    const notice1 = { type: "agent_needs_input" as const, title: "Review", message: "Inspect", receivedAt: 10 };
    state.activity = new Map([["ordinary", { activity: "idle", attention: notice1 }]]);
    fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
    await waitFor(() => expect(document.title).toBe("(1) ftown base"));
    document.title = "ftown new";
    const notice2 = { ...notice1, title: "Review 2", receivedAt: 11 };
    state.activity = new Map([["ordinary", { activity: "idle", attention: notice2 }], ["worker", { activity: "idle", attention: notice2 }]]);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    await waitFor(() => expect(document.title).toBe("(2) ftown new"));
  });
  it("does not count parent-routed non-escalated items toward the waiting prefix", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    document.title = "ftown base";
    state.sessions = [session("ordinary", "Regular shell"), session("boss", "Boss"), session("child", "Worker", { parentSessionId: "boss" })];
    dashboard();
    expect(document.title).toBe("ftown base");
    const ordinary = { type: "agent_needs_input" as const, title: "Review", message: "Inspect", receivedAt: 10 };
    const withParent = { type: "agent_needs_input" as const, title: "Question", message: "Ask", receivedAt: 11, route: "parent" as const, routedTo: "boss" };
    state.activity = new Map([["ordinary", { activity: "idle", attention: ordinary }], ["child", { activity: "idle", attention: withParent }]]);
    fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
    await waitFor(() => expect(document.title).toBe("(1) ftown base"));
    // Once the parent escalates, the item counts again.
    state.activity = new Map([["child", { activity: "idle", attention: { ...withParent, escalatedAt: "2026-11-13T00:00:00.000Z", escalationNote: "Parent is gone" } }]]);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    await waitFor(() => expect(document.title).toBe("(1) ftown base"));
  });
});

describe("manager Overview tab", () => {
  it("appears on the phone for a session with children, shows the overview panel, and disappears for a plain session", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    state.sessions = [session("boss", "Boss"), session("child", "Worker", { parentSessionId: "boss" }), session("plain", "Regular shell")];
    dashboard();
    fireEvent.click(await screen.findByRole("button", { name: /Boss/ }));
    expect(phoneTabNames()).toEqual(["Workspace", "Overview", "Terminal"]);
    fireEvent.click(phoneTab("Overview"));
    expect(phoneTab("Overview").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toBeTruthy();
    fireEvent.click(phoneTab("Terminal"));
    expect(screen.queryByRole("tabpanel", { name: "Overview" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
    expect(phoneTabNames()).toEqual(["Workspace", "Terminal"]);
  });
});

type Layout = "wide" | "compact" | "mobile";
const layouts: Layout[] = ["wide", "compact", "mobile"];
function useLayout(layout: Layout) {
  window.matchMedia = vi.fn().mockReturnValue({ matches: layout !== "mobile", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  if (layout !== "wide") return;
  class WideResizeObserver implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: DOMRect.fromRect({ width: 900 }), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this); }
    unobserve() {} disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", WideResizeObserver);
}
const demoPreview = { id: "12345678-1234-4234-8234-123456789abc", files: [{ id: "22345678-2234-4234-8234-123456789abc", fileName: "demo.html", kind: "html" as const }] };
const question = (key: string) => ({ type: "agent_needs_input" as const, title: "Review", message: `Question ${key}`, receivedAt: 10, attentionId: `att-${key}`, attentionSequence: 1 });
function waiting(items: Record<string, ReturnType<typeof question>>) {
  state.activity = new Map(Object.entries(items).map(([id, attention]) => [id, { activity: "idle", attention }]));
}
function fixtures(withPreview: boolean, fields: Partial<Session> = {}) {
  state.sessions = [session("ordinary", "Regular shell", { ...(withPreview ? { preview: demoPreview } : {}), ...fields }), session("worker", "project-t42-implement", withPreview ? { preview: { ...demoPreview, id: "aaaaaaaa-1234-4234-8234-123456789abc" } } : {})];
}
/** Mounts the dashboard; `refresh` re-renders it after the mocked sessions or activity changed, like a bridge event would. */
function mountDashboard() {
  const client = { securityRuntime: { ownerId: "00000000-0000-4000-8000-000000000001", state: (bridgeId: string) => ({ bridgeId, status: "ready", endpoint: null }),
    snapshot: () => [], onChange: () => () => {}, bridge: () => ({ permissions: ["read", "control"] }), identity: { endpoint: { id: "approved-browser" } } } } as unknown as MessageClient;
  const element = () => <Dashboard client={client} connectionStatus="connected" connectionError={null} userId="user" token="test" centrifugoUrl="ws://localhost" transport={null} onDisconnect={vi.fn()} />;
  const view = render(element());
  return { refresh: async () => { view.rerender(element()); await act(async () => {}); } };
}
const enter = (name: RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const pane = () => screen.queryByRole("region", { name: "Waiting for you" });
const paneInDom = () => document.querySelector('[role="region"][aria-label="Waiting for you"]');
const phoneTabs = () => within(screen.getByRole("tablist", { name: "Workspace navigation" })).getAllByRole("tab");
const phoneTab = (name: string | RegExp) => within(screen.getByRole("tablist", { name: "Workspace navigation" })).getByRole("tab", { name });
/** Tab labels without the Inbox badge count the Workspace tab carries. */
const phoneTabNames = () => phoneTabs().map(tab => tab.textContent?.replace(/\d+$/, ""));
const selectedPhoneTab = () => phoneTabs().filter(tab => tab.getAttribute("aria-selected") === "true").map(tab => tab.textContent);
const selectedCompactTab = () => within(screen.getByRole("tablist", { name: "Session view" })).getAllByRole("tab").filter(tab => tab.getAttribute("aria-selected") === "true").map(tab => tab.textContent);
const terminalPane = () => screen.getByTestId("terminal").closest<HTMLElement>("#session-terminal-panel")!;
function expectShown(layout: Layout, key: string) {
  expect(within(pane()!).getByText(`Question ${key}`)).toBeTruthy();
  expect(document.querySelectorAll('[aria-label="Waiting for you"][role="region"]')).toHaveLength(1);
  if (layout === "mobile") expect(selectedPhoneTab()).toEqual(["Waiting"]);
  if (layout === "compact") expect(selectedCompactTab()).toEqual(["Waiting"]);
  if (layout === "wide") expect(terminalPane().hidden).toBe(false);
}
/** The pane left the item for the session's open preview (`true`) or closed onto the terminal (`false`). */
function expectFallback(layout: Layout, withPreview: boolean) {
  expect(paneInDom()).toBeNull();
  if (layout === "mobile") {
    expect(selectedPhoneTab()).toEqual([withPreview ? "Preview" : "Terminal"]);
    expect(phoneTabNames()).toEqual(withPreview ? ["Workspace", "Terminal", "Preview"] : ["Workspace", "Terminal"]);
  }
  if (layout === "compact" && withPreview) expect(selectedCompactTab()).toEqual(["Preview"]);
  if (layout !== "mobile" && !withPreview) expect(screen.queryByRole("tablist", { name: "Session view" })).toBeNull();
  if (withPreview) expect(screen.getByRole(layout === "wide" ? "region" : "tabpanel", { name: "Session preview" })).toBeTruthy();
  else expect(document.querySelector(".session-aux-pane:not([hidden])")).toBeNull();
  expect(terminalPane().hidden).toBe(withPreview && layout !== "wide");
}
/** The owner looks away from a shown item without resolving it: a file on a wide pane, the terminal tab elsewhere. */
function lookAway(layout: Layout, withPreview: boolean) {
  if (layout === "mobile") fireEvent.click(phoneTab("Terminal"));
  else if (layout === "compact") fireEvent.click(within(screen.getByRole("tablist", { name: "Session view" })).getByRole("tab", { name: "Terminal" }));
  else if (withPreview) fireEvent.click(within(screen.getByRole("tablist", { name: "Side pane view" })).getByRole("tab", { name: "demo.html" }));
  else fireEvent.click(screen.getByRole("button", { name: "Close waiting" }));
  expect(pane()).toBeNull();
}
/** Shows a closed item again: from the terminal header, or from the selector when a narrow layout has the preview in front. */
function showAgain(layout: Layout, withPreview: boolean) {
  if (withPreview && layout !== "wide") fireEvent.click(within(screen.getByRole("tablist", { name: "Side pane view" })).getByRole("tab", { name: "Waiting for you" }));
  else fireEvent.click(screen.getAllByRole("button", { name: "Waiting for you" })[0]);
}
const cases = layouts.flatMap(layout => [false, true].map(withPreview => ({ layout, withPreview, label: `${layout}, ${withPreview ? "with" : "without"} preview` })));

describe.each(cases)("waiting item in the side pane ($label)", ({ layout, withPreview }) => {
  beforeEach(() => { useLayout(layout); fixtures(withPreview); });

  it("shows the item of the first session entered after load", () => {
    waiting({ ordinary: question("a") });
    mountDashboard();
    expect(paneInDom()).toBeNull();
    enter(/Regular shell/);
    expectShown(layout, "a");
    expect(screen.queryByText(/Waiting \(/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Waiting for you" })).toBeNull();
  });

  it("shows each session's own item when switching between two sessions that both wait", () => {
    waiting({ ordinary: question("a"), worker: question("b") });
    mountDashboard();
    enter(/Regular shell/);
    expectShown(layout, "a");
    if (layout === "mobile") fireEvent.click(phoneTab(/^Workspace/));
    enter(/project-t42-implement/);
    expectShown(layout, "b");
    if (layout === "mobile") fireEvent.click(phoneTab(/^Workspace/));
    enter(/Regular shell/);
    expectShown(layout, "a");
  });

  it("leaves the pane of a session alone when another session starts waiting", async () => {
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    waiting({ worker: question("b") });
    await refresh();
    expectFallback(layout, withPreview);
  });

  it("switches to an item that arrives while the owner is in the session, without taking focus from the terminal", async () => {
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    const terminal = screen.getByTestId("terminal");
    terminal.focus();
    waiting({ ordinary: question("a") });
    await refresh();
    expectShown(layout, "a");
    expect(document.activeElement).toBe(terminal);
  });

  it("keeps showing the item when the preview set changes underneath it", async () => {
    waiting({ ordinary: question("a") });
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    fixtures(!withPreview);
    await refresh();
    expectShown(layout, "a");
    fixtures(withPreview);
    await refresh();
    expectShown(layout, "a");
  });

  it("falls back to the preview or the terminal once the item is resolved", async () => {
    waiting({ ordinary: question("a") });
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    expectShown(layout, "a");
    waiting({});
    await refresh();
    expectFallback(layout, withPreview);
  });

  it("shows a new item after the owner looked away from the previous one", async () => {
    waiting({ ordinary: question("a") });
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    lookAway(layout, withPreview);
    waiting({ ordinary: question("b") });
    await refresh();
    expectShown(layout, "b");
  });

  it("keeps a closed item closed, then shows the next item after the closed one was resolved", async () => {
    waiting({ ordinary: question("a") });
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    fireEvent.click(screen.getByRole("button", { name: "Close waiting" }));
    expectFallback(layout, withPreview);
    waiting({ ordinary: question("a") });
    await refresh();
    expectFallback(layout, withPreview);
    waiting({});
    await refresh();
    expectFallback(layout, withPreview);
    waiting({ ordinary: question("b") });
    await refresh();
    expectShown(layout, "b");
  });

  it("shows a closed item again from the header button and when the session is entered again", () => {
    waiting({ ordinary: question("a"), worker: question("b") });
    mountDashboard();
    enter(/Regular shell/);
    expect(screen.queryByRole("button", { name: "Waiting for you" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close waiting" }));
    expectFallback(layout, withPreview);
    expect(document.querySelectorAll('button[aria-label="Waiting for you"]').length).toBeGreaterThan(0);
    showAgain(layout, withPreview);
    expectShown(layout, "a");
    expect(document.querySelector('button[aria-label="Waiting for you"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close waiting" }));
    if (layout === "mobile") fireEvent.click(phoneTab(/^Workspace/));
    enter(/project-t42-implement/);
    expectShown(layout, "b");
    if (layout === "mobile") fireEvent.click(phoneTab(/^Workspace/));
    enter(/Regular shell/);
    expectShown(layout, "a");
  });

  it("moves focus on Close and Escape to the terminal beside a desktop pane, else to the tab left selected", () => {
    waiting({ ordinary: question("a") });
    mountDashboard();
    enter(/Regular shell/);
    const toTerminal = layout === "wide" || (layout === "compact" && !withPreview);
    const selectedTab = () => layout === "mobile" ? phoneTab(withPreview ? "Preview" : "Terminal")
      : within(screen.getByRole("tablist", { name: "Session view" })).getByRole("tab", { name: "Preview" });
    const expectFocusMoved = (times: number) => {
      expect(state.terminalFocus).toHaveBeenCalledTimes(toTerminal ? times : 0);
      if (!toTerminal) { expect(selectedTab().getAttribute("aria-selected")).toBe("true"); expect(document.activeElement).toBe(selectedTab()); }
    };
    const close = screen.getByRole("button", { name: "Close waiting" });
    close.focus();
    fireEvent.click(close);
    expectFallback(layout, withPreview);
    expectFocusMoved(1);
    showAgain(layout, withPreview);
    const reply = within(pane()!).getByLabelText("Reply to Regular shell");
    reply.focus();
    fireEvent.keyDown(reply, { key: "Escape" });
    expectFallback(layout, withPreview);
    expectFocusMoved(2);
  });

  it("keeps a typed reply while the owner looks at something else, and never carries it to another item", async () => {
    waiting({ ordinary: question("a") });
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    const reply = () => within(pane()!).getByLabelText("Reply to Regular shell") as HTMLTextAreaElement;
    fireEvent.change(reply(), { target: { value: "half a thought" } });
    if (withPreview) {
      fireEvent.click(within(screen.getByRole("tablist", { name: "Side pane view" })).getByRole("tab", { name: "demo.html" }));
      expectFallback(layout, true);
      fireEvent.click(within(screen.getByRole("tablist", { name: "Side pane view" })).getByRole("tab", { name: "Waiting for you" }));
      expect(reply().value).toBe("half a thought");
    }
    fireEvent.keyDown(reply(), { key: "Escape" });
    expectFallback(layout, withPreview);
    showAgain(layout, withPreview);
    expect(reply().value).toBe("half a thought");
    waiting({ ordinary: question("b") });
    await refresh();
    expectShown(layout, "b");
    expect(reply().value).toBe("");
    fireEvent.change(reply(), { target: { value: "for b" } });
    waiting({});
    await refresh();
    waiting({ ordinary: question("b") });
    await refresh();
    expect(reply().value).toBe("");
  });

  it("hides the pane while the Inbox page is open and never closes that page", async () => {
    waiting({ ordinary: question("a") });
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    if (layout === "mobile") fireEvent.click(phoneTab(/^Workspace/));
    fireEvent.click(screen.getByRole("button", { name: "Inbox, 1 waiting" }));
    expect(paneInDom()).toBeNull();
    expect(screen.queryByRole("button", { name: "Waiting for you" })).toBeNull();
    waiting({ ordinary: question("b") });
    await refresh();
    expect(paneInDom()).toBeNull();
    expect(within(screen.getByRole("region", { name: "Inbox" })).getByText("Question b")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    if (layout === "mobile") { expect(selectedPhoneTab()).toEqual(["Workspace"]); expect(phoneTab("Waiting")).toBeTruthy(); }
    else expectShown(layout, "b");
  });

  it("dismisses, replies and answers from the pane", async () => {
    const plain = question("a");
    waiting({ ordinary: plain });
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    fireEvent.change(within(pane()!).getByLabelText("Reply to Regular shell"), { target: { value: "go ahead" } });
    fireEvent.click(within(pane()!).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(state.refreshSessionAttention).toHaveBeenCalledExactlyOnceWith("ordinary"));
    expect(state.rpcCommands.filter(type => type === "send_message")).toHaveLength(1);
    state.clearSessionAttention.mockRejectedValueOnce(new Error("Bridge refused the dismiss"));
    fireEvent.click(within(pane()!).getByRole("button", { name: "Dismiss" }));
    expect((await within(pane()!).findByRole("alert")).textContent).toBe("Bridge refused the dismiss");
    fireEvent.click(within(pane()!).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(state.clearSessionAttention).toHaveBeenCalledTimes(2));
    expect(state.clearSessionAttention).toHaveBeenLastCalledWith("ordinary", plain);
    const prompted = { ...question("q"), prompt: { channel: "mail" as const, questions: [{ question: "Which path?", options: [{ label: "Fast" }, { label: "Safe" }], multiSelect: false, allowText: false }] } };
    state.answerSessionAttention.mockResolvedValue({ ok: true, delivery: "waiter" });
    waiting({ ordinary: prompted });
    await refresh();
    fireEvent.click(within(pane()!).getByLabelText("Safe"));
    fireEvent.click(within(pane()!).getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(state.answerSessionAttention).toHaveBeenCalledExactlyOnceWith("ordinary", prompted, [{ selected: [1] }]));
    waiting({});
    await refresh();
    expectFallback(layout, withPreview);
  });
});

describe.each(layouts)("preview behind the waiting item (%s)", layout => {
  beforeEach(() => { useLayout(layout); fixtures(true); waiting({ ordinary: question("a") }); });

  it("can expand the preview after the item was closed", () => {
    mountDashboard();
    enter(/Regular shell/);
    expect(screen.queryByRole("button", { name: "Expand preview" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close waiting" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand preview" }));
    expect(screen.getByRole("button", { name: "Collapse preview" })).toBeTruthy();
    expect(terminalPane().hidden).toBe(true);
  });

  it("offers one selector with the item first, and moving through it with the arrow keys keeps focus in it", () => {
    mountDashboard();
    enter(/Regular shell/);
    expect(screen.queryByRole("tablist", { name: "Auxiliary view" })).toBeNull();
    const selector = screen.getByRole("tablist", { name: "Side pane view" });
    const entries = within(selector).getAllByRole("tab");
    expect(entries.map(entry => entry.textContent)).toEqual(["Waiting for you", "demo.html"]);
    entries[0].focus();
    fireEvent.keyDown(selector, { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(selector).getByRole("tab", { name: "demo.html" }));
    expectFallback(layout, true);
    fireEvent.keyDown(selector, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(within(selector).getByRole("tab", { name: "Waiting for you" }));
    expectShown(layout, "a");
  });
});

it("compact: entering another session starts on its side pane even after the Terminal tab was chosen in the previous one", () => {
  useLayout("compact");
  fixtures(true);
  mountDashboard();
  enter(/Regular shell/);
  fireEvent.click(within(screen.getByRole("tablist", { name: "Session view" })).getByRole("tab", { name: "Terminal" }));
  expect(selectedCompactTab()).toEqual(["Terminal"]);
  enter(/project-t42-implement/);
  expect(selectedCompactTab()).toEqual(["Preview"]);
});

describe.each(["wide", "mobile"] as const)("header Open preview over a shown item (%s)", layout => {
  it("shows the preview file instead of the item, without asking for the terminal", async () => {
    useLayout(layout);
    fixtures(true);
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    waiting({ ordinary: question("a") });
    await refresh();
    expectShown(layout, "a");
    if (layout === "mobile") fireEvent.click(phoneTab("Terminal"));
    fireEvent.click(screen.getAllByRole("button", { name: "Open preview" })[0]);
    expectFallback(layout, true);
    expect(state.terminalFocus).not.toHaveBeenCalled();
    expect(document.querySelectorAll('button[aria-label="Waiting for you"]').length).toBeGreaterThan(0);
    expect(document.querySelector('button[aria-label="Open preview"]')).toBeNull();
  });
});

it("compact: selecting the session it is already in brings a shown item forward from the Terminal tab", () => {
  useLayout("compact");
  fixtures(false);
  waiting({ ordinary: question("a") });
  mountDashboard();
  enter(/Regular shell/);
  fireEvent.click(within(screen.getByRole("tablist", { name: "Session view" })).getByRole("tab", { name: "Terminal" }));
  expect(selectedCompactTab()).toEqual(["Terminal"]);
  enter(/Regular shell/);
  expectShown("compact", "a");
});

it("keeps the Inbox page open when the window narrows to a phone and the side-pane tab has nothing behind it", () => {
  const listeners: ((event: { matches: boolean }) => void)[] = [];
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { listeners.push(listener); }, removeEventListener: vi.fn() });
  fixtures(false);
  waiting({ ordinary: question("a") });
  mountDashboard();
  enter(/Regular shell/);
  fireEvent.click(screen.getByRole("button", { name: "Inbox, 1 waiting" }));
  expect(screen.getByRole("region", { name: "Inbox" })).toBeTruthy();
  expect(listeners.length).toBeGreaterThan(0);
  act(() => { for (const listener of listeners) listener({ matches: false }); });
  expect(selectedPhoneTab()).toEqual(["Terminal"]);
  expect(screen.getByRole("region", { name: "Inbox" })).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Inbox" })).getByText("Question a")).toBeTruthy();
});

describe("waiting item on a phone", () => {
  beforeEach(() => { useLayout("mobile"); });

  it.each([false, true])("names the side-pane tab after what it shows (preview=%s)", async withPreview => {
    fixtures(withPreview);
    waiting({ ordinary: question("a") });
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    expect(phoneTabNames()).toEqual(["Workspace", "Terminal", "Waiting"]);
    expect(phoneTab("Waiting").getAttribute("aria-controls")).toBe("session-preview-panel");
    expect(document.getElementById("session-preview-panel")?.getAttribute("role")).toBe("tabpanel");
    fireEvent.click(phoneTab("Terminal"));
    expect(phoneTabNames()).toEqual(["Workspace", "Terminal", "Waiting"]);
    fireEvent.click(phoneTab("Waiting"));
    expectShown("mobile", "a");
    waiting({});
    await refresh();
    expect(phoneTabNames()).toEqual(withPreview ? ["Workspace", "Terminal", "Preview"] : ["Workspace", "Terminal"]);
  });

  it("does not leave the Workspace list or the PR review for a new item, and offers the tab instead", async () => {
    fixtures(false, { pullRequestUrl: "https://github.com/Org/repo/pull/123", pullRequestReviewGeneration: "generation" });
    const { refresh } = mountDashboard();
    enter(/Regular shell/);
    fireEvent.click(screen.getAllByRole("button", { name: "Review pull request" })[0]);
    expect(selectedPhoneTab()).toEqual(["PR review"]);
    waiting({ ordinary: question("a") });
    await refresh();
    expect(selectedPhoneTab()).toEqual(["PR review"]);
    expect(phoneTab("Waiting")).toBeTruthy();
    fireEvent.click(phoneTab(/^Workspace/));
    waiting({ ordinary: question("b") });
    await refresh();
    expect(selectedPhoneTab()).toEqual(["Workspace"]);
    fireEvent.click(phoneTab("Terminal"));
    expect(selectedPhoneTab()).toEqual(["Terminal"]);
    waiting({ ordinary: question("c") });
    await refresh();
    expectShown("mobile", "c");
  });

  it.each([false, true])("returns from a closed PR review to the item, else to the preview or the terminal (item=%s)", item => {
    fixtures(false, { pullRequestUrl: "https://github.com/Org/repo/pull/123", pullRequestReviewGeneration: "generation" });
    if (item) waiting({ ordinary: question("a") });
    mountDashboard();
    enter(/Regular shell/);
    fireEvent.click(phoneTab("Terminal"));
    fireEvent.click(screen.getAllByRole("button", { name: "Review pull request" })[0]);
    expect(selectedPhoneTab()).toEqual(["PR review"]);
    fireEvent.click(screen.getByRole("button", { name: "Close PR review" }));
    if (item) expectShown("mobile", "a");
    else expectFallback("mobile", false);
  });

  it("lands on the item when the session it is already in is entered again from the Workspace list", () => {
    fixtures(false);
    waiting({ ordinary: question("a") });
    mountDashboard();
    enter(/Regular shell/);
    fireEvent.click(phoneTab("Terminal"));
    fireEvent.click(phoneTab(/^Workspace/));
    enter(/Regular shell/);
    expectShown("mobile", "a");
  });

  it("lands on the item when the session is opened from the Inbox page", () => {
    fixtures(true);
    waiting({ ordinary: question("a") });
    mountDashboard();
    fireEvent.click(screen.getByRole("button", { name: "Inbox, 1 waiting" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Inbox" })).getByRole("button", { name: "Open session" }));
    expect(screen.queryByRole("region", { name: "Inbox" })).toBeNull();
    expectShown("mobile", "a");
  });
});

describe("mobile inbox badge", () => {
  it("shows the workspace badge with an accessible waiting description off the sessions tab", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    dashboard();
    const notice = { type: "agent_needs_input" as const, title: "Review", message: "Inspect", receivedAt: 10 };
    state.activity = new Map([["ordinary", { activity: "idle", attention: notice }]]);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    const workspaceTab = screen.getByRole("tab", { name: "Workspace" });
    expect(workspaceTab.getAttribute("aria-describedby")).toBe("mobile-tab-inbox-waiting");
    expect(document.getElementById("mobile-tab-inbox-waiting")?.textContent).toBe("1 waiting");
    const badge = workspaceTab.querySelector(".mobile-tab-inbox-badge");
    expect(badge?.textContent).toBe("1");
  });
});

describe("inbox answers", () => {
  it("submits a prompted answer through answerSessionAttention and maps the delivery", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    state.answerSessionAttention.mockResolvedValue({ ok: true, delivery: "waiter" });
    dashboard();
    const notice = { type: "agent_needs_input" as const, title: "Question", message: "Pick one", receivedAt: 10, attentionId: "att-1",
      prompt: { channel: "mail" as const, questions: [{ question: "Which path?", options: [{ label: "Fast" }, { label: "Safe" }], multiSelect: false, allowText: false }] } };
    state.activity = new Map([["ordinary", { activity: "idle", attention: notice }]]);
    fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
    fireEvent.click(screen.getByRole("button", { name: "Inbox, 1 waiting" }));
    expect(within(screen.getByRole("region", { name: "Inbox" })).queryByRole("button", { name: "Send reply" })).toBeNull();
    fireEvent.click(within(screen.getByRole("region", { name: "Inbox" })).getByLabelText("Safe")); fireEvent.click(within(screen.getByRole("region", { name: "Inbox" })).getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(state.answerSessionAttention).toHaveBeenCalledExactlyOnceWith("ordinary", notice, [{ selected: [1] }]));
    expect((await screen.findAllByText("Answer delivered to Regular shell.")).length).toBeGreaterThan(0);
  });
  it("re-reads the snapshot after a stamped reply so the item drops", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    dashboard();
    const notice = { type: "agent_needs_input" as const, title: "Review", message: "Inspect", receivedAt: 10, attentionId: "att-1", attentionSequence: 1 };
    state.activity = new Map([["ordinary", { activity: "idle", attention: notice }]]);
    fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
    fireEvent.click(screen.getByRole("button", { name: "Inbox, 1 waiting" }));
    fireEvent.change(within(screen.getByRole("region", { name: "Inbox" })).getByLabelText("Reply to Regular shell"), { target: { value: "hello" } });
    fireEvent.click(within(screen.getByRole("region", { name: "Inbox" })).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(state.refreshSessionAttention).toHaveBeenCalledWith("ordinary"));
  });
  it("does not re-read after an unstamped reply", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    dashboard();
    const notice = { type: "agent_needs_input" as const, title: "Review", message: "Inspect", receivedAt: 10 };
    state.activity = new Map([["ordinary", { activity: "idle", attention: notice }]]);
    fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
    fireEvent.click(screen.getByRole("button", { name: "Inbox, 1 waiting" }));
    fireEvent.change(within(screen.getByRole("region", { name: "Inbox" })).getByLabelText("Reply to Regular shell"), { target: { value: "hello" } });
    fireEvent.click(within(screen.getByRole("region", { name: "Inbox" })).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(state.rpcCommands).toContain("send_message"));
    expect(state.refreshSessionAttention).not.toHaveBeenCalled();
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

describe("account mode navigation", () => {
  it("offers no switch to /local: the account dashboard already reaches this computer, loopback included", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    dashboard(false, "A".repeat(43));
    const nav = screen.getByRole("navigation", { name: "Dashboard actions" });
    expect(within(nav).queryByRole("link", { name: "Use This computer" })).toBeNull();
    expect(within(nav).getByRole("button", { name: "Open security" })).toBeTruthy();
    cleanup(); dashboard();
    expect(within(screen.getByRole("navigation", { name: "Dashboard actions" })).getByRole("link", { name: "Use This computer" })).toBeTruthy();
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
        fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
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

describe("sidebar PR review navigation", () => {
  it.each([true, false])("opens the target session review from badge and menu, including from inbox (desktop=%s)", async desktop => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    state.sessions = [session("ordinary", "Regular shell"), session("target", "Target review", {
      pullRequestUrl: "https://github.com/Org/repo/pull/123", pullRequestReviewGeneration: "target-generation",
      preview: { id: "12345678-1234-4234-8234-123456789abc", files: [{ id: "22345678-2234-4234-8234-123456789abc", fileName: "demo.html", kind: "html" }] },
    })];
    const { container } = dashboard();
    fireEvent.click(screen.getByRole("button", { name: /Regular shell/ }));
    expect(screen.getByTestId("terminal").textContent).toBe("ordinary");
    if (!desktop) fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
    fireEvent.click(screen.getByRole("button", { name: "Inbox, 0 messages" }));
    expect(screen.getByRole("region", { name: "Inbox" })).toBeTruthy();
    if (!desktop) {
      fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
      fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
    }
    const target = container.querySelector<HTMLElement>('[data-session-row="target"]')!;
    fireEvent.click(within(target).getByRole("button", { name: /Review pull request: PR #123/ }));
    expect(screen.queryByRole("region", { name: "Inbox" })).toBeNull();
    expect(screen.getByTestId("terminal").textContent).toBe("target");
    await waitFor(() => expect(screen.getByRole("tabpanel", { name: "PR review" })).toBeTruthy());
    if (!desktop) expect(screen.getByRole("tab", { name: "PR review" }).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tabpanel", { name: "PR review" })).getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe("https://github.com/Org/repo/pull/123");
    if (desktop) fireEvent.click(within(screen.getByRole("tablist", { name: "Session view" })).getByRole("tab", { name: "Preview" }));
    else {
      fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
      fireEvent.click(screen.getByRole("tab", { name: /^Workspace/ }));
    }
    fireEvent.click(within(target).getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Review pull request" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(screen.getByRole("tabpanel", { name: "PR review" })).toBeTruthy());
    if (!desktop) expect(screen.getByRole("tab", { name: "PR review" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("terminal").textContent).toBe("target");
  });
});

it("keeps terminal controls mounted when a compact desktop switches from preview to Terminal", async () => {
  state.sessions = [session("ordinary", "Regular shell", { preview: { id: "12345678-1234-4234-8234-123456789abc", files: [{ id: "22345678-2234-4234-8234-123456789abc", fileName: "demo.html", kind: "html" }] } })];
  dashboard();
  fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
  const tabs = screen.getByRole("tablist", { name: "Session view" });
  expect(within(tabs).getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(within(tabs).getByRole("tab", { name: "Terminal" }));
  expect(within(screen.getByRole("tabpanel", { name: "Terminal" })).getByText("Session controls")).toBeTruthy();
});

describe("mobile copy and paste wiring", () => {
  function openOrdinary() {
    dashboard();
    fireEvent.click(screen.getByRole("button", { name: /Regular shell/ }));
  }

  it("opens the copy sheet with a terminal snapshot and closes it", async () => {
    openOrdinary();
    expect(screen.queryByRole("dialog", { name: "Copy terminal text" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    const dialog = await screen.findByRole("dialog", { name: "Copy terminal text" });
    expect(state.terminalGetText).toHaveBeenCalledWith({ maxLines: 2000 });
    expect(dialog.textContent).toContain("terminal output");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Copy terminal text" })).toBeNull());
  });

  it("routes the key-bar paste to the terminal handle", () => {
    openOrdinary();
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    expect(state.terminalPaste).toHaveBeenCalledWith("pasted\ntext");
  });

  function openSession(id: string, name: string, fields: Partial<Session> = {}) {
    state.sessions.push(session(id, name, fields));
    dashboard();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
  }

  it("sends Ctrl+V to the terminal once for a claude session's Host key", () => {
    openSession("claude-agent", "Claude agent", { shellType: "claude" });
    fireEvent.click(screen.getByRole("button", { name: "Host" }));
    expect(state.terminalSendInput).toHaveBeenCalledTimes(1);
    expect(state.terminalSendInput).toHaveBeenCalledWith("\x16");
    expect(state.terminalPaste).not.toHaveBeenCalled();
  });

  it("shows the Host key for a zai session", () => {
    openSession("zai-agent", "Zai agent", { shellType: "zai" });
    expect(screen.getByRole("button", { name: "Host" })).toBeTruthy();
  });

  it("hides the Host key for a shell session", () => {
    openOrdinary();
    expect(screen.queryByRole("button", { name: "Host" })).toBeNull();
  });

  it("hides the Host key for a session without shellType", () => {
    openSession("untyped", "Untyped session", { shellType: undefined });
    expect(screen.queryByRole("button", { name: "Host" })).toBeNull();
  });
});

describe("preview auto-open rule", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  it("auto-opens only on no-preview-before; a closed preview stays closed until its revision changes", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const initialPreview = { id: uuid(1), files: [{ id: uuid(11), fileName: "a.html", kind: "html" as const }] };
    state.sessions = [session("ordinary", "Regular shell", { preview: initialPreview })];
    const { rerender } = dashboard();
    fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
    // initially auto-opened: Open preview button not present, Preview tab selected
    expect(screen.queryByRole("button", { name: "Open preview" })).toBeNull();
    const tabs = screen.getByRole("tablist", { name: "Session view" });
    expect(within(tabs).getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
    // close preview
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open preview" })).toBeTruthy());
    // file added: new set id, extra file
    const extended = { id: uuid(2), files: [{ id: uuid(11), fileName: "a.html", kind: "html" as const }, { id: uuid(12), fileName: "c.html", kind: "html" as const }] };
    state.sessions = [session("ordinary", "Regular shell", { preview: extended })];
    rerender(<Dashboard client={ { securityRuntime: { ownerId: "00000000-0000-4000-8000-000000000001", state: (bridgeId: string) => ({ bridgeId, status: "ready", endpoint: null }), snapshot: () => [], onChange: () => () => {}, bridge: () => ({ permissions: ["read", "control"] }), identity: { endpoint: { id: "approved-browser" } } } } as unknown as MessageClient } connectionStatus="connected" connectionError={null} userId="user" token="test" centrifugoUrl="ws://localhost" transport={null} onDisconnect={vi.fn()} localMode={false} />);
    await act(async () => {});
    // a changed revision is new content: it shows again instead of staying hidden
    expect(screen.queryByRole("button", { name: "Open preview" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close preview" })).toBeTruthy();
  });

  it("re-opens after clear then re-add", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const p1 = { id: uuid(1), files: [{ id: uuid(11), fileName: "a.html", kind: "html" as const }] };
    state.sessions = [session("ordinary", "Regular shell", { preview: p1 })];
    const { rerender } = dashboard();
    fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
    expect(screen.queryByRole("button", { name: "Open preview" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open preview" })).toBeTruthy());
    // clear
    state.sessions = [session("ordinary", "Regular shell", {})];
    rerender(<Dashboard client={ { securityRuntime: { ownerId: "00000000-0000-4000-8000-000000000001", state: (bridgeId: string) => ({ bridgeId, status: "ready", endpoint: null }), snapshot: () => [], onChange: () => () => {}, bridge: () => ({ permissions: ["read", "control"] }), identity: { endpoint: { id: "approved-browser" } } } } as unknown as MessageClient } connectionStatus="connected" connectionError={null} userId="user" token="test" centrifugoUrl="ws://localhost" transport={null} onDisconnect={vi.fn()} localMode={false} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Open preview" })).toBeNull();
    // re-add
    const p2 = { id: uuid(3), files: [{ id: uuid(21), fileName: "x.md", kind: "markdown" as const }] };
    state.sessions = [session("ordinary", "Regular shell", { preview: p2 })];
    rerender(<Dashboard client={ { securityRuntime: { ownerId: "00000000-0000-4000-8000-000000000001", state: (bridgeId: string) => ({ bridgeId, status: "ready", endpoint: null }), snapshot: () => [], onChange: () => () => {}, bridge: () => ({ permissions: ["read", "control"] }), identity: { endpoint: { id: "approved-browser" } } } } as unknown as MessageClient } connectionStatus="connected" connectionError={null} userId="user" token="test" centrifugoUrl="ws://localhost" transport={null} onDisconnect={vi.fn()} localMode={false} />);
    await act(async () => {});
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open preview" })).toBeNull());
    expect(screen.getByRole("tablist", { name: "Session view" })).toBeTruthy();
  });
});

describe("trackIdleSince", () => {
  const activity = (entries: Array<[string, Pick<SessionActivity, "activity">]>): Map<string, Pick<SessionActivity, "activity">> => new Map(entries);

  it("stamps the moment a session becomes idle and keeps it while it stays idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-13T10:00:00.000Z"));
    try {
      const first = trackIdleSince({}, activity([["a", { activity: "thinking" }]]));
      expect(first).toEqual({});
      const stamped = trackIdleSince(first, activity([["a", { activity: "idle" }]]));
      expect(stamped.a).toBe("2026-11-13T10:00:00.000Z");
      // Still idle, possibly via a new activity map: the stamp survives.
      expect(trackIdleSince(stamped, activity([["a", { activity: "idle" }]]))).toBe(stamped);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the stamp when the session stops being idle or leaves the map", () => {
    const stamped = { a: "2026-11-13T10:00:00.000Z", b: "2026-11-13T09:00:00.000Z" };
    expect(trackIdleSince(stamped, activity([["a", { activity: "tool_use" }], ["b", { activity: "idle" }]]))).toEqual({ b: "2026-11-13T09:00:00.000Z" });
    expect(trackIdleSince(stamped, activity([["b", { activity: "idle" }]]))).toEqual({ b: "2026-11-13T09:00:00.000Z" });
    expect(trackIdleSince(stamped, activity([]))).toEqual({});
  });

  it("returns the previous object untouched when nothing changed", () => {
    const stamped = { a: "2026-11-13T10:00:00.000Z" };
    expect(trackIdleSince(stamped, activity([["a", { activity: "idle" }]]))).toBe(stamped);
    expect(trackIdleSince({}, activity([["a", { activity: "thinking" }]]))).toEqual({});
  });
});
