"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ApprovedEndpoint, BridgeInvitation } from "@security/protocol";
import { LEDGER_LIMITS, type LedgerBridge, type LedgerCheckpoint, type LedgerDevice, type LedgerOperation, type LedgerTransition, type Signed } from "@security/ledger/protocol";
import { securityErrorMessage, type SecurityBridge, type SecurityCommandExecutor } from "./SecurityPanel";
import { SecurityAccessMap, accessBrowserLabel, type SecurityAccessBrowserNode, type SecurityAccessBridgeNode, type SecurityAccessSelection } from "./SecurityAccessMap";
import type { SecurityLockState } from "./SecurityLockIcon";
import { useDeviceDisplayNames } from "@/hooks/useDeviceDisplayNames";
import { DeviceDisplayNameEditor } from "./DeviceDisplayNameEditor";
import { securityErrorCode, useAccountSecurity, type AccountSecurity } from "@/hooks/useAccountSecurity";
import type { LedgerClient, LedgerClientSnapshot } from "@/lib/ledger-client";

interface Props {
  bridge?: SecurityBridge;
  currentEndpointId: string | null;
  currentComputerIds?: ReadonlySet<string>;
  execute: SecurityCommandExecutor;
  onInvitation?: (invitation: BridgeInvitation) => void;
  bridges?: SecurityBridge[];
  /** Account mode: the signed-in accountId; the view then comes from the passkey ledger. Solo/local leave it unset. */
  accountId?: string | null;
}

function ComputerApprovalRecovery() {
  return <p className="text-xs leading-relaxed text-[var(--text-muted)]">On that computer, while its FTown bridge is running, run <code>ftown security invite</code>. Open the printed private link in this browser and verify the computer and account before approving. This grants access to that computer only; it does not restore account signing keys or share the computer with other browsers.</p>;
}

export function SecurityDevices(props: Props) {
  if (props.accountId) return <LedgerDevices accountId={props.accountId} bridges={props.bridges ?? []} selected={props.bridge} currentEndpointId={props.currentEndpointId} currentComputerIds={props.currentComputerIds} />;
  const bridge = props.bridge ?? props.bridges?.find(item => props.currentComputerIds?.has(item.bridgeId));
  return <BridgeDevices {...props} bridge={bridge} initialBridgeSelected={!!props.bridge} />;
}

