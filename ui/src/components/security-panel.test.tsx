// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovedEndpoint, SecurityEvent, SecurityPage } from "@security/protocol";
import { SecurityPanel, type SecurityBridge, type SecurityCommandExecutor } from "./SecurityPanel";
import { SecurityActivity } from "./SecurityActivity";
import { SecurityDevices } from "./SecurityDevices";
import { EncryptionDiagram } from "./EncryptionDiagram";

// Vitest's Mock utility erases generic return correlation; keep that assertion
// at the test-double boundary rather than weakening production executor types.
function mockExecutor() {
  const mock = vi.fn<SecurityCommandExecutor>();
  return mock as typeof mock & SecurityCommandExecutor;
}

const bridge: SecurityBridge = { bridgeId: "bridge-one", label: "My laptop", security: { bridgeId: "bridge-one", status: "ready", endpoint: null } };
const event: SecurityEvent = {
  version: 1, id: "event-one", actionId: "action-one", parentActionId: null, ownerId: "owner", source: "gateway",
  bridgeId: "bridge-one", clientId: "client-one", grantId: "grant", endpointId: "endpoint", tool: "terminal_input",
  operation: "input", sessionId: "session", startedAt: "2026-10-24T12:00:00Z", finishedAt: null, status: "unknown", errorCode: "outcome_unknown", mutating: true,
};
const page = (events: SecurityEvent[] = [event], nextCursor: string | null = null): SecurityPage => ({ events, nextCursor, retentionDays: 30, maxEvents: 10000, oldestAvailableAt: "2026-10-01T00:00:00Z", truncated: true, reset: false });
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const device = (id: string, label: string): ApprovedEndpoint => ({ endpoint: { version: 1, id, ownerId: "owner", kind: "browser", publicKey: "public" }, label, permissions: ["read", "control", "admin"], approvedAt: "2026-10-24T12:00:00Z", grantId: null, expiresAt: null });

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Security activity", () => {
  it("loads gateway history without online bridges, labels uncertainty and retains it after refresh failure", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(page())).mockResolvedValueOnce(reply({ code: "audit_unavailable", error: "SECRET RAW ERROR" }, false));
    vi.stubGlobal("fetch", fetcher);
    const execute = mockExecutor();
    render(<SecurityActivity bridgeId="" execute={execute} gatewayAvailable />);
    await screen.findByText("Outcome unknown");
    expect(screen.getByText(/Execution may have occurred/)).toBeTruthy();
    expect(screen.getByText(/30 days, up to 10,000/)).toBeTruthy();
    expect(screen.getByText(/Older activity has been removed/)).toBeTruthy();
    expect(fetcher.mock.calls[0][0]).toBe("/api/security/activity?limit=50");
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    await screen.findByRole("alert");
    expect(screen.getByText("terminal_input · input")).toBeTruthy();
    expect(screen.queryByText(/SECRET RAW ERROR/)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("loads older pages and merges an updated event without duplicating its identity", async () => {
    const older = { ...event, id: "older", actionId: "action-older", tool: "sessions_list", startedAt: "2026-10-23T12:00:00Z", status: "succeeded" as const };
    const fetcher = vi.fn().mockResolvedValueOnce(reply(page([event], "older-cursor")))
      .mockResolvedValueOnce(reply(page([{ ...event, status: "succeeded", finishedAt: "2026-10-24T12:01:00Z" }, older])));
    vi.stubGlobal("fetch", fetcher);
    render(<SecurityActivity bridgeId="bridge-one" selectedBridge={bridge} execute={mockExecutor()} gatewayAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Load older activity" }));
    await screen.findByText("sessions_list · input");
    expect(screen.getAllByText("terminal_input · input")).toHaveLength(1);
    expect(screen.queryByText("Outcome unknown")).toBeNull();
    expect(String(fetcher.mock.calls[1][0])).toContain("cursor=older-cursor");
  });

  it("aborts a previous bridge filter and never shows its late response", async () => {
    let resolveOld!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(reply(page([])));
    vi.stubGlobal("fetch", fetcher);
    const execute = mockExecutor();
    const view = render(<SecurityActivity bridgeId="bridge-one" selectedBridge={bridge} execute={execute} gatewayAvailable />);
    const oldSignal = fetcher.mock.calls[0][1].signal as AbortSignal;
    view.rerender(<SecurityActivity bridgeId="bridge-two" selectedBridge={{ ...bridge, bridgeId: "bridge-two" }} execute={execute} gatewayAvailable />);
    await screen.findByText(/No MCP activity/);
    expect(oldSignal.aborted).toBe(true);
    resolveOld(reply(page()));
    await waitFor(() => expect(screen.queryByText("terminal_input · input")).toBeNull());
  });
});

describe("Security devices and dialog", () => {
  it("requires explicit confirmation before self-revocation and targets only the selected bridge", async () => {
    const execute = mockExecutor().mockResolvedValueOnce({ devices: [device("self", "My browser"), device("other", "Phone")] }).mockResolvedValueOnce({ endpointId: "self", revoked: true });
    render(<SecurityDevices bridge={bridge} currentEndpointId="self" execute={execute} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke My browser" }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Revoking this browser disconnects/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith({ type: "security_revoke", bridgeId: "bridge-one", endpointId: "self" }));
    await waitFor(() => expect(screen.queryByText("My browser · This browser")).toBeNull());
    expect(screen.getByText("Phone")).toBeTruthy();
  });

  it("offers offline guidance without sending privileged commands", () => {
    const execute = mockExecutor();
    render(<SecurityDevices bridge={{ ...bridge, security: { ...bridge.security, status: "offline" } }} currentEndpointId="self" execute={execute} />);
    expect(screen.getByText(/Device management needs an encrypted connection/)).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });

  it("restores opener focus and supports keyboard tabs without navigation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(page([]))));
    const onClose = vi.fn();
    const execute = mockExecutor();
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const view = render(<SecurityPanel open onClose={onClose} bridges={[]} currentEndpointId="self" execute={execute} />);
    await screen.findByText(/No MCP activity/);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Devices" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/Choose a bridge to inspect its approved devices/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close security" }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount(); expect(document.activeElement).toBe(opener); opener.remove();
  });

  it("documents the trusted MCP endpoint, wrapping secret, visible metadata and provider boundary", () => {
    render(<EncryptionDiagram />);
    expect(screen.getByText("Hosted MCP gateway")).toBeTruthy();
    expect(screen.getByText(/wrapping secret is stored separately/)).toBeTruthy();
    expect(screen.getByText(/routing metadata remains visible/)).toBeTruthy();
    expect(screen.getByText(/does not provide anonymity/)).toBeTruthy();
  });
});
