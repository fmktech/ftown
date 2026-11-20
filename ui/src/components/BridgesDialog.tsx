"use client";

import { useEffect, useRef } from "react";
import { formatResources, type HostResources } from "@/lib/host-resources";

import type { BridgeSecurityState } from "@security/protocol";
import { bridgeConnectionLock, SecurityLockIcon } from "./SecurityLockIcon";

interface Computer {
  id: string;
  label: string;
  online: boolean;
  connection?: BridgeSecurityState["status"];
  ready: boolean;
}

interface Props {
  computers: Computer[];
  resources: ReadonlyMap<string, HostResources>;
  selected: string | null;
  onSelect: (id: string) => void;
  create: (id: string) => void;
  updates: (id: string) => void;
  security: (id: string) => void;
  routing: (id: string) => void;
  close: () => void;
}

export function BridgesDialog({ computers, resources, selected, onSelect, create, updates, security, routing, close }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} aria-label="Bridges" onCancel={event => { event.preventDefault(); close(); }}
    className="m-auto max-h-[85dvh] w-[min(36rem,94vw)] overflow-auto rounded-lg border border-[var(--border-muted)] bg-[var(--bg-surface)] p-4 text-[var(--text-primary)] backdrop:bg-black/60">
    <header className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">Bridges</h2>
      <button className="btn-ghost min-h-11 min-w-11" aria-label="Close bridges" onClick={close}>×</button></header>
    {!computers.length && <p>No known bridges.</p>}
    {computers.map(bridge => <section key={bridge.id} data-bridge-row={bridge.id} aria-label={bridge.label}
      className="border-t border-[var(--border-subtle)] py-3">
      <div className="flex items-baseline justify-between gap-3"><strong className="break-all">{bridge.label}</strong><span>{bridge.online ? "Online" : "Offline"}</span></div>
      {bridge.label !== bridge.id && <p className="break-all font-mono text-xs text-[var(--text-muted)]">{bridge.id}</p>}
      <p className="my-2 text-sm">{formatResources(resources.get(bridge.id)) || "Load unavailable"}</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost min-h-11" disabled={!bridge.ready} aria-pressed={selected === bridge.id} onClick={() => onSelect(bridge.id)}>{selected === bridge.id ? "Selected computer" : "Use computer"}</button>
        <button className="btn-ghost min-h-11" disabled={!bridge.ready} onClick={() => create(bridge.id)}>Create session</button>
        <button className="btn-ghost min-h-11" onClick={() => updates(bridge.id)}>Updates…</button>
        <button className="btn-ghost inline-flex min-h-11 items-center gap-1" aria-label={`Security log for ${bridge.label}`} title={bridgeConnectionLock(bridge.connection).title} onClick={() => security(bridge.id)}><SecurityLockIcon state={bridgeConnectionLock(bridge.connection).state} />Security log</button>
        <button className="btn-ghost min-h-11" onClick={() => routing(bridge.id)}>Model routing…</button>
      </div>
    </section>)}
  </dialog>;
}
