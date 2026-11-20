"use client";

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Session } from "@/types";
import { SessionActivity } from "@/hooks/useAllSessionEvents";
import { BridgeInfo } from "@/hooks/useBridges";
import { getSessionDropZone, resolveSessionDrop, type SessionDropZone } from "@/lib/session-drop";
import { StatusDot } from "@/lib/StatusDot";
import { usePersistentState, stringSetCodec } from "@/lib/use-persistent-state";
import { parsePullRequestUrl } from "@/lib/pull-request-url";
import { HarnessIcon } from "./HarnessIcon";
import { SessionStateIndicator } from "./SessionStateIndicator";
import { HandoffDialog, SessionBlockBadge } from "./SessionBlockBadge";
import { SessionCardChip, formatCardRollup, rollupChildCards } from "./SessionCardChip";
import { PullRequestBadgePlaceholder, PullRequestLink } from "./PullRequestLink";
import type { BridgeSecurityState } from "@security/protocol";
import { bridgeConnectionLock, SecurityLockIcon } from "./SecurityLockIcon";
import type { UpdateView } from "@/hooks/useBridgeUpdates";

export function SessionAccountBadge({ account }: { account?: string }) {
  if (!account || account === "default") return null;
  return <span aria-label={`Account: ${account}`} title={`Account: ${account}`}
    className="inline-flex max-w-28 shrink-0 items-center truncate rounded border border-[var(--border-muted)] bg-[var(--bg-base)] px-1.5 py-px font-mono text-[10px] leading-4 text-[var(--text-muted)]">{account}</span>;
}

