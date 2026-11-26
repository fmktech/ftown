"use client";

import { useEffect, useRef } from "react";
import { bridgeLetter } from "./BridgeBadge";
import type { UpdateView } from "@/hooks/useBridgeUpdates";
import type { HostResources } from "@/lib/host-resources";

import type { BridgeSecurityState } from "@security/protocol";
import { bridgeConnectionLock, SecurityLockIcon } from "./SecurityLockIcon";

interface Computer {
  id: string;
  label: string;
  number?: number;
  online: boolean;
  update?: Pick<UpdateView, "status" | "lastKnownVersion">;
  connection?: BridgeSecurityState["status"];
  ready: boolean;
}

interface Props {
  computers: Computer[];
  resources: ReadonlyMap<string, HostResources>;
  create: (id: string) => void;
  instructions: (id: string) => void;
  updates: (id: string) => void;
  security: (id: string) => void;
  routing: (id: string) => void;
  close: () => void;
}

function ActionIcon({ action }: { action: "create" | "updates" | "routing" | "instructions" }) {
  const paths = {
    instructions: "M4 3h11l5 5v13H4z M14 3v6h6 M7 13h10 M7 17h7",
    create: "M4 4h16v16H4z M12 8v8 M8 12h8",
    updates: "M20 5v5h-5 M4 19v-5h5 M5 9a7.5 7.5 0 0 1 12-4l3 4 M4 15l3 4a7.5 7.5 0 0 0 12-4",
    routing: "M4 6h7 M15 6h5 M4 12h2 M10 12h10 M4 18h10 M18 18h2 M11 3v6 M7 9v6 M15 15v6",
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[action]} /></svg>;
}

export function BridgesDialog({ computers, resources, create, updates, security, routing, instructions, close }: Props) {
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
      const runningVersion = bridge.online ? bridge.update?.status?.currentVersion : undefined;
      const version = runningVersion ?? bridge.update?.lastKnownVersion;
      return <section key={bridge.id} data-bridge-row={bridge.id} aria-label={bridge.label} className="computer-card">
        <header><span className="bridge-index">{bridge.number ? bridgeLetter(bridge.number) : "—"}</span><strong title={bridge.label}>{bridge.label}</strong>
          <span className="computer-status" data-online={bridge.online}>{bridge.online ? "Online" : "Offline"}</span></header>
        <p className="computer-version">Bridge version <strong>{version ?? "Unknown"}</strong>{version && !runningVersion && " (last reported)"}</p>
        {sample ? <dl className="computer-load" title={`Sampled at ${new Date(sample.sampledAt).toLocaleTimeString()}`}>
          <div><dt>CPU</dt><dd>{sample.cpuPercent === null ? "—" : sample.cpuPercent + "%"}</dd>
            {sample.cpuPercent !== null && <meter aria-label="CPU usage" min={0} max={100} value={sample.cpuPercent} />}</div>
          <div><dt>RAM free</dt><dd>{gib(sample.freeRamBytes)}<small>of {gib(sample.totalRamBytes)} total</small></dd></div>
          <div><dt>Disk free</dt><dd>{sample.freeDiskBytes === null ? "—" : gib(sample.freeDiskBytes)}</dd></div>
          {sample.memoryPressure && <div className="computer-pressure"><dt>Memory pressure</dt><dd>{sample.memoryPressure}</dd></div>}
        </dl> : <p className="computer-load-empty">Load unavailable</p>}
        <div role="toolbar" aria-label={`Actions for ${bridge.label}`} className="computer-toolbar"
          onKeyDown={event => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled"));
            const current = buttons.indexOf(event.target as HTMLButtonElement);
            if (current < 0) return;
            event.preventDefault();
            buttons[(current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length].focus();
          }}>
          <button disabled={!bridge.ready} aria-label="Create session" title="Create session" onClick={() => create(bridge.id)}><ActionIcon action="create" /></button>
          <button disabled={!bridge.ready} aria-label="Edit agent instructions" title="Edit agent instructions" onClick={() => instructions(bridge.id)}><ActionIcon action="instructions" /></button>
          <button aria-label="Updates…" title="Check for updates" onClick={() => updates(bridge.id)}><ActionIcon action="updates" /></button>
          <button aria-label={`Security log for ${bridge.label}`} title={`Security log · ${lock.title}`} onClick={() => security(bridge.id)}><SecurityLockIcon state={lock.state} /></button>
          <button aria-label="Model routing…" title="Model routing" onClick={() => routing(bridge.id)}><ActionIcon action="routing" /></button>
        </div>
      </section>;
    })}</div>

  </dialog>;
}
