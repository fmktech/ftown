"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SecurityLockIcon, type SecurityLockState } from "./SecurityLockIcon";

export type AccessEdgeCertainty = "current" | "historical" | "none";
export type SecurityAccessSelection = { kind: "browser"; id: string } | { kind: "bridge"; id: string };
export interface SecurityAccessBrowserNode { id: string; label: string; customLabel?: boolean; current: boolean; accessText: string; lockState: SecurityLockState; edge: AccessEdgeCertainty }
export interface SecurityAccessBridgeNode { current?: boolean; id: string; label: string; accessText: string; connectionText: string; lockState: SecurityLockState; edge: AccessEdgeCertainty }
export interface SecurityAccessMapProps {
  scope?: "account" | "computer";
  browsers: readonly SecurityAccessBrowserNode[];
  bridges: readonly SecurityAccessBridgeNode[];
  account: { statusText: string; lockState: SecurityLockState };
  selected: SecurityAccessSelection | null;
  onSelect: (selection: SecurityAccessSelection) => void;
  toolbar?: ReactNode;
  selectedDetails?: ReactNode;
  renderBrowserName?: (node: SecurityAccessBrowserNode, label: string) => ReactNode;
}

/** Public identifiers distinguish generic labels; full fingerprints stay in details. */
export function accessBrowserLabel(node: SecurityAccessBrowserNode, nodes: readonly SecurityAccessBrowserNode[]): string {
  if (node.customLabel) return node.label;
  if (!/^(browser|this device|this browser)$/i.test(node.label.trim())) return node.label || "Browser";
  if (node.current) return "This browser";
  let length = Math.min(6, node.id.length);
  while (length < node.id.length && nodes.some(other => other.id !== node.id && other.id.slice(-length) === node.id.slice(-length))) length++;
  return `Browser · ${node.id.slice(-length)}`;
}

function DeviceIcon({ browser }: { browser: boolean }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="13" rx="2" />
    {browser ? <path d="M3 8h18M7 6h.01M10 6h.01" /> : <path d="M8 21h8M12 17v4" />}
  </svg>;
}

type Point = { x: number; y: number };
type Connector = { from: Point; to: Point };