interface SessionListProps {
  sessions: Session[];
  bridges: BridgeInfo[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onReviewPullRequest?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, name: string) => void;
  onStopSession?: (sessionId: string) => void;
  onRemoveSession?: (sessionId: string, onlyIfFinished?: boolean) => void;
  onCloneSession?: (session: Session) => void;
  onSetSessionParent?: (sessionId: string, parentSessionId: string | null) => void;
  onReorderSessions?: (orderedIds: string[]) => void;
  onHiddenProjectsChange?: (projects: Set<string>) => void;
  sessionActivity?: Map<string, SessionActivity>;
  collapsed?: boolean;
  onCreateSession?: (bridgeId: string) => void;
  onOpenSecurity?: (bridgeId: string) => void;
  bridgeSecurityStates?: ReadonlyMap<string, BridgeSecurityState["status"]>;
  bridgeUpdates?: ReadonlyMap<string, UpdateView>;
  onOpenUpdates?: (bridgeId: string) => void;
  onOpenModelRouting?: (bridgeId: string) => void;
  onHandoff?: (sessionId: string, input: { shellType?: string; model?: string; name?: string }) => Promise<void>;
  onDismissBlock?: (session: Session) => Promise<void>;
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

/**
 * Build a parent→child forest from a pre-sorted list of sessions.
 *
 * A session nests under another only when its parentSessionId points to another
 * session present in the account-wide list.
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
    // A scroll that was already under way when the menu opened (the list settling after a section expanded, or the row being
    // brought into view for the very click that opened it) reports its event on the next frame. That event is not the user
    // scrolling away from the menu, so scrolls only dismiss from the frame after the one the menu opened in.
    const armed = requestAnimationFrame(() => window.addEventListener("scroll", handleScroll, true));
    return () => {
      cancelAnimationFrame(armed);
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
  largeOnMobile = false,
}: {
  label: string;
  onClick: () => void;
  color?: string;
  disabled?: boolean;
  largeOnMobile?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`${largeOnMobile ? "min-h-11 text-sm md:min-h-0 md:text-[11px]" : ""} session-context-menu-item`}
      style={{
        ...menuButtonStyle,
        fontSize: largeOnMobile ? undefined : menuButtonStyle.fontSize,
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
  onReviewPullRequest,
  onStop,
  onRemove,
  onClone,
  onHandoff,
  onDismissBlock,
  onClose,
}: {
  menu: Extract<ContextMenuState, { kind: "session" }>;
  onRename: (session: Session) => void;
  onReviewPullRequest?: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  onRemove: (sessionId: string) => void;
  onClone: (session: Session) => void;
  onHandoff?: (session: Session) => void;
  onDismissBlock?: (session: Session) => Promise<void>;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissContextMenu(onClose, menuRef);
  const pos = useClampedMenuPosition(menu.x, menu.y, menuRef);
  useEffect(() => { menuRef.current?.focus(); }, []);

  const isRunning = menu.session.status === "running" || menu.session.status === "pending";
  const pullRequest = parsePullRequestUrl(menu.session.pullRequestUrl);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Session actions"
      tabIndex={-1}
      className="w-[220px] max-w-[calc(100vw-16px)] md:w-auto md:max-w-none md:min-w-[120px]"
      style={{ ...contextMenuPanelStyle, minWidth: undefined, top: pos.top, left: pos.left, outline: "none" }}
    >
      {pullRequest && onReviewPullRequest ? (
        <ContextMenuButton largeOnMobile label="Review pull request" color="var(--accent)" onClick={() => { onReviewPullRequest(menu.session.id); onClose(); }} />
      ) : pullRequest && (
        <a
          role="menuitem"
          href={pullRequest.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open pull request: PR #${pullRequest.number} in ${pullRequest.repository}: ${pullRequest.url}`}
          title={pullRequest.url}
          className="min-h-11 text-sm md:min-h-0 md:text-[11px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
          style={{ ...menuButtonStyle, fontSize: undefined, color: "var(--accent)" }}
          onClick={(event) => { event.stopPropagation(); onClose(); }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        >
          Open pull request
        </a>
      )}
      {menu.session.block && onHandoff && (
        <ContextMenuButton largeOnMobile label="Hand off" color="var(--status-pending)" onClick={() => { onHandoff(menu.session); onClose(); }} />
      )}
      {menu.session.block && onDismissBlock && (
        <ContextMenuButton largeOnMobile label="Dismiss badge" onClick={() => { void onDismissBlock(menu.session).catch(console.error); onClose(); }} />
      )}
      <ContextMenuButton largeOnMobile label="Rename" onClick={() => { onRename(menu.session); onClose(); }} />
      <ContextMenuButton largeOnMobile label="Clone" onClick={() => { onClone(menu.session); onClose(); }} />
      {isRunning && (
        <ContextMenuButton
          largeOnMobile
          label="Stop"
          color="var(--status-error)"
          onClick={() => { onStop(menu.session.id); onClose(); }}
        />
      )}
      <ContextMenuButton
        largeOnMobile
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
  onCreateSession,
  onOpenSecurity,
  onOpenUpdates,
  onOpenModelRouting,
  onClose,
}: {
  menu: Extract<ContextMenuState, { kind: "bridge" }>;
  isOnline: boolean;
  onCreateSession: (bridgeId: string) => void;
  onOpenSecurity?: (bridgeId: string) => void;
  onOpenUpdates?: (bridgeId: string) => void;
  onOpenModelRouting?: (bridgeId: string) => void;
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
      {onOpenSecurity && <ContextMenuButton largeOnMobile label="Security log" onClick={() => { onOpenSecurity(menu.bridgeId); onClose(); }} />}
      {onOpenUpdates && <ContextMenuButton largeOnMobile label="Updates…" onClick={() => { onOpenUpdates(menu.bridgeId); onClose(); }} />}
      {onOpenModelRouting && <ContextMenuButton largeOnMobile label="Model routing…" onClick={() => { onOpenModelRouting(menu.bridgeId); onClose(); }} />}
    </div>,
    document.body
  );
}

export function SessionList({
  bridges, onCreateSession, onOpenSecurity, onOpenUpdates, onOpenModelRouting,
  sessions, bridgeSecurityStates, bridgeUpdates, onHiddenProjectsChange,
  selectedSessionId,
  onSelectSession,
  onReviewPullRequest,
  onRenameSession,
  onStopSession,
  onRemoveSession,
  onCloneSession,
  onSetSessionParent,
  onReorderSessions,
  sessionActivity,
  collapsed,
  onHandoff,
  onDismissBlock,
}: SessionListProps) {
  const [handoffTarget, setHandoffTarget] = useState<Session | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [dragOverZone, setDragOverZone] = useState<SessionDropZone | null>(null);
  const [hiddenProjects, setHiddenProjects] = usePersistentState<Set<string>>("ftown:hiddenProjects", EMPTY_ID_SET, stringSetCodec);
  useEffect(() => { onHiddenProjectsChange?.(hiddenProjects); }, [hiddenProjects, onHiddenProjectsChange]);
  const [collapsedSessions, setCollapsedSessions] = usePersistentState<Set<string>>(
    "ftown:collapsedSessions",
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

  // A blocked child has to be on the board. Expand its parent once per
  // transition, after the default fold above, and then leave a manual
  // collapse alone.
  const revealedBlocksRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!collapseDefaultsReadyRef.current) return;
    const parents: string[] = [];
    for (const session of sessions) {
      const key = session.block?.transitionKey;
      const parentId = session.parentSessionId;
      if (!key || !parentId || parentId === session.id) continue;
      const mark = `${session.id}:${key}`;
      if (revealedBlocksRef.current.has(mark)) continue;
      revealedBlocksRef.current.add(mark);
      parents.push(parentId);
    }
    if (parents.length === 0) return;
    setCollapsedSessions((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of parents) {
        if (next.delete(id)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessions, setCollapsedSessions]);

  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingSessionId]);

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

  /** parentId → rollup text for children card states, computed once per render. */
  const cardRollups = useMemo(() => {
    const parentIds = new Set<string>();
    for (const s of sessions) {
      if (s.parentSessionId && !parentIds.has(s.parentSessionId)) parentIds.add(s.parentSessionId);
    }
    const map = new Map<string, string>();
    for (const parentId of parentIds) {
      const rollup = formatCardRollup(rollupChildCards(sessions, parentId));
      if (rollup) map.set(parentId, rollup);
    }
    return map;
  }, [sessions]);

