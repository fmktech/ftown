"use client";

import { useState, useEffect, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type { CommandResponse } from "@/types";
import { relativeTime } from "@/lib/relative-time";

interface ClaudeSession {
  sessionId: string;
  timestamp: string;
  summary: string;
}

interface ClaudeSessionPickerProps {
  bridgeId: string;
  workingDir: string;
  account: string;
  onSelect: (claudeSessionId: string, summary: string) => void;
  sendCommand: (command: { type: "list_native_sessions"; payload: { bridgeId: string; workingDir: string; harness: "claude"; account?: string }; requestId: string }) => Promise<CommandResponse>;
}

function safeErrorCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}

export function ClaudeSessionPicker({ bridgeId, workingDir, account, onSelect, sendCommand }: ClaudeSessionPickerProps) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<"load" | "upgrade" | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    if (!bridgeId || !workingDir) return;

    setLoading(true);
    setError(null);
    setErrorCode(null);

    try {
      const response = await sendCommand({ type: "list_native_sessions", payload: { bridgeId, workingDir, harness: "claude", ...(account !== "default" ? { account } : {}) }, requestId: uuidv4() });
      if (!response.success && (response.error === "Unknown command type: list_native_sessions"
        || (account !== "default" && response.error === "Invalid native session list request"))) {
        setError("upgrade");
        setSessions([]);
        return;
      }
      if (!response.success) {
        const data = response.data;
        setErrorCode(safeErrorCode(data && typeof data === "object" && "code" in data ? data.code : null));
        setError("load");
        setSessions([]);
        return;
      }
      setSessions((response.data as { sessions: ClaudeSession[] }).sessions);
    } catch (e) {
      setErrorCode(safeErrorCode(e && typeof e === "object" && "code" in e ? e.code : null));
      setError("load");
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [bridgeId, workingDir, account, sendCommand]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  if (loading) {
    return (
      <div className="mt-2 border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-overlay)] p-2 space-y-1.5" aria-busy="true" aria-label="Loading Claude sessions">
        <div className="skeleton h-4 w-2/5" />
        <div className="skeleton h-8" />
        <div className="skeleton h-8" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="fade-in mt-2 px-3 py-2 border border-[var(--status-error)] rounded-[var(--radius-sm)] bg-[rgba(255,68,102,0.08)]"
      >
        <div className="flex items-start gap-2 text-xs text-[var(--status-error)]">
          <span aria-hidden>⚠</span>
          <span className="break-words">{error === "upgrade" ? "Upgrade this computer's ftown bridge to load Claude sessions." : "Couldn't load Claude sessions."}</span>
        </div>
        {error === "load" && errorCode && <div className="mt-1 text-xs text-[var(--status-error)] break-words">Code: {errorCode}</div>}
        <button
          type="button"
          onClick={() => void fetchSessions()}
          className="btn-ghost mt-2"
        >
          Retry
        </button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="mt-2 px-3 py-4 text-xs text-[var(--text-faint)] text-center border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-overlay)]">
        No sessions found
      </div>
    );
  }

  return (
    <div className="mt-2 border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-overlay)] max-h-48 overflow-y-auto" role="listbox" aria-label="Resume a Claude session">
      <div className="px-3 py-1.5 text-[10px] text-[var(--text-muted)] uppercase tracking-wider border-b border-[var(--border-default)]">
        Resume a Claude session
      </div>
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          type="button"
          role="option"
          aria-selected="false"
          onClick={() => onSelect(s.sessionId, s.summary)}
          className="w-full text-left px-3 py-2 hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] transition-colors border-b border-[var(--border-subtle)] last:border-b-0"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-[var(--text-secondary)] truncate flex-1">
              {s.summary || "Empty session"}
            </span>
            <span className="text-[10px] text-[var(--text-faint)] shrink-0 tabular-nums">
              {relativeTime(s.timestamp)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
