"use client";

import { useState, useEffect, useCallback } from "react";
import { BridgeExecResponse } from "@/hooks/useSessions";

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

function formatRelativeTime(ts: string): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
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
                if t in ("human", "user") and not summary:
                    c = entry.get("content", "")
                    if isinstance(c, list):
                        parts = [p.get("text","") for p in c if isinstance(p, dict) and p.get("type") == "text"]
                        c = " ".join(parts)
                    if isinstance(c, str) and c.strip():
                        summary = c.strip()[:100].replace("|", " ")
                if ts and summary:
                    break
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
      <div className="mt-2 px-3 py-4 text-xs text-[#666] text-center border border-[#2a2a2a] rounded bg-[#1a1a1a]">
        Loading Claude sessions...
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-2 px-3 py-2 text-xs text-red-400 border border-[#2a2a2a] rounded bg-[#1a1a1a]">
        {error}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="mt-2 px-3 py-4 text-xs text-[#555] text-center border border-[#2a2a2a] rounded bg-[#1a1a1a]">
        No sessions found
      </div>
    );
  }

  return (
    <div className="mt-2 border border-[#2a2a2a] rounded bg-[#1a1a1a] max-h-48 overflow-y-auto">
      <div className="px-3 py-1.5 text-[10px] text-[#666] uppercase tracking-wider border-b border-[#2a2a2a]">
        Resume a Claude session
      </div>
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          type="button"
          onClick={() => onSelect(s.sessionId, s.summary)}
          className="w-full text-left px-3 py-2 hover:bg-[#2a2a2a] transition-colors border-b border-[#222] last:border-b-0"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-[#ccc] truncate flex-1">
              {s.summary || "Empty session"}
            </span>
            <span className="text-[10px] text-[#555] shrink-0 tabular-nums">
              {formatRelativeTime(s.timestamp)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
