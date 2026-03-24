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
  onRemoveSession?: (sessionId: string) => void;
  onCloneSession?: (session: Session) => void;
  onReorderSessions?: (orderedIds: string[]) => void;
  sessionActivity?: Map<string, SessionActivity>;
}

interface ContextMenuState {
  session: Session;
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

function parseDiffStat(diffStat: string | undefined): { added: number; removed: number } | null {
  if (!diffStat) return null;
  const lines = diffStat.trim().split("\n");
  const summary = lines[lines.length - 1];
  const addMatch = summary.match(/(\d+) insertion/);
  const delMatch = summary.match(/(\d+) deletion/);
  const added = addMatch ? parseInt(addMatch[1], 10) : 0;
  const removed = delMatch ? parseInt(delMatch[1], 10) : 0;
  if (added === 0 && removed === 0) return null;
  return { added, removed };
}

function DiffBadge({ diffStat }: { diffStat: string | undefined }) {
  const stats = parseDiffStat(diffStat);
  if (!stats) return null;
  return (
    <span className="flex items-center gap-1 shrink-0" style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}>
      {stats.added > 0 && (
        <span style={{ color: "rgb(74, 222, 128)" }}>+{stats.added}</span>
      )}
      {stats.removed > 0 && (
        <span style={{ color: "rgb(248, 113, 113)" }}>-{stats.removed}</span>
      )}
    </span>
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
  onRename,
  onStop,
  onRemove,
  onClone,
  onClose,
}: {
  menu: ContextMenuState;
  onRename: (session: Session) => void;
  onStop: (sessionId: string) => void;
  onRemove: (sessionId: string) => void;
  onClone: (session: Session) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent | TouchEvent): void {
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
    document.addEventListener("touchstart", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  const isRunning = menu.session.status === "running" || menu.session.status === "pending";

  const menuButtonStyle = {
    display: "block" as const,
    width: "100%",
    textAlign: "left" as const,
    padding: "6px 12px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
  };

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
      <button
        onClick={() => {
          onRename(menu.session);
          onClose();
        }}
        style={{ ...menuButtonStyle, color: "var(--text-secondary)" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        Rename
      </button>
      <button
        onClick={() => {
          onClone(menu.session);
          onClose();
        }}
        style={{ ...menuButtonStyle, color: "var(--text-secondary)" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        Clone
      </button>
      {isRunning && (
        <button
          onClick={() => {
            onStop(menu.session.id);
            onClose();
          }}
          style={{ ...menuButtonStyle, color: "var(--status-error)" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          Stop
        </button>
      )}
      <button
        onClick={() => {
          onRemove(menu.session.id);
          onClose();
        }}
        style={{ ...menuButtonStyle, color: "var(--status-error)" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        Remove
      </button>
    </div>,
    document.body
  );
}

export function SessionList({ sessions, selectedSessionId, onSelectSession, onRenameSession, onStopSession, onRemoveSession, onCloneSession, onReorderSessions, sessionActivity }: SessionListProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"above" | "below" | null>(null);
  const draggedIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

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
      session,
      x: e.clientX,
      y: e.clientY,
    });
  }

  function handleDragStart(e: React.DragEvent, sessionId: string): void {
    draggedIdRef.current = sessionId;
    e.dataTransfer.effectAllowed = "move";
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "0.4";
    }
  }

  function handleDragEnd(e: React.DragEvent): void {
    draggedIdRef.current = null;
    setDragOverId(null);
    setDragOverPosition(null);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "1";
    }
  }

  function handleDragOver(e: React.DragEvent, sessionId: string): void {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!draggedIdRef.current || draggedIdRef.current === sessionId) {
      setDragOverId(null);
      setDragOverPosition(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDragOverId(sessionId);
    setDragOverPosition(e.clientY < midY ? "above" : "below");
  }

  function handleDrop(e: React.DragEvent, targetId: string): void {
    e.preventDefault();
    const draggedId = draggedIdRef.current;
    if (!draggedId || draggedId === targetId || !onReorderSessions) return;

    const ids = sessions.map((s) => s.id);
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    ids.splice(fromIdx, 1);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const insertIdx = e.clientY < midY ? ids.indexOf(targetId) : ids.indexOf(targetId) + 1;
    ids.splice(insertIdx, 0, draggedId);
    onReorderSessions(ids);

    setDragOverId(null);
    setDragOverPosition(null);
    draggedIdRef.current = null;
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
            draggable
            onDragStart={(e) => handleDragStart(e, session.id)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, session.id)}
            onDragLeave={() => { setDragOverId(null); setDragOverPosition(null); }}
            onDrop={(e) => handleDrop(e, session.id)}
            onClick={() => {
              if (longPressFired.current) return;
              onSelectSession(session.id);
            }}
            onContextMenu={(e) => handleContextMenu(e, session)}
            onTouchStart={(e) => {
              longPressFired.current = false;
              const touch = e.touches[0];
              const x = touch.clientX;
              const y = touch.clientY;
              longPressTimer.current = setTimeout(() => {
                longPressFired.current = true;
                setContextMenu({ session, x, y });
              }, 500);
            }}
            onTouchEnd={() => {
              if (longPressTimer.current) {
                clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
              }
            }}
            onTouchMove={() => {
              if (longPressTimer.current) {
                clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
              }
            }}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "10px 16px",
              borderBottom: "1px solid var(--border-subtle)",
              borderTop: dragOverId === session.id && dragOverPosition === "above" ? "2px solid var(--accent)" : "none",
              ...(dragOverId === session.id && dragOverPosition === "below" ? { borderBottom: "2px solid var(--accent)" } : {}),
              borderLeft: `2px solid ${isSelected ? "var(--accent)" : "transparent"}`,
              background: isSelected ? "var(--bg-elevated)" : "transparent",
              cursor: "grab",
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
              <DiffBadge diffStat={session.diffStat} />
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
                {session.model && session.shellType !== "shell" && (
                  <span style={{ fontSize: 10, color: "var(--text-faint)" }}>
                    {session.model}
                  </span>
                )}
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
          onRename={startEditing}
          onStop={onStopSession}
          onRemove={onRemoveSession}
          onClone={onCloneSession ?? (() => {})}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
