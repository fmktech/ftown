// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import { Dashboard } from "./Dashboard";
import { buildBridgeCommand } from "@/lib/bridge-command";
import type { MessageClient } from "@/lib/message-client";
import type { ReactNode } from "react";

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
}));

vi.mock("@/hooks/useSessions", () => ({ useSessions: () => ({
  sessions: state.sessions, createSession: state.createSession, stopSession: state.stopSession,
  retrySession: state.retrySession, removeSession: state.removeSession,
  renameSession: vi.fn(), setSessionParent: vi.fn(), refreshSessions: vi.fn(),
}) }));
vi.mock("@/hooks/useBridgeRpc", () => ({ useBridgeRpc: () => ({ bridgeExec: state.bridgeExec,
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: { sessionId: "ordinary", attention: null, sequence: 0 } }),
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
function dashboard(localMode = false) {
  const client = { securityRuntime: { ownerId: "00000000-0000-4000-8000-000000000001", state: (bridgeId: string) => ({ bridgeId, status: "ready", endpoint: null }),
    snapshot: () => [], onChange: () => () => {}, identity: { endpoint: { id: "approved-browser" } } } } as unknown as MessageClient;
  return render(<Dashboard client={client} connectionStatus="connected" connectionError={null}
    userId="user" token="test" centrifugoUrl="ws://localhost" transport={null} onDisconnect={vi.fn()} localMode={localMode} />);
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  vi.clearAllMocks();
  state.activity = new Map();
  state.createSession.mockResolvedValue(undefined);
  state.sessions = [
    session("ordinary", "Regular shell"),
    session("legacy", "Preserved run", { loopId: "retired-loop", status: "error" }),
    session("worker", "project-t42-implement"),
  ];
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  window.requestAnimationFrame = vi.fn(() => 1);
  window.cancelAnimationFrame = vi.fn();
});
afterEach(() => { cleanup(); Reflect.deleteProperty(navigator, "clipboard"); Reflect.deleteProperty(document, "execCommand"); });

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
    fireEvent.click(screen.getByTitle("Create a new session"));
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
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(screen.getByTitle("Create a new session"));
    fireEvent.click(screen.getByRole("button", { name: "Submit new session" }));
    await waitFor(() => expect(screen.getByTestId("terminal").textContent).toBe("created-id"));
    expect(screen.getByRole("button", { name: "Terminal" }).classList.contains("mobile-tab-active")).toBe(true);
    expect(screen.getByRole("button", { name: /Regular shell/ })).toBeTruthy();
    expect(state.clearSessionAttention).not.toHaveBeenCalled();
  });

  it("keeps the selected session and mobile workspace when creation fails", async () => {
    state.createSession.mockRejectedValue(new Error("Create rejected"));
    dashboard();
    fireEvent.click(await screen.findByRole("button", { name: /Regular shell/ }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(screen.getByTitle("Create a new session"));
    fireEvent.click(screen.getByRole("button", { name: "Submit new session" }));
    await waitFor(() => expect(state.createSession).toHaveBeenCalled());
    expect(screen.getByTestId("terminal").textContent).toBe("ordinary");
    expect(screen.getByRole("button", { name: "Workspace" }).classList.contains("mobile-tab-active")).toBe(true);
    expect(screen.getByText("New Session")).toBeTruthy();
    expect(state.clearSessionAttention).not.toHaveBeenCalled();
  });
});

describe("attention navigation preserves the request", () => {
  it.each([true, false])("keeps attention through original, shortcut and repeat selection without an overlay (desktop=%s)", desktop => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const { container } = dashboard();
    const original = Array.from(container.querySelectorAll<HTMLButtonElement>('button[draggable="true"]'))
      .find(row => row.textContent?.includes("Regular shell"))!;
    fireEvent.click(original);
    // A newly arriving notice on the already selected session must also survive
    // selecting that same session again.
    state.activity = new Map([["ordinary", { activity: "idle", attention: {
      type: "agent_needs_input", title: "Review requested", message: "Inspect the result before continuing", receivedAt: 10,
    } }]]);
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const shortcut = screen.getByRole("button", { name: "Regular shell: Review requested. Inspect the result before continuing" });
    for (const control of [original, original, shortcut]) {
      fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
      fireEvent.click(control);
      expect(screen.getByTestId("terminal").textContent).toBe("ordinary");
      expect(screen.getByRole("button", { name: "Terminal" }).classList.contains("mobile-tab-active")).toBe(true);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: "Dismiss attention for Regular shell" })).toBeTruthy();
      expect(state.clearSessionAttention).not.toHaveBeenCalled();
    }
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss attention for Regular shell" }));
    expect(state.clearSessionAttention).toHaveBeenCalledExactlyOnceWith("ordinary");
    expect(screen.getByRole("button", { name: "Workspace" }).classList.contains("mobile-tab-active")).toBe(true);
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
    expect(within(nav).getByRole("button", { name: "Open security" }).title).toBe("Security: computer and browser access");
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
        fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
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
