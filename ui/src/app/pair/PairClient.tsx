"use client";

import { useCallback, useEffect, useState, FormEvent } from "react";
import { useSearchParams } from "next/navigation";

interface PairClientProps {
  userEmail: string;
}

interface PendingDevice {
  bridgeId: string;
  hostname: string;
  platform: string;
  createdAt: string;
}

type Phase = "idle" | "looking-up" | "found" | "not-found" | "approved" | "denied";

function normalizeUserCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length <= 4) return cleaned;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
}

function shortBridgeId(bridgeId: string): string {
  return bridgeId.length > 12 ? `${bridgeId.slice(0, 8)}…` : bridgeId;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "recently";
  const seconds = Math.round(ms / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

const inputClass =
  "w-full px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-base)] border border-[var(--border-default)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] outline-none focus-visible:border-[var(--accent)] focus-visible:shadow-[var(--focus-ring)] font-mono tracking-widest text-center uppercase";

export function PairClient({ userEmail }: PairClientProps) {
  const searchParams = useSearchParams();
  const [userCode, setUserCode] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [device, setDevice] = useState<PendingDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const lookup = useCallback(async (code: string) => {
    const normalized = normalizeUserCode(code);
    if (normalized.length < 9) {
      setError("Enter the full 8-character code.");
      return;
    }

    setPhase("looking-up");
    setError(null);
    setDevice(null);

    try {
      const response = await fetch("/api/auth/bridge/pair/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userCode: normalized }),
      });

      if (response.status === 404) {
        setPhase("not-found");
        return;
      }

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setError(data.error || "Could not look up that code.");
        setPhase("idle");
        return;
      }

      const data = (await response.json()) as PendingDevice;
      setDevice(data);
      setPhase("found");
    } catch {
      setError("Network error — please try again.");
      setPhase("idle");
    }
  }, []);

  useEffect(() => {
    const prefill = searchParams.get("code");
    if (prefill) {
      const normalized = normalizeUserCode(prefill);
      setUserCode(normalized);
      void lookup(normalized);
    }
    // Only run once on mount with the initial query param.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void lookup(userCode);
    },
    [userCode, lookup],
  );

  const handleDecision = useCallback(
    async (decision: "approve" | "deny") => {
      setActionLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/auth/bridge/pair/${decision}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ userCode: normalizeUserCode(userCode) }),
        });

        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          setError(data.error || `Could not ${decision} this device.`);
          setActionLoading(false);
          return;
        }

        setPhase(decision === "approve" ? "approved" : "denied");
      } catch {
        setError("Network error — please try again.");
      } finally {
        setActionLoading(false);
      }
    },
    [userCode],
  );

  const busy = phase === "looking-up" || actionLoading;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm sm:max-w-md rounded-[var(--radius-md)] border border-[var(--border-muted)] bg-[var(--bg-surface)] p-6 sm:p-8">
        <h1 className="text-xl font-bold text-[var(--accent)] mb-2">Approve device</h1>
        <p className="text-[var(--text-secondary)] text-sm mb-6">
          Signed in as <span className="text-[var(--text-primary)]">{userEmail}</span>. Approving a
          device lets that machine act as your bridge — connect to your account, run agents, and
          send/receive on your behalf. Only approve a device you recognize.
        </p>

        {phase !== "approved" && phase !== "denied" && (
          <form onSubmit={handleSubmit} className="space-y-3 mb-4">
            <div>
              <label htmlFor="userCode" className="block text-sm text-[var(--text-secondary)] mb-1">
                Device code
              </label>
              <input
                id="userCode"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="characters"
                value={userCode}
                onChange={(e) => setUserCode(normalizeUserCode(e.target.value))}
                placeholder="XXXX-XXXX"
                maxLength={9}
                className={inputClass}
              />
            </div>
            <button type="submit" disabled={busy} className="btn-accent w-full !py-2.5 flex items-center justify-center gap-2">
              {phase === "looking-up" && (
                <span
                  className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
                  aria-hidden="true"
                />
              )}
              {phase === "looking-up" ? "Looking up..." : "Look up code"}
            </button>
          </form>
        )}

        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="fade-in flex items-start gap-2 px-3 py-2 mb-4 rounded-[var(--radius-sm)] bg-[rgba(255,68,102,0.08)] border border-[var(--status-error)] text-[var(--status-error)] text-sm"
          >
            <span aria-hidden="true">⚠</span>
            <span>{error}</span>
          </div>
        )}

        {phase === "not-found" && (
          <p className="text-sm text-[var(--text-faint)]">
            That code is invalid or expired. Double-check the code shown on the device, or ask it to
            print a new one.
          </p>
        )}

        {phase === "found" && device && (
          <div className="fade-in space-y-4">
            <div className="rounded-[var(--radius-sm)] border border-[var(--border-default)] p-4 bg-[var(--bg-base)]">
              <p className="text-xs text-[var(--text-faint)] mb-1">This device is requesting access</p>
              <p className="text-lg font-semibold text-[var(--text-primary)] break-all">
                {device.hostname || "Unknown host"}
              </p>
              <p className="text-sm text-[var(--text-secondary)] mt-1">
                {device.platform || "unknown platform"} · id {shortBridgeId(device.bridgeId)}
              </p>
              <p className="text-xs text-[var(--text-faint)] mt-1">
                requested {relativeTime(device.createdAt)}
              </p>
            </div>

            <p className="text-xs text-[var(--text-faint)]">
              Make sure this is a machine you own before approving. Approving grants it full bridge
              access to your account until you revoke it.
            </p>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleDecision("approve")}
                disabled={busy}
                className="btn-accent flex-1 !py-2.5 flex items-center justify-center gap-2"
              >
                {actionLoading && (
                  <span
                    className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
                    aria-hidden="true"
                  />
                )}
                Approve this device
              </button>
              <button
                type="button"
                onClick={() => void handleDecision("deny")}
                disabled={busy}
                className="btn-ghost flex-1 !py-2.5 !text-[var(--status-error)]"
              >
                Deny
              </button>
            </div>
          </div>
        )}

        {phase === "approved" && device && (
          <div
            role="status"
            aria-live="polite"
            className="fade-in flex items-start gap-2 px-3 py-3 rounded-[var(--radius-sm)] bg-[var(--accent-dim)] border border-[var(--accent)] text-[var(--text-primary)] text-sm"
          >
            <span aria-hidden="true" className="text-[var(--accent)]">✓</span>
            <span>
              Approved — <strong>{device.hostname || "the device"}</strong> is now connecting.
            </span>
          </div>
        )}

        {phase === "denied" && (
          <div
            role="status"
            aria-live="polite"
            className="fade-in flex items-start gap-2 px-3 py-3 rounded-[var(--radius-sm)] bg-[var(--bg-base)] border border-[var(--border-default)] text-[var(--text-secondary)] text-sm"
          >
            <span aria-hidden="true">✕</span>
            <span>Denied. This device was not granted access.</span>
          </div>
        )}
      </div>
    </div>
  );
}
