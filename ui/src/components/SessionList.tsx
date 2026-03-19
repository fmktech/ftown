"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Session, SessionStatus } from "@/types";
import { SessionActivity } from "@/hooks/useAllSessionEvents";

interface SessionListProps {
  sessions: Session[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, name: string) => void;
  onStopSession?: (sessionId: string) => void;
  onResumeSession?: (sessionId: string) => void;
  onRemoveSession?: (sessionId: string) => void;
  sessionActivity?: Map<string, SessionActivity>;
}

interface ContextMenuState {
  sessionId: string;
  sessionStatus: SessionStatus;
  x: number;
  y: number;
}

function StatusBadge({ status, activity }: { status: SessionStatus; activity?: "thinking" | "tool_use" | "idle" }) {
  const isIdle = status === "running" && activity === "idle";
  const config: Record<SessionStatus, { dot: string; label: string; pulse: string }> = {
    running:      { dot: isIdle ? "status-dot-pending" : "status-dot-running", label: isIdle ? "idle" : "running", pulse: isIdle ? "" : "animate-running" },
    completed:    { dot: "status-dot-done",     label: "done",         pulse: "" },
    error:        { dot: "status-dot-error",    label: "error",        pulse: "" },
    pending:      { dot: "status-dot-pending",  label: "pending",      pulse: "animate-pending" },
    disconnected: { dot: "status-dot-done",     label: "disconnected", pulse: "" },
  };
  const { dot, label, pulse } = config[status] ?? config.completed;

  const labelColors: Record<SessionStatus, string> = {
    running:      isIdle ? "var(--status-pending)" : "var(--accent)",
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

function ContextMenu({
  menu,
  onStop,
  onResume,
  onRemove,
  onClose,
}: {
  menu: ContextMenuState;
  onStop: (sessionId: string) => void;
  onResume: (sessionId: string) => void;
  onRemove: (sessionId: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    function handleScroll(): void {
      onClose();
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  const isRunning = menu.sessionStatus === "running" || menu.sessionStatus === "pending";
  const canResume = menu.sessionStatus === "completed" || menu.sessionStatus === "error";

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: menu.y,
        left: menu.x,
        zIndex: 9999,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-muted)",
        borderRadius: 6,
        padding: "4px 0",
        minWidth: 120,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.4)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      {isRunning && (
        <button
          onClick={() => {
            onStop(menu.sessionId);
            onClose();
          }}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "6px 12px",
            background: "transparent",
            border: "none",
            color: "var(--status-error)",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          Stop
        </button>
      )}
      {canResume && (
        <button
          onClick={() => {
            onResume(menu.sessionId);
            onClose();
          }}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "6px 12px",
            background: "transparent",
            border: "none",
            color: "var(--accent)",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          Resume
        </button>
      )}
      <button
        onClick={() => {
          onRemove(menu.sessionId);
          onClose();
        }}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: "6px 12px",
          background: "transparent",
          border: "none",
          color: "var(--status-error)",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        Remove
      </button>
    </div>,
    document.body
  );
}

export function SessionList({ sessions, selectedSessionId, onSelectSession, onRenameSession, onStopSession, onResumeSession, onRemoveSession, sessionActivity }: SessionListProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingSessionId]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

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

  function handleContextMenu(e: React.MouseEvent, session: Session): void {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      sessionId: session.id,
      sessionStatus: session.status,
      x: e.clientX,
      y: e.clientY,
    });
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
            onContextMenu={(e) => handleContextMenu(e, session)}
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
              <StatusBadge status={session.status} activity={sessionActivity?.get(session.id)?.activity} />
            </div>

            {/* Activity indicator */}
            {session.status === "running" && (() => {
              const act = sessionActivity?.get(session.id);
              if (!act || act.activity === "idle") return null;
              const isThinking = act.activity === "thinking";
              return (
                <div
                  style={{
                    fontSize: 10,
                    color: isThinking ? "var(--status-pending)" : "var(--accent)",
                    fontStyle: "italic",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginBottom: 2,
                    ...(isThinking ? { animation: "pulse-pending 2s ease-in-out infinite" } : {}),
                  }}
                >
                  {isThinking ? "thinking..." : `using ${act.toolName ?? "tool"}`}
                </div>
              );
            })()}

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

      {contextMenu && onStopSession && onRemoveSession && (
        <ContextMenu
          menu={contextMenu}
          onStop={onStopSession}
          onResume={onResumeSession ?? (() => {})}
          onRemove={onRemoveSession}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
