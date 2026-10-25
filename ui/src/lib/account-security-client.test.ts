// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import { AccountTrustError, createAccountEnrollment, createAccountGenesis, generateAccountBridgeCandidate, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from "@security/account-crypto";
import type { ApprovedBridge, SecurityCommand, SecurityCommandResults } from "@security/protocol";
import type { AccountEnrollmentStatus, AccountHistory, StoredAccountTrust } from "@security/account-protocol";
import { AccountSecurityClient, accountStorage, captureAccountLink, safeAccountReturnTo } from "./account-security-client";

const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); sessionStorage.clear(); });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function fixture(seed = true) {
  const identity = await generateEndpoint(owner, "browser"); const signing = await generateAccountSigningIdentity();
  let history: AccountHistory | null = seed ? { genesis: await createAccountGenesis(owner, identity.endpoint, signing, "Laptop"), transitions: [] } : null;
  const enrollments = new Map<string, AccountEnrollmentStatus>();
  const calls: { path: string; body: unknown }[] = [];
  const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const url = String(path); const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url, body });
    if (url === "/api/security/account") {
      if (body && typeof body === "object" && "record" in body && "expectedHead" in body) {
        if (history) {
          const current = await verifyAccountHistory(history, null);
          if (!body.expectedHead || (body.expectedHead as { head: string }).head !== current.head) return response({ error: { code: "account_trust_conflict" } }, 409);
          history = { ...history, transitions: [...history.transitions, body.record as AccountHistory["transitions"][number]] };
        } else history = { genesis: body.record as AccountHistory["genesis"], transitions: [] };
        await verifyAccountHistory(history, null);
      }
      return response({ history });
    }
    if (url === "/api/security/account/enrollments" && body && typeof body === "object" && "requestId" in body) {
      const request = body as AccountEnrollmentStatus["request"];
      const existing = enrollments.get(request.requestId);
      if (!existing) enrollments.set(request.requestId, { request, status: "pending", bundle: null });
      return response(enrollments.get(request.requestId));
    }
    const id = url.split("/").at(-1)!; const enrollment = enrollments.get(id);
    if (!enrollment) return response({ error: { code: "account_enrollment_invalid" } }, 404);
    if (body && typeof body === "object" && "bundle" in body) { enrollment.status = "approved"; enrollment.bundle = body.bundle as AccountEnrollmentStatus["bundle"]; }
    return response(enrollment);
  }) as unknown as typeof fetch;
  async function installation(pinned: boolean, existingIdentity = identity, existingSigning = signing) {
    let stored: StoredAccountTrust | null = pinned && history ? { history, checkpoint: await verifyAccountHistory(history, null), lastServerReadAt: Date.now(), lastObservedAt: Date.now() } : null;
    let pending: Awaited<ReturnType<typeof accountStorage.readAccountEnrollment>> = null;
    const storage: typeof accountStorage = {
      loadBrowserIdentity: async () => existingIdentity, loadAccountSigningIdentity: async () => existingSigning, readPinnedBridges: async () => [],
      readAccountTrust: async () => stored, readAccountEnrollment: async () => pending, storeAccountEnrollment: async (_owner, link) => { pending = link; },
      persistAccountTrust: async (_owner, verified, options = {}) => {
        if (!stored && !options.bootstrap) throw new AccountTrustError("account_approval_required");
        const now = options.now ?? Date.now();
        if (stored && now < stored.lastObservedAt) throw new AccountTrustError("account_offline_expired");
        const checkpoint = await verifyAccountHistory(verified.history, stored?.checkpoint ?? null);
        stored = { history: verified.history, checkpoint, lastServerReadAt: Math.max(stored?.lastServerReadAt ?? 0, options.serverReadAt ?? 0), lastObservedAt: now }; return stored;
      },
    };
    return { client: new AccountSecurityClient(owner, fetcher, storage), storage, stored: () => stored,
      setStored: (value: StoredAccountTrust | null) => { stored = value; } };
  }
  return { identity, signing, fetcher, calls, installation, history: () => history, setHistory: (value: AccountHistory | null) => { history = value; } };
}

