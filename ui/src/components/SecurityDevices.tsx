"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ApprovedEndpoint, BridgeInvitation } from "@security/protocol";
import { securityErrorMessage, type SecurityBridge, type SecurityCommandExecutor } from "./SecurityPanel";
import type { AccountSecurityClient, AccountSecuritySnapshot } from "@/lib/account-security-client";
import { DeviceApproval } from "./DeviceApproval";
import { SecurityAccessMap, accessBrowserLabel, type SecurityAccessBrowserNode, type SecurityAccessBridgeNode, type SecurityAccessSelection } from "./SecurityAccessMap";
import type { SecurityLockState } from "./SecurityLockIcon";
import type { PendingApprovalClient, PendingSnapshot } from "@/lib/pending-approval-client";
import { usePendingApprovals } from "@/hooks/usePendingApprovals";
import { PendingDeviceInbox } from "./PendingDeviceApprovals";
import { useDeviceDisplayNames } from "@/hooks/useDeviceDisplayNames";
import { DeviceDisplayNameEditor } from "./DeviceDisplayNameEditor";

interface Props {
  bridge?: SecurityBridge;
  currentEndpointId: string | null;
  currentComputerIds?: ReadonlySet<string>;
  execute: SecurityCommandExecutor;
  onInvitation?: (invitation: BridgeInvitation) => void;
  bridges?: SecurityBridge[];
  accountClient?: AccountSecurityClient;
  accountState?: AccountSecuritySnapshot;
  pendingClient?: PendingApprovalClient;
  pendingState?: PendingSnapshot;
}

function ComputerApprovalRecovery() {
  return <p className="text-xs leading-relaxed text-[var(--text-muted)]">On that computer, while its FTown bridge is running, run <code>ftown security invite</code>. Open the printed private link in this browser and verify the computer and account before approving. This grants access to that computer only; it does not restore account signing keys or share the computer with other browsers.</p>;
}

