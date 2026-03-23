"use client";

import { useState, useCallback } from "react";
import { ConnectionStatus } from "@/hooks/useCentrifugo";

interface DiagnosticCheck {
  name: string;
  status: "pending" | "running" | "pass" | "fail" | "warn";
  detail?: string;
}

interface ConnectionDiagnosticsProps {
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  centrifugoUrl: string;
  token: string;
  onRetry: () => void;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function StatusIcon({ status }: { status: DiagnosticCheck["status"] }) {
  const map: Record<string, { symbol: string; color: string }> = {
    pending: { symbol: "○", color: "var(--text-faint)" },
    running: { symbol: "◌", color: "var(--accent)" },
    pass: { symbol: "✓", color: "var(--status-running)" },
    fail: { symbol: "✗", color: "var(--status-error)" },
    warn: { symbol: "!", color: "var(--status-pending)" },
  };
  const { symbol, color } = map[status] ?? map.pending;
  return (
    <span style={{ color, fontWeight: 700, fontFamily: "var(--font-mono)", width: 16, display: "inline-block", textAlign: "center" }}>
      {symbol}
    </span>
  );
}

export function ConnectionDiagnostics({ connectionStatus, connectionError, centrifugoUrl, token, onRetry }: ConnectionDiagnosticsProps) {
  const [checks, setChecks] = useState<DiagnosticCheck[]>([]);
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);

  const updateCheck = useCallback((index: number, update: Partial<DiagnosticCheck>) => {
    setChecks((prev) => prev.map((c, i) => (i === index ? { ...c, ...update } : c)));
  }, []);

  const runDiagnostics = useCallback(async () => {
    setRunning(true);
    setHasRun(true);

    const initial: DiagnosticCheck[] = [
      { name: "Token format", status: "pending" },
      { name: "Token expiry", status: "pending" },
      { name: "Token audience", status: "pending" },
      { name: "WebSocket reachable", status: "pending" },
      { name: "Centrifugo handshake", status: "pending" },
    ];
    setChecks(initial);

    // 1. Token format
    updateCheck(0, { status: "running" });
    const payload = decodeJwtPayload(token);
    if (!payload) {
      updateCheck(0, { status: "fail", detail: "Token is not a valid JWT" });
      setRunning(false);
      return;
    }
    updateCheck(0, { status: "pass", detail: `sub: ${payload.sub as string}` });

    // 2. Token expiry
    updateCheck(1, { status: "running" });
    const exp = payload.exp as number | undefined;
    if (!exp) {
      updateCheck(1, { status: "warn", detail: "No exp claim found" });
    } else {
      const now = Math.floor(Date.now() / 1000);
      const remaining = exp - now;
      if (remaining <= 0) {
        updateCheck(1, { status: "fail", detail: `Expired ${Math.abs(Math.floor(remaining / 60))} min ago — reload the page` });
      } else if (remaining < 3600) {
        updateCheck(1, { status: "warn", detail: `Expires in ${Math.floor(remaining / 60)} min` });
      } else {
        updateCheck(1, { status: "pass", detail: `Expires in ${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m` });
      }
    }

    // 3. Token audience
    updateCheck(2, { status: "running" });
    const aud = payload.aud as string | string[] | undefined;
    if (!aud) {
      updateCheck(2, { status: "fail", detail: "Missing aud claim — token was generated before the security update. Reload the page." });
    } else {
      const audStr = Array.isArray(aud) ? aud.join(", ") : aud;
      if (audStr.includes("ftown:centrifugo")) {
        updateCheck(2, { status: "pass", detail: `aud: ${audStr}` });
      } else {
        updateCheck(2, { status: "fail", detail: `Wrong audience: ${audStr} (expected ftown:centrifugo)` });
      }
    }

    // 4. Raw WebSocket connectivity
    updateCheck(3, { status: "running" });
    try {
      const wsResult = await new Promise<{ connected: boolean; code?: number; reason?: string }>((resolve) => {
        const timeout = setTimeout(() => resolve({ connected: false, reason: "Timeout (5s)" }), 5000);
        const ws = new WebSocket(centrifugoUrl);
        ws.onopen = () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ connected: true });
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          resolve({ connected: false, reason: "WebSocket error — check network/firewall" });
        };
        ws.onclose = (e) => {
          clearTimeout(timeout);
          if (e.code === 1005 || e.code === 1000) {
            resolve({ connected: true });
          } else {
            resolve({ connected: false, code: e.code, reason: e.reason || `Close code ${e.code}` });
          }
        };
      });

