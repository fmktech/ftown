"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { BridgeInvitation, BridgeSecurityState, SecurityCommand, SecurityCommandResults } from "@security/protocol";
import { SecurityActivity } from "./SecurityActivity";
import { SecurityDevices } from "./SecurityDevices";

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
  execute: SecurityCommandExecutor;
  initialBridgeId?: string;
  gatewayAvailable?: boolean;
  onInvitation?: (invitation: BridgeInvitation) => void;
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
    permission_denied: "This device does not have permission for this action.",
    approval_required: "Approve this browser on the bridge first.", endpoint_revoked: "This device's bridge access was revoked.",
    bridge_offline: "The bridge is offline. Reconnect it and try again.", key_changed: "The bridge key changed. Verify it with a fresh invitation.",
    upgrade_required: "Upgrade and pair this bridge to use encrypted access.", audit_unavailable: "The security log is unavailable. Try again shortly.",
    security_setup_required: "Security storage needs setup before this view is available.", invalid_cursor: "This page has expired. Refresh the log.",
    outcome_unknown: "Delivery is uncertain. Refresh before repeating this action.",
  };
  return messages[code] ?? "This security action could not be completed. Refresh and try again.";
}

export function SecurityPanel({ open, onClose, bridges, currentEndpointId, execute, initialBridgeId,
  gatewayAvailable = true, onInvitation }: SecurityPanelProps) {
  const [view, setView] = useState<"activity" | "devices">("activity");
  const [bridgeId, setBridgeId] = useState(initialBridgeId ?? "");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    setBridgeId(initialBridgeId ?? "");
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, [open, initialBridgeId]);

  if (!open) return null;
  const selected = bridges.find(bridge => bridge.bridgeId === bridgeId);
  return <dialog ref={dialogRef} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    className="fixed inset-0 m-auto max-h-[min(92dvh,920px)] w-[calc(100%_-_24px)] max-w-4xl overflow-hidden rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/70">
    <div className="flex max-h-[min(92dvh,920px)] flex-col" onClick={event => event.stopPropagation()}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-muted)] px-4 py-3 sm:px-6">
        <div><h2 id={titleId} className="text-lg font-semibold">Security</h2><p className="text-xs text-[var(--text-muted)]">Devices, trust, and MCP activity</p></div>
        <button type="button" aria-label="Close security" className="btn-ghost min-h-11 min-w-11" onClick={onClose}>✕</button>
      </header>
      <div className="flex shrink-0 flex-col gap-3 border-b border-[var(--border-subtle)] p-4 sm:flex-row sm:items-end sm:justify-between sm:px-6">
        <div role="tablist" aria-label="Security views" className="flex gap-2">
          {(["activity", "devices"] as const).map(tab => <button key={tab} type="button" role="tab"
            aria-selected={view === tab} aria-controls={`${titleId}-${tab}`} id={`${titleId}-tab-${tab}`}
            tabIndex={view === tab ? 0 : -1}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "activity" : event.key === "End" ? "devices" : tab === "activity" ? "devices" : "activity";
              setView(next); document.getElementById(`${titleId}-tab-${next}`)?.focus();
            }}
            className={`${view === tab ? "btn-accent" : "btn-ghost"} min-h-11`} onClick={() => setView(tab)}>
            {tab === "activity" ? "Activity" : "Devices"}
          </button>)}
        </div>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-muted)]">Bridge
          <select aria-label="Security bridge" value={bridgeId} onChange={event => setBridgeId(event.target.value)}
            className="min-h-11 w-full max-w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] px-3 text-sm text-[var(--text-primary)] sm:max-w-72">
            <option value="">All bridges</option>
            {bridges.map(bridge => <option key={bridge.bridgeId} value={bridge.bridgeId}>{bridge.label}</option>)}
          </select>
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
        {selected && <p className="mb-4 text-xs text-[var(--text-muted)]">{selected.label}: {securityStateLabel(selected.security.status)}</p>}
        <section role="tabpanel" id={`${titleId}-${view}`} aria-labelledby={`${titleId}-tab-${view}`}>
          {view === "activity" ? <SecurityActivity bridgeId={bridgeId} selectedBridge={selected} execute={execute} gatewayAvailable={gatewayAvailable} />
            : <SecurityDevices bridge={selected} currentEndpointId={currentEndpointId} execute={execute} onInvitation={onInvitation} />}
        </section>
      </div>
    </div>
  </dialog>;
}
