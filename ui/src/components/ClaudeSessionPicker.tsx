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

function formatTimestamp(ts: string): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
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
    const script = `DIR="$HOME/.claude/projects/$(echo '${escapedDir}' | sed 's|^/|-|;s|/|-|g')"
if [ ! -d "$DIR" ]; then echo '[]'; exit 0; fi
find "$DIR" -maxdepth 1 -name "*.jsonl" -type f | while read f; do
  SID=$(basename "$f" .jsonl)
  FIRST_LINE=$(head -1 "$f" 2>/dev/null)
  TS=$(echo "$FIRST_LINE" | python3 -c "import sys,json; print(json.loads(sys.stdin.readline()).get('timestamp',''))" 2>/dev/null)
  SUMMARY=$(grep '"type":"human"' "$f" 2>/dev/null | head -1 | python3 -c "import sys,json; d=json.loads(sys.stdin.readline()); c=d.get('content',''); print(c[:80] if isinstance(c,str) else str(c)[:80])" 2>/dev/null)
  echo "$SID|$TS|$SUMMARY"
done | sort -t'|' -k2 -r | head -20`;

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
            <span className="text-xs text-[#aaa] truncate flex-1 font-mono">
              {s.summary || s.sessionId.slice(0, 12)}
            </span>
            <span className="text-[10px] text-[#555] shrink-0">
              {formatTimestamp(s.timestamp)}
            </span>
          </div>
          <div className="text-[10px] text-[#444] font-mono mt-0.5">
            {s.sessionId.slice(0, 20)}...
          </div>
        </button>
      ))}
    </div>
  );
}
