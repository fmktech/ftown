"use client";

import { useMemo, useState } from "react";
import type { Session, SessionStatus } from "@/types";
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

function formatRelative(timestamp: string): string {
  const ms = new Date(timestamp).getTime();
  if (Number.isNaN(ms)) return "unknown";
  const diffMs = Date.now() - ms;
  if (diffMs < 60000) return "just now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function statusDotClass(status: SessionStatus): string {
  switch (status) {
    case "running":
      return "bg-green-500 animate-pulse";
    case "pending":
      return "bg-zinc-400";
    case "completed":
      return "bg-zinc-600";
    case "error":
      return "bg-red-500";
    case "disconnected":
      return "bg-amber-500";
  }
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
}: {
  session: Session;
  selected: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
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
        width: "100%",
        textAlign: "left",
        padding: "5px 12px 5px 30px",
        border: "none",
        borderLeft: `3px solid ${selected ? "var(--accent)" : "transparent"}`,
        background: selected ? "var(--bg-elevated)" : "transparent",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(session.status)}`}
        style={{ borderRadius: "50%", width: 6, height: 6, flexShrink: 0 }}
      />
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
      <span style={{ fontSize: 10, color: "var(--text-faint)", flexShrink: 0 }}>
        {formatRelative(session.createdAt)}
      </span>
    </button>
  );
}

function WorkerSection({
  workers,
  expanded,
  onToggle,
  selectedSessionId,
  onOpenSession,
}: {
  workers: Session[];
  expanded: boolean;
  onToggle: () => void;
  selectedSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
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
            />
          ))}
        </div>
      )}
    </div>
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
  selectedSessionId,
}: FactoryListProps) {
  const [collapsedWorkers, setCollapsedWorkers] = useState<Record<string, boolean>>({});

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
        {factories.map((factory) => {
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
      {factories.map((factory) => {
        const selected = factoryKey(factory) === selectedKey;
        const fKey = factoryKey(factory);
        const workers = workersByFactoryKey.get(fKey) ?? [];
        const workersExpanded = collapsedWorkers[fKey] !== true;
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
            style={{
              width: "100%",
              textAlign: "left",
              padding: "9px 12px",
              borderLeft: `3px solid ${selected ? "var(--accent)" : "var(--border-muted)"}`,
              background: selected ? "var(--bg-elevated)" : "transparent",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
            }}
            onMouseEnter={(e) => {
              if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (!selected) e.currentTarget.style.background = "transparent";
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
          />
        </div>
        );
      })}
    </div>
  );
}
