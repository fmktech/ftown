"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardColumn } from "../../../bridge/src/board-columns";
import type { Ticket } from "./ProjectTicketDetail";

interface Props {
  columns: BoardColumn[];
  tickets: Ticket[];
  projectName: string;
  editable: boolean;
  error: string;
  change: (payload: Record<string, unknown>) => Promise<boolean>;
  close: () => void;
}

export function ProjectBoardSettingsDialog({ columns, tickets, projectName, editable, error, change, close }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [original, setOriginal] = useState(columns);
  const [draft, setDraft] = useState(columns);
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);

  const trimmed = draft.map(column => ({ ...column, label: column.label.trim() }));
  const removed = original.filter(column => !draft.some(c => c.id === column.id));
  const dirty = JSON.stringify(trimmed) !== JSON.stringify(original);
  const conflict = JSON.stringify(columns) !== JSON.stringify(original);
  const labels = trimmed.map(column => column.label.toLowerCase());
  const duplicate = new Set(labels).size !== labels.length;
  const occupied = removed.filter(column => tickets.some(ticket => ticket.stage === column.id));
  const moveTo = Object.fromEntries(occupied.flatMap(column => {
    const destination = destinations[column.id];
    return draft.some(c => c.id === destination) ? [[column.id, destination]] : [];
  }));
  const valid = !duplicate && labels.every(Boolean) && occupied.every(c => moveTo[c.id]);

  function reorder(index: number, step: number) {
    const copy = [...draft];
    [copy[index], copy[index + step]] = [copy[index + step], copy[index]];
    setDraft(copy);
  }
  return <dialog ref={dialog} className="computers-dialog p-5" aria-labelledby="board-settings-title"
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="mb-4 flex items-center justify-between gap-3">
      <h2 id="board-settings-title" className="text-lg font-semibold">Board settings</h2>
      <button className="btn-ghost" aria-label="Close board settings" onClick={close}>×</button>
    </header>
    {error && <p role="alert" className="mb-3">{error}</p>}
    {conflict && <p role="alert" className="mb-3">The board columns changed while you were editing.
      <button className="btn-ghost ml-2" onClick={() => { setOriginal(columns); setDraft(columns); setDestinations({}); }}>Reload columns</button></p>}
    <form className="space-y-4" onSubmit={async event => {
      event.preventDefault();
      if (valid && dirty && !conflict && await change({ action: "configure_columns", columns: trimmed, previousColumns: original, moveTo })) close();
    }}>
      <fieldset className="space-y-2" disabled={!editable || conflict}>
        <legend className="mb-2 font-semibold">Columns</legend>
        {draft.map((column, index) => <div className="flex items-center gap-1" key={column.id}>
          <input className="min-w-0 flex-1 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] p-2 text-sm"
            aria-label={`Column ${index + 1} name`} maxLength={64} value={column.label} onChange={e =>
              setDraft(draft.map(c => c.id === column.id ? { ...c, label: e.target.value } : c))} required />
          <button type="button" className="btn-ghost" title="Move up" aria-label={`Move ${column.label} up`} disabled={index === 0} onClick={() => reorder(index, -1)}>↑</button>
          <button type="button" className="btn-ghost" title="Move down" aria-label={`Move ${column.label} down`} disabled={index === draft.length - 1} onClick={() => reorder(index, 1)}>↓</button>
          <button type="button" className="btn-ghost" title="Remove column" aria-label={`Remove ${column.label}`} disabled={draft.length === 1}
            onClick={() => setDraft(draft.filter(c => c.id !== column.id))}>×</button>
        </div>)}
        <button type="button" className="btn-ghost" disabled={draft.length >= 32} onClick={() =>
          setDraft([...draft, { id: crypto.randomUUID(), label: "" }])}>Add column</button>
        {duplicate && <p role="alert" className="text-sm">Give each column a unique name.</p>}
        {occupied.map(column => <label className="block text-sm" key={column.id}>
          Move tickets from {column.label} ({tickets.filter(ticket => ticket.stage === column.id).length}) to
          <select className="btn-ghost ml-2" value={moveTo[column.id] ?? ""} onChange={event =>
            setDestinations({ ...destinations, [column.id]: event.target.value })}>
            <option value="" disabled>Choose a destination</option>
            {draft.map((c, index) => <option key={c.id} value={c.id}>{c.label || `Column ${index + 1}`}</option>)}
          </select>
        </label>)}
      </fieldset>
      <button className="btn-accent" disabled={!editable || !dirty || !valid || conflict}>Save columns</button>
    </form>
    <div className="mt-5 border-t border-[var(--border-subtle)] pt-4">
      {confirmDelete ? <div className="space-y-2">
        <p>Delete the board for “{projectName}”? This permanently deletes its columns, tickets and comments. The project and its sessions stay available.</p>
        <div className="flex gap-2"><button className="btn-danger" disabled={!editable} onClick={async () => {
          if (await change({ action: "delete_board" })) close();
        }}>Confirm delete board</button><button className="btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button></div>
      </div> : <button className="btn-danger" disabled={!editable} onClick={() => setConfirmDelete(true)}>Delete board</button>}
    </div>
  </dialog>;
}
