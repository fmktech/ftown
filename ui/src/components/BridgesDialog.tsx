"use client";

import { useEffect, useRef } from "react";
import type { HostResources } from "@/lib/host-resources";

import type { BridgeSecurityState } from "@security/protocol";
import { bridgeConnectionLock, SecurityLockIcon } from "./SecurityLockIcon";

interface Computer {
  id: string;
  label: string;
  number?: number;
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
  const gib = (bytes: number) => (bytes / 2 ** 30).toLocaleString(undefined, { maximumFractionDigits: 1 }) + " GiB";
  return <dialog ref={ref} aria-label="Bridges" onCancel={event => { event.preventDefault(); close(); }} className="computers-dialog">
    <header className="computers-heading"><div><h2>Computers</h2><p>{computers.filter(b => b.online).length} online · {computers.length} total</p></div>
      <button className="btn-ghost min-h-11 min-w-11" aria-label="Close bridges" onClick={close}>×</button></header>
    {!computers.length && <p className="p-5">No known bridges.</p>}
    <div className="computers-list">{computers.map(bridge => {
      const sample = bridge.online ? resources.get(bridge.id) : undefined;
      const lock = bridgeConnectionLock(bridge.connection);
      return <section key={bridge.id} data-bridge-row={bridge.id} aria-label={bridge.label} className="computer-card">
        <header><span className="bridge-index">#{bridge.number ?? "—"}</span><strong title={bridge.label}>{bridge.label}</strong>
          <span className="computer-status" data-online={bridge.online}>{bridge.online ? "Online" : "Offline"}</span></header>
        {sample ? <dl className="computer-load" title={`Sampled at ${new Date(sample.sampledAt).toLocaleTimeString()}`}>
          <div><dt>CPU</dt><dd>{sample.cpuPercent === null ? "—" : sample.cpuPercent + "%"}</dd>
            {sample.cpuPercent !== null && <meter aria-label="CPU usage" min={0} max={100} value={sample.cpuPercent} />}</div>
          <div><dt>RAM free</dt><dd title={gib(sample.totalRamBytes) + " total"}>{gib(sample.freeRamBytes)}</dd>
            {sample.totalRamBytes > 0 && <meter aria-label="RAM usage" min={0} max={sample.totalRamBytes} value={sample.totalRamBytes - sample.freeRamBytes} />}</div>
          <div><dt>Disk free</dt><dd>{sample.freeDiskBytes === null ? "—" : gib(sample.freeDiskBytes)}</dd></div>
        </dl> : <p className="computer-load-empty">Load unavailable</p>}
        <div className="computer-primary"><button disabled={!bridge.ready} aria-pressed={selected === bridge.id} onClick={() => onSelect(bridge.id)}>{selected === bridge.id ? "Selected computer" : "Use computer"}</button>
          <button disabled={!bridge.ready} onClick={() => create(bridge.id)}>Create session</button></div>
        <footer><button onClick={() => updates(bridge.id)}>Updates…</button>
          <button aria-label={`Security log for ${bridge.label}`} title={lock.title} onClick={() => security(bridge.id)}><SecurityLockIcon state={lock.state} />Security log</button>
          <button onClick={() => routing(bridge.id)}>Model routing…</button></footer>
      </section>;
    })}</div>
  </dialog>;
}
