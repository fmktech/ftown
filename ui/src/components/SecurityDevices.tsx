"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ApprovedEndpoint, BridgeInvitation } from "@security/protocol";
import { securityErrorMessage, type SecurityBridge, type SecurityCommandExecutor } from "./SecurityPanel";
import type { AccountSecurityClient, AccountSecuritySnapshot } from "@/lib/account-security-client";
import { DeviceApproval } from "./DeviceApproval";
import type { PendingApprovalClient, PendingSnapshot } from "@/lib/pending-approval-client";
import { usePendingApprovals } from "@/hooks/usePendingApprovals";
import { PendingDeviceInbox } from "./PendingDeviceApprovals";

interface Props {
  bridge?: SecurityBridge;
  currentEndpointId: string | null;
  execute: SecurityCommandExecutor;
  onInvitation?: (invitation: BridgeInvitation) => void;
  bridges?: SecurityBridge[];
  accountClient?: AccountSecurityClient;
  accountState?: AccountSecuritySnapshot;
  pendingClient?: PendingApprovalClient;
  pendingState?: PendingSnapshot;
}

export function SecurityDevices({ bridge, currentEndpointId, execute, onInvitation, bridges = [], accountClient, accountState, pendingClient, pendingState }: Props) {
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
    if (ready && !accountClient) void load();
    return () => { generation.current++; };
  }, [load, ready, accountClient]);

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

  if (accountClient && accountState) return <AccountDevices client={accountClient} initial={accountState} bridges={bridges} selected={bridge} execute={execute} pendingClient={pendingClient} pendingState={pendingState} />;
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
          {canAdmin && device.source !== "account" && <button type="button" className="btn-ghost min-h-11 text-[var(--status-error)]" disabled={!!busy}
            aria-label={`Revoke ${device.label || device.endpoint.kind}`} onClick={() => setConfirmRevoke(device.endpoint.id)}>Revoke</button>}
        </div>
        <details className="mt-2 text-xs"><summary className="min-h-11 cursor-pointer py-3">Device details</summary><p className="break-all font-mono text-[11px] text-[var(--text-faint)]">Fingerprint: {device.endpoint.id}</p></details>
        {device.source === "account" && <p className="mt-2 text-xs text-[var(--text-muted)]">Account device — manage its account-wide access from the hosted dashboard.</p>}
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

