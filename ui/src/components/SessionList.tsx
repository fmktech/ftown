"use client";

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Session } from "@/types";
import { SessionActivity } from "@/hooks/useAllSessionEvents";
import { BridgeInfo } from "@/hooks/useBridges";
import { reorderByDrop } from "@/lib/bridge-order";
import { getSessionDropZone, resolveSessionDrop, type SessionDropZone } from "@/lib/session-drop";
import { StatusDot } from "@/lib/StatusDot";
import { usePersistentState, stringSetCodec } from "@/lib/use-persistent-state";
import { formatUsage, formatUsageDetail } from "@/lib/format-usage";
import { collapseToActiveSection } from "@/lib/active-sidebar-section";
import { HarnessIcon } from "./HarnessIcon";
import { SessionStateIndicator } from "./SessionStateIndicator";

interface SessionListProps {
  sessions: Session[];
  bridges: BridgeInfo[];
  bridgeOrder: string[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, name: string) => void;
  onStopSession?: (sessionId: string) => void;
  onRemoveSession?: (sessionId: string, onlyIfFinished?: boolean) => void;
  onCloneSession?: (session: Session) => void;
  onSetSessionParent?: (sessionId: string, parentSessionId: string | null) => void;
  onReorderSessions?: (orderedIds: string[]) => void;
  onReorderBridges?: (orderedBridgeIds: string[]) => void;
  sessionActivity?: Map<string, SessionActivity>;
  collapsed?: boolean;
  hiddenSessionIds?: Set<string>;
  onHideSession?: (sessionId: string) => void;
  onUnhideSession?: (sessionId: string) => void;
  hiddenBridgeIds?: Set<string>;
  onHideBridge?: (bridgeId: string) => void;
  onUnhideBridge?: (bridgeId: string) => void;
  onCreateSession?: (bridgeId: string) => void;
}

type ContextMenuState =
  | { kind: "session"; session: Session; x: number; y: number }
  | { kind: "bridge"; bridgeId: string; x: number; y: number };

type DragState =
  | { kind: "bridge"; id: string }
  | { kind: "session"; id: string; bridgeId: string };

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
}

function bridgeLabel(bridgeId: string, bridges: BridgeInfo[]): string {
  const info = bridges.find((b) => b.bridgeId === bridgeId);
  if (info?.hostname && info.hostname !== "unknown") return info.hostname;
  return bridgeId.length > 20 ? `${bridgeId.slice(0, 18)}…` : bridgeId;
}

function computeDropZone(e: React.DragEvent): "above" | "below" {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const offset = e.clientY - rect.top;
  return offset < rect.height / 2 ? "above" : "below";
}

interface SessionTreeNode {
  session: Session;
  children: SessionTreeNode[];
}

interface FlatSessionRow {
  session: Session;
  depth: number;
  hasChildren: boolean;
  descendantCount: number;
}

interface SessionRowTreeProps {
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  descendantCount: number;
  onToggleCollapse: () => void;
}

interface SessionFolderGroup {
  key: string;
  path: string | null;
  label: string;
  roots: SessionTreeNode[];
}

function normalizeWorkingDir(workingDir?: string): string | null {
  const trimmed = workingDir?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[\\/]+$/, "") || trimmed;
}

function workingDirLabel(workingDir: string | null): string {
  if (workingDir === null) return "No folder";
  const segments = workingDir.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? workingDir;
}

/**
 * Add workspace folders only when they compact repeated roots across a bridge.
 * Singleton workspaces remain direct bridge children, avoiding a folder row
 * that would merely repeat metadata for one agent. Descendants stay attached
 * to their root and are never regrouped using a child's working directory.
 */
function groupSessionRootsByFolder(roots: SessionTreeNode[]): SessionFolderGroup[] | null {
  const byPath = new Map<string, SessionFolderGroup>();
  for (const root of roots) {
    const path = normalizeWorkingDir(root.session.workingDir);
    const key = path ?? "\u0000no-folder";
    const existing = byPath.get(key);
    if (existing) {
      existing.roots.push(root);
    } else {
      byPath.set(key, { key, path, label: workingDirLabel(path), roots: [root] });
    }
  }

  const groups = [...byPath.values()];
  if (groups.length < 2 || groups.every((group) => group.roots.length === 1)) return null;
  return groups;
}

function FolderIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M3 6.75A1.75 1.75 0 0 1 4.75 5h4.1l2 2h8.4A1.75 1.75 0 0 1 21 8.75v8.5A1.75 1.75 0 0 1 19.25 19H4.75A1.75 1.75 0 0 1 3 17.25z" />
    </svg>
  );
}

/**
 * Build a parent→child forest from a pre-sorted list of sessions.
 *
 * A session nests under another only when its parentSessionId points to another
 * session present in the SAME list (callers pass per-bridge visible sessions).
 * Sessions with a missing, self-referential, or out-of-list parent become roots.
 * Ancestor cycles (A→B→A) are detected via a per-node walk and demoted to roots
 * so no node is lost and traversal can never loop. Sibling order mirrors the
 * incoming order because we iterate the list once in place.
 */