      if (wsResult.connected) {
        updateCheck(3, { status: "pass", detail: "WebSocket connection established" });
      } else {
        updateCheck(3, { status: "fail", detail: wsResult.reason ?? "Connection failed" });
      }
    } catch (err) {
      updateCheck(3, { status: "fail", detail: `Exception: ${err instanceof Error ? err.message : String(err)}` });
    }

    // 5. Centrifugo protocol handshake
    updateCheck(4, { status: "running" });
    try {
      const handshakeResult = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        const timeout = setTimeout(() => resolve({ ok: false, detail: "Timeout (8s)" }), 8000);
        const ws = new WebSocket(centrifugoUrl);
        let gotResponse = false;

        ws.onopen = () => {
          // Send Centrifugo connect command
          ws.send(JSON.stringify({ id: 1, connect: { token, name: "diagnostics" } }));
        };
        ws.onmessage = (e) => {
          gotResponse = true;
          clearTimeout(timeout);
          try {
            const data = JSON.parse(e.data as string) as Record<string, unknown>;
            if (data.error) {
              const err = data.error as { code?: number; message?: string };
              resolve({ ok: false, detail: `Server rejected: ${err.message ?? "unknown"} (code ${err.code ?? "?"})` });
            } else if (data.connect) {
              resolve({ ok: true, detail: "Authenticated successfully" });
            } else {
              resolve({ ok: false, detail: `Unexpected response: ${JSON.stringify(data).slice(0, 120)}` });
            }
          } catch {
            resolve({ ok: false, detail: `Invalid JSON response: ${(e.data as string).slice(0, 80)}` });
          }
          ws.close();
        };
        ws.onerror = () => {
          if (!gotResponse) {
            clearTimeout(timeout);
            resolve({ ok: false, detail: "WebSocket error before handshake" });
          }
        };
        ws.onclose = (e) => {
          if (!gotResponse) {
            clearTimeout(timeout);
            resolve({ ok: false, detail: `Connection closed before response (code ${e.code})` });
          }
        };
      });

      updateCheck(4, { status: handshakeResult.ok ? "pass" : "fail", detail: handshakeResult.detail });
    } catch (err) {
      updateCheck(4, { status: "fail", detail: `Exception: ${err instanceof Error ? err.message : String(err)}` });
    }

    setRunning(false);
  }, [token, centrifugoUrl, updateCheck]);

  if (connectionStatus === "connected") return null;
  if (connectionStatus === "connecting" && !hasRun) return null;

  const hasFail = checks.some((c) => c.status === "fail");
  const allPass = checks.length > 0 && checks.every((c) => c.status === "pass");

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.75)",
        zIndex: 100,
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-muted)",
          borderRadius: 8,
          padding: "24px 28px",
          maxWidth: 480,
          width: "90%",
          fontFamily: "var(--font-mono)",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          Connection Failed
        </div>
        {connectionError && (
          <div style={{ fontSize: 11, color: "var(--status-error)", marginBottom: 12, lineHeight: 1.5 }}>
            {connectionError}
          </div>
        )}
        {!connectionError && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>
            Status: {connectionStatus}
          </div>
        )}

        {checks.length > 0 && (
          <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 6 }}>
            {checks.map((check, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <StatusIcon status={check.status} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "var(--text-primary)", fontWeight: 600 }}>{check.name}</div>
                  {check.detail && (
                    <div
                      style={{
                        fontSize: 10,
                        color: check.status === "fail" ? "var(--status-error)" : check.status === "warn" ? "var(--status-pending)" : "var(--text-muted)",
                        lineHeight: 1.4,
                        wordBreak: "break-word",
                      }}
                    >
                      {check.detail}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {hasFail && (
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5, background: "var(--bg-void)", borderRadius: 4, padding: "8px 10px" }}>
            {checks.some((c) => c.name === "Token audience" && c.status === "fail")
              ? "Your token is missing the required audience claim. This usually means the page was cached. Try: reload page, or log out and back in."
              : checks.some((c) => c.name === "Token expiry" && c.status === "fail")
                ? "Your token has expired. Reload the page to get a fresh token."
                : checks.some((c) => c.name === "WebSocket reachable" && c.status === "fail")
                  ? "Cannot reach the WebSocket server. Check your network connection, VPN, or firewall settings."
                  : checks.some((c) => c.name === "Centrifugo handshake" && c.status === "fail")
                    ? "WebSocket connects but the server rejected authentication. Try reloading the page for a fresh token."
                    : "Check the details above for more information."}
          </div>
        )}

        {allPass && (
          <div style={{ fontSize: 10, color: "var(--status-running)", marginBottom: 12, lineHeight: 1.5, background: "var(--bg-void)", borderRadius: 4, padding: "8px 10px" }}>
            All checks passed. The connection may have been temporarily interrupted. Click Retry to reconnect.
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn-accent"
            onClick={runDiagnostics}
            disabled={running}
            style={{ flex: 1 }}
          >
            {running ? "Running..." : hasRun ? "Re-run Diagnostics" : "Run Diagnostics"}
          </button>
          <button
            className="btn-ghost"
            onClick={onRetry}
            style={{ flex: 1 }}
          >
            Reload Page
          </button>
        </div>
      </div>
    </div>
  );
}
