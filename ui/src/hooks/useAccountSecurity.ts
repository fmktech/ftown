"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AccountSecurityClient, type AccountSecuritySnapshot } from "@/lib/account-security-client";
import { securityNudges } from "@/lib/security-nudge-bus";

const checking: AccountSecuritySnapshot = { status: "checking", identity: null, signing: null, trust: null, legacyBridges: [], historyExists: false, code: null, offline: false };
const noop = () => () => {};
export function useAccountSecurity(ownerId: string | null) {
  const resource = useMemo(() => ownerId ? { client: new AccountSecurityClient(ownerId), leases: 0 } : null, [ownerId]);
  const snapshot = useSyncExternalStore(resource?.client.subscribe ?? noop, resource?.client.snapshot ?? (() => checking), () => checking);
  useEffect(() => {
    if (!resource) return;
    resource.leases++;
    const refresh = () => { void resource.client.refresh(); };
    refresh(); const unsubscribe = securityNudges.on("account", () => { void resource.client.refreshFresh(); });
    // Without a bus (no dashboard Centrifugo client) nothing would ever nudge us, so fall back to refreshing when the tab returns.
    const visible = () => { if (document.visibilityState === "visible" && !securityNudges.attached) refresh(); };
    document.addEventListener("visibilitychange", visible);
    const flush = () => { void resource.client.flushObservation().catch(() => {}); };
    window.addEventListener("pagehide", flush);
    return () => {
      unsubscribe(); document.removeEventListener("visibilitychange", visible); window.removeEventListener("pagehide", flush); resource.leases--;
      queueMicrotask(() => { if (!resource.leases) resource.client.dispose(); });
    };
  }, [resource]);
  return { client: resource?.client ?? null, snapshot };
}