function buildSessionTree(orderedSessions: Session[]): SessionTreeNode[] {
  const byId = new Map<string, Session>();
  const nodeById = new Map<string, SessionTreeNode>();
  for (const s of orderedSessions) {
    byId.set(s.id, s);
    nodeById.set(s.id, { session: s, children: [] });
  }

  const hasAncestorCycle = (startId: string): boolean => {
    const seen = new Set<string>();
    let current: string | undefined = startId;
    while (current !== undefined) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = byId.get(current)?.parentSessionId;
    }
    return false;
  };

  const roots: SessionTreeNode[] = [];
  for (const s of orderedSessions) {
    const node = nodeById.get(s.id);
    if (node === undefined) continue;
    const parentId = s.parentSessionId;
    const parentNode =
      parentId !== undefined && parentId !== s.id ? nodeById.get(parentId) : undefined;
    if (parentNode !== undefined && !hasAncestorCycle(s.id)) {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function countTreeDescendants(node: SessionTreeNode): number {
  let total = 0;
  for (const child of node.children) {
    total += 1 + countTreeDescendants(child);
  }
  return total;
}

/** Depth-first flatten that skips the subtree of any collapsed parent. */
function flattenSessionTree(
  roots: SessionTreeNode[],
  collapsedSessions: Set<string>,
): FlatSessionRow[] {
  const rows: FlatSessionRow[] = [];
  const walk = (nodes: SessionTreeNode[], depth: number): void => {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      rows.push({
        session: node.session,
        depth,
        hasChildren,
        descendantCount: hasChildren ? countTreeDescendants(node) : 0,
      });
      if (hasChildren && !collapsedSessions.has(node.session.id)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(roots, 0);
  return rows;
}

const EMPTY_ID_SET: Set<string> = new Set();

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

const contextMenuPanelStyle = {
  position: "fixed" as const,
  zIndex: 9999,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-muted)",
  borderRadius: 6,
  padding: "4px 0",
  minWidth: 120,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.4)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};

function useDismissContextMenu(onClose: () => void, menuRef: React.RefObject<HTMLDivElement | null>): void {
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
  }, [onClose, menuRef]);
}

// Keep a context menu fully on screen: measure it after mount and clamp the
// desired (x, y) into the viewport with a small margin. Without this, menus
// opened on rows near the bottom of the list render partly off-screen.
function useClampedMenuPosition(
  x: number,
  y: number,
  menuRef: React.RefObject<HTMLDivElement | null>,
): { top: number; left: number } {
  const [pos, setPos] = useState({ top: y, left: x });
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const maxLeft = window.innerWidth - rect.width - margin;
    const maxTop = window.innerHeight - rect.height - margin;
    setPos({
      top: Math.max(margin, Math.min(y, maxTop)),
      left: Math.max(margin, Math.min(x, maxLeft)),
    });
  }, [x, y, menuRef]);
  return pos;
}

