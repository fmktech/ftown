"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthMode } from "@/lib/auth-mode";
import { useCentrifugo } from "@/hooks/useCentrifugo";
import { useBrowserIdentity } from "@/hooks/useBrowserIdentity";
import type { ApprovedBridge, EndpointIdentity } from "@security/protocol";
import { SecureEndpointRuntime } from "@/lib/secure-endpoint-runtime";
import { Dashboard } from "@/components/Dashboard";
import { DeviceApproval } from "./DeviceApproval";
import { PushNotificationsControl, detachPushSubscription } from "./PushNotificationsControl";
import { securityErrorMessage } from "./SecurityPanel";
import type { AccountSecurityClient, AccountSecuritySnapshot } from "@/lib/account-security-client";

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

export function DashboardClient(props: DashboardClientProps) {
  const state = useBrowserIdentity(props.ownerId);
  if (state.status === "checking") return <main className="flex min-h-dvh items-center justify-center p-4"><p role="status" className="text-sm text-[var(--text-muted)]">Opening this browser's encryption identity…</p></main>;
  if (state.status === "error") return <BrowserSecurityUnavailable code={state.code} />;
  if (state.account?.status === "unapproved" && !state.bridges.length && state.accountClient) return <AccountApprovalShell ownerId={props.ownerId} email={props.userId} client={state.accountClient} />;
  return <EncryptedDashboardClient {...props} identity={state.identity} pins={state.bridges} accountClient={state.accountClient} accountState={state.account} />;
}

/** Authenticated account actions do not require encrypted session authority. */
function AccountApprovalShell({ ownerId, email, client }: { ownerId: string; email: string; client: AccountSecurityClient }) {
  const { signOut } = useAuthMode();
  const [showAccount, setShowAccount] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const accountButton = useRef<HTMLButtonElement>(null);
  function disconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    void detachPushSubscription().catch(() => {}).finally(signOut);
  }
  return <main className="min-h-dvh p-4 sm:p-8">
    <header className="mx-auto mb-4 flex w-full max-w-5xl items-center justify-between gap-3 border-b border-[var(--border-muted)] pb-3">
      <span className="font-semibold">FTown</span>
      <div className="relative min-w-0" onKeyDown={event => {
        if (event.key === "Escape") { setShowAccount(false); accountButton.current?.focus(); }
      }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setShowAccount(false); }}>
        <button ref={accountButton} type="button" title={email} aria-expanded={showAccount} aria-controls="pending-account-actions"
          className="btn-ghost min-h-11 min-w-11 max-w-[65vw] truncate px-3 text-sm sm:max-w-sm" onClick={() => setShowAccount(value => !value)}>{email}</button>
        {showAccount && <div id="pending-account-actions" role="group" aria-label="Account actions"
          className="absolute right-0 z-10 mt-1 min-w-40 rounded-lg border border-[var(--border-muted)] bg-[var(--bg-elevated)] p-1 shadow-lg">
          <button type="button" className="btn-ghost min-h-11 w-full px-3 text-left text-sm" disabled={disconnecting} onClick={disconnect}>{disconnecting ? "Disconnecting…" : "Disconnect"}</button>
        </div>}
      </div>
    </header>
    <div className="mx-auto mb-4 flex w-full max-w-5xl justify-end [&_button]:!min-h-11"><PushNotificationsControl accountId={email} /></div>
    <DeviceApproval ownerId={ownerId} email={email} client={client} />
  </main>;
}

function EncryptedDashboardClient({ identity, pins, accountClient, accountState, ...props }: DashboardClientProps & { identity: EndpointIdentity; pins: ApprovedBridge[]; accountClient?: AccountSecurityClient; accountState?: AccountSecuritySnapshot }) {
  const { signOut } = useAuthMode();
  const resource = useMemo(() => ({ runtime: new SecureEndpointRuntime(identity, pins, accountClient?.assertBridgeAccess), leases: 0 }), [identity, accountClient]);
  useEffect(() => { resource.runtime.replacePins(pins); }, [resource, pins]);
  useEffect(() => {
    resource.leases++;
    return () => { resource.leases--; queueMicrotask(() => { if (resource.leases === 0) resource.runtime.dispose(); }); };
  }, [resource]);
  const { client, status, error, transport } = useCentrifugo(props.token, props.centrifugoUrl, props.userId, {
    securityRuntime: resource.runtime, tokenRefresher: props.tokenRefresher, onUnauthorized: props.onUnauthorized,
  });
  const handleDisconnect = useCallback(() => { resource.runtime.dispose(); signOut(); }, [resource, signOut]);
  return <Dashboard client={client} connectionStatus={status} connectionError={error} userId={props.userId}
    token={props.token} centrifugoUrl={props.centrifugoUrl} transport={transport} onDisconnect={handleDisconnect} accountClient={accountClient} accountState={accountState} />;
}