function BridgeDevices({ bridge, currentEndpointId, currentComputerIds, execute, onInvitation, initialBridgeSelected }: Props & { initialBridgeSelected: boolean }) {
  const [devices, setDevices] = useState<ApprovedEndpoint[] | null>(null);
  const [loadedContext, setLoadedContext] = useState("");
  const [selection, setSelection] = useState<{ context: string; node: SecurityAccessSelection } | null>(null);
  const [approvalClock, setApprovalClock] = useState(Date.now);
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
  const context = `${bridgeId}:${bridge?.security.endpoint?.id ?? ""}:${currentEndpointId ?? ""}`;
  const currentContext = useRef(context); currentContext.current = context;
  const currentDevices = loadedContext === context ? devices : null;

  const load = useCallback(async () => {
    if (!bridgeId) return;
    const request = generation.current;
    setLoading(true); setError(null);
    try {
      const result = await execute({ type: "security_devices", bridgeId });
      if (request === generation.current && currentContext.current === context) { setDevices(result.devices); setLoadedContext(context); }
    } catch (failure) { if (request === generation.current && currentContext.current === context) setError(securityErrorMessage(failure)); }
    finally { if (request === generation.current && currentContext.current === context) setLoading(false); }
  }, [bridgeId, context, execute]);

  useEffect(() => {
    generation.current++; setDevices(null); setError(null); setBusy(null); setInvitation(null); setCopied(false); setConfirmRevoke(null); setLoading(false);
    if (ready) void load();
    return () => { generation.current++; };
  }, [load, ready]);
  useEffect(() => {
    const nextExpiry = Math.min(...(currentDevices ?? []).map(device => device.expiresAt ? Date.parse(device.expiresAt) : Infinity).filter(expiry => Number.isFinite(expiry) && expiry > approvalClock));
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => setApprovalClock(Date.now()), Math.min(2147483647, Math.max(1, nextExpiry - Date.now())));
    return () => clearTimeout(timer);
  }, [currentDevices, approvalClock]);

  async function invite() {
    const request = generation.current;
    setBusy("invite"); setError(null); setInvitation(null); setCopied(false);
    try {
      const result = await execute({ type: "security_invite", bridgeId, label: label.trim() || "Another browser" });
      if (request !== generation.current || currentContext.current !== context) return;
      setInvitation(result); onInvitation?.(result);
    } catch (failure) { if (request === generation.current && currentContext.current === context) setError(securityErrorMessage(failure)); }
    finally { if (request === generation.current && currentContext.current === context) setBusy(null); }
  }

  async function revoke(endpointId: string) {
    const request = generation.current;
    setBusy(endpointId); setError(null);
    try {
      await execute({ type: "security_revoke", bridgeId, endpointId });
      if (request !== generation.current || currentContext.current !== context) return;
      setDevices(previous => previous?.filter(device => device.endpoint.id !== endpointId) ?? null);
      setConfirmRevoke(null);
    } catch (failure) { if (request === generation.current && currentContext.current === context) setError(securityErrorMessage(failure)); }
    finally { if (request === generation.current && currentContext.current === context) setBusy(null); }
  }

  if (!bridge) return <p className="rounded-md border border-[var(--border-muted)] p-4 text-sm text-[var(--text-muted)]">Choose a bridge to inspect its approved devices or invite another browser.</p>;
  const activeApproval = (device: ApprovedEndpoint) => !device.expiresAt || Date.parse(device.expiresAt) > Math.max(approvalClock, Date.now());
  const self = currentDevices?.find(device => device.endpoint.id === currentEndpointId);
  const verified = ready && !loading && !error && !!self && activeApproval(self);
  const canAdmin = verified && self.permissions.includes("admin");
  const accountManaged = !!currentDevices?.some(device => device.source === "account");
  const browserNodes: SecurityAccessBrowserNode[] = (currentDevices ?? []).filter(device => device.endpoint.kind === "browser").map(device => ({
    id: device.endpoint.id, label: device.label || "Browser", current: device.endpoint.id === currentEndpointId,
    accessText: !activeApproval(device) ? "Approval expired" : verified ? `${device.source === "account" ? "Account-managed" : "This computer only"} · ${device.permissions.join(", ")}` : "Access not verified",
    lockState: verified && activeApproval(device) ? "secured" : "unknown", edge: verified && activeApproval(device) ? "current" : "none",
  }));
  if (currentEndpointId && !browserNodes.some(node => node.id === currentEndpointId)) browserNodes.unshift({ id: currentEndpointId, label: "This browser", current: true,
    accessText: loading ? "Checking approvals…" : "Access not verified", lockState: "unknown", edge: "none" });
  const fallback: SecurityAccessSelection = initialBridgeSelected || !browserNodes.length ? { kind: "bridge", id: bridgeId }
    : { kind: "browser", id: browserNodes.find(node => node.current)?.id ?? browserNodes[0].id };
  const selected = selection?.context === context && (selection.node.kind === "bridge" ? selection.node.id === bridgeId : browserNodes.some(node => node.id === selection.node.id)) ? selection.node : fallback;
  const selectedDevices = (currentDevices ?? []).filter(device => selected.kind === "browser" ? device.endpoint.id === selected.id : device.endpoint.kind !== "browser");
  const invitationUrl = invitation && typeof window !== "undefined"
    ? `${window.location.origin}/connect#invite=${encodeURIComponent(JSON.stringify(invitation))}` : null;

  const details = <section aria-label="Selected access details" className="space-y-3">
    {selected.kind === "bridge" && <p className="text-xs leading-relaxed text-[var(--text-muted)]">Each browser has its own key. Approval belongs to this computer; public directory entries alone never grant access.</p>}
    {selectedDevices.length > 0 && <ul aria-label={selected.kind === "bridge" ? "Other approved clients" : "Selected approved browser"} className="space-y-3">
      {selectedDevices.map(device => <li key={device.endpoint.id} className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">{selected.kind === "bridge" && <h3 className="break-words text-sm font-semibold">{device.label || device.endpoint.kind}</h3>}
            <p className="mt-1 text-xs text-[var(--text-muted)]">{device.endpoint.kind} · {device.permissions.join(", ")}</p></div>
          {canAdmin && device.source !== "account" && <button type="button" className="btn-ghost min-h-11 sm:min-h-8 text-[var(--status-error)]" disabled={!!busy}
            aria-label={`Revoke ${device.label || device.endpoint.kind}`} onClick={() => setConfirmRevoke(device.endpoint.id)}>Revoke</button>}
        </div>
        <details className="mt-2 text-xs"><summary className="min-h-11 sm:min-h-8 cursor-pointer py-3 sm:py-2">Device details</summary><p className="break-all font-mono text-[11px] text-[var(--text-faint)]">Fingerprint: {device.endpoint.id}</p></details>
        {device.source === "account" && <p className="mt-2 text-xs text-[var(--text-muted)]">Account device — manage its account-wide access from the hosted dashboard.</p>}
        {device.expiresAt && <p className="mt-2 text-xs text-[var(--text-muted)]">Approval expires {new Date(device.expiresAt).toLocaleString()}.</p>}
        {confirmRevoke === device.endpoint.id && <div role="group" aria-label="Confirm device revocation" className="mt-3 space-y-3 border-t border-[var(--border-subtle)] pt-3">
          <p className="text-sm text-[var(--text-secondary)]">{device.endpoint.id === currentEndpointId ? "Revoking this browser disconnects it from this bridge. A new invitation will be required." : "Revoke this device's access on this bridge? Its open connections will close."}</p>
          <div className="flex flex-wrap gap-2"><button type="button" className="btn-danger min-h-11 sm:min-h-8" disabled={!!busy || !canAdmin || device.source === "account"} onClick={() => void revoke(device.endpoint.id)}>{busy === device.endpoint.id ? "Revoking…" : "Confirm revoke"}</button>
            <button type="button" className="btn-ghost min-h-11 sm:min-h-8" disabled={!!busy} onClick={() => setConfirmRevoke(null)}>Cancel</button></div>
        </div>}
      </li>)}
    </ul>}
    {canAdmin && !accountManaged && selected.kind === "bridge" && <section aria-labelledby="security-invite-title" className="space-y-3 border-t border-[var(--border-subtle)] pt-2">
      <h3 id="security-invite-title" className="text-sm font-semibold">Invite another browser</h3>
      <p className="text-xs leading-relaxed text-[var(--text-muted)]">Creates a single-use link lasting five minutes. Opening it requires account sign-in and explicit approval. Share it only with the intended device; it grants administrator access on this bridge.</p>
      <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">Device label
        <input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} placeholder="e.g. My phone"
          className="min-h-11 sm:min-h-8 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] px-3 text-sm text-[var(--text-primary)]" />
      </label>
      <button type="button" className="btn-accent min-h-11 sm:min-h-8" disabled={!!busy} onClick={() => void invite()}>{busy === "invite" ? "Creating invitation…" : "Create secure invitation"}</button>
      {invitationUrl && invitation && <div role="status" className="space-y-3 border-t border-[var(--border-subtle)] pt-3">
        <p className="text-xs text-[var(--text-muted)]">Invitation expires {new Date(invitation.expiresAt).toLocaleTimeString()}. The secret stays in the URL fragment; it is never an ordinary page query.</p>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">Private invitation link
          <input readOnly type="text" autoComplete="off" value={invitationUrl} onFocus={event => event.target.select()}
            className="min-h-11 sm:min-h-8 w-full min-w-0 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] px-3 text-xs" />
        </label>
        <div className="flex flex-wrap gap-2"><button type="button" className="btn-ghost min-h-11 sm:min-h-8" onClick={() => {
          if (!navigator.clipboard?.writeText) { setError("Copy was unavailable. Select and copy the private link above."); return; }
          void navigator.clipboard.writeText(invitationUrl).then(() => setCopied(true)).catch(() => setError("Copy was unavailable. Select and copy the private link above."));
        }}>{copied ? "Copied invitation" : "Copy invitation"}</button>
          <button type="button" className="btn-ghost min-h-11 sm:min-h-8" onClick={() => { setInvitation(null); setCopied(false); }}>Hide invitation</button></div>
      </div>}
    </section>}
    {selected.kind === "bridge" && accountManaged && <p className="text-xs text-[var(--text-muted)]">Manage account browsers from the hosted dashboard. Local recovery grants access only to this computer.</p>}
    {selected.kind === "bridge" && ready && <details className="text-xs"><summary className="min-h-11 sm:min-h-8 cursor-pointer py-3 sm:py-2">Approve a browser on this computer</summary><ComputerApprovalRecovery /></details>}
    {selected.kind === "bridge" && bridge.security.endpoint && <details className="text-xs"><summary className="min-h-11 sm:min-h-8 cursor-pointer py-3 sm:py-2">Computer details</summary><p className="break-all font-mono">Known bridge fingerprint: {bridge.security.endpoint.id}</p></details>}
    {selected.kind === "browser" && !selectedDevices.length && <p className="text-xs text-[var(--text-muted)]">Refresh this computer's approvals to verify this browser's access.</p>}
  </section>;
  const lockState: SecurityLockState = verified ? "secured" : ["unpaired", "revoked", "key_changed", "upgrade_required"].includes(bridge.security.status) ? "approval_needed" : "unknown";
  return <div className="space-y-3">
    <SecurityAccessMap scope="computer" browsers={browserNodes} bridges={[{ id: bridgeId, label: bridge.label, current: ready && !!currentComputerIds?.has(bridgeId),
      accessText: verified ? "Computer approvals verified" : loading ? "Checking approvals…" : "Access not verified", connectionText: ready ? "Connected" : bridge.security.status === "offline" ? "Offline" : "Not connected", lockState, edge: verified ? "current" : "none" }]}
      account={{ statusText: verified ? "Verified here" : "Not verified", lockState }} selected={selected}
      onSelect={node => { setSelection({ context, node }); setConfirmRevoke(null); }} selectedDetails={details}
      toolbar={<div className="flex flex-wrap items-center gap-2"><button type="button" className="btn-ghost min-h-11 sm:min-h-8" disabled={!ready || loading || !!busy} onClick={() => void load()}>Refresh devices</button>
        {error && <p role="alert" className="w-full text-sm text-[var(--status-error)]">{error}</p>}
        {loading && <p role="status" className="text-xs text-[var(--text-muted)]">Loading approved devices…</p>}
        {currentDevices && !loading && !currentDevices.length && <p className="text-xs text-[var(--text-muted)]">No approved devices were returned by this bridge.</p>}
      </div>} />
    {!ready && <div role="status" className="space-y-2 text-xs text-[var(--text-muted)]"><p>Device management needs an encrypted connection to this bridge.</p>{bridge.security.status === "upgrade_required" ? <p>Upgrade FTown on that computer before opening a fresh invitation.</p> : <ComputerApprovalRecovery />}</div>}
    {currentDevices && !canAdmin && !loading && <p className="text-xs text-[var(--text-muted)]">An approved administrator browser or the bridge's local CLI can manage device access.</p>}
    <details className="text-xs text-[var(--text-muted)]"><summary className="min-h-11 sm:min-h-8 cursor-pointer py-3 sm:py-2">Recovery and security details</summary><p>Removing browser storage loses its private key. Account password resets cannot recover it. Keep access to the bridge's local CLI for recovery. Revocation on another offline bridge remains pending until that bridge is contacted.</p></details>
  </div>;
}


