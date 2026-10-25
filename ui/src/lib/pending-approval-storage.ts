import type { AccountEnrollmentRequest, AccountHistory, StoredAccountTrust } from "@security/account-protocol";
import type { PendingApprovalState, PendingCandidateCommand, PendingHelloLocal, PendingOffer, PendingOfferLocal, PendingResult, PendingReviewerCommand, PendingReviewerOpened, PendingTerminalStatus } from "@security/pending-approval-protocol";
import { openBrowserSecurityDatabase, sameAccountTrustPin } from "./browser-identity";

export interface PendingCandidateRecord {
  version: 1; key: string; revision: number; ownerId: string; candidateId: string;
  candidateToken: string; request: Extract<AccountEnrollmentRequest, { kind: "browser" }> | null;
  phase: "creating" | "waiting" | "preparing-hello" | "active" | "completed" | PendingTerminalStatus;
  offer?: PendingOffer; hello?: PendingHelloLocal; confirmedOfferHash?: string;
  outbound?: PendingCandidateCommand; state?: PendingApprovalState;
}
export interface PendingReviewerRecord {
  version: 1; key: string; revision: number; ownerId: string; request: AccountEnrollmentRequest;
  phase: "creating-offer" | "active" | "opening-hello" | "burned" | PendingTerminalStatus;
  local?: PendingOfferLocal; helloHash?: string; opened?: PendingReviewerOpened;
  confirmedOfferHash?: string; outbound?: PendingReviewerCommand;
  approvalHistory?: AccountHistory; result?: PendingResult; state?: PendingApprovalState;
}
export interface PendingApprovalStorage {
  readCandidate(key: string): Promise<PendingCandidateRecord | null>;
  casCandidate(key: string, expected: number | null, value: PendingCandidateRecord | null): Promise<boolean>;
  readReviewer(key: string): Promise<PendingReviewerRecord | null>;
  casReviewer(key: string, expected: number | null, value: PendingReviewerRecord | null): Promise<boolean>;
  completeCandidate(expected: PendingCandidateRecord, previous: StoredAccountTrust | null, trust: StoredAccountTrust): Promise<boolean>;
}
/** Exact local transcript verified before crypto; never retarget stale work. */
export function sameCandidateCompletion(current: PendingCandidateRecord | null, expected: PendingCandidateRecord): boolean {
  const canonical = (value: unknown): string => value && typeof value === "object" ? Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
  return !!current && current.phase === "active" && expected.phase === "active"
    && current.version === expected.version && current.key === expected.key && current.revision === expected.revision
    && current.ownerId === expected.ownerId && current.candidateId === expected.candidateId
    && !!expected.confirmedOfferHash && current.confirmedOfferHash === expected.confirmedOfferHash
    && expected.state?.status === "approved" && canonical(current.state) === canonical(expected.state)
    && canonical(current.request) === canonical(expected.request) && canonical(current.offer) === canonical(expected.offer)
    && canonical(current.hello?.hello) === canonical(expected.hello?.hello);
}
async function read<T>(store: string, key: string): Promise<T | null> {
  const db = await openBrowserSecurityDatabase();
  try { return await new Promise<T | null>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null); request.onerror = () => reject(request.error);
  }); } finally { db.close(); }
}
/** Only the transaction winner may continue asynchronous crypto or publish. */
async function cas<T extends { key: string; revision: number }>(storeName: string, key: string, expected: number | null, value: T | null, untrustedOwner?: string): Promise<boolean> {
  const db = await openBrowserSecurityDatabase();
  try { return await new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(untrustedOwner ? [storeName, "account-trust"] : storeName, "readwrite"); const store = tx.objectStore(storeName); let won = false;
    const select = () => {
      const request = store.get(key);
      request.onsuccess = () => {
        const current = request.result as T | undefined;
        if ((current?.revision ?? null) !== expected) return;
        won = true;
        if (value) store.put({ ...value, key, revision: (expected ?? 0) + 1 }); else store.delete(key);
      };
    };
    // Approval in another tab and cleanup of its request must not race into a
    // second automatic enrollment. A fresh authenticated read will load this pin.
    if (untrustedOwner) { const trust = tx.objectStore("account-trust").get(untrustedOwner); trust.onsuccess = () => { if (!trust.result) select(); }; }
    else select();
    tx.oncomplete = () => resolve(won); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}
export const pendingApprovalStorage: PendingApprovalStorage = {
  readCandidate: key => read("pending-candidates", key), casCandidate: (key, expected, value) => cas("pending-candidates", key, expected, value, expected === null && value?.phase === "creating" ? value.ownerId : undefined),
  readReviewer: key => read("pending-reviewers", key), casReviewer: (key, expected, value) => cas("pending-reviewers", key, expected, value),
  async completeCandidate(expected, previous, trust) {
    const db = await openBrowserSecurityDatabase();
    try { return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(["account-trust", "pending-candidates"], "readwrite"); let won = false;
      const candidates = tx.objectStore("pending-candidates"); const trusts = tx.objectStore("account-trust");
      const candidate = candidates.get(expected.key);
      candidate.onsuccess = () => {
        if (!sameCandidateCompletion(candidate.result as PendingCandidateRecord | null, expected) || trust.checkpoint.ownerId !== expected.ownerId) return;
        const pin = trusts.get(expected.ownerId);
        pin.onsuccess = () => {
          if (!sameAccountTrustPin((pin.result as { trust: StoredAccountTrust } | undefined)?.trust ?? null, previous)) return;
          trusts.put({ ownerId: expected.ownerId, trust });
          candidates.put({ ...expected, revision: expected.revision + 1, phase: "completed", outbound: undefined });
          won = true;
        };
      };
      tx.oncomplete = () => resolve(won); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
    }); } finally { db.close(); }
  },
};
