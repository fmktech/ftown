"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dashboard } from "./Dashboard";
import { HybridTerminalTransport } from "@/lib/direct-transport/hybrid-terminal-transport";
import { LocalBrowserClient, bootstrapLocal, forgetDevice, localOrigin, localRequest, readDevice, rememberDevice, type LocalDevice } from "@/lib/local-browser-client";
import { loadBrowserIdentity, readPinnedBridges } from "@/lib/browser-identity";
import { SecureEndpointRuntime } from "@/lib/secure-endpoint-runtime";
import { securityErrorMessage } from "./SecurityPanel";

type Runtime = { client: LocalBrowserClient; transport: HybridTerminalTransport; security: SecureEndpointRuntime; device: LocalDevice };
export function LocalDashboard() {
  const [port, setPort] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [connected, setConnected] = useState(true);
  const active = useRef<Runtime | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const disconnect = useCallback(() => {
    attempt.current?.abort();
    if (active.current) { active.current.transport.dispose(); active.current.client.close(); active.current.security.dispose(); }
    active.current = null; setRuntime(null); setBusy(false);
  }, []);
  const connect = useCallback(async (device: LocalDevice, signal: AbortSignal, save = true) => {
    const boot = await bootstrapLocal(device, signal);
    const [identity, pins] = await Promise.all([loadBrowserIdentity(boot.ownerId), readPinnedBridges(boot.ownerId)]);
    if (signal.aborted) return;
    const security = new SecureEndpointRuntime(identity, pins);
    security.discover(boot.bridgeId, boot.endpoint);
    try {
      const channel = `local-http:${boot.bridgeId}`;
      await security.handshake(boot.bridgeId, channel, async packet => {
        const response = await localRequest(device.port, "/api/security/envelope", undefined, packet, signal);
        await security.receive(response, channel);
      });
      if (signal.aborted) { security.dispose(); return; }
      const verified = { port: device.port, bridgeId: boot.bridgeId };
      rememberDevice(verified, save);
      const client = new LocalBrowserClient(verified, boot, (ok, message) => { setConnected(ok); setError(message ?? null); },
        () => { disconnect(); setError("Access was revoked or the bridge key changed. Open a fresh verified invitation."); }, undefined, security);
      const transport = new HybridTerminalTransport({ centrifuge: client, userId: boot.userId, clientId: crypto.randomUUID(), localOnly: true,
        securityRuntime: security, publishCommand: () => {}, getLocalAdvert: async id => id === boot.bridgeId ? { localPort: boot.localPort } : null,
        upgradeBackoffMs: [2000, 5000, 10000] });
      active.current?.transport.dispose(); active.current?.client.close(); active.current?.security.dispose();
      active.current = { client, transport, security, device: verified };
      setConnected(true); setRuntime(active.current); setError(null); client.start();
    } catch (failure) { security.dispose(); throw failure; }
  }, [disconnect]);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("port");
    const stored = readDevice();
    let device = stored;
    if (requested) try { localOrigin(requested); setPort(requested); device = stored?.port === Number(requested) ? stored : { port: Number(requested), bridgeId: "" }; }
    catch { setError("Invalid local bridge port."); }
    if (device) {
      setPort(String(device.port)); setBusy(true);
      const controller = new AbortController(); attempt.current = controller;
      void connect(device, controller.signal).catch(failure => { if (!controller.signal.aborted) setError(securityErrorMessage(failure)); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }
    return () => { attempt.current?.abort(); active.current?.transport.dispose(); active.current?.client.close(); active.current?.security.dispose(); active.current = null; };
  }, [connect]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); attempt.current?.abort(); setBusy(true); setError(null);
    const controller = new AbortController(); attempt.current = controller;
    try { localOrigin(port); await connect({ port: Number(port), bridgeId: "" }, controller.signal, remember); }
    catch (failure) { if (!controller.signal.aborted) setError(securityErrorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  if (runtime) return <Dashboard client={runtime.client} connectionStatus={connected ? "connected" : "connecting"} connectionError={error}
    userId={runtime.client.boot.userId} token={""} centrifugoUrl={""} transport={runtime.transport} onDisconnect={disconnect} localMode />;
  return <main className="flex min-h-dvh items-center justify-center bg-[var(--bg-base)] p-4"><section className="w-full max-w-md space-y-5 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-6">
    <h1 className="text-xl font-semibold">This computer</h1>
    <p className="text-sm text-[var(--text-muted)]">Connect directly with this browser's approved encryption identity. For first approval, run <code>ftown security invite</code> on the bridge and open its private invitation.</p>
    <form onSubmit={event => void submit(event)} className="space-y-4">
      <label className="flex flex-col gap-1 text-sm">Local bridge port<input inputMode="numeric" pattern="[0-9]{1,5}" required value={port} disabled={busy} onChange={event => setPort(event.target.value)} className="min-h-11 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] px-3" /></label>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />Remember this bridge's port</label>
      {error && <p role="alert" className="text-sm text-[var(--status-error)]">{error}</p>}
      <button className="btn-accent min-h-11 w-full" disabled={busy}>{busy ? "Connecting securely…" : "Connect locally"}</button>
    </form>
    {busy && <button className="btn-ghost min-h-11" onClick={disconnect}>Cancel</button>}
    <button className="btn-ghost min-h-11" onClick={() => { const saved = readDevice(); if (saved) forgetDevice(saved.port); setPort(""); }}>Forget saved bridge port</button>
    <p className="text-xs text-[var(--text-faint)]">Encrypted controls require HTTPS or trustworthy localhost. Clearing browser key storage requires fresh approval; there is no plaintext fallback.</p>
    <a href="/login" className="inline-flex min-h-11 items-center text-sm text-[var(--accent)]">Use Cloud instead</a>
  </section></main>;
}