function ContextMenuButton({
  label,
  onClick,
  color = "var(--text-secondary)",
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  color?: string;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...menuButtonStyle,
        color: disabled ? "var(--text-faint)" : color,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}

function SessionContextMenu({
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
  menu: Extract<ContextMenuState, { kind: "session" }>;
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
  useDismissContextMenu(onClose, menuRef);
  const pos = useClampedMenuPosition(menu.x, menu.y, menuRef);
  useEffect(() => { menuRef.current?.focus(); }, []);

  const isRunning = menu.session.status === "running" || menu.session.status === "pending";

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Session actions"
      tabIndex={-1}
      style={{ ...contextMenuPanelStyle, top: pos.top, left: pos.left, outline: "none" }}
    >
      <ContextMenuButton label="Rename" onClick={() => { onRename(menu.session); onClose(); }} />
      <ContextMenuButton label="Clone" onClick={() => { onClone(menu.session); onClose(); }} />
      {isHidden ? (
        <ContextMenuButton label="Unhide" onClick={() => { onUnhide(menu.session.id); onClose(); }} />
      ) : (
        <ContextMenuButton label="Hide" onClick={() => { onHide(menu.session.id); onClose(); }} />
      )}
      {isRunning && (
        <ContextMenuButton
          label="Stop"
          color="var(--status-error)"
          onClick={() => { onStop(menu.session.id); onClose(); }}
        />
      )}
      <ContextMenuButton
        label="Remove"
        color="var(--status-error)"
        onClick={() => { onRemove(menu.session.id); onClose(); }}
      />
    </div>,
    document.body
  );
}

function BridgeContextMenu({
  menu,
  isOnline,
  isHidden,
  onCreateSession,
  onHide,
  onUnhide,
  onClose,
}: {
  menu: Extract<ContextMenuState, { kind: "bridge" }>;
  isOnline: boolean;
  isHidden: boolean;
  onCreateSession: (bridgeId: string) => void;
  onHide: (bridgeId: string) => void;
  onUnhide: (bridgeId: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissContextMenu(onClose, menuRef);
  const pos = useClampedMenuPosition(menu.x, menu.y, menuRef);
  useEffect(() => { menuRef.current?.focus(); }, []);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Bridge actions"
      tabIndex={-1}
      style={{ ...contextMenuPanelStyle, top: pos.top, left: pos.left, outline: "none" }}
    >
      <ContextMenuButton
        label="Create session"
        disabled={!isOnline}
        onClick={() => {
          if (!isOnline) return;
          onCreateSession(menu.bridgeId);
          onClose();
        }}
      />
      {isHidden ? (
        <ContextMenuButton label="Unhide" onClick={() => { onUnhide(menu.bridgeId); onClose(); }} />
      ) : (
        <ContextMenuButton label="Hide" onClick={() => { onHide(menu.bridgeId); onClose(); }} />
      )}
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
  onSetSessionParent,
  onReorderSessions,
  onReorderBridges,
  sessionActivity,
  collapsed,
  hiddenSessionIds,
  onHideSession,
  onUnhideSession,
  hiddenBridgeIds,
  onHideBridge,
  onUnhideBridge,
  onCreateSession,
}: SessionListProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [dragOverZone, setDragOverZone] = useState<SessionDropZone | null>(null);
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [hiddenBridgesExpanded, setHiddenBridgesExpanded] = useState(false);
  const [collapsedBridges, setCollapsedBridges] = usePersistentState<Set<string>>(
    "ftown:collapsedBridges",
    EMPTY_ID_SET,
    stringSetCodec,
  );
  const [collapsedSessions, setCollapsedSessions] = usePersistentState<Set<string>>(
    "ftown:collapsedSessions",
    EMPTY_ID_SET,
    stringSetCodec,
  );
  const [collapsedFolders, setCollapsedFolders] = usePersistentState<Set<string>>(
    "ftown:collapsedSessionFolders",
    EMPTY_ID_SET,
    stringSetCodec,
  );
  const dragRef = useRef<DragState | null>(null);
  // Inline opacity React rendered on the dragged row, restored on drag end —
  // hardcoding "1" would permanently clear the 0.55 dim on finished rows.
  const dragStartOpacity = useRef<string>("");
  const inputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  // Parent ids whose subtree has already had the default-collapse applied. A
  // parent the user later expands stays expanded because it is never reprocessed;
  // this is persisted so reloads honor that choice instead of re-folding it.
  const seenParentsRef = useRef<Set<string>>(new Set());
  const collapseDefaultsReadyRef = useRef(false);
  const hiddenSet = hiddenSessionIds ?? EMPTY_ID_SET;
  const hiddenBridgeSet = hiddenBridgeIds ?? EMPTY_ID_SET;
  const visibleSessions = useMemo(
    () => sessions.filter((session) => !hiddenSet.has(session.id) && !hiddenBridgeSet.has(session.bridgeId)),
    [hiddenBridgeSet, hiddenSet, sessions],
  );
  const hiddenSessions = useMemo(
    () => sessions.filter((session) => hiddenSet.has(session.id) && !hiddenBridgeSet.has(session.bridgeId)),
    [hiddenBridgeSet, hiddenSet, sessions],
  );

  // seenParents stays a manually-persisted ref (not usePersistentState): the
  // default-collapse effect below must see the restored set synchronously in
  // the same mount commit, which state-based hydration cannot guarantee.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("ftown:seenParents");
      if (raw) seenParentsRef.current = new Set(JSON.parse(raw));
    } catch { /* ignore */ }
    // Gate the default-collapse effect until persisted state is restored, so it
    // never folds a parent the user had previously expanded.
    collapseDefaultsReadyRef.current = true;
  }, []);

  // Collapse each orchestrator's subagents by default: the first time a session
  // is seen acting as a parent, fold its subtree. Tracking seen parents (rather
  // than collapsing on every render) means a parent the user later expands stays
  // expanded, and that choice persists across reloads alongside collapsedSessions.
  useEffect(() => {
    if (!collapseDefaultsReadyRef.current) return;

    const present = new Set(sessions.map((s) => s.id));
    const newParents: string[] = [];
    for (const s of sessions) {
      const parentId = s.parentSessionId;
      if (!parentId || parentId === s.id || !present.has(parentId)) continue;
      if (seenParentsRef.current.has(parentId)) continue;
      seenParentsRef.current.add(parentId);
      newParents.push(parentId);
    }
    if (newParents.length === 0) return;

    try {
      localStorage.setItem("ftown:seenParents", JSON.stringify([...seenParentsRef.current]));
    } catch { /* ignore */ }
    setCollapsedSessions((prev) => {
      const next = new Set(prev);
      for (const id of newParents) next.add(id);
      return next;
    });
  }, [sessions, setCollapsedSessions]);

  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingSessionId]);

  const onlineBridgeIds = useMemo(() => new Set(bridges.map((b) => b.bridgeId)), [bridges]);

  const knownBridgeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const b of bridges) ids.add(b.bridgeId);
    for (const s of visibleSessions) ids.add(s.bridgeId);
    return ids;
  }, [bridges, visibleSessions]);

  const orderedBridgeIds = useMemo(
    () => bridgeOrder.filter((id) => knownBridgeIds.has(id)),
    [bridgeOrder, knownBridgeIds],
  );

  const visibleBridgeIds = useMemo(
    () => orderedBridgeIds.filter((id) => !hiddenBridgeSet.has(id)),
    [orderedBridgeIds, hiddenBridgeSet],
  );

  const selectedBridgeId = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId)?.bridgeId ?? null,
    [selectedSessionId, sessions],
  );

  useEffect(() => {
    setCollapsedBridges((current) => {
      const activeBridgeId = selectedBridgeId
        ?? visibleBridgeIds.find((bridgeId) => !current.has(bridgeId))
        ?? visibleBridgeIds[0]
        ?? null;
      const next = collapseToActiveSection(
        current,
        visibleBridgeIds,
        activeBridgeId,
      );
      if (
        next.size === current.size &&
        [...next].every((sectionId) => current.has(sectionId))
      ) {
        return current;
      }
      return next;
    });
  }, [selectedBridgeId, setCollapsedBridges, visibleBridgeIds]);

  useEffect(() => {
    if (selectedSessionId === null) return;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const ancestors = new Set<string>();
    let current = byId.get(selectedSessionId);
    while (current?.parentSessionId && !ancestors.has(current.parentSessionId)) {
      ancestors.add(current.parentSessionId);
      current = byId.get(current.parentSessionId);
    }
    if (ancestors.size === 0) return;
    setCollapsedSessions((collapsedIds) => {
      const next = new Set(collapsedIds);
      for (const ancestorId of ancestors) next.delete(ancestorId);
      return next.size === collapsedIds.size ? collapsedIds : next;
    });
  }, [selectedSessionId, sessions, setCollapsedSessions]);

  useEffect(() => {
    if (selectedSessionId === null) return;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    let root = byId.get(selectedSessionId);
    const seen = new Set<string>();
    while (root?.parentSessionId && !seen.has(root.parentSessionId)) {
      seen.add(root.parentSessionId);
      const parent = byId.get(root.parentSessionId);
      if (!parent || parent.bridgeId !== root.bridgeId) break;
      root = parent;
    }
    if (!root) return;
    const folderKey = `${root.bridgeId}:${normalizeWorkingDir(root.workingDir) ?? "\u0000no-folder"}`;
    setCollapsedFolders((current) => {
      if (!current.has(folderKey)) return current;
      const next = new Set(current);
      next.delete(folderKey);
      return next;
    });
  }, [selectedSessionId, sessions, setCollapsedFolders]);

  const hiddenBridgeIdsList = useMemo(
    () => orderedBridgeIds.filter((id) => hiddenBridgeSet.has(id)),
    [orderedBridgeIds, hiddenBridgeSet],
  );

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
    setEditValue(session.name || session.prompt?.slice(0, 36) || "Session");
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
    setContextMenu({ kind: "session", session, x: e.clientX, y: e.clientY });
  }

  function handleBridgeContextMenu(e: React.MouseEvent, bridgeId: string): void {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ kind: "bridge", bridgeId, x: e.clientX, y: e.clientY });
  }

  function clearDragState(): void {
    dragRef.current = null;
    setDragOverKey(null);
    setDragOverZone(null);
  }

  function handleDragStart(e: React.DragEvent, state: DragState): void {
    dragRef.current = state;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", state.id);
    const el = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    if (el) {
      dragStartOpacity.current = el.style.opacity;
      el.style.opacity = "0.4";
    }
  }

  function handleDragEnd(e: React.DragEvent): void {
    clearDragState();
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = dragStartOpacity.current;
    }
  }

  function rejectDragOver(e?: React.DragEvent): void {
    if (e) e.dataTransfer.dropEffect = "none";
    setDragOverKey(null);
    setDragOverZone(null);
  }

  function handleSessionDragOver(e: React.DragEvent, targetSession: Session): void {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const drag = dragRef.current;
    if (!drag || drag.kind !== "session") {
      rejectDragOver(e);
      return;
    }
    const draggedSession = sessions.find((session) => session.id === drag.id);
    if (!draggedSession) {
      rejectDragOver(e);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zone = getSessionDropZone(e.clientY - rect.top, rect.height);
    const action = resolveSessionDrop(
      {
        id: drag.id,
        bridgeId: drag.bridgeId,
        hasChildren: sessions.some((session) => session.parentSessionId === drag.id),
      },
      {
        kind: "session",
        id: targetSession.id,
        bridgeId: targetSession.bridgeId,
        parentSessionId: targetSession.parentSessionId,
        zone,
      },
    );
    const needsParentChange =
      action?.type === "set-parent" ||
      (action?.type === "reorder" &&
        (draggedSession.parentSessionId ?? null) !== action.parentSessionId);
    if (!action || (needsParentChange && !onSetSessionParent)) {
      rejectDragOver(e);
      return;
    }
    setDragOverKey(`session:${targetSession.id}`);
    setDragOverZone(zone);
  }

  function handleBridgeDragOver(e: React.DragEvent, targetBridgeId: string): void {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const drag = dragRef.current;
    if (!drag) {
      rejectDragOver(e);
      return;
    }
    if (drag.kind === "bridge") {
      if (drag.id === targetBridgeId) {
        rejectDragOver(e);
        return;
      }
      setDragOverKey(`bridge:${targetBridgeId}`);
      setDragOverZone(computeDropZone(e));
      return;
    }
    if (drag.bridgeId !== targetBridgeId || !onSetSessionParent) {
      rejectDragOver(e);
      return;
    }
    setDragOverKey(`bridge:${targetBridgeId}`);
    setDragOverZone("inside");
  }

  function handleBridgeDrop(e: React.DragEvent, targetBridgeId: string): void {
    e.preventDefault();
    const drag = dragRef.current;
    if (!drag) {
      clearDragState();
      return;
    }
    if (drag.kind === "session") {
      const action = resolveSessionDrop(
        { id: drag.id, bridgeId: drag.bridgeId },
        { kind: "bridge", bridgeId: targetBridgeId },
      );
      if (action?.type === "set-parent" && onSetSessionParent) {
        onSetSessionParent(action.sessionId, action.parentSessionId);
      }
      clearDragState();
      return;
    }
    if (drag.kind !== "bridge" || !onReorderBridges) {
      clearDragState();
      return;
    }
    const draggedId = drag.id;
    if (draggedId === targetBridgeId) {
      clearDragState();
      return;
    }

    const zone = computeDropZone(e);
    const reordered = reorderByDrop(orderedBridgeIds, draggedId, targetBridgeId, zone);
    if (reordered) {
      onReorderBridges(reordered);
    }
    clearDragState();
  }

  function handleSessionDrop(e: React.DragEvent, targetSession: Session): void {
    e.preventDefault();
    const drag = dragRef.current;
    if (!drag || drag.kind !== "session") {
      clearDragState();
      return;
    }
    const draggedSession = sessions.find((session) => session.id === drag.id);
    if (!draggedSession) {
      clearDragState();
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const action = resolveSessionDrop(
      {
        id: drag.id,
        bridgeId: drag.bridgeId,
        hasChildren: sessions.some((session) => session.parentSessionId === drag.id),
      },
      {
        kind: "session",
        id: targetSession.id,
        bridgeId: targetSession.bridgeId,
        parentSessionId: targetSession.parentSessionId,
        zone: getSessionDropZone(e.clientY - rect.top, rect.height),
      },
    );
    if (!action) {
      clearDragState();
      return;
    }
    if (action.type === "set-parent") {
      onSetSessionParent?.(action.sessionId, action.parentSessionId);
      clearDragState();
      return;
    }
    if (!onReorderSessions) {
      clearDragState();
      return;
    }

    if ((draggedSession.parentSessionId ?? null) !== action.parentSessionId) {
      if (!onSetSessionParent) {
        clearDragState();
        return;
      }
      onSetSessionParent(action.sessionId, action.parentSessionId);
    }

    const draggedId = action.sessionId;
    const zone = action.zone;
    const bridgeSessions = sessionsByBridge.get(targetSession.bridgeId) ?? [];
    // Compute indices against the full DFS tree order (the same order rendered),
    // not the raw flat array, so dragging matches what the user sees. Use an
    // empty collapsed set so collapsed subtrees keep their position and all
    // session ids remain in the persisted order.
    const ids = flattenSessionTree(buildSessionTree(bridgeSessions), new Set<string>()).map(
      (row) => row.session.id,
    );
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
      if (next.has(bridgeId)) {
        for (const visibleBridgeId of visibleBridgeIds) next.add(visibleBridgeId);
        next.delete(bridgeId);
      } else {
        next.add(bridgeId);
      }
      return next;
    });
  }

  function toggleSessionCollapsed(sessionId: string): void {
    setCollapsedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  if (visibleSessions.length === 0 && visibleBridgeIds.length === 0 && hiddenSessions.length === 0 && hiddenBridgeIdsList.length === 0) {
    if (collapsed) return null;
    return (
      <div
        className="flex flex-col items-center justify-center p-8 text-center fade-in"
        style={{ color: "var(--text-faint)", fontSize: 11, gap: 8 }}
      >
        <span aria-hidden style={{ fontSize: 20, color: "var(--text-faint)" }}>›_</span>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>No sessions yet</span>
        <span style={{ color: "var(--text-faint)" }}>Click + above to start your first session</span>
      </div>
    );
  }

  function renderSessionRow(session: Session, treeProps?: SessionRowTreeProps): ReactElement {
    const isSelected = session.id === selectedSessionId;
    const displayName = session.name || session.prompt?.slice(0, 36) || "Session";
    const dropKey = `session:${session.id}`;
    const isDragOver = dragOverKey === dropKey;
    const depth = treeProps?.depth ?? 0;
    const isFinished = session.status === "completed" || session.status === "error";

    if (collapsed) {
      const act = sessionActivity?.get(session.id);
      const isRunning = session.status === "running";
      const isIdle = isRunning && act?.activity === "idle";
      const isThinking = isRunning && act?.activity === "thinking";
      const isToolUse = isRunning && act?.activity === "tool_use";

      const borderColor = session.status === "error" ? "var(--status-error)"
        : session.status === "pending" ? "var(--status-pending)"
        : isThinking ? "var(--status-thinking)"
        : isToolUse ? "var(--status-tool-use)"
        : isRunning ? "var(--status-done)"
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
            opacity: isFinished ? 0.55 : 1,
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
        onDragOver={(e) => handleSessionDragOver(e, session)}
        onDragLeave={() => { setDragOverKey(null); setDragOverZone(null); }}
        onDrop={(e) => handleSessionDrop(e, session)}
        title="Drop on an edge to reorder within that subgroup, or in the center of a root session to move under it"
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
            setContextMenu({ kind: "session", session, x: touch.clientX, y: touch.clientY });
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
          padding: isSelected
            ? `9px 12px 9px ${18 + depth * 10}px`
            : `6px 12px 6px ${18 + depth * 10}px`,
          borderBottom: "1px solid var(--border-subtle)",
          borderTop: isDragOver && dragOverZone === "above" ? "2px solid var(--accent)" : "none",
          ...(isDragOver && dragOverZone === "below" ? { borderBottom: "2px solid var(--accent)" } : {}),
          boxShadow: isDragOver && dragOverZone === "inside" ? "inset 0 0 0 2px var(--accent)" : "none",
          borderLeft: `2px solid ${isSelected ? "var(--accent)" : depth > 0 ? "var(--border-muted)" : "transparent"}`,
          background: isSelected ? "var(--bg-elevated)" : "transparent",
          cursor: "grab",
          transition: "background 0.12s ease, border-color 0.12s ease",
          fontFamily: "var(--font-mono)",
          display: "block",
          opacity: isFinished ? 0.55 : 1,
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.background = "transparent";
        }}
      >
        <div className={`flex items-center justify-between gap-2 ${isSelected ? "mb-1" : ""}`}>
          <div className="flex items-center gap-1.5" style={{ flex: 1, minWidth: 0 }}>
          {treeProps?.hasChildren ? (
            <span
              role="button"
              tabIndex={0}
              aria-expanded={!treeProps.isCollapsed}
              aria-label={treeProps.isCollapsed ? "Expand children" : "Collapse children"}
              onClick={(e) => {
                e.stopPropagation();
                treeProps.onToggleCollapse();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  treeProps.onToggleCollapse();
                }
              }}
              title={treeProps.isCollapsed ? "Expand children" : "Collapse children"}
              style={{
                cursor: "pointer",
                color: "var(--text-faint)",
                fontSize: 9,
                width: 10,
                lineHeight: 1,
                flexShrink: 0,
                userSelect: "none",
              }}
            >
              {treeProps.isCollapsed ? "▸" : "▾"}
            </span>
          ) : depth > 0 ? (
            <span style={{ width: 10, flexShrink: 0 }} />
          ) : null}
          <HarnessIcon harness={session.shellType} size={17} />
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
              title={session.prompt || displayName}
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
          {treeProps?.isCollapsed && treeProps.descendantCount > 0 && (
            <span
              title={`${treeProps.descendantCount} hidden child session${treeProps.descendantCount === 1 ? "" : "s"}`}
              style={{
                fontSize: 9,
                fontWeight: 600,
                lineHeight: 1,
                padding: "1px 5px",
                borderRadius: 8,
                flexShrink: 0,
                color: "var(--accent)",
                background: "rgba(0, 255, 136, 0.08)",
                border: "1px solid rgba(0, 255, 136, 0.15)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {treeProps.descendantCount}
            </span>
          )}
          </div>
          <div className="flex items-center gap-1.5" style={{ flexShrink: 0 }}>
            <SessionStateIndicator
              status={session.status}
              activity={sessionActivity?.get(session.id)?.activity}
              needsInput={Boolean(sessionActivity?.get(session.id)?.attention)}
            />
            <span
              title={new Date(session.createdAt).toLocaleString()}
              style={{ fontSize: 10, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}
            >
              {formatTimestamp(session.createdAt)}
            </span>
            <span
              role="button"
              tabIndex={0}
              aria-haspopup="menu"
              aria-label="Session actions"
              title="Session actions"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setContextMenu({ kind: "session", session, x: r.right, y: r.bottom + 4 });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setContextMenu({ kind: "session", session, x: r.right, y: r.bottom + 4 });
                }
              }}
              style={{
                cursor: "pointer",
                color: "var(--text-faint)",
                fontSize: 16,
                lineHeight: 1,
                padding: "2px 4px",
                userSelect: "none",
                flexShrink: 0,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
            >
              ⋮
            </span>
          </div>
        </div>

        {sessionActivity?.get(session.id)?.attention && (
          <div
            title={sessionActivity.get(session.id)?.attention?.message}
            style={{
              fontSize: 10,
              color: "var(--status-pending)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginBottom: 2,
            }}
          >
            <span aria-hidden style={{ marginRight: 4 }}>!</span>
            {sessionActivity.get(session.id)?.attention?.message ?? "Session needs your input"}
          </div>
        )}

        {isSelected && session.status === "running" && (() => {
          const act = sessionActivity?.get(session.id);
          if (!act || act.activity === "idle") return null;
          const isThinking = act.activity === "thinking";
          return (
            <div
              style={{
                fontSize: 10,
                color: isThinking ? "var(--status-thinking)" : "var(--status-tool-use)",
                fontStyle: "italic",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                marginBottom: 2,
                ...(isThinking ? { animation: "pulse-pending 2s ease-in-out infinite" } : {}),
              }}
            >
              <span aria-hidden style={{ fontStyle: "normal", marginRight: 4 }}>
                {isThinking ? "◌" : "⚙"}
              </span>
              {isThinking ? "thinking..." : `using ${act.toolName ?? "tool"}`}
            </div>
          );
        })()}

        {isSelected && session.name && (
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

        {isSelected && session.usage && (
          <p
            title={formatUsageDetail(session.usage)}
            style={{
              fontSize: 10,
              color: "var(--text-faint)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginBottom: 4,
            }}
          >
            {formatUsage(session.usage)}
          </p>
        )}

        {isSelected && session.model && session.shellType !== "shell" && (
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 10, color: "var(--text-faint)" }}>
              {session.model}
            </span>
          </div>
        )}
      </button>
    );
  }

  function renderBridgeFolder(bridgeId: string): ReactElement | null {
    const bridgeSessions = sessionsByBridge.get(bridgeId) ?? [];
    if (bridgeSessions.length === 0 && collapsed) return null;

    const isBridgeCollapsed = collapsedBridges.has(bridgeId);
    const isActiveBridge = !isBridgeCollapsed;
    const isOnline = onlineBridgeIds.has(bridgeId);
    const label = bridgeLabel(bridgeId, bridges);
    const finishedSessions = bridgeSessions.filter(
      (s) => s.status === "completed" || s.status === "error",
    );
    const dropKey = `bridge:${bridgeId}`;
    const isDragOver = dragOverKey === dropKey;
    const sessionTree = buildSessionTree(bridgeSessions);
    const folderGroups = groupSessionRootsByFolder(sessionTree);

    const renderTree = (roots: SessionTreeNode[], depthOffset = 0): ReactElement[] =>
      flattenSessionTree(roots, collapsedSessions).map((row) =>
        renderSessionRow(row.session, {
          depth: row.depth + depthOffset,
          hasChildren: row.hasChildren,
          isCollapsed: collapsedSessions.has(row.session.id),
          descendantCount: row.descendantCount,
          onToggleCollapse: () => toggleSessionCollapsed(row.session.id),
        }),
      );

    if (collapsed) {
      return (
        <div key={bridgeId} className="flex flex-col">
          {bridgeSessions.map((session) => renderSessionRow(session))}
        </div>
      );
    }

    return (
      <div
        key={bridgeId}
        className={`mx-2 my-1 flex flex-col overflow-hidden rounded-xl border ${
          isActiveBridge ? "border-zinc-700/80 bg-zinc-900/80" : "border-transparent"
        }`}
      >
        <div
          onDragOver={(e) => handleBridgeDragOver(e, bridgeId)}
          onDragLeave={() => { setDragOverKey(null); setDragOverZone(null); }}
          onDrop={(e) => handleBridgeDrop(e, bridgeId)}
          title="Drop a child session here to move it back to the bridge root"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 9px",
            borderBottom: !isBridgeCollapsed ? "1px solid var(--border-subtle)" : "none",
            borderTop: isDragOver && dragOverZone === "above" ? "2px solid var(--accent)" : "none",
            ...(isDragOver && dragOverZone === "below" ? { borderBottom: "2px solid var(--accent)" } : {}),
            boxShadow: isDragOver && dragOverZone === "inside" ? "inset 0 0 0 2px var(--accent)" : "none",
            background: isDragOver && dragOverZone === "inside"
              ? "var(--bg-hover)"
              : isActiveBridge
                ? "var(--bg-elevated)"
                : "transparent",
            fontFamily: "var(--font-mono)",
            userSelect: "none",
          }}
          onContextMenu={(e) => handleBridgeContextMenu(e, bridgeId)}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = isActiveBridge ? "var(--bg-elevated)" : "transparent";
          }}
        >
          <span
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              handleDragStart(e, { kind: "bridge", id: bridgeId });
            }}
            onDragEnd={handleDragEnd}
            title="Drag to reorder"
            style={{
              cursor: "grab",
              color: "var(--text-faint)",
              fontSize: 10,
              lineHeight: 1,
              padding: "0 2px",
              flexShrink: 0,
              letterSpacing: "-2px",
            }}
          >
            ⠿
          </span>
          <button
            type="button"
            aria-expanded={!isBridgeCollapsed}
            aria-label={`${isBridgeCollapsed ? "Expand" : "Collapse"} ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleBridgeCollapsed(bridgeId);
            }}
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
          {finishedSessions.length > 0 && onRemoveSession && (
            <button
              type="button"
              disabled={!isOnline}
              title={isOnline
                ? `Clear ${finishedSessions.length} completed/error session${finishedSessions.length === 1 ? "" : "s"}`
                : "Bridge is offline — sessions cannot be removed"}
              onClick={(e) => {
                e.stopPropagation();
                const count = finishedSessions.length;
                if (!window.confirm(`Remove ${count} completed/error session${count === 1 ? "" : "s"} from ${label}?`)) return;
                // onlyIfFinished: the bridge re-checks status, so a session
                // retried back to running since this render is not killed.
                for (const s of finishedSessions) onRemoveSession(s.id, true);
              }}
              style={{
                background: "none",
                border: "none",
                cursor: isOnline ? "pointer" : "default",
                opacity: isOnline ? 1 : 0.4,
                color: "var(--text-faint)",
                fontSize: 10,
                padding: "0 2px",
                lineHeight: 1,
                flexShrink: 0,
                fontFamily: "var(--font-mono)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--status-error)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}
            >
              ✕
            </button>
          )}
          <StatusDot kind={isOnline ? "connected" : "disconnected"} />
          <span style={{ fontSize: 10, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
            {bridgeSessions.length}
          </span>
        </div>
        {!isBridgeCollapsed && (folderGroups === null
          ? renderTree(sessionTree)
          : folderGroups.flatMap((group) => {
              if (group.roots.length === 1) return renderTree(group.roots);
              const folderKey = `${bridgeId}:${group.key}`;
              const isFolderCollapsed = collapsedFolders.has(folderKey);
              return [
                <div
                  key={`folder:${bridgeId}:${group.key}`}
                  role="group"
                  aria-label={`Sessions in ${group.label}`}
                  title={group.path ?? "Sessions without a working folder"}
                  style={{ borderBottom: "1px solid var(--border-subtle)" }}
                >
                  <button
                    type="button"
                    aria-expanded={!isFolderCollapsed}
                    aria-label={`${isFolderCollapsed ? "Expand" : "Collapse"} folder ${group.label}`}
                    onClick={() => {
                      setCollapsedFolders((current) => {
                        const next = new Set(current);
                        if (next.has(folderKey)) next.delete(folderKey);
                        else next.add(folderKey);
                        return next;
                      });
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      minWidth: 0,
                      padding: "6px 12px 5px 17px",
                      color: "var(--text-muted)",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "var(--font-mono)",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <span aria-hidden style={{ width: 8, flexShrink: 0, fontSize: 9, color: "var(--text-faint)" }}>
                      {isFolderCollapsed ? "▸" : "▾"}
                    </span>
                    <FolderIcon />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {group.label}
                    </span>
                    <span
                      aria-label={`${group.roots.length} root agents`}
                      style={{ fontSize: 9, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}
                    >
                      {group.roots.length}
                    </span>
                  </button>
                  {!isFolderCollapsed && renderTree(group.roots, 1)}
                </div>,
              ];
            }))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {visibleBridgeIds.map((bridgeId) => renderBridgeFolder(bridgeId))}

      {hiddenBridgeIdsList.length > 0 && !collapsed && (
        <div className="flex flex-col">
          <button
            onClick={() => setHiddenBridgesExpanded((v) => !v)}
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
            <span>Hidden bridges ({hiddenBridgeIdsList.length})</span>
            <span style={{ fontSize: 10, opacity: 0.6 }}>{hiddenBridgesExpanded ? "▾" : "▸"}</span>
          </button>
          {hiddenBridgesExpanded && hiddenBridgeIdsList.map((bridgeId) => renderBridgeFolder(bridgeId))}
        </div>
      )}

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
            const displayName = session.name || session.prompt?.slice(0, 36) || "Session";
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
                  <HarnessIcon harness={session.shellType} size={16} />
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
                  <SessionStateIndicator
                    status={session.status}
                    activity={sessionActivity?.get(session.id)?.activity}
                    needsInput={Boolean(sessionActivity?.get(session.id)?.attention)}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {contextMenu?.kind === "session" && onStopSession && onRemoveSession && (
        <SessionContextMenu
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
      {contextMenu?.kind === "bridge" && (
        <BridgeContextMenu
          menu={contextMenu}
          isOnline={onlineBridgeIds.has(contextMenu.bridgeId)}
          isHidden={hiddenBridgeSet.has(contextMenu.bridgeId)}
          onCreateSession={onCreateSession ?? (() => {})}
          onHide={onHideBridge ?? (() => {})}
          onUnhide={onUnhideBridge ?? (() => {})}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
