"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Centrifuge } from "centrifuge";
import { ConnectionStatus } from "@/hooks/useCentrifugo";
import { TerminalTransportApi } from "@/lib/direct-transport/contract";
import { Session, ShellType, Loop, LoopDraft, LoopRunRecord } from "@/types";
import { CreateSessionOptions, useSessions } from "@/hooks/useSessions";
import { useBridges } from "@/hooks/useBridges";
import { useLoops } from "@/hooks/useLoops";
import { useAllSessionEvents } from "@/hooks/useAllSessionEvents";
import { SessionList } from "./SessionList";
import { LoopList } from "./LoopList";
import { LoopDetailPane } from "./LoopDetailPane";
import { Terminal, TerminalHandle } from "./Terminal";
import { MobileControlBar, MobileControlBarHandle } from "./MobileControlBar";
import { NewSessionModal, SessionDefaults } from "./NewSessionModal";
import { LoopFormModal } from "./LoopFormModal";
import { ConnectionDiagnostics } from "./ConnectionDiagnostics";
import { mergeBridgeOrder } from "@/lib/bridge-order";

interface DashboardProps {
  client: Centrifuge | null;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  userId: string;
  token: string;
  centrifugoUrl: string;
  /** One HybridTerminalTransport per live Centrifugo connection; consumed by
   *  useTerminal once the terminal component is wired to it. */
  transport: TerminalTransportApi | null;
  onDisconnect: () => void;
}

function ConnectionDot({ status }: { status: ConnectionStatus }) {
  const map: Record<ConnectionStatus, { cls: string; pulse: boolean }> = {
    connected:    { cls: "status-dot-running",  pulse: false },
    connecting:   { cls: "status-dot-pending",  pulse: true  },
    disconnected: { cls: "status-dot-done",     pulse: false },
    error:        { cls: "status-dot-error",    pulse: false },
  };
  const { cls, pulse } = map[status] ?? { cls: "status-dot-done", pulse: false };
  return (
    <span
      className={`status-dot ${cls} ${pulse ? "animate-pending" : ""}`}
      title={status}
    />
  );
}

