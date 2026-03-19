"use client";

import { Session, SessionStatus } from "@/types";

interface SessionListProps {
  sessions: Session[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}

function StatusBadge({ status }: { status: SessionStatus }) {
  const config: Record<SessionStatus, { dot: string; label: string; pulse: string }> = {
    running:   { dot: "status-dot-running",  label: "running",   pulse: "animate-running" },
    completed: { dot: "status-dot-done",     label: "done",      pulse: "" },
    error:     { dot: "status-dot-error",    label: "error",     pulse: "" },
    pending:   { dot: "status-dot-pending",  label: "pending",   pulse: "animate-pending" },
  };
  const { dot, label, pulse } = config[status] ?? config.completed;

  const labelColors: Record<SessionStatus, string> = {
    running:   "var(--accent)",
    completed: "var(--text-faint)",
    error:     "var(--status-error)",
    pending:   "var(--status-pending)",
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

export function SessionList({ sessions, selectedSessionId, onSelectSession }: SessionListProps) {
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
              <span
                style={{
                  fontSize: 12,
                  fontWeight: isSelected ? 600 : 400,
                  color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {displayName}
              </span>
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
              <span style={{ fontSize: 10, color: "var(--text-faint)" }}>
                {session.model}
              </span>
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
