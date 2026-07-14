"use client";

import { useState, useEffect, useCallback } from "react";
import { BridgeExecResponse } from "@/hooks/useSessions";
import { relativeTime } from "@/lib/relative-time";

interface ClaudeSession {
  sessionId: string;
  timestamp: string;
  summary: string;
}

interface ClaudeSessionPickerProps {
  bridgeId: string;
  workingDir: string;
  onSelect: (claudeSessionId: string, summary: string) => void;
  bridgeExec: (command: string, workingDir: string, bridgeId: string) => Promise<BridgeExecResponse>;
}

function parseSessionLines(stdout: string): ClaudeSession[] {
  if (!stdout.trim() || stdout.trim() === "[]") return [];

  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const [sessionId, timestamp, ...rest] = line.split("|");
      return {
        sessionId: sessionId.trim(),
        timestamp: timestamp.trim(),
        summary: rest.join("|").trim(),
      };
    })
    .filter((s) => s.sessionId);
}

export function ClaudeSessionPicker({ bridgeId, workingDir, onSelect, bridgeExec }: ClaudeSessionPickerProps) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    if (!bridgeId || !workingDir) return;

    setLoading(true);
    setError(null);

    const escapedDir = workingDir.replace(/'/g, "'\\''");
    const script = `python3 << 'PYEOF'
import os, json, glob
d = os.path.expanduser("~/.claude/projects/") + os.popen("echo '${escapedDir}' | tr '[:upper:]' '[:lower:]' | sed 's| |-|g;s|^/|-|;s|/|-|g'").read().strip()
if not os.path.isdir(d):
    print("[]")
    exit()
results = []
for f in glob.glob(os.path.join(d, "*.jsonl")):
    sid = os.path.basename(f).replace(".jsonl", "")
    if not sid or "-" not in sid:
        continue
    ts, summary = "", ""
    try:
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except:
                    continue
                if not ts and entry.get("timestamp"):
                    ts = entry["timestamp"]
                t = entry.get("type", "")
                if t in ("human", "user"):
                    c = entry.get("content", "")
                    msg = entry.get("message", {})
                    if not c and isinstance(msg, dict):
                        c = msg.get("content", "")
                    if isinstance(c, list):
                        parts = [p.get("text","") for p in c if isinstance(p, dict) and p.get("type") == "text"]
                        c = " ".join(parts)
                    if isinstance(c, str) and c.strip():
                        summary = c.strip()[:100].replace("|", " ")
    except:
        pass
    results.append((sid, ts, summary))
results.sort(key=lambda x: x[1], reverse=True)
for sid, ts, summary in results[:20]:
    print(f"{sid}|{ts}|{summary}")
PYEOF`;

    try {
      const result = await bridgeExec(script, workingDir, bridgeId);
      setSessions(parseSessionLines(result.stdout));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch sessions");
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [bridgeId, workingDir, bridgeExec]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  if (loading) {
    return (
      <div className="mt-2 border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-overlay)] p-2 space-y-1.5" aria-busy="true" aria-label="Loading Claude sessions">
        <div className="skeleton h-4 w-2/5" />
        <div className="skeleton h-8" />
        <div className="skeleton h-8" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="fade-in mt-2 px-3 py-2 border border-[var(--status-error)] rounded-[var(--radius-sm)] bg-[rgba(255,68,102,0.08)]"
      >
        <div className="flex items-start gap-2 text-xs text-[var(--status-error)]">
          <span aria-hidden>⚠</span>
          <span className="break-words">Couldn&apos;t load Claude sessions.</span>
        </div>
        <button
          type="button"
          onClick={() => void fetchSessions()}
          className="btn-ghost mt-2"
        >
          Retry
        </button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="mt-2 px-3 py-4 text-xs text-[var(--text-faint)] text-center border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-overlay)]">
        No sessions found
      </div>
    );
  }

  return (
    <div className="mt-2 border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-overlay)] max-h-48 overflow-y-auto" role="listbox" aria-label="Resume a Claude session">
      <div className="px-3 py-1.5 text-[10px] text-[var(--text-muted)] uppercase tracking-wider border-b border-[var(--border-default)]">
        Resume a Claude session
      </div>
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          type="button"
          role="option"
          aria-selected="false"
          onClick={() => onSelect(s.sessionId, s.summary)}
          className="w-full text-left px-3 py-2 hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] transition-colors border-b border-[var(--border-subtle)] last:border-b-0"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-[var(--text-secondary)] truncate flex-1">
              {s.summary || "Empty session"}
            </span>
            <span className="text-[10px] text-[var(--text-faint)] shrink-0 tabular-nums">
              {relativeTime(s.timestamp)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
