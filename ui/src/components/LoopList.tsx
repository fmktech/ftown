"use client";

import { useCallback, useEffect, useState } from "react";
import { Loop } from "@/types";
import { BridgeInfo } from "@/hooks/useBridges";
import { describeSchedule } from "@/lib/loop-schedule";
import { relativeTime } from "@/lib/relative-time";
import { StatusDot } from "@/lib/StatusDot";
import { usePersistentState, stringSetCodec } from "@/lib/use-persistent-state";
import { ContextMenu, ContextMenuButton } from "./ContextMenu";

const FOLD_STORAGE_KEY = "ftown:loopList:collapsedSections";

interface LoopMenuState {
  loopId: string;
  x: number;
  y: number;
}

interface LoopListProps {
  loops: Loop[];
  bridges: BridgeInfo[];
  selectedLoopId: string | null;
  onSelectLoop: (loopId: string) => void;
  onRunNow: (loop: Loop) => void;
  onToggleEnabled: (loop: Loop) => void;
  onEdit: (loop: Loop) => void;
  onDelete: (loop: Loop) => void;
  collapsed?: boolean;
  hiddenLoopIds?: Set<string>;
  onHideLoop?: (loopId: string) => void;
  onUnhideLoop?: (loopId: string) => void;
}

function bridgeLabel(bridgeId: string, bridges: BridgeInfo[]): string {
  const info = bridges.find((b) => b.bridgeId === bridgeId);
  if (info?.hostname && info.hostname !== "unknown") return info.hostname;
  return bridgeId.length > 20 ? `${bridgeId.slice(0, 18)}...` : bridgeId;
}

function statusLabel(loop: Loop): string {
  if (!loop.enabled) return "paused";
  if (loop.runNowRequested) return "queued";
  return loop.lastStatus ?? "idle";
}

function nextDueLabel(loop: Loop): string {
  if (loop.runNowRequested) return "queued now";
  if (!loop.enabled) return loop.nextRunAt ? `paused · ${relativeTime(loop.nextRunAt)}` : "paused";
  return loop.nextRunAt ? relativeTime(loop.nextRunAt) : "not scheduled";
}

function loopAccent(loop: Loop): string {
  if (!loop.enabled) return "var(--status-done)";
  if (loop.lastStatus === "error") return "var(--status-error)";
  if (loop.lastStatus === "running" || loop.runNowRequested) return "var(--accent)";
  if (loop.lastStatus === "skipped") return "var(--status-pending)";
  return "var(--border-muted)";
}

function LoopStatusDot({ loop }: { loop: Loop }) {
  if (loop.enabled && (loop.lastStatus === "running" || loop.runNowRequested)) {
    return <StatusDot kind="running" />;
  }
  if (loop.enabled && loop.lastStatus === "error") return <StatusDot kind="error" />;
  if (loop.enabled && loop.lastStatus === "skipped") return <StatusDot kind="pending" pulse={false} />;
  return <StatusDot kind="completed" />;
}

