"use client";

import { useEffect, useId, useRef, useState } from "react";

const valid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value);
export function AppUpdateNotice({ reload = () => window.location.reload(), buildId = process.env.FTOWN_UI_BUILD_ID }: { reload?: () => void; buildId?: string } = {}) {
  const [newBuild, setNewBuild] = useState<string | null>(null);
  const suppressed = useRef<string | null>(null);
  const current = buildId;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const laterRef = useRef<HTMLButtonElement>(null);
  const titleId = useId(), descriptionId = useId();
  const open = newBuild !== null;
  useEffect(() => {
    if (!valid(current)) return;
    let alive = true; let pending = false; let controller: AbortController | null = null;
    const check = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true; controller = new AbortController();
      try {
        const response = await fetch("/api/version", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) return;
        const value: unknown = await response.json();
        if (!alive || !value || typeof value !== "object" || !("buildId" in value) || !valid(value.buildId)) return;
        let later = ""; try { later = sessionStorage.getItem("ftown:app-update-later") ?? ""; } catch { /* storage is optional */ }
        setNewBuild(value.buildId !== current && value.buildId !== later && value.buildId !== suppressed.current ? value.buildId : null);
      } catch { /* Offline and malformed responses do not announce an update. */ }
      finally { pending = false; }
    };
    void check(); const timer = setInterval(() => void check(), 300_000);
    const visibility = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { alive = false; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [current]);
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    let previous: HTMLElement | null = null;
    const visible = (element: Element) => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true" || node instanceof HTMLDialogElement && !node.open) return false;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      }
      return true;
    };
    const showWhenAvailable = () => {
      const others = document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
      if (dialog.open || [...others].some(other => other !== dialog && visible(other))) return;
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      observer.disconnect();
      laterRef.current?.focus();
    };
    const observer = new MutationObserver(showWhenAvailable);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "hidden", "aria-hidden", "aria-modal", "role", "style", "class"] });
    showWhenAvailable();
    return () => { observer.disconnect(); if (dialog.open) dialog.close(); previous?.focus(); };
  }, [open]);
  if (!newBuild) return null;
  const later = () => {
    suppressed.current = newBuild;
    try { sessionStorage.setItem("ftown:app-update-later", newBuild); } catch { /* keep this tab quiet in memory */ }
    setNewBuild(null);
  };
  return <dialog ref={dialogRef} aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); later(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) later();
    }}
    className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_24px)] max-w-sm overflow-y-auto rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-4 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/70">
    <h2 id={titleId} className="text-base font-semibold">App update available</h2>
    <p id={descriptionId} className="mt-3 text-sm">A new version is ready. Reloading reconnects the terminal; unsent dialog input may be lost.</p>
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <button ref={laterRef} type="button" className="min-h-11 rounded border border-[var(--border-muted)] px-3" onClick={later}>Later</button>
      <button type="button" className="min-h-11 rounded bg-[var(--accent)] px-3 text-black" onClick={reload}>Reload</button>
    </div>
  </dialog>;
}
