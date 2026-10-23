// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import { Dashboard } from "./Dashboard";
import { buildBridgeCommand } from "@/lib/bridge-command";

const state = vi.hoisted(() => ({
  sessions: [] as Session[],
  bridges: [{ clientId: "client-a", bridgeId: "bridge-a", hostname: "alpha", connectedAt: "2026-10-16T00:00:00Z" }],
  activity: new Map<string, never>(),
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
vi.mock("@/hooks/useBridgeRpc", () => ({ useBridgeRpc: () => ({ bridgeExec: state.bridgeExec }) }));
vi.mock("@/hooks/useBridges", () => ({ useBridges: () => ({ bridges: state.bridges, hasBridges: true, prepareLocalAccess: vi.fn() }) }));
vi.mock("@/hooks/useAllSessionEvents", () => ({ useAllSessionEvents: () => ({
  sessionActivity: state.activity, markSessionIdle: vi.fn(), clearSessionAttention: state.clearSessionAttention,
}) }));
vi.mock("./Terminal", () => ({ Terminal: ({ sessionId }: { sessionId: string | null }) => <div data-testid="terminal">{sessionId}</div> }));
vi.mock("./MobileControlBar", () => ({ MobileControlBar: () => <div>Session controls</div> }));
vi.mock("./NewSessionModal", () => ({ NewSessionModal: ({ isOpen, onSubmit, onClose }: {
  isOpen: boolean; onSubmit: (prompt: string, options: { shellType: "shell" }) => Promise<void>; onClose: () => void;
}) => isOpen ? <div>New Session<button onClick={() => { void onSubmit("", { shellType: "shell" }).then(onClose).catch(() => {}); }}>Submit new session</button></div> : null }));
vi.mock("./CloudConnectionNotice", () => ({ CloudConnectionNotice: () => null }));

function session(id: string, name: string, fields: Partial<Session> = {}): Session {
  return { id, name, bridgeId: "bridge-a", status: "running", shellType: "shell", createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", ...fields };
}
function dashboard(localMode = false) {
  return render(<Dashboard client={null} connectionStatus="connected" connectionError={null}
    userId="user" token="test" centrifugoUrl="ws://localhost" transport={null} onDisconnect={vi.fn()} localMode={localMode} />);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
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
    expect(state.clearSessionAttention).toHaveBeenLastCalledWith("created-id");
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
    expect(state.clearSessionAttention).toHaveBeenCalledTimes(1);
  });
});
