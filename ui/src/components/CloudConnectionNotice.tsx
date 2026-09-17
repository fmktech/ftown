"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ConnectionStatus } from "@/hooks/useCentrifugo";
import { ConnectionDiagnostics } from "./ConnectionDiagnostics";
import { diagnosticEndpoint, getConnectionHistory, probeWebSocket, probeWebsite, recordConnectionEvent } from "@/lib/connection-history";

interface Props {
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  centrifugoUrl: string;
  token: string;
  onRetry: () => void;
  directBridgeCount?: number;
  children?: ReactNode;
}

/** Diagnostics are opt-in UI; passive recording survives cloud recovery. */
export function CloudConnectionNotice(props: Props) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, refresh] = useState(0);
  const activeProbe = useRef<AbortController | null>(null);
  const lastProbe = useRef(-Infinity);
  const outage = useRef<number | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connected = props.connectionStatus === "connected";
  const open = hover || pinned;

  const runChecks = useCallback(async () => {
    if (activeProbe.current) return;
    const controller = new AbortController();
    activeProbe.current = controller;
    lastProbe.current = Date.now();
    setBusy(true);
    const startedAt = new Date().toISOString();
    const [socket, website] = await Promise.all([
      probeWebSocket(props.centrifugoUrl, controller.signal),
      probeWebsite(controller.signal),
    ]);
    if (!controller.signal.aborted) {
      recordConnectionEvent("WebSocket probe", { startedAt, ...socket });
      recordConnectionEvent("website probe", { startedAt, ...website });
      setBusy(false);
      refresh((n) => n + 1);
    }
    if (activeProbe.current === controller) activeProbe.current = null;
  }, [props.centrifugoUrl]);

  useEffect(() => () => {
    activeProbe.current?.abort();
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, [props.centrifugoUrl]);
  useEffect(() => {
    recordConnectionEvent("dashboard state", {
      cloud: props.connectionStatus, directBridges: props.directBridgeCount ?? 0,
      browserOnline: navigator.onLine, visibility: document.visibilityState,
    });
  }, [props.connectionStatus, props.directBridgeCount]);
  useEffect(() => {
    if (connected) {
      if (outage.current !== null) {
        recordConnectionEvent("cloud recovered", { outageMs: Date.now() - outage.current });
        outage.current = null;
      }
      return;
    }
    if (outage.current === null) {
      outage.current = Date.now();
      recordConnectionEvent("cloud unavailable");
    }
    // Sample during an outage without a reconnect storm creating probe storms.
    const sample = () => { if (Date.now() - lastProbe.current >= 30_000) void runChecks(); };
    sample();
    const interval = setInterval(sample, 30_000);
    return () => clearInterval(interval);
  }, [connected, runChecks]);
  useEffect(() => {
    const online = () => recordConnectionEvent("browser online");
    const offline = () => recordConnectionEvent("browser offline");
    const visibility = () => recordConnectionEvent("visibility", { state: document.visibilityState });
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => refresh((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [open]);

  const download = () => {
    const report = {
      capturedAt: new Date().toISOString(), endpoint: diagnosticEndpoint(props.centrifugoUrl),
      cloud: props.connectionStatus, directBridges: props.directBridgeCount ?? 0,
      browserOnline: navigator.onLine, visibility: document.visibilityState,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      note: "Browser WebSocket failures cannot distinguish DNS, TCP, TLS, proxy, or ISP causes. Website checks may be served by a service worker. History is limited to this tab lifetime (100 events).",
      events: getConnectionHistory(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `ftown-connection-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div onMouseEnter={() => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      setHover(true);
    }} onMouseLeave={() => { hoverTimer.current = setTimeout(() => setHover(false), 180); }}
      onFocus={() => setHover(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHover(false); }}
      onKeyDown={(event) => { if (event.key === "Escape") { setPinned(false); setHover(false); } }}>
      <button type="button" className="flex items-center gap-1.5" aria-label="Connection status and diagnostics"
        aria-expanded={open} onClick={() => { setPinned(!pinned); setHover(false); }}>
        {props.children ?? (connected ? "Cloud connected" : "Cloud reconnecting")}
      </button>
      {open && <div role="region" aria-label="Connection diagnostics" style={{ position: "fixed", top: 52, right: 12, zIndex: 100, width: "min(440px, calc(100vw - 24px))", maxHeight: "70vh", overflowY: "auto", padding: 16, borderRadius: 8, background: "var(--bg-surface)", border: "1px solid var(--border-muted)", fontSize: 12 }}>
        <p>{connected ? "Cloud connected. Recent outage history is available below." : "Cloud disconnected — reconnecting automatically. Reachable Local/P2P terminals remain available; cloud controls resume after reconnecting."}</p>
        <p style={{ overflowWrap: "anywhere" }}>Endpoint: {diagnosticEndpoint(props.centrifugoUrl)}</p>
        <p>Browser: {navigator.onLine ? "online" : "offline"} · Direct bridges: {props.directBridgeCount ?? 0}</p>
        <div className="flex flex-wrap gap-2" style={{ margin: "8px 0" }}>
          <button className="btn-ghost" disabled={busy} onClick={() => void runChecks()}>{busy ? "Checking…" : "Run network checks"}</button>
          <button className="btn-ghost" onClick={download}>Download report</button>
          <button className="btn-ghost" onClick={() => { setDetails(true); setPinned(false); setHover(false); }}>Authentication checks</button>
          <button className="btn-ghost" onClick={() => { setPinned(false); setHover(false); }}>Close</button>
        </div>
        <p>Times below are UTC. WebSocket failure alone cannot identify an ISP problem.</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11 }}>{getConnectionHistory().slice(-20).map((entry) => `${entry.at} ${entry.event} ${JSON.stringify(entry.details)}`).join("\n")}</pre>
      </div>}
      {details && <ConnectionDiagnostics {...props} onDismiss={() => setDetails(false)} />}
    </div>
  );
}
