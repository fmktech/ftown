// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovedEndpoint, BridgeInvitation, EndpointPublic } from "@security/protocol";
import type { LedgerAuthority, LedgerBridge, LedgerCheckpoint, LedgerDevice, LedgerOperation, LedgerTransition, Signed } from "@security/ledger/protocol";
import type { LedgerClient, LedgerClientSnapshot } from "@/lib/ledger-client";
import { SecurityPanel, securityErrorMessage, type SecurityBridge, type SecurityCommandExecutor } from "./SecurityPanel";
import { SecurityDevices } from "./SecurityDevices";
import { useAccountSecurity } from "@/hooks/useAccountSecurity";
import { EncryptionDiagram } from "./EncryptionDiagram";

// The page's ledger client is replaced by a fake that models the real client's passkey prompts (see FakeLedger).
const ledger = vi.hoisted(() => ({ snapshot: null as LedgerClientSnapshot | null, client: null as unknown, listeners: new Set<() => void>(), calls: 0 }));
vi.mock("@/hooks/useLedger", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { ledger.listeners.add(listener); return () => { ledger.listeners.delete(listener); }; };
  return { useLedger: () => {
    ledger.calls++;
    const snapshot = useSyncExternalStore(subscribe, () => ledger.snapshot as LedgerClientSnapshot);
    return { client: ledger.client as LedgerClient, snapshot };
  } };
});

// Vitest's Mock utility erases generic return correlation; keep that assertion
// at the test-double boundary rather than weakening production executor types.
function mockExecutor() {
  const mock = vi.fn<SecurityCommandExecutor>();
  return mock as typeof mock & SecurityCommandExecutor;
}

const bridge: SecurityBridge = { bridgeId: "bridge-one", label: "My laptop", security: { bridgeId: "bridge-one", status: "ready", endpoint: null } };
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const device = (id: string, label: string): ApprovedEndpoint => ({ endpoint: { version: 1, id, ownerId: "owner", kind: "browser", publicKey: "public" }, label, permissions: ["read", "control", "admin"], approvedAt: "2026-10-24T12:00:00Z", grantId: null, expiresAt: null });

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  ledger.calls = 0; ledger.snapshot = null; ledger.client = null; ledger.listeners.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

  it("restores opener focus and renders access management without an activity tab", () => {
    const onClose = vi.fn();
    const execute = mockExecutor();
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const view = render(<SecurityPanel open onClose={onClose} bridges={[]} currentEndpointId="self" execute={execute} />);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByText(/Choose a bridge to inspect its approved devices/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close security" }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount(); expect(document.activeElement).toBe(opener); opener.remove();
  });

  it("documents visible routing metadata and the trust boundary", () => {
    render(<EncryptionDiagram />);
    expect(screen.queryByText(/MCP/)).toBeNull();
    expect(screen.getByText(/routing metadata remains visible/)).toBeTruthy();
    expect(screen.getByText(/does not provide anonymity/)).toBeTruthy();
  });
});