export function SecurityDevices(props: Props) {
  if (props.accountClient && props.accountState) return <AccountDevices currentComputerIds={props.currentComputerIds} client={props.accountClient} initial={props.accountState} bridges={props.bridges ?? []} selected={props.bridge} execute={props.execute} pendingClient={props.pendingClient} pendingState={props.pendingState} />;
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
    {selected.kind === "bridge" && <p className="text-xs leading-relaxed text-[var(--text-muted)]">Each browser and MCP authorization has its own key. Approval belongs to this computer; public directory entries alone never grant access.</p>}
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

function AccountDevices({ client, initial, bridges, selected, execute, pendingClient, pendingState, currentComputerIds }: { currentComputerIds?: ReadonlySet<string>; client: AccountSecurityClient; initial: AccountSecuritySnapshot; bridges: SecurityBridge[]; selected?: SecurityBridge; execute: SecurityCommandExecutor; pendingClient?: PendingApprovalClient; pendingState?: PendingSnapshot }) {
  const state = useSyncExternalStore(client.subscribe, client.snapshot, () => initial);
  const pending = usePendingApprovals(client, pendingClient ? "passive" : "reviewer", pendingClient);
  const displayNames = useDeviceDisplayNames(client.ownerId);
  useEffect(() => () => { pending.client?.dismissReview(); }, [pending.client]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [refreshRound, setRefreshRound] = useState(0);
  const [selection, setSelection] = useState<{ scope: string; node: SecurityAccessSelection } | null>(null);
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
  const accountCurrent = state.status === "ready" && !!state.trust && !state.offline;
  const accountHistorical = state.status === "ready" && !!state.trust && state.offline;
  const displayName = (kind: "browser" | "bridge", id: string) => displayNames.names.find(item => item.kind === kind && item.id === id)?.name;
  const browserNodes: SecurityAccessBrowserNode[] = devices.map(device => ({ id: device.endpoint.id,
    label: displayName("browser", device.endpoint.id) ?? browserName(device.label, device.endpoint.id === state.identity?.endpoint.id), customLabel: displayName("browser", device.endpoint.id) !== undefined, current: device.endpoint.id === state.identity?.endpoint.id,
    accessText: accountCurrent ? "Approved for your account" : accountHistorical ? "Last verified · offline" : device.endpoint.id === state.identity?.endpoint.id && state.code === "account_device_revoked" ? "Access revoked" : "Access paused",
    lockState: accountCurrent ? "secured" : accountHistorical ? "unknown" : "approval_needed", edge: accountCurrent ? "current" : accountHistorical ? "historical" : "none" }));
  if (state.identity && !browserNodes.some(node => node.id === state.identity!.endpoint.id)) browserNodes.unshift({ id: state.identity.endpoint.id,
    label: "This browser", current: true, accessText: state.status === "checking" ? "Checking access…" : state.status === "error" ? state.code === "account_device_revoked" ? "Access revoked" : "Access paused" : "Account approval needed", lockState: state.status === "checking" ? "unknown" : "approval_needed", edge: "none" });
  const computerViews = [...computers.values()].map(computer => {
    const key = proofKey(computer); const confirmed = confirmedComputers[key] === true;
    const ready = computer.security.status === "ready";
    const blocked = ["revoked", "key_changed"].includes(computer.security.status) || state.status === "error" || !!state.trust?.checkpoint.revokedBridgeIds.includes(computer.bridgeId);
    const pin = state.legacyBridges.find(item => item.bridgeId === computer.bridgeId);
    const inRoster = roster.some(item => item.bridgeId === computer.bridgeId);
    const shared = confirmed && !blocked && !checkingComputers[key] && !failedChecks[key] && state.status === "ready" && !state.offline;
    const verifying = !confirmed && !failedChecks[key] && (checkingComputers[key] || computer.security.status === "connecting" || inRoster && confirmedComputers[key] !== false);
    const access = blocked ? "Access needs attention" : verifying ? "Checking access…" : checkingComputers[key] && ready && !state.offline ? "Checking sharing…" : confirmed ? failedChecks[key] && ready ? "Previously shared · check access" : shared && ready ? "Shared with your approved browsers" : "Previously shared · reconnect to verify" : inRoster ? failedChecks[key] ? "Setup needs attention" : "Finishing setup" : pin ? "Only separately approved browsers" : "Approval needed";
    const connection = ready ? "Connected" : computer.security.status === "connecting" ? "Connecting…" : computer.security.status === "offline" ? "Offline" : "Not connected";
    const current = accountCurrent && shared && ready;
    const historical = !!state.trust && confirmed && !blocked && !checkingComputers[key] && !failedChecks[key] && state.status === "ready" && (state.offline || computer.security.status === "offline");
    const lockState: SecurityLockState = current ? "secured" : blocked || ["unpaired", "revoked", "key_changed", "upgrade_required"].includes(computer.security.status) ? "approval_needed"
      : ["offline", "connecting"].includes(computer.security.status) || verifying || failedChecks[key] || confirmed ? "unknown" : "approval_needed";
    const node: SecurityAccessBridgeNode = { current: currentComputerIds?.has(computer.bridgeId) ?? false, id: computer.bridgeId, label: displayName("bridge", computer.bridgeId) ?? (computer.label || "Computer"), accessText: access, connectionText: connection,
      lockState, edge: current ? "current" : historical ? "historical" : "none" };
    return { computer, key, confirmed, ready, blocked, pin, inRoster, verifying, node };
  });
  const scope = `${context}:${selected?.bridgeId ?? ""}`;
  const validSelection = (node: SecurityAccessSelection) => node.kind === "browser" ? browserNodes.some(item => item.id === node.id) : computerViews.some(item => item.node.id === node.id);
  const fallback: SecurityAccessSelection | null = selected && computerViews.some(item => item.node.id === selected.bridgeId) ? { kind: "bridge", id: selected.bridgeId }
    : browserNodes.find(node => node.current) ? { kind: "browser", id: browserNodes.find(node => node.current)!.id }
    : browserNodes[0] ? { kind: "browser", id: browserNodes[0].id } : computerViews[0] ? { kind: "bridge", id: computerViews[0].node.id } : null;
  const active = selection?.scope === scope && validSelection(selection.node) ? selection.node : fallback;
  const selectedBrowser = active?.kind === "browser" ? browserNodes.find(node => node.id === active.id) : undefined;
  const selectedDevice = selectedBrowser ? devices.find(device => device.endpoint.id === selectedBrowser.id) : undefined;
  const selectedComputer = active?.kind === "bridge" ? computerViews.find(item => item.node.id === active.id) : undefined;
  const selectedBrowserLabel = selectedBrowser ? accessBrowserLabel(selectedBrowser, browserNodes) : "Browser";
  const nameDisabledReason = (kind: "browser" | "bridge", id: string, available: boolean) =>
    !accountCurrent || !available ? "Reconnect and verify access before renaming." : displayNames.loading ? "Loading display names…" : displayNames.error && !displayNames.eligible.length ? "Display names are unavailable. Refresh access to try again." : !displayNames.eligible.some(item => item.kind === kind && item.id === id) ? "Renaming is unavailable for this device." : undefined;
  const selectedDetails = active && <section aria-label="Selected access details" className="space-y-2">
      {selectedBrowser && <>
        <div className="flex flex-wrap items-center gap-2">
          {selectedDevice && <button type="button" className="btn-danger inline-flex min-h-11 items-center gap-1 sm:min-h-8" title="Remove this browser’s access" aria-label={`Remove access for ${selectedBrowserLabel}`} disabled={!!busy || state.offline || devices.length === 1} onClick={() => setConfirm(selectedBrowser.id)}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>Disconnect</button>}</div>
        {state.offline && <p role="status" className="text-xs text-[var(--text-muted)]">Showing verified stored account trust. Reconnect before removing access.</p>}
        <details className="text-xs"><summary className="min-h-11 sm:min-h-8 cursor-pointer py-3 sm:py-2">Browser details</summary><p className="mb-2">Account-approved browsers can control shared computers and approve other browsers.</p>{selectedDevice && <><p>Original name: {selectedDevice.label || "Browser"}</p><p>Approved {new Date(selectedDevice.approvedAt).toLocaleString()}.</p></>}<p className="break-all font-mono">Fingerprint: {selectedBrowser.id}</p></details>
        {confirm === selectedBrowser.id && selectedDevice && <div role="group" aria-label="Confirm account device revocation" className="space-y-3 rounded-md border border-[var(--border-muted)] p-3"><p className="text-sm">Remove this browser from all shared computers? Connected computers stop its access after receiving the update; offline computers apply it when they reconnect. Other browsers and MCP grants keep their access.</p><div className="flex flex-wrap gap-2"><button className="btn-danger min-h-11 sm:min-h-8" disabled={!!busy} onClick={() => void revoke(selectedBrowser.id)}>Confirm remove access</button><button className="btn-ghost min-h-11 sm:min-h-8" onClick={() => setConfirm(null)}>Cancel</button></div></div>}
        {devices.length === 1 && <p className="text-xs text-[var(--text-muted)]">This is the last account administrator. Approve another browser before removing its access.</p>}
      </>}
      {selectedComputer && (() => {
        const { computer, key, confirmed, pin, ready, blocked, inRoster, verifying } = selectedComputer;
        return <div data-computer-details={computer.bridgeId} data-account-migration={pin && !confirmed ? computer.bridgeId : undefined} className="space-y-2">
          <DeviceDisplayNameEditor key={`${context}:bridge:${computer.bridgeId}`} target={{ kind: "bridge", id: computer.bridgeId }} label={selectedComputer.node.label} customName={displayName("bridge", computer.bridgeId)} disabledReason={nameDisabledReason("bridge", computer.bridgeId, ready && !blocked)} saving={displayNames.saving} error={displayNames.error} setName={displayNames.setName} />
          <details className="text-xs"><summary className="min-h-11 cursor-pointer py-3">Original computer name and fingerprint</summary><p className="break-words">Original name: {computer.label || "Computer"}</p>{computer.security.endpoint && <p className="break-all font-mono">Fingerprint: {computer.security.endpoint.id}</p>}</details>
          {pin && !confirmed && <><p className="text-xs leading-relaxed text-[var(--text-muted)]">Sharing lets your account-approved browsers control this computer. It replaces separate browser approvals and old invitations; browsers outside your account approvals lose access.</p>
            <button className="btn-accent min-h-11 sm:min-h-8 w-full sm:w-auto" disabled={!!busy || !ready || blocked || state.offline || state.status === "unapproved" && state.historyExists} onClick={() => void migrate(computer)}>{busy === computer.bridgeId ? "Sharing computer…" : "Share with my other browsers"}</button></>}
          {!pin && !confirmed && !blocked && <p className="text-xs text-[var(--text-muted)]">{failedChecks[key] ? "Could not verify access. Reconnect this computer, then refresh access." : verifying ? ready ? "Checking how access is set up…" : "Waiting for this computer to connect." : inRoster ? "Finish sharing from a browser already approved on this computer." : "Approve this computer from its setup request, or use its local invitation."}</p>}
          {!confirmed && !inRoster && state.status !== "error" && !state.trust?.checkpoint.revokedBridgeIds.includes(computer.bridgeId) && computer.security.status !== "upgrade_required" && (pin || ["unpaired", "revoked", "key_changed"].includes(computer.security.status)) && <details className="text-xs" open={!ready}><summary className="min-h-11 sm:min-h-8 cursor-pointer py-3 sm:py-2">Approve a browser on this computer</summary><ComputerApprovalRecovery /></details>}
          {confirmed && selectedComputer.node.edge !== "current" && <p className="text-xs text-[var(--text-muted)]">Reconnect and refresh access to verify sharing on this computer.</p>}
          {confirmed && <details className="text-xs"><summary className="min-h-11 sm:min-h-8 cursor-pointer py-3 sm:py-2">Computer details</summary><p>Your approved account browsers can use this computer after access is verified.</p>{computer.security.endpoint && <p className="break-all font-mono">Fingerprint: {computer.security.endpoint.id}</p>}</details>}
          {pin && !confirmed && !ready && <p className="text-xs text-[var(--text-muted)]">Connect this computer to share it.</p>}
          {pin && ready && !confirmed && <details className="text-xs" onToggle={event => { const open = event.currentTarget.open; setExpandedComputers(previous => previous[key] === open ? previous : { ...previous, [key]: open }); }}><summary className="min-h-11 sm:min-h-8 cursor-pointer py-3 sm:py-2">Separate approvals and recovery</summary>{expandedComputers[key] && <SecurityDevices bridge={computer} currentEndpointId={state.identity?.endpoint.id ?? null} execute={execute} />}</details>}
        </div>;
      })()}
    </section>;
  return <div className="space-y-3">
    <SecurityAccessMap browsers={browserNodes} bridges={computerViews.map(item => item.node)}
      account={{ statusText: accountCurrent ? "Verified" : accountHistorical ? "Offline approval" : state.status === "checking" ? "Checking" : state.status === "error" ? "Access paused" : "Account approval needed", lockState: accountCurrent ? "secured" : accountHistorical || state.status === "checking" ? "unknown" : "approval_needed" }}
      selected={active} onSelect={node => { setSelection({ scope, node }); setConfirm(null); }} selectedDetails={selectedDetails}
      renderBrowserName={(node, label) => devices.some(device => device.endpoint.id === node.id)
        ? <DeviceDisplayNameEditor key={`${context}:browser:${node.id}`} variant="inline" target={{ kind: "browser", id: node.id }} label={label} customName={displayName("browser", node.id)} disabledReason={nameDisabledReason("browser", node.id, true)} saving={displayNames.saving} error={displayNames.error} setName={displayNames.setName} />
        : <span className="block break-words text-[10px] font-semibold sm:text-xs [overflow-wrap:anywhere]">{label}</span>}
      toolbar={<div className="flex flex-wrap items-start gap-2">
        <button className="btn-ghost min-h-11 sm:min-h-8 text-xs" disabled={!!busy} onClick={() => { setRefreshRound(value => value + 1); displayNames.refresh(); void client.refresh(); }}>Refresh access</button>
        {state.status === "ready" && pending.client && !needsReview && <details className="min-w-0 text-xs open:w-full"><summary className="min-h-11 sm:min-h-8 cursor-pointer rounded-md border border-[var(--border-muted)] px-2 py-3 sm:py-2">Add / review</summary><p className="my-2 text-xs text-[var(--text-muted)]">Sign in on the new browser, then review its request here and compare the code on both devices.</p><PendingDeviceInbox client={pending.client} snapshot={inbox} offline={state.offline} /></details>}
        {(error || state.status === "error") && <p role="alert" className="w-full text-sm text-[var(--status-error)]">{error ?? securityErrorMessage({ code: state.code })}</p>}
        {state.status === "ready" && pending.client && needsReview && <div className="w-full"><PendingDeviceInbox client={pending.client} snapshot={inbox} offline={state.offline} /></div>}
      </div>} />
    {state.status === "unapproved" && state.historyExists && <DeviceApproval ownerId={client.ownerId} email="your account" client={client} />}
    <details className="text-xs text-[var(--text-muted)]"><summary className="min-h-11 sm:min-h-8 cursor-pointer py-3 sm:py-2">Recovery and security details</summary><p>Clearing browser storage loses its private key. Password resets cannot recover it. Keep an approved browser and local CLI access available. If every account signing key is lost, each computer needs explicit account-trust recovery. Local recovery cannot reset account approvals.</p></details>
  </div>;
}
