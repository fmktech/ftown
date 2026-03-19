"use client";

import { useState, useRef, useEffect } from "react";
import { Session, SessionStatus } from "@/types";

interface SessionListProps {
  sessions: Session[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, name: string) => void;
}

function StatusBadge({ status }: { status: SessionStatus }) {
  const config: Record<SessionStatus, { dot: string; label: string; pulse: string }> = {
    running:      { dot: "status-dot-running",  label: "running",      pulse: "animate-running" },
    completed:    { dot: "status-dot-done",     label: "done",         pulse: "" },
    error:        { dot: "status-dot-error",    label: "error",        pulse: "" },
    pending:      { dot: "status-dot-pending",  label: "pending",      pulse: "animate-pending" },
    disconnected: { dot: "status-dot-done",     label: "disconnected", pulse: "" },
  };
  const { dot, label, pulse } = config[status] ?? config.completed;

  const labelColors: Record<SessionStatus, string> = {
    running:      "var(--accent)",
    completed:    "var(--text-faint)",
    error:        "var(--status-error)",
    pending:      "var(--status-pending)",
    disconnected: "var(--text-faint)",
  };

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className={`status-dot ${dot} ${pulse}`} />
      <span style={{ fontSize: 10, color: labelColors[status] ?? "var(--text-faint)", letterSpacing: "0.06em" }}>
        {label}
      </span>
    </div>
  );
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return date.toLocaleDateString();
}

export function SessionList({ sessions, selectedSessionId, onSelectSession, onRenameSession }: SessionListProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingSessionId]);

  function startEditing(session: Session): void {
    setEditingSessionId(session.id);
    setEditValue(session.name || session.prompt.slice(0, 36));
  }

  function commitRename(): void {
    if (editingSessionId && editValue.trim() && onRenameSession) {
      onRenameSession(editingSessionId, editValue.trim());
    }
    setEditingSessionId(null);
  }

  function cancelEditing(): void {
    setEditingSessionId(null);
  }

  if (sessions.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center p-8 fade-in"
        style={{ color: "var(--text-faint)", fontSize: 11, gap: 8 }}
      >
        <span style={{ fontSize: 20, opacity: 0.4 }}>▣</span>
        <span>No sessions yet</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {sessions.map((session) => {
        const isSelected = session.id === selectedSessionId;
        const displayName = session.name || session.prompt.slice(0, 36);

        return (
          <button
            key={session.id}
            onClick={() => onSelectSession(session.id)}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "10px 16px",
              borderBottom: "1px solid var(--border-subtle)",
              borderLeft: `2px solid ${isSelected ? "var(--accent)" : "transparent"}`,
              background: isSelected ? "var(--bg-elevated)" : "transparent",
              cursor: "pointer",
              transition: "background 0.12s ease, border-color 0.12s ease",
              fontFamily: "var(--font-mono)",
              display: "block",
            }}
            onMouseEnter={(e) => {
              if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (!isSelected) e.currentTarget.style.background = "transparent";
            }}
          >
            {/* Title row */}
            <div className="flex items-center justify-between gap-2 mb-1">
              {editingSessionId === session.id ? (
                <input
                  ref={inputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") cancelEditing();
                  }}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    background: "var(--bg-void)",
                    border: "1px solid var(--accent-dim)",
                    borderRadius: 3,
                    padding: "1px 4px",
                    outline: "none",
                    flex: 1,
                    minWidth: 0,
                    fontFamily: "var(--font-mono)",
                  }}
                />
              ) : (
                <span
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startEditing(session);
                  }}
                  style={{
                    fontSize: 12,
                    fontWeight: isSelected ? 600 : 400,
                    color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
                    cursor: "default",
                  }}
                >
                  {displayName}
                </span>
              )}
              <StatusBadge status={session.status} />
            </div>

            {/* Prompt preview */}
            {session.name && (
              <p
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  marginBottom: 4,
                }}
              >
                {session.prompt}
              </p>
            )}

            {/* Meta row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    padding: "1px 4px",
                    borderRadius: 3,
                    background: session.shellType === "shell" ? "rgba(255, 170, 0, 0.12)" : "rgba(0, 255, 136, 0.08)",
                    color: session.shellType === "shell" ? "var(--status-pending)" : "var(--accent)",
                    border: `1px solid ${session.shellType === "shell" ? "rgba(255, 170, 0, 0.2)" : "rgba(0, 255, 136, 0.15)"}`,
                    textTransform: "uppercase",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {session.shellType === "shell" ? "zsh" : "claude"}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-faint)" }}>
                  {session.model}
                </span>
              </div>
              <span style={{ fontSize: 10, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                {formatTimestamp(session.createdAt)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
