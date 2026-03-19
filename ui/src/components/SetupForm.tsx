"use client";

import { useState, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";

interface SetupFormProps {
  onConnect: (token: string, userId: string, url: string) => void;
}

export function SetupForm({ onConnect }: SetupFormProps) {
  const [userId, setUserId] = useState("");
  const [centrifugoUrl, setCentrifugoUrl] = useState("ws://localhost:8000/connection/websocket");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

      const data = await response.json() as { token: string };
      setGeneratedToken(data.token);

      localStorage.setItem("ftown_token", data.token);
      localStorage.setItem("ftown_userId", finalUserId);
      localStorage.setItem("ftown_centrifugoUrl", centrifugoUrl);

      onConnect(data.token, finalUserId, centrifugoUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [userId, centrifugoUrl, onConnect]);

  const handleCopyToken = useCallback(async () => {
    if (!generatedToken) return;
    await navigator.clipboard.writeText(generatedToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [generatedToken]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md border border-[#2a2a2a] bg-[#111111] rounded-lg p-8">
        <h1 className="text-xl font-bold text-[#00ff88] mb-2">ftown</h1>
        <p className="text-[#888888] text-sm mb-8">Claude Code Orchestrator</p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-[#888888] mb-1">User ID</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="Enter or generate..."
                className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88]"
              />
              <button
                onClick={generateUserId}
                className="px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-xs text-[#888888] hover:text-[#e0e0e0] hover:border-[#444] transition-colors"
              >
                Generate
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm text-[#888888] mb-1">Centrifugo WebSocket URL</label>
            <input
              type="text"
              value={centrifugoUrl}
              onChange={(e) => setCentrifugoUrl(e.target.value)}
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] focus:outline-none focus:border-[#00ff88]"
            />
          </div>

          {error && (
            <div className="text-[#ff4444] text-sm bg-[#1a0000] border border-[#330000] rounded px-3 py-2">
              {error}
            </div>
          )}

          <button
            onClick={handleConnect}
            disabled={loading}
            className="w-full py-2 bg-[#00ff88] text-[#0a0a0a] font-bold rounded hover:bg-[#00cc6e] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Connecting..." : "Connect"}
          </button>

          {generatedToken && (
            <div className="mt-4 border border-[#2a2a2a] rounded p-3 bg-[#0a0a0a]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[#888888]">JWT Token (for CLI bridges)</span>
                <button
                  onClick={handleCopyToken}
                  className="text-xs px-2 py-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-[#00ff88] hover:bg-[#222] transition-colors"
                >
                  {copied ? "Copied!" : "Copy for CLI"}
                </button>
              </div>
              <p className="text-xs text-[#666] break-all font-mono leading-relaxed">
                {generatedToken}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
