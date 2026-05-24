"use client";

import { useState, useRef, useEffect, useCallback, useMemo, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Session, SessionStatus } from "@/types";
import { SessionActivity } from "@/hooks/useAllSessionEvents";
import { BridgeInfo } from "@/hooks/useBridges";

interface SessionListProps {
  sessions: Session[];
  bridges: BridgeInfo[];
  bridgeOrder: string[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, name: string) => void;
  onStopSession?: (sessionId: string) => void;
  onRemoveSession?: (sessionId: string) => void;
  onCloneSession?: (session: Session) => void;
  onReorderSessions?: (orderedIds: string[]) => void;
  onReorderBridges?: (orderedBridgeIds: string[]) => void;
  sessionActivity?: Map<string, SessionActivity>;
  collapsed?: boolean;
  hiddenSessionIds?: Set<string>;
  onHideSession?: (sessionId: string) => void;
  onUnhideSession?: (sessionId: string) => void;
}

interface ContextMenuState {
  session: Session;
  x: number;
  y: number;
}

type DragKind = "bridge" | "session";
type DropZone = "above" | "below";

interface DragState {
  kind: DragKind;
  id: string;
  bridgeId?: string;
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

function bridgeLabel(bridgeId: string, bridges: BridgeInfo[]): string {
  const info = bridges.find((b) => b.bridgeId === bridgeId);
  if (info?.hostname && info.hostname !== "unknown") return info.hostname;
  return bridgeId.length > 20 ? `${bridgeId.slice(0, 18)}…` : bridgeId;
}

function computeDropZone(e: React.DragEvent): DropZone {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const offset = e.clientY - rect.top;
  return offset < rect.height / 2 ? "above" : "below";
}

function ContextMenu({
  menu,
  onRename,
  onStop,
  onRemove,
  onClone,
  onHide,
  onUnhide,
  isHidden,
  onClose,
}: {
  menu: ContextMenuState;
  onRename: (session: Session) => void;
  onStop: (sessionId: string) => void;
  onRemove: (sessionId: string) => void;
  onClone: (session: Session) => void;
  onHide: (sessionId: string) => void;
  onUnhide: (sessionId: string) => void;
  isHidden: boolean;
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
      {isHidden ? (
        <button
          onClick={() => {
            onUnhide(menu.session.id);
            onClose();
          }}
          style={{ ...menuButtonStyle, color: "var(--text-secondary)" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          Unhide
        </button>
      ) : (
        <button
          onClick={() => {
            onHide(menu.session.id);
            onClose();
          }}
          style={{ ...menuButtonStyle, color: "var(--text-secondary)" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          Hide
        </button>
      )}
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

export function SessionList({
  sessions,
  bridges,
  bridgeOrder,
  selectedSessionId,
  onSelectSession,
  onRenameSession,
  onStopSession,
  onRemoveSession,
  onCloneSession,
  onReorderSessions,
  onReorderBridges,
  sessionActivity,
  collapsed,
  hiddenSessionIds,
  onHideSession,
  onUnhideSession,
}: SessionListProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [dragOverZone, setDragOverZone] = useState<DropZone | null>(null);
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [collapsedBridges, setCollapsedBridges] = useState<Set<string>>(new Set());
  const dragRef = useRef<DragState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const hiddenSet = hiddenSessionIds ?? new Set<string>();
  const visibleSessions = sessions.filter((s) => !hiddenSet.has(s.id));
  const hiddenSessions = sessions.filter((s) => hiddenSet.has(s.id));

  useEffect(() => {
    try {
      const raw = localStorage.getItem("ftown:collapsedBridges");
      if (raw) setCollapsedBridges(new Set(JSON.parse(raw)));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingSessionId]);

  const onlineBridgeIds = useMemo(() => new Set(bridges.map((b) => b.bridgeId)), [bridges]);

  const orderedBridgeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const b of bridges) ids.add(b.bridgeId);
    for (const s of visibleSessions) ids.add(s.bridgeId);
    const ordered = bridgeOrder.filter((id) => ids.has(id));
    for (const id of ids) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    return ordered;
  }, [bridges, visibleSessions, bridgeOrder]);

  const sessionsByBridge = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const s of visibleSessions) {
      const arr = map.get(s.bridgeId) ?? [];
      arr.push(s);
      map.set(s.bridgeId, arr);
    }
    return map;
  }, [visibleSessions]);

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

  function handleContextMenu(e: React.MouseEvent, session: Session): void {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ session, x: e.clientX, y: e.clientY });
  }