it("ordinary login never trusts an unpinned self-signed roster, even when its initial device uses these keys", async () => {
  const f = await fixture(); const browser = await f.installation(false);
  expect((await browser.client.refresh()).status).toBe("unapproved"); expect(browser.stored()).toBeNull();
  expect(f.calls.every(call => call.body === undefined)).toBe(true);
});

it("one explicit initial bridge confirmation establishes the first device and exact bridge key", async () => {
  const f = await fixture(false); const browser = await f.installation(false);
  const computer = await generateAccountBridgeCandidate("computer-one");
  const link = await createAccountEnrollment(computer, "Computer", null, "computer-one");
  const bundle = await browser.client.approve(link, true);
  expect(bundle.requestId).toBe(link.request.requestId);
  expect(browser.client.snapshot().status).toBe("ready");
  expect(browser.stored()?.checkpoint.devices.map(device => device.endpoint.id)).toEqual([f.identity.endpoint.id]);
  expect(browser.stored()?.checkpoint.bridges[0].endpoint.publicKey).toBe(computer.endpoint.publicKey);
  expect(JSON.stringify(f.calls)).not.toContain(link.secret);
});

it("one fresh browser approval receives all verified bridges, then learns another without another enrollment", async () => {
  const f = await fixture(); const trusted = await f.installation(true);
  const second = await f.installation(false, await generateEndpoint(owner, "browser"), await generateAccountSigningIdentity());
  const link = await second.client.requestDevice("Phone");
  expect(await second.client.finishDevice(link)).toBe(false);
  await trusted.client.approveDevice(link); expect(await second.client.finishDevice(link)).toBe(true);
  const before = f.calls.filter(call => call.path === "/api/security/account/enrollments" && call.body).length;
  const computer = await generateAccountBridgeCandidate("later-computer");
  await trusted.client.approve(await createAccountEnrollment(computer, "Later computer", null, "later-computer"));
  const state = await second.client.refresh(); expect(state.status).toBe("ready");
  expect(state.trust?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(["later-computer"]);
  expect(f.calls.filter(call => call.path === "/api/security/account/enrollments" && call.body)).toHaveLength(before);
  expect(JSON.stringify(f.calls)).not.toContain(link.secret);
});

it("known empty history and a late older GET cannot replace a newer durable pin or refresh its clock", async () => {
  const f = await fixture(); const browser = await f.installation(true); const initial = f.history()!;
  const second = await generateEndpoint(owner, "browser"); const signing = await generateAccountSigningIdentity();
  const record = await signAccountTransition(browser.stored()!.checkpoint, f.identity.endpoint.id, f.signing,
    { type: "add_device", device: { endpoint: second.endpoint, signingPublicKey: signing.publicKey, label: "Phone", approvedAt: new Date().toISOString() } });
  const latest = { ...initial, transitions: [record] }; f.setHistory(latest); await browser.client.refresh();
  const pin = browser.stored()!; const time = pin.lastServerReadAt;
  f.setHistory(initial); expect((await browser.client.refresh()).code).toBe("account_trust_rollback");
  expect(browser.stored()!.checkpoint.head).toBe(pin.checkpoint.head); expect(browser.stored()!.lastServerReadAt).toBe(time);
  f.setHistory(null); expect((await browser.client.refresh()).code).toBe("account_trust_rollback"); expect(browser.stored()!.lastServerReadAt).toBe(time);
});

it("an older GET finishing after another tab advanced the shared pin cannot commit its old head or clock", async () => {
  const f = await fixture(); const first = await f.installation(true);
  const otherTab = new AccountSecurityClient(owner, f.fetcher, first.storage);
  const initial = f.history()!; let release: (value: Response) => void = () => {};
  vi.mocked(f.fetcher).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const olderRead = first.client.refresh(); await vi.waitFor(() => expect(vi.mocked(f.fetcher)).toHaveBeenCalledTimes(1));
  const endpoint = await generateEndpoint(owner, "browser"); const signing = await generateAccountSigningIdentity();
  const record = await signAccountTransition(first.stored()!.checkpoint, f.identity.endpoint.id, f.signing,
    { type: "add_device", device: { endpoint: endpoint.endpoint, signingPublicKey: signing.publicKey, label: "Second tab peer", approvedAt: new Date().toISOString() } });
  f.setHistory({ ...initial, transitions: [record] }); await otherTab.refresh();
  const newer = first.stored()!; release(response({ history: initial }));
  expect((await olderRead).code).toBe("account_trust_rollback");
  expect(first.stored()!.checkpoint.head).toBe(newer.checkpoint.head); expect(first.stored()!.lastServerReadAt).toBe(newer.lastServerReadAt);
});

it("retries a partially committed first bootstrap using only its own exact genesis keys", async () => {
  const f = await fixture(false); const browser = await f.installation(false);
  const computer = await generateAccountBridgeCandidate("lost-response"); const link = await createAccountEnrollment(computer, "Computer", null, "lost-response");
  const original = f.fetcher; let failed = false;
  const wrapper = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const result = await original(path, init);
    if (!failed && String(path) === "/api/security/account" && init?.body) { failed = true; throw new Error("lost reply after commit"); }
    return result;
  }) as unknown as typeof fetch;
  const retrying = new AccountSecurityClient(owner, wrapper, browser.storage);
  await expect(retrying.approve(link, true)).rejects.toBeTruthy();
  await expect(retrying.approve(link, true)).resolves.toMatchObject({ requestId: link.request.requestId });
  expect(f.history()!.transitions).toHaveLength(1); expect(retrying.snapshot().status).toBe("ready");
});

