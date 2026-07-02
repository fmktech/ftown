"use client";

import { useState, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";

interface SetupFormProps {
  onConnect: (token: string, userId: string, url: string) => void;
}

export function SetupForm({ onConnect }: SetupFormProps) {
  const [userId, setUserId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  const generateUserId = useCallback(() => {
    setUserId(uuidv4().slice(0, 8));
  }, []);

  const handleConnect = useCallback(async () => {
    const finalUserId = userId.trim() || uuidv4().slice(0, 8);
    if (!userId.trim()) {
      setUserId(finalUserId);
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: finalUserId }),
      });

      if (!response.ok) {
        const data = await response.json() as { error: string };
        throw new Error(data.error || "Failed to generate token");
      }

      const data = await response.json() as { token: string; centrifugoUrl: string };
      setGeneratedToken(data.token);

      localStorage.setItem("ftown_token", data.token);
      localStorage.setItem("ftown_userId", finalUserId);
      localStorage.setItem("ftown_centrifugoUrl", data.centrifugoUrl);

      onConnect(data.token, finalUserId, data.centrifugoUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [userId, onConnect]);

  const handleCopyToken = useCallback(async () => {
    if (!generatedToken) return;
    try {
      await navigator.clipboard.writeText(generatedToken);
      setCopied(true);
      setCopyStatus("Token copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy to clipboard — please copy manually");
    }
  }, [generatedToken]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm sm:max-w-md rounded-[var(--radius-md)] border border-[var(--border-muted)] bg-[var(--bg-surface)] p-6 sm:p-8">
        <h1 className="text-xl font-bold text-[var(--accent)] mb-2">ftown</h1>
        <p className="text-[var(--text-secondary)] text-sm mb-8 font-[family-name:var(--font-sans)]">
          Remote coding agent orchestration
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="userId" className="block text-sm text-[var(--text-secondary)] mb-1">
              User ID
            </label>
            <div className="flex gap-2">
              <input
                id="userId"
                type="text"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="Enter or generate..."
                className="flex-1 px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-base)] border border-[var(--border-default)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] outline-none focus-visible:border-[var(--accent)] focus-visible:shadow-[var(--focus-ring)]"
              />
              <button
                type="button"
                onClick={generateUserId}
                className="btn-ghost min-h-[44px] sm:min-h-0"
              >
                Generate
              </button>
            </div>
            <p className="mt-1 text-xs text-[var(--text-faint)]">
              Used to identify this device when connecting CLI bridges
            </p>
          </div>

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="fade-in flex items-start gap-2 px-3 py-2 rounded-[var(--radius-sm)] bg-[rgba(255,68,102,0.08)] border border-[var(--status-error)] text-[var(--status-error)] text-sm"
            >
              <span aria-hidden="true">⚠</span>
              <span>{error}</span>
            </div>
          )}

          <button
            type="button"
            onClick={handleConnect}
            disabled={loading}
            className="btn-accent w-full !py-2.5 flex items-center justify-center gap-2"
          >
            {loading && (
              <span
                className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
                aria-hidden="true"
              />
            )}
            {loading ? "Connecting..." : "Connect"}
          </button>

          {generatedToken && (
            <div
              aria-live="polite"
              className="fade-in mt-4 rounded-[var(--radius-sm)] border border-[var(--border-default)] p-3 bg-[var(--bg-base)]"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[var(--text-secondary)]">JWT Token (for CLI bridges)</span>
                <button
                  type="button"
                  onClick={handleCopyToken}
                  className="btn-ghost !text-[var(--accent)] min-h-[36px]"
                >
                  {copied ? "Copied!" : "Copy for CLI"}
                </button>
              </div>
              <p className="text-xs text-[var(--text-faint)] break-all font-mono leading-relaxed">
                {generatedToken}
              </p>
            </div>
          )}

          <span className="sr-only" role="status" aria-live="polite">
            {copyStatus}
          </span>
        </div>
      </div>
    </div>
  );
}