  function clearDragState(): void {
    dragRef.current = null;
    setDragOverKey(null);
    setDragOverZone(null);
  }

  function handleDragStart(e: React.DragEvent, state: DragState): void {
    dragRef.current = state;
    e.dataTransfer.effectAllowed = "move";
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "0.4";
    }
  }

  function handleDragEnd(e: React.DragEvent): void {
    clearDragState();
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "1";
    }
  }

  function handleDragOver(e: React.DragEvent, key: string, accept: DragKind): void {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const drag = dragRef.current;
    if (!drag || drag.kind !== accept) {
      setDragOverKey(null);
      setDragOverZone(null);
      return;
    }
    if (drag.kind === "bridge" && drag.id === key.replace("bridge:", "")) {
      setDragOverKey(null);
      setDragOverZone(null);
      return;
    }
    if (drag.kind === "session" && drag.id === key.replace("session:", "")) {
      setDragOverKey(null);
      setDragOverZone(null);
      return;
    }
    setDragOverKey(key);
    setDragOverZone(computeDropZone(e));
  }

  function handleBridgeDrop(e: React.DragEvent, targetBridgeId: string): void {
    e.preventDefault();
    const drag = dragRef.current;
    if (!drag || drag.kind !== "bridge" || !onReorderBridges) {
      clearDragState();
      return;
    }
    const draggedId = drag.id;
    if (draggedId === targetBridgeId) {
      clearDragState();
      return;
    }

    const zone = computeDropZone(e);
    const ids = [...orderedBridgeIds];
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetBridgeId);
    if (fromIdx === -1 || toIdx === -1) {
      clearDragState();
      return;
    }

    ids.splice(fromIdx, 1);
    const insertIdx = zone === "above" ? ids.indexOf(targetBridgeId) : ids.indexOf(targetBridgeId) + 1;
    ids.splice(insertIdx, 0, draggedId);
    onReorderBridges(ids);
    clearDragState();
  }

  function handleSessionDrop(e: React.DragEvent, targetSession: Session): void {
    e.preventDefault();
    const drag = dragRef.current;
    if (!drag || drag.kind !== "session" || !onReorderSessions) {
      clearDragState();
      return;
    }
    const draggedId = drag.id;
    if (draggedId === targetSession.id || drag.bridgeId !== targetSession.bridgeId) {
      clearDragState();
      return;
    }

    const zone = computeDropZone(e);
    const bridgeSessions = sessionsByBridge.get(targetSession.bridgeId) ?? [];
    const ids = bridgeSessions.map((s) => s.id);
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetSession.id);
    if (fromIdx === -1 || toIdx === -1) {
      clearDragState();
      return;
    }

    ids.splice(fromIdx, 1);
    const insertIdx = zone === "above" ? ids.indexOf(targetSession.id) : ids.indexOf(targetSession.id) + 1;
    ids.splice(insertIdx, 0, draggedId);

    const newOrder: string[] = [];
    const seenBridges = new Set<string>();
    for (const bid of orderedBridgeIds) {
      seenBridges.add(bid);
      if (bid === targetSession.bridgeId) {
        newOrder.push(...ids);
      } else {
        newOrder.push(...(sessionsByBridge.get(bid)?.map((s) => s.id) ?? []));
      }
    }
    for (const [bid, bridgeSessionsList] of sessionsByBridge) {
      if (!seenBridges.has(bid)) {
        newOrder.push(...bridgeSessionsList.map((s) => s.id));
      }
    }
    onReorderSessions(newOrder);
    clearDragState();
  }

  function toggleBridgeCollapsed(bridgeId: string): void {
    setCollapsedBridges((prev) => {
      const next = new Set(prev);
      if (next.has(bridgeId)) next.delete(bridgeId);
      else next.add(bridgeId);
      localStorage.setItem("ftown:collapsedBridges", JSON.stringify([...next]));
      return next;
    });
  }

  if (visibleSessions.length === 0 && hiddenSessions.length === 0) {
    if (collapsed) return null;
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

  function renderSessionRow(session: Session): ReactElement {
    const isSelected = session.id === selectedSessionId;
    const displayName = session.name || session.prompt.slice(0, 36);
    const dropKey = `session:${session.id}`;
    const isDragOver = dragOverKey === dropKey;

    if (collapsed) {
      const act = sessionActivity?.get(session.id);
      const isRunning = session.status === "running";
      const isIdle = isRunning && act?.activity === "idle";
      const isThinking = isRunning && act?.activity === "thinking";
      const isToolUse = isRunning && act?.activity === "tool_use";

      const borderColor = session.status === "error" ? "var(--status-error)"
        : session.status === "pending" ? "var(--status-pending)"
        : isThinking ? "#ff8800"
        : isToolUse ? "#eedd00"
        : isRunning ? "#666"
        : "transparent";

      const tooltip = isThinking ? `${displayName}\nthinking...`
        : isToolUse ? `${displayName}\nusing ${act?.toolName ?? "tool"}`
        : `${displayName}\n${session.status}`;

      return (
        <button
          key={session.id}
          onClick={() => onSelectSession(session.id)}
          onContextMenu={(e) => handleContextMenu(e, session)}
          title={tooltip}
          style={{
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            borderBottom: "1px solid var(--border-subtle)",
            borderLeft: `3px solid ${borderColor !== "transparent" ? borderColor : isSelected ? "var(--accent)" : "transparent"}`,
            background: isSelected ? "var(--bg-elevated)" : "transparent",
            cursor: "pointer",
            transition: "background 0.12s ease, border-color 0.3s ease",
            padding: "6px 8px",
            fontFamily: "var(--font-mono)",
          }}
          onMouseEnter={(e) => {
            if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            if (!isSelected) e.currentTarget.style.background = "transparent";
          }}
        >
          <span style={{
            fontSize: 10,
            fontWeight: isSelected ? 600 : 400,
            color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            lineHeight: 1.3,
          }}>
            {displayName.slice(0, 10)}
          </span>
        </button>
      );
    }

    return (
      <button
        key={session.id}
        draggable
        onDragStart={(e) => handleDragStart(e, { kind: "session", id: session.id, bridgeId: session.bridgeId })}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => handleDragOver(e, dropKey, "session")}
        onDragLeave={() => { setDragOverKey(null); setDragOverZone(null); }}
        onDrop={(e) => handleSessionDrop(e, session)}
        onClick={() => {
          if (longPressFired.current) return;
          onSelectSession(session.id);
        }}
        onContextMenu={(e) => handleContextMenu(e, session)}
        onTouchStart={(e) => {
          longPressFired.current = false;
          const touch = e.touches[0];
          longPressTimer.current = setTimeout(() => {
            longPressFired.current = true;
            setContextMenu({ session, x: touch.clientX, y: touch.clientY });
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
          padding: "10px 16px 10px 28px",
          borderBottom: "1px solid var(--border-subtle)",
          borderTop: isDragOver && dragOverZone === "above" ? "2px solid var(--accent)" : "none",
          ...(isDragOver && dragOverZone === "below" ? { borderBottom: "2px solid var(--accent)" } : {}),
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
        <div className="flex items-center justify-between gap-2 mb-1">
          {editingSessionId === session.id ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditingSessionId(null);
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

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              style={{
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: "0.06em",
                padding: "1px 4px",
                borderRadius: 3,
                background: session.shellType === "shell" ? "rgba(255, 170, 0, 0.12)" : session.shellType === "cursor" ? "rgba(168, 180, 255, 0.12)" : session.shellType === "zai" ? "rgba(100, 149, 237, 0.12)" : session.shellType === "kimi" ? "rgba(255, 105, 180, 0.12)" : session.shellType === "opencode" ? "rgba(186, 85, 211, 0.12)" : session.shellType === "deepseek" ? "rgba(0, 191, 255, 0.12)" : "rgba(0, 255, 136, 0.08)",
                color: session.shellType === "shell" ? "var(--status-pending)" : session.shellType === "cursor" ? "#A8B4FF" : session.shellType === "zai" ? "#6495ED" : session.shellType === "kimi" ? "#FF69B4" : session.shellType === "opencode" ? "#BA55D3" : session.shellType === "deepseek" ? "#00BFFF" : "var(--accent)",
                border: `1px solid ${session.shellType === "shell" ? "rgba(255, 170, 0, 0.2)" : session.shellType === "cursor" ? "rgba(168, 180, 255, 0.25)" : session.shellType === "zai" ? "rgba(100, 149, 237, 0.2)" : session.shellType === "kimi" ? "rgba(255, 105, 180, 0.2)" : session.shellType === "opencode" ? "rgba(186, 85, 211, 0.2)" : session.shellType === "deepseek" ? "rgba(0, 191, 255, 0.2)" : "rgba(0, 255, 136, 0.15)"}`,
                textTransform: "uppercase",
                fontFamily: "var(--font-mono)",
              }}
            >
              {session.shellType === "shell" ? "zsh" : session.shellType === "cursor" ? "cursor" : session.shellType === "zai" ? "z.ai" : session.shellType === "kimi" ? "kimi" : session.shellType === "opencode" ? "opencode" : session.shellType === "deepseek" ? "deepseek" : "claude"}
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
  }

  function renderBridgeFolder(bridgeId: string): ReactElement | null {
    const bridgeSessions = sessionsByBridge.get(bridgeId) ?? [];
    if (bridgeSessions.length === 0 && collapsed) return null;

    const isBridgeCollapsed = collapsedBridges.has(bridgeId);
    const isOnline = onlineBridgeIds.has(bridgeId);
    const label = bridgeLabel(bridgeId, bridges);
    const dropKey = `bridge:${bridgeId}`;
    const isDragOver = dragOverKey === dropKey;

    if (collapsed) {
      return (
        <div key={bridgeId} className="flex flex-col">
          {bridgeSessions.map((session) => renderSessionRow(session))}
        </div>
      );
    }

    return (
      <div key={bridgeId} className="flex flex-col">
        <div
          draggable
          onDragStart={(e) => handleDragStart(e, { kind: "bridge", id: bridgeId })}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => handleDragOver(e, dropKey, "bridge")}
          onDragLeave={() => { setDragOverKey(null); setDragOverZone(null); }}
          onDrop={(e) => handleBridgeDrop(e, bridgeId)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 12px",
            borderBottom: "1px solid var(--border-subtle)",
            borderTop: isDragOver && dragOverZone === "above" ? "2px solid var(--accent)" : "none",
            ...(isDragOver && dragOverZone === "below" ? { borderBottom: "2px solid var(--accent)" } : {}),
            background: "var(--bg-base)",
            cursor: "grab",
            fontFamily: "var(--font-mono)",
            userSelect: "none",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-base)"; }}
        >
          <button
            type="button"
            onClick={() => toggleBridgeCollapsed(bridgeId)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-faint)",
              fontSize: 10,
              padding: 0,
              width: 12,
              lineHeight: 1,
              fontFamily: "var(--font-mono)",
            }}
          >
            {isBridgeCollapsed ? "▸" : "▾"}
          </button>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
            title={bridgeId}
          >
            {label}
          </span>
          <span className={`status-dot ${isOnline ? "status-dot-running" : "status-dot-done"}`} />
          <span style={{ fontSize: 10, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
            {bridgeSessions.length}
          </span>
        </div>
        {!isBridgeCollapsed && bridgeSessions.map((session) => renderSessionRow(session))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {orderedBridgeIds.map((bridgeId) => renderBridgeFolder(bridgeId))}

      {hiddenSessions.length > 0 && !collapsed && (
        <div className="flex flex-col">
          <button
            onClick={() => setHiddenExpanded((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 16px",
              borderBottom: "1px solid var(--border-subtle)",
              borderTop: "1px solid var(--border-subtle)",
              background: "var(--bg-base)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-muted)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-base)"; }}
          >
            <span>Hidden ({hiddenSessions.length})</span>
            <span style={{ fontSize: 10, opacity: 0.6 }}>{hiddenExpanded ? "▾" : "▸"}</span>
          </button>
          {hiddenExpanded && hiddenSessions.map((session) => {
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
                  padding: "8px 16px 8px 28px",
                  borderBottom: "1px solid var(--border-subtle)",
                  borderLeft: `2px solid ${isSelected ? "var(--accent)" : "transparent"}`,
                  background: isSelected ? "var(--bg-elevated)" : "transparent",
                  cursor: "pointer",
                  transition: "background 0.12s ease, border-color 0.12s ease",
                  fontFamily: "var(--font-mono)",
                  display: "block",
                  opacity: 0.6,
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.background = "transparent";
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    style={{
                      fontSize: 11,
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
                  <StatusBadge status={session.status} activity={sessionActivity?.get(session.id)?.activity} />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {contextMenu && onStopSession && onRemoveSession && (
        <ContextMenu
          menu={contextMenu}
          onRename={startEditing}
          onStop={onStopSession}
          onRemove={onRemoveSession}
          onClone={onCloneSession ?? (() => {})}
          onHide={onHideSession ?? (() => {})}
          onUnhide={onUnhideSession ?? (() => {})}
          isHidden={hiddenSet.has(contextMenu.session.id)}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
