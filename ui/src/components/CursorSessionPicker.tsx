"use client";

import { useState, useEffect, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type { CommandResponse } from "@/types";
import { relativeTime } from "@/lib/relative-time";

interface CursorSession {
  sessionId: string;
  timestamp: string;
  summary: string;
}

interface CursorSessionPickerProps {
  bridgeId: string;
  workingDir: string;
  onSelect: (cursorSessionId: string, summary: string) => void;
  sendCommand: (command: { type: "list_native_sessions"; payload: { bridgeId: string; workingDir: string; harness: "cursor" }; requestId: string }) => Promise<CommandResponse>;
}

export function CursorSessionPicker({ bridgeId, workingDir, onSelect, sendCommand }: CursorSessionPickerProps) {
  const [sessions, setSessions] = useState<CursorSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    if (!bridgeId || !workingDir) return;

    setLoading(true);
    setError(null);

    try {
      const response = await sendCommand({ type: "list_native_sessions", payload: { bridgeId, workingDir, harness: "cursor" }, requestId: uuidv4() });
      if (!response.success) throw new Error(response.error ?? "Failed to fetch sessions");
      setSessions((response.data as { sessions: CursorSession[] }).sessions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch sessions");
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [bridgeId, workingDir, sendCommand]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  if (loading) {
    return (
      <div className="mt-2 border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-overlay)] p-2 space-y-1.5" aria-busy="true" aria-label="Loading Cursor Agent sessions">
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
          <span className="break-words">Couldn&apos;t load Cursor Agent sessions.</span>
        </div>
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
        No Cursor Agent sessions found for this directory
      </div>
    );
  }

  return (
    <div className="mt-2 border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-overlay)] max-h-48 overflow-y-auto" role="listbox" aria-label="Resume a Cursor Agent session">
      <div className="px-3 py-1.5 text-[10px] text-[var(--text-muted)] uppercase tracking-wider border-b border-[var(--border-default)]">
        Resume a Cursor Agent session
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
              {s.summary || `${s.sessionId.slice(0, 20)}…`}
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