describe("Computer-scoped access map", () => {
  it("uses actual browser grants and keeps CLI management separate from account authority", async () => {
    const cli = { ...device("cli", "Local CLI"), endpoint: { ...device("cli", "Local CLI").endpoint, kind: "local-cli" as const }, source: "local" as const };
    const execute = mockExecutor().mockResolvedValue({ devices: [device("self", "My browser"), device("phone", "Phone"), cli] });
    const view = render(<SecurityDevices bridge={bridge} currentEndpointId="self" currentComputerIds={new Set([bridge.bridgeId])} execute={execute} />);
    await screen.findByRole("button", { name: "Create secure invitation" });
    expect(screen.getByRole("heading", { name: "Computer access" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Account access" })).toBeNull();
    expect(screen.getByText(/Approvals apply only to this computer/)).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Approved devices" })).getAllByRole("button")).toHaveLength(2);
    const otherClients = screen.getByRole("list", { name: "Other approved clients" });
    expect(within(otherClients).getByText("local-cli · read, control, admin")).toBeTruthy();
    expect(within(otherClients).getByRole("button", { name: "Revoke Local CLI" })).toBeTruthy();
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

// ---- Account mode (passkey ledger) ----

const ACCOUNT = "A".repeat(43);
const AT = Date.parse("2026-11-01T00:00:00Z");
const endpoint = (id: string, kind: "browser" | "bridge" = "browser"): EndpointPublic => ({ version: 1, id, ownerId: ACCOUNT, kind, publicKey: `point-${id}` });
const authority = (credentialId: string, label: string): LedgerAuthority => ({ credentialId, publicKey: `key-${credentialId}`, label, addedAt: AT });
const ledgerDevice = (id: string, label: string): LedgerDevice => ({ endpoint: endpoint(id), authPublicKey: `auth-${id}`, label, approvedAt: AT });
const ledgerBridge = (bridgeId: string, label: string): LedgerBridge => ({ bridgeId, endpoint: endpoint(`${bridgeId}-key`, "bridge"), authPublicKey: `auth-${bridgeId}`, label, approvedAt: AT });
const checkpoint = (overrides: Partial<LedgerCheckpoint> = {}): LedgerCheckpoint => ({
  version: 2, accountId: ACCOUNT, revision: 4, head: "head-4", authorities: [authority("cred-1", "MacBook Touch ID")],
  devices: [ledgerDevice("self", "Laptop"), ledgerDevice("phone", "Phone")], bridges: [ledgerBridge("bridge-one", "Computer")],
  revokedDeviceIds: [], revokedBridgeIds: [], ...overrides,
});
const record = (revision: number, operation: LedgerOperation): Signed<LedgerTransition> => ({
  payload: { type: "ftown_account_transition", version: 2, accountId: ACCOUNT, revision, previousHead: `head-${revision - 1}`, issuedAt: AT + revision, credentialId: "cred-1", operation },
  signature: { authenticatorData: "data", clientDataJSON: "client", signature: "signature" },
});

function publish(next: LedgerClientSnapshot) { ledger.snapshot = next; for (const listener of Array.from(ledger.listeners)) listener(); }
function current(): LedgerClientSnapshot { return ledger.snapshot as LedgerClientSnapshot; }

/**
 * Models LedgerClient's ceremonies: every write signs once, and when the account has several passkeys and the signer was not chosen
 * (selectPasskey) it first runs an identification ceremony too — the two-prompt case the panel must never reach in one click.
 */
class FakeLedger {
  prompts = 0;
  private signs() {
    const authorities = current().checkpoint!.authorities;
    if (authorities.length > 1 && !authorities.some(item => item.credentialId === current().signer)) this.prompts++;
    this.prompts++;
  }
  private settleLocal(kind: "deviceIds" | "bridgeIds", id: string) {
    const localOnly = current().localOnly;
    publish({ ...current(), localOnly: { ...localOnly, [kind]: localOnly[kind].filter(item => item !== id) } });
  }
  private change(update: (value: LedgerCheckpoint) => LedgerCheckpoint) { publish({ ...current(), checkpoint: update(current().checkpoint!) }); }
  refresh = vi.fn(async () => {});
  selectPasskey = vi.fn(async () => { this.prompts++; publish({ ...current(), signer: "cred-1" }); });
  revokeBridge = vi.fn(async (bridgeId: string) => {
    this.signs(); this.settleLocal("bridgeIds", bridgeId);
    this.change(value => ({ ...value, bridges: value.bridges.filter(item => item.bridgeId !== bridgeId), revokedBridgeIds: [...new Set([...value.revokedBridgeIds, bridgeId])] }));
  });
  revokeDevice = vi.fn(async (endpointId: string) => {
    this.signs(); this.settleLocal("deviceIds", endpointId);
    this.change(value => ({ ...value, devices: value.devices.filter(item => item.endpoint.id !== endpointId), revokedDeviceIds: [...new Set([...value.revokedDeviceIds, endpointId])] }));
  });
  append = vi.fn(async (_operation: LedgerOperation) => { this.signs(); });
  addAuthorityStart = vi.fn(async (_input: { label: string }) => { this.prompts++; publish({ ...current(), pending: "authority_created" }); });
  addAuthorityConsent = vi.fn(async () => { this.prompts++; publish({ ...current(), pending: "authority_consented" }); });
  addAuthorityFinish = vi.fn(async () => {
    this.signs();
    publish({ ...current(), pending: "none", checkpoint: { ...current().checkpoint!, authorities: [...current().checkpoint!.authorities, authority("cred-2", "Security key")] } });
  });
  dismissDiscarded = vi.fn(() => { publish({ ...current(), discarded: [] }); });
  rotateDeviceIdentity = vi.fn(async () => {});
}

function mountLedger(snapshot: Partial<LedgerClientSnapshot> = {}): FakeLedger {
  ledger.snapshot = { status: "ready", checkpoint: checkpoint(), discarded: [], localOnly: { deviceIds: [], bridgeIds: [] }, signer: null, pending: "none", ...snapshot };
  const fake = new FakeLedger();
  ledger.client = fake;
  return fake;
}
function renderAccount(props: Partial<ComponentProps<typeof SecurityDevices>> = {}) {
  return render(<SecurityDevices accountId={ACCOUNT} currentEndpointId="self" bridges={[bridge]} execute={mockExecutor()} {...props} />);
}
/** Clicks and returns how many passkey prompts that one click caused. */
async function click(fake: FakeLedger, element: HTMLElement): Promise<number> {
  const before = fake.prompts;
  await act(async () => { fireEvent.click(element); });
  return fake.prompts - before;
}
const edge = (container: HTMLElement, key: string) => container.querySelector(`[data-access-edge="${key}"]`)?.getAttribute("data-certainty") ?? null;

describe("Account security from the passkey ledger", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => reply({ names: [], eligible: [] }))); });

  it("maps browsers, the account and computers from the trusted checkpoint, with this browser marked", async () => {
    const fake = mountLedger({ checkpoint: checkpoint({ bridges: [ledgerBridge("bridge-one", "Computer"), ledgerBridge("bridge-two", "Desk")] }) });
    const stray: SecurityBridge = { bridgeId: "stray", label: "Unknown box", security: { bridgeId: "stray", status: "unpaired", endpoint: null } };
    const execute = mockExecutor();
    const view = renderAccount({ bridges: [bridge, stray], execute, currentComputerIds: new Set([bridge.bridgeId]) });
    await waitFor(() => expect(fake.refresh).toHaveBeenCalledOnce());
    expect(screen.getByRole("heading", { name: "Account access" })).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Browser Laptop (this browser): In your account" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Browser Phone: In your account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Computer My laptop (this computer): In your account. Connected" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Computer Desk: In your account · reconnect to verify. Offline" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Computer Unknown box: Not in your account. Not connected" })).toBeTruthy();
    expect(edge(view.container, "browser:self")).toBe("current");
    expect(edge(view.container, "bridge:bridge-one")).toBe("current");
    expect(edge(view.container, "bridge:bridge-two")).toBe("historical");
    expect(edge(view.container, "bridge:stray")).toBeNull();
    expect(within(screen.getByRole("list", { name: "Account passkeys" })).getByText("MacBook Touch ID")).toBeTruthy();
    // v1 account UI is gone: no invitations, pending approvals or sharing migration; and no bridge command is sent.
    expect(screen.queryByRole("button", { name: "Create secure invitation" })).toBeNull();
    expect(screen.queryByText(/Add \/ review/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Share with my other browsers" })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(fake.prompts).toBe(0);
  });

  describe("Remove computer", () => {
    const CONFIRM = "Remove My laptop from your account? It loses access immediately. To use it again, pair it as a new computer.";
    const open = () => {
      fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
      fireEvent.click(screen.getByRole("button", { name: "Remove computer My laptop" }));
    };
    it("shows the exact confirm text and signs revoke_bridge once, with one passkey prompt, only after confirming", async () => {
      const fake = mountLedger(); renderAccount();
      open();
      expect(screen.getByText(CONFIRM)).toBeTruthy();
      expect(within(screen.getByRole("group", { name: "Confirm computer removal" })).getByText("Signed name: “Computer” · ID bridge-o")).toBeTruthy();
      expect(fake.revokeBridge).not.toHaveBeenCalled(); expect(fake.prompts).toBe(0);
      expect(await click(fake, screen.getByRole("button", { name: "Confirm remove computer" }))).toBe(1);
      expect(fake.revokeBridge).toHaveBeenCalledExactlyOnceWith(bridge.bridgeId);
      expect(screen.queryByRole("group", { name: "Confirm computer removal" })).toBeNull();
      expect(screen.getByRole("button", { name: "Computer My laptop: Removed from your account. Connected" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove computer My laptop" })).toBeNull();
    });
    it("does nothing when cancelled", () => {
      const fake = mountLedger(); renderAccount();
      open(); fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(fake.revokeBridge).not.toHaveBeenCalled(); expect(screen.queryByText(CONFIRM)).toBeNull();
    });
    it("asks for the device's passkey as its own click when the account has several, so no click prompts twice", async () => {
      const fake = mountLedger({ checkpoint: checkpoint({ authorities: [authority("cred-1", "MacBook Touch ID"), authority("cred-2", "Security key")] }) });
      renderAccount(); open();
      expect(screen.queryByRole("button", { name: "Confirm remove computer" })).toBeNull();
      const groups = screen.getAllByRole("button", { name: "Choose passkey" });
      expect(await click(fake, groups[0])).toBe(1);
      expect(fake.selectPasskey).toHaveBeenCalledOnce(); expect(fake.revokeBridge).not.toHaveBeenCalled();
      expect(await click(fake, screen.getByRole("button", { name: "Confirm remove computer" }))).toBe(1);
      expect(fake.revokeBridge).toHaveBeenCalledExactlyOnceWith(bridge.bridgeId);
      expect(screen.queryByRole("button", { name: "Choose passkey" })).toBeNull();
    });
    it("skips the passkey choice when the client already knows this device's passkey", async () => {
      const fake = mountLedger({ signer: "cred-2", checkpoint: checkpoint({ authorities: [authority("cred-1", "MacBook Touch ID"), authority("cred-2", "Security key")] }) });
      renderAccount(); open();
      expect(screen.queryByRole("button", { name: "Choose passkey" })).toBeNull();
      expect(await click(fake, screen.getByRole("button", { name: "Confirm remove computer" }))).toBe(1);
      expect(fake.selectPasskey).not.toHaveBeenCalled(); expect(fake.revokeBridge).toHaveBeenCalledOnce();
    });
    it("shows the mapped error and keeps the computer when the passkey prompt is cancelled", async () => {
      const fake = mountLedger(); fake.revokeBridge.mockRejectedValueOnce(new Error("passkey_cancelled"));
      renderAccount(); open();
      await click(fake, screen.getByRole("button", { name: "Confirm remove computer" }));
      expect(screen.getByRole("alert").textContent).toBe(securityErrorMessage(new Error("passkey_cancelled")));
      expect(screen.getByRole("button", { name: "Remove computer My laptop" })).toBeTruthy();
    });
    it("shows the rate-limited text when the removal is rejected with rate_limited", async () => {
      const fake = mountLedger(); fake.revokeBridge.mockRejectedValueOnce(Object.assign(new Error("rate_limited"), { code: "rate_limited" }));
      renderAccount(); open();
      await click(fake, screen.getByRole("button", { name: "Confirm remove computer" }));
      expect(screen.getByRole("alert").textContent).toBe("Too many changes in a short time. Wait a few minutes and try again.");
    });
    it("offers no removal for a computer outside the account and explains how to pair it", () => {
      mountLedger({ checkpoint: checkpoint({ bridges: [] }) }); renderAccount();
      fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
      expect(screen.queryByRole("button", { name: /^Remove computer/ })).toBeNull();
      expect(screen.getByText(/This computer is not in your account/)).toBeTruthy();
    });
  });

  it("removes another browser and this browser with their own confirmations, one passkey prompt each", async () => {
    const fake = mountLedger(); renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /^Browser Phone:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove browser Phone" }));
    expect(screen.getByText("Remove Phone from your account? It loses access to your computers immediately. To use it again, sign in on it with your passkey.")).toBeTruthy();
    expect(fake.revokeDevice).not.toHaveBeenCalled();
    expect(await click(fake, screen.getByRole("button", { name: "Confirm remove browser" }))).toBe(1);
    expect(fake.revokeDevice).toHaveBeenCalledExactlyOnceWith("phone");
    expect(screen.queryByRole("button", { name: /^Browser Phone:/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove browser Laptop" }));
    expect(screen.getByText(/^Remove this browser from your account\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fake.revokeDevice).toHaveBeenCalledOnce();
  });

  it("adds another passkey in three clicks: create, consent, approve — one passkey prompt each", async () => {
    const fake = mountLedger(); renderAccount();
    const add = screen.getByRole("group", { name: "Add another passkey" });
    fireEvent.change(within(add).getByRole("textbox", { name: "New passkey name" }), { target: { value: "Security key" } });
    expect(await click(fake, within(add).getByRole("button", { name: "Create passkey" }))).toBe(1);
    expect(fake.addAuthorityStart).toHaveBeenCalledExactlyOnceWith({ label: "Security key" });
    expect(within(add).getByText(/Step 2 of 3/)).toBeTruthy();
    expect(await click(fake, within(add).getByRole("button", { name: "Confirm new passkey" }))).toBe(1);
    expect(fake.addAuthorityConsent).toHaveBeenCalledOnce();
    expect(within(add).getByText(/Step 3 of 3/)).toBeTruthy();
    expect(await click(fake, within(add).getByRole("button", { name: "Approve new passkey" }))).toBe(1);
    expect(fake.addAuthorityFinish).toHaveBeenCalledOnce();
    expect(within(screen.getByRole("list", { name: "Account passkeys" })).getByText("Security key")).toBeTruthy();
    expect(within(add).getByRole("button", { name: "Create passkey" })).toBeTruthy();
    expect(fake.prompts).toBe(3);
  });

  it("refuses a signing write while the passkey choice is pending, then signs once it is made", async () => {
    const fake = mountLedger({ checkpoint: checkpoint({ authorities: [authority("cred-1", "MacBook Touch ID"), authority("cred-2", "Security key")] }) });
    const hook = renderHook(() => useAccountSecurity());
    const write = vi.fn(async (client: LedgerClient) => { await client.revokeBridge("bridge-one"); });
    expect(hook.result.current.needsSigner).toBe(true);
    let done = true;
    await act(async () => { done = await hook.result.current.run("write", write, { signs: true }); });
    expect(done).toBe(false); expect(write).not.toHaveBeenCalled(); expect(hook.result.current.error).toBe("passkey_choice_required");
    await act(async () => { await hook.result.current.chooseSigner(); });
    expect(hook.result.current.needsSigner).toBe(false);
    await act(async () => { done = await hook.result.current.run("write", write, { signs: true }); });
    expect(done).toBe(true); expect(fake.prompts).toBe(2);
  });

  it("follows the client's signer: a wrong-credential failure that clears it asks for the choice again", async () => {
    const fake = mountLedger({ checkpoint: checkpoint({ authorities: [authority("cred-1", "MacBook Touch ID"), authority("cred-2", "Security key")] }) });
    const hook = renderHook(() => useAccountSecurity());
    await act(async () => { await hook.result.current.chooseSigner(); });
    expect(hook.result.current.needsSigner).toBe(false);
    fake.revokeBridge.mockImplementationOnce(async () => { fake.prompts++; publish({ ...current(), signer: null }); throw new Error("passkey_wrong_credential"); });
    await act(async () => { await hook.result.current.run("write", client => client.revokeBridge("bridge-one"), { signs: true }); });
    expect(hook.result.current.error).toBe("passkey_wrong_credential");
    expect(hook.result.current.needsSigner).toBe(true);
  });

  it("runs one action at a time", async () => {
    mountLedger();
    const hook = renderHook(() => useAccountSecurity());
    let release!: () => void;
    const first = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const second = vi.fn(async () => {});
    let firstRun!: Promise<boolean>; let secondDone = true;
    await act(async () => { firstRun = hook.result.current.run("first", first); secondDone = await hook.result.current.run("second", second); });
    expect(secondDone).toBe(false); expect(second).not.toHaveBeenCalled(); expect(hook.result.current.busy).toBe("first");
    await act(async () => { release(); await firstRun; });
    expect(hook.result.current.busy).toBeNull();
  });

  describe("Removals saved on this browser only", () => {
    const LOCAL = "Removed on this browser only — not yet applied to your account";
    it("keeps a local-only browser in the list with its signed name and signs the removal again with one prompt", async () => {
      const fake = mountLedger(); renderAccount();
      expect(screen.getByRole("button", { name: "Browser Phone: In your account" })).toBeTruthy();
      // The client revoked it locally, but the account (raw chain) still lists it.
      act(() => publish({ ...current(), checkpoint: checkpoint({ devices: [ledgerDevice("self", "Laptop")], revokedDeviceIds: ["phone"] }), localOnly: { deviceIds: ["phone"], bridgeIds: [] } }));
      expect(screen.getByRole("region", { name: "Removals not applied" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: `Browser Phone: ${LOCAL}` }));
      const warning = screen.getByRole("group", { name: "Removal not applied" });
      expect(within(warning).getByText("Signed name: “Phone” · ID phone")).toBeTruthy();
      expect(await click(fake, within(warning).getByRole("button", { name: "Sign removal again" }))).toBe(1);
      expect(fake.revokeDevice).toHaveBeenCalledExactlyOnceWith("phone");
      expect(screen.queryByRole("button", { name: /^Browser Phone:/ })).toBeNull();
      expect(screen.queryByRole("region", { name: "Removals not applied" })).toBeNull();
    });
    it("never shows a local-only computer as removed from the account", async () => {
      const fake = mountLedger({ checkpoint: checkpoint({ bridges: [], revokedBridgeIds: ["bridge-one"] }), localOnly: { deviceIds: [], bridgeIds: ["bridge-one"] } });
      renderAccount();
      expect(screen.queryByText("Removed from your account")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: `Computer My laptop: ${LOCAL}. Connected` }));
      const warning = screen.getByRole("group", { name: "Removal not applied" });
      expect(within(warning).getByText("Signed name: not known on this browser · ID bridge-o")).toBeTruthy();
      expect(await click(fake, within(warning).getByRole("button", { name: "Sign removal again" }))).toBe(1);
      expect(fake.revokeBridge).toHaveBeenCalledExactlyOnceWith("bridge-one");
      expect(screen.getByRole("button", { name: "Computer My laptop: Removed from your account. Connected" })).toBeTruthy();
    });
  });

  it("shows the signed ledger name and a short ID in removal prompts, whatever the display name says", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ names: [{ kind: "bridge", id: "bridge-one", name: "Office" }, { kind: "browser", id: "phone", name: "Work phone" }],
      eligible: [{ kind: "bridge", id: "bridge-one" }, { kind: "browser", id: "phone" }] })));
    mountLedger(); renderAccount();
    fireEvent.click(await screen.findByRole("button", { name: /^Computer Office:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove computer Office" }));
    const computer = screen.getByRole("group", { name: "Confirm computer removal" });
    expect(within(computer).getByText("Remove Office from your account? It loses access immediately. To use it again, pair it as a new computer.")).toBeTruthy();
    expect(within(computer).getByText("Signed name: “Computer” · ID bridge-o")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Browser Work phone:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove browser Work phone" }));
    const browser = screen.getByRole("group", { name: "Confirm browser removal" });
    expect(within(browser).getByText("Signed name: “Phone” · ID phone")).toBeTruthy();
  });

  it("cancels a half-done add-passkey flow without signing anything and can start again", async () => {
    const fake = mountLedger(); renderAccount();
    const add = screen.getByRole("group", { name: "Add another passkey" });
    await click(fake, within(add).getByRole("button", { name: "Create passkey" }));
    expect(within(add).getByText(/Step 2 of 3/)).toBeTruthy();
    fireEvent.click(within(add).getByRole("button", { name: "Cancel" }));
    expect(within(add).getByRole("status").textContent).toMatch(/Reloading this page discards the unfinished passkey/);
    expect(within(add).queryByRole("button", { name: "Confirm new passkey" })).toBeNull();
    expect(fake.addAuthorityConsent).not.toHaveBeenCalled(); expect(fake.addAuthorityFinish).not.toHaveBeenCalled();
    expect(await click(fake, within(add).getByRole("button", { name: "Create passkey" }))).toBe(1);
    expect(fake.addAuthorityStart).toHaveBeenCalledTimes(2);
    expect(within(add).getByRole("button", { name: "Confirm new passkey" })).toBeTruthy();
  });

  it("lists changes discarded by a fork and signs each again with one prompt", async () => {
    const removal = record(4, { type: "revoke_bridge", bridgeId: "bridge-one" });
    const present = record(5, { type: "add_device", device: ledgerDevice("phone", "Phone") });
    const fake = mountLedger({ discarded: [removal, present] }); renderAccount();
    const notice = screen.getByRole("region", { name: "Changes not kept" });
    expect(within(notice).getByText("Remove computer “My laptop”")).toBeTruthy();
    expect(within(notice).getByText("Already in your account")).toBeTruthy();
    expect(within(notice).getAllByRole("button", { name: /^Sign again/ })).toHaveLength(1);
    expect(await click(fake, within(notice).getByRole("button", { name: "Sign again: Remove computer “My laptop”" }))).toBe(1);
    expect(fake.append).toHaveBeenCalledExactlyOnceWith(removal.payload.operation);
    expect(fake.dismissDiscarded).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "Changes not kept" })).toBeNull();
  });

  it("treats an already-removed discarded revocation as done and can dismiss the notice", async () => {
    const fake = mountLedger({ discarded: [record(4, { type: "revoke_device", endpointId: "phone" })] });
    // The prompt happens, then the client finds the device already revoked on the winning chain.
    fake.append.mockImplementationOnce(async () => { fake.prompts++; throw new Error("ledger_revoked"); });
    renderAccount();
    await click(fake, screen.getByRole("button", { name: "Sign again: Remove browser “Phone”" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fake.dismissDiscarded).toHaveBeenCalledOnce();
    publish({ ...current(), discarded: [record(6, { type: "add_bridge", bridge: ledgerBridge("bridge-three", "Studio") })] });
    expect(await screen.findByText("Add computer “Studio”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(fake.dismissDiscarded).toHaveBeenCalledTimes(2);
    expect(fake.prompts).toBe(1);
  });

  it("shows the device_revoked state and sends the owner to set this browser up again", () => {
    mountLedger({ status: "device_revoked", checkpoint: checkpoint({ devices: [ledgerDevice("phone", "Phone")], revokedDeviceIds: ["self"] }) });
    renderAccount();
    expect(screen.getAllByRole("alert")[0].textContent).toContain("This browser was removed from your account.");
    expect(screen.getByRole("link", { name: "Set up this browser again" }).getAttribute("href")).toBe("/login");
    expect(screen.getByRole("button", { name: "Browser This browser (this browser): Removed from your account" })).toBeTruthy();
    expect(screen.getByText("This browser was removed")).toBeTruthy();
    // Passkey-signed changes are off on a removed browser.
    expect(screen.queryByRole("group", { name: "Add another passkey" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Browser Phone:/ }));
    expect((screen.getByRole("button", { name: "Remove browser Phone" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
    expect((screen.getByRole("button", { name: "Remove computer My laptop" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("never shows another account's ledger as the signed-in account", () => {
    const fake = mountLedger({ checkpoint: checkpoint({ accountId: "B".repeat(43) }) });
    renderAccount();
    expect(screen.getByRole("alert").textContent).toMatch(/different account/);
    expect(screen.getByText("Different account")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Browser Phone:/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Add another passkey" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
    expect(screen.queryByRole("button", { name: /^Remove computer/ })).toBeNull();
    expect(fake.prompts).toBe(0);
  });

  it("is read-only while signed out", () => {
    mountLedger({ status: "signed_out", checkpoint: null });
    renderAccount();
    expect(screen.getByRole("heading", { name: "Account access" }).parentElement!.textContent).toContain("Not signed in");
    expect(screen.getByRole("status").textContent).toMatch(/Sign in with your passkey/);
    expect(screen.queryByRole("group", { name: "Add another passkey" })).toBeNull();
  });

  it("keeps display names a cosmetic overlay on the signed ledger labels", async () => {
    const names: { kind: "browser" | "bridge"; id: string; name: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "PUT") {
        const request = JSON.parse(String(options.body));
        names.splice(0, names.length, ...(request.name === null ? [] : [request]));
        return reply({ name: request.name === null ? null : request });
      }
      return reply({ names: [...names], eligible: [{ kind: "browser", id: "self" }, { kind: "bridge", id: bridge.bridgeId }] });
    }));
    mountLedger(); renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /^Computer My laptop:/ }));
    const rename = await screen.findByRole("button", { name: "Rename My laptop" });
    await waitFor(() => expect((rename as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(rename);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Office" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: /^Computer Office:/ });
    expect(current().checkpoint!.bridges[0].label).toBe("Computer");
  });
});

describe("Mode selection", () => {
  it("never opens the ledger for Solo/local and keeps their computer selector", () => {
    render(<SecurityPanel open onClose={() => {}} bridges={[bridge]} currentEndpointId="self" execute={mockExecutor()} />);
    expect(screen.getByRole("combobox", { name: "Security computer" })).toBeTruthy();
    expect(ledger.calls).toBe(0);
  });
  it("renders the ledger view in account mode without the per-computer selector", () => {
    mountLedger();
    render(<SecurityPanel open onClose={() => {}} bridges={[bridge]} currentEndpointId="self" execute={mockExecutor()} accountId={ACCOUNT} />);
    expect(screen.queryByRole("combobox", { name: "Security computer" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Passkeys" })).toBeTruthy();
    expect(ledger.calls).toBeGreaterThan(0);
  });
  it("maps ledger and legacy error codes to fixed text only", () => {
    expect(securityErrorMessage(new Error("passkey_cancelled"))).toMatch(/cancelled/);
    expect(securityErrorMessage({ code: "constructor" })).toBe("This security action could not be completed. Refresh and try again.");
    expect(securityErrorMessage({ code: "account_bridge_revoked" })).toBe("This computer was removed from account trust.");
    expect(securityErrorMessage(new Error("Server said <b>no</b>"))).toBe("This security action could not be completed. Refresh and try again.");
  });
});
