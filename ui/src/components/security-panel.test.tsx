// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovedEndpoint, BridgeInvitation, SecurityEvent, SecurityPage } from "@security/protocol";
import { SecurityPanel, type SecurityBridge, type SecurityCommandExecutor } from "./SecurityPanel";
import { SecurityActivity } from "./SecurityActivity";
import { SecurityDevices } from "./SecurityDevices";
import type { AccountSecurityClient, AccountSecuritySnapshot } from "@/lib/account-security-client";
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
    fireEvent.click(await screen.findByRole("button", { name: /^Browser My browser \(this browser\):/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke My browser" }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Revoking this browser disconnects/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith({ type: "security_revoke", bridgeId: "bridge-one", endpointId: "self" }));
    await waitFor(() => expect(screen.queryByText("My browser · This browser")).toBeNull());
    expect(screen.queryByRole("button", { name: /^Browser My browser/ })).toBeNull();
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
    expect(screen.getByRole("tab", { name: "Access" }).getAttribute("aria-selected")).toBe("true");
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Access" }), { key: "ArrowRight" });
    await screen.findByText(/No MCP activity/);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Access" }).getAttribute("aria-selected")).toBe("true");
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


describe("Computer-scoped access map", () => {
  it("uses actual browser grants and keeps MCP/CLI management separate from account authority", async () => {
    const cli = { ...device("cli", "Local CLI"), endpoint: { ...device("cli", "Local CLI").endpoint, kind: "local-cli" as const }, source: "local" as const };
    const mcp = { ...device("mcp", "My MCP client"), endpoint: { ...device("mcp", "My MCP client").endpoint, kind: "mcp" as const }, permissions: ["read"] as const, expiresAt: "2030-01-01T00:00:00Z" };
    const execute = mockExecutor().mockResolvedValue({ devices: [device("self", "My browser"), device("phone", "Phone"), cli, { ...mcp, permissions: [...mcp.permissions] }] });
    const view = render(<SecurityDevices bridge={bridge} currentEndpointId="self" currentComputerIds={new Set([bridge.bridgeId])} execute={execute} />);
    await screen.findByRole("button", { name: "Create secure invitation" });
    expect(screen.getByRole("heading", { name: "Computer access" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Account access" })).toBeNull();
    expect(screen.getByText(/Approvals apply only to this computer/)).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Approved devices" })).getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Browser My MCP client/ })).toBeNull();
    const otherClients = screen.getByRole("list", { name: "Other approved clients" });
    expect(within(otherClients).getByText("local-cli · read, control, admin")).toBeTruthy();
    expect(within(otherClients).getByText("mcp · read")).toBeTruthy();
    expect(within(otherClients).getByRole("button", { name: "Revoke My MCP client" })).toBeTruthy();
    expect(view.container.querySelectorAll('[data-certainty="current"]')).toHaveLength(3);
    expect(view.container.querySelector('[data-current-device="bridge"]')).not.toBeNull();
    expect(view.container.querySelector("button button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share with my other browsers" })).toBeNull();
    expect(execute).toHaveBeenCalledExactlyOnceWith({ type: "security_devices", bridgeId: bridge.bridgeId });
  });

  it("keeps account-source grants non-revocable and does not offer prohibited browser invitations", async () => {
    const execute = mockExecutor().mockResolvedValue({ devices: [{ ...device("self", "Account browser"), source: "account" }] });
    render(<SecurityDevices bridge={bridge} currentEndpointId="self" execute={execute} />);
    await screen.findByText(/Manage account browsers from the hosted dashboard/);
    expect(screen.queryByRole("button", { name: "Create secure invitation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Browser Account browser/ }));
    expect(screen.queryByRole("button", { name: "Revoke Account browser" })).toBeNull();
    expect(screen.getByText(/manage its account-wide access from the hosted dashboard/)).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("never offers admin actions to a read-only browser", async () => {
    const execute = mockExecutor().mockResolvedValue({ devices: [{ ...device("self", "Read browser"), permissions: ["read"] }, device("phone", "Phone")] });
    render(<SecurityDevices bridge={bridge} currentEndpointId="self" execute={execute} />);
    await screen.findByText(/An approved administrator browser/);
    fireEvent.click(screen.getByRole("button", { name: /^Browser Phone:/ }));
    expect(screen.queryByRole("button", { name: "Revoke Phone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create secure invitation" })).toBeNull();
  });

  it("creates a private computer-only invitation only after its explicit admin action", async () => {
    const invitation: BridgeInvitation = { version: 1, invitationId: "invite-one", ownerId: "owner", bridgeId: bridge.bridgeId,
      bridge: { ...device("bridge-key", "").endpoint, kind: "bridge" }, secret: "private-fixture-secret", expiresAt: "2030-01-01T00:00:00Z", relayUrl: null, localOrigin: null };
    const execute = mockExecutor().mockResolvedValueOnce({ devices: [device("self", "My browser")] }).mockResolvedValueOnce(invitation);
    render(<SecurityDevices bridge={bridge} currentEndpointId="self" execute={execute} />);
    await screen.findByRole("button", { name: "Create secure invitation" });
    expect(execute).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Device label" }), { target: { value: "Phone" } });
    fireEvent.click(screen.getByRole("button", { name: "Create secure invitation" }));
    const link = await screen.findByRole("textbox", { name: "Private invitation link" }) as HTMLInputElement;
    expect(execute).toHaveBeenLastCalledWith({ type: "security_invite", bridgeId: bridge.bridgeId, label: "Phone" });
    const url = new URL(link.value);
    expect(url.pathname).toBe("/connect"); expect(url.search).toBe("");
    expect(JSON.parse(decodeURIComponent(url.hash.slice("#invite=".length)))).toEqual(invitation);
  });

  it("ignores an old bridge roster and drops all trusted edges while offline", async () => {
    let finish!: (value: { devices: ApprovedEndpoint[] }) => void;
    const execute = mockExecutor().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ devices: [device("self", "New browser")] });
    const view = render(<SecurityDevices bridge={bridge} currentEndpointId="self" execute={execute} />);
    const next = { ...bridge, bridgeId: "next", label: "Next computer", security: { ...bridge.security, bridgeId: "next" } };
    view.rerender(<SecurityDevices bridge={next} currentEndpointId="self" execute={execute} />);
    await screen.findByRole("button", { name: /^Browser New browser/ });
    await act(async () => finish({ devices: [device("old", "Old private label")] }));
    expect(screen.queryByText("Old private label")).toBeNull();
    view.rerender(<SecurityDevices bridge={{ ...next, security: { ...next.security, status: "offline" } }} currentEndpointId="self" execute={execute} />);
    expect(view.container.querySelector('[data-certainty="current"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Create secure invitation" })).toBeNull();
    expect(screen.getByText(/while its FTown bridge is running/)).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("expires a displayed browser grant without granting it a lasting solid edge", async () => {
    vi.useFakeTimers();
    try {
      const execute = mockExecutor().mockResolvedValue({ devices: [device("self", "My browser"), { ...device("phone", "Phone"), expiresAt: new Date(Date.now() + 100).toISOString() }] });
      let view!: ReturnType<typeof render>;
      await act(async () => { view = render(<SecurityDevices bridge={bridge} currentEndpointId="self" execute={execute} />); });
      expect(view.container.querySelector('[data-access-edge="browser:phone"]')).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(101));
      expect(view.container.querySelector('[data-access-edge="browser:phone"]')).toBeNull();
      expect(screen.getByRole("button", { name: /Browser Phone: Approval expired/ })).toBeTruthy();
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

});

describe("Account devices", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ requests: [] }), { status: 200 }))); });
  function accountFixture(count: number, offline = false) {
    const devices = Array.from({ length: count }, (_, index) => ({ endpoint: device(String(index), "").endpoint, label: index ? "Phone" : "Laptop", signingPublicKey: "signing-public", approvedAt: "2026-10-25T00:00:00Z" }));
    const state: AccountSecuritySnapshot = { status: "ready", identity: { endpoint: devices[0].endpoint, keyPair: {} as CryptoKeyPair }, signing: null, legacyBridges: [], historyExists: true, code: null, offline,
      trust: { history: {} as NonNullable<AccountSecuritySnapshot["trust"]>["history"], lastServerReadAt: 1, lastObservedAt: 1,
        checkpoint: { version: 1, ownerId: "owner", rootId: "root", revision: 0, head: "head", devices, bridges: [], revokedDeviceIds: [], revokedBridgeIds: [] } } };
    const revoke = vi.fn().mockResolvedValue(undefined);
    const client = { snapshot: () => state, subscribe: () => () => {}, revoke, refresh: vi.fn() } as unknown as AccountSecurityClient;
    return { state, client, revoke };
  }
  it("overlays browser and computer names, then resets without changing access identity", async () => {
    const f = accountFixture(1);
    Object.assign(f.client, { ownerId: "owner" });
    f.state.trust!.checkpoint.bridges = [{ bridgeId: bridge.bridgeId, endpoint: { ...device("bridge-key", "").endpoint, kind: "bridge" }, label: "Signed computer", approvedAt: "2026-10-25T00:00:00Z" }];
    const names: { kind: "browser" | "bridge"; id: string; name: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "PUT") {
        const request = JSON.parse(String(options.body));
        const index = names.findIndex(item => item.kind === request.kind && item.id === request.id);
        if (index >= 0) names.splice(index, 1);
        if (request.name !== null) names.push(request);
        return reply({ name: request.name === null ? null : request });
      }
      return reply({ names: [...names], eligible: [{ kind: "browser", id: "0" }, { kind: "bridge", id: bridge.bridgeId }] });
    }));
    const execute = mockExecutor().mockResolvedValue({ devices: [{ ...device("0", "Laptop"), source: "account" }] });
    const view = render(<SecurityDevices currentEndpointId="0" bridges={[bridge]} execute={execute} accountClient={f.client} accountState={f.state} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename Laptop" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Browser" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: /^Browser Browser \(this browser\):/ });
    expect(view.container.querySelector('[data-access-edge="browser:0"]')?.getAttribute("data-certainty")).toBe("current");
    fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename My laptop" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Office 💻" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: /^Computer Office 💻:/ });
    fireEvent.click(screen.getByRole("button", { name: "Reset name" }));
    await screen.findByRole("button", { name: /^Computer My laptop:/ });
    expect(f.state.trust!.checkpoint.bridges[0].label).toBe("Signed computer");
    expect(f.state.trust!.checkpoint.devices[0].label).toBe("Laptop");
  });
  it("puts private CLI recovery instructions on an independent computer without implying account sharing", () => {
    const f = accountFixture(1); const execute = mockExecutor();
    render(<SecurityDevices bridge={{ ...bridge, security: { ...bridge.security, status: "unpaired" } }} bridges={[{ ...bridge, security: { ...bridge.security, status: "unpaired" } }]} currentEndpointId="0" execute={execute} accountClient={f.client} accountState={f.state} />);
    expect(screen.getByText("ftown security invite")).toBeTruthy();
    expect(screen.getByText(/On that computer, while its FTown bridge is running/)).toBeTruthy();
    expect(screen.getByText(/Open the printed private link in this browser/)).toBeTruthy();
    expect(screen.getByText(/does not restore account signing keys or share the computer/)).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });
  it("keeps paused account trust from suggesting a per-computer approval bypass", () => {
    const f = accountFixture(1); f.state.status = "error"; f.state.code = "account_device_revoked";
    const unpaired = { ...bridge, security: { ...bridge.security, status: "unpaired" as const } };
    render(<SecurityDevices bridge={unpaired} bridges={[unpaired]} currentEndpointId="0" execute={mockExecutor()} accountClient={f.client} accountState={f.state} />);
    expect(screen.queryByText("ftown security invite")).toBeNull();
  });
  it("keeps the last account administrator and offline device revocation disabled", () => {
    const f = accountFixture(1); const execute = mockExecutor();
    const view = render(<SecurityDevices currentEndpointId="0" execute={execute} accountClient={f.client} accountState={f.state} />);
    expect((screen.getByRole("button", { name: "Remove access for Laptop" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/last account administrator/)).toBeTruthy(); expect(execute).not.toHaveBeenCalled();
    const offline = accountFixture(2, true);
    view.rerender(<SecurityDevices currentEndpointId="0" execute={execute} accountClient={offline.client} accountState={offline.state} />);
    fireEvent.click(screen.getByRole("button", { name: /^Browser Phone:/ }));
    expect((screen.getByRole("button", { name: "Remove access for Phone" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Showing verified stored account trust/)).toBeTruthy();
  });
  it("requires explicit account-wide confirmation and never sends a per-bridge revoke", async () => {
    const f = accountFixture(2); const execute = mockExecutor();
    render(<SecurityDevices currentEndpointId="0" execute={execute} accountClient={f.client} accountState={f.state} />);
    fireEvent.click(screen.getByRole("button", { name: /^Browser Phone:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove access for Phone" })); expect(f.revoke).not.toHaveBeenCalled();
    expect(screen.getByText(/offline computers apply it when they reconnect/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove access" }));
    await waitFor(() => expect(f.revoke).toHaveBeenCalledWith("1")); expect(execute).not.toHaveBeenCalled();
  });
  it("keeps roster-only computers unlinked and reveals sharing only after selecting the computer", async () => {
    const f = accountFixture(2);
    const endpoint = { ...device("bridge-key", "").endpoint, kind: "bridge" as const };
    f.state.legacyBridges = [{ bridgeId: bridge.bridgeId, endpoint, permissions: ["read", "control", "admin"] }];
    f.state.trust!.checkpoint.bridges = [{ bridgeId: bridge.bridgeId, endpoint, label: "Computer", approvedAt: "2026-10-25T00:00:00Z" }];
    const execute = mockExecutor().mockRejectedValue({ code: "bridge_offline" });
    const view = render(<SecurityDevices currentEndpointId="0" bridges={[bridge]} execute={execute} accountClient={f.client} accountState={f.state} />);
    await screen.findByText("Setup needs attention");
    expect(screen.queryByRole("button", { name: "Share with my other browsers" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
    expect(screen.queryByText("Shared with your approved browsers")).toBeNull();
    expect(screen.getByRole("button", { name: "Share with my other browsers" })).toBeTruthy();
    expect(view.container.querySelector('[data-access-edge="bridge:bridge-one"]')).toBeNull();
    expect(screen.getByText(/browsers outside your account approvals lose access/)).toBeTruthy();
  });

  it("waits for a roster-only computer to connect and verify without requesting another approval", async () => {
    const f = accountFixture(1);
    const endpoint = { ...device("bridge-key", "").endpoint, kind: "bridge" as const };
    f.state.trust!.checkpoint.bridges = [{ bridgeId: bridge.bridgeId, endpoint, label: "Computer", approvedAt: "2026-10-25T00:00:00Z" }];
    let complete!: (value: { devices: ApprovedEndpoint[] }) => void;
    const execute = mockExecutor().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const props = { currentEndpointId: "0", execute, accountClient: f.client, accountState: f.state };
    const view = render(<SecurityDevices {...props} bridges={[{ ...bridge, security: { ...bridge.security, status: "connecting" } }]} />);
    expect(screen.getByText("Checking access…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
    expect(screen.getByText("Waiting for this computer to connect.")).toBeTruthy();
    expect(screen.queryByText(/Finish sharing from a browser/)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    view.rerender(<SecurityDevices {...props} bridges={[bridge]} />);
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(screen.getByText("Checking how access is set up…")).toBeTruthy();
    expect(screen.queryByText(/Finish sharing from a browser/)).toBeNull();
    await act(async () => complete({ devices: [{ ...device("0", "Laptop"), source: "account" }] }));
    expect(screen.getByText("Shared with your approved browsers")).toBeTruthy();
  });

  it("offers setup guidance only after an independent result and refresh advice after verification failure", async () => {
    const f = accountFixture(1);
    const endpoint = { ...device("bridge-key", "").endpoint, kind: "bridge" as const };
    f.state.trust!.checkpoint.bridges = [{ bridgeId: bridge.bridgeId, endpoint, label: "Computer", approvedAt: "2026-10-25T00:00:00Z" }];
    const execute = mockExecutor().mockResolvedValueOnce({ devices: [device("0", "Laptop")] }).mockRejectedValue({ code: "bridge_offline" });
    render(<SecurityDevices currentEndpointId="0" bridges={[bridge]} execute={execute} accountClient={f.client} accountState={f.state} />);
    await screen.findByText("Finishing setup");
    fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
    expect(screen.getByText(/Finish sharing from a browser already approved/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh access" }));
    await screen.findByText("Setup needs attention");
    expect(screen.getByText("Could not verify access. Reconnect this computer, then refresh access.")).toBeTruthy();
    expect(screen.queryByText(/Finish sharing from a browser/)).toBeNull();
  });

  it("keeps three shared computers identifiable in one list, including a long hostname", async () => {
    const f = accountFixture(2);
    const longName = "my-computer-with-an-unusually-long-continuous-hostname-".repeat(3);
    const computers = ["Work laptop", "Home computer", longName].map((label, index): SecurityBridge => ({
      ...bridge, bridgeId: `computer-${index}`, label, security: { ...bridge.security, bridgeId: `computer-${index}` },
    }));
    const execute = mockExecutor().mockResolvedValue({ devices: [{ ...device("0", "Laptop"), source: "account" }] });
    render(<SecurityDevices currentEndpointId="0" bridges={computers} execute={execute} accountClient={f.client} accountState={f.state} />);
    const list = screen.getByRole("list", { name: "Computer access" });
    await waitFor(() => expect(within(list).getAllByText("Shared with your approved browsers")).toHaveLength(3));
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByRole("button", { name: `Computer ${longName}: Shared with your approved browsers. Connected` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share with my other browsers" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Browser Phone:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove access for Phone" }));
    expect(screen.getByRole("group", { name: "Confirm account device revocation" })).toBeTruthy();
    expect(f.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm account device revocation" })).toBeNull();
  });

  it("confirms account sharing once per connection and qualifies offline or changed-key status", async () => {
    const f = accountFixture(1); const execute = mockExecutor().mockResolvedValue({ devices: [{ ...device("0", "Laptop"), source: "account" }] });
    const props = { currentEndpointId: "0", execute, accountClient: f.client, accountState: f.state };
    const view = render(<SecurityDevices {...props} bridges={[bridge]} />);
    await screen.findByText("Shared with your approved browsers");
    expect(view.container.querySelector('[data-access-edge="bridge:bridge-one"]')?.getAttribute("data-certainty")).toBe("current");
    view.rerender(<SecurityDevices {...props} bridges={[{ ...bridge }]} />);
    expect(execute).toHaveBeenCalledTimes(1);
    view.rerender(<SecurityDevices {...props} bridges={[{ ...bridge, security: { ...bridge.security, status: "offline" } }]} />);
    expect(screen.getByText("Previously shared · reconnect to verify")).toBeTruthy();
    expect(view.container.querySelector('[data-access-edge="bridge:bridge-one"]')?.getAttribute("data-certainty")).toBe("historical");
    view.rerender(<SecurityDevices {...props} bridges={[{ ...bridge, security: { ...bridge.security, status: "key_changed" } }]} />);
    expect(screen.getByText("Access needs attention")).toBeTruthy();
    expect(view.container.querySelector('[data-access-edge="bridge:bridge-one"]')).toBeNull();
    expect(screen.queryByText("Shared with your approved browsers")).toBeNull();
  });

  it("qualifies a previous confirmation after a failed refresh and overrides it with roster revocation", async () => {
    const f = accountFixture(1);
    const execute = mockExecutor().mockResolvedValueOnce({ devices: [{ ...device("0", "Laptop"), source: "account" }] }).mockRejectedValue({ code: "bridge_offline" });
    const props = { currentEndpointId: "0", bridges: [bridge], execute, accountClient: f.client, accountState: f.state };
    const view = render(<SecurityDevices {...props} />);
    await screen.findByText("Shared with your approved browsers");
    fireEvent.click(screen.getByRole("button", { name: "Refresh access" }));
    await screen.findByText("Previously shared · check access");
    expect(view.container.querySelector('[data-access-edge="bridge:bridge-one"]')).toBeNull();
    expect(screen.queryByText("Shared with your approved browsers")).toBeNull();
    f.state.trust!.checkpoint.revokedBridgeIds = [bridge.bridgeId];
    view.rerender(<SecurityDevices {...props} bridges={[{ ...bridge }]} />);
    expect(screen.getByText("Access needs attention")).toBeTruthy();
  });

  it("removes a previously current edge immediately on signed bridge revocation before runtime catches up", async () => {
    const f = accountFixture(1); const execute = mockExecutor().mockResolvedValue({ devices: [{ ...device("0", "Laptop"), source: "account" }] });
    const props = { currentEndpointId: "0", bridges: [bridge], execute, accountClient: f.client, accountState: f.state };
    const view = render(<SecurityDevices {...props} />);
    await screen.findByText("Shared with your approved browsers");
    expect(view.container.querySelector('[data-access-edge="bridge:bridge-one"]')?.getAttribute("data-certainty")).toBe("current");
    f.state.trust!.checkpoint.revokedBridgeIds = [bridge.bridgeId];
    view.rerender(<SecurityDevices {...props} />);
    expect(view.container.querySelector('[data-access-edge="bridge:bridge-one"]')).toBeNull();
    expect(screen.getByText("Access needs attention")).toBeTruthy();
  });

  it("removes current edges while a fresh sharing check is pending and while account access is paused", async () => {
    const f = accountFixture(1); let finish!: (value: { devices: ApprovedEndpoint[] }) => void;
    const execute = mockExecutor().mockResolvedValueOnce({ devices: [{ ...device("0", "Laptop"), source: "account" }] })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const props = { currentEndpointId: "0", bridges: [bridge], execute, accountClient: f.client, accountState: f.state };
    const view = render(<SecurityDevices {...props} />);
    await screen.findByText("Shared with your approved browsers");
    fireEvent.click(screen.getByRole("button", { name: "Refresh access" }));
    await screen.findByText("Checking sharing…");
    expect(view.container.querySelector('[data-access-edge="bridge:bridge-one"]')).toBeNull();
    await act(async () => finish({ devices: [{ ...device("0", "Laptop"), source: "account" }] }));
    await screen.findByText("Shared with your approved browsers");
    f.state.status = "error"; f.state.code = "account_trust_rollback";
    view.rerender(<SecurityDevices {...props} />);
    expect(view.container.querySelector('[data-certainty="current"]')).toBeNull();
  });

  it("ignores a late sharing probe after the computer connection changes", async () => {
    const f = accountFixture(1); let complete!: (value: { devices: ApprovedEndpoint[] }) => void;
    const execute = mockExecutor().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const view = render(<SecurityDevices currentEndpointId="0" bridges={[bridge]} execute={execute} accountClient={f.client} accountState={f.state} />);
    view.rerender(<SecurityDevices currentEndpointId="0" bridges={[{ ...bridge, security: { ...bridge.security, status: "offline" } }]} execute={execute} accountClient={f.client} accountState={f.state} />);
    await act(async () => { complete({ devices: [{ ...device("0", "Laptop"), source: "account" }] }); });
    expect(screen.queryByText(/Shared with your approved browsers|Previously shared/)).toBeNull();
  });

  it("keeps another computer's pending verification alive while sharing one computer", async () => {
    const f = accountFixture(1);
    const endpoint = { ...device("bridge-key", "").endpoint, kind: "bridge" as const };
    f.state.legacyBridges = [{ bridgeId: bridge.bridgeId, endpoint, permissions: ["read", "control", "admin"] }];
    const other: SecurityBridge = { ...bridge, bridgeId: "bridge-two", label: "Other laptop", security: { ...bridge.security, bridgeId: "bridge-two" } };
    let finishOther!: (value: { devices: ApprovedEndpoint[] }) => void;
    const execute = mockExecutor().mockImplementation(command => command.bridgeId === other.bridgeId
      ? new Promise(resolve => { finishOther = resolve; }) : Promise.resolve({ devices: [device("0", "Laptop")] }));
    f.client.migrate = vi.fn().mockResolvedValue(undefined);
    const view = render(<SecurityDevices currentEndpointId="0" bridges={[bridge, other]} execute={execute} accountClient={f.client} accountState={f.state} />);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Share with my other browsers" }));
    await waitFor(() => expect(view.container.querySelector(`[data-account-migration="${bridge.bridgeId}"]`)).toBeNull());
    await act(async () => finishOther({ devices: [{ ...device("0", "Laptop"), source: "account" }] }));
    const otherCard = view.container.querySelector(`[data-computer-access="${other.bridgeId}"]`)!;
    expect(otherCard.textContent).toContain("Shared with your approved browsers");
    expect(otherCard.textContent).not.toContain("Checking sharing");
  });

  it("does not let a bootstrap-time independent probe overwrite successful sharing", async () => {
    const f = accountFixture(1); const listeners = new Set<() => void>();
    const endpoint = { ...device("bridge-key", "").endpoint, kind: "bridge" as const };
    let current: AccountSecuritySnapshot = { ...f.state, status: "unapproved", trust: null, historyExists: false,
      legacyBridges: [{ bridgeId: bridge.bridgeId, endpoint, permissions: ["read", "control", "admin"] }] };
    f.client.snapshot = () => current;
    f.client.subscribe = listener => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    let finishSharing!: () => void; let finishProbe!: (value: { devices: ApprovedEndpoint[] }) => void;
    f.client.migrate = vi.fn(async () => {
      current = { ...current, status: "ready", trust: f.state.trust, historyExists: true };
      listeners.forEach(listener => listener());
      await new Promise<void>(resolve => { finishSharing = resolve; });
    });
    const execute = mockExecutor().mockImplementation(() => new Promise(resolve => { finishProbe = resolve; }));
    render(<SecurityDevices currentEndpointId="0" bridges={[bridge]} execute={execute} accountClient={f.client} accountState={current} />);
    fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Share with my other browsers" }));
    await screen.findByRole("button", { name: "Sharing computer…" });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await act(async () => finishSharing());
    await screen.findByText("Shared with your approved browsers");
    await act(async () => finishProbe({ devices: [device("0", "Laptop")] }));
    expect(screen.getByText("Shared with your approved browsers")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share with my other browsers" })).toBeNull();
  });

  it.each(["account_device_revoked", "account_trust_rollback"] as const)("shows the current browser's actual paused or revoked state (%s)", code => {
    const f = accountFixture(1); f.state.status = "error"; f.state.code = code;
    render(<SecurityDevices currentEndpointId="0" execute={mockExecutor()} accountClient={f.client} accountState={f.state} />);
    expect(screen.getByRole("button", { name: code === "account_device_revoked" ? /^Browser Laptop \(this browser\): Access revoked/ : /^Browser Laptop \(this browser\): Access paused/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Browser Laptop.*Account approval needed/ })).toBeNull();
  });

  it("consolidates toolbar and guarded actions inside the selected node without duplicate external panels", () => {
    const f = accountFixture(2); const execute = mockExecutor();
    const view = render(<SecurityDevices currentEndpointId="0" execute={execute} accountClient={f.client} accountState={f.state} />);
    const map = screen.getByRole("region", { name: "Browser and computer access map" });
    expect(map.contains(screen.getByRole("button", { name: "Refresh access" }))).toBe(true);
    const details = screen.getByRole("region", { name: "Selected access details" });
    expect(details.closest("[data-access-card]")?.getAttribute("data-access-card")).toBe("browser:0");
    expect(screen.getAllByText("This browser")).toHaveLength(1);
    expect(view.container.querySelector("button button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Browser Phone:/ }));
    const remove = screen.getByRole("button", { name: "Remove access for Phone" });
    fireEvent.click(remove);
    expect(screen.getByRole("group", { name: "Confirm account device revocation" }).closest("[data-access-card]")?.getAttribute("data-access-card")).toBe("browser:1");
    expect(f.revoke).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it("falls back to the current browser when a selected browser disappears or identity changes", () => {
    const f = accountFixture(2); const execute = mockExecutor();
    const view = render(<SecurityDevices currentEndpointId="0" execute={execute} accountClient={f.client} accountState={f.state} />);
    fireEvent.click(screen.getByRole("button", { name: /^Browser Phone:/ }));
    expect(screen.getByRole("button", { name: "Remove access for Phone" })).toBeTruthy();
    f.state.trust!.checkpoint.devices = f.state.trust!.checkpoint.devices.filter(device => device.endpoint.id !== "1");
    view.rerender(<SecurityDevices currentEndpointId="0" execute={execute} accountClient={f.client} accountState={f.state} />);
    expect(screen.getByRole("button", { name: "Remove access for Laptop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove access for Phone" })).toBeNull();
    const other = { ...f.state.trust!.checkpoint.devices[0], endpoint: device("2", "New browser").endpoint, label: "New browser" };
    f.state.trust!.checkpoint.devices.push(other); f.state.identity = { ...f.state.identity!, endpoint: other.endpoint };
    view.rerender(<SecurityDevices currentEndpointId="2" execute={execute} accountClient={f.client} accountState={f.state} />);
    expect(screen.getByRole("button", { name: /^Browser New browser/ }).getAttribute("aria-pressed")).toBe("true");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps a pending or failed adoption retryable even after its signed roster addition", async () => {
    const f = accountFixture(1); let current = f.state; const listeners = new Set<() => void>();
    const pin = { bridgeId: bridge.bridgeId, endpoint: { ...device("bridge-key", "").endpoint, kind: "bridge" as const }, permissions: ["read", "control", "admin"] as const };
    current = { ...current, legacyBridges: [{ ...pin, permissions: [...pin.permissions] }] };
    f.client.snapshot = () => current;
    f.client.subscribe = listener => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    let rejectAdoption: (error: unknown) => void = () => {};
    const migrate = vi.fn().mockImplementationOnce(async () => {
      current = { ...current, trust: { ...current.trust!, checkpoint: { ...current.trust!.checkpoint,
        bridges: [{ bridgeId: pin.bridgeId, endpoint: pin.endpoint, label: "Computer", approvedAt: "2026-10-25T00:00:00Z" }] } } };
      for (const listener of listeners) listener();
      await new Promise<void>((_resolve, reject) => { rejectAdoption = reject; });
    }).mockResolvedValue(undefined);
    f.client.migrate = migrate;
    const execute = mockExecutor().mockResolvedValue({ devices: [device("0", "Laptop")] });
    const view = render(<SecurityDevices currentEndpointId="0" bridges={[bridge]} execute={execute} accountClient={f.client} accountState={current} />);
    fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Share with my other browsers" }));
    await screen.findByRole("button", { name: "Sharing computer…" });
    expect(view.container.querySelector(`[data-account-migration="${pin.bridgeId}"]`)).not.toBeNull();
    await act(async () => { rejectAdoption({ code: "account_storage_unavailable" }); });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Sharing is not confirmed/)).toBeTruthy();
    expect(view.container.querySelector(`[data-computer-access="${pin.bridgeId}"]`)!.textContent).not.toContain("Checking sharing");
    const retry = screen.getByRole("button", { name: "Share with my other browsers" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false); fireEvent.click(retry);
    await waitFor(() => expect(view.container.querySelector(`[data-account-migration="${pin.bridgeId}"]`)).toBeNull());
    expect(migrate).toHaveBeenCalledTimes(2);
  });

});
