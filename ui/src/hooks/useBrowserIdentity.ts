"use client";

import { useEffect, useState } from "react";
import type { ApprovedBridge, EndpointIdentity } from "@security/protocol";
import { loadBrowserIdentity, readPinnedBridges } from "@/lib/browser-identity";

export type BrowserIdentityState = { status: "checking"; identity: null; bridges: ApprovedBridge[]; code: null }
  | { status: "ready"; identity: EndpointIdentity; bridges: ApprovedBridge[]; code: null }
  | { status: "error"; identity: null; bridges: ApprovedBridge[]; code: string };

export function useBrowserIdentity(ownerId: string | null): BrowserIdentityState {
  const [state, setState] = useState<BrowserIdentityState>({ status: "checking", identity: null, bridges: [], code: null });
  useEffect(() => {
    let active = true;
    setState({ status: "checking", identity: null, bridges: [], code: null });
    if (!ownerId) return;
    void Promise.all([loadBrowserIdentity(ownerId), readPinnedBridges(ownerId)]).then(([identity, bridges]) => {
      if (active) setState({ status: "ready", identity, bridges, code: null });
    }).catch((error: unknown) => {
      if (active) setState({ status: "error", identity: null, bridges: [], code: error && typeof error === "object" && "code" in error ? String(error.code) : "storage_unavailable" });
    });
    return () => { active = false; };
  }, [ownerId]);
  return state;
}
