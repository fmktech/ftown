"use client";

import { useState } from "react";
import { DEVICE_DISPLAY_NAME_MAX_LENGTH, type DeviceNameTarget, type SetDeviceNameRequest } from "@/lib/device-display-name-contract";

interface Props { target: DeviceNameTarget; label: string; customName?: string; disabledReason?: string; saving: boolean; error: string | null; setName: (input: SetDeviceNameRequest) => Promise<boolean> }
export function DeviceDisplayNameEditor({ target, label, customName, disabledReason, saving, error, setName }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<"save" | "reset" | null>(null);
  const [status, setStatus] = useState("");
  const trimmed = value.trim();
  const valid = !!trimmed && trimmed.length <= DEVICE_DISPLAY_NAME_MAX_LENGTH && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(trimmed);
  async function submit(name: string | null) {
    if (saving || pending || disabledReason || (name !== null && !valid)) return;
    setPending(name === null ? "reset" : "save"); setStatus("");
    const success = await setName({ ...target, name });
    setPending(null);
    if (success) { setEditing(false); setStatus(name === null ? "Name reset." : "Display name saved."); }
  }
  return <div className="min-w-0 space-y-2 border-t border-[var(--border-subtle)] pt-2">
    <p className={`text-xs text-[var(--text-muted)] ${editing ? "" : "md:hidden"}`}>Display names appear across your signed-in browsers.</p>
    {!editing ? <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-ghost min-h-11 md:min-h-8" aria-label={`Rename ${label}`} disabled={!!disabledReason || saving} onClick={() => { setValue(customName ?? label); setStatus(""); setEditing(true); }}>Rename</button>
      {customName !== undefined && <button type="button" className="btn-ghost min-h-11 md:min-h-8" disabled={!!disabledReason || saving} onClick={() => void submit(null)}>{pending === "reset" ? "Resetting…" : "Reset name"}</button>}
    </div> : <form className="min-w-0 space-y-2" onSubmit={event => { event.preventDefault(); void submit(trimmed); }} onKeyDown={event => { if (event.key === "Escape" && !saving) { event.preventDefault(); setEditing(false); } }}>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-muted)]">Display name
        <input autoFocus disabled={saving || !!pending || !!disabledReason} value={value} onChange={event => setValue(event.target.value)} maxLength={DEVICE_DISPLAY_NAME_MAX_LENGTH} className="min-h-11 w-full min-w-0 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] px-3 text-sm text-[var(--text-primary)]" />
      </label>
      {!valid && <p className="text-xs text-[var(--status-error)]">Enter a name without control characters.</p>}
      <div className="flex flex-wrap gap-2"><button type="submit" className="btn-accent min-h-11" disabled={!valid || saving}>{pending === "save" ? "Saving…" : "Save"}</button><button type="button" className="btn-ghost min-h-11" disabled={saving} onClick={() => setEditing(false)}>Cancel</button></div>
    </form>}
    {disabledReason && <p className="text-xs text-[var(--text-muted)]">{disabledReason}</p>}
    <p aria-live="polite" className={`break-words text-xs ${error ? "text-[var(--status-error)]" : "text-[var(--text-muted)]"}`}>{error || status}</p>
  </div>;
}
