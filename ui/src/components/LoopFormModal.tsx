"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { Loop, LoopDraft, LoopHarness, LoopSchedule } from "@/types";
import { BridgeInfo } from "@/hooks/useBridges";
import { validateCron } from "@/lib/loop-schedule";

interface LoopFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (draft: LoopDraft) => void | Promise<void>;
  bridges: BridgeInfo[];
  /** When set, the form is pre-filled for editing; onSubmit still emits a full LoopDraft. */
  editingLoop?: Loop | null;
}

type IntervalUnit = "s" | "m" | "h";

const UNIT_MS: Record<IntervalUnit, number> = { s: 1000, m: 60_000, h: 3_600_000 };

function msToValueUnit(ms: number): { value: string; unit: IntervalUnit } {
  if (ms % UNIT_MS.h === 0) return { value: String(ms / UNIT_MS.h), unit: "h" };
  if (ms % UNIT_MS.m === 0) return { value: String(ms / UNIT_MS.m), unit: "m" };
  return { value: String(Math.max(1, Math.round(ms / UNIT_MS.s))), unit: "s" };
}

// Mirrors NewSessionModal's per-hostname path suggestions (read-only reuse —
// this modal does not need the full picker UX, just the same localStorage
// namespace so paths typed for sessions resurface here too).
function getStoredPaths(hostname: string): string[] {
  try {
    const raw = localStorage.getItem(`ftown:paths:${hostname}`);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function storePath(hostname: string, path: string): void {
  if (!path.trim()) return;
  const existing = getStoredPaths(hostname);
  const filtered = existing.filter((p) => p !== path);
  const updated = [path, ...filtered].slice(0, 20);
  localStorage.setItem(`ftown:paths:${hostname}`, JSON.stringify(updated));
}

export function LoopFormModal({ isOpen, onClose, onSubmit, bridges, editingLoop }: LoopFormModalProps) {
  const [name, setName] = useState("");
  const [bridgeId, setBridgeId] = useState("");
  const [scheduleKind, setScheduleKind] = useState<"interval" | "cron">("interval");
  const [everyValue, setEveryValue] = useState("5");
  const [everyUnit, setEveryUnit] = useState<IntervalUnit>("m");
  const [cronExpression, setCronExpression] = useState("*/5 * * * *");
  const [cronTz, setCronTz] = useState("");
  const [harness, setHarness] = useState<LoopHarness>("claude");
  const [workingDir, setWorkingDir] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [model, setModel] = useState("");
  const [task, setTask] = useState("");
  const [preflightCommand, setPreflightCommand] = useState("");
  const [preflightTimeoutMs, setPreflightTimeoutMs] = useState("");
  const [postflightCommand, setPostflightCommand] = useState("");
  const [postflightTimeoutMs, setPostflightTimeoutMs] = useState("");
  const [postflightRunOnSkip, setPostflightRunOnSkip] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [overlapPolicy, setOverlapPolicy] = useState<"skip" | "allow">("skip");
  const [autoClearAfterRuns, setAutoClearAfterRuns] = useState("10");
  const [maxRuntimeMs, setMaxRuntimeMs] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const defaultBridgeId = bridges.length > 0 ? bridges[0].bridgeId : "";
  const effectiveBridgeId = bridgeId || defaultBridgeId;
  const selectedBridge = bridges.find((b) => b.bridgeId === effectiveBridgeId);
  const hostname = selectedBridge?.hostname ?? "";

  const suggestedPaths = useMemo(() => {
    if (!hostname) return [];
    const paths = getStoredPaths(hostname);
    if (!workingDir.trim()) return paths;
    return paths.filter((p) => p.toLowerCase().includes(workingDir.toLowerCase()));
  }, [hostname, workingDir]);

  useEffect(() => {
    if (!isOpen) return;

    if (editingLoop) {
      setName(editingLoop.name);
      setBridgeId(editingLoop.bridgeId);
      if (editingLoop.schedule.kind === "interval") {
        setScheduleKind("interval");
        const { value, unit } = msToValueUnit(editingLoop.schedule.everyMs);
        setEveryValue(value);
        setEveryUnit(unit);
      } else {
        setScheduleKind("cron");
        setCronExpression(editingLoop.schedule.expression);
        setCronTz(editingLoop.schedule.tz ?? "");
      }
      setHarness(editingLoop.harness);
      setWorkingDir(editingLoop.workdir ?? "");
      setModel(editingLoop.model ?? "");
      setTask(editingLoop.task);
      setPreflightCommand(editingLoop.preflight?.command ?? "");
      setPreflightTimeoutMs(editingLoop.preflight?.timeoutMs ? String(editingLoop.preflight.timeoutMs) : "");
      setPostflightCommand(editingLoop.postflight?.command ?? "");
      setPostflightTimeoutMs(editingLoop.postflight?.timeoutMs ? String(editingLoop.postflight.timeoutMs) : "");
      setPostflightRunOnSkip(editingLoop.postflight?.runOnSkip ?? false);
      setEnabled(editingLoop.enabled);
      setOverlapPolicy(editingLoop.overlapPolicy);
      setAutoClearAfterRuns(
        editingLoop.retention.autoClearAfterRuns == null ? "" : String(editingLoop.retention.autoClearAfterRuns)
      );
      setMaxRuntimeMs(editingLoop.maxRuntimeMs ? String(editingLoop.maxRuntimeMs) : "");
    } else {
      setName("");
      setBridgeId(defaultBridgeId);
      setScheduleKind("interval");
      setEveryValue("5");
      setEveryUnit("m");
      setCronExpression("*/5 * * * *");
      setCronTz("");
      setHarness("claude");
      setWorkingDir("");
      setModel("");
      setTask("");
      setPreflightCommand("");
      setPreflightTimeoutMs("");
      setPostflightCommand("");
      setPostflightTimeoutMs("");
      setPostflightRunOnSkip(false);
      setEnabled(true);
      setOverlapPolicy("skip");
      setAutoClearAfterRuns("10");
      setMaxRuntimeMs("");
    }
    setSubmitError(null);
    setShowAdvanced(false);
    setShowSuggestions(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editingLoop]);

  const handleSubmit = useCallback(async () => {
    setSubmitError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setSubmitError("Name is required");
      return;
    }
    if (!effectiveBridgeId) {
      setSubmitError("Bridge is required");
      return;
    }
    const trimmedTask = task.trim();
    if (!trimmedTask) {
      setSubmitError("Task is required");
      return;
    }

    let schedule: LoopSchedule;
    if (scheduleKind === "interval") {
      const everyMs = Number(everyValue) * UNIT_MS[everyUnit];
      if (!Number.isFinite(everyMs) || everyMs < 1000) {
        setSubmitError("Interval must be at least 1 second");
        return;
      }
      schedule = { kind: "interval", everyMs };
    } else {
      const cronError = validateCron(cronExpression);
      if (cronError) {
        setSubmitError(cronError);
        return;
      }
      schedule = { kind: "cron", expression: cronExpression.trim(), tz: cronTz.trim() || undefined };
    }

    const trimmedRetention = autoClearAfterRuns.trim();
    const autoClearAfterRunsParsed = trimmedRetention === "" ? null : Number(trimmedRetention);
    if (autoClearAfterRunsParsed !== null && (!Number.isFinite(autoClearAfterRunsParsed) || autoClearAfterRunsParsed < 0)) {
      setSubmitError("Retention must be a non-negative number, or blank to keep all runs");
      return;
    }

    if (hostname && workingDir.trim()) {
      storePath(hostname, workingDir.trim());
    }

    const draft: LoopDraft = {
      name: trimmedName,
      bridgeId: effectiveBridgeId,
      schedule,
      harness,
      workdir: workingDir.trim() || undefined,
      task: trimmedTask,
      model: model.trim() || undefined,
      enabled,
      overlapPolicy,
      retention: { autoClearAfterRuns: autoClearAfterRunsParsed },
      preflight: preflightCommand.trim()
        ? {
            command: preflightCommand.trim(),
            timeoutMs: preflightTimeoutMs.trim() ? Number(preflightTimeoutMs) : undefined,
          }
        : undefined,
      postflight: postflightCommand.trim()
        ? {
            command: postflightCommand.trim(),
            timeoutMs: postflightTimeoutMs.trim() ? Number(postflightTimeoutMs) : undefined,
            runOnSkip: postflightRunOnSkip || undefined,
          }
        : undefined,
      maxRuntimeMs: maxRuntimeMs.trim() ? Number(maxRuntimeMs) : undefined,
    };

    setSubmitting(true);
    try {
      await onSubmit(draft);
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [
    name,
    effectiveBridgeId,
    task,
    scheduleKind,
    everyValue,
    everyUnit,
    cronExpression,
    cronTz,
    autoClearAfterRuns,
    harness,
    workingDir,
    model,
    enabled,
    overlapPolicy,
    preflightCommand,
    preflightTimeoutMs,
    postflightCommand,
    postflightTimeoutMs,
    postflightRunOnSkip,
    maxRuntimeMs,
    hostname,
    onSubmit,
    onClose,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
      if (e.key === "Enter" && e.metaKey) {
        void handleSubmit();
      }
    },
    [onClose, handleSubmit]
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-full max-w-lg lg:max-w-2xl border border-[#2a2a2a] bg-[#111111] rounded-lg p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-[#00ff88] mb-4">{editingLoop ? "Edit Loop" : "New Loop"}</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-[#888888] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nightly cleanup, PR triage, etc."
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88]"
              onKeyDown={handleKeyDown}
            />
          </div>

          <div>
            <label className="block text-sm text-[#888888] mb-1">Bridge</label>
            <select
              value={effectiveBridgeId}
              onChange={(e) => setBridgeId(e.target.value)}
              disabled={!!editingLoop}
              title={editingLoop ? "A loop stays on the bridge that owns it" : undefined}
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] focus:outline-none focus:border-[#00ff88] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {/* When editing a loop whose owner bridge is currently offline, still
                  show it so the (locked) field is not blank. */}
              {editingLoop && !bridges.some((b) => b.bridgeId === effectiveBridgeId) && (
                <option value={effectiveBridgeId}>{effectiveBridgeId} (offline)</option>
              )}
              {bridges.map((b) => (
                <option key={b.bridgeId} value={b.bridgeId}>
                  {b.bridgeId} ({b.hostname})
                </option>
              ))}
            </select>
            {editingLoop && (
              <p className="text-xs text-[#555] mt-1">A loop cannot be moved between bridges.</p>
            )}
          </div>

          <div>
            <label className="block text-sm text-[#888888] mb-1">Schedule</label>
            <div className="flex gap-2 mb-2">
              <button
                type="button"
                onClick={() => setScheduleKind("interval")}
                className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                  scheduleKind === "interval"
                    ? "border-[#00ff88] text-[#00ff88] bg-[#00ff88]/10"
                    : "border-[#2a2a2a] text-[#888888] hover:text-[#e0e0e0]"
                }`}
              >
                Interval
              </button>
              <button
                type="button"
                onClick={() => setScheduleKind("cron")}
                className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                  scheduleKind === "cron"
                    ? "border-[#00ff88] text-[#00ff88] bg-[#00ff88]/10"
                    : "border-[#2a2a2a] text-[#888888] hover:text-[#e0e0e0]"
                }`}
              >
                Cron
              </button>
            </div>

            {scheduleKind === "interval" ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={everyValue}
                  onChange={(e) => setEveryValue(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="5"
                  className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                  onKeyDown={handleKeyDown}
                />
                <select
                  value={everyUnit}
                  onChange={(e) => setEveryUnit(e.target.value as IntervalUnit)}
                  className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] focus:outline-none focus:border-[#00ff88]"
                >
                  <option value="s">seconds</option>
                  <option value="m">minutes</option>
                  <option value="h">hours</option>
                </select>
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                  placeholder="*/5 * * * *"
                  className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                  onKeyDown={handleKeyDown}
                />
                <input
                  type="text"
                  value={cronTz}
                  onChange={(e) => setCronTz(e.target.value)}
                  placeholder="Timezone (optional, e.g. America/Sao_Paulo)"
                  className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                  onKeyDown={handleKeyDown}
                />
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm text-[#888888] mb-1">Harness</label>
            <select
              value={harness}
              onChange={(e) => setHarness(e.target.value as LoopHarness)}
              className="w-full px-3 py-2 text-sm font-mono rounded"
              style={{
                background: "#0a0a0a",
                color: "#e0e0e0",
                border: "1px solid #2a2a2a",
                outline: "none",
              }}
            >
              <optgroup label="Claude Code">
                <option value="claude">Claude Code</option>
              </optgroup>
              <optgroup label="Other agents">
                <option value="cursor">Cursor Agent</option>
                <option value="codex">Codex</option>
                <option value="opencode">opencode</option>
              </optgroup>
              <optgroup label="Plain">
                <option value="shell">Shell (zsh)</option>
              </optgroup>
            </select>
          </div>

          {harness !== "shell" && (
            <div>
              <label className="block text-sm text-[#888888] mb-1">Model</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Optional model override"
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88]"
                onKeyDown={handleKeyDown}
              />
            </div>
          )}

          <div className="relative">
            <label className="block text-sm text-[#888888] mb-1">Working Directory</label>
            <input
              type="text"
              value={workingDir}
              onChange={(e) => {
                setWorkingDir(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="/path/to/project (optional)"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88]"
              onKeyDown={handleKeyDown}
            />
            {showSuggestions && suggestedPaths.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded max-h-40 overflow-y-auto">
                {suggestedPaths.map((path) => (
                  <button
                    key={path}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setWorkingDir(path);
                      setShowSuggestions(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-[#aaa] hover:bg-[#2a2a2a] hover:text-[#e0e0e0] font-mono truncate"
                  >
                    {path}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm text-[#888888] mb-1">
              Task{" "}
              <span className="text-xs text-[#555] font-mono normal-case tracking-normal">
                (prompt run each fire — may contain {"{{preflight}}"})
              </span>
            </label>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="What should this loop do each time it fires?"
              rows={4}
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono resize-y"
            />
          </div>

          <div>
            <label className="block text-sm text-[#888888] mb-1">
              Preflight <span className="text-xs text-[#555]">(optional shell command; non-zero exit skips the run)</span>
            </label>
            <textarea
              value={preflightCommand}
              onChange={(e) => setPreflightCommand(e.target.value)}
              placeholder="e.g. git diff --quiet || exit 1"
              rows={2}
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono resize-y"
            />
          </div>

          <div>
            <label className="block text-sm text-[#888888] mb-1">
              Postflight <span className="text-xs text-[#555]">(optional shell command run after the flight finishes)</span>
            </label>
            <textarea
              value={postflightCommand}
              onChange={(e) => setPostflightCommand(e.target.value)}
              placeholder="e.g. notify-send &quot;loop finished: $FTOWN_RUN_STATUS&quot;"
              rows={2}
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono resize-y"
            />
            {postflightCommand.trim() && (
              <label className="flex items-center gap-2 mt-2 text-xs text-[#888888] cursor-pointer">
                <input
                  type="checkbox"
                  checked={postflightRunOnSkip}
                  onChange={(e) => setPostflightRunOnSkip(e.target.checked)}
                />
                Run postflight even when preflight skips the cycle
              </label>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <label className="flex items-center gap-2 text-sm text-[#888888] cursor-pointer">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Enabled
            </label>

            <div className="flex items-center gap-2">
              <label className="text-sm text-[#888888]">Overlap</label>
              <select
                value={overlapPolicy}
                onChange={(e) => setOverlapPolicy(e.target.value as "skip" | "allow")}
                className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-[#e0e0e0] focus:outline-none focus:border-[#00ff88]"
              >
                <option value="skip">Skip if still running</option>
                <option value="allow">Allow overlap</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm text-[#888888] mb-1">
              Retention{" "}
              <span className="text-xs text-[#555] font-mono normal-case tracking-normal">
                (keep newest N run sessions; blank = keep all)
              </span>
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={autoClearAfterRuns}
              onChange={(e) => setAutoClearAfterRuns(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="10"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
              onKeyDown={handleKeyDown}
            />
          </div>

          <div className="border border-[#2a2a2a] rounded">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-sm text-[#888888] hover:text-[#e0e0e0] transition-colors"
            >
              <span>Advanced</span>
              <span className="text-xs">{showAdvanced ? "▾" : "▸"}</span>
            </button>
            {showAdvanced && (
              <div className="border-t border-[#2a2a2a] px-3 py-3 space-y-3">
                <div>
                  <label className="block text-xs text-[#666] mb-1">Preflight timeout (ms)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={preflightTimeoutMs}
                    onChange={(e) => setPreflightTimeoutMs(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder="default: 30000"
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-xs text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#666] mb-1">Postflight timeout (ms)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={postflightTimeoutMs}
                    onChange={(e) => setPostflightTimeoutMs(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder="default: 30000"
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-xs text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#666] mb-1">
                    Max runtime (ms) — force-stop + mark error past this
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={maxRuntimeMs}
                    onChange={(e) => setMaxRuntimeMs(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder="unbounded"
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-xs text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                  />
                </div>
              </div>
            )}
          </div>

          {submitError && (
            <div className="px-3 py-2.5 border border-[#ff5555]/40 rounded bg-[#ff5555]/10 text-xs text-[#ff8888] break-words">
              {submitError}
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-[#2a2a2a] rounded text-sm text-[#888888] hover:text-[#e0e0e0] hover:border-[#444] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSubmit()}
              disabled={submitting}
              className="px-4 py-2 bg-[#00ff88] text-[#0a0a0a] font-bold rounded text-sm hover:bg-[#00cc6e] transition-colors disabled:opacity-40"
            >
              {editingLoop ? "Save Loop" : "Create Loop"}
            </button>
          </div>

          <p className="text-xs text-[#444] text-right">Cmd+Enter to submit</p>
        </div>
      </div>
    </div>
  );
}