/** Read-only access relationships. Selection never calls an approval action. */
export function SecurityAccessMap({ scope = "account", browsers, bridges, account, selected, onSelect, toolbar, selectedDetails, renderBrowserName }: SecurityAccessMapProps) {
  const root = useRef<HTMLDivElement>(null);
  const hub = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [connectors, setConnectors] = useState<Record<string, Connector>>({});
  const layoutKey = JSON.stringify([browsers.map(node => [node.id, node.label, node.accessText, node.edge]), bridges.map(node => [node.id, node.label, node.accessText, node.connectionText, node.edge]), account.statusText, selected]);
  useLayoutEffect(() => {
    const measure = () => {
      if (!root.current || !hub.current) return;
      const bounds = root.current.getBoundingClientRect(); const center = hub.current.getBoundingClientRect();
      const horizontal = window.matchMedia?.("(min-width: 640px)").matches ?? bounds.width >= 640;
      const next: Record<string, Connector> = {};
      for (const [key, element] of nodes.current) {
        const rect = element.getBoundingClientRect(); const browser = key.startsWith("browser:");
        next[key] = horizontal ? {
          from: { x: (browser ? rect.right : rect.left) - bounds.left, y: rect.top + rect.height / 2 - bounds.top },
          to: { x: (browser ? center.left : center.right) - bounds.left, y: center.top + center.height / 2 - bounds.top },
        } : {
          from: { x: rect.left + rect.width / 2 - bounds.left, y: (browser ? rect.bottom : rect.top) - bounds.top },
          to: { x: center.left + center.width / 2 - bounds.left, y: (browser ? center.top : center.bottom) - bounds.top },
        };
      }
      setConnectors(next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (root.current) observer?.observe(root.current);
    if (hub.current) observer?.observe(hub.current);
    for (const element of nodes.current.values()) { observer?.observe(element); if (element.parentElement) observer?.observe(element.parentElement); }
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [layoutKey]);
  const edges = [ ...browsers.map(node => ({ ...node, kind: "browser" as const })), ...bridges.map(node => ({ ...node, kind: "bridge" as const })) ];
  const cardClass = (current: boolean, active: boolean) => `relative z-10 min-w-0 rounded-md border bg-[var(--bg-base)] ${current ? "border-[var(--shell-claude)]" : "border-[var(--border-muted)]"} ${active ? "outline outline-1 outline-offset-2 outline-[var(--text-secondary)]" : ""}`;
  const buttonClass = (edge: AccessEdgeCertainty) => `relative flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-[var(--bg-hover)] ${edge === "current" ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`;
  const currentStyle = { background: "color-mix(in srgb, var(--shell-claude) 9%, var(--bg-base))" };
  return <section aria-label="Browser and computer access map" className="space-y-2">
    {toolbar}
    <p className="text-[10px] text-[var(--text-muted)]">{scope === "account" ? "Approved browsers → Account access → Shared computers." : "Approved browsers → Computer access → Selected computer. Approvals apply only to this computer."} Lines show access, not network connections.</p>
    <div ref={root} className="relative grid grid-cols-1 items-center gap-x-6 gap-y-3 sm:gap-y-6 sm:grid-cols-[minmax(0,1fr)_6.5rem_minmax(0,1fr)]">
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" fill="none">
        {edges.filter(node => node.edge !== "none").map(node => {
          const key = `${node.kind}:${node.id}`; const line = connectors[key];
          return <path key={key} data-access-edge={key} data-certainty={node.edge}
            d={line ? `M ${line.from.x} ${line.from.y} C ${line.from.x} ${line.to.y}, ${line.to.x} ${line.from.y}, ${line.to.x} ${line.to.y}` : "M 0 0"}
            stroke={node.edge === "current" ? "var(--accent)" : "var(--text-faint)"} strokeOpacity={node.edge === "current" ? 0.4 : 0.35} strokeWidth="1.5" strokeDasharray={node.edge === "historical" ? "4 4" : undefined} />;
        })}
      </svg>
      <div className="relative space-y-1">
        <h3 className="text-xs font-semibold">Browsers</h3>
        <ul aria-label={scope === "account" ? "Account devices" : "Approved devices"} className="grid grid-cols-3 gap-2 sm:grid-cols-1">
          {browsers.map(node => {
            const label = accessBrowserLabel(node, browsers); const active = selected?.kind === "browser" && selected.id === node.id;
            return <li key={node.id} data-access-card={`browser:${node.id}`} data-current-device={node.current ? "browser" : undefined} className={`${cardClass(node.current, active)} ${active && selectedDetails ? "col-span-full sm:col-span-1" : ""} ${renderBrowserName ? "has-[[data-browser-name-editing]]:col-span-full sm:has-[[data-browser-name-editing]]:col-span-1" : ""}`} style={node.current ? currentStyle : undefined}>
            {renderBrowserName ? <div ref={element => { if (element) nodes.current.set(`browser:${node.id}`, element); else nodes.current.delete(`browser:${node.id}`); }} className="relative flex min-w-0 flex-wrap items-start gap-1 rounded-md px-2 py-1">
              <div className="min-w-[4.5rem] flex-1">{renderBrowserName(node, label)}
                {node.current && label !== "This browser" && <span className="block text-[10px] text-[var(--shell-claude)]">This browser</span>}
                <span className="hidden break-words text-[10px] leading-4 text-[var(--text-muted)] sm:block">{node.accessText}</span></div>
              <button type="button" data-access-kind="browser" data-access-node={node.id} aria-pressed={active} aria-label={`Browser ${label}${node.current ? " (this browser)" : ""}: ${node.accessText}`}
                className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md px-1 text-left hover:bg-[var(--bg-hover)] sm:min-h-8 sm:min-w-8 ${node.edge === "current" ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`} onClick={() => onSelect({ kind: "browser", id: node.id })}>
                <span className="hidden shrink-0 sm:block"><DeviceIcon browser /></span>
                <SecurityLockIcon state={node.lockState} className={`shrink-0 ${node.edge === "current" ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}`} />
              </button>
            </div> : <button type="button" ref={element => { if (element) nodes.current.set(`browser:${node.id}`, element); else nodes.current.delete(`browser:${node.id}`); }}
              data-access-kind="browser" data-access-node={node.id} aria-pressed={active} aria-label={`Browser ${label}${node.current ? " (this browser)" : ""}: ${node.accessText}`}
              className={buttonClass(node.edge)} onClick={() => onSelect({ kind: "browser", id: node.id })}>
              <span className="hidden shrink-0 pt-0.5 sm:block"><DeviceIcon browser /></span><span className="min-w-0 flex-1"><span className="block break-words text-[10px] font-semibold sm:text-xs [overflow-wrap:anywhere]">{label}</span>
                {node.current && label !== "This browser" && <span className="block text-[10px] text-[var(--shell-claude)]">This browser</span>}
                <span className="mt-0.5 hidden text-[10px] leading-4 text-[var(--text-muted)] sm:block">{node.accessText}</span></span>
              <SecurityLockIcon state={node.lockState} className={`shrink-0 ${node.edge === "current" ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}`} />
            </button>}{active && selectedDetails && <div className="border-t border-[var(--border-subtle)] p-2">{selectedDetails}</div>}</li>;
          })}
        </ul>
      </div>
      <div ref={hub} className="relative z-10 mx-auto flex w-fit max-w-full items-center gap-2 rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-2 text-left sm:block sm:w-full sm:p-2 sm:text-center">
        <SecurityLockIcon state={account.lockState} className="shrink-0 text-[var(--text-muted)] sm:mx-auto sm:mb-1" />
        <h3 className="text-xs font-semibold">{scope === "account" ? "Account access" : "Computer access"}</h3><p className="text-[10px] leading-4 text-[var(--text-muted)] sm:mt-1">{account.statusText}</p>
      </div>
      <div className="relative space-y-1">
        <h3 className="text-xs font-semibold">Your computers</h3>
        {!bridges.length && <p className="text-xs text-[var(--text-muted)]">Start FTown on a computer to connect it to your account.</p>}
        <ul aria-label="Computer access" className="grid grid-cols-1 gap-2">
          {bridges.map(node => {
            const active = selected?.kind === "bridge" && selected.id === node.id;
            return <li key={node.id} data-access-card={`bridge:${node.id}`} data-current-device={node.current ? "bridge" : undefined} className={cardClass(!!node.current, active)} style={node.current ? currentStyle : undefined}><button type="button" ref={element => { if (element) nodes.current.set(`bridge:${node.id}`, element); else nodes.current.delete(`bridge:${node.id}`); }}
              data-access-kind="bridge" data-access-node={node.id} data-computer-access={node.id} aria-pressed={active} aria-label={`Computer ${node.label}${node.current ? " (this computer)" : ""}: ${node.accessText}. ${node.connectionText}`}
              className={buttonClass(node.edge)} onClick={() => onSelect({ kind: "bridge", id: node.id })}>
              <span className="shrink-0 pt-0.5"><DeviceIcon browser={false} /></span><span className="min-w-0 flex-1"><span className="block break-words text-xs font-semibold [overflow-wrap:anywhere]">{node.label}</span>
                {node.current && <span className="block text-[10px] text-[var(--shell-claude)]">This computer</span>}
                <span className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] leading-4 text-[var(--text-muted)] sm:block"><span>{node.accessText}</span><span className="text-[var(--text-faint)] sm:block">{node.connectionText}</span></span></span>
              <SecurityLockIcon state={node.lockState} className={`shrink-0 ${node.edge === "current" ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}`} />
            </button>{active && selectedDetails && <div className="border-t border-[var(--border-subtle)] p-2">{selectedDetails}</div>}</li>;
          })}
        </ul>
      </div>
    </div>
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--text-faint)]"><span>Solid: verified access now</span><span>Dashed: last verified, reconnect to check</span><span>No line: access not verified</span></p>
  </section>;
}
