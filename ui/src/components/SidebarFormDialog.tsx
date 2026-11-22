"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: string;
  action: string;
  disabled?: boolean;
  close: () => void;
  submit: () => void | Promise<void>;
  children: ReactNode;
}

export function SidebarFormDialog({ title, action, disabled, close, submit, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return createPortal(<dialog ref={ref} aria-labelledby={titleId} className="computers-dialog p-5"
    style={{ width: "min(26rem, calc(100vw - 2rem))" }}
    onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <h2 id={titleId} className="mb-4 text-lg font-semibold">{title}</h2>
    <form onSubmit={async event => {
      event.preventDefault();
      if (busy || disabled) return;
      setBusy(true);
      setError("");
      try { await submit(); close(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save changes."); }
      finally { setBusy(false); }
    }}>
      <fieldset disabled={busy} className="space-y-4">
        {children}
        {error && <p role="alert" className="text-sm text-[var(--status-error)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" type="button" onClick={close}>Cancel</button>
          <button className="btn-accent" disabled={disabled} type="submit">{action}</button>
        </div>
      </fieldset>
    </form>
  </dialog>, document.body);
}
