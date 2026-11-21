"use client";

import { useEffect, useRef, useState } from "react";
import type { Command, CommandResponse } from "@/types";

type Send = (command: Command) => Promise<CommandResponse>;
type Props = { bridgeId: string; name: string; send: Send; close: () => void };

function InstructionField({ bridgeId, scope, send }: Pick<Props, "bridgeId" | "send"> & { scope: "global" | "bridge" }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setMessage("");
    void send({ type: "get_instructions", requestId: crypto.randomUUID(), payload: { bridgeId, scope } })
      .then(result => {
        if (!active) return;
        const data = result.data as { text?: unknown } | null;
        if (!result.success || typeof data?.text !== "string") throw new Error(result.error || "Could not load instructions.");
        setSaved(data.text);
        setDraft(data.text);
      }).catch(error => { if (active) setMessage(String(error)); });
    return () => { active = false; };
  }, [bridgeId, scope, send, attempt]);
  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const result = await send({ type: "set_instructions", requestId: crypto.randomUUID(), payload: { bridgeId, scope, text: draft } });
      if (!result.success) throw new Error(result.error || "Could not save instructions.");
      setSaved(draft);
      setMessage("Saved");
    } catch (error) { setMessage(String(error)); }
    finally { setSaving(false); }
  }
  const label = scope === "global" ? "Global instructions" : "Bridge instructions";
  return <section className="mt-4">
    <label className="block font-semibold" htmlFor={scope + "-instructions"}>{label}</label>
    <p className="mb-2 text-xs">{scope === "global" ? "Shared with paired bridges. The newest edit wins." : "Applies only to this computer."}</p>
    <textarea id={scope + "-instructions"} rows={6} disabled={saved === null || saving}
      className="w-full rounded border border-[var(--border-muted)] p-2 font-mono text-sm"
      placeholder={saved === null && !message ? "Loading…" : undefined}
      value={draft} onChange={event => { setDraft(event.target.value); setMessage(""); }} />
    <div className="flex items-center gap-2">
      <button className="btn-accent" disabled={saved === null || saving || saved === draft} onClick={() => void save()}>Save {scope} instructions</button>
      <span role="status">{message}</span>
      {saved === null && message && <button className="btn-ghost" onClick={() => setAttempt(n => n + 1)}>Retry</button>}
    </div>
  </section>;
}

export function InstructionsDialog({ bridgeId, name, send, close }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="computers-dialog p-5" aria-labelledby="instruction-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="flex items-center justify-between gap-2">
      <h2 id="instruction-title" className="text-lg font-semibold">Agent instructions · {name}</h2>
      <button className="btn-ghost" onClick={close} aria-label="Close agent instructions">×</button>
    </header>
    {(["global", "bridge"] as const).map(scope => <InstructionField key={bridgeId + scope} bridgeId={bridgeId} scope={scope} send={send} />)}
  </dialog>;
}