  const bridgeMenuAnchor = useRef<HTMLButtonElement>(null);
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    bridgeMenuAnchor.current?.focus();
    bridgeMenuAnchor.current = null;
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
    // Compute indices against the full DFS tree order (the same order rendered),
    // not the raw flat array, so dragging matches what the user sees. Use an
    // empty collapsed set so collapsed subtrees keep their position and all
    // session ids remain in the persisted order.
    const ids = flattenSessionTree(buildSessionTree(sessions), new Set<string>()).map(
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

    onReorderSessions(ids);
    clearDragState();
  }

  function toggleSessionCollapsed(sessionId: string): void {
    setCollapsedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
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

    const hasPullRequest = Boolean(parsePullRequestUrl(session.pullRequestUrl));
    const hasCollapsedCount = Boolean(treeProps?.isCollapsed && treeProps.descendantCount > 0);
    const headerTopPadding = (isSelected ? 9 : 6) + (isDragOver && dragOverZone === "above" ? 2 : 0);
    const headerBottomMargin = isSelected ? 4 : 0;

    return (
      <div
        key={session.id}
        data-session-row={session.id}
        className="min-w-0"
        style={{
          display: "grid",
          gridTemplateColumns: `minmax(96px, 1fr) ${hasPullRequest ? 6 : 0}px minmax(0, max-content) ${hasCollapsedCount ? 6 : 0}px auto 8px auto`,
          gridTemplateRows: "auto auto",
          borderBottom: "1px solid var(--border-subtle)",
          background: isSelected ? "var(--bg-elevated)" : "transparent",
        }}
      >
      <button
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
          gridColumn: "1 / -1",
          gridRow: "1 / 3",
          gridTemplateColumns: "subgrid",
          gridTemplateRows: "subgrid",
          minWidth: 0,
          textAlign: "left",
          padding: isSelected
            ? `9px 12px 9px ${18 + depth * 10}px`
            : `6px 12px 6px ${18 + depth * 10}px`,
          borderBottom: "none",
          borderTop: isDragOver && dragOverZone === "above" ? "2px solid var(--accent)" : "none",
          ...(isDragOver && dragOverZone === "below" ? { borderBottom: "2px solid var(--accent)" } : {}),
          boxShadow: isDragOver && dragOverZone === "inside" ? "inset 0 0 0 2px var(--accent)" : "none",
          borderLeft: `2px solid ${isSelected ? "var(--accent)" : depth > 0 ? "var(--border-muted)" : "transparent"}`,
          background: isSelected ? "var(--bg-elevated)" : "transparent",
          cursor: "grab",
          transition: "background 0.12s ease, border-color 0.12s ease",
          fontFamily: "var(--font-mono)",
          display: "grid",
          opacity: isFinished ? 0.55 : 1,
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.background = "transparent";
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "subgrid", gridColumn: "1 / -1", gridRow: 1, alignItems: "center", marginBottom: headerBottomMargin }}>
          <div className="flex items-center gap-1.5" style={{ gridColumn: 1, minWidth: 0 }}>
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
          <SessionAccountBadge account={session.account} />
          </div>
          <div style={{ gridColumn: 3, display: "flex", minWidth: 0, alignItems: "center" }}>
            <PullRequestBadgePlaceholder url={session.pullRequestUrl} />
          </div>
          {treeProps?.isCollapsed && treeProps.descendantCount > 0 && (
            <span
              title={`${treeProps.descendantCount} hidden child session${treeProps.descendantCount === 1 ? "" : "s"}`}
              style={{
                gridColumn: 5,
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
          <div className="flex items-center gap-1.5" style={{ gridColumn: 7 }}>
            {session.block && <SessionBlockBadge block={session.block} />}
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
              aria-expanded={contextMenu?.kind === "session" && contextMenu.session.id === session.id}
              aria-label="Session actions"
              title="Session actions"
              className="inline-flex min-h-11 min-w-11 items-center justify-center text-xl md:min-h-0 md:min-w-0 md:text-base"
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

        <div style={{ gridColumn: "1 / -1", gridRow: 2, minWidth: 0 }}>
        {cardRollups.get(session.id) && (
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginBottom: 2,
            }}
          >
            {cardRollups.get(session.id)}
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

        {session.card && (
          <div style={{ display: "flex", minWidth: 0, marginBottom: 2 }}>
            <SessionCardChip card={session.card} />
          </div>
        )}

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

        {isSelected && session.model && session.shellType !== "shell" && (
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 10, color: "var(--text-faint)" }}>
              {session.model}
            </span>
          </div>
        )}
        </div>
      </button>
      {hasPullRequest && (
        <div style={{ gridColumn: 3, gridRow: 1, display: "flex", minWidth: 0, alignItems: "center", justifyContent: "center", pointerEvents: "none", paddingTop: headerTopPadding, paddingBottom: headerBottomMargin, fontFamily: "var(--font-mono)", opacity: isFinished ? 0.55 : 1 }}>
          <PullRequestLink url={session.pullRequestUrl} badge onReview={onReviewPullRequest ? () => onReviewPullRequest(session.id) : undefined} />
        </div>
      )}
      </div>
    );
  }