it("failed refreshes do not slide offline grace and a backward clock stops access", async () => {
  const f = await fixture(); const browser = await f.installation(true); await browser.client.refresh(); const pin = browser.stored()!;
  vi.mocked(f.fetcher).mockRejectedValue(new Error("private network error"));
  const recent = await browser.client.refresh(); expect(recent.status).toBe("ready"); expect(recent.offline).toBe(true); expect(browser.stored()!.lastServerReadAt).toBe(pin.lastServerReadAt);
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 86400001); expect((await browser.client.refresh()).code).toBe("account_offline_expired");
  vi.mocked(Date.now).mockReturnValue(now - 1000); expect((await browser.client.refresh()).code).toBe("account_offline_expired");
});

it("last-admin and cross-owner approvals fail without submitting an account mutation", async () => {
  const f = await fixture(); const browser = await f.installation(true); await browser.client.refresh();
  await expect(browser.client.revoke(f.identity.endpoint.id)).rejects.toMatchObject({ code: "account_last_admin" });
  const foreign = await generateEndpoint(other, "browser"); const signing = await generateAccountSigningIdentity();
  await expect(browser.client.approve(await createAccountEnrollment(foreign, "Other owner", signing, null))).rejects.toMatchObject({ code: "account_enrollment_invalid" });
  expect(f.calls.some(call => call.path === "/api/security/account" && call.body)).toBe(false);
});

it("disposing during an account read cannot expose stale trust", async () => {
  const f = await fixture(); const browser = await f.installation(true);
  let release: (response: Response) => void = () => {};
  vi.mocked(f.fetcher).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const reading = browser.client.refresh(); await vi.waitFor(() => expect(vi.mocked(f.fetcher)).toHaveBeenCalled());
  browser.client.dispose(); release(response({ history: f.history() })); await reading;
  expect(browser.client.snapshot().status).toBe("checking");
});

it("scrubs secret fragments synchronously and allows only bounded local login continuations", () => {
  window.history.replaceState(null, "", "/pair?code=ABCD-EFGH#account=YWJj");
  expect(captureAccountLink()).toBe("YWJj"); expect(window.location.hash).toBe("");
  expect(captureAccountLink()).toBe("YWJj");
  expect(safeAccountReturnTo("/pair?code=ABCD-EFGH")).toBe("/pair?code=ABCD-EFGH");
  expect(safeAccountReturnTo("/devices/approve")).toBe("/devices/approve");
  for (const value of ["//evil.test/pair", "/pair#account=secret", "/pair?secret=bad", "/devices/approve?next=https://evil.test", "/%2f%2fevil.test"]) expect(safeAccountReturnTo(value)).toBeNull();
  expect(JSON.stringify(window.location.href)).not.toContain("YWJj");
});


