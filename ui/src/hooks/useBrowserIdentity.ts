"use client";

import { useEffect, useMemo, useState } from "react";
import type { ApprovedBridge, EndpointIdentity } from "@security/protocol";
import { loadBrowserIdentity, readPinnedBridges } from "@/lib/browser-identity";
import { useAccountSecurity } from "./useAccountSecurity";
import type { AccountSecurityClient, AccountSecuritySnapshot } from "@/lib/account-security-client";

export type BrowserIdentityState = ({ status: "checking"; identity: null; bridges: ApprovedBridge[]; code: null }
  | { status: "ready"; identity: EndpointIdentity; bridges: ApprovedBridge[]; code: null }
  | { status: "error"; identity: null; bridges: ApprovedBridge[]; code: string }) & { accountClient?: AccountSecurityClient; account?: AccountSecuritySnapshot };

export function useBrowserIdentity(ownerId: string | null): BrowserIdentityState {
  const [state, setState] = useState<BrowserIdentityState>({ status: "checking", identity: null, bridges: [], code: null });
  const solo = ownerId?.startsWith("solo:") ?? false;
  const account = useAccountSecurity(solo ? null : ownerId);
  useEffect(() => {
    let active = true;
    setState({ status: "checking", identity: null, bridges: [], code: null });
    if (!ownerId || !solo) return;
    void Promise.all([loadBrowserIdentity(ownerId), readPinnedBridges(ownerId)]).then(([identity, bridges]) => {
      if (active) setState({ status: "ready", identity, bridges, code: null });
    }).catch((error: unknown) => {
      if (active) setState({ status: "error", identity: null, bridges: [], code: error && typeof error === "object" && "code" in error ? String(error.code) : "storage_unavailable" });
    });
    return () => { active = false; };
  }, [ownerId, solo]);
  return useMemo(() => {
    if (solo) return state;
    const value = account.snapshot;
    const extra = { account: value, accountClient: account.client ?? undefined };
    if (value.status === "checking" || !value.identity && value.status !== "error") return { status: "checking" as const, identity: null, bridges: [], code: null, ...extra };
    if ((value.status === "error" && !value.legacyBridges.length) || !value.identity) return { status: "error" as const, identity: null, bridges: [], code: value.code ?? "account_storage_unavailable", ...extra };
    const roster = value.trust?.checkpoint.bridges ?? [];
    const bridges: ApprovedBridge[] = [...value.legacyBridges.filter(pin => !roster.some(bridge => bridge.bridgeId === pin.bridgeId)
      && !value.trust?.checkpoint.revokedBridgeIds.includes(pin.bridgeId)), ...roster.map(bridge => ({ bridgeId: bridge.bridgeId, endpoint: bridge.endpoint, permissions: ["read", "control", "admin"] as ApprovedBridge["permissions"] }))];
    return { status: "ready" as const, identity: value.identity, bridges, code: null, ...extra };
  }, [solo, state, account.snapshot, account.client]);
}
