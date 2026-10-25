// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pendingApprovalStorage } from "./pending-approval-storage";
import type { StoredAccountTrust } from "@security/account-protocol";
import type { PendingCandidateRecord } from "./pending-approval-storage";
const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./browser-identity", async importOriginal => ({ ...await importOriginal<typeof import("./browser-identity")>(), openBrowserSecurityDatabase: open }));
let records: Map<string, unknown>;
let scopes: (string | string[])[];
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); records = new Map<string, unknown>(); scopes = [];
  open.mockResolvedValue({ close: () => {}, transaction: (storeNames: string | string[], mode?: string) => {
    if (mode === "readwrite") scopes.push(storeNames);
    const tx = { oncomplete: null as (() => void) | null, onabort: null, onerror: null, objectStore: (storeName: string) => ({
      get: (key: string) => { const request = { result: undefined as unknown, onsuccess: null as (() => void) | null };
        queueMicrotask(() => { request.result = structuredClone(records.get(`${storeName}:${key}`)); request.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); }); return request; },
      put: (value: { key?: string; ownerId?: string }) => records.set(`${storeName}:${value.key ?? value.ownerId}`, structuredClone(value)), delete: (key: string) => records.delete(`${storeName}:${key}`),
    }) }; return tx;
  } });
});
it("cannot create another automatic request after a sibling tab durably installed account trust", async () => {
  const record = candidate(); records.set("account-trust:owner", { trust: { checkpoint: { head: "durable-pin" } } });
  expect(await pendingApprovalStorage.casCandidate(record.key, null, record)).toBe(false);
  expect(await pendingApprovalStorage.readCandidate(record.key)).toBeNull();
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
function candidate(): PendingCandidateRecord { return { version: 1, key: "owner:candidate", revision: 0, ownerId: "owner", candidateId: "candidate", candidateToken: "token", request: null, phase: "creating" }; }
it("one cross-tab CAS wins and a stale completion cannot overwrite or delete it", async () => {
  const record = candidate(); const results = await Promise.all([pendingApprovalStorage.casCandidate(record.key, null, record), pendingApprovalStorage.casCandidate(record.key, null, { ...record, candidateToken: "other" })]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const durable = (await pendingApprovalStorage.readCandidate(record.key))!; expect(durable.revision).toBe(1);
  expect(await pendingApprovalStorage.casCandidate(record.key, null, null)).toBe(false);
  expect(await pendingApprovalStorage.casCandidate(record.key, 0, { ...record, phase: "cancelled" })).toBe(false);
  expect(await pendingApprovalStorage.readCandidate(record.key)).toEqual(durable);
  expect(await pendingApprovalStorage.casCandidate(record.key, 1, null)).toBe(true); expect(await pendingApprovalStorage.readCandidate(record.key)).toBeNull();
});
it("persists a real nonextractable HKDF key by structured clone without exporting it", async () => {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits"]);
  const record = { ...candidate(), hello: { hello: {} as NonNullable<PendingCandidateRecord["hello"]>["hello"], secret: { key } } };
  await pendingApprovalStorage.casCandidate(record.key, null, record);
  const loaded = (await pendingApprovalStorage.readCandidate(record.key))!.hello!.secret.key;
  expect(loaded.extractable).toBe(false); expect(loaded.algorithm.name).toBe("HKDF");
  await expect(crypto.subtle.exportKey("raw", loaded)).rejects.toBeTruthy();
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new Uint8Array() }, loaded, 256); expect(bits.byteLength).toBe(32);
});

function completion() {
  const expected = { ...candidate(), revision: 4, phase: "active", request: { requestId: "request" }, offer: { payload: { offerId: "offer" } },
    hello: { hello: { offerHash: "offer-hash" } }, confirmedOfferHash: "offer-hash", state: { status: "approved" } } as unknown as PendingCandidateRecord;
  const trust = { checkpoint: { ownerId: "owner", rootId: "root", head: "head", revision: 1 }, lastServerReadAt: 10, lastObservedAt: 10 } as StoredAccountTrust;
  return { expected, trust };
}
it("installs trust and completes the exact transcript in one transaction covering both stores", async () => {
  const { expected, trust } = completion(); records.set(`pending-candidates:${expected.key}`, expected);
  expect(await pendingApprovalStorage.completeCandidate(expected, null, trust)).toBe(true);
  expect(scopes).toEqual([["account-trust", "pending-candidates"]]);
  expect(records.get("account-trust:owner")).toEqual({ ownerId: "owner", trust });
  expect((await pendingApprovalStorage.readCandidate(expected.key))?.phase).toBe("completed");
});
for (const change of ["cancel", "request", "offer", "confirmation", "revision", "trust"] as const) it(`rejects held completion after a sibling changes ${change}`, async () => {
  const { expected, trust } = completion();
  const current = structuredClone(expected);
  if (change === "cancel") { current.phase = "cancelled"; current.revision++; }
  if (change === "request") current.request = { ...current.request!, requestId: "replacement" };
  if (change === "offer") current.offer = { ...current.offer!, payload: { ...current.offer!.payload, offerId: "replacement" } };
  if (change === "confirmation") current.confirmedOfferHash = "other";
  if (change === "revision") current.revision++;
  records.set(`pending-candidates:${expected.key}`, current);
  if (change === "trust") records.set("account-trust:owner", { ownerId: "owner", trust: { ...trust, lastObservedAt: 11 } });
  const before = structuredClone([...records.entries()]);
  expect(await pendingApprovalStorage.completeCandidate(expected, null, trust)).toBe(false);
  expect([...records.entries()]).toEqual(before);
});
it("a completed transaction cannot be replayed by stale completion work", async () => {
  const { expected, trust } = completion(); records.set(`pending-candidates:${expected.key}`, expected);
  expect(await pendingApprovalStorage.completeCandidate(expected, null, trust)).toBe(true);
  expect(await pendingApprovalStorage.completeCandidate(expected, null, { ...trust, lastObservedAt: 20 })).toBe(false);
  expect(records.get("account-trust:owner")).toEqual({ ownerId: "owner", trust });
});
