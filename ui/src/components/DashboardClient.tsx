"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useAuthMode } from "@/lib/auth-mode";
import { useCentrifugo } from "@/hooks/useCentrifugo";
import { useBrowserIdentity } from "@/hooks/useBrowserIdentity";
import type { ApprovedBridge, EndpointIdentity } from "@security/protocol";
import { SecureEndpointRuntime } from "@/lib/secure-endpoint-runtime";
import { Dashboard } from "@/components/Dashboard";
import { DeviceApproval } from "./DeviceApproval";
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
  if (state.account?.status === "unapproved" && state.account.historyExists && !state.bridges.length && state.accountClient) return <main className="min-h-dvh p-4 pt-8 sm:p-8"><DeviceApproval ownerId={props.ownerId} email={props.userId} client={state.accountClient} /></main>;
  return <EncryptedDashboardClient {...props} identity={state.identity} pins={state.bridges} accountClient={state.accountClient} accountState={state.account} />;
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
