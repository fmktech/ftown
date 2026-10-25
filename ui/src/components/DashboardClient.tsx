"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useAuthMode } from "@/lib/auth-mode";
import { useCentrifugo } from "@/hooks/useCentrifugo";
import { useBrowserIdentity } from "@/hooks/useBrowserIdentity";
import type { ApprovedBridge, EndpointIdentity } from "@security/protocol";
import { SecureEndpointRuntime } from "@/lib/secure-endpoint-runtime";
import { Dashboard } from "@/components/Dashboard";

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
      : "This browser could not open its private key storage. Enable IndexedDB, close older FTown tabs, and try again. Lost or cleared keys require a fresh bridge invitation."}</p>
    <p className="text-xs text-[var(--text-muted)]">No plaintext connection is enabled. Keep access to the bridge's local CLI for recovery.</p>
    <button className="btn-ghost min-h-11" onClick={() => window.location.reload()}>Try again</button>
  </section></main>;
}

export function DashboardClient(props: DashboardClientProps) {
  const state = useBrowserIdentity(props.ownerId);
  if (state.status === "checking") return <main className="flex min-h-dvh items-center justify-center p-4"><p role="status" className="text-sm text-[var(--text-muted)]">Opening this browser's encryption identity…</p></main>;
  if (state.status === "error") return <BrowserSecurityUnavailable code={state.code} />;
  return <EncryptedDashboardClient {...props} identity={state.identity} pins={state.bridges} />;
}

function EncryptedDashboardClient({ identity, pins, ...props }: DashboardClientProps & { identity: EndpointIdentity; pins: ApprovedBridge[] }) {
  const { signOut } = useAuthMode();
  const resource = useMemo(() => ({ runtime: new SecureEndpointRuntime(identity, pins), leases: 0 }), [identity, pins]);
  useEffect(() => {
    resource.leases++;
    return () => { resource.leases--; queueMicrotask(() => { if (resource.leases === 0) resource.runtime.dispose(); }); };
  }, [resource]);
  const { client, status, error, transport } = useCentrifugo(props.token, props.centrifugoUrl, props.userId, {
    securityRuntime: resource.runtime, tokenRefresher: props.tokenRefresher, onUnauthorized: props.onUnauthorized,
  });
  const handleDisconnect = useCallback(() => { resource.runtime.dispose(); signOut(); }, [resource, signOut]);
  return <Dashboard client={client} connectionStatus={status} connectionError={error} userId={props.userId}
    token={props.token} centrifugoUrl={props.centrifugoUrl} transport={transport} onDisconnect={handleDisconnect} />;
}
