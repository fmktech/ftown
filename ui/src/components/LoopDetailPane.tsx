"use client";

import { Loop, LoopRunRecord, LoopRunStatus } from "@/types";
import { describeSchedule } from "@/lib/loop-schedule";

interface LoopDetailPaneProps {
  loop: Loop | null;
  runs: LoopRunRecord[];
  selectedRunId: string | null;
  loadingRuns?: boolean;
  runsError?: string | null;
  onSelectRun: (runId: string) => void;
  onRunNow: (loop: Loop) => void;
  onToggleEnabled: (loop: Loop) => void;
  onEdit: (loop: Loop) => void;
}

function formatAbsolute(timestamp?: string): string {
  if (!timestamp) return "-";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString();
}

function formatDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatBytes(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function statusTone(status?: LoopRunStatus): string {
  if (status === "error") return "var(--status-error)";
  if (status === "running") return "var(--accent)";
  if (status === "skipped") return "var(--status-pending)";
  if (status === "ok") return "var(--status-done)";
  return "var(--text-faint)";
}

function statusLabel(loop: Loop): string {
  if (!loop.enabled) return "paused";
  if (loop.runNowRequested) return "queued";
  return loop.lastStatus ?? "idle";
}

function DetailMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ marginTop: 3, fontSize: 12, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>{value}</div>
    </div>
  );
}

