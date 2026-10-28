"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { UpdateView } from "@/hooks/useBridgeUpdates";

const manual = (value: string | undefined): string => value && /^npx ftown@(?:latest|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)) setup(?: --repair)?$/.test(value) ? value : "npx ftown@latest setup";
const reason: Record<string, string> = {
  busy: "Stop running sessions before updating",
  permission_denied: "This device does not have control permission for this computer.",
  not_enabled: "Updates are not enabled on this computer. Start an unsupervised single-bridge installation with ftown start --allow-updates.",
  unsupported_launch: "This installation cannot update itself. Use its service manager or the manual setup instructions below. ftown start --allow-updates requires an unsupervised single-bridge installation.",
  in_progress: "Another update is already in progress.",
  release_unavailable: "The latest release could not be checked. Try again later.",
};

export function BridgeUpdatesDialog({ open, name, view, onClose, onCheck, onUpdate }: { open: boolean; name: string; view: UpdateView; onClose: () => void; onCheck: () => void; onUpdate: () => void }) {
  const ref = useRef<HTMLDialogElement>(null); const title = useId();
  const [confirming, setConfirming] = useState(false); const [copied, setCopied] = useState("");
  useEffect(() => {
    if (!open) return;
    setConfirming(false); setCopied("");
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal();
    return () => { ref.current?.close(); previous?.focus(); };
  }, [open]);
  if (!open) return null;
  const status = view.status;
  const command = manual(status?.manualCommand);
  const eligible = Boolean(status?.canUpdate && status.blockedReason === null && status.availability === "available" && status.latestVersion && !view.operation && !view.loading);
  return <dialog ref={ref} aria-labelledby={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_24px)] max-w-lg overflow-y-auto rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-4 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/70">
    <h2 id={title} className="text-base font-semibold">Updates for {name}</h2>
    <div className="mt-3 space-y-2 text-sm" role="status" aria-live="polite">
      <p>Installed: {status?.currentVersion ?? "Unknown"}</p>
      <p>Latest: {status?.latestVersion ?? "Unknown"}</p>
      {view.loading && <p>Checking for updates…</p>}
      {status?.availability === "current" && <p>Up to date.</p>}
      {status?.availability === "available" && <p>Update available.</p>}
      {status?.availability === "unknown" && <p>Update availability is unknown.</p>}
      {status?.operation && <p>Update status: {status.operation.phase === "succeeded" ? (view.complete ? "Completed" : "Previous operation recorded") : ({ staging: "Preparing", prepared: "Ready to restart", restarting: "Restarting", failed: "Failed" })[status.operation.phase]}.</p>}
      {status?.blockedReason && <p>{reason[status.blockedReason]}</p>}
      {view.message && <p>{view.message}</p>}
    </div>
    <div className="mt-4 space-y-2 text-sm">
      <p>Manual setup on this computer:</p>
      <code className="block break-all rounded bg-[var(--bg-elevated)] p-2">{command}</code>
      <button type="button" className="min-h-11 rounded border border-[var(--border-muted)] px-3" onClick={() => { if (!navigator.clipboard?.writeText) { setCopied("Copy unavailable; select the command above."); return; } void navigator.clipboard.writeText(command).then(() => setCopied("Copied."), () => setCopied("Copy unavailable; select the command above.")); }}>Copy setup command</button>
      {copied && <span role="status" className="ml-2">{copied}</span>}
      <p>For an unsupervised single-bridge installation, start with <code>ftown start --allow-updates</code>. For managed installations, use the service manager.</p>
    </div>
    {confirming && <div className="mt-4 rounded border border-[var(--border-muted)] p-3 text-sm" role="group" aria-label="Confirm bridge update">
      <p>All sessions must be stopped before updating. The bridge will briefly disconnect.</p>
      <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="min-h-11 rounded bg-[var(--accent)] px-3 text-black" disabled={!eligible} onClick={() => { setConfirming(false); onUpdate(); }}>Confirm update and restart</button><button type="button" className="min-h-11 px-3" onClick={() => setConfirming(false)}>Cancel</button></div>
    </div>}
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" className="min-h-11 rounded border border-[var(--border-muted)] px-3" disabled={view.loading} onClick={onCheck}>Check again</button>
      <button type="button" className="min-h-11 rounded bg-[var(--accent)] px-3 text-black disabled:opacity-40" disabled={!eligible} onClick={() => setConfirming(true)}>Update and restart</button>
      <button type="button" className="min-h-11 px-3" onClick={onClose}>Close</button>
    </div>
  </dialog>;
}
