"use client";

import { Loop } from "@/types";
import { BridgeInfo } from "@/hooks/useBridges";
import { describeSchedule } from "@/lib/loop-schedule";

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
}

function bridgeLabel(bridgeId: string, bridges: BridgeInfo[]): string {
  const info = bridges.find((b) => b.bridgeId === bridgeId);
  if (info?.hostname && info.hostname !== "unknown") return info.hostname;
  return bridgeId.length > 20 ? `${bridgeId.slice(0, 18)}...` : bridgeId;
}

function formatRelative(timestamp?: string): string {
  if (!timestamp) return "not scheduled";
  const date = new Date(timestamp);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return "unknown";

  const diffMs = ms - Date.now();
  const absMins = Math.floor(Math.abs(diffMs) / 60000);
  const suffix = diffMs >= 0 ? "" : " ago";
  const prefix = diffMs >= 0 ? "in " : "";

  if (Math.abs(diffMs) < 60000) return diffMs >= 0 ? "due now" : "just now";
  if (absMins < 60) return `${prefix}${absMins}m${suffix}`;
  const absHours = Math.floor(absMins / 60);
  if (absHours < 24) return `${prefix}${absHours}h${suffix}`;
  const absDays = Math.floor(absHours / 24);
  if (absDays < 7) return `${prefix}${absDays}d${suffix}`;
  return date.toLocaleString();
}

function statusLabel(loop: Loop): string {
  if (!loop.enabled) return "paused";
  if (loop.runNowRequested) return "queued";
  return loop.lastStatus ?? "idle";
}

function nextDueLabel(loop: Loop): string {
  if (loop.runNowRequested) return "queued now";
  if (!loop.enabled) return loop.nextRunAt ? `paused · ${formatRelative(loop.nextRunAt)}` : "paused";
  return loop.nextRunAt ? formatRelative(loop.nextRunAt) : "not scheduled";
}

function loopAccent(loop: Loop): string {
  if (!loop.enabled) return "var(--status-done)";
  if (loop.lastStatus === "error") return "var(--status-error)";
  if (loop.lastStatus === "running" || loop.runNowRequested) return "var(--accent)";
  if (loop.lastStatus === "skipped") return "var(--status-pending)";
  return "var(--border-muted)";
}

function StatusDot({ loop }: { loop: Loop }) {
  let cls = "status-dot-done";
  let pulse = "";
  if (loop.enabled && (loop.lastStatus === "running" || loop.runNowRequested)) {
    cls = "status-dot-running";
    pulse = "animate-running";
  } else if (loop.enabled && loop.lastStatus === "error") {
    cls = "status-dot-error";
  } else if (loop.enabled && loop.lastStatus === "skipped") {
    cls = "status-dot-pending";
  }
  return <span className={`status-dot ${cls} ${pulse}`} />;
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
}: LoopListProps) {
  const cronLoops = loops
    .filter((loop) => loop.schedule.kind === "cron")
    .sort((a, b) => {
      const aNext = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.POSITIVE_INFINITY;
      const bNext = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.POSITIVE_INFINITY;
      return aNext - bNext;
    });

  if (cronLoops.length === 0) {
    if (collapsed) return null;
    return (
      <div
        className="flex flex-col items-center justify-center text-center"
        style={{ color: "var(--text-faint)", fontSize: 11, gap: 8, padding: "32px 16px" }}
      >
        <span aria-hidden style={{ fontSize: 20, color: "var(--text-faint)" }}>◷</span>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>No crons yet</span>
        <span style={{ color: "var(--text-faint)" }}>Schedule a recurring agent run to see it here</span>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="flex flex-col">
        {cronLoops.map((loop) => (
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
            <StatusDot loop={loop} />
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

  // Group cron loops under per-bridge headers, mirroring SessionList. Map
  // preserves first-appearance order, so groups follow the next-run sort above.
  const groups = new Map<string, Loop[]>();
  for (const loop of cronLoops) {
    const arr = groups.get(loop.bridgeId) ?? [];
    arr.push(loop);
    groups.set(loop.bridgeId, arr);
  }

  const renderLoopRow = (loop: Loop) => {
        const selected = loop.id === selectedLoopId;
        return (
          <div
            key={loop.id}
            role="button"
            tabIndex={0}
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelectLoop(loop.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelectLoop(loop.id);
            }}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "9px 12px",
              borderBottom: "1px solid var(--border-subtle)",
              borderLeft: `3px solid ${selected ? "var(--accent)" : loopAccent(loop)}`,
              background: selected ? "var(--bg-elevated)" : loop.runNowRequested ? "rgba(0, 255, 136, 0.03)" : "transparent",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              opacity: loop.enabled ? 1 : 0.6,
            }}
            onMouseEnter={(e) => {
              if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (!selected) e.currentTarget.style.background = loop.runNowRequested ? "rgba(0, 255, 136, 0.03)" : "transparent";
              }}
            >
            <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <StatusDot loop={loop} />
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

            {selected && (
              <div className="flex items-center gap-1.5" style={{ marginTop: 7 }}>
                <button
                  type="button"
                  title="Run now"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRunNow(loop);
                  }}
                  className="btn-ghost"
                  style={{ padding: "2px 6px", fontSize: 10, border: "none" }}
                >
                  Run
                </button>
                <button
                  type="button"
                  title={loop.enabled ? "Pause" : "Resume"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleEnabled(loop);
                  }}
                  className="btn-ghost"
                  style={{ padding: "2px 6px", fontSize: 10, border: "none" }}
                >
                  {loop.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  title="Edit cron"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(loop);
                  }}
                  className="btn-ghost"
                  style={{ padding: "2px 6px", fontSize: 10, border: "none" }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  title="Delete cron"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete cron "${loop.name}"?`)) onDelete(loop);
                  }}
                  className="btn-danger"
                  style={{ padding: "2px 6px", fontSize: 10, border: "none" }}
                >
                  Del
                </button>
              </div>
            )}
          </div>
        );
  };

  return (
    <div className="flex flex-col">
      {[...groups.entries()].map(([bridgeId, bridgeLoops]) => (
        <div key={bridgeId} className="flex flex-col">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 12px",
              borderBottom: "1px solid var(--border-subtle)",
              background: "var(--bg-base)",
              fontFamily: "var(--font-mono)",
              userSelect: "none",
            }}
          >
            <span
              title={bridgeId}
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
            >
              {bridgeLabel(bridgeId, bridges)}
            </span>
            <span style={{ fontSize: 10, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
              {bridgeLoops.length}
            </span>
          </div>
          {bridgeLoops.map((loop) => renderLoopRow(loop))}
        </div>
      ))}
    </div>
  );
}