export function LoopList({
  loops,
  bridges,
  selectedLoopId,
  onSelectLoop,
  onRunNow,
  onToggleEnabled,
  onEdit,
  onDelete,
  collapsed,
  hiddenLoopIds,
  onHideLoop,
  onUnhideLoop,
}: LoopListProps) {
  // Fold state for the two-level bridge → group hierarchy below. Keyed by
  // `bridgeId` (level 1) or `${bridgeId} ${group}` (level 2); absence from the
  // set means expanded (the default). Persisted so a reload keeps the user's
  // fold choices, mirroring SessionList's collapsedBridges/collapsedSessions.
  const [collapsedSections, setCollapsedSections] = usePersistentState<Set<string>>(
    FOLD_STORAGE_KEY,
    new Set(),
    stringSetCodec,
  );
  const [contextMenu, setContextMenu] = useState<LoopMenuState | null>(null);
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const hiddenSet = hiddenLoopIds ?? new Set<string>();

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  function openContextMenu(e: React.MouseEvent<HTMLDivElement>, loop: Loop): void {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ loopId: loop.id, x: e.clientX, y: e.clientY });
  }

  // If the loop backing the open menu disappears from `loops` (e.g. deleted
  // elsewhere, or a websocket update drops it), close the menu instead of
  // leaving it open with stale/nonexistent data.
  useEffect(() => {
    if (contextMenu && !loops.some((l) => l.id === contextMenu.loopId)) {
      setContextMenu(null);
    }
  }, [loops, contextMenu]);

  // Re-derived from the live `loops` prop on every render so the menu never
  // acts on a stale captured Loop (e.g. stale enabled/pause state).
  const activeMenuLoop = contextMenu ? loops.find((l) => l.id === contextMenu.loopId) ?? null : null;

  function toggleSection(sectionId: string): void {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  }

  const sortByNextRun = (a: Loop, b: Loop): number => {
    const aNext = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.POSITIVE_INFINITY;
    const bNext = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.POSITIVE_INFINITY;
    return aNext - bNext;
  };

  const visibleLoops = loops
    .filter((l) => !hiddenSet.has(l.id))
    .slice()
    .sort(sortByNextRun);

  const hiddenLoops = loops
    .filter((l) => hiddenSet.has(l.id))
    .slice()
    .sort(sortByNextRun);

  if (visibleLoops.length === 0 && hiddenLoops.length === 0) {
    if (collapsed) return null;
    return (
      <div
        className="flex flex-col items-center justify-center text-center"
        style={{ color: "var(--text-faint)", fontSize: 11, gap: 8, padding: "32px 16px" }}
      >
        <span aria-hidden style={{ fontSize: 20, color: "var(--text-faint)" }}>◷</span>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>No loops yet</span>
        <span style={{ color: "var(--text-faint)" }}>Schedule a recurring agent run to see it here</span>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="flex flex-col">
        {visibleLoops.map((loop) => (
          <button
            key={loop.id}
            onClick={() => onSelectLoop(loop.id)}
            aria-label={`${loop.name} — ${statusLabel(loop)} — ${nextDueLabel(loop)}`}
            aria-current={loop.id === selectedLoopId ? "true" : undefined}
            title={`${loop.name}\n${statusLabel(loop)}\n${nextDueLabel(loop)}`}
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 3,
              alignItems: "center",
              borderBottom: "1px solid var(--border-subtle)",
              borderLeft: `3px solid ${loopAccent(loop)}`,
              background: loop.id === selectedLoopId ? "var(--bg-elevated)" : "transparent",
              cursor: "pointer",
              padding: "8px 6px",
              fontFamily: "var(--font-mono)",
              opacity: loop.enabled ? 1 : 0.55,
            }}
          >
            <LoopStatusDot loop={loop} />
            <span
              style={{
                fontSize: 10,
                color: loop.enabled ? "var(--text-secondary)" : "var(--text-faint)",
                maxWidth: 42,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {loop.name}
            </span>
          </button>
        ))}
      </div>
    );
  }

  // Group loops under per-bridge headers, mirroring SessionList. Map
  // preserves first-appearance order, so groups follow the next-run sort above.
  const groups = new Map<string, Loop[]>();
  for (const loop of visibleLoops) {
    const arr = groups.get(loop.bridgeId) ?? [];
    arr.push(loop);
    groups.set(loop.bridgeId, arr);
  }

  const renderLoopRow = (loop: Loop, indent?: boolean, dimmed?: boolean) => {
        const selected = loop.id === selectedLoopId;
        return (
          <div
            key={loop.id}
            role="button"
            tabIndex={0}
            aria-current={selected ? "true" : undefined}
            aria-haspopup="menu"
            onClick={() => onSelectLoop(loop.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelectLoop(loop.id);
            }}
            onContextMenu={(e) => openContextMenu(e, loop)}
            style={{
              width: "100%",
              textAlign: "left",
              padding: indent ? "9px 12px 9px 24px" : "9px 12px",
              borderBottom: "1px solid var(--border-subtle)",
              borderLeft: `3px solid ${selected ? "var(--accent)" : loopAccent(loop)}`,
              background: selected ? "var(--bg-elevated)" : loop.runNowRequested ? "rgba(0, 255, 136, 0.03)" : "transparent",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              opacity: dimmed ? 0.55 : loop.enabled ? 1 : 0.6,
            }}
            onMouseEnter={(e) => {
              if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (!selected) e.currentTarget.style.background = loop.runNowRequested ? "rgba(0, 255, 136, 0.03)" : "transparent";
              }}
            >
            <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <LoopStatusDot loop={loop} />
              <span
                title={loop.name}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  fontWeight: 600,
                  color: selected ? "var(--text-primary)" : "var(--text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {loop.name}
              </span>
              <span style={{ fontSize: 10, color: "var(--text-faint)", whiteSpace: "nowrap" }}>{statusLabel(loop)}</span>
              <span
                role="button"
                tabIndex={0}
                aria-haspopup="menu"
                aria-label="Loop actions"
                title="Loop actions"
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setContextMenu({ loopId: loop.id, x: r.right, y: r.bottom + 4 });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setContextMenu({ loopId: loop.id, x: r.right, y: r.bottom + 4 });
                  }
                }}
                style={{
                  cursor: "pointer",
                  color: "var(--text-faint)",
                  fontSize: 14,
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

            <div className="flex items-center justify-between gap-2" style={{ marginTop: 5, minWidth: 0 }}>
              <span style={{ fontSize: 10, color: loop.runNowRequested ? "var(--accent)" : "var(--text-faint)", whiteSpace: "nowrap" }}>
                {nextDueLabel(loop)}
              </span>
              <span
                title={bridgeLabel(loop.bridgeId, bridges)}
                style={{
                  fontSize: 9,
                  color: "var(--text-faint)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {loop.harness}
              </span>
            </div>

            <div
              title={describeSchedule(loop.schedule)}
              style={{
                marginTop: 3,
                fontSize: 9,
                color: "var(--text-faint)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {describeSchedule(loop.schedule)}
            </div>
          </div>
        );
  };

  const renderSectionHeader = (params: {
    sectionId: string;
    label: string;
    count: number;
    isCollapsed: boolean;
    onToggle: () => void;
    indent?: boolean;
  }) => {
    const { sectionId, label, count, isCollapsed, onToggle, indent } = params;
    return (
      <div
        key={sectionId}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: indent ? "6px 12px 6px 24px" : "8px 12px",
          borderBottom: "1px solid var(--border-subtle)",
          background: indent ? "var(--bg-elevated)" : "var(--bg-base)",
          fontFamily: "var(--font-mono)",
          userSelect: "none",
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
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
          {isCollapsed ? "▸" : "▾"}
        </button>
        <span
          title={label}
          style={{
            fontSize: indent ? 10 : 11,
            fontWeight: 600,
            color: "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          {label}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>{count}</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col">
      {[...groups.entries()].map(([bridgeId, bridgeLoops]) => {
        const bridgeSectionId = bridgeId;
        const isBridgeCollapsed = collapsedSections.has(bridgeSectionId);

        // Nest loops with a non-empty group under a collapsible group header;
        // ungrouped loops render directly under the bridge section. Groups are
        // sorted alphabetically; ungrouped loops render last (no existing
        // precedent for "misc" ordering in this codebase, so appending them
        // after named groups keeps named groups visually primary).
        const byGroup = new Map<string, Loop[]>();
        const ungrouped: Loop[] = [];
        for (const loop of bridgeLoops) {
          const group = loop.group?.trim();
          if (!group) {
            ungrouped.push(loop);
            continue;
          }
          const arr = byGroup.get(group) ?? [];
          arr.push(loop);
          byGroup.set(group, arr);
        }
        const sortedGroups = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));

        return (
          <div key={bridgeId} className="flex flex-col">
            {renderSectionHeader({
              sectionId: bridgeSectionId,
              label: bridgeLabel(bridgeId, bridges),
              count: bridgeLoops.length,
              isCollapsed: isBridgeCollapsed,
              onToggle: () => toggleSection(bridgeSectionId),
            })}
            {!isBridgeCollapsed && (
              <>
                {sortedGroups.map(([group, groupLoops]) => {
                  const groupSectionId = `${bridgeId} ${group}`;
                  const isGroupCollapsed = collapsedSections.has(groupSectionId);
                  return (
                    <div key={groupSectionId} className="flex flex-col">
                      {renderSectionHeader({
                        sectionId: groupSectionId,
                        label: group,
                        count: groupLoops.length,
                        isCollapsed: isGroupCollapsed,
                        onToggle: () => toggleSection(groupSectionId),
                        indent: true,
                      })}
                      {!isGroupCollapsed && groupLoops.map((loop) => renderLoopRow(loop, true))}
                    </div>
                  );
                })}
                {ungrouped.map((loop) => renderLoopRow(loop))}
              </>
            )}
          </div>
        );
      })}

      {hiddenLoops.length > 0 && !collapsed && (
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
            <span>Hidden ({hiddenLoops.length})</span>
            <span style={{ fontSize: 10, opacity: 0.6 }}>{hiddenExpanded ? "▾" : "▸"}</span>
          </button>
          {hiddenExpanded && hiddenLoops.map((loop) => renderLoopRow(loop, false, true))}
        </div>
      )}

      {contextMenu && activeMenuLoop && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="Loop actions"
          onClose={closeContextMenu}
        >
          <ContextMenuButton
            label="Run now"
            onClick={() => {
              onRunNow(activeMenuLoop);
              closeContextMenu();
            }}
          />
          <ContextMenuButton
            label={activeMenuLoop.enabled ? "Pause" : "Resume"}
            onClick={() => {
              onToggleEnabled(activeMenuLoop);
              closeContextMenu();
            }}
          />
          <ContextMenuButton
            label="Edit"
            onClick={() => {
              onEdit(activeMenuLoop);
              closeContextMenu();
            }}
          />
          {hiddenSet.has(activeMenuLoop.id)
            ? onUnhideLoop && (
                <ContextMenuButton
                  label="Unhide"
                  onClick={() => {
                    onUnhideLoop(activeMenuLoop.id);
                    closeContextMenu();
                  }}
                />
              )
            : onHideLoop && (
                <ContextMenuButton
                  label="Hide"
                  onClick={() => {
                    onHideLoop(activeMenuLoop.id);
                    closeContextMenu();
                  }}
                />
              )}
          <ContextMenuButton
            label="Delete"
            color="var(--status-error)"
            onClick={() => {
              closeContextMenu();
              if (window.confirm(`Delete loop "${activeMenuLoop.name}"?`)) onDelete(activeMenuLoop);
            }}
          />
        </ContextMenu>
      )}
    </div>
  );
}