// ---- Account mode: the passkey ledger. ----

const REMOVE_CONFIRM = (label: string) => `Remove ${label} from your account? It loses access immediately. To use it again, pair it as a new computer.`;
const REMOVE_BROWSER_CONFIRM = (label: string) => `Remove ${label} from your account? It loses access to your computers immediately. To use it again, sign in on it with your passkey.`;
const REMOVE_THIS_BROWSER_CONFIRM = "Remove this browser from your account? It loses access to your computers immediately. To use it again, sign in here with your passkey.";
const ACCOUNT_MISMATCH = "This browser holds a different account than the one you are signed in to. Sign in again with your passkey.";
const LOCAL_ONLY = "Removed on this browser only — not yet applied to your account";
/** A removal in this browser's chain that the server has not taken yet (refused or failed); the client re-sends it by itself. */
const UNSAVED = "Removal not saved to the server yet";
const UNSAVED_DETAIL = "Removal not saved to the server yet. It can still connect. Retrying…";
const UNSAVED_SELF_DETAIL = "This browser's removal is not saved to the server yet. It can still connect. Retrying…";
/** No automatic retry: sending this chain would drop removals the server has (snapshot.conflict). */
const UNSAVED_CONFLICT = "Not saved to the server. Sign this removal again from this browser.";
/** No automatic retry: this browser's own removal came from another chain, so it cannot write (snapshot.canReoffer false). */
const UNSAVED_BLOCKED = "Not saved to the server. Remove it again from another browser of your account.";
/** A removal while nothing is confirmed about the server (snapshot.serverState 'unknown'). */
const UNCONFIRMED = "Removed here. Not confirmed by the server yet.";

/**
 * Signed entries this page has seen per ledger client. The snapshot's checkpoint drops an entry once this browser revoked it locally;
 * a local-only removal still needs its signed name and fingerprint on screen.
 */
const seenEntries = new WeakMap<LedgerClient, { devices: Map<string, LedgerDevice>; bridges: Map<string, LedgerBridge> }>();
function rememberEntries(client: LedgerClient | null, checkpoint: LedgerCheckpoint | null): void {
  if (!client || !checkpoint) return;
  const seen = seenEntries.get(client) ?? { devices: new Map<string, LedgerDevice>(), bridges: new Map<string, LedgerBridge>() };
  for (const item of checkpoint.devices) seen.devices.set(item.endpoint.id, item);
  for (const item of checkpoint.bridges) seen.bridges.set(item.bridgeId, item);
  seenEntries.set(client, seen);
}

/** The ledger's own (passkey-signed) name and a short fingerprint, so a server-side display name cannot disguise the target. */
function SignedIdentity({ label, id }: { label: string | null; id: string }) {
  return <p data-signed-identity className="break-words text-xs text-[var(--text-muted)] [overflow-wrap:anywhere]">Signed name: {label ? `“${label}”` : "not known on this browser"} · ID {id.slice(0, 8)}</p>;
}

function TrashIcon() {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>;
}

const browserName = (label: string, self: boolean) => self && /^(this device|this browser|browser)$/i.test(label.trim()) ? "This browser" : !self && /^this (device|browser)$/i.test(label.trim()) ? "Browser" : label || "Browser";
const recordKey = (record: Signed<LedgerTransition>) => `${record.payload.revision}:${record.payload.previousHead}:${record.payload.issuedAt}:${record.payload.credentialId}`;
const shortId = (id: string) => id.slice(-6);

/**
 * A ledger write: one click, at most one passkey prompt. While the account has several passkeys and this page does not know which
 * one this device holds, the same place offers "Choose passkey" (its own click and prompt) instead of the write.
 */
function PasskeyActionButton({ security, actionKey, label, busyLabel, ariaLabel, className, disabled, action, onDone }: {
  security: AccountSecurity; actionKey: string; label: string; busyLabel: string; ariaLabel?: string; className: string; disabled?: boolean;
  action: (client: LedgerClient) => Promise<void>; onDone?: () => void;
}) {
  if (security.needsSigner) return <button type="button" className="btn-accent min-h-11 sm:min-h-8" disabled={!!security.busy || disabled}
    onClick={() => void security.chooseSigner()}>{security.busy === "signer" ? "Waiting for passkey…" : "Choose passkey"}</button>;
  return <button type="button" aria-label={ariaLabel} className={`${className} min-h-11 sm:min-h-8`} disabled={!!security.busy || disabled}
    onClick={() => void security.run(actionKey, action, { signs: true }).then(done => { if (done) onDone?.(); })}>{security.busy === actionKey ? busyLabel : label}</button>;
}

