"use client";

import { useState, useCallback, useMemo } from "react";
import { Loop, Session, SessionStatus } from "@/types";
import { BridgeInfo } from "@/hooks/useBridges";
import { describeSchedule } from "@/lib/loop-schedule";

interface LoopListProps {
  loops: Loop[];
  /** Sessions with loopId set — Dashboard passes it the loop-run partition of its `sessions` memo. */
  runs: Session[];
  bridges: BridgeInfo[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onRunNow: (loop: Loop) => void;
  onToggleEnabled: (loop: Loop) => void;
  onEdit: (loop: Loop) => void;
  onDelete: (loop: Loop) => void;
  onStopSession?: (sessionId: string) => void;
  onRemoveSession?: (sessionId: string, onlyIfFinished?: boolean) => void;
  collapsed?: boolean;
}

function bridgeLabel(bridgeId: string, bridges: BridgeInfo[]): string {
  const info = bridges.find((b) => b.bridgeId === bridgeId);
  if (info?.hostname && info.hostname !== "unknown") return info.hostname;
  return bridgeId.length > 20 ? `${bridgeId.slice(0, 18)}…` : bridgeId;
}

function formatTimestamp(timestamp?: string): string {
  if (!timestamp) return "—";
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
  return date.toLocaleDateString();
}

function nextRunLabel(loop: Loop): string {
  if (loop.runNowRequested) return "queued now";
  if (!loop.enabled) return loop.nextRunAt ? `paused · target ${formatRelative(loop.nextRunAt)}` : "paused";
  return loop.nextRunAt ? `next ${formatRelative(loop.nextRunAt)}` : "not scheduled";
}

function loopAccent(loop: Loop): string {
  if (!loop.enabled) return "var(--status-done)";
  if (loop.lastStatus === "error") return "var(--status-error)";
  if (loop.lastStatus === "running" || loop.runNowRequested) return "var(--accent)";
  if (loop.lastStatus === "skipped") return "var(--status-pending)";
  return "var(--border-muted)";
}

function LoopMetric({ label, value, tone }: { label: string; value: number | string; tone?: "warn" | "ok" }) {
  const color = tone === "warn" ? "var(--status-pending)" : tone === "ok" ? "var(--accent)" : "var(--text-faint)";
  const background = tone === "warn" ? "rgba(255, 170, 0, 0.08)" : tone === "ok" ? "rgba(0, 255, 136, 0.07)" : "rgba(255, 255, 255, 0.03)";
  const border = tone === "warn" ? "rgba(255, 170, 0, 0.18)" : tone === "ok" ? "rgba(0, 255, 136, 0.16)" : "var(--border-subtle)";

  return (
    <span
      title={`${label}: ${value}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        minHeight: 16,
        padding: "1px 5px",
        borderRadius: 4,
        border: `1px solid ${border}`,
        background,
        color,
        fontSize: 9,
        fontWeight: 600,
        lineHeight: 1.2,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color: "var(--text-faint)", fontWeight: 500 }}>{label}</span>
      {value}
    </span>
  );
}

// Reuses the session status-dot CSS tokens/classes (status-dot / status-dot-*
// / animate-running) so a Loop's badge reads consistently with session
// status without importing SessionList's private StatusBadge (SessionList
// is left unmodified per the contract).
function LoopStatusBadge({ loop }: { loop: Loop }) {
  let dot = "status-dot-done";
  let pulse = "";
  let label = "never run";

  if (!loop.enabled) {
    dot = "status-dot-done";
    label = "disabled";
  } else if (loop.lastStatus === "running") {
    dot = "status-dot-running";
    pulse = "animate-running";
    label = "running";
  } else if (loop.lastStatus === "error") {
    dot = "status-dot-error";
    label = "error";
  } else if (loop.lastStatus === "skipped") {
    dot = "status-dot-pending";
    label = "skipped";
  } else if (loop.lastStatus === "ok") {
    dot = "status-dot-running";
    label = "ok";
  }

  return (
    <div className="flex items-center gap-1.5 shrink-0" title={loop.enabled ? `last run: ${label}` : "disabled"}>
      <span className={`status-dot ${dot} ${pulse}`} />
      <span
        style={{
          fontSize: 10,
          color: loop.enabled ? "var(--text-secondary)" : "var(--text-faint)",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </span>
    </div>
  );
}

const RUN_STATUS_STYLE: Record<SessionStatus, { dot: string; pulse: string }> = {
  running: { dot: "status-dot-running", pulse: "animate-running" },
  completed: { dot: "status-dot-done", pulse: "" },
  error: { dot: "status-dot-error", pulse: "" },
  pending: { dot: "status-dot-pending", pulse: "animate-pending" },
  disconnected: { dot: "status-dot-done", pulse: "" },
};

function RunStatusDot({ status }: { status: SessionStatus }) {
  const { dot, pulse } = RUN_STATUS_STYLE[status] ?? RUN_STATUS_STYLE.completed;
  return <span className={`status-dot ${dot} ${pulse}`} />;
}

export function LoopList({
  loops,
  runs,
  bridges,
  selectedSessionId,
  onSelectSession,
  onRunNow,
  onToggleEnabled,
  onEdit,
  onDelete,
  onStopSession,
  onRemoveSession,
  collapsed,
}: LoopListProps) {
  // Runs nest under their loop COLLAPSED by default — this Set tracks the
  // (rare) loop the user has explicitly expanded.
  const [expandedLoopIds, setExpandedLoopIds] = useState<Set<string>>(new Set());

  const runsByLoop = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const run of runs) {
      if (!run.loopId) continue;
      const arr = map.get(run.loopId) ?? [];
      arr.push(run);
      map.set(run.loopId, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return map;
  }, [runs]);

  const toggleExpanded = useCallback((loopId: string) => {
    setExpandedLoopIds((prev) => {
      const next = new Set(prev);
      if (next.has(loopId)) next.delete(loopId);
      else next.add(loopId);
      return next;
    });
  }, []);

  if (loops.length === 0) return null;

  const activeCount = loops.filter((loop) => loop.enabled).length;
  const runningCount = loops.filter((loop) => loop.lastStatus === "running" || loop.runNowRequested).length;
  const errorCount = loops.filter((loop) => loop.lastStatus === "error").length;

  if (collapsed) {
    return (
      <div className="flex flex-col">
        {loops.map((loop) => (
          <button
            key={loop.id}
            onClick={() => onEdit(loop)}
            title={`${loop.name}\n${loop.enabled ? loop.lastStatus ?? "never run" : "disabled"}`}
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              borderBottom: "1px solid var(--border-subtle)",
              borderLeft: `3px solid ${loopAccent(loop)}`,
              background: "transparent",
              cursor: "pointer",
              padding: "6px 8px",
              fontFamily: "var(--font-mono)",
              opacity: loop.enabled ? 1 : 0.55,
            }}
          >
            <span className={`status-dot ${loop.lastStatus === "error" ? "status-dot-error" : loop.lastStatus === "running" ? "status-dot-running animate-running" : loop.enabled ? "status-dot-done" : "status-dot-done"}`} />
            <span
              style={{
                fontSize: 10,
                color: loop.enabled ? "var(--text-secondary)" : "var(--text-faint)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {loop.name.slice(0, 10)}
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div
        style={{
          padding: "8px 16px",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-base)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span>Loops ({loops.length})</span>
        <span style={{ color: "var(--text-faint)", fontWeight: 500, letterSpacing: "0.04em", textTransform: "none" }}>
          {activeCount} active{runningCount > 0 ? ` · ${runningCount} running` : ""}{errorCount > 0 ? ` · ${errorCount} error` : ""}
        </span>
      </div>

      {loops.map((loop) => {
        const loopRuns = runsByLoop.get(loop.id) ?? [];
        const isExpanded = expandedLoopIds.has(loop.id);

        return (
          <div key={loop.id} className="flex flex-col">
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                padding: "9px 12px",
                borderBottom: "1px solid var(--border-subtle)",
                borderLeft: `3px solid ${loopAccent(loop)}`,
                background: loop.runNowRequested ? "rgba(0, 255, 136, 0.03)" : "transparent",
                fontFamily: "var(--font-mono)",
              }}
            >
              <button
                type="button"
                onClick={() => toggleExpanded(loop.id)}
                disabled={loopRuns.length === 0}
                title={isExpanded ? "Collapse runs" : "Expand runs"}
                style={{
                  background: "none",
                  border: "none",
                  cursor: loopRuns.length === 0 ? "default" : "pointer",
                  color: "var(--text-faint)",
                  fontSize: 10,
                  padding: 0,
                  width: 12,
                  marginTop: 2,
                  lineHeight: 1,
                  fontFamily: "var(--font-mono)",
                  opacity: loopRuns.length === 0 ? 0.3 : 1,
                }}
              >
                {isExpanded ? "▾" : "▸"}
              </button>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex items-center gap-1.5">
                  <span
                    title={loop.name}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: loop.enabled ? "var(--text-primary)" : "var(--text-faint)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {loop.name}
                  </span>
                  <LoopStatusBadge loop={loop} />
                </div>
                <div className="flex items-center gap-2" style={{ marginTop: 3, minWidth: 0 }}>
                  <span
                    title={describeSchedule(loop.schedule)}
                    style={{
                      fontSize: 10,
                      color: "var(--text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {describeSchedule(loop.schedule)}
                  </span>
                  <span style={{ fontSize: 10, color: loop.runNowRequested ? "var(--accent)" : "var(--text-faint)", whiteSpace: "nowrap" }}>
                    {nextRunLabel(loop)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5" style={{ marginTop: 5, flexWrap: "wrap" }}>
                  <LoopMetric label="runs" value={loop.runCount} tone={loop.runCount > 0 ? "ok" : undefined} />
                  <LoopMetric label="kept" value={loopRuns.length} />
                  {loop.skipCount > 0 && <LoopMetric label="skips" value={loop.skipCount} tone="warn" />}
                  <span style={{ fontSize: 9, color: "var(--text-faint)" }}>
                    {loop.harness} · {bridgeLabel(loop.bridgeId, bridges)}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1" style={{ flexShrink: 0 }}>
                <button
                  type="button"
                  title="Run now"
                  onClick={() => onRunNow(loop)}
                  className="btn-ghost"
                  style={{ padding: "2px 6px", fontSize: 10 }}
                >
                  Run
                </button>
                <button
                  type="button"
                  title={loop.enabled ? "Disable" : "Enable"}
                  onClick={() => onToggleEnabled(loop)}
                  className="btn-ghost"
                  style={{ padding: "2px 6px", fontSize: 10 }}
                >
                  {loop.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  title="Edit loop"
                  onClick={() => onEdit(loop)}
                  className="btn-ghost"
                  style={{ padding: "2px 6px", fontSize: 10 }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  title="Delete loop"
                  onClick={() => {
                    if (window.confirm(`Delete loop "${loop.name}"? Its run sessions are not removed.`)) {
                      onDelete(loop);
                    }
                  }}
                  className="btn-danger"
                  style={{ padding: "2px 6px", fontSize: 10 }}
                >
                  Del
                </button>
              </div>
            </div>

            {isExpanded &&
              loopRuns.map((run) => {
                const isSelected = run.id === selectedSessionId;
                const displayName = run.name || run.prompt.slice(0, 36);
                const isFinished = run.status === "completed" || run.status === "error";

                return (
                  <button
                    key={run.id}
                    onClick={() => onSelectSession(run.id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "6px 16px 6px 34px",
                      borderBottom: "1px solid var(--border-subtle)",
                      borderLeft: `2px solid ${isSelected ? "var(--accent)" : "var(--border-muted)"}`,
                      background: isSelected ? "var(--bg-elevated)" : "transparent",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 6,
                      opacity: isFinished ? 0.65 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <div className="flex items-center gap-1.5" style={{ flex: 1, minWidth: 0 }}>
                      <RunStatusDot status={run.status} />
                      <span
                        style={{
                          fontSize: 11,
                          color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {displayName}
                      </span>
                    </div>
                    <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
                      <span style={{ fontSize: 9, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                        {formatTimestamp(run.createdAt)}
                      </span>
                      {run.status === "running" && onStopSession && (
                        <span
                          role="button"
                          title="Stop"
                          onClick={(e) => {
                            e.stopPropagation();
                            onStopSession(run.id);
                          }}
                          style={{ fontSize: 10, color: "var(--status-error)", cursor: "pointer" }}
                        >
                          ■
                        </span>
                      )}
                      {isFinished && onRemoveSession && (
                        <span
                          role="button"
                          title="Remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveSession(run.id, true);
                          }}
                          style={{ fontSize: 10, color: "var(--text-faint)", cursor: "pointer" }}
                        >
                          ✕
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