it("requires a successful authenticated current read after every client startup, even with a recent durable pin", async () => {
  const f = await fixture(); const trusted = await f.installation(true);
  const computer = await generateAccountBridgeCandidate("startup-computer");
  await trusted.client.approve(await createAccountEnrollment(computer, "Computer", null, "startup-computer"));
  const browser = await f.installation(true); const before = browser.stored()!;
  vi.mocked(f.fetcher).mockRejectedValueOnce(new Error("startup offline"));
  expect((await browser.client.refresh()).status).toBe("error"); expect(browser.stored()).toBe(before);
  expect(browser.stored()!.lastServerReadAt).toBe(before.lastServerReadAt);
  expect(() => browser.client.assertBridgeAccess("startup-computer")).toThrowError(expect.objectContaining({ code: "account_approval_required" }));
  expect((await browser.client.refresh()).status).toBe("ready");
  expect(() => browser.client.assertBridgeAccess("startup-computer")).not.toThrow();
});
it("an invalid current history stays blocked through a subsequent network failure until a valid GET recovers", async () => {
  const f = await fixture(); const browser = await f.installation(true); await browser.client.refresh();
  const initial = f.history();
  f.setHistory(null); expect((await browser.client.refresh()).code).toBe("account_trust_rollback");
  vi.mocked(f.fetcher).mockRejectedValueOnce(new Error("now unavailable"));
  expect((await browser.client.refresh()).code).toBe("account_trust_rollback");
  expect(browser.client.snapshot().status).toBe("error");
  f.setHistory(initial); expect((await browser.client.refresh()).status).toBe("ready");
});
it("checks elapsed monotonic grace at account admission even with a frozen wall and no refresh timer", async () => {
  const f = await fixture(); const browser = await f.installation(true);
  const computer = await generateAccountBridgeCandidate("timed-computer");
  await browser.client.approve(await createAccountEnrollment(computer, "Computer", null, "timed-computer"));
  const start = performance.now(); const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(performance, "now").mockReturnValue(start + 86400001);
  expect(() => browser.client.assertBridgeAccess("timed-computer")).toThrowError(expect.objectContaining({ code: "account_offline_expired" }));
  expect(browser.client.snapshot().status).toBe("error");
  expect(() => browser.client.assertBridgeAccess("independent-legacy-computer")).not.toThrow();
  vi.restoreAllMocks();
});

it("latches a wall-clock rollback detected by send admission until a matching valid read at a safe clock", async () => {
  const f = await fixture(); const browser = await f.installation(true);
  const computer = await generateAccountBridgeCandidate("clock-computer");
  await browser.client.approve(await createAccountEnrollment(computer, "Computer", null, "clock-computer"));
  const now = Date.now(); browser.client.assertBridgeAccess("clock-computer");
  vi.spyOn(Date, "now").mockReturnValue(now - 1000);
  expect(() => browser.client.assertBridgeAccess("clock-computer")).toThrowError(expect.objectContaining({ code: "account_offline_expired" }));
  vi.mocked(f.fetcher).mockRejectedValueOnce(new Error("offline")); expect((await browser.client.refresh()).status).toBe("error");
  vi.restoreAllMocks(); expect((await browser.client.refresh()).status).toBe("error");
  expect((await browser.client.refresh()).status).toBe("ready");
});

it("a stalled refresh cannot keep account access alive beyond monotonic grace", async () => {
  const f = await fixture(); const browser = await f.installation(true);
  const computer = await generateAccountBridgeCandidate("stalled-computer");
  await browser.client.approve(await createAccountEnrollment(computer, "Computer", null, "stalled-computer"));
  let release: (response: Response) => void = () => {};
  vi.mocked(f.fetcher).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const count = vi.mocked(f.fetcher).mock.calls.length; const pending = browser.client.refresh();
  await vi.waitFor(() => expect(vi.mocked(f.fetcher)).toHaveBeenCalledTimes(count + 1));
  const monotonic = performance.now(); vi.spyOn(performance, "now").mockReturnValue(monotonic + 86400001);
  expect(() => browser.client.assertBridgeAccess("stalled-computer")).toThrowError(expect.objectContaining({ code: "account_offline_expired" }));
  browser.client.dispose(); release(response({ history: f.history() })); await pending;
});

