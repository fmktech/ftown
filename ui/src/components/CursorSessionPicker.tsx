"use client";

import { useState, useEffect, useCallback } from "react";
import { BridgeExecResponse } from "@/hooks/useSessions";

interface CursorSession {
  sessionId: string;
  timestamp: string;
  summary: string;
}

interface CursorSessionPickerProps {
  bridgeId: string;
  workingDir: string;
  onSelect: (cursorSessionId: string, summary: string) => void;
  bridgeExec: (command: string, workingDir: string, bridgeId: string) => Promise<BridgeExecResponse>;
}

function parseSessionLines(stdout: string): CursorSession[] {
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
    const ms = /^\d+$/.test(ts) ? parseInt(ts, 10) : NaN;
    const d = Number.isFinite(ms) ? new Date(ms) : new Date(ts);
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

export function CursorSessionPicker({ bridgeId, workingDir, onSelect, bridgeExec }: CursorSessionPickerProps) {
  const [sessions, setSessions] = useState<CursorSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    if (!bridgeId || !workingDir) return;

    setLoading(true);
    setError(null);

    const escapedDir = workingDir.replace(/'/g, "'\\''");
    const script = `python3 << 'PYEOF'
import os, json, sqlite3, hashlib, glob
wd = os.path.abspath('${escapedDir}')
wh = hashlib.md5(wd.encode()).hexdigest()
root = os.path.join(os.path.expanduser("~/.cursor/chats"), wh)
if not os.path.isdir(root):
    print("[]")
    raise SystemExit(0)
results = []
for store in glob.glob(os.path.join(root, "*/store.db")):
    chat_id = os.path.basename(os.path.dirname(store))
    ts, summary = "", ""
    try:
        conn = sqlite3.connect(store)
        row = conn.execute("SELECT value FROM meta WHERE key = '0'").fetchone()
        conn.close()
        if row and row[0]:
            raw = row[0]
            if isinstance(raw, str) and all(c in "0123456789abcdef" for c in raw[:32].lower()):
                raw = bytes.fromhex(raw).decode("utf-8")
            meta = json.loads(raw) if isinstance(raw, str) else {}
            summary = (meta.get("name") or "").strip()
            ts = str(meta.get("createdAt") or meta.get("updatedAt") or "")
    except Exception:
        pass
    results.append((chat_id, ts, summary))
results.sort(key=lambda x: x[1], reverse=True)
for sid, ts, summary in results[:20]:
    print(f"{sid}|{ts}|{summary.replace('|', ' ')}")
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
        Loading Cursor Agent sessions...
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
        No Cursor Agent sessions found for this directory
      </div>
    );
  }

  return (
    <div className="mt-2 border border-[#2a2a2a] rounded bg-[#1a1a1a] max-h-48 overflow-y-auto">
      <div className="px-3 py-1.5 text-[10px] text-[#666] uppercase tracking-wider border-b border-[#2a2a2a]">
        Resume a Cursor Agent session
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
              {s.summary || s.sessionId.slice(0, 20)}
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
