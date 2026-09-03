"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { DashboardClient } from "@/components/DashboardClient";
import { KeyEntry } from "@/components/local/KeyEntry";
import { StartingState } from "@/components/local/StartingState";
import {
  SoloAuthError,
  bootstrap,
  captureKeyFromHash,
  clearKey,
  getHealth,
  getStoredKey,
  mintToken,
  storeKey,
} from "@/lib/solo-client";

/**
 * Solo first-run experience (bridge contract: ui/src/app/local/page.tsx).
 *
 *   mount → consume #k= fragment (or stored key) → GET /api/solo/bootstrap
 *     ├─ no key            → KeyEntry (inline 401 validation)
 *     ├─ key accepted      → DashboardClient wired to solo token refresh
 *     └─ children booting  → StartingState polling /healthz every 2s
 */

type Phase = "connecting" | "needs-key" | "starting" | "ready";

interface BootstrapInfo {
  userId: string;
  centrifugoUrl: string;
  token: string;
}

const HEALTH_POLL_INTERVAL_MS = 2000;

export default function LocalPage() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [boot, setBoot] = useState<BootstrapInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [startDetail, setStartDetail] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);

  const runBootstrap = useCallback(async (key: string): Promise<void> => {
    try {
      const result = await bootstrap(key);
      setBoot(result);
      setStartDetail(null);
      setPhase("ready");
    } catch (err) {
      if (err instanceof SoloAuthError) {
        // Rejected cached or mistyped key: forget it and re-prompt.
        clearKey();
        keyRef.current = null;
        setKeyError("That key was rejected. Copy it again from the ftown-bridge --solo banner.");
        setPhase("needs-key");
      } else {
        // Network failure or 502 — the hub/panel children may still be
        // booting; let the healthz poller drive the retry.
        setPhase("starting");
      }
    }
  }, []);

  useEffect(() => {
    const captured = captureKeyFromHash();
    const key = captured ?? getStoredKey();
    if (!key) {
      setPhase("needs-key");
      return;
    }
    keyRef.current = key;
    void runBootstrap(key);
  }, [runBootstrap]);

  const handleSubmit = useCallback(
    (key: string) => {
      storeKey(key);
      keyRef.current = key;
      setSubmitting(true);
      setKeyError(null);
      void runBootstrap(key).finally(() => setSubmitting(false));
    },
    [runBootstrap]
  );

  useEffect(() => {
    if (phase !== "starting") return undefined;
    let disposed = false;
    let triggered = false;

    const tick = async (): Promise<void> => {
      try {
        const health = await getHealth();
        if (disposed || triggered) return;
        if (health.hub === "down") {
          setStartDetail("Waiting for the realtime hub…");
          return;
        }
        if (health.panel === "down") {
          setStartDetail("Waiting for the web panel…");
          return;
        }
        triggered = true;
        const key = keyRef.current;
        if (!key) {
          setPhase("needs-key");
          return;
        }
        await runBootstrap(key);
      } catch {
        if (!disposed && !triggered) setStartDetail("Reaching ftown Solo…");
      }
    };

    void tick();
    const interval = window.setInterval(() => void tick(), HEALTH_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [phase, runBootstrap]);

  const refreshHubToken = useCallback((): Promise<string> => {
    const key = keyRef.current;
    if (!key) return Promise.reject(new Error("Solo access key is not available."));
    return mintToken(key).then((minted) => minted.token);
  }, []);

  const handleUnauthorized = useCallback(() => {
    // The bridge rejected the stored key mid-session: wipe it and fall back
    // to the entry form. Unmounting DashboardClient disconnects the socket.
    clearKey();
    keyRef.current = null;
    setBoot(null);
    setKeyError("Your access key stopped working. Enter it again to reconnect.");
    setPhase("needs-key");
  }, []);

  return (
    <main className="min-h-dvh flex items-center justify-center bg-[var(--bg-base)] px-4 py-8">
      {phase === "connecting" && (
        <p className="text-sm text-[var(--text-faint)] font-[family-name:var(--font-mono)]" role="status">
          Connecting to ftown Solo…
        </p>
      )}
      {phase === "needs-key" && (
        <KeyEntry onSubmit={handleSubmit} submitting={submitting} error={keyError} />
      )}
      {phase === "starting" && <StartingState detail={startDetail} />}
      {phase === "ready" && boot && (
        <DashboardClient
          userId={boot.userId}
          token={boot.token}
          centrifugoUrl={boot.centrifugoUrl}
          tokenRefresher={refreshHubToken}
          onUnauthorized={handleUnauthorized}
        />
      )}
    </main>
  );
}
