"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dashboard } from './Dashboard';
import { HybridTerminalTransport } from '@/lib/direct-transport/hybrid-terminal-transport';
import { LocalAccessError, LocalBrowserClient, bootstrapLocal, forgetDevice, localOrigin,
  localRequest, readDevice, rememberDevice, type LocalDevice, type Pairing } from '@/lib/local-browser-client';

type Runtime = { client: LocalBrowserClient; transport: HybridTerminalTransport; device: LocalDevice };

export function LocalDashboard() {
  const [port, setPort] = useState('');
  const [remember, setRemember] = useState(true);
  const [pending, setPending] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [connected, setConnected] = useState(true);
  const active = useRef<Runtime | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const cached = useRef<LocalDevice | null>(null);

  const disconnect = useCallback(() => {
    attempt.current?.abort();
    if (cached.current) forgetDevice(cached.current.port);
    cached.current = null;
    active.current?.transport.dispose(); active.current?.client.close(); active.current = null;
    setRuntime(null); setPending(null); setBusy(false);
  }, []);

  const connect = useCallback(async (device: LocalDevice, signal: AbortSignal, save?: boolean): Promise<void> => {
    const boot = await bootstrapLocal(device, signal);
    if (signal.aborted) return;
    const verified = { ...device, bridgeId: boot.bridgeId };
    if (save !== undefined) rememberDevice(verified, save);
    cached.current = verified;
    const client = new LocalBrowserClient(verified, boot, (ok, message) => {
      setConnected(ok); setError(message ?? null);
    }, () => { disconnect(); setError('Local access was revoked or expired. Run ftown-bridge pair to approve this browser again.'); }, () => {
      // A restarted bridge may change its terminal port or cloud identity.
      // Rebuild subscriptions and transport using authenticated bootstrap only.
      active.current?.transport.dispose(); active.current = null; setRuntime(null);
      setBusy(true);
      const controller = new AbortController(); attempt.current = controller;
      void connect(verified, controller.signal).catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Local reconnect failed');
      }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    });
    const transport = new HybridTerminalTransport({
      centrifuge: client, userId: boot.userId, clientId: crypto.randomUUID(), localOnly: true,
      publishCommand: () => {},
      getLocalAdvert: async (id) => id === boot.bridgeId ? { localPort: boot.localPort, localNonce: boot.localNonce } : null,
      upgradeBackoffMs: [2000, 5000, 10000],
    });
    active.current?.transport.dispose(); active.current?.client.close();
    active.current = { client, transport, device: verified };
    setConnected(true); setRuntime(active.current); setPending(null); setError(null);
    client.start();
  }, [disconnect]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('port');
    let requestedPort: number | null = null;
    if (requested) {
      try { localOrigin(requested); requestedPort = Number(requested); setPort(requested); }
      catch { setError('Invalid local port in this link.'); }
    }
    const stored = readDevice();
    const device = stored && (requestedPort === null || requestedPort === stored.port) ? stored : null;
    cached.current = device;
    if (device) {
      setPort(String(device.port)); setBusy(true);
      const controller = new AbortController(); attempt.current = controller;
      void connect(device, controller.signal).catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof LocalAccessError && (err.status === 401 || err.status === 403)) {
          forgetDevice(device.port); cached.current = null;
        }
        setError(err instanceof Error ? err.message : 'Unable to reach this computer.');
      }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }
    return () => { attempt.current?.abort(); active.current?.transport.dispose(); active.current?.client.close(); active.current = null; };
  }, [connect]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    attempt.current?.abort();
    const controller = new AbortController(); attempt.current = controller;
    setError(null); setBusy(true); setPending(null);
    try {
      localOrigin(port);
      const saved = cached.current;
      if (saved?.port === Number(port)) {
        await connect(saved, controller.signal);
        return;
      }
      const pair = await localRequest<Pairing>(Number(port), '/api/browser/pairings', undefined, { remember }, controller.signal);
      if (controller.signal.aborted) return;
      setPending(pair);
      while (!controller.signal.aborted && Date.now() < Date.parse(pair.expiresAt)) {
        const decision = await localRequest<{ status: string; credential?: string }>(Number(port),
          `/api/browser/pairings/${encodeURIComponent(pair.id)}`, pair.pollToken, undefined, controller.signal);
        if (decision.status === 'denied') throw new Error('Request declined in the bridge terminal.');
        if (decision.status === 'approved' && decision.credential) {
          await connect({ port: Number(port), bridgeId: '', credential: decision.credential }, controller.signal, remember);
          return;
        }
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, 1000); controller.signal.addEventListener('abort', finish, { once: true });
        });
      }
      if (!controller.signal.aborted) throw new Error('Approval expired. Run ftown-bridge pair again.');
    } catch (err) {
      if (!controller.signal.aborted) {
        if (err instanceof LocalAccessError && (err.status === 401 || err.status === 403) && cached.current) {
          forgetDevice(cached.current.port); cached.current = null;
        }
        setError(err instanceof Error ? err.message : 'Unable to connect locally.');
        setPending(null);
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  if (runtime) return <Dashboard client={runtime.client} connectionStatus={connected ? 'connected' : 'connecting'}
    connectionError={error} userId={runtime.client.boot.userId} token={""} centrifugoUrl={""}
    transport={runtime.transport} onDisconnect={disconnect} localMode />;

  return <main className="min-h-dvh flex items-center justify-center p-4 bg-[var(--bg-base)]">
    <section className="w-full max-w-md p-6 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] space-y-5">
      <h1 className="text-xl font-bold">This computer</h1>
      <p className="text-sm text-[var(--text-secondary)]">Connect directly to your local bridge. No cloud account needed.</p>
      <p className="text-sm">Run <code>ftown-bridge pair</code> in a terminal, then enter the port it prints.</p>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm">Local port
          <input className="block w-full mt-2 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] p-2"
            inputMode="numeric" pattern="[0-9]{1,5}" required value={port} disabled={busy}
            onChange={(event) => setPort(event.target.value)} placeholder="e.g. 43127" />
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={remember} disabled={busy}
          onChange={(event) => setRemember(event.target.checked)} />Remember this browser</label>
        <p className="text-xs text-[var(--text-muted)]">Unchecked: access lasts for this bridge process and browser tab.</p>
        {pending && <div role="status" className="p-4 border rounded border-[var(--accent)] space-y-2">
          <p>Match this code in your terminal:</p><p className="text-3xl tracking-widest font-mono">{pending.code}</p>
          <p className="text-sm">Approve there to grant terminal and session control. Waiting for local approval…</p>
        </div>}
        {error && <p role="alert" className="text-sm text-[var(--status-error)]">{error}</p>}
        <button className="btn-accent w-full" disabled={busy}>{busy ? 'Connecting…' : 'Connect locally'}</button>
      </form>
      {(busy || cached.current) && <button className="btn-ghost" onClick={disconnect}>{busy ? 'Cancel' : 'Forget saved access'}</button>}
      <a href="/login" className="block text-sm text-[var(--accent)]">Use Cloud instead</a>
    </section>
  </main>;
}
