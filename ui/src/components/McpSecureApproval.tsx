"use client";

import { useEffect, useMemo, useState } from "react";
import type { McpBridgeApproval, McpConsentSecurity } from "@security/protocol";
import { useBrowserIdentity } from "@/hooks/useBrowserIdentity";
import { useCentrifugo } from "@/hooks/useCentrifugo";
import { SecureEndpointRuntime } from "@/lib/secure-endpoint-runtime";
import { securityErrorMessage, securityStateLabel } from "./SecurityPanel";
import { DeviceApproval } from "./DeviceApproval";

export interface McpConsentDetails {
  clientName: string;
  redirectUri: string;
  scopes: string[];
  machines: string[];
  security: McpConsentSecurity;
}
interface Props { requestId: string; ownerId: string; email: string; details: McpConsentDetails; devices: { bridgeId: string; hostname: string | null }[] }

export function McpSecureApproval({ requestId, ownerId, email, details, devices }: Props) {
  const identity = useBrowserIdentity(ownerId);
  const endpoint = identity.status === "ready" ? identity.identity : null;
  const resource = useMemo(() => endpoint ? { runtime: new SecureEndpointRuntime(endpoint, identity.bridges, identity.accountClient?.assertBridgeAccess), leases: 0 } : null, [endpoint, identity.accountClient]);
  useEffect(() => { if (resource) resource.runtime.replacePins(identity.bridges); }, [resource, identity.bridges]);
  const [bootstrap, setBootstrap] = useState<{ token: string; centrifugoUrl: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [, setGeneration] = useState(0);
  useEffect(() => {
    if (!resource) return;
    resource.leases++;
    const off = resource.runtime.onChange(() => setGeneration(value => value + 1));
    const abort = new AbortController();
    void fetch("/api/auth/token", { method: "POST", credentials: "include", cache: "no-store", signal: abort.signal })
      .then(async response => { if (!response.ok) throw new Error("unauthorized"); const token = await response.json() as { token: string; centrifugoUrl: string }; if (!abort.signal.aborted) setBootstrap(token); })
      .catch(() => { if (!abort.signal.aborted) setError("Sign in again to establish encrypted bridge approvals."); });
    return () => { abort.abort(); off(); resource.leases--; queueMicrotask(() => { if (!resource.leases) resource.runtime.dispose(); }); };
  }, [resource]);
  const { client } = useCentrifugo(bootstrap?.token ?? null, bootstrap?.centrifugoUrl ?? null, email, { securityRuntime: resource?.runtime });
  const valid = details.security?.requestId === requestId && details.security.endpoint.ownerId === ownerId && details.security.endpoint.kind === "mcp";
  const expired = Date.parse(details.security?.expiresAt ?? "") <= Date.now();
  const allReady = !identity.account?.offline && selected.length > 0 && selected.every(id => resource?.runtime.state(id).status === "ready");

  async function complete(decision: "approve" | "deny") {
    if (decision === "approve" && (!valid || expired || !allReady || !client?.executeSecurity)) return;
    setBusy(true); setError(null);
    try {
      const approvals: McpBridgeApproval[] = [];
      if (decision === "approve" && client?.executeSecurity) {
        for (let index = 0; index < selected.length; index += 4) {
          setProgress(`Approving ${Math.min(index + 4, selected.length)} of ${selected.length} bridges…`);
          approvals.push(...await Promise.all(selected.slice(index, index + 4).map(bridgeId => client.executeSecurity!({ type: "security_approve_mcp", bridgeId,
            approval: { requestId, grantId: details.security.grantId, endpoint: details.security.endpoint, permissions: details.security.permissions,
              expiresAt: details.security.expiresAt, activeExpiresAt: details.security.activeExpiresAt } }))));
        }
      }
      setProgress(decision === "approve" ? "Verifying bridge receipts…" : "Cancelling authorization…");
      const response = await fetch("/api/mcp/consent", { method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, machines: decision === "approve" ? selected : [], approvals, decision }) });
      if (!response.ok) throw { code: "permission_denied" };
      const result = await response.json() as { redirect: string };
      const destination = new URL(result.redirect); const registered = new URL(details.redirectUri);
      if (destination.origin !== registered.origin || destination.pathname !== registered.pathname) throw { code: "wrong_context" };
      window.location.assign(destination.href);
    } catch (failure) {
      setError(`${securityErrorMessage(failure)} Any incomplete bridge approvals expire automatically; no authorization is issued without verified receipts.`);
    } finally { setBusy(false); setProgress(null); }
  }

  if (identity.account?.status === "unapproved" && identity.account.historyExists && !identity.bridges.length && identity.accountClient) return <main className="min-h-dvh p-4 sm:p-8"><DeviceApproval ownerId={ownerId} email={email} client={identity.accountClient} /></main>;
  return <main className="mx-auto max-w-2xl space-y-5 p-4 sm:p-8">
    <h1 className="break-words text-2xl font-semibold">Connect {details.clientName} to FTown</h1>
    <p className="text-sm text-[var(--text-muted)]">Signed in as {email}.</p>
    <p className="text-sm leading-relaxed">{details.scopes.includes("mcp:control")
      ? "This client can read sessions and conversations, launch and stop agents, send messages, and control terminals on the bridges you select."
      : "This client can read sessions, conversations, messages and usage on the bridges you select."}</p>
    <p className="text-xs leading-relaxed text-[var(--text-muted)]">The hosted MCP gateway sees tool requests and results over HTTPS. Its separate grant key is encrypted at rest. This single consent obtains verified read/control receipts from all selected computers; the gateway cannot approve account devices. No model PIN is needed.</p>
    <p className="break-all text-xs text-[var(--text-faint)]">Client callback: {details.redirectUri}</p>
    {!valid && <p role="alert" className="text-sm text-[var(--status-error)]">This authorization identity is invalid. Start again from your MCP client.</p>}
    {expired && <p role="alert" className="text-sm text-[var(--status-error)]">This authorization request expired. Start again from your MCP client.</p>}
    {identity.status === "checking" && <p role="status" className="text-sm text-[var(--text-muted)]">Opening your approved browser identity…</p>}
    {identity.status === "error" && <p role="alert" className="text-sm text-[var(--status-error)]">Use HTTPS or trustworthy localhost with browser key storage enabled. This consent cannot fall back to plaintext.</p>}
    <fieldset disabled={busy} className="space-y-3"><legend className="mb-3 font-semibold">Choose computers for this authorization</legend>
      {devices.length > 0 && <label className="flex min-h-11 items-center gap-3 rounded border border-[var(--border-muted)] p-3 text-sm">
        <input type="checkbox" checked={devices.length > 0 && selected.length === devices.length} onChange={event => setSelected(event.target.checked ? devices.map(device => device.bridgeId) : [])} />Select all listed computers
      </label>}
      {devices.map(device => {
        const state = resource?.runtime.state(device.bridgeId);
        return <label key={device.bridgeId} data-bridge-id={device.bridgeId} className="flex min-h-11 items-start gap-3 rounded-lg border border-[var(--border-muted)] p-4 text-sm">
          <input type="checkbox" className="mt-1" checked={selected.includes(device.bridgeId)} onChange={event => setSelected(previous => event.target.checked ? [...previous, device.bridgeId] : previous.filter(id => id !== device.bridgeId))} />
          <span className="min-w-0"><span className="block break-words font-semibold">{device.hostname || device.bridgeId}</span>
            <span className="mt-1 block text-xs text-[var(--text-muted)]">{securityStateLabel(state?.status ?? "unpaired")}</span>
            {state?.status !== "ready" && <span className="mt-1 block text-xs text-[var(--text-faint)]">Connect this computer and wait for its account trust update. A legacy computer must first use account device approvals.</span>}</span>
        </label>;
      })}
      {devices.length === 0 && <p className="text-sm text-[var(--text-muted)]">No eligible computers are available for this account.</p>}
    </fieldset>
    <p className="text-xs text-[var(--text-muted)]">Only the selected computers are included; future computers require new consent. Selected offline or unavailable computers block completion. Cancelled pending approvals expire automatically.</p>
    {error && <p role="alert" className="text-sm text-[var(--status-error)]">{error}</p>}
    {progress && <p role="status" className="text-sm text-[var(--text-muted)]">{progress}</p>}
    <div className="flex flex-wrap gap-3"><button type="button" className="btn-accent min-h-11" disabled={busy || !valid || expired || !allReady} onClick={() => void complete("approve")}>Approve encrypted access</button>
      <button type="button" className="btn-ghost min-h-11" disabled={busy} onClick={() => void complete("deny")}>Cancel</button></div>
  </main>;
}