export function LoopDetailPane({
  loop,
  runs,
  selectedRunId,
  loadingRuns,
  runsError,
  onSelectRun,
  onRunNow,
  onToggleEnabled,
  onEdit,
}: LoopDetailPaneProps) {
  if (!loop) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: "var(--bg-base)", color: "var(--text-faint)" }}>
        Select a cron job
      </div>
    );
  }

  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0" style={{ background: "var(--bg-base)" }}>
      <div
        className="shrink-0"
        style={{
          borderBottom: "1px solid var(--border-subtle)",
          padding: "14px 18px",
          background: "var(--bg-surface)",
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div style={{ minWidth: 0 }}>
            <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span className={`status-dot ${loop.lastStatus === "error" ? "status-dot-error" : loop.lastStatus === "running" || loop.runNowRequested ? "status-dot-running animate-running" : "status-dot-done"}`} />
              <h2
                style={{
                  margin: 0,
                  fontSize: 18,
                  lineHeight: 1.2,
                  fontWeight: 650,
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {loop.name}
              </h2>
              <span style={{ fontSize: 11, color: statusTone(loop.lastStatus), fontFamily: "var(--font-mono)" }}>
                {statusLabel(loop)}
              </span>
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
              {describeSchedule(loop.schedule)}
            </div>
            {loop.group && (
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>
                Group: {loop.group}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
            <button type="button" className="btn-ghost" onClick={() => onRunNow(loop)}>
              Run now
            </button>
            <button type="button" className="btn-ghost" onClick={() => onToggleEnabled(loop)}>
              {loop.enabled ? "Pause" : "Resume"}
            </button>
            <button type="button" className="btn-ghost" onClick={() => onEdit(loop)}>
              Edit
            </button>
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))",
            gap: 16,
          }}
        >
          <DetailMetric label="Next due" value={formatAbsolute(loop.nextRunAt)} />
          <DetailMetric label="Last run" value={formatAbsolute(loop.lastRunAt)} />
          <DetailMetric label="Runs" value={loop.runCount} />
          <DetailMetric label="Skips" value={loop.skipCount} />
          <DetailMetric label="Harness" value={loop.harness} />
          <DetailMetric label="Retention" value={loop.retention.autoClearAfterRuns == null ? "all" : loop.retention.autoClearAfterRuns} />
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <aside
          className="shrink-0"
          style={{
            width: 260,
            borderRight: "1px solid var(--border-subtle)",
            background: "var(--bg-surface)",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              padding: "9px 12px",
              borderBottom: "1px solid var(--border-subtle)",
              fontSize: 10,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              fontWeight: 650,
            }}
          >
            {loadingRuns ? (
              <span className="flex items-center gap-1.5">
                Runs <span className="status-dot status-dot-running animate-running" aria-hidden />
              </span>
            ) : (
              `Runs (${runs.length})`
            )}
          </div>
          {runs.length === 0 && (
            runsError ? (
              <div
                role="alert"
                style={{ padding: 14, fontSize: 12, color: "var(--status-error)" }}
              >
                <span aria-hidden>⚠</span> Run history unavailable: {runsError}
              </div>
            ) : loadingRuns ? (
              <div style={{ padding: 14, fontSize: 12, color: "var(--text-faint)", display: "flex", alignItems: "center", gap: 8 }}>
                <span className="status-dot status-dot-running animate-running" aria-hidden />
                Loading runs
              </div>
            ) : (
              <div style={{ padding: 14, fontSize: 12, color: "var(--text-faint)" }}>No runs yet</div>
            )
          )}
          {runs.map((run) => {
            const selected = run.id === selectedRun?.id;
            return (
              <button
                key={run.id}
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelectRun(run.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "9px 12px",
                  border: "none",
                  borderBottom: "1px solid var(--border-subtle)",
                  borderLeft: `3px solid ${selected ? "var(--accent)" : statusTone(run.status)}`,
                  background: selected ? "var(--bg-elevated)" : "transparent",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    style={{
                      fontSize: 11,
                      color: selected ? "var(--text-primary)" : "var(--text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {run.name}
                  </span>
                  <span style={{ fontSize: 10, color: statusTone(run.status), flexShrink: 0 }}>{run.status}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-faint)" }}>{formatAbsolute(run.startedAt)}</div>
              </button>
            );
          })}
        </aside>

        <section className="flex-1 min-w-0 min-h-0 flex flex-col">
          {!selectedRun ? (
            <div className="flex-1 flex items-center justify-center" style={{ color: "var(--text-faint)" }}>
              Select a run
            </div>
          ) : (
            <>
              <div
                className="shrink-0"
                style={{
                  padding: "14px 18px",
                  borderBottom: "1px solid var(--border-subtle)",
                  background: "var(--bg-base)",
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 650, color: "var(--text-primary)", fontFamily: "var(--font-mono)" }}>
                      {selectedRun.name}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>
                      {selectedRun.sessionId ?? selectedRun.id}
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: statusTone(selectedRun.status), fontFamily: "var(--font-mono)" }}>
                    {selectedRun.status}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 12,
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))",
                    gap: 16,
                  }}
                >
                  <DetailMetric label="Started" value={formatAbsolute(selectedRun.startedAt)} />
                  <DetailMetric label="Finished" value={formatAbsolute(selectedRun.finishedAt)} />
                  <DetailMetric label="Duration" value={formatDuration(selectedRun.durationMs)} />
                  <DetailMetric label="Log" value={selectedRun.logTruncated ? `${formatBytes(selectedRun.logBytes)} tail` : formatBytes(selectedRun.logBytes)} />
                </div>
              </div>

              <div className="flex-1 min-h-0" style={{ overflow: "auto", padding: 18 }}>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Task
                  </div>
                  <pre
                    style={{
                      marginTop: 6,
                      whiteSpace: "pre-wrap",
                      color: "var(--text-secondary)",
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {selectedRun.task || loop.task}
                  </pre>
                </div>

                <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Persisted log
                </div>
                <pre
                  style={{
                    marginTop: 6,
                    maxHeight: 480,
                    overflowY: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: selectedRun.logTail?.trim() ? "var(--text-secondary)" : "var(--text-faint)",
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 6,
                    padding: 12,
                    fontSize: 12,
                    lineHeight: 1.45,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {selectedRun.logTail?.trim() || (selectedRun.status === "running" ? "Run is still active; log will persist when it finishes." : "No persisted output captured for this run.")}
                </pre>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
