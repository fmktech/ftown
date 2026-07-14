"use client";

import { useState, useEffect, useCallback } from "react";
import { BridgeExecResponse } from "@/hooks/useSessions";
import { relativeTime } from "@/lib/relative-time";

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
for d in glob.glob(os.path.join(root, "*/")):
    chat_id = os.path.basename(os.path.dirname(d))
    ts, summary = "", ""
    meta_json = None
    try:
        with open(os.path.join(d, "meta.json")) as f:
            meta_json = json.load(f)
    except Exception:
        meta_json = None
    if meta_json is not None and meta_json.get("hasConversation") is False:
        continue
    if meta_json is not None:
        summary = (meta_json.get("title") or "").strip()
        ts = str(meta_json.get("updatedAtMs") or meta_json.get("createdAtMs") or "")
    if not summary:
        store = os.path.join(d, "store.db")
        try:
            conn = sqlite3.connect(store)
            row = conn.execute("SELECT value FROM meta WHERE key = '0'").fetchone()
            conn.close()
            if row and row[0]:
                raw = row[0]
                if isinstance(raw, str) and all(c in "0123456789abcdef" for c in raw[:32].lower()):
                    raw = bytes.fromhex(raw).decode("utf-8")
                sqlite_meta = json.loads(raw) if isinstance(raw, str) else {}
                summary = (sqlite_meta.get("name") or "").strip()
                if not ts:
                    ts = str(sqlite_meta.get("createdAt") or sqlite_meta.get("updatedAt") or "")
        except Exception:
            pass
    if summary in ("Agent", "New Agent"):
        summary = ""
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
      <div className="mt-2 border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-overlay)] p-2 space-y-1.5" aria-busy="true" aria-label="Loading Cursor Agent sessions">
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
          <span className="break-words">Couldn&apos;t load Cursor Agent sessions.</span>
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
        No Cursor Agent sessions found for this directory
      </div>
    );
  }

  return (
    <div className="mt-2 border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-overlay)] max-h-48 overflow-y-auto" role="listbox" aria-label="Resume a Cursor Agent session">
      <div className="px-3 py-1.5 text-[10px] text-[var(--text-muted)] uppercase tracking-wider border-b border-[var(--border-default)]">
        Resume a Cursor Agent session
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
              {s.summary || `${s.sessionId.slice(0, 20)}…`}
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
