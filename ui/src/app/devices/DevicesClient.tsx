"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Device {
  bridgeId: string;
  hostname: string | null;
  lastSeen: string | null;
  revoked: boolean;
}

interface DevicesResponse {
  devices: Device[];
}

interface RevokeResponse {
  ok: true;
}

interface ErrorResponse {
  error: string;
}

function formatRelativeTime(ts: string | null): string {
  if (!ts) return "never";
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "never";
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "never";
  }
}

function shortBridgeId(bridgeId: string): string {
  return bridgeId.length > 12 ? `${bridgeId.slice(0, 12)}…` : bridgeId;
}

export function DevicesClient() {
  const router = useRouter();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/bridges/devices", {
        method: "GET",
        credentials: "include",
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        const data = (await response.json()) as ErrorResponse;
        throw new Error(data.error || "Failed to load devices");
      }

      const data = (await response.json()) as DevicesResponse;
      setDevices(data.devices);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [router]);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const handleRevoke = useCallback(
    async (device: Device) => {
      const label = device.hostname || shortBridgeId(device.bridgeId);
      const confirmed = window.confirm(
        `Revoke ${label}? Its bridge will disconnect and cannot reconnect until re-paired.`
      );
      if (!confirmed) return;

      setRevokingId(device.bridgeId);
      setError(null);

      try {
        const response = await fetch("/api/bridges/devices/revoke", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bridgeId: device.bridgeId }),
        });

        if (response.status === 401) {
          router.push("/login");
          return;
        }

        if (!response.ok) {
          const data = (await response.json()) as ErrorResponse;
          throw new Error(data.error || "Failed to revoke device");
        }

        (await response.json()) as RevokeResponse;

        setDevices((prev) =>
          prev
            ? prev.map((d) => (d.bridgeId === device.bridgeId ? { ...d, revoked: true } : d))
            : prev
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setRevokingId(null);
      }
    },
    [router]
  );

  return (
    <div className="min-h-screen p-4 sm:p-8">
      <div className="w-full max-w-2xl mx-auto">
        <div className="mb-6">
          <Link
            href="/dashboard"
            className="text-sm text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
          >
            ← Back to dashboard
          </Link>
        </div>

        <div className="rounded-[var(--radius-md)] border border-[var(--border-muted)] bg-[var(--bg-surface)] p-6 sm:p-8">
          <h1 className="text-xl font-bold text-[var(--accent)] mb-2">Paired devices</h1>
          <p className="text-[var(--text-secondary)] text-sm mb-6">
            Bridges approved for your account. Revoke a device to disconnect it immediately.
          </p>

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="fade-in mb-4 flex items-start gap-2 px-3 py-2 rounded-[var(--radius-sm)] bg-[rgba(255,68,102,0.08)] border border-[var(--status-error)] text-[var(--status-error)] text-sm"
            >
              <span aria-hidden="true">⚠</span>
              <span>{error}</span>
            </div>
          )}

          {devices === null && !error && (
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] py-8 justify-center">
              <span
                className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
                aria-hidden="true"
              />
              Loading devices...
            </div>
          )}

          {devices !== null && devices.length === 0 && (
            <div className="text-center py-8 text-sm text-[var(--text-muted)]">
              <p>No bridges paired yet. Start a bridge and approve it to see it here.</p>
              <p className="mt-2">
                <Link href="/pair" className="text-[var(--accent)] hover:underline">
                  Go to /pair
                </Link>{" "}
                or use Bridge Command on the dashboard.
              </p>
            </div>
          )}

          {devices !== null && devices.length > 0 && (
            <ul className="space-y-3">
              {devices.map((device) => {
                const label = device.hostname || shortBridgeId(device.bridgeId);
                const isRevoking = revokingId === device.bridgeId;
                return (
                  <li
                    key={device.bridgeId}
                    className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-base)] p-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-[var(--text-primary)] truncate">
                          {label}
                        </span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full border ${
                            device.revoked
                              ? "text-[var(--status-done)] border-[var(--status-done)]"
                              : "text-[var(--status-running)] border-[var(--status-running)]"
                          }`}
                        >
                          {device.revoked ? "Revoked" : "Active"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[var(--text-faint)] font-mono truncate">
                        {shortBridgeId(device.bridgeId)}
                      </p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        last seen {formatRelativeTime(device.lastSeen)}
                      </p>
                    </div>

                    {!device.revoked && (
                      <button
                        type="button"
                        onClick={() => handleRevoke(device)}
                        disabled={isRevoking}
                        className="btn-danger shrink-0 min-h-[44px] sm:min-h-0 flex items-center justify-center gap-2"
                      >
                        {isRevoking && (
                          <span
                            className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
                            aria-hidden="true"
                          />
                        )}
                        {isRevoking ? "Revoking..." : "Revoke"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
