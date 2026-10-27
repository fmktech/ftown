"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { BridgeInvitation, BridgeSecurityState, SecurityCommand, SecurityCommandResults } from "@security/protocol";
import { SecurityActivity } from "./SecurityActivity";
import { SecurityDevices } from "./SecurityDevices";
import type { AccountSecurityClient, AccountSecuritySnapshot } from "@/lib/account-security-client";
import type { PendingApprovalClient, PendingSnapshot } from "@/lib/pending-approval-client";

export interface SecurityBridge {
  bridgeId: string;
  label: string;
  security: BridgeSecurityState;
}

export type SecurityCommandExecutor = <C extends SecurityCommand>(command: C) => Promise<SecurityCommandResults[C["type"]]>;

export interface SecurityPanelProps {
  open: boolean;
  onClose: () => void;
  bridges: SecurityBridge[];
  currentEndpointId: string | null;
  currentComputerIds?: ReadonlySet<string>;
  execute: SecurityCommandExecutor;
  initialBridgeId?: string;
  gatewayAvailable?: boolean;
  onInvitation?: (invitation: BridgeInvitation) => void;
  accountClient?: AccountSecurityClient;
  accountState?: AccountSecuritySnapshot;
  pendingClient?: PendingApprovalClient;
  pendingState?: PendingSnapshot;
  initialView?: "activity" | "devices";
}

export function securityStateLabel(state: BridgeSecurityState["status"]): string {
  return {
    unpaired: "Approval required", connecting: "Connecting securely", ready: "Encrypted connection ready",
    offline: "Bridge offline", revoked: "Access revoked", key_changed: "Bridge key changed", upgrade_required: "Bridge upgrade required",
  }[state];
}

/** A fixed allowlist prevents transport/server error text from becoming UI content. */
export function securityErrorMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const messages: Record<string, string> = {
    invalid_account_trust: "Account trust could not be verified. Access is paused; use an approved device or explicit recovery.",
    account_trust_conflict: "Account devices changed. Refresh and review this action again.",
    account_trust_rollback: "The server returned older or conflicting account trust. Access is paused; no keys were replaced.",
    account_approval_required: "Approve this device using an existing approved device first.",
    account_device_revoked: "This account device was revoked or its signing key is unavailable. Use another approved device for recovery.",
    account_bridge_revoked: "This computer was removed from account trust.",
    account_offline_expired: "Account access paused: reconnect to refresh trust and check this device's clock.",
    account_last_admin: "Approve another device before revoking the last account administrator.",
    account_capacity_exceeded: "Account trust reached its supported capacity. Contact your administrator for explicit recovery or rotation.",
    account_enrollment_expired: "This approval request expired. Create a new request on the device you want to add.",
    account_enrollment_invalid: "This approval request or response could not be verified. Start again from the requesting device, or reopen its original private link.",
    account_storage_unavailable: "Account trust could not be refreshed or stored. Check the connection and browser storage, then try again.",
    permission_denied: "This device does not have permission for this action.",
    approval_required: "Approve this browser on the bridge first.", endpoint_revoked: "This device's bridge access was revoked.",
    bridge_offline: "The bridge is offline. Reconnect it and try again.", key_changed: "The bridge key changed. Verify it with a fresh invitation.",
    upgrade_required: "Upgrade and pair this bridge to use encrypted access.", audit_unavailable: "The security log is unavailable. Try again shortly.",
    security_setup_required: "Security storage needs setup before this view is available.", invalid_cursor: "This page has expired. Refresh the log.",
    outcome_unknown: "Delivery is uncertain. Refresh before repeating this action.",
  };
  return messages[code] ?? "This security action could not be completed. Refresh and try again.";
}

export function SecurityPanel({ open, onClose, bridges, currentEndpointId, currentComputerIds, execute, initialBridgeId,
  gatewayAvailable = true, onInvitation, accountClient, accountState, pendingClient, pendingState, initialView = "devices" }: SecurityPanelProps) {
  const [view, setView] = useState<"activity" | "devices">("devices");
  const [bridgeId, setBridgeId] = useState(initialBridgeId ?? "");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    setBridgeId(initialBridgeId ?? "");
    setView(initialView);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, [open, initialBridgeId, initialView]);

  if (!open) return null;
  const selected = bridges.find(bridge => bridge.bridgeId === bridgeId);
  return <dialog ref={dialogRef} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    className="fixed inset-0 m-auto max-h-[min(92dvh,920px)] w-[calc(100%_-_16px)] max-w-4xl overflow-hidden rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/70">
    <div className="flex max-h-[min(92dvh,920px)] flex-col" onClick={event => event.stopPropagation()}>
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-muted)] px-3 py-1.5 sm:px-4">
        <h2 id={titleId} className="shrink-0 text-base font-semibold">Security</h2>
        <div role="tablist" aria-label="Security views" className="flex min-w-0 flex-1 gap-1">
          {(["devices", "activity"] as const).map(tab => <button key={tab} type="button" role="tab"
            aria-selected={view === tab} aria-controls={`${titleId}-${tab}`} id={`${titleId}-tab-${tab}`}
            tabIndex={view === tab ? 0 : -1}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "devices" : event.key === "End" ? "activity" : tab === "activity" ? "devices" : "activity";
              setView(next); document.getElementById(`${titleId}-tab-${next}`)?.focus();
            }}
            className={`${view === tab ? "btn-accent" : "btn-ghost"} min-h-11 sm:min-h-8`} onClick={() => setView(tab)}>
            {tab === "activity" ? "Activity" : "Access"}
          </button>)}
        </div>
        {(view === "activity" || !accountClient || !accountState?.trust && !!accountState?.legacyBridges.length) && <label className="order-last flex w-full min-w-0 items-center gap-2 text-xs text-[var(--text-muted)] sm:order-none sm:w-auto">Computer
          <select aria-label="Security computer" value={bridgeId} onChange={event => setBridgeId(event.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] px-2 text-sm text-[var(--text-primary)] sm:min-h-8 sm:max-w-56">
            <option value="">All computers</option>
            {bridges.map(bridge => <option key={bridge.bridgeId} value={bridge.bridgeId}>{bridge.label}</option>)}
          </select>
        </label>}
        <button type="button" aria-label="Close security" className="btn-ghost min-h-11 min-w-11 shrink-0 sm:min-h-8 sm:min-w-8" onClick={onClose}>✕</button>
      </header>
      <div data-security-content className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4">
        {selected && <p className="mb-2 text-xs text-[var(--text-muted)]">{selected.label}: {securityStateLabel(selected.security.status)}</p>}
        <section role="tabpanel" id={`${titleId}-${view}`} aria-labelledby={`${titleId}-tab-${view}`}>
          {view === "activity" ? <SecurityActivity bridgeId={bridgeId} selectedBridge={selected} execute={execute} gatewayAvailable={gatewayAvailable} />
            : <SecurityDevices bridge={selected} bridges={bridges} currentEndpointId={currentEndpointId} currentComputerIds={currentComputerIds} execute={execute} onInvitation={onInvitation} accountClient={accountClient} accountState={accountState} pendingClient={pendingClient} pendingState={pendingState} />}
        </section>
      </div>
    </div>
  </dialog>;
}
