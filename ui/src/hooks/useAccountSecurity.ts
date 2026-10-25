"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AccountSecurityClient, type AccountSecuritySnapshot } from "@/lib/account-security-client";
import { ACCOUNT_TRUST_LIMITS } from "@security/account-crypto";

const checking: AccountSecuritySnapshot = { status: "checking", identity: null, signing: null, trust: null, legacyBridges: [], historyExists: false, code: null, offline: false };
const noop = () => () => {};
export function useAccountSecurity(ownerId: string | null) {
  const resource = useMemo(() => ownerId ? { client: new AccountSecurityClient(ownerId), leases: 0 } : null, [ownerId]);
  const snapshot = useSyncExternalStore(resource?.client.subscribe ?? noop, resource?.client.snapshot ?? (() => checking), () => checking);
  useEffect(() => {
    if (!resource) return;
    resource.leases++;
    const refresh = () => { void resource.client.refresh(); };
    refresh(); const timer = setInterval(refresh, ACCOUNT_TRUST_LIMITS.refreshIntervalMs);
    window.addEventListener("focus", refresh);
    const flush = () => { void resource.client.flushObservation().catch(() => {}); };
    window.addEventListener("pagehide", flush);
    return () => {
      clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("pagehide", flush); resource.leases--;
      queueMicrotask(() => { if (!resource.leases) resource.client.dispose(); });
    };
  }, [resource]);
  return { client: resource?.client ?? null, snapshot };
}
