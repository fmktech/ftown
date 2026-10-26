"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { PENDING_APPROVAL_LIMITS } from "@security/pending-approval-crypto";
import { PendingApprovalClient, type PendingSnapshot } from "@/lib/pending-approval-client";
import type { AccountSecurityClient } from "@/lib/account-security-client";
const empty: PendingSnapshot = { candidate: { status: "idle", requestId: null, label: "Browser", code: null, localConfirmed: false, peerConfirmed: false, error: null }, inbox: [], inboxError: null, review: null };
const noop = () => () => {};
export function usePendingApprovals(account: AccountSecurityClient | undefined, mode: "candidate" | "reviewer" | "passive", supplied?: PendingApprovalClient) {
  const resource = useMemo(() => account ? { client: supplied ?? new PendingApprovalClient(account), owned: !supplied, leases: 0 } : null, [account, supplied]);
  const snapshot = useSyncExternalStore(resource?.client.subscribe ?? noop, resource?.client.snapshot ?? (() => empty), () => empty);
  useEffect(() => {
    if (!resource) return;
    resource.leases++;
    const poll = () => { if (mode === "candidate") void resource.client.ensureCandidate(); else if (mode === "reviewer") { void resource.client.refreshInbox(); void resource.client.pollReview(); } };
    poll(); const timer = setInterval(poll, PENDING_APPROVAL_LIMITS.pollIntervalMs); window.addEventListener("focus", poll);
    return () => { clearInterval(timer); window.removeEventListener("focus", poll); resource.leases--; queueMicrotask(() => { if (!resource.leases && resource.owned) resource.client.dispose(); }); };
  }, [resource, mode]);
  return { client: resource?.client ?? null, snapshot };
}