  const projects = new Map<string, SessionTreeNode[]>();
  for (const root of buildSessionTree(sessions)) {
    const project = root.session.projectName || "";
    const roots = projects.get(project) ?? [];
    roots.push(root);
    projects.set(project, roots);
  }
  const computers = new Map(sessions.map(session => [session.bridgeId, session.bridgeId]));
  for (const id of bridgeSecurityStates?.keys() ?? []) computers.set(id, id);
  for (const bridge of bridges) computers.set(bridge.bridgeId, bridge.hostname || bridge.bridgeId);
  function toggleProject(project: string) {
    setHiddenProjects(previous => {
      const next = new Set(previous);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }
  return (
    <div className="flex flex-col">
      {Array.from(projects, ([project, roots]) => hiddenProjects.has(project) ? null : (
        <section key={project} aria-label={project || "No project"}>
          {!collapsed && <div className="flex items-center justify-between px-2 py-1"
            onDragOver={event => {
              const drag = dragRef.current;
              if (drag?.kind === "session" && roots.some(root => root.children.some(child => child.session.id === drag.id))) event.preventDefault();
            }}
            onDrop={event => {
              event.preventDefault();
              const drag = dragRef.current;
              if (drag?.kind === "session" && roots.some(root => root.children.some(child => child.session.id === drag.id))) onSetSessionParent?.(drag.id, null);
              clearDragState();
            }}>
            <strong className="min-w-0 truncate text-sm">{project || "No project"}</strong>
            <button type="button" className="btn-ghost text-xs" aria-label={`Hide project ${project || "No project"}`} onClick={() => toggleProject(project)}>Hide</button>
          </div>}
          {flattenSessionTree(roots, collapsedSessions).map(row => renderSessionRow(row.session, {
            depth: row.depth, hasChildren: row.hasChildren, descendantCount: row.descendantCount,
            isCollapsed: collapsedSessions.has(row.session.id), onToggleCollapse: () => toggleSessionCollapsed(row.session.id),
          }))}
        </section>
      ))}
      {Array.from(projects.keys()).some(project => hiddenProjects.has(project)) && <details>
        <summary className="cursor-pointer px-2 py-1 text-xs">Hidden projects</summary>
        {Array.from(projects.keys()).filter(project => hiddenProjects.has(project)).map(project =>
          <button type="button" className="btn-ghost block text-xs" key={project} onClick={() => toggleProject(project)}>Show {project || "No project"}</button>)}
      </details>}
      {!sessions.length && !collapsed && <p className="p-4 text-xs text-[var(--text-muted)]">No sessions yet</p>}
      {!collapsed && (onOpenUpdates || onOpenSecurity || onOpenModelRouting) && computers.size > 0 &&
        <nav aria-label="Computer settings" className="mt-3 border-t border-[var(--border-subtle)] p-2">
          {Array.from(computers, ([id, label]) => {
            const lock = bridgeConnectionLock(bridgeSecurityStates?.get(id));
            const update = bridgeUpdates?.get(id)?.status;
            return <div key={id} className="flex items-center justify-between">
              <button className="btn-ghost text-xs" aria-label={`Actions for ${label}`} aria-haspopup="menu"
                aria-expanded={contextMenu?.kind === "bridge" && contextMenu.bridgeId === id}
                onClick={event => {
                  bridgeMenuAnchor.current = event.currentTarget;
                  const rect = event.currentTarget.getBoundingClientRect();
                  setContextMenu({ kind: "bridge", bridgeId: id, x: rect.left, y: rect.bottom });
                }}>{label} {update && <span>v{update.currentVersion}{update.availability === "available" ? " ↑" : ""}</span>} ⋯</button>
              {onOpenSecurity && <button aria-label={`Security log for ${label}`} title={lock.title}
                style={{ color: "var(--text-muted)" }} onClick={() => onOpenSecurity(id)}>
                <SecurityLockIcon state={lock.state} />
              </button>}
            </div>;
          })}
        </nav>}
      {contextMenu?.kind === "bridge" && <BridgeContextMenu menu={contextMenu} isOnline={bridges.some(b => b.bridgeId === contextMenu.bridgeId)}
        onCreateSession={onCreateSession ?? (() => {})} onOpenSecurity={onOpenSecurity} onOpenUpdates={onOpenUpdates}
        onOpenModelRouting={onOpenModelRouting} onClose={closeContextMenu} />}
      {contextMenu?.kind === "session" && onStopSession && onRemoveSession && (
        <SessionContextMenu
          menu={contextMenu}
          onRename={startEditing}
          onReviewPullRequest={onReviewPullRequest}
          onStop={onStopSession}
          onRemove={onRemoveSession}
          onClone={onCloneSession ?? (() => {})}
          onHandoff={onHandoff ? (session) => setHandoffTarget(session) : undefined}
          onDismissBlock={onDismissBlock}
          onClose={closeContextMenu}
        />
      )}
      {handoffTarget && onHandoff && (
        <HandoffDialog
          sessionName={handoffTarget.name}
          onClose={() => setHandoffTarget(null)}
          onSubmit={(input) => onHandoff(handoffTarget.id, input)}
        />
      )}
    </div>
  );
}
