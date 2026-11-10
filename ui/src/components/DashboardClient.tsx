"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthMode } from "@/lib/auth-mode";
import { useCentrifugo } from "@/hooks/useCentrifugo";
import { useAccountIdentity, useBrowserIdentity } from "@/hooks/useBrowserIdentity";
import type { ApprovedBridge, EndpointIdentity } from "@security/protocol";
import type { LedgerClient } from "@/lib/ledger-client";
import { SecureEndpointRuntime } from "@/lib/secure-endpoint-runtime";
import { Dashboard } from "@/components/Dashboard";
import { detachPushSubscription } from "./PushNotificationsControl";
import { securityErrorMessage } from "./SecurityPanel";

interface DashboardClientProps {
  ownerId: string;
  userId: string;
  token: string;
  centrifugoUrl: string;
  tokenRefresher?: () => Promise<string>;
  onUnauthorized?: () => void;
}

export function BrowserSecurityUnavailable({ code }: { code: string }) {
  return <main className="flex min-h-dvh items-center justify-center p-4"><section className="max-w-md space-y-4 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-6">
    <h1 className="text-xl font-semibold">Encrypted browser access</h1>
    <p role="alert" className="text-sm text-[var(--text-secondary)]">{code === "secure_context_required"
      ? "Open FTown over HTTPS or trustworthy localhost. Plain LAN HTTP cannot enable encrypted controls."
      : code.startsWith("account_") || code === "invalid_account_trust" ? securityErrorMessage({ code })
      : "This browser could not open its private key storage. Enable IndexedDB, close older FTown tabs, and try again. Lost or cleared keys require approval from an existing device."}</p>
    <p className="text-xs text-[var(--text-muted)]">No plaintext connection is enabled. Keep access to the bridge's local CLI for recovery.</p>
    <button className="btn-ghost min-h-11" onClick={() => window.location.reload()}>Try again</button>
  </section></main>;
}

function OpeningIdentity() {
  return <main className="flex min-h-dvh items-center justify-center p-4"><p role="status" className="text-sm text-[var(--text-muted)]">Opening this browser's encryption identity…</p></main>;
}

/** Solo owners (`solo:<bridgeId>`) keep invitation pins; every other owner is a passkey-ledger account. */
export function DashboardClient(props: DashboardClientProps) {
  return props.ownerId.startsWith("solo:") ? <SoloDashboardClient {...props} /> : <AccountDashboardClient {...props} />;
}

/** Solo: unchanged invitation-based trust (this browser's identity plus the bridge pins its invitations stored). */
function SoloDashboardClient(props: DashboardClientProps) {
  const state = useBrowserIdentity(props.ownerId);
  if (state.status === "checking") return <OpeningIdentity />;
  if (state.status === "error") return <BrowserSecurityUnavailable code={state.code} />;
  return <EncryptedDashboardClient {...props} identity={state.identity} pins={state.bridges} />;
}

/** Account: this browser's endpoint for the accountId, trusted only while the ledger lists it; bridges come from the ledger alone. */
function AccountDashboardClient(props: DashboardClientProps) {
  const state = useAccountIdentity(props.ownerId);
  if (state.status === "checking") return <OpeningIdentity />;
  if (state.status === "error") return <BrowserSecurityUnavailable code={state.code} />;
  if (state.status !== "ready") return <AccountAccessEnded removed={state.status === "removed"} />;
  return <EncryptedDashboardClient {...props} identity={state.identity} ledger={state.ledger} accountId={props.userId} />;
}

/** This browser is not (or no longer) a trusted device of the signed-in account: no encrypted resources exist on this screen. */
function AccountAccessEnded({ removed }: { removed: boolean }) {
  const { signOut } = useAuthMode();
  const [leaving, setLeaving] = useState(false);
  function signInAgain() {
    if (leaving) return;
    setLeaving(true);
    void detachPushSubscription().catch(() => {}).finally(signOut);
  }
  return <main className="flex min-h-dvh items-center justify-center p-4"><section className="max-w-md space-y-4 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-6">
    <h1 className="text-xl font-semibold">{removed ? "This browser was removed" : "Sign in again"}</h1>
    <p role="alert" className="text-sm text-[var(--text-secondary)]">{removed
      ? "This browser was removed from your account, so it can no longer open encrypted sessions. Sign in with your passkey to add it again."
      : "This browser does not hold your account's keys. Sign in with your passkey to continue."}</p>
    <button type="button" className="btn-ghost min-h-11" disabled={leaving} onClick={signInAgain}>{leaving ? "Signing out…" : "Sign in again"}</button>
  </section></main>;
}

function EncryptedDashboardClient({ identity, pins, ledger, accountId, ...props }: DashboardClientProps & { identity: EndpointIdentity; pins?: ApprovedBridge[]; ledger?: LedgerClient; accountId?: string }) {
  const { signOut } = useAuthMode();
  // Account: the ledger is the only bridge authority. Solo: invitation pins, refreshed below.
  const resource = useMemo(() => ({ runtime: new SecureEndpointRuntime(identity, ledger ? { ledger } : pins ?? []), leases: 0 }), [identity, ledger]);
  useEffect(() => { if (!ledger) resource.runtime.replacePins(pins ?? []); }, [resource, pins, ledger]);
  useEffect(() => {
    resource.leases++;
    return () => { resource.leases--; queueMicrotask(() => { if (resource.leases === 0) resource.runtime.dispose(); }); };
  }, [resource]);
  const { client, status, error, transport } = useCentrifugo(props.token, props.centrifugoUrl, props.userId, {
    securityRuntime: resource.runtime, tokenRefresher: props.tokenRefresher, onUnauthorized: props.onUnauthorized, ledger,
  });
  const handleDisconnect = useCallback(() => { resource.runtime.dispose(); signOut(); }, [resource, signOut]);
  return <Dashboard client={client} connectionStatus={status} connectionError={error} userId={props.userId}
    token={props.token} centrifugoUrl={props.centrifugoUrl} transport={transport} onDisconnect={handleDisconnect} accountId={accountId ?? null} />;
}
