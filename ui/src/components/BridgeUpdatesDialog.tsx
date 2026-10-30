"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { UpdateView } from "@/hooks/useBridgeUpdates";

const manual = (value: string | undefined): string => value && /^npx ftown@(?:latest|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)) setup(?: --repair)?$/.test(value) ? value : "npx ftown@latest setup";
const reason: Record<string, string> = {
  busy: "Stop running sessions before updating.",
  permission_denied: "This device does not have control permission for this computer.",
  not_enabled: "Updates are disabled on this computer or this bridge uses an older default. Start with ftown start; older bridges may require ftown start --allow-updates.",
  unsupported_launch: "Automatic updates aren’t available for this installation. Use your service manager or manual setup.",
  in_progress: "Another update is already in progress.",
  release_unavailable: "The latest release could not be checked. Try again later.",
  node_incompatible: "Upgrade Node on this computer to a version supported by the latest release before updating the bridge.",
};
const phaseLabel = { staging: "Preparing", prepared: "Ready to restart", restarting: "Restarting", failed: "Failed" } as const;
const button = "min-h-11 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-10";

export function BridgeUpdatesDialog({ open, name, view, onClose, onCheck, onUpdate }: { open: boolean; name: string; view: UpdateView; onClose: () => void; onCheck: () => void; onUpdate: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    if (!open) return;
    setConfirming(false); setCopied("");
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, [open]);
  if (!open) return null;
  const status = view.status;
  const command = manual(status?.manualCommand);
  const eligible = Boolean(status?.canUpdate && status.blockedReason === null && status.availability === "available" && status.latestVersion && !view.operation && !view.loading);
  const recorded = status?.operation;
  const phase = !view.operation || (recorded?.id === view.operation.id && recorded.targetVersion === view.operation.target) ? recorded?.phase : undefined;
  const operationLabel = phase === "succeeded" ? (view.complete ? "Update completed" : "Previous operation recorded") : phase ? `Update ${phaseLabel[phase].toLowerCase()}` : view.operation ? "Update in progress" : null;
  const headline = view.loading ? "Checking for updates" : operationLabel ?? (!status ? (view.message ? "Couldn’t check for updates" : "Not checked yet") : status.availability === "current" ? "Up to date" : status.availability === "available" ? "Update available" : "Update status unavailable");
  const warning = !view.loading && (status?.blockedReason || phase === "failed" || (!status && view.message));
  const neutral = view.loading || (!status && !view.message) || status?.availability === "unknown";
  const nodeBlocked = status?.blockedReason === "node_incompatible";
  const runtime = <>
    {status?.currentNodeVersion && <div className="flex flex-wrap justify-between gap-x-4"><dt>Current Node</dt><dd className="break-all font-[family-name:var(--font-mono)] text-[var(--text-primary)]">{status.currentNodeVersion}</dd></div>}
    {status?.requiredNodeEngine && <div className="flex flex-wrap justify-between gap-x-4"><dt>Required Node</dt><dd className="break-all font-[family-name:var(--font-mono)] text-[var(--text-primary)]">{status.requiredNodeEngine}</dd></div>}
  </>;
  return <dialog ref={ref} aria-labelledby={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    className="fixed inset-0 m-auto max-h-[calc(100dvh_-_32px)] w-[calc(100%_-_32px)] max-w-[480px] overflow-y-auto rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-0 font-[family-name:var(--font-sans)] text-[var(--text-primary)] shadow-2xl backdrop:bg-black/70">
    <div className="p-5 text-sm leading-[1.5] sm:p-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0"><h2 id={title} className="text-lg font-semibold leading-6">Bridge updates</h2><p className="mt-1 break-words text-xs text-[var(--text-muted)]">{name}</p></div>
        <button type="button" aria-label="Close bridge updates" className={`${button} -mr-2 -mt-2 flex min-w-11 items-center justify-center text-lg text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]`} onClick={onClose}>×</button>
      </header>
      <div className="mt-4" role="status" aria-live="polite">
        <p className="flex items-center gap-2 font-semibold"><span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${warning ? "bg-[var(--status-pending)]" : neutral ? "bg-[var(--text-muted)]" : "bg-[var(--accent)]"}`} />{headline}</p>
        {view.loading && operationLabel && <p className="mt-1 text-[var(--text-secondary)]">{operationLabel}</p>}
        {view.message && <p className="mt-1 text-[var(--text-secondary)]">{view.message}</p>}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-[var(--border-muted)] bg-[var(--bg-elevated)] p-3">
        <div className="min-w-0"><dt className="text-xs text-[var(--text-muted)]">Installed</dt><dd className="mt-1 break-all font-[family-name:var(--font-mono)]">{status?.currentVersion ?? "Unknown"}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-[var(--text-muted)]">Latest</dt><dd className="mt-1 break-all font-[family-name:var(--font-mono)]">{status?.latestVersion ?? "Unknown"}</dd></div>
      </dl>
      {status?.blockedReason && <div className="mt-4 rounded-lg border border-[var(--status-pending)] bg-[var(--bg-elevated)] p-3 text-[var(--text-primary)]">
        <p>{reason[status.blockedReason]}</p>
        {nodeBlocked && <dl className="mt-2 space-y-1 text-xs text-[var(--text-muted)]">{runtime}</dl>}
      </div>}
      <details className="mt-4 rounded-lg border border-[var(--border-muted)]">
        <summary className="cursor-pointer rounded-lg px-3 py-2 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Setup &amp; runtime details</summary>
        <div className="space-y-3 border-t border-[var(--border-muted)] p-3 text-xs text-[var(--text-secondary)]">
          {!nodeBlocked && (status?.currentNodeVersion || status?.requiredNodeEngine) && <dl className="space-y-1">{runtime}</dl>}
          <div><p className="mb-1">Manual setup on this computer:</p><code className="block select-all break-all rounded bg-[var(--bg-base)] p-2 font-[family-name:var(--font-mono)] text-[var(--text-primary)]">{command}</code></div>
          <div className="flex flex-wrap items-center gap-2"><button type="button" className={`${button} border border-[var(--border-muted)] hover:bg-[var(--bg-elevated)]`} onClick={() => { if (!navigator.clipboard?.writeText) { setCopied("Copy unavailable; select the command above."); return; } void navigator.clipboard.writeText(command).then(() => setCopied("Copied."), () => setCopied("Copy unavailable; select the command above.")); }}>Copy command</button>{copied && <span role="status">{copied}</span>}</div>
          <p>For an unsupervised single-bridge installation, start with <code className="font-[family-name:var(--font-mono)]">ftown start</code>. For managed installations, use the service manager.</p>
        </div>
      </details>
      {confirming && <div className="mt-4 rounded-lg border border-[var(--border-muted)] bg-[var(--bg-elevated)] p-3" role="group" aria-label="Confirm bridge update">
        <p>All sessions must be stopped before updating. The bridge will briefly disconnect.</p>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={`${button} bg-[var(--accent)] text-[var(--bg-void)] hover:bg-[var(--accent-bright)]`} disabled={!eligible} onClick={() => { if (!eligible) return; setConfirming(false); onUpdate(); }}>Confirm update and restart</button><button type="button" className={`${button} border border-[var(--border-muted)] hover:bg-[var(--bg-hover)]`} onClick={() => setConfirming(false)}>Cancel</button></div>
      </div>}
      <footer className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border-muted)] pt-4">
        <button type="button" className={`${button} border border-[var(--border-muted)] hover:bg-[var(--bg-elevated)]`} disabled={view.loading} onClick={onCheck}>Check again</button>
        <button type="button" className={`${button} text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]`} onClick={onClose}>Close</button>
        {eligible && <button type="button" className={`${button} ml-auto bg-[var(--accent)] text-[var(--bg-void)] hover:bg-[var(--accent-bright)]`} onClick={() => setConfirming(true)}>Update and restart</button>}
      </footer>
    </div>
  </dialog>;
}