it("blocks an existing runtime callback after another tab durably revoked this device, even if GET is unavailable", async () => {
  const f = await fixture(); const browser = await f.installation(true);
  const computer = await generateAccountBridgeCandidate("revocation-computer");
  await browser.client.approve(await createAccountEnrollment(computer, "Computer", null, "revocation-computer"));
  const second = await f.installation(false, await generateEndpoint(owner, "browser"), await generateAccountSigningIdentity());
  const link = await second.client.requestDevice("Another administrator"); await browser.client.approveDevice(link); await second.client.finishDevice(link);
  await second.client.revoke(f.identity.endpoint.id);
  const latest = f.history()!;
  browser.setStored({ history: latest, checkpoint: await verifyAccountHistory(latest, browser.stored()!.checkpoint), lastServerReadAt: Date.now(), lastObservedAt: Date.now() });
  vi.mocked(f.fetcher).mockRejectedValueOnce(new Error("offline after another tab committed revoke"));
  expect((await browser.client.refresh()).code).toBe("account_device_revoked");
  expect(() => browser.client.assertBridgeAccess("revocation-computer")).toThrowError(expect.objectContaining({ code: "account_device_revoked" }));
});
it("clean observation flush advances only the durable clock highwater, not authenticated-read freshness", async () => {
  const f = await fixture(); const browser = await f.installation(true); await browser.client.refresh();
  const before = browser.stored()!; vi.spyOn(Date, "now").mockReturnValue(before.lastObservedAt + 10000);
  await browser.client.flushObservation();
  expect(browser.stored()!.lastObservedAt).toBe(before.lastObservedAt + 10000);
  expect(browser.stored()!.lastServerReadAt).toBe(before.lastServerReadAt);
});

it("calls the browser fetch capability with its global receiver for account reads and enrollment writes", async () => {
  const f = await fixture(false); const installation = await f.installation(false);
  const receivers: unknown[] = [];
  const nativeLikeFetch: typeof fetch = function(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    receivers.push(this);
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return f.fetcher(input, init);
  };
  vi.stubGlobal("fetch", nativeLikeFetch);
  // Omit the injected fetcher to exercise the production default capability.
  const client = new AccountSecurityClient(owner, undefined, installation.storage);
  expect((await client.refresh()).status).toBe("unapproved");
  const link = await client.requestDevice("Native receiver test");
  expect(link.request.kind).toBe("browser");
  expect(receivers).toHaveLength(2); expect(receivers.every(receiver => receiver === globalThis)).toBe(true);
  expect(f.calls.map(call => call.path)).toEqual(["/api/security/account", "/api/security/account/enrollments"]);
});

it("retries a failed bridge adoption after roster append without adding its exact key twice", async () => {
  const f = await fixture(false); const browser = await f.installation(false);
  const computer = await generateEndpoint(owner, "bridge");
  const pin: ApprovedBridge = { bridgeId: "legacy-computer", endpoint: computer.endpoint, permissions: ["read", "control", "admin"] };
  browser.storage.readPinnedBridges = async () => [pin];
  let fail = true; const heads: unknown[] = [];
  const execute = async <C extends SecurityCommand>(command: C): Promise<SecurityCommandResults[C["type"]]> => {
    if (command.type === "security_devices") return { devices: [{ endpoint: f.identity.endpoint, label: "Legacy browser", permissions: ["read", "control", "admin"], approvedAt: new Date().toISOString(), grantId: null, expiresAt: null }] } as SecurityCommandResults[C["type"]];
    if (command.type !== "security_account_adopt") throw new Error("Unexpected privileged operation");
    heads.push(command.head); if (fail) { fail = false; throw new AccountTrustError("account_storage_unavailable"); }
    return { head: command.head } as SecurityCommandResults[C["type"]];
  };
  await expect(browser.client.migrate(pin, execute)).rejects.toMatchObject({ code: "account_storage_unavailable" });
  expect(f.history()!.transitions).toHaveLength(1); expect(browser.client.snapshot().legacyBridges).toEqual([pin]);
  await expect(browser.client.migrate(pin, execute)).resolves.toBeUndefined();
  expect(f.history()!.transitions).toHaveLength(1); expect(heads).toHaveLength(2); expect(heads[1]).toEqual(heads[0]);
  expect(browser.client.snapshot().trust!.checkpoint.bridges).toHaveLength(1);
});
