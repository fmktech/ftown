"use client";

import { useMemo, useState } from "react";
import type { Session } from "@/types";
import { relativeTime } from "@/lib/relative-time";
import { StatusDot } from "@/lib/StatusDot";
import { formatTokens, formatUsageDetail } from "@/lib/format-usage";
import {
  factoryKey,
  factoryWorkerOf,
  type FactoryInfo,
  type FactoryListProps,
} from "./types";

function repoBasename(repoRoot: string): string {
  const parts = repoRoot.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : repoRoot;
}

function initial(factory: FactoryInfo): string {
  return factory.project.slice(0, 1).toUpperCase() || "?";
}

function NewFactoryButton({ onCreateFactory }: { onCreateFactory: () => void }) {
  return (
    <button
      type="button"
      onClick={onCreateFactory}
      aria-label="New factory…"
      title="New factory…"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        borderRadius: 5,
        border: "1px solid var(--border-subtle)",
        background: "var(--bg-elevated)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        fontSize: 13,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      ＋
    </button>
  );
}

function WorkerRow({
  session,
  selected,
  onOpenSession,
  onRemoveSession,
}: {
  session: Session;
  selected: boolean;
  onOpenSession: (sessionId: string) => void;
  onRemoveSession: (sessionId: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        width: "100%",
        borderLeft: `3px solid ${selected ? "var(--accent)" : "transparent"}`,
        background: selected ? "var(--bg-elevated)" : "transparent",
        fontFamily: "var(--font-mono)",
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenSession(session.id);
        }}
        aria-current={selected ? "true" : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flex: 1,
          minWidth: 0,
          padding: "5px 4px 5px 27px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "inherit",
        }}
      >
        <StatusDot kind={session.status} />
        <span
          title={session.name}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            color: selected ? "var(--text-primary)" : "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {session.name}
        </span>
        {session.usage && (
          <span
            title={formatUsageDetail(session.usage)}
            style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0 }}
          >
            {formatTokens(session.usage.totalTokens)} tok
          </span>
        )}
        <span style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0 }}>
          {relativeTime(session.createdAt)}
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemoveSession(session.id);
        }}
        aria-label={`Stop and archive ${session.name}`}
        title="Stop and archive worker"
        className="btn-ghost"
        style={{
          width: 20,
          height: 20,
          padding: 0,
          marginRight: 8,
          flexShrink: 0,
          fontSize: 11,
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

function WorkerSection({
  workers,
  expanded,
  onToggle,
  selectedSessionId,
  onOpenSession,
  onRemoveSession,
}: {
  workers: Session[];
  expanded: boolean;
  onToggle: () => void;
  selectedSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  onRemoveSession: (sessionId: string) => void;
}) {
  if (workers.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          width: "100%",
          textAlign: "left",
          padding: "4px 12px 4px 18px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-faint)",
        }}
      >
        <span aria-hidden>{expanded ? "▾" : "▸"}</span>
        <span>workers ({workers.length})</span>
      </button>
      {expanded && (
        <div className="flex flex-col">
          {workers.map((session) => (
            <WorkerRow
              key={session.id}
              session={session}
              selected={session.id === selectedSessionId}
              onOpenSession={onOpenSession}
              onRemoveSession={onRemoveSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HideFactoryButton({ onHide, rowHovered }: { onHide: () => void; rowHovered: boolean }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onHide();
      }}
      aria-label="Hide factory"
      title="Hide factory"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        borderRadius: 4,
        border: "none",
        background: "transparent",
        color: "var(--text-faint)",
        cursor: "pointer",
        fontSize: 11,
        lineHeight: 1,
        flexShrink: 0,
        opacity: rowHovered ? 1 : 0.4,
        transition: "opacity 0.15s ease, color 0.15s ease, background 0.15s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--text-primary)";
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.opacity = "1";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--text-faint)";
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.opacity = rowHovered ? "1" : "0.4";
      }}
    >
      ✕
    </button>
  );
}

export function FactoryList({
  factories,
  selectedKey,
  onSelect,
  collapsed,
  onCreateFactory,
  sessions,
  onOpenSession,
  onRemoveSession,
  selectedSessionId,
  hiddenFactoryKeys,
  onHideFactory,
  onUnhideFactory,
}: FactoryListProps) {
  const [collapsedWorkers, setCollapsedWorkers] = useState<Record<string, boolean>>({});
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [hiddenExpanded, setHiddenExpanded] = useState(false);

  const hiddenSet = hiddenFactoryKeys ?? new Set<string>();
  const visibleFactories = useMemo(
    () => factories.filter((f) => !hiddenSet.has(factoryKey(f))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [factories, hiddenFactoryKeys],
  );
  const hiddenFactories = useMemo(
    () => factories.filter((f) => hiddenSet.has(factoryKey(f))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [factories, hiddenFactoryKeys],
  );

  const workersByFactoryKey = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const factory of factories) {
      const key = factoryKey(factory);
      const matches = sessions.filter((session) => factoryWorkerOf(session, [factory]) !== null);
      matches.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      map.set(key, matches);
    }
    return map;
  }, [sessions, factories]);

  if (factories.length === 0) {
    if (collapsed) return null;
    return (
      <div
        className="flex flex-col items-center justify-center text-center"
        style={{ color: "var(--text-faint)", fontSize: 11, gap: 8, padding: "32px 16px" }}
      >
        <span aria-hidden style={{ fontSize: 20, color: "var(--text-faint)" }}>
          🏭
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>No factories detected</span>
        <span style={{ color: "var(--text-faint)" }}>
          Deploy one with the /factory skill — loops grouped &quot;Factory: &lt;project&gt;&quot;
          appear here.
        </span>
        {onCreateFactory && (
          <button
            type="button"
            onClick={onCreateFactory}
            className="btn-ghost"
            style={{ marginTop: 4 }}
          >
            New factory…
          </button>
        )}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="flex flex-col">
        {visibleFactories.map((factory) => {
          const selected = factoryKey(factory) === selectedKey;
          return (
            <button
              key={factoryKey(factory)}
              onClick={() => onSelect(factory)}
              aria-label={`${factory.project} — ${factory.repoRoot}`}
              aria-current={selected ? "true" : undefined}
              title={`${factory.project}\n${factory.repoRoot}`}
              style={{
                width: "100%",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                borderBottom: "1px solid var(--border-subtle)",
                borderLeft: `3px solid ${selected ? "var(--accent)" : "var(--border-muted)"}`,
                background: selected ? "var(--bg-elevated)" : "transparent",
                cursor: "pointer",
                padding: "10px 6px",
                fontFamily: "var(--font-mono)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 22,
                  height: 22,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 5,
                  fontSize: 11,
                  fontWeight: 600,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-subtle)",
                  color: selected ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                {initial(factory)}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {onCreateFactory && (
        <div
          className="flex items-center justify-end"
          style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-subtle)" }}
        >
          <NewFactoryButton onCreateFactory={onCreateFactory} />
        </div>
      )}
      {visibleFactories.map((factory) => {
        const selected = factoryKey(factory) === selectedKey;
        const fKey = factoryKey(factory);
        const workers = workersByFactoryKey.get(fKey) ?? [];
        const workersExpanded = collapsedWorkers[fKey] !== true;
        const hovered = hoveredKey === fKey;
        return (
        <div key={fKey} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <div
            role="button"
            tabIndex={0}
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(factory)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelect(factory);
            }}
            onMouseEnter={(e) => {
              setHoveredKey(fKey);
              if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              setHoveredKey((k) => (k === fKey ? null : k));
              if (!selected) e.currentTarget.style.background = "transparent";
            }}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "9px 12px",
              borderLeft: `3px solid ${selected ? "var(--accent)" : "var(--border-muted)"}`,
              background: selected ? "var(--bg-elevated)" : "transparent",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
            }}
          >
            <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span aria-hidden style={{ fontSize: 12, flexShrink: 0 }}>
                🏭
              </span>
              <span
                title={factory.project}
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
                {factory.project}
              </span>
              <span
                title={factory.repoRoot}
                style={{
                  fontSize: 10,
                  color: "var(--text-faint)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 120,
                  flexShrink: 0,
                }}
              >
                {repoBasename(factory.repoRoot)}
              </span>
              {onHideFactory && (
                <HideFactoryButton onHide={() => onHideFactory(fKey)} rowHovered={hovered} />
              )}
            </div>
          </div>
          <WorkerSection
            workers={workers}
            expanded={workersExpanded}
            onToggle={() =>
              setCollapsedWorkers((prev) => ({ ...prev, [fKey]: workersExpanded }))
            }
            selectedSessionId={selectedSessionId}
            onOpenSession={onOpenSession}
            onRemoveSession={onRemoveSession}
          />
        </div>
        );
      })}

      {hiddenFactories.length > 0 && (
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => setHiddenExpanded((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
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
            <span>hidden ({hiddenFactories.length})</span>
            <span style={{ fontSize: 10, opacity: 0.6 }}>{hiddenExpanded ? "▾" : "▸"}</span>
          </button>
          {hiddenExpanded &&
            hiddenFactories.map((factory) => {
              const fKey = factoryKey(factory);
              return (
                <div
                  key={fKey}
                  role="button"
                  tabIndex={0}
                  onClick={() => onUnhideFactory?.(fKey)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onUnhideFactory?.(fKey);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    textAlign: "left",
                    padding: "9px 12px",
                    borderBottom: "1px solid var(--border-subtle)",
                    background: "transparent",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    opacity: 0.55,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <span aria-hidden style={{ fontSize: 12, flexShrink: 0 }}>
                    🏭
                  </span>
                  <span
                    title={factory.project}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {factory.project}
                  </span>
                  {onUnhideFactory && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUnhideFactory(fKey);
                      }}
                      title="Unhide factory"
                      className="btn-ghost"
                      style={{ fontSize: 10, flexShrink: 0 }}
                    >
                      Unhide
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