/** The clock, re-read every second until `until` (epoch ms) has passed; for "Retry in N s". */
function useClockUntil(until: number | null): number {
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

/**
 * A removal the server has not taken yet. The client sends it again by itself; "Retry now" sends it at once, without a passkey, but
 * never before a server Retry-After. No retry happens in a conflict (the owner must sign the conflicting removals again here) or when
 * this browser cannot write: the text then says what to do instead, and there is no button.
 */
function UnsavedRemoval({ security, label, id, self = false }: { security: AccountSecurity; label: string | null; id: string; self?: boolean }) {
  const { snapshot } = security;
  const blocked = snapshot.canReoffer === false;
  const conflict = !blocked && snapshot.conflict === true;
  const notBefore = snapshot.retryNotBefore ?? null;
  const now = useClockUntil(notBefore);
  const wait = notBefore === null ? 0 : Math.ceil((notBefore - now) / 1000);
  const text = blocked ? UNSAVED_BLOCKED : conflict ? UNSAVED_CONFLICT : self ? UNSAVED_SELF_DETAIL : UNSAVED_DETAIL;
  return <div role="group" aria-label="Removal not saved" className="space-y-2 rounded-md border border-[var(--status-pending)] p-3">
    <p className="text-sm">{text}</p>
    <SignedIdentity label={label} id={id} />
    {!blocked && !conflict && <button type="button" className="btn-ghost min-h-11 sm:min-h-8" disabled={!!security.busy || wait > 0}
      onClick={() => void security.run("retry", client => client.retryNow())}>{wait > 0 ? `Retry in ${wait} s` : security.busy === "retry" ? "Retrying…" : "Retry now"}</button>}
  </div>;
}

function SignerHint({ security }: { security: AccountSecurity }) {
  if (!security.needsSigner) return null;
  return <p className="text-xs text-[var(--text-muted)]">Your account has {security.snapshot.checkpoint?.authorities.length ?? 0} passkeys. Choose the passkey on this device first, then confirm.</p>;
}

/** The fork notice: local records dropped because a longer chain won. Each can be signed again (one prompt each). */
function DiscardedChanges({ security, canWrite, describe }: { security: AccountSecurity; canWrite: boolean; describe: (operation: LedgerOperation) => string }) {
  const { client, snapshot } = security;
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const trusted = snapshot.checkpoint;
  const entries = snapshot.discarded;
  /** Why an addition can no longer be signed again (it is present, or its target was removed since); null when it can. */
  const settled = (operation: LedgerOperation): string | null => {
    if (!trusted) return null;
    if (operation.type === "add_device") {
      const id = operation.device.endpoint.id;
      return trusted.devices.some(item => item.endpoint.id === id) ? "Already in your account" : trusted.revokedDeviceIds.includes(id) ? "Removed since; it cannot be added again" : null;
    }
    if (operation.type === "add_bridge") {
      const id = operation.bridge.bridgeId;
      return trusted.bridges.some(item => item.bridgeId === id) ? "Already in your account" : trusted.revokedBridgeIds.includes(id) ? "Removed since; pair it as a new computer" : null;
    }
    if (operation.type === "add_authority") return trusted.authorities.some(item => item.credentialId === operation.authority.credentialId) ? "Already in your account" : null;
    return null;
  };
  const handled = entries.filter(entry => recordKey(entry) in resolved || settled(entry.payload.operation) !== null).length;
  const signedHere = entries.some(entry => recordKey(entry) in resolved);
  useEffect(() => {
    if (entries.length && signedHere && handled === entries.length) client.dismissDiscarded();
  }, [client, entries.length, handled, signedHere]);
  if (!entries.length) return null;
  return <section aria-label="Changes not kept" className="space-y-2 rounded-md border border-[var(--status-pending)] p-3">
    <h3 className="text-sm font-semibold">Some account changes were not kept</h3>
    <p className="text-xs leading-relaxed text-[var(--text-muted)]">These changes were signed on this browser but are not part of your account, because another change was saved first or they never reached the server. Sign them again to apply them.</p>
    <SignerHint security={security} />
    <ul aria-label="Changes to sign again" className="space-y-2">
      {entries.map(entry => {
        const key = recordKey(entry); const operation = entry.payload.operation; const text = describe(operation);
        const note = resolved[key] ?? settled(operation);
        let outcome = "Signed again";
        return <li key={key} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">{text}</span>
          {note !== null ? <span className="text-xs text-[var(--text-muted)]">{note}</span>
            : <PasskeyActionButton security={security} actionKey={`discarded:${key}`} label="Sign again" busyLabel="Waiting for passkey…" ariaLabel={`Sign again: ${text}`}
              className="btn-accent" disabled={!canWrite} action={async ledger => {
                try { await ledger.append(operation); }
                catch (failure) {
                  // The winning chain already removed it: nothing left to sign.
                  if ((operation.type === "revoke_device" || operation.type === "revoke_bridge") && securityErrorCode(failure) === "ledger_revoked") { outcome = "Already removed"; return; }
                  throw failure;
                }
              }} onDone={() => setResolved(previous => ({ ...previous, [key]: outcome }))} />}
        </li>;
      })}
    </ul>
    <button type="button" className="btn-ghost min-h-11 sm:min-h-8" disabled={!!security.busy} onClick={() => client.dismissDiscarded()}>Dismiss</button>
  </section>;
}

/** Account passkeys and the three-gesture "add another passkey" flow (create, consent, approve). */
function PasskeysSection({ security, canWrite }: { security: AccountSecurity; canWrite: boolean }) {
  const { snapshot, busy } = security;
  const titleId = useId();
  const [label, setLabel] = useState("");
  /** The client has no reset for a half-done add-passkey flow: Cancel hides that step here until a new start (a reload discards it). */
  const [abandoned, setAbandoned] = useState<LedgerClientSnapshot["pending"] | null>(null);
  useEffect(() => { if (snapshot.pending === "none") setAbandoned(null); }, [snapshot.pending]);
  const step = abandoned !== null && snapshot.pending === abandoned ? "none" : snapshot.pending;
  const authorities = snapshot.checkpoint?.authorities ?? [];
  const full = authorities.length >= LEDGER_LIMITS.maxAuthorities;
  const start = () => void security.run("passkey:create", client => client.addAuthorityStart({ label: label.trim() || "Passkey" })).then(done => { if (done) setAbandoned(null); });
  const restart = <div className="flex flex-wrap gap-2">
    <button type="button" className="btn-ghost min-h-11 sm:min-h-8" disabled={!!busy || !canWrite} onClick={start}>{busy === "passkey:create" ? "Waiting for passkey…" : "Start over"}</button>
    <button type="button" className="btn-ghost min-h-11 sm:min-h-8" disabled={!!busy} onClick={() => { security.clearError(); setAbandoned(snapshot.pending); }}>Cancel</button></div>;
  return <section aria-labelledby={titleId} className="space-y-3 border-t border-[var(--border-subtle)] pt-3">
    <h3 id={titleId} className="text-sm font-semibold">Passkeys</h3>
    <p className="text-xs leading-relaxed text-[var(--text-muted)]">Your passkeys sign every change to your account: adding or removing browsers, computers and passkeys. Each change asks for one passkey confirmation.</p>
    {authorities.length > 0 ? <ul aria-label="Account passkeys" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {authorities.map(authority => <li key={authority.credentialId} className="min-w-0 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] p-2">
        <p className="break-words text-sm font-semibold [overflow-wrap:anywhere]">{authority.label || "Passkey"}</p>
        <p className="text-xs text-[var(--text-muted)]">Added {new Date(authority.addedAt).toLocaleString()}</p>
        <details className="text-xs"><summary className="min-h-11 cursor-pointer py-3 sm:min-h-8 sm:py-2">Passkey details</summary><p className="break-all font-mono text-[11px] text-[var(--text-faint)]">Credential ID: {authority.credentialId}</p></details>
      </li>)}
    </ul> : <p className="text-xs text-[var(--text-muted)]">Sign in with your passkey to see your account's passkeys.</p>}
    {security.needsSigner && <div role="group" aria-label="Choose passkey" className="space-y-2 rounded-md border border-[var(--border-muted)] p-3">
      <p className="text-xs text-[var(--text-muted)]">Your account has {authorities.length} passkeys. Before changing your account, choose the passkey on this device.</p>
      <button type="button" className="btn-accent min-h-11 sm:min-h-8" disabled={!!busy || !canWrite} onClick={() => void security.chooseSigner()}>{busy === "signer" ? "Waiting for passkey…" : "Choose passkey"}</button>
    </div>}
    {canWrite && <div role="group" aria-label="Add another passkey" className="space-y-2 rounded-md border border-[var(--border-muted)] p-3">
      <h4 className="text-xs font-semibold">Add another passkey</h4>
      <p className="text-xs leading-relaxed text-[var(--text-muted)]">A second passkey, such as a security key, keeps your account usable if you lose this one. It takes three steps, each with one passkey prompt.</p>
      {full ? <p className="text-xs text-[var(--text-muted)]">Your account has the maximum of {LEDGER_LIMITS.maxAuthorities} passkeys.</p>
        : step === "authority_created" ? <>
          <p className="text-xs">Step 2 of 3: confirm that the new passkey joins this account.</p>
          <button type="button" className="btn-accent min-h-11 sm:min-h-8" disabled={!!busy} onClick={() => void security.run("passkey:consent", client => client.addAuthorityConsent())}>{busy === "passkey:consent" ? "Waiting for passkey…" : "Confirm new passkey"}</button>
          {restart}
        </> : step === "authority_consented" ? <>
          <p className="text-xs">Step 3 of 3: approve the new passkey with a passkey already in your account.</p>
          <SignerHint security={security} />
          <PasskeyActionButton security={security} actionKey="passkey:approve" label="Approve new passkey" busyLabel="Waiting for passkey…" className="btn-accent" action={client => client.addAuthorityFinish()} onDone={() => setLabel("")} />
          {restart}
        </> : <>
          {abandoned !== null && <p role="status" className="text-xs text-[var(--text-muted)]">Adding the passkey was cancelled. Reloading this page discards the unfinished passkey; you can also delete it from your authenticator.</p>}
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">New passkey name
            <input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} placeholder="e.g. Security key"
              className="min-h-11 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] px-3 text-sm text-[var(--text-primary)] sm:min-h-8" />
          </label>
          <p className="text-xs">Step 1 of 3: create the new passkey.</p>
          <button type="button" className="btn-accent min-h-11 sm:min-h-8" disabled={!!busy} onClick={start}>{busy === "passkey:create" ? "Waiting for passkey…" : "Create passkey"}</button>
        </>}
    </div>}
  </section>;
}

function LedgerDevices({ accountId, bridges, selected, currentEndpointId, currentComputerIds }: {
  accountId: string; bridges: SecurityBridge[]; selected?: SecurityBridge; currentEndpointId: string | null; currentComputerIds?: ReadonlySet<string>;
}) {
  const security = useAccountSecurity();
  const { snapshot, busy } = security;
  const displayNames = useDeviceDisplayNames(accountId);
  const [selection, setSelection] = useState<{ scope: string; node: SecurityAccessSelection } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const context = `${accountId}:${currentEndpointId ?? ""}`;
  useEffect(() => { setConfirm(null); }, [context]);
  const mismatch = !!snapshot.checkpoint && snapshot.checkpoint.accountId !== accountId;
  const trusted = mismatch ? null : snapshot.checkpoint;
  const revokedHere = snapshot.status === "device_revoked";
  /** The verified chain (sticky revocations applied) is on screen; this browser's own membership is reported separately. */
  const verified = !!trusted && (snapshot.status === "ready" || revokedHere);
  const accountReady = !!trusted && snapshot.status === "ready";
  /** Passkey-signed changes only from a browser that is itself in the account (never in device_revoked). */
  const canWrite = accountReady;
  const displayName = (kind: "browser" | "bridge", id: string) => displayNames.names.find(item => item.kind === kind && item.id === id)?.name;
  // Revoked on this browser only: still in the account for the server, the computers and the other browsers.
  const localDevices = trusted ? snapshot.localOnly.deviceIds : [];
  const localBridges = trusted ? snapshot.localOnly.bridgeIds : [];
  // Removed in this browser's chain, not yet on the server: the server (and so the computers) still accept them.
  const unsavedDevices = trusted ? (snapshot.unsaved?.deviceIds ?? []).filter(id => !localDevices.includes(id) && id !== currentEndpointId) : [];
  const unsavedBridges = trusted ? (snapshot.unsaved?.bridgeIds ?? []).filter(id => !localBridges.includes(id)) : [];
  /** This browser's own removal, not on the server yet: it is still accepted there, and the client sends it again. */
  const unsavedSelf = !!trusted && !!currentEndpointId && (snapshot.unsaved?.deviceIds ?? []).includes(currentEndpointId);
  /** Nothing is confirmed about the server yet: a removal here may not be there. */
  const unconfirmed = !!trusted && snapshot.serverState === "unknown";
  // Map labels end without a period (the map appends ". <connection>"); the details show UNCONFIRMED as written.
  const removedText = unconfirmed ? UNCONFIRMED.replace(/\.$/, "") : "Removed from your account";
  useEffect(() => { rememberEntries(security.client, trusted); }, [security.client, trusted]);
  const seen = security.client ? seenEntries.get(security.client) : undefined;
  const discardedOperations = snapshot.discarded.map(record => record.payload.operation);
  /** The signed ledger entry of a browser: current checkpoint, else seen earlier in this page, else a dropped add record. */
  const signedDevice = (id: string): LedgerDevice | undefined => trusted?.devices.find(item => item.endpoint.id === id) ?? seen?.devices.get(id)
    ?? discardedOperations.reduce<LedgerDevice | undefined>((found, item) => found ?? (item.type === "add_device" && item.device.endpoint.id === id ? item.device : undefined), undefined);
  const signedBridge = (id: string): LedgerBridge | undefined => trusted?.bridges.find(item => item.bridgeId === id) ?? seen?.bridges.get(id)
    ?? discardedOperations.reduce<LedgerBridge | undefined>((found, item) => found ?? (item.type === "add_bridge" && item.bridge.bridgeId === id ? item.bridge : undefined), undefined);

  const devices = [...(trusted?.devices ?? [])].sort((a, b) => Number(b.endpoint.id === currentEndpointId) - Number(a.endpoint.id === currentEndpointId));
  const browserNodes: SecurityAccessBrowserNode[] = devices.map(device => {
    const current = device.endpoint.id === currentEndpointId; const custom = displayName("browser", device.endpoint.id);
    return { id: device.endpoint.id, label: custom ?? browserName(device.label, current), customLabel: custom !== undefined, current,
      accessText: current && revokedHere ? "Access revoked" : verified ? "In your account" : "Access paused",
      lockState: verified && !(current && revokedHere) ? "secured" : "approval_needed", edge: verified && !(current && revokedHere) ? "current" : "none" };
  });
  for (const id of localDevices) {
    if (browserNodes.some(node => node.id === id)) continue;
    const custom = displayName("browser", id); const current = id === currentEndpointId;
    browserNodes.push({ id, label: custom ?? browserName(signedDevice(id)?.label ?? "", current), customLabel: custom !== undefined, current,
      accessText: LOCAL_ONLY, lockState: "approval_needed", edge: "none" });
  }
  for (const id of unsavedDevices) {
    if (browserNodes.some(node => node.id === id)) continue;
    const custom = displayName("browser", id);
    browserNodes.push({ id, label: custom ?? browserName(signedDevice(id)?.label ?? "", false), customLabel: custom !== undefined, current: false,
      accessText: UNSAVED, lockState: "approval_needed", edge: "none" });
  }
  const selfRemoved = !!currentEndpointId && (revokedHere || !!trusted?.revokedDeviceIds.includes(currentEndpointId));
  if (currentEndpointId && !browserNodes.some(node => node.id === currentEndpointId)) browserNodes.unshift({ id: currentEndpointId, label: "This browser", current: true,
    accessText: unsavedSelf ? UNSAVED : selfRemoved ? removedText : trusted ? "Not in your account" : "Not signed in",
    lockState: selfRemoved && unconfirmed && !unsavedSelf ? "unknown" : "approval_needed", edge: "none" });

  const roster = trusted?.bridges ?? [];
  const computers = new Map(bridges.map(computer => [computer.bridgeId, computer]));
  for (const entry of roster) if (!computers.has(entry.bridgeId)) computers.set(entry.bridgeId, { bridgeId: entry.bridgeId, label: entry.label || "Computer", security: { bridgeId: entry.bridgeId, status: "offline", endpoint: entry.endpoint } });
  for (const id of [...localBridges, ...unsavedBridges]) if (!computers.has(id)) {
    const signed = signedBridge(id);
    computers.set(id, { bridgeId: id, label: signed?.label || "Computer", security: { bridgeId: id, status: "offline", endpoint: signed?.endpoint ?? null } });
  }
  const computerViews = [...computers.values()].map(computer => {
    const entry = roster.find(item => item.bridgeId === computer.bridgeId);
    const localOnly = localBridges.includes(computer.bridgeId);
    const revoked = !localOnly && !!trusted?.revokedBridgeIds.includes(computer.bridgeId);
    const unsaved = revoked && unsavedBridges.includes(computer.bridgeId);
    const status = computer.security.status;
    const keyMismatch = !!entry && !!computer.security.endpoint && computer.security.endpoint.id !== entry.endpoint.id;
    const inAccount = !!entry && !revoked && !keyMismatch && status !== "revoked" && status !== "key_changed";
    const edge: SecurityAccessBridgeNode["edge"] = verified && inAccount ? status === "ready" ? "current" : status === "offline" || status === "connecting" ? "historical" : "none" : "none";
    const access = localOnly ? LOCAL_ONLY : unsaved ? UNSAVED : revoked ? removedText : !entry ? "Not in your account" : !inAccount ? "Key changed · check this computer"
      : status === "upgrade_required" ? "Update FTown on this computer" : !verified ? "Access paused" : status === "ready" ? "In your account"
      : status === "unpaired" ? "Waiting for this computer to update" : "In your account · reconnect to verify";
    const connection = status === "ready" ? "Connected" : status === "connecting" ? "Connecting…" : status === "offline" ? "Offline" : "Not connected";
    // A removal nobody confirmed yet is shown neutral, not as a settled "removed".
    const lockState: SecurityLockState = edge === "current" ? "secured" : revoked && !unsaved && unconfirmed ? "unknown"
      : !inAccount || status === "unpaired" || status === "upgrade_required" ? "approval_needed" : "unknown";
    const node: SecurityAccessBridgeNode = { current: currentComputerIds?.has(computer.bridgeId) ?? false, id: computer.bridgeId,
      label: displayName("bridge", computer.bridgeId) ?? (computer.label || entry?.label || "Computer"), accessText: access, connectionText: connection, lockState, edge };
    return { computer, entry, revoked, localOnly, unsaved, inAccount, node };
  });

  const scope = `${context}:${selected?.bridgeId ?? ""}`;
  const validSelection = (node: SecurityAccessSelection) => node.kind === "browser" ? browserNodes.some(item => item.id === node.id) : computerViews.some(item => item.node.id === node.id);
  const currentBrowser = browserNodes.find(node => node.current);
  const fallback: SecurityAccessSelection | null = selected && computerViews.some(item => item.node.id === selected.bridgeId) ? { kind: "bridge", id: selected.bridgeId }
    : currentBrowser ? { kind: "browser", id: currentBrowser.id } : browserNodes[0] ? { kind: "browser", id: browserNodes[0].id }
    : computerViews[0] ? { kind: "bridge", id: computerViews[0].node.id } : null;
  const active = selection?.scope === scope && validSelection(selection.node) ? selection.node : fallback;
  const selectedBrowser = active?.kind === "browser" ? browserNodes.find(node => node.id === active.id) : undefined;
  const selectedDevice = selectedBrowser ? devices.find(device => device.endpoint.id === selectedBrowser.id) : undefined;
  const selectedComputer = active?.kind === "bridge" ? computerViews.find(item => item.node.id === active.id) : undefined;
  const selectedBrowserLabel = selectedBrowser ? accessBrowserLabel(selectedBrowser, browserNodes) : "Browser";
  const nameDisabledReason = (kind: "browser" | "bridge", id: string, available: boolean) =>
    !accountReady || !available ? "Reconnect and verify access before renaming." : displayNames.loading ? "Loading display names…" : displayNames.error && !displayNames.eligible.length ? "Display names are unavailable. Refresh access to try again." : !displayNames.eligible.some(item => item.kind === kind && item.id === id) ? "Renaming is unavailable for this device." : undefined;

  /** Plain-language summary of a signed operation, for the discarded-changes notice. */
  const describe = (operation: LedgerOperation): string => {
    switch (operation.type) {
      case "add_device": return `Add browser “${operation.device.label || "Browser"}”`;
      case "add_bridge": return `Add computer “${operation.bridge.label || "Computer"}”`;
      case "add_authority": return `Add passkey “${operation.authority.label || "Passkey"}”`;
      case "revoke_device": {
        const id = operation.endpointId;
        const name = displayName("browser", id) ?? signedDevice(id)?.label;
        return `Remove browser “${name || `Browser · ${shortId(id)}`}”`;
      }
      case "revoke_bridge": {
        const id = operation.bridgeId;
        const name = displayName("bridge", id) ?? computers.get(id)?.label ?? signedBridge(id)?.label;
        return `Remove computer “${name || `Computer · ${shortId(id)}`}”`;
      }
    }
  };

  const accountProblem = mismatch ? ACCOUNT_MISMATCH : snapshot.status === "error" ? securityErrorMessage({ code: snapshot.error ?? "" }) : null;
  const message = security.error ? securityErrorMessage({ code: security.error }) : accountProblem;
  const selectedDetails = active && <section aria-label="Selected access details" className="space-y-2">
    {selectedBrowser && <>
      {selectedDevice && <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-danger inline-flex min-h-11 items-center gap-1 sm:min-h-8" title="Remove this browser from your account" aria-label={`Remove browser ${selectedBrowserLabel}`}
          disabled={!!busy || !canWrite} onClick={() => setConfirm(`browser:${selectedBrowser.id}`)}><TrashIcon />Remove</button></div>}
      {confirm === `browser:${selectedBrowser.id}` && selectedDevice && <div role="group" aria-label="Confirm browser removal" className="space-y-3 rounded-md border border-[var(--border-muted)] p-3">
        <p className="text-sm">{selectedBrowser.current ? REMOVE_THIS_BROWSER_CONFIRM : REMOVE_BROWSER_CONFIRM(selectedBrowserLabel)}</p>
        <SignedIdentity label={selectedDevice.label} id={selectedBrowser.id} />
        <SignerHint security={security} />
        <div className="flex flex-wrap gap-2">
          <PasskeyActionButton security={security} actionKey={`browser:${selectedBrowser.id}`} label="Confirm remove browser" busyLabel="Waiting for passkey…" className="btn-danger"
            disabled={!canWrite} action={client => client.revokeDevice(selectedBrowser.id)} onDone={() => setConfirm(null)} />
          <button type="button" className="btn-ghost min-h-11 sm:min-h-8" onClick={() => setConfirm(null)}>Cancel</button></div>
      </div>}
      {!selectedDevice && localDevices.includes(selectedBrowser.id) && <div role="group" aria-label="Removal not applied" className="space-y-2 rounded-md border border-[var(--status-pending)] p-3">
        <p className="text-sm">{LOCAL_ONLY}.</p>
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">Your computers, the server and your other browsers still trust this browser. Sign the removal again to apply it.</p>
        <SignedIdentity label={signedDevice(selectedBrowser.id)?.label ?? null} id={selectedBrowser.id} />
        <SignerHint security={security} />
        <PasskeyActionButton security={security} actionKey={`browser:${selectedBrowser.id}`} label="Sign removal again" busyLabel="Waiting for passkey…" className="btn-danger"
          disabled={!canWrite} action={client => client.revokeDevice(selectedBrowser.id)} />
      </div>}
      {!selectedDevice && unsavedDevices.includes(selectedBrowser.id) && <UnsavedRemoval security={security} label={signedDevice(selectedBrowser.id)?.label ?? null} id={selectedBrowser.id} />}
      {/* This browser's unsaved or unconfirmed removal is explained once, above the map. */}
      {!selectedDevice && selectedBrowser.current && !localDevices.includes(selectedBrowser.id) && !unsavedSelf && !(selfRemoved && unconfirmed) && <p className="text-xs text-[var(--text-muted)]">{selfRemoved ? "This browser was removed from your account." : "This browser is not in your account."} <a href="/login" className="underline">Sign in with your passkey</a> to add it.</p>}
      <details className="text-xs"><summary className="min-h-11 cursor-pointer py-3 sm:min-h-8 sm:py-2">Browser details</summary>
        <p className="mb-2">Browsers in your account can use your computers. Only your passkeys can add or remove them.</p>
        {selectedDevice && <><p>Original name: {selectedDevice.label || "Browser"}</p><p>Added {new Date(selectedDevice.approvedAt).toLocaleString()}.</p></>}
        <p className="break-all font-mono">Fingerprint: {selectedBrowser.id}</p></details>
    </>}
    {selectedComputer && (() => {
      const { computer, entry, revoked, localOnly, unsaved, inAccount, node } = selectedComputer;
      return <div data-computer-details={computer.bridgeId} className="space-y-2">
        <DeviceDisplayNameEditor key={`${context}:bridge:${computer.bridgeId}`} target={{ kind: "bridge", id: computer.bridgeId }} label={node.label} customName={displayName("bridge", computer.bridgeId)}
          disabledReason={nameDisabledReason("bridge", computer.bridgeId, inAccount)} saving={displayNames.saving} error={displayNames.error} setName={displayNames.setName} />
        <details className="text-xs"><summary className="min-h-11 cursor-pointer py-3">Original computer name and fingerprint</summary>
          <p className="break-words">Original name: {entry?.label || computer.label || "Computer"}</p>
          {entry && <p>Added {new Date(entry.approvedAt).toLocaleString()}.</p>}
          {(entry?.endpoint ?? computer.security.endpoint) && <p className="break-all font-mono">Fingerprint: {(entry?.endpoint ?? computer.security.endpoint)?.id}</p>}</details>
        {entry && !revoked && <div className="space-y-2">
          <button type="button" aria-label={`Remove computer ${node.label}`} className="btn-danger inline-flex min-h-11 items-center gap-1 sm:min-h-8" disabled={!!busy || !canWrite}
            onClick={() => setConfirm(`computer:${computer.bridgeId}`)}><TrashIcon />Remove computer</button>
          {confirm === `computer:${computer.bridgeId}` && <div role="group" aria-label="Confirm computer removal" className="space-y-3 rounded-md border border-[var(--border-muted)] p-3">
            <p className="text-sm">{REMOVE_CONFIRM(node.label)}</p>
            <SignedIdentity label={entry.label} id={computer.bridgeId} />
            <SignerHint security={security} />
            <div className="flex flex-wrap gap-2">
              <PasskeyActionButton security={security} actionKey={`computer:${computer.bridgeId}`} label="Confirm remove computer" busyLabel="Waiting for passkey…" className="btn-danger"
                disabled={!canWrite} action={client => client.revokeBridge(computer.bridgeId)} onDone={() => setConfirm(null)} />
              <button type="button" className="btn-ghost min-h-11 sm:min-h-8" onClick={() => setConfirm(null)}>Cancel</button></div>
          </div>}
        </div>}
        {localOnly && <div role="group" aria-label="Removal not applied" className="space-y-2 rounded-md border border-[var(--status-pending)] p-3">
          <p className="text-sm">{LOCAL_ONLY}.</p>
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">The server, your other browsers and the computer itself still trust it. Sign the removal again to apply it.</p>
          <SignedIdentity label={signedBridge(computer.bridgeId)?.label ?? null} id={computer.bridgeId} />
          <SignerHint security={security} />
          <PasskeyActionButton security={security} actionKey={`computer:${computer.bridgeId}`} label="Sign removal again" busyLabel="Waiting for passkey…" className="btn-danger"
            disabled={!canWrite} action={client => client.revokeBridge(computer.bridgeId)} />
        </div>}
        {unsaved && <UnsavedRemoval security={security} label={signedBridge(computer.bridgeId)?.label ?? null} id={computer.bridgeId} />}
        {revoked && !unsaved && <p className="text-xs text-[var(--text-muted)]">{unconfirmed ? UNCONFIRMED : "This computer was removed from your account. To use it again, pair it as a new computer."}</p>}
        {!entry && !revoked && !localOnly && <p className="text-xs leading-relaxed text-[var(--text-muted)]">This computer is not in your account. To add it, run <code>ftown start</code> on it and open the pairing link it prints.</p>}
      </div>;
    })()}
  </section>;

  return <div className="space-y-3">
    {unsavedSelf && currentEndpointId && <UnsavedRemoval security={security} label={signedDevice(currentEndpointId)?.label ?? null} id={currentEndpointId} self />}
    {!unsavedSelf && selfRemoved && unconfirmed && <p role="status" className="rounded-md border border-[var(--border-muted)] p-3 text-sm">{UNCONFIRMED}</p>}
    {revokedHere && !unsavedSelf && !unconfirmed && <div role="alert" className="space-y-2 rounded-md border border-[var(--status-error)] p-3">
      <p className="text-sm font-semibold">This browser was removed from your account.</p>
      <p className="text-xs leading-relaxed text-[var(--text-muted)]">It can no longer reach your computers, and passkey changes are turned off here. To use it again, set it up with new keys and sign in with your passkey.</p>
      <a href="/login" className="btn-accent inline-flex min-h-11 items-center sm:min-h-8">Set up this browser again</a>
    </div>}
    {localDevices.length + localBridges.length > 0 && <section aria-label="Removals not applied" className="rounded-md border border-[var(--status-pending)] p-3 text-xs leading-relaxed">
      <p className="font-semibold">{localDevices.length + localBridges.length === 1 ? "1 removal is" : `${localDevices.length + localBridges.length} removals are`} saved on this browser only.</p>
      <p className="text-[var(--text-muted)]">Your account still includes {localDevices.length + localBridges.length === 1 ? "it" : "them"}. Select each item marked “{LOCAL_ONLY}” and sign its removal again.</p>
    </section>}
    <DiscardedChanges security={security} canWrite={canWrite} describe={describe} />
    <SecurityAccessMap browsers={browserNodes} bridges={computerViews.map(item => item.node)}
      account={{ statusText: mismatch ? "Different account" : accountReady ? "Verified" : revokedHere ? "This browser was removed" : snapshot.status === "error" ? "Access paused" : "Not signed in",
        lockState: accountReady ? "secured" : snapshot.status === "error" ? "unknown" : "approval_needed" }}
      selected={active} onSelect={node => { setSelection({ scope, node }); setConfirm(null); }} selectedDetails={selectedDetails}
      renderBrowserName={(node, label) => devices.some(device => device.endpoint.id === node.id)
        ? <DeviceDisplayNameEditor key={`${context}:browser:${node.id}`} variant="inline" target={{ kind: "browser", id: node.id }} label={label} customName={displayName("browser", node.id)} disabledReason={nameDisabledReason("browser", node.id, true)} saving={displayNames.saving} error={displayNames.error} setName={displayNames.setName} />
        : <span className="block break-words text-[10px] font-semibold sm:text-xs [overflow-wrap:anywhere]">{label}</span>}
      toolbar={<div className="flex flex-wrap items-start gap-2">
        <button type="button" className="btn-ghost min-h-11 text-xs sm:min-h-8" disabled={!!busy} onClick={() => { displayNames.refresh(); void security.run("refresh", client => client.refresh()); }}>{busy === "refresh" ? "Refreshing…" : "Refresh access"}</button>
        {message && <p role="alert" className="w-full text-sm text-[var(--status-error)]">{message}</p>}
        {snapshot.status === "signed_out" && !mismatch && <p role="status" className="w-full text-xs text-[var(--text-muted)]">Sign in with your passkey to manage your account.</p>}
      </div>} />
    <PasskeysSection security={security} canWrite={canWrite} />
    <details className="text-xs text-[var(--text-muted)]"><summary className="min-h-11 cursor-pointer py-3 sm:min-h-8 sm:py-2">Recovery and security details</summary>
      <p>Only your passkeys can change your account. Removing a browser or computer takes effect as soon as your computers receive the signed change; offline computers apply it when they reconnect. Clearing this browser's storage removes its keys; sign in again with your passkey to add it back. If you lose every passkey, create a new account and run <code>ftown start --new-identity</code> on each computer.</p></details>
  </div>;
}