function AccountDevices({ client, initial, bridges, selected, execute, pendingClient, pendingState }: { client: AccountSecurityClient; initial: AccountSecuritySnapshot; bridges: SecurityBridge[]; selected?: SecurityBridge; execute: SecurityCommandExecutor; pendingClient?: PendingApprovalClient; pendingState?: PendingSnapshot }) {
  const state = useSyncExternalStore(client.subscribe, client.snapshot, () => initial);
  const pending = usePendingApprovals(client, pendingClient ? "passive" : "reviewer", pendingClient);
  useEffect(() => () => { pending.client?.dismissReview(); }, [pending.client]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [refreshRound, setRefreshRound] = useState(0);
  const [expandedComputers, setExpandedComputers] = useState<Record<string, boolean>>({});
  const [confirmedComputers, setConfirmedComputers] = useState<Record<string, boolean>>({});
  const [failedChecks, setFailedChecks] = useState<Record<string, boolean>>({});
  const [checkingComputers, setCheckingComputers] = useState<Record<string, boolean>>({});
  const probeGeneration = useRef(0);
  const probeVersions = useRef(new Map<string, number>());
  const context = `${client.ownerId}:${state.identity?.endpoint.id ?? ""}`;
  const currentContext = useRef(context); currentContext.current = context;
  useEffect(() => { setBusy(null); setError(null); setConfirm(null); }, [client, context]);
  const roster = state.trust?.checkpoint.bridges ?? [];
  const computers = new Map(bridges.map(computer => [computer.bridgeId, computer]));
  for (const computer of roster) if (!computers.has(computer.bridgeId)) computers.set(computer.bridgeId, { bridgeId: computer.bridgeId, label: computer.label || "Computer", security: { bridgeId: computer.bridgeId, status: "offline", endpoint: computer.endpoint } });
  for (const pin of state.legacyBridges) if (!computers.has(pin.bridgeId)) computers.set(pin.bridgeId, { bridgeId: pin.bridgeId, label: "Computer", security: { bridgeId: pin.bridgeId, status: "offline", endpoint: pin.endpoint } });
  const proofKey = (computer: SecurityBridge) => `${context}:${computer.bridgeId}:${computer.security.endpoint?.id ?? state.legacyBridges.find(pin => pin.bridgeId === computer.bridgeId)?.endpoint.id ?? ""}`;
  const probeTargets = JSON.stringify([...computers.values()].filter(computer => computer.security.status === "ready").map(computer => [computer.bridgeId, proofKey(computer)]));
  useEffect(() => {
    const generation = ++probeGeneration.current;
    if (state.status !== "ready" || state.offline) return;
    const targets = JSON.parse(probeTargets) as [string, string][];
    for (const [bridgeId, key] of targets) {
      const version = (probeVersions.current.get(key) ?? 0) + 1;
      probeVersions.current.set(key, version);
      setCheckingComputers(previous => ({ ...previous, [key]: true }));
      void execute({ type: "security_devices", bridgeId }).then(result => {
        if (generation !== probeGeneration.current || probeVersions.current.get(key) !== version) return;
        const account = result.devices.some(device => device.endpoint.id === state.identity?.endpoint.id && device.source === "account");
        setCheckingComputers(previous => ({ ...previous, [key]: false }));
        setConfirmedComputers(previous => ({ ...previous, [key]: account }));
        setFailedChecks(previous => ({ ...previous, [key]: false }));
      }).catch(() => { if (generation === probeGeneration.current && probeVersions.current.get(key) === version) { setCheckingComputers(previous => ({ ...previous, [key]: false })); setFailedChecks(previous => ({ ...previous, [key]: true })); } });
    }
    return () => { if (generation === probeGeneration.current) probeGeneration.current++; };
  }, [client, execute, probeTargets, refreshRound, state.status, state.offline, state.identity?.endpoint.id]);
  async function revoke(endpointId: string) {
    setBusy(endpointId); setError(null);
    try { await client.revoke(endpointId); setConfirm(null); }
    catch (failure) { setError(securityErrorMessage(failure)); }
    finally { setBusy(null); }
  }
  async function migrate(computer: SecurityBridge) {
    const pin = state.legacyBridges.find(bridge => bridge.bridgeId === computer.bridgeId); if (!pin) return;
    const actionContext = context; const key = proofKey(computer);
    probeVersions.current.set(key, (probeVersions.current.get(key) ?? 0) + 1);
    setBusy(computer.bridgeId); setError(null);
    try {
      await client.migrate(pin, execute);
      if (currentContext.current === actionContext) { probeVersions.current.set(key, (probeVersions.current.get(key) ?? 0) + 1); setCheckingComputers(previous => ({ ...previous, [key]: false })); setConfirmedComputers(previous => ({ ...previous, [key]: true })); setFailedChecks(previous => ({ ...previous, [key]: false })); }
    } catch (failure) { if (currentContext.current === actionContext) setError(`${securityErrorMessage(failure)} Sharing is not confirmed. Try again when the computer is connected.`); }
    finally { if (currentContext.current === actionContext) { probeVersions.current.set(key, (probeVersions.current.get(key) ?? 0) + 1); setCheckingComputers(previous => ({ ...previous, [key]: false })); setBusy(null); } }
  }
  const devices = [...(state.trust?.checkpoint.devices ?? [])].sort((a, b) => Number(b.endpoint.id === state.identity?.endpoint.id) - Number(a.endpoint.id === state.identity?.endpoint.id));
  const inbox = pendingState ?? pending.snapshot;
  const needsReview = !!inbox.review || !!inbox.inboxError || inbox.inbox.some(item => !["rejected", "cancelled", "expired", "conflict"].includes(item.status));
  const browserName = (label: string, self: boolean) => self && /^(this device|this browser|browser)$/i.test(label.trim()) ? "This browser" : !self && /^this (device|browser)$/i.test(label.trim()) ? "Browser" : label || "Browser";
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm"><span className="font-semibold">This browser</span><span className="text-[var(--text-muted)]"> · {state.status === "ready" ? state.offline ? "Reconnect to verify access" : "Approved for your account" : state.status === "checking" ? "Checking access…" : state.status === "error" ? state.code === "account_device_revoked" ? "Access revoked" : "Access paused" : "Account approval needed"}</span></p>
      <button className="btn-ghost min-h-11 text-xs" disabled={!!busy} onClick={() => { setRefreshRound(value => value + 1); void client.refresh(); }}>Refresh access</button>
    </div>
    {(error || state.status === "error") && <p role="alert" className="text-sm text-[var(--status-error)]">{error ?? securityErrorMessage({ code: state.code })}</p>}
    {state.status === "ready" && pending.client && (needsReview
      ? <PendingDeviceInbox client={pending.client} snapshot={inbox} offline={state.offline} />
      : <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">Add a browser or review requests</summary><p className="mb-3 text-xs text-[var(--text-muted)]">Sign in on the new browser, then review its request here and compare the code on both devices.</p><PendingDeviceInbox client={pending.client} snapshot={inbox} offline={state.offline} /></details>)}
    <section aria-labelledby="security-computers-title" className="space-y-3">
      <h3 id="security-computers-title" className="font-semibold">Your computers</h3>
      {!computers.size && <p className="text-sm text-[var(--text-muted)]">Start FTown on a computer to connect it to your account.</p>}
      {[...computers.values()].map(computer => {
        const key = proofKey(computer); const confirmed = confirmedComputers[key] === true;
        const ready = computer.security.status === "ready";
        const blocked = ["revoked", "key_changed"].includes(computer.security.status) || state.status === "error" || !!state.trust?.checkpoint.revokedBridgeIds.includes(computer.bridgeId);
        const pin = state.legacyBridges.find(item => item.bridgeId === computer.bridgeId);
        const inRoster = roster.some(item => item.bridgeId === computer.bridgeId);
        const shared = confirmed && !blocked && !checkingComputers[key] && !failedChecks[key] && state.status === "ready" && !state.offline;
        const verifying = !confirmed && !failedChecks[key] && (checkingComputers[key] || computer.security.status === "connecting" || inRoster && confirmedComputers[key] !== false);
        const access = blocked ? "Access needs attention" : verifying ? "Checking access…" : checkingComputers[key] && ready && !state.offline ? "Checking sharing…" : confirmed ? failedChecks[key] && ready ? "Previously shared · check access" : shared && ready ? "Shared with your approved browsers" : "Previously shared · reconnect to verify" : inRoster ? failedChecks[key] ? "Setup needs attention" : "Finishing setup" : pin ? "Only separately approved browsers" : "Approval needed";
        const connection = ready ? "Connected" : computer.security.status === "connecting" ? "Connecting…" : computer.security.status === "offline" ? "Offline" : "Not connected";
        return <article key={computer.bridgeId} data-computer-access={computer.bridgeId} data-account-migration={pin && !confirmed ? computer.bridgeId : undefined} className="space-y-2 rounded-lg border border-[var(--border-muted)] p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="min-w-0 break-words text-sm font-semibold">{computer.label || "Computer"}</h4><span className="text-xs text-[var(--text-muted)]">{connection}</span></div>
          <p className="text-sm text-[var(--text-secondary)]">{access}</p>
          {pin && !confirmed && <><p className="text-xs leading-relaxed text-[var(--text-muted)]">Sharing lets your account-approved browsers control this computer. It replaces separate browser approvals and old invitations; browsers outside your account approvals lose access.</p>
            <button className="btn-accent min-h-11 w-full sm:w-auto" disabled={!!busy || !ready || blocked || state.offline || state.status === "unapproved" && state.historyExists} onClick={() => void migrate(computer)}>{busy === computer.bridgeId ? "Sharing computer…" : "Share with my other browsers"}</button></>}
          {!pin && !confirmed && !blocked && <p className="text-xs text-[var(--text-muted)]">{failedChecks[key] ? "Could not verify access. Reconnect this computer, then refresh access." : verifying ? ready ? "Checking how access is set up…" : "Waiting for this computer to connect." : inRoster ? "Finish sharing from a browser already approved on this computer." : "Approve this computer from its setup request, or use its local invitation."}</p>}
          {pin && !confirmed && !ready && <p className="text-xs text-[var(--text-muted)]">Connect this computer to share it.</p>}
          {pin && ready && !confirmed && <details className="text-xs" onToggle={event => { const open = event.currentTarget.open; setExpandedComputers(previous => previous[key] === open ? previous : { ...previous, [key]: open }); }}><summary className="min-h-11 cursor-pointer py-3">Separate approvals and recovery</summary>{expandedComputers[key] && <SecurityDevices bridge={computer} currentEndpointId={state.identity?.endpoint.id ?? null} execute={execute} />}</details>}
        </article>;
      })}
    </section>
    {state.status === "unapproved" && state.historyExists && <DeviceApproval ownerId={client.ownerId} email="your account" client={client} />}
    <details className="rounded-lg border border-[var(--border-muted)] p-3 sm:p-4">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">Browsers with access ({devices.length})</summary>
      <p className="mb-3 text-xs text-[var(--text-muted)]">These browsers can control shared computers and approve other browsers.</p>
      {state.offline && <p role="status" className="mb-3 text-xs text-[var(--text-muted)]">Showing verified stored account trust. Reconnect before removing access.</p>}
      {devices.length > 0 && <ul aria-label="Account devices" className="space-y-3">{devices.map(device => {
        const self = device.endpoint.id === state.identity?.endpoint.id; const label = browserName(device.label, self);
        return <li key={device.endpoint.id} className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="break-words text-sm font-semibold">{label}{self && label !== "This browser" ? " · This browser" : ""}</h4>
            <button className="btn-ghost min-h-11 text-[var(--status-error)]" aria-label={`Remove access for ${label}`} disabled={!!busy || state.offline || devices.length === 1} onClick={() => setConfirm(device.endpoint.id)}>Remove access</button></div>
          <details className="text-xs"><summary className="min-h-11 cursor-pointer py-3">Browser details</summary><p>Approved {new Date(device.approvedAt).toLocaleString()}.</p><p className="break-all font-mono">Fingerprint: {device.endpoint.id}</p></details>
          {confirm === device.endpoint.id && <div role="group" aria-label="Confirm account device revocation" className="space-y-3 rounded-md border border-[var(--border-muted)] p-3"><p className="text-sm">Remove this browser from all shared computers? Connected computers stop its access after receiving the update; offline computers apply it when they reconnect. Other browsers and MCP grants keep their access.</p><div className="flex flex-wrap gap-2"><button className="btn-danger min-h-11" disabled={!!busy} onClick={() => void revoke(device.endpoint.id)}>Confirm remove access</button><button className="btn-ghost min-h-11" onClick={() => setConfirm(null)}>Cancel</button></div></div>}
        </li>;
      })}</ul>}
      {devices.length === 1 && <p className="mt-3 text-xs text-[var(--text-muted)]">This is the last account administrator. Approve another browser before removing its access.</p>}
    </details>
    <details className="text-xs text-[var(--text-muted)]"><summary className="min-h-11 cursor-pointer py-3">Recovery and security details</summary><p>Clearing browser storage loses its private key. Password resets cannot recover it. Keep an approved browser and local CLI access available. If every account signing key is lost, each computer needs explicit account-trust recovery. Local recovery cannot reset account approvals.</p></details>
  </div>;
}
