"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { PENDING_APPROVAL_LIMITS } from "@security/pending-approval-crypto";
import { PendingApprovalClient, type PendingSnapshot } from "@/lib/pending-approval-client";
import type { AccountSecurityClient } from "@/lib/account-security-client";
import { securityNudges } from "@/lib/security-nudge-bus";
const empty: PendingSnapshot = { candidate: { status: "idle", requestId: null, label: "Browser", code: null, localConfirmed: false, peerConfirmed: false, error: null }, inbox: [], inboxError: null, review: null };
const noop = () => () => {};
export function usePendingApprovals(account: AccountSecurityClient | undefined, mode: "candidate" | "reviewer" | "passive", supplied?: PendingApprovalClient) {
  const resource = useMemo(() => account ? { client: supplied ?? new PendingApprovalClient(account), owned: !supplied, leases: 0 } : null, [account, supplied]);
  const snapshot = useSyncExternalStore(resource?.client.subscribe ?? noop, resource?.client.snapshot ?? (() => empty), () => empty);
  const reviewing = mode === "reviewer" && !!snapshot.review && !["idle", "completed-unverified", "rejected", "cancelled", "expired", "conflict", "restart-required"].includes(snapshot.review.status);
  useEffect(() => {
    if (!resource) return;
    resource.leases++;
    const cleanups: (() => void)[] = [];
    if (mode === "candidate") {
      const poll = () => void resource.client.ensureCandidate();
      poll(); const timer = setInterval(poll, PENDING_APPROVAL_LIMITS.pollIntervalMs); window.addEventListener("focus", poll);
      cleanups.push(() => { clearInterval(timer); window.removeEventListener("focus", poll); });
    } else if (mode === "reviewer") {
      const refresh = () => void resource.client.refreshInbox();
      refresh(); cleanups.push(securityNudges.on("approvals", () => void resource.client.refreshInboxFresh()));
      // Without an attached bus nothing announces changes, so catching up on return to the tab is the only freshness signal.
      const visible = () => { if (document.visibilityState === "visible" && !securityNudges.attached) refresh(); };
      document.addEventListener("visibilitychange", visible); cleanups.push(() => document.removeEventListener("visibilitychange", visible));
    }
    return () => { for (const cleanup of cleanups) cleanup(); resource.leases--; queueMicrotask(() => { if (!resource.leases && resource.owned) resource.client.dispose(); }); };
  }, [resource, mode]);
  const reviewId = snapshot.review?.requestId ?? null;
  useEffect(() => {
    if (!resource || !reviewing) return;
    const timer = setInterval(() => void resource.client.pollReview(), PENDING_APPROVAL_LIMITS.pollIntervalMs);
    // A review stuck on a persistent unmapped error never turns terminal; cap polling at the request lifetime.
    const stop = setTimeout(() => clearInterval(timer), PENDING_APPROVAL_LIMITS.lifetimeMs);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [resource, reviewing, reviewId]);
  return { client: resource?.client ?? null, snapshot };
}
