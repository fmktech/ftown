"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovedEndpoint, BridgeInvitation } from "@security/protocol";
import { securityErrorMessage, type SecurityBridge, type SecurityCommandExecutor } from "./SecurityPanel";

interface Props {
  bridge?: SecurityBridge;
  currentEndpointId: string | null;
  execute: SecurityCommandExecutor;
  onInvitation?: (invitation: BridgeInvitation) => void;
}

export function SecurityDevices({ bridge, currentEndpointId, execute, onInvitation }: Props) {
  const [devices, setDevices] = useState<ApprovedEndpoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [invitation, setInvitation] = useState<BridgeInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const bridgeId = bridge?.bridgeId ?? "";
  const ready = bridge?.security.status === "ready";

  const load = useCallback(async () => {
    if (!bridgeId) return;
    const request = generation.current;
    setLoading(true); setError(null);
    try {
      const result = await execute({ type: "security_devices", bridgeId });
      if (request === generation.current) setDevices(result.devices);
    } catch (failure) { if (request === generation.current) setError(securityErrorMessage(failure)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [bridgeId, execute]);

  useEffect(() => {
    generation.current++; setDevices(null); setError(null); setBusy(null); setInvitation(null); setCopied(false); setConfirmRevoke(null); setLoading(false);
    if (ready) void load();
    return () => { generation.current++; };
  }, [load, ready]);

  async function invite() {
    const request = generation.current;
    setBusy("invite"); setError(null); setInvitation(null); setCopied(false);
    try {
      const result = await execute({ type: "security_invite", bridgeId, label: label.trim() || "Another browser" });
      if (request !== generation.current) return;
      setInvitation(result); onInvitation?.(result);
    } catch (failure) { if (request === generation.current) setError(securityErrorMessage(failure)); }
    finally { if (request === generation.current) setBusy(null); }
  }

  async function revoke(endpointId: string) {
    const request = generation.current;
    setBusy(endpointId); setError(null);
    try {
      await execute({ type: "security_revoke", bridgeId, endpointId });
      if (request !== generation.current) return;
      setDevices(previous => previous?.filter(device => device.endpoint.id !== endpointId) ?? null);
      setConfirmRevoke(null);
    } catch (failure) { if (request === generation.current) setError(securityErrorMessage(failure)); }
    finally { if (request === generation.current) setBusy(null); }
  }

  if (!bridge) return <p className="rounded-md border border-[var(--border-muted)] p-4 text-sm text-[var(--text-muted)]">Choose a bridge to inspect its approved devices or invite another browser.</p>;
  if (!ready) return <div role="status" className="space-y-3 text-sm text-[var(--text-muted)]">
    <p>Device management needs an encrypted connection to this bridge.</p>
    <p>For first approval or recovery, run <code className="text-[var(--text-primary)]">ftown security invite</code> on that computer and open its invitation in this browser. Verify the bridge and account before approving.</p>
    {bridge.security.endpoint && <p className="break-all text-xs">Known bridge fingerprint: {bridge.security.endpoint.id}</p>}
  </div>;
  const self = devices?.find(device => device.endpoint.id === currentEndpointId);
  const canAdmin = self?.permissions.includes("admin") ?? false;
  const invitationUrl = invitation && typeof window !== "undefined"
    ? `${window.location.origin}/connect#invite=${encodeURIComponent(JSON.stringify(invitation))}` : null;

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-xl text-xs leading-relaxed text-[var(--text-muted)]">Each browser and MCP authorization has its own key. Approval belongs to this bridge; public directory entries alone never grant access.</p>
      <button type="button" className="btn-ghost min-h-11" disabled={loading || !!busy} onClick={() => void load()}>Refresh devices</button>
    </div>
    {error && <p role="alert" className="rounded-md border border-[var(--status-error)] p-3 text-sm text-[var(--status-error)]">{error}</p>}
    {loading && <p role="status" className="text-sm text-[var(--text-muted)]">Loading approved devices…</p>}
    {devices && !loading && devices.length === 0 && <p className="text-sm text-[var(--text-muted)]">No approved devices were returned by this bridge.</p>}
    {devices && <ul aria-label="Approved devices" className="space-y-3">
      {devices.map(device => <li key={device.endpoint.id} className="rounded-lg border border-[var(--border-muted)] bg-[var(--bg-base)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0"><h3 className="break-words text-sm font-semibold">{device.label || device.endpoint.kind}{device.endpoint.id === currentEndpointId ? " · This browser" : ""}</h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">{device.endpoint.kind} · {device.permissions.join(", ")}</p></div>
          {canAdmin && <button type="button" className="btn-ghost min-h-11 text-[var(--status-error)]" disabled={!!busy}
            aria-label={`Revoke ${device.label || device.endpoint.kind}`} onClick={() => setConfirmRevoke(device.endpoint.id)}>Revoke</button>}
        </div>
        <p className="mt-3 break-all font-mono text-[11px] text-[var(--text-faint)]">Fingerprint: {device.endpoint.id}</p>
        {device.expiresAt && <p className="mt-2 text-xs text-[var(--text-muted)]">Approval expires {new Date(device.expiresAt).toLocaleString()}.</p>}
        {confirmRevoke === device.endpoint.id && <div role="group" aria-label="Confirm device revocation" className="mt-3 space-y-3 border-t border-[var(--border-subtle)] pt-3">
          <p className="text-sm text-[var(--text-secondary)]">{device.endpoint.id === currentEndpointId ? "Revoking this browser disconnects it from this bridge. A new invitation will be required." : "Revoke this device's access on this bridge? Its open connections will close."}</p>
          <div className="flex flex-wrap gap-2"><button type="button" className="btn-danger min-h-11" disabled={!!busy} onClick={() => void revoke(device.endpoint.id)}>{busy === device.endpoint.id ? "Revoking…" : "Confirm revoke"}</button>
            <button type="button" className="btn-ghost min-h-11" disabled={!!busy} onClick={() => setConfirmRevoke(null)}>Cancel</button></div>
        </div>}
      </li>)}
    </ul>}
    {canAdmin && <section aria-labelledby="security-invite-title" className="space-y-3 rounded-lg border border-[var(--border-muted)] p-4">
      <h3 id="security-invite-title" className="text-sm font-semibold">Invite another browser</h3>
      <p className="text-xs leading-relaxed text-[var(--text-muted)]">Creates a single-use link lasting five minutes. Opening it requires account sign-in and explicit approval. Share it only with the intended device; it grants administrator access on this bridge.</p>
      <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">Device label
        <input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} placeholder="e.g. My phone"
          className="min-h-11 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] px-3 text-sm text-[var(--text-primary)]" />
      </label>
      <button type="button" className="btn-accent min-h-11" disabled={!!busy} onClick={() => void invite()}>{busy === "invite" ? "Creating invitation…" : "Create secure invitation"}</button>
      {invitationUrl && invitation && <div role="status" className="space-y-3 border-t border-[var(--border-subtle)] pt-3">
        <p className="text-xs text-[var(--text-muted)]">Invitation expires {new Date(invitation.expiresAt).toLocaleTimeString()}. The secret stays in the URL fragment; it is never an ordinary page query.</p>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">Private invitation link
          <input readOnly type="text" autoComplete="off" value={invitationUrl} onFocus={event => event.target.select()}
            className="min-h-11 w-full min-w-0 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] px-3 text-xs" />
        </label>
        <div className="flex flex-wrap gap-2"><button type="button" className="btn-ghost min-h-11" onClick={() => {
          if (!navigator.clipboard?.writeText) { setError("Copy was unavailable. Select and copy the private link above."); return; }
          void navigator.clipboard.writeText(invitationUrl).then(() => setCopied(true)).catch(() => setError("Copy was unavailable. Select and copy the private link above."));
        }}>{copied ? "Copied invitation" : "Copy invitation"}</button>
          <button type="button" className="btn-ghost min-h-11" onClick={() => { setInvitation(null); setCopied(false); }}>Hide invitation</button></div>
      </div>}
    </section>}
    {devices && !canAdmin && <p className="text-xs text-[var(--text-muted)]">An approved administrator browser or the bridge's local CLI can manage device access.</p>}
    <p className="text-xs leading-relaxed text-[var(--text-faint)]">Removing browser storage loses its private key. Account password resets cannot recover it. Keep access to the bridge's local CLI for recovery. Revocation on another offline bridge remains pending until that bridge is contacted.</p>
  </div>;
}
