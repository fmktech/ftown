"use client";

import { useEffect, useState } from "react";
import type { LedgerClientSnapshot } from "@/lib/ledger-client";

export const UNSAVED_DETAIL = "Removal not saved to the server yet. It can still connect. Retrying…";
export const UNSAVED_SELF_DETAIL = "This browser's removal is not saved to the server yet. It can still connect. Retrying…";
/** No automatic retry: sending this chain would drop removals the server has (snapshot.conflict). */
export const UNSAVED_CONFLICT = "Not saved to the server. Sign this removal again from this browser.";
/** No automatic retry: this browser's own removal came from another chain, so it cannot write (snapshot.canReoffer false). */
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

/** What to tell about a removal the server has not stored, by what the client can do about it. */
export function unsavedRemovalState(snapshot: LedgerClientSnapshot, self = false): { text: string; canRetry: boolean } {
  const blocked = snapshot.canReoffer === false;
  const conflict = !blocked && snapshot.conflict === true;
  return { text: blocked ? UNSAVED_BLOCKED : conflict ? UNSAVED_CONFLICT : self ? UNSAVED_SELF_DETAIL : UNSAVED_DETAIL, canRetry: !blocked && !conflict };
}

/** "Retry now" (disabled as "Retry in N s" while the server's Retry-After is pending). Renders nothing when no retry can happen. */
export function UnsavedRemovalRetryButton({ snapshot, busy, retrying, onRetry }: {
  snapshot: LedgerClientSnapshot; busy: boolean; retrying: boolean; onRetry: () => void;
}) {
  const notBefore = snapshot.retryNotBefore ?? null;
  const now = useClockUntil(notBefore);
  const wait = notBefore === null ? 0 : Math.ceil((notBefore - now) / 1000);
  if (!unsavedRemovalState(snapshot).canRetry) return null;
  return <button type="button" className="btn-ghost min-h-11 sm:min-h-8" disabled={busy || wait > 0} onClick={onRetry}>
    {wait > 0 ? `Retry in ${wait} s` : retrying ? "Retrying…" : "Retry now"}</button>;
}
