// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpBridgeApproval } from "@security/protocol";
import { McpSecureApproval, type McpConsentDetails } from "./McpSecureApproval";

const mocks = vi.hoisted(() => ({
  identity: { status: "ready", identity: {}, bridges: [] },
  states: new Map<string, string>(), execute: vi.fn(),
}));
vi.mock("@/hooks/useBrowserIdentity", () => ({ useBrowserIdentity: () => mocks.identity }));
vi.mock("@/hooks/useCentrifugo", () => ({ useCentrifugo: () => ({ client: { executeSecurity: mocks.execute } }) }));
vi.mock("@/lib/secure-endpoint-runtime", () => ({ SecureEndpointRuntime: class {
  state(id: string) { return { bridgeId: id, status: mocks.states.get(id) ?? "unpaired" }; }
  onChange() { return () => {}; }
  dispose() {}
} }));

const ownerId = "00000000-0000-4000-8000-000000000001";
const details = (): McpConsentDetails => ({ clientName: "Test client", redirectUri: "https://client.example/callback", scopes: ["mcp:read"], machines: ["one", "two"],
  security: { requestId: "request", grantId: "grant", endpoint: { version: 1, id: "mcp-endpoint", ownerId, kind: "mcp", publicKey: "public" },
    permissions: ["read"], expiresAt: new Date(Date.now() + 60000).toISOString(), activeExpiresAt: new Date(Date.now() + 86400000).toISOString() } });
const devices = [{ bridgeId: "one", hostname: "Laptop" }, { bridgeId: "two", hostname: "Desktop" }];
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
beforeEach(() => { mocks.states.clear(); mocks.execute.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("encrypted MCP consent", () => {
  it("blocks selected unpaired/offline computers and never approves anything implicitly", async () => {
    mocks.states.set("one", "ready"); mocks.states.set("two", "offline");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ token: "token", centrifugoUrl: "wss://relay.example" })));
    render(<McpSecureApproval requestId="request" ownerId={ownerId} email="owner@example.com" details={details()} devices={devices} />);
    const approve = screen.getByRole("button", { name: "Approve encrypted access" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Select all listed/));
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Selected offline or unpaired bridges block completion/)).toBeTruthy();
    expect(mocks.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Desktop/));
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
  });

  it("binds receipts to the exact candidate, permissions and fixed expiry for each selected bridge", async () => {
    mocks.states.set("one", "ready"); mocks.states.set("two", "ready");
    const request = details();
    const approvals = devices.map(device => ({ bridgeId: device.bridgeId, bridge: { ...request.security.endpoint, kind: "bridge" }, receipt: { type: "ftown_encrypted" } })) as unknown as McpBridgeApproval[];
    mocks.execute.mockResolvedValueOnce(approvals[0]).mockResolvedValueOnce(approvals[1]);
    const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(url === "/api/auth/token"
      ? response({ token: "token", centrifugoUrl: "wss://relay.example" }) : response({}, false)));
    vi.stubGlobal("fetch", fetcher);
    render(<McpSecureApproval requestId="request" ownerId={ownerId} email="owner@example.com" details={request} devices={devices} />);
    fireEvent.click(screen.getByLabelText(/Select all listed/)); fireEvent.click(screen.getByRole("button", { name: "Approve encrypted access" }));
    await screen.findByRole("alert");
    expect(mocks.execute.mock.calls.map(([command]) => command)).toEqual(devices.map(device => ({ type: "security_approve_mcp", bridgeId: device.bridgeId, approval: request.security })));
    const completion = fetcher.mock.calls.find(([url]) => url === "/api/mcp/consent");
    expect(completion).toBeTruthy();
    expect(JSON.parse(completion![1].body)).toEqual({ requestId: "request", machines: ["one", "two"], approvals, decision: "approve" });
  });

  it("does not submit consent if any bridge fails to produce its receipt", async () => {
    mocks.states.set("one", "ready"); mocks.states.set("two", "ready");
    mocks.execute.mockRejectedValue({ code: "bridge_offline", message: "PRIVATE RAW FAILURE" });
    const fetcher = vi.fn().mockResolvedValue(response({ token: "token", centrifugoUrl: "wss://relay.example" })); vi.stubGlobal("fetch", fetcher);
    render(<McpSecureApproval requestId="request" ownerId={ownerId} email="owner@example.com" details={details()} devices={devices} />);
    fireEvent.click(screen.getByLabelText(/Select all listed/)); fireEvent.click(screen.getByRole("button", { name: "Approve encrypted access" }));
    await screen.findByRole("alert");
    expect(fetcher.mock.calls.some(([url]) => url === "/api/mcp/consent")).toBe(false);
    expect(screen.queryByText(/PRIVATE RAW FAILURE/)).toBeNull();
  });
});