export function Dashboard({ client, connectionStatus, connectionError, userId, token, centrifugoUrl, transport, onDisconnect }: DashboardProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedLoopId, setSelectedLoopId] = useState<string | null>(null);
  const [selectedLoopRunId, setSelectedLoopRunId] = useState<string | null>(null);
  const [selectedLoopRuns, setSelectedLoopRuns] = useState<LoopRunRecord[]>([]);
  const [loopRunsLoading, setLoopRunsLoading] = useState(false);
  const [loopRunsError, setLoopRunsError] = useState<string | null>(null);
  const [showNewSession, setShowNewSession] = useState(false);
  const [sessionDefaults, setSessionDefaults] = useState<SessionDefaults | undefined>(undefined);
  const [showLoopForm, setShowLoopForm] = useState(false);
  const [editingLoop, setEditingLoop] = useState<Loop | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [mobileTab, setMobileTab] = useState<"sessions" | "terminal">("sessions");
  const [sidebarTab, setSidebarTab] = useState<"sessions" | "crons">("sessions");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [bridgeOrder, setBridgeOrder] = useState<string[]>([]);
  const [hiddenSessionIds, setHiddenSessionIds] = useState<Set<string>>(new Set());
  const [hiddenBridgeIds, setHiddenBridgeIds] = useState<Set<string>>(new Set());
  const [showUserMenu, setShowUserMenu] = useState(false);
  const terminalRef = useRef<TerminalHandle>(null);
  const mobileControlRef = useRef<MobileControlBarHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const scheduleTerminalRenderAdjustment = useCallback(() => {
    const refit = () => terminalRef.current?.refit({ forceResize: true });
    const frame = window.requestAnimationFrame(refit);
    const timers = [
      window.setTimeout(refit, 80),
      window.setTimeout(refit, 250),
    ];

    return () => {
      window.cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    setSidebarCollapsed(localStorage.getItem("ftown:sidebarCollapsed") === "true");
    const savedSidebarTab = localStorage.getItem("ftown:sidebarTab");
    if (savedSidebarTab === "sessions" || savedSidebarTab === "crons") setSidebarTab(savedSidebarTab);
    try {
      setSessionOrder(JSON.parse(localStorage.getItem("ftown:sessionOrder") ?? "[]"));
    } catch { /* ignore */ }
    try {
      setBridgeOrder(JSON.parse(localStorage.getItem("ftown:bridgeOrder") ?? "[]"));
    } catch { /* ignore */ }
    try {
      const raw = localStorage.getItem("ftown:hiddenSessions");
      if (raw) setHiddenSessionIds(new Set(JSON.parse(raw)));
    } catch { /* ignore */ }
    try {
      const raw = localStorage.getItem("ftown:hiddenBridges");
      if (raw) setHiddenBridgeIds(new Set(JSON.parse(raw)));
    } catch { /* ignore */ }
  }, []);

  // Resize layout when mobile keyboard opens/closes
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const onResize = () => {
      if (rootRef.current) {
        rootRef.current.style.height = `${vv.height}px`;
      }
      terminalRef.current?.refit();
    };

    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (!showUserMenu) return;
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showUserMenu]);

  const { sessions: rawSessions, createSession, stopSession, retrySession, renameSession, removeSession, refreshSessions, bridgeExec, sendCommand, sendCommandCollect } = useSessions(client, userId);
  const { bridges, hasBridges } = useBridges(client, userId);
  const { loops, createLoop, updateLoop, deleteLoop, runLoopNow, getLoopRuns } = useLoops(client, userId, sendCommand, sendCommandCollect);

  // Keep bridgeOrder stable when bridges connect/disconnect; only append new ids (sorted).
  useEffect(() => {
    const knownIds: string[] = [];
    for (const b of bridges) knownIds.push(b.bridgeId);
    for (const s of rawSessions) {
      if (!knownIds.includes(s.bridgeId)) knownIds.push(s.bridgeId);
    }
    setBridgeOrder((prev) => {
      const next = mergeBridgeOrder(prev, knownIds);
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev;
      localStorage.setItem("ftown:bridgeOrder", JSON.stringify(next));
      return next;
    });
  }, [bridges, rawSessions]);
  const { sessionActivity, markSessionIdle } = useAllSessionEvents(client, rawSessions, userId);

  const installedHookBridges = useRef(new Set<string>());

  useEffect(() => {
    for (const bridge of bridges) {
      if (installedHookBridges.current.has(bridge.bridgeId)) continue;
      installedHookBridges.current.add(bridge.bridgeId);

      const script = `
NOTIFY="$HOME/.ftown/notify.sh"
if [ ! -x "$NOTIFY" ]; then
  echo "ftown notify.sh missing (start ftown-bridge on this machine first)"
  exit 0
fi
python3 << 'PY'
import json, os

notify = os.path.expanduser("~/.ftown/notify.sh")

def is_ftown_notify(cmd):
    return isinstance(cmd, str) and cmd.endswith("notify.sh") and (
        ".ftown/" in cmd or "/ftown/bridge/hooks/" in cmd or cmd.endswith("/hooks/notify.sh")
    )

# Claude ~/.claude/settings.json
claude_path = os.path.expanduser("~/.claude/settings.json")
claude = {}
try:
    with open(claude_path) as f:
        claude = json.load(f)
except FileNotFoundError:
    pass
hooks = claude.setdefault("hooks", {})
entry = {"matcher": "", "hooks": [{"type": "command", "command": notify, "async": True}]}
for ev in ["UserPromptSubmit", "Stop", "PreToolUse", "PostToolUse", "Notification"]:
    hooks[ev] = [entry]
os.makedirs(os.path.dirname(claude_path), exist_ok=True)
with open(claude_path, "w") as f:
    json.dump(claude, f, indent=2)

# Cursor ~/.cursor/hooks.json
cursor_path = os.path.expanduser("~/.cursor/hooks.json")
cursor = {"version": 1, "hooks": {}}
try:
    with open(cursor_path) as f:
        cursor = json.load(f)
except FileNotFoundError:
    pass
cursor.setdefault("version", 1)
ch = cursor.setdefault("hooks", {})
for ev in [
    "sessionStart", "preToolUse", "postToolUse", "beforeShellExecution",
    "afterShellExecution", "afterFileEdit", "stop", "beforeSubmitPrompt",
]:
    ch[ev] = [{"command": notify}]
os.makedirs(os.path.dirname(cursor_path), exist_ok=True)
with open(cursor_path, "w") as f:
    json.dump(cursor, f, indent=2)

print("ftown hooks point at", notify)
PY`;
      bridgeExec(script, "~", bridge.bridgeId).catch(() => {});
    }
  }, [bridges, bridgeExec]);

  const activeBridgeIds = useMemo(() => new Set(bridges.map((b) => b.bridgeId)), [bridges]);

  const sessions = useMemo(() => {
    const mapped = rawSessions.map((s) =>
      s.status === "running" && activeBridgeIds.size > 0 && !activeBridgeIds.has(s.bridgeId)
        ? { ...s, status: "disconnected" as const }
        : s
    );
    if (sessionOrder.length === 0 && bridgeOrder.length === 0) return mapped;
    const orderMap = new Map(sessionOrder.map((id, i) => [id, i]));
    return [...mapped].sort((a, b) => {
      const bridgeAi = bridgeOrder.indexOf(a.bridgeId);
      const bridgeBi = bridgeOrder.indexOf(b.bridgeId);
      const bOrderA = bridgeAi === -1 ? Infinity : bridgeAi;
      const bOrderB = bridgeBi === -1 ? Infinity : bridgeBi;
      if (bOrderA !== bOrderB) return bOrderA - bOrderB;
      const ai = orderMap.get(a.id) ?? Infinity;
      const bi = orderMap.get(b.id) ?? Infinity;
      return ai - bi;
    });
  }, [rawSessions, activeBridgeIds, sessionOrder, bridgeOrder]);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;
  const selectedLoop = selectedLoopId ? loops.find((loop) => loop.id === selectedLoopId) ?? null : null;

  // Mirrors the run-selection fallback in LoopDetailPane so the two stay in sync.
  const selectedLoopRun = useMemo(
    () => selectedLoopRuns.find((run) => run.id === selectedLoopRunId) ?? selectedLoopRuns[0] ?? null,
    [selectedLoopRuns, selectedLoopRunId]
  );
  // The Session backing a still-running run, if the bridge still reports it live.
  const liveLoopRunSession = useMemo(() => {
    if (!selectedLoopRun || selectedLoopRun.status !== "running" || !selectedLoopRun.sessionId) return null;
    return sessions.find((s) => s.id === selectedLoopRun.sessionId) ?? null;
  }, [selectedLoopRun, sessions]);

  // Loop-run sessions are represented through LoopRunRecord in the loop detail
  // pane, so they no longer appear as top-level sidebar sessions.
  const normalSessions = useMemo(() => sessions.filter((s) => !s.loopId), [sessions]);
  const cronLoopCount = useMemo(() => loops.filter((loop) => loop.schedule.kind === "cron").length, [loops]);

  useEffect(() => {
    if (!selectedLoop) {
      setSelectedLoopRuns([]);
      setSelectedLoopRunId(null);
      setLoopRunsLoading(false);
      setLoopRunsError(null);
      return;
    }

    let cancelled = false;
    const routeBridgeId = activeBridgeIds.has(selectedLoop.bridgeId) ? selectedLoop.bridgeId : undefined;
    setLoopRunsLoading(true);
    setLoopRunsError(null);
    getLoopRuns(routeBridgeId, selectedLoop.id)
      .then((runs) => {
        if (cancelled) return;
        setSelectedLoopRuns(runs);
        setLoopRunsError(null);
        setSelectedLoopRunId((current) => {
          if (current && runs.some((run) => run.id === current)) return current;
          return runs[0]?.id ?? null;
        });
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("get_loop_runs failed", err);
          setLoopRunsError(err instanceof Error ? err.message : String(err));
          setSelectedLoopRuns([]);
          setSelectedLoopRunId(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoopRunsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedLoop?.id, selectedLoop?.bridgeId, selectedLoop?.runCount, selectedLoop?.skipCount, selectedLoop?.lastStatus, selectedLoop?.lastSessionId, selectedLoop?.updatedAt, activeBridgeIds, getLoopRuns]);

  useEffect(() => {
    if (!selectedSessionId) return undefined;
    return scheduleTerminalRenderAdjustment();
  }, [selectedSessionId, scheduleTerminalRenderAdjustment]);

  const handleReorderSessions = useCallback((orderedIds: string[]) => {
    setSessionOrder(orderedIds);
    localStorage.setItem("ftown:sessionOrder", JSON.stringify(orderedIds));
  }, []);

  const handleReorderBridges = useCallback((orderedBridgeIds: string[]) => {
    setBridgeOrder(orderedBridgeIds);
    localStorage.setItem("ftown:bridgeOrder", JSON.stringify(orderedBridgeIds));

    setSessionOrder((prevOrder) => {
      const byBridge = new Map<string, string[]>();
      for (const s of rawSessions) {
        const arr = byBridge.get(s.bridgeId) ?? [];
        arr.push(s.id);
        byBridge.set(s.bridgeId, arr);
      }

      const orderMap = new Map(prevOrder.map((id, i) => [id, i]));
      for (const [, ids] of byBridge) {
        ids.sort((a, b) => (orderMap.get(a) ?? Infinity) - (orderMap.get(b) ?? Infinity));
      }

      const newOrder = orderedBridgeIds.flatMap((bid) => byBridge.get(bid) ?? []);
      for (const [bid, ids] of byBridge) {
        if (!orderedBridgeIds.includes(bid)) newOrder.push(...ids);
      }

      localStorage.setItem("ftown:sessionOrder", JSON.stringify(newOrder));
      return newOrder;
    });
  }, [rawSessions]);

  const handleCreateSession = useCallback(
    async (prompt: string, options: CreateSessionOptions): Promise<void> => {
      await createSession(prompt, options);
      scheduleTerminalRenderAdjustment();
    },
    [createSession, scheduleTerminalRenderAdjustment]
  );

  const handleStopSession = useCallback(() => {
    if (selectedSessionId) stopSession(selectedSessionId);
  }, [selectedSessionId, stopSession]);

  const handleRetrySession = useCallback(() => {
    if (selectedSessionId) retrySession(selectedSessionId);
  }, [selectedSessionId, retrySession]);

  // Claude's Stop hook does not fire on user interrupt, so a lone ESC leaves the
  // dashboard stuck on "thinking"/"tool_use". Optimistically clear it locally.
  // Cursor reports interrupts via postToolUseFailure, so it needs no heuristic.
  const markInterruptIdle = useCallback((sessionId: string | null, shellType?: ShellType) => {
    if (sessionId && shellType !== "cursor") markSessionIdle(sessionId);
  }, [markSessionIdle]);

  const handleTerminalInterrupt = useCallback(() => {
    markInterruptIdle(selectedSessionId, selectedSession?.shellType);
  }, [selectedSessionId, selectedSession?.shellType, markInterruptIdle]);

  // Same optimistic-idle heuristic as handleTerminalInterrupt, targeted at the
  // live session backing the currently viewed loop run instead of the sidebar selection.
  const handleLoopRunInterrupt = useCallback(() => {
    markInterruptIdle(liveLoopRunSession?.id ?? null, liveLoopRunSession?.shellType);
  }, [liveLoopRunSession, markInterruptIdle]);

  const handleRemoveSession = useCallback((sessionId: string, onlyIfFinished?: boolean) => {
    // Only let removeSession drop the row optimistically when the owning bridge
    // is online; otherwise the remove_session command is dropped (no command
    // history) and the session genuinely persists, so the row must stay put.
    const ownerBridgeId = rawSessions.find((s) => s.id === sessionId)?.bridgeId;
    const ownerOnline = ownerBridgeId !== undefined && activeBridgeIds.has(ownerBridgeId);
    removeSession(sessionId, onlyIfFinished, ownerOnline);
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null);
    }
  }, [removeSession, selectedSessionId, rawSessions, activeBridgeIds]);

  const handleHideSession = useCallback((sessionId: string) => {
    setHiddenSessionIds((prev) => {
      const next = new Set(prev);
      next.add(sessionId);
      localStorage.setItem("ftown:hiddenSessions", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const handleUnhideSession = useCallback((sessionId: string) => {
    setHiddenSessionIds((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      localStorage.setItem("ftown:hiddenSessions", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const handleHideBridge = useCallback((bridgeId: string) => {
    setHiddenBridgeIds((prev) => {
      const next = new Set(prev);
      next.add(bridgeId);
      localStorage.setItem("ftown:hiddenBridges", JSON.stringify([...next]));
      return next;
    });
    const selected = rawSessions.find((s) => s.id === selectedSessionId);
    if (selected?.bridgeId === bridgeId) {
      setSelectedSessionId(null);
    }
  }, [rawSessions, selectedSessionId]);

  const handleUnhideBridge = useCallback((bridgeId: string) => {
    setHiddenBridgeIds((prev) => {
      const next = new Set(prev);
      next.delete(bridgeId);
      localStorage.setItem("ftown:hiddenBridges", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const handleCreateSessionOnBridge = useCallback((bridgeId: string) => {
    setSessionDefaults({ bridgeId });
    setShowNewSession(true);
  }, []);

  const handleSelectSession = useCallback((id: string | null) => {
    setSelectedSessionId(id);
    if (id) {
      setSelectedLoopId(null);
      setSelectedLoopRunId(null);
      setSidebarTab("sessions");
      setMobileTab("terminal");
    }
  }, []);

  const handleSelectLoop = useCallback((loopId: string) => {
    setSelectedLoopId(loopId);
    setSelectedSessionId(null);
    setSidebarTab("crons");
    setMobileTab("terminal");
  }, []);

  const handleSidebarTabSwitch = useCallback((tab: "sessions" | "crons") => {
    setSidebarTab(tab);
    try {
      localStorage.setItem("ftown:sidebarTab", tab);
    } catch { /* ignore */ }
  }, []);

  const handleMobileTabSwitch = useCallback((tab: "sessions" | "terminal") => {
    setMobileTab(tab);
    if (tab === "terminal") {
      scheduleTerminalRenderAdjustment();
    }
  }, [scheduleTerminalRenderAdjustment]);

  const handleCloneSession = useCallback((session: Session) => {
    setSessionDefaults({
      workingDir: session.workingDir,
      bridgeId: session.bridgeId,
      shellType: session.shellType,
    });
    setShowNewSession(true);
  }, []);

  const handleOpenNewLoop = useCallback(() => {
    setEditingLoop(null);
    setShowLoopForm(true);
  }, []);

  const handleEditLoop = useCallback((loop: Loop) => {
    setEditingLoop(loop);
    setShowLoopForm(true);
  }, []);

  const handleCloseLoopForm = useCallback(() => {
    setShowLoopForm(false);
    setEditingLoop(null);
  }, []);

  const handleSubmitLoop = useCallback(
    async (draft: LoopDraft): Promise<void> => {
      if (editingLoop) {
        // Route by the loop's OWNING bridge, never the (locked) form value — a
        // loop cannot be moved, and only its owner bridge holds the record.
        await updateLoop(editingLoop.bridgeId, editingLoop.id, draft);
      } else {
        await createLoop(draft);
      }
    },
    [editingLoop, updateLoop, createLoop]
  );

  const handleRunLoopNow = useCallback(
    (loop: Loop) => {
      runLoopNow(loop.bridgeId, loop.id).catch((err) => console.error("run_loop_now failed", err));
    },
    [runLoopNow]
  );

  const handleToggleLoopEnabled = useCallback(
    (loop: Loop) => {
      updateLoop(loop.bridgeId, loop.id, { enabled: !loop.enabled }).catch((err) =>
        console.error("update_loop failed", err)
      );
    },
    [updateLoop]
  );

  const handleDeleteLoop = useCallback(
    (loop: Loop) => {
      deleteLoop(loop.bridgeId, loop.id).catch((err) => console.error("delete_loop failed", err));
      if (selectedLoopId === loop.id) {
        setSelectedLoopId(null);
        setSelectedLoopRunId(null);
        setSelectedLoopRuns([]);
      }
    },
    [deleteLoop, selectedLoopId]
  );

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem("ftown:sidebarCollapsed", String(next));
      setTimeout(() => terminalRef.current?.refit(), 250);
      return next;
    });
  }, []);

  return (
    <div
      ref={rootRef}
      className="h-dvh flex flex-col"
      style={{ background: "var(--bg-void)" }}
    >
      {/* ── Top Chrome ── */}
      <header
        className="shrink-0 flex items-center justify-between px-4"
        style={{
          height: "calc(44px + env(safe-area-inset-top))",
          paddingTop: "env(safe-area-inset-top)",
          paddingLeft: "max(16px, env(safe-area-inset-left))",
          paddingRight: "max(16px, env(safe-area-inset-right))",
          borderBottom: "1px solid var(--border-muted)",
          background: "linear-gradient(180deg, var(--bg-surface) 0%, var(--bg-base) 100%)",
        }}
      >
        {/* Left cluster */}
        <div className="flex items-center gap-3">
          {/* Wordmark */}
          <div className="flex items-center gap-1.5" style={{ userSelect: "none" }}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="20" height="20">
              <defs>
                <linearGradient id="ng" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#33ffaa" />
                  <stop offset="100%" stopColor="#00ff88" />
                </linearGradient>
              </defs>
              <rect x="4" y="4" width="56" height="56" rx="12" fill="#0a0a0d"/>
              <path d="M20 16 L20 48 M20 16 L40 16 M20 32 L34 32" stroke="#00ff88" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              <circle cx="48" cy="16" r="4" fill="url(#ng)"/>
              <circle cx="48" cy="32" r="4" fill="url(#ng)"/>
              <circle cx="48" cy="48" r="4" fill="url(#ng)"/>
              <line x1="40" y1="16" x2="44" y2="16" stroke="#00ff88" strokeWidth="2" opacity="0.6"/>
              <line x1="34" y1="32" x2="44" y2="32" stroke="#00ff88" strokeWidth="2" opacity="0.6"/>
              <line x1="20" y1="48" x2="44" y2="48" stroke="#00ff88" strokeWidth="2" opacity="0.6"/>
            </svg>
            <span
              style={{
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: "0.15em",
                color: "var(--accent)",
                textTransform: "uppercase",
                textShadow: "0 0 12px var(--accent-glow)",
              }}
            >
              ftown
            </span>
          </div>

          <span style={{ width: 1, height: 16, background: "var(--border-muted)" }} />

          <button
            className="btn-accent"
            onClick={() => setShowNewSession(true)}
            disabled={!hasBridges}
            title={hasBridges ? "Create a new session" : "No bridges online — start a bridge first"}
            style={{ padding: "4px 8px", lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="8" y1="3" x2="8" y2="13" />
              <line x1="3" y1="8" x2="13" y2="8" />
            </svg>
          </button>

          <button
            className="btn-ghost"
            onClick={handleOpenNewLoop}
            disabled={!hasBridges}
            title={hasBridges ? "Create a new loop" : "No bridges online — start a bridge first"}
            style={{ padding: "4px 8px", lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 8a6 6 0 0 1 10.5-4M14 8a6 6 0 0 1-10.5 4" />
              <path d="M12.5 4H14V2.5" />
              <path d="M3.5 12H2v1.5" />
            </svg>
          </button>

          <button
            className="btn-ghost hidden md:inline-flex"
            onClick={refreshSessions}
            title="Refresh sessions"
            style={{ padding: "4px 8px", lineHeight: 1, alignItems: "center", justifyContent: "center" }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 1v5h5" />
              <path d="M3.51 10a5 5 0 1 0 .49-5.38L1 6" />
            </svg>
          </button>

          <button
            className="btn-ghost hidden md:inline-flex"
            onClick={() => setShowToken(!showToken)}
            style={showToken ? { color: "var(--accent)", borderColor: "var(--accent-dim)" } : {}}
          >
            Connect a bridge
          </button>

          {selectedSession?.status === "running" && (
            <button className="btn-danger" onClick={handleStopSession}>
              Stop
            </button>
          )}
          {selectedSession?.status === "error" && (
            <button className="btn-warn" onClick={handleRetrySession}>
              Retry
            </button>
          )}
        </div>

        {/* Right cluster */}
        <div className="hidden md:flex items-center gap-4">
          {connectionError && (
            <span style={{ fontSize: 11, color: "var(--status-error)" }}>
              {connectionError}
            </span>
          )}

          {/* Bridge count */}
          <div
            className="flex items-center gap-1.5"
            title={bridges.map((b) => `${b.bridgeId} (${b.hostname})`).join("\n")}
          >
            <span
              className={`status-dot ${hasBridges ? "status-dot-running" : "status-dot-error"}`}
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
              {bridges.length} {bridges.length === 1 ? "bridge" : "bridges"}
            </span>
          </div>

          <span style={{ width: 1, height: 12, background: "var(--border-muted)" }} />

          {/* Connection status */}
          <div className="flex items-center gap-1.5">
            <ConnectionDot status={connectionStatus} />
            <span
              style={{
                fontSize: 11,
                color: connectionStatus === "error" || connectionStatus === "disconnected"
                  ? "var(--status-error)"
                  : "var(--text-muted)",
                textTransform: "capitalize",
              }}
            >
              {connectionStatus}
            </span>
          </div>

          <span style={{ width: 1, height: 12, background: "var(--border-muted)" }} />

          <a
            href="https://github.com/fmktech/ftown"
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub"
            aria-label="View ftown on GitHub"
            style={{ color: "var(--text-faint)", display: "flex", alignItems: "center", transition: "color 0.15s" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
          </a>

          <span style={{ width: 1, height: 12, background: "var(--border-muted)" }} />

          <div ref={userMenuRef} style={{ position: "relative" }}>
            <button
              onClick={() => setShowUserMenu((v) => !v)}
              title={userId}
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "#444",
                border: "1px solid var(--border-muted)",
                color: "#fff",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                letterSpacing: "0.04em",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                lineHeight: 1,
                transition: "border-color 0.15s, color 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--accent-dim)";
                e.currentTarget.style.color = "var(--text-primary)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border-muted)";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
            >
              {userId.charAt(0).toUpperCase()}
            </button>
            {showUserMenu && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-muted)",
                  borderRadius: 6,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                  padding: "4px 0",
                  minWidth: 160,
                  zIndex: 100,
                  fontFamily: "var(--font-mono)",
                }}
              >
                <div
                  style={{
                    padding: "6px 12px",
                    fontSize: 11,
                    color: "var(--text-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 200,
                  }}
                >
                  {userId}
                </div>
                <div style={{ height: 1, background: "var(--border-muted)", margin: "2px 0" }} />
                <button
                  onClick={() => {
                    setShowUserMenu(false);
                    onDisconnect();
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "6px 12px",
                    fontSize: 11,
                    color: "var(--text-faint)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    transition: "color 0.15s, background 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--status-error)";
                    e.currentTarget.style.background = "rgba(255,255,255,0.03)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--text-faint)";
                    e.currentTarget.style.background = "none";
                  }}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── CLI Token bar ── */}
      {showToken && (
        <div
          className="shrink-0 px-4 py-3 fade-in"
          style={{
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--bg-surface)",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Connect a bridge:
            </span>
            <button
              className="btn-ghost"
              onClick={async () => {
                const text = `npx -y ftown-bridge@latest --api-url ${window.location.origin}`;
                try {
                  await navigator.clipboard.writeText(text);
                } catch {
                  const ta = document.createElement("textarea");
                  ta.value = text;
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand("copy");
                  document.body.removeChild(ta);
                }
                setTokenCopied(true);
                setTimeout(() => setTokenCopied(false), 2000);
              }}
              style={tokenCopied ? { color: "var(--accent)", borderColor: "var(--accent-dim)" } : {}}
            >
              {tokenCopied ? "✓ Copied" : "Copy"}
            </button>
          </div>
          <code
            style={{
              display: "block",
              fontSize: 11,
              color: "var(--text-muted)",
              background: "var(--bg-void)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              padding: "6px 10px",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.02em",
            }}
          >
            npx -y ftown-bridge@latest --api-url {typeof window !== "undefined" ? window.location.origin : ""}
          </code>
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6 }}>
            Run this on the machine, then approve it here:{" "}
            <a href="/pair" style={{ color: "var(--accent)" }}>
              Approve a device
            </a>
            {" · "}
            <a href="/devices" style={{ color: "var(--accent)" }}>
              Manage devices
            </a>
          </div>
        </div>
      )}

      {/* ── Mobile Tab Bar ── */}
      <div
        className="flex md:hidden shrink-0"
        style={{
          borderBottom: "1px solid var(--border-muted)",
          background: "var(--bg-surface)",
        }}
      >
        <button
          className={`mobile-tab ${mobileTab === "sessions" ? "mobile-tab-active" : ""}`}
          onClick={() => handleMobileTabSwitch("sessions")}
        >
          Workspace
        </button>
        <button
          className={`mobile-tab ${mobileTab === "terminal" ? "mobile-tab-active" : ""}`}
          onClick={() => handleMobileTabSwitch("terminal")}
        >
          Terminal
        </button>
      </div>

      {/* ── Main Layout ── */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        <aside
          id="dashboard-sidebar"
          className={`shrink-0 flex-col w-full ${sidebarCollapsed ? "md:w-[60px]" : "md:w-[260px]"} ${mobileTab === "sessions" ? "flex" : "hidden"} md:flex`}
          style={{
            borderRight: "1px solid var(--border-subtle)",
            background: "var(--bg-surface)",
            overflow: "hidden",
            transition: "width 0.2s ease",
          }}
        >
          <div
            className="shrink-0 hidden md:flex items-center"
            style={{
              height: 36,
              borderBottom: "1px solid var(--border-subtle)",
              padding: sidebarCollapsed ? "0" : "0 16px",
              justifyContent: sidebarCollapsed ? "center" : "space-between",
            }}
          >
            {sidebarCollapsed ? (
              <button
                onClick={toggleSidebar}
                title="Expand sidebar"
                aria-label="Expand sidebar"
                aria-expanded={!sidebarCollapsed}
                aria-controls="dashboard-sidebar"
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-muted)",
                  fontSize: 14,
                  padding: "2px 4px",
                  fontFamily: "var(--font-mono)",
                  lineHeight: 1,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
              >
                »
              </button>
            ) : (
              <>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "var(--text-muted)",
                  }}
                >
                  Bridges
                </span>
                <div className="flex items-center gap-2">
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--text-faint)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {sessions.length}
                  </span>
                  <button
                    onClick={toggleSidebar}
                    title="Collapse sidebar"
                    aria-label="Collapse sidebar"
                    aria-expanded={!sidebarCollapsed}
                    aria-controls="dashboard-sidebar"
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-faint)",
                      fontSize: 14,
                      padding: "2px 4px",
                      fontFamily: "var(--font-mono)",
                      lineHeight: 1,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
                  >
                    «
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {isDesktop && sidebarCollapsed ? (
              <div
                role="tablist"
                aria-label="Sidebar sections"
                className="sidebar-tabs-collapsed"
              >
                <button
                  role="tab"
                  aria-selected={sidebarTab === "sessions"}
                  aria-label={`Sessions (${normalSessions.length})`}
                  title={`Sessions (${normalSessions.length})`}
                  onClick={() => handleSidebarTabSwitch("sessions")}
                  className={`sidebar-tab-icon ${sidebarTab === "sessions" ? "sidebar-tab-active" : ""}`}
                >
                  ▤
                </button>
                <button
                  role="tab"
                  aria-selected={sidebarTab === "crons"}
                  aria-label={`Crons (${cronLoopCount})`}
                  title={`Crons (${cronLoopCount})`}
                  onClick={() => handleSidebarTabSwitch("crons")}
                  className={`sidebar-tab-icon ${sidebarTab === "crons" ? "sidebar-tab-active" : ""}`}
                >
                  ◷
                </button>
              </div>
            ) : (
              <div
                role="tablist"
                aria-label="Sidebar sections"
                className="sidebar-tabs sidebar-tabs-sticky"
              >
                <button
                  role="tab"
                  aria-selected={sidebarTab === "sessions"}
                  onClick={() => handleSidebarTabSwitch("sessions")}
                  className={`sidebar-tab ${sidebarTab === "sessions" ? "sidebar-tab-active" : ""}`}
                >
                  Sessions <span className="sidebar-tab-count">{normalSessions.length}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={sidebarTab === "crons"}
                  onClick={() => handleSidebarTabSwitch("crons")}
                  className={`sidebar-tab ${sidebarTab === "crons" ? "sidebar-tab-active" : ""}`}
                >
                  Crons <span className="sidebar-tab-count">{cronLoopCount}</span>
                </button>
              </div>
            )}
            {sidebarTab === "crons" ? (
              <LoopList
                loops={loops}
                bridges={bridges}
                selectedLoopId={selectedLoopId}
                onSelectLoop={handleSelectLoop}
                onRunNow={handleRunLoopNow}
                onToggleEnabled={handleToggleLoopEnabled}
                onEdit={handleEditLoop}
                onDelete={handleDeleteLoop}
                collapsed={isDesktop && sidebarCollapsed}
              />
            ) : (
              <SessionList
                sessions={normalSessions}
                bridges={bridges}
                bridgeOrder={bridgeOrder}
                selectedSessionId={selectedSessionId}
                onSelectSession={handleSelectSession}
                onRenameSession={renameSession}
                onStopSession={stopSession}
                onRemoveSession={handleRemoveSession}
                onCloneSession={handleCloneSession}
                onReorderSessions={handleReorderSessions}
                onReorderBridges={handleReorderBridges}
                sessionActivity={sessionActivity}
                collapsed={isDesktop && sidebarCollapsed}
                hiddenSessionIds={hiddenSessionIds}
                hiddenBridgeIds={hiddenBridgeIds}
                onHideSession={handleHideSession}
                onUnhideSession={handleUnhideSession}
                onHideBridge={handleHideBridge}
                onUnhideBridge={handleUnhideBridge}
                onCreateSession={handleCreateSessionOnBridge}
              />
            )}
          </div>
        </aside>

        {/* Terminal area */}
        <main className={`flex-1 flex-col min-h-0 min-w-0 ${mobileTab === "terminal" ? "flex" : "hidden"} md:flex`}>
          {selectedLoop ? (
            <LoopDetailPane
              loop={selectedLoop}
              runs={selectedLoopRuns}
              selectedRunId={selectedLoopRunId}
              loadingRuns={loopRunsLoading}
              runsError={loopRunsError}
              onSelectRun={setSelectedLoopRunId}
              onRunNow={handleRunLoopNow}
              onToggleEnabled={handleToggleLoopEnabled}
              onEdit={handleEditLoop}
              onDelete={handleDeleteLoop}
              liveSession={liveLoopRunSession}
              transport={transport}
              usage={liveLoopRunSession ? sessionActivity.get(liveLoopRunSession.id)?.usage : undefined}
              terminalRef={terminalRef}
              onInterrupt={handleLoopRunInterrupt}
            />
          ) : (
            <Terminal
              ref={terminalRef}
              transport={transport}
              sessionId={selectedSessionId}
              bridgeId={selectedSession?.bridgeId ?? null}
              isRunning={selectedSession?.status === "running"}
              sessionName={selectedSession?.name ?? selectedSession?.prompt?.slice(0, 48) ?? null}
              usage={selectedSessionId ? sessionActivity.get(selectedSessionId)?.usage : undefined}
              onMobileTap={() => mobileControlRef.current?.focusInput()}
              shellType={selectedSession?.shellType}
              onInterrupt={handleTerminalInterrupt}
            />
          )}
          {selectedSessionId && !selectedLoop && (
            <MobileControlBar ref={mobileControlRef} onSendInput={(data) => terminalRef.current?.sendInput(data)} />
          )}
        </main>

      </div>

      <NewSessionModal
        isOpen={showNewSession}
        onClose={() => { setShowNewSession(false); setSessionDefaults(undefined); }}
        onSubmit={handleCreateSession}
        bridges={bridges}
        defaults={sessionDefaults}
        bridgeExec={bridgeExec}
      />

      <LoopFormModal
        isOpen={showLoopForm}
        onClose={handleCloseLoopForm}
        onSubmit={handleSubmitLoop}
        bridges={bridges}
        editingLoop={editingLoop}
      />

      <ConnectionDiagnostics
        connectionStatus={connectionStatus}
        connectionError={connectionError}
        centrifugoUrl={centrifugoUrl}
        token={token}
        onRetry={() => window.location.reload()}
      />

    </div>
  );
}
