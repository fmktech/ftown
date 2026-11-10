"use client";

import { useEffect, useMemo, useState } from "react";
import type { ApprovedBridge, EndpointIdentity } from "@security/protocol";
import { loadBrowserIdentity, readPinnedBridges } from "@/lib/browser-identity";
import type { LedgerClient } from "@/lib/ledger-client";
import { ledgerStanding } from "@/lib/secure-endpoint-runtime";
import { useLedger } from "./useLedger";

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : fallback;
}

export type BrowserIdentityState = { status: "checking"; identity: null; bridges: ApprovedBridge[]; code: null }
  | { status: "ready"; identity: EndpointIdentity; bridges: ApprovedBridge[]; code: null }
  | { status: "error"; identity: null; bridges: ApprovedBridge[]; code: string };

/**
 * Solo/local only (`solo:<bridgeId>` owners): this browser's identity plus the bridge pins its invitations stored. Account owners are
 * refused (`wrong_context`): their bridges come from the passkey ledger alone (useAccountIdentity), never from stored pins.
 */
export function useBrowserIdentity(ownerId: string | null): BrowserIdentityState {
  const [state, setState] = useState<BrowserIdentityState>({ status: "checking", identity: null, bridges: [], code: null });
  const solo = ownerId?.startsWith("solo:") ?? false;
  useEffect(() => {
    let active = true;
    setState({ status: "checking", identity: null, bridges: [], code: null });
    if (!ownerId) return;
    if (!solo) { setState({ status: "error", identity: null, bridges: [], code: "wrong_context" }); return; }
    void Promise.all([loadBrowserIdentity(ownerId), readPinnedBridges(ownerId)]).then(([identity, bridges]) => {
      if (active) setState({ status: "ready", identity, bridges, code: null });
    }).catch((error: unknown) => {
      if (active) setState({ status: "error", identity: null, bridges: [], code: errorCode(error, "storage_unavailable") });
    });
    return () => { active = false; };
  }, [ownerId, solo]);
  return state;
}

export type AccountIdentityState = { status: "checking" }
  | { status: "error"; code: string }
  /** This browser's endpoint is revoked (or replaced) in the trusted checkpoint: permanent for this identity. */
  | { status: "removed"; identity: EndpointIdentity }
  /** Not a device of this account in the local replica (nothing bound, another account, never enrolled). */
  | { status: "unenrolled"; identity: EndpointIdentity }
  /** A trusted device: `ledger` is the only bridge authority for this identity. */
  | { status: "ready"; identity: EndpointIdentity; ledger: LedgerClient };

/**
 * Account mode: this browser's endpoint for `accountId` (the identity the ledger client enrolls: owner = accountId) and where it stands
 * in the ledger client's trusted checkpoint. Re-evaluated on every ledger change, so a removal ends access immediately.
 */
export function useAccountIdentity(accountId: string): AccountIdentityState {
  const { client: ledger, snapshot } = useLedger();
  const [identity, setIdentity] = useState<{ status: "checking" } | { status: "ready"; identity: EndpointIdentity } | { status: "error"; code: string }>({ status: "checking" });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    setIdentity({ status: "checking" });
    loadBrowserIdentity(accountId).then(value => { if (active) setIdentity({ status: "ready", identity: value }); },
      (error: unknown) => { if (active) setIdentity({ status: "error", code: errorCode(error, "storage_unavailable") }); });
    return () => { active = false; };
  }, [accountId]);
  useEffect(() => {
    let active = true;
    // A failed load surfaces as snapshot.status "error".
    ledger.load().catch(() => {}).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [ledger]);
  return useMemo((): AccountIdentityState => {
    if (identity.status === "error") return identity;
    if (snapshot.status === "error") return { status: "error", code: snapshot.error ?? "storage_unavailable" };
    if (identity.status === "checking" || !loaded) return { status: "checking" };
    const standing = ledgerStanding(snapshot, identity.identity.endpoint);
    if (standing === "revoked") return { status: "removed", identity: identity.identity };
    if (standing === "absent") return { status: "unenrolled", identity: identity.identity };
    return { status: "ready", identity: identity.identity, ledger };
  }, [identity, snapshot, loaded, ledger]);
}
