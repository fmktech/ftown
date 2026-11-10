"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { LedgerClient, LedgerClientSnapshot } from "@/lib/ledger-client";
import { getLedgerClient } from "@/lib/ledger-runtime";

const serverSnapshot: LedgerClientSnapshot = { status: "signed_out", checkpoint: null, discarded: [], localOnly: { deviceIds: [], bridgeIds: [] }, signer: null, pending: "none" };
const noop = () => () => {};

/** The page's ledger client and its live snapshot. Calls client.load() once on mount. On the server `client` is null. */
export function useLedger(): { client: LedgerClient; snapshot: LedgerClientSnapshot } {
  const client = useMemo(() => (typeof window === "undefined" ? null : getLedgerClient()), []);
  const snapshot = useSyncExternalStore(client?.subscribe ?? noop, client?.snapshot ?? (() => serverSnapshot), () => serverSnapshot);
  useEffect(() => { void client?.load().catch(() => {}); }, [client]);
  return { client: client as LedgerClient, snapshot };
}
