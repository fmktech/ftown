"use client";

import { useEffect, useState } from "react";
import type { LedgerClientSnapshot } from "@/lib/ledger-client";

export const UNSAVED_DETAIL = "Removal not saved to the server yet. It can still connect. Retrying…";
export const UNSAVED_SELF_DETAIL = "This browser's removal is not saved to the server yet. It can still connect. Retrying…";
/** No automatic re-offer: this browser's own removal is only in its sticky set, so it cannot re-offer (snapshot.canReoffer false). */
export const UNSAVED_BLOCKED = "Not saved to the server. Remove it again from another browser of your account.";

/** The clock, re-read every second until `until` (epoch ms) has passed; for "Retry in N s". */
export function useClockUntil(until: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (until === null || until <= Date.now()) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  return now;
}

/** True iff the removal of `id` is the pending write (a signed record the client sends itself, whatever canReoffer says). */
function pendingRemoval(snapshot: LedgerClientSnapshot, id: string | undefined): boolean {
  const pending = snapshot.pendingWrite;
  return id !== undefined && !!pending && (pending.operation === "revoke_device" ? pending.deviceId === id : pending.operation === "revoke_bridge" && pending.bridgeId === id);
}

/**
 * What to tell about a removal the server has not stored (of `id`, when known), by what the client can do about it: the pending write
 * is always retried; a removal already in this browser's chain (the server is behind) only by a browser that may re-offer.
 */
export function unsavedRemovalState(snapshot: LedgerClientSnapshot, self = false, id?: string): { text: string; canRetry: boolean } {
  const blocked = snapshot.canReoffer === false && !pendingRemoval(snapshot, id);
  return { text: blocked ? UNSAVED_BLOCKED : self ? UNSAVED_SELF_DETAIL : UNSAVED_DETAIL, canRetry: !blocked };
}

/** "Retry now" (disabled as "Retry in N s" while the server's Retry-After is pending). Renders nothing when no retry can happen. */
export function UnsavedRemovalRetryButton({ snapshot, busy, retrying, onRetry, id, pending = false }: {
  /** `id`: the removal's target; `pending`: the button is for the pending write itself (always retried). */
  snapshot: LedgerClientSnapshot; busy: boolean; retrying: boolean; onRetry: () => void; id?: string; pending?: boolean;
}) {
  const notBefore = snapshot.retryNotBefore ?? null;
  const now = useClockUntil(notBefore);
  const wait = notBefore === null ? 0 : Math.ceil((notBefore - now) / 1000);
  if (!pending && !unsavedRemovalState(snapshot, false, id).canRetry) return null;
  return <button type="button" className="btn-ghost min-h-11 sm:min-h-8" disabled={busy || wait > 0} onClick={onRetry}>
    {wait > 0 ? `Retry in ${wait} s` : retrying ? "Retrying…" : "Retry now"}</button>;
}
