"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  project: string;
  computers: Array<{ id: string; label: string }>;
  allowed?: string[];
  changeBridges: (ids?: string[]) => void;
  changeName: (next: string | null) => Promise<void>;
  close: () => void;
}

export function ProjectSettingsDialog({ project, computers, allowed, changeBridges, changeName, close }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(project);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  async function submit(next: string | null) {
    setError("");
    setBusy(true);
    try { await changeName(next); close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update project."); }
    finally { setBusy(false); }
  }
  return <dialog ref={ref} className="computers-dialog p-5" aria-labelledby="project-settings-title"
    onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
    <header className="flex items-center justify-between gap-2"><h2 className="text-lg font-semibold" id="project-settings-title">Project settings</h2>
      <button type="button" className="btn-ghost min-h-11 min-w-11" disabled={busy} onClick={close} aria-label="Close project settings">×</button></header>
    <fieldset disabled={busy} className="space-y-4">
      <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void submit(name.trim()); }}>
        <label className="flex min-w-0 flex-1 flex-col gap-1">Project name<input maxLength={256} value={name} onChange={e => setName(e.target.value)} /></label>
        <button className="btn-accent" disabled={!name.trim() || name.trim() === project}>Rename project</button>
      </form>
      <fieldset className="space-y-1"><legend className="font-semibold">Allowed bridges</legend>
        <label className="flex gap-2"><input type="checkbox" checked={!allowed} onChange={e => changeBridges(e.target.checked ? undefined : computers.map(b => b.id))} />All bridges, including future bridges</label>
        {computers.map(b => <label key={b.id} className="flex gap-2"><input type="checkbox" checked={allowed?.includes(b.id) ?? true} onChange={e => {
          const ids = new Set(allowed ?? computers.map(item => item.id));
          if (e.target.checked) ids.add(b.id); else ids.delete(b.id);
          changeBridges([...ids]);
        }} />{b.label}</label>)}
      </fieldset>
      {confirm ? <div><p>Delete “{project}” and move its sessions to No project? Deleting a hosted project also deletes its board and tickets. Session working directories and files are preserved.</p>
        <div className="flex gap-3"><button className="btn-danger" onClick={() => void submit(null)}>Confirm delete</button><button className="btn-ghost" onClick={() => setConfirm(false)}>Cancel</button></div></div>
        : <button className="btn-danger" onClick={() => setConfirm(true)}>Delete project</button>}
    </fieldset>
    {busy && <p role="status">Updating project…</p>}
    {error && <p role="alert">{error}</p>}
  </dialog>;
}
