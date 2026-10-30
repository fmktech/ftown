"use client";

import { useState, useCallback, useMemo, useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { MessageClient } from "@/lib/message-client";
import { ConnectionStatus } from "@/hooks/useCentrifugo";
import { TerminalTransportApi } from "@/lib/direct-transport/contract";
import { Session, ShellType } from "@/types";
import { CreateSessionOptions, useSessions } from "@/hooks/useSessions";
import { useBridgeRpc } from "@/hooks/useBridgeRpc";
import { useBridges } from "@/hooks/useBridges";
import { useBridgeUpdates } from "@/hooks/useBridgeUpdates";
import { BridgeUpdatesDialog } from "./BridgeUpdatesDialog";
import { AppUpdateNotice } from "./AppUpdateNotice";
import { useAllSessionEvents } from "@/hooks/useAllSessionEvents";
import type { SecurityCommand, SecurityCommandResults } from "@security/protocol";
import { SecurityPanel, type SecurityBridge } from "./SecurityPanel";
import { SecurityLockIcon } from "./SecurityLockIcon";
import { usePendingApprovals } from "@/hooks/usePendingApprovals";
import type { AccountSecurityClient, AccountSecuritySnapshot } from "@/lib/account-security-client";
import { SessionList } from "./SessionList";
import { PullRequestStatusProvider } from "./PullRequestStatusProvider";
import { Terminal, TerminalHandle } from "./Terminal";
import { MobileControlBar, MobileControlBarHandle } from "./MobileControlBar";
import { NewSessionModal, SessionDefaults } from "./NewSessionModal";
import { CloudConnectionNotice } from "./CloudConnectionNotice";
import { HeaderTooltip } from "./HeaderTooltip";
import { PushNotificationsControl, detachPushSubscription } from "./PushNotificationsControl";
import { mergeBridgeOrder } from "@/lib/bridge-order";
import { buildBridgeCommand } from "@/lib/bridge-command";
import { StatusDot } from "@/lib/StatusDot";
import { usePersistentState, useHiddenSet } from "@/lib/use-persistent-state";
import { deriveSessionReachabilityStatus } from "@/lib/session-reachability";
import { getSessionRelaunchLabel } from "@/lib/session-relaunch";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_KEYBOARD_STEP,
  clampSidebarWidth,
  sidebarWidthFromDrag,
} from "@/lib/sidebar-width";

function NavigationIcon({ kind }: { kind: "bridge" | "local" | "p2p" | "cloud" | "menu" | "switch" }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {kind === "bridge" || kind === "local" ? <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" />{kind === "local" && <path d="M7 10h10" />}</>
      : kind === "p2p" ? <><circle cx="5" cy="7" r="3" /><circle cx="19" cy="7" r="3" /><circle cx="12" cy="19" r="3" /><path d="m7 10 3 6m7-6-3 6M8 7h8" /></>
      : kind === "cloud" ? <path d="M7 18a5 5 0 0 1-1-10 6 6 0 0 1 11-2 5 5 0 1 1 1 12H7Z" />
      : kind === "menu" ? <path d="M4 6h16M4 12h16M4 18h16" /> : <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />}
  </svg>;
}

interface DashboardProps {
  client: MessageClient | null;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  userId: string;
  token: string;
  centrifugoUrl: string;
  /** One HybridTerminalTransport per live Centrifugo connection; consumed by
   *  useTerminal once the terminal component is wired to it. */
  transport: TerminalTransportApi | null;
  onDisconnect: () => void;
  localMode?: boolean;
  accountClient?: AccountSecurityClient;
  accountState?: AccountSecuritySnapshot;
}

/** Only validated same-machine paths identify the browser's current computer. */
export function deriveCurrentComputerIds({ localMode, connectionStatus, localBridgeId, sessions, transport, bridges }: {
  localMode: boolean; connectionStatus: ConnectionStatus; localBridgeId?: string;
  sessions: readonly Pick<Session, "id" | "bridgeId">[]; transport: Pick<TerminalTransportApi, "getMode"> | null;
  bridges: readonly SecurityBridge[];
}): ReadonlySet<string> {
  const current = new Set<string>();
  if (connectionStatus !== "connected") return current;
  const ready = new Set(bridges.filter(bridge => bridge.security.status === "ready").map(bridge => bridge.bridgeId));
  if (localMode && localBridgeId && ready.has(localBridgeId)) current.add(localBridgeId);
  for (const session of sessions) if (ready.has(session.bridgeId) && transport?.getMode(session.id) === "local") current.add(session.bridgeId);
  return current;
}

export function Dashboard({ client, connectionStatus, connectionError, userId, token, centrifugoUrl, transport, onDisconnect, localMode = false, accountClient, accountState }: DashboardProps) {
  const connectCommand = buildBridgeCommand({ apiUrl: typeof window !== "undefined" ? window.location.origin : "" });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showNewSession, setShowNewSession] = useState(false);
  const [sessionDefaults, setSessionDefaults] = useState<SessionDefaults | undefined>(undefined);
  const [showToken, setShowToken] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [mobileTab, setMobileTab] = useState<"sessions" | "terminal">("sessions");
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState<boolean>("ftown:sidebarCollapsed", false);
  const [storedSidebarWidth, setStoredSidebarWidth] = usePersistentState<number>("ftown:sidebarWidth", DEFAULT_SIDEBAR_WIDTH);
  const sidebarWidth = clampSidebarWidth(storedSidebarWidth);
  const [sessionOrder, setSessionOrder] = usePersistentState<string[]>("ftown:sessionOrder", []);
  const [bridgeOrder, setBridgeOrder] = usePersistentState<string[]>("ftown:bridgeOrder", []);
  const { hidden: hiddenSessionIds, hide: handleHideSession, unhide: handleUnhideSession } = useHiddenSet("ftown:hiddenSessions");
  const { hidden: hiddenBridgeIds, hide: hideBridge, unhide: handleUnhideBridge } = useHiddenSet("ftown:hiddenBridges");
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNavigation, setShowNavigation] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [updateBridgeId, setUpdateBridgeId] = useState<string | null>(null);
  const [securityView, setSecurityView] = useState<"activity" | "devices">("devices");
  const pending = usePendingApprovals(accountClient, "reviewer");
  const pendingCount = pending.snapshot.inbox.filter(item => !["approved", "rejected", "cancelled", "expired", "conflict"].includes(item.status)).length;
  const [securityBridgeId, setSecurityBridgeId] = useState<string | undefined>(undefined);
  const [securityGeneration, setSecurityGeneration] = useState(0);
  const [localityGeneration, setLocalityGeneration] = useState(0);
  const [directlyReachableBridgeIds, setDirectlyReachableBridgeIds] = useState<Set<string>>(
    () => new Set()
  );
  const terminalRef = useRef<TerminalHandle>(null);
  const mobileControlRef = useRef<MobileControlBarHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarResizeRef = useRef<{
    pointerId: number;
    startClientX: number;
    startWidth: number;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);
  const sidebarRefitFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!transport) {
      setDirectlyReachableBridgeIds(new Set());
      return;
    }

    const unsubscribe = transport.onBridgeReachabilityChange((bridgeId, reachable) => {
      setLocalityGeneration(value => value + 1);
      setDirectlyReachableBridgeIds((current) => {
        const next = new Set(current);
        if (reachable) next.add(bridgeId);
        else next.delete(bridgeId);
        return next;
      });
    });
    setDirectlyReachableBridgeIds(new Set(transport.getDirectlyReachableBridgeIds()));
    const unsubscribeMode = transport.onModeChange(() => setLocalityGeneration(value => value + 1));
    return () => { unsubscribe(); unsubscribeMode(); };
  }, [transport]);

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

  // The bridge-RPC transport over `commands:rpc#{userId}` is created ONCE here;
  // session management consumes this shared transport.
  const rpc = useBridgeRpc(client, userId);
  const { bridgeExec } = rpc;
  const { sessions: rawSessions, createSession, stopSession, retrySession, renameSession, setSessionParent, removeSession } = useSessions(client, userId, rpc);
  const { bridges, prepareLocalAccess } = useBridges(client, userId);
  const securityRuntime = client?.securityRuntime;
  useEffect(() => securityRuntime?.onChange(() => setSecurityGeneration(value => value + 1)), [securityRuntime]);
  const readyBridges = useMemo(() => bridges.filter(bridge => securityRuntime?.state(bridge.bridgeId).status === "ready"), [bridges, securityRuntime, securityGeneration]);
  const updateIds = connectionStatus === "connected" ? readyBridges.map(bridge => bridge.bridgeId) : [];
  const updates = useBridgeUpdates(rpc.sendCommand, updateIds);
  const updateViews = new Map(bridges.map(bridge => [bridge.bridgeId, updates.get(bridge.bridgeId)]));
  const hasBridges = readyBridges.length > 0;
  const securityBridges = useMemo(() => {
    const known = new Map(bridges.map(bridge => [bridge.bridgeId, { bridgeId: bridge.bridgeId, label: bridge.hostname,
      security: securityRuntime?.state(bridge.bridgeId) ?? { bridgeId: bridge.bridgeId, status: "unpaired" as const, endpoint: null } }]));
    for (const state of securityRuntime?.snapshot() ?? []) if (!known.has(state.bridgeId)) known.set(state.bridgeId, { bridgeId: state.bridgeId, label: state.bridgeId, security: state });
    return [...known.values()];
  }, [bridges, securityRuntime, securityGeneration]);
  const currentComputerIds = useMemo(() => deriveCurrentComputerIds({ localMode, connectionStatus,
    localBridgeId: client?.sessionSnapshotBridgeId, sessions: rawSessions, transport, bridges: securityBridges }),
  [localMode, connectionStatus, client, rawSessions, transport, securityBridges, localityGeneration]);
  const bridgeSecurityStates = useMemo(() => new Map(securityBridges.map(bridge => [bridge.bridgeId, bridge.security.status])), [securityBridges]);
  const executeSecurity = useCallback(<C extends SecurityCommand>(command: C): Promise<SecurityCommandResults[C["type"]]> => {
    if (!client?.executeSecurity) return Promise.reject({ code: "security_setup_required" });
    return client.executeSecurity(command);
  }, [client]);
  const closeNavigation = useCallback((restoreFocus = false) => { setShowNavigation(false); if (restoreFocus) navigationButtonRef.current?.focus(); }, []);
  const openSecurity = useCallback((bridgeId?: string) => { if (showNavigation) closeNavigation(true); setSecurityView("devices"); setSecurityBridgeId(bridgeId); setShowSecurity(true); }, [showNavigation, closeNavigation]);
  useEffect(() => {
    if (!showNavigation) return;
    const outside = (event: globalThis.PointerEvent) => { if (!navigationRef.current?.contains(event.target as Node) && !navigationButtonRef.current?.contains(event.target as Node)) closeNavigation(true); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeNavigation(true); } };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
  }, [showNavigation, closeNavigation]);
  useEffect(() => { if (isDesktop) setShowNavigation(false); }, [isDesktop]);

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
      return next;
    });
  }, [bridges, rawSessions, setBridgeOrder]);
  const { sessionActivity, markSessionIdle, clearSessionAttention } = useAllSessionEvents(client, rawSessions, userId, rpc);
  const installedHookBridges = useRef(new Set<string>());

  useEffect(() => {
    for (const bridge of readyBridges) {
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
  }, [readyBridges, bridgeExec]);

  const activeBridgeIds = useMemo(() => new Set(bridges.map((b) => b.bridgeId)), [bridges]);

  const sessions = useMemo(() => {
    const mapped = rawSessions.map((s) => {
      const status = deriveSessionReachabilityStatus(
        s.status,
        s.bridgeId,
        activeBridgeIds,
        directlyReachableBridgeIds,
      );
      return status === s.status ? s : { ...s, status };
    });
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
  }, [rawSessions, activeBridgeIds, directlyReachableBridgeIds, sessionOrder, bridgeOrder]);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;
  useEffect(() => {
    if (selectedSessionId && !sessions.some(session => session.id === selectedSessionId)) setSelectedSessionId(null);
  }, [sessions, selectedSessionId]);
  const sessionRelaunchLabel = selectedSession && !selectedSession.loopId
    ? getSessionRelaunchLabel(selectedSession.status)
    : null;

  useEffect(() => {
    if (!selectedSessionId) return undefined;
    return scheduleTerminalRenderAdjustment();
  }, [selectedSessionId, scheduleTerminalRenderAdjustment]);

  const handleReorderSessions = useCallback((orderedIds: string[]) => {
    setSessionOrder(orderedIds);
  }, [setSessionOrder]);

  const handleReorderBridges = useCallback((orderedBridgeIds: string[]) => {
    setBridgeOrder(orderedBridgeIds);

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

      return newOrder;
    });
  }, [rawSessions, setBridgeOrder, setSessionOrder]);

  const handleStopSession = useCallback(() => {
    if (selectedSessionId) stopSession(selectedSessionId);
  }, [selectedSessionId, stopSession]);

  const handleRelaunchSession = useCallback(() => {
    if (selectedSessionId) retrySession(selectedSessionId);
  }, [selectedSessionId, retrySession]);
  const selectedTransportMode = selectedSessionId ? transport?.getMode(selectedSessionId) ?? "connecting" : null;
  const sessionHeaderActions = selectedSession ? <div role="group" aria-label="Selected session actions" className="flex items-center gap-2">
    {selectedSession.status === "running" && <button type="button" className="btn-danger min-h-11 md:min-h-8" onClick={handleStopSession}>Stop</button>}
    {sessionRelaunchLabel && <button type="button" className="btn-warn min-h-11 md:min-h-8" onClick={handleRelaunchSession} title="Relaunch this session using the same command">{sessionRelaunchLabel}</button>}
  </div> : null;

  // Claude's Stop hook does not fire on user interrupt, so a lone ESC leaves the
  // dashboard stuck on "thinking"/"tool_use". Optimistically clear it locally.
  // Cursor reports interrupts via postToolUseFailure, so it needs no heuristic.
  const markInterruptIdle = useCallback((sessionId: string | null, shellType?: ShellType) => {
    if (sessionId && shellType !== "cursor") markSessionIdle(sessionId);
  }, [markSessionIdle]);

  const handleTerminalInterrupt = useCallback(() => {
    markInterruptIdle(selectedSessionId, selectedSession?.shellType);
  }, [selectedSessionId, selectedSession?.shellType, markInterruptIdle]);

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

  const handleHideBridge = useCallback((bridgeId: string) => {
    hideBridge(bridgeId);
    const selected = rawSessions.find((s) => s.id === selectedSessionId);
    if (selected?.bridgeId === bridgeId) {
      setSelectedSessionId(null);
    }
  }, [hideBridge, rawSessions, selectedSessionId]);

  const handleCreateSessionOnBridge = useCallback((bridgeId: string) => {
    setSessionDefaults({ bridgeId });
    setShowNewSession(true);
  }, []);

  const handleSelectSession = useCallback((id: string | null) => {
    setSelectedSessionId(id);
    if (id) {
      setMobileTab("terminal");
    }
  }, []);

  const handleCreateSession = useCallback(
    async (prompt: string, options: CreateSessionOptions): Promise<void> => {
      const created = await createSession(prompt, options);
      handleSelectSession(created.id);
      scheduleTerminalRenderAdjustment();
    },
    [createSession, handleSelectSession, scheduleTerminalRenderAdjustment]
  );

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session");
    if (sessionId && rawSessions.some((session) => session.id === sessionId)) {
      handleSelectSession(sessionId);
      const url = new URL(window.location.href); url.searchParams.delete("session");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    const onNotification = (event: MessageEvent) => {
      if (event.data?.type === "ftown-open-session" && typeof event.data.sessionId === "string"
        && rawSessions.some((session) => session.id === event.data.sessionId)) handleSelectSession(event.data.sessionId);
    };
    navigator.serviceWorker?.addEventListener("message", onNotification);
    return () => navigator.serviceWorker?.removeEventListener("message", onNotification);
  }, [rawSessions, handleSelectSession]);

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

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
    setTimeout(() => terminalRef.current?.refit(), 250);
  }, [setSidebarCollapsed]);

  const scheduleSidebarRefit = useCallback(() => {
    if (sidebarRefitFrameRef.current !== null) return;
    sidebarRefitFrameRef.current = window.requestAnimationFrame(() => {
      sidebarRefitFrameRef.current = null;
      terminalRef.current?.refit();
    });
  }, []);

  const updateSidebarWidth = useCallback((width: number) => {
    setStoredSidebarWidth(clampSidebarWidth(width));
    scheduleSidebarRefit();
  }, [scheduleSidebarRefit, setStoredSidebarWidth]);

  const finishSidebarResize = useCallback((element?: HTMLDivElement, pointerId?: number) => {
    const active = sidebarResizeRef.current;
    if (!active) return;
    if (element && pointerId !== undefined && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
    document.body.style.cursor = active.previousCursor;
    document.body.style.userSelect = active.previousUserSelect;
    sidebarResizeRef.current = null;
    scheduleSidebarRefit();
  }, [scheduleSidebarRefit]);

  const handleSidebarResizeStart = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (sidebarCollapsed || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizeRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth: sidebarWidth,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [sidebarCollapsed, sidebarWidth]);

  const handleSidebarResizeMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const active = sidebarResizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    updateSidebarWidth(sidebarWidthFromDrag(active.startWidth, active.startClientX, event.clientX));
  }, [updateSidebarWidth]);

  const handleSidebarResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = sidebarWidth - SIDEBAR_KEYBOARD_STEP;
    if (event.key === "ArrowRight") nextWidth = sidebarWidth + SIDEBAR_KEYBOARD_STEP;
    if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH;
    if (event.key === "End") nextWidth = MAX_SIDEBAR_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    updateSidebarWidth(nextWidth);
  }, [sidebarWidth, updateSidebarWidth]);

  useEffect(() => () => {
    if (sidebarRefitFrameRef.current !== null) {
      window.cancelAnimationFrame(sidebarRefitFrameRef.current);
    }
    const active = sidebarResizeRef.current;
    if (active) {
      document.body.style.cursor = active.previousCursor;
      document.body.style.userSelect = active.previousUserSelect;
    }
  }, []);

  return (
    <PullRequestStatusProvider send={rpc.sendCommand} sessions={sessions.filter(s => s.id === selectedSessionId || (!hiddenSessionIds.has(s.id) && !hiddenBridgeIds.has(s.bridgeId)))} readyBridgeIds={readyBridges.map(b => b.bridgeId)} connected={connectionStatus === "connected"}>
    <div
      ref={rootRef}
      className="h-dvh flex flex-col"
      style={{ background: "var(--bg-void)" }}
    >
      {/* ── Top Chrome ── */}
      <header
        className="shrink-0 flex items-center justify-between px-4"
        style={{
          position: "relative", zIndex: 40,
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

          <HeaderTooltip label={hasBridges ? "Create a new session" : "No computers connected — start a bridge first"} focusable={!hasBridges}>
          <button
            className="btn-accent"
            aria-label="Create a new session"
            onClick={() => setShowNewSession(true)}
            disabled={!hasBridges}
            style={{ padding: "4px 8px", lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="8" y1="3" x2="8" y2="13" />
              <line x1="3" y1="8" x2="13" y2="8" />
            </svg>
          </button>
          </HeaderTooltip>

          <HeaderTooltip label="Reconnect and refresh this page" className="hidden md:inline-flex">
          <button
            type="button"
            className="btn-ghost inline-flex"
            onClick={() => window.location.reload()}
            aria-label="Reconnect and refresh"
            style={{ padding: "4px 8px", lineHeight: 1, alignItems: "center", justifyContent: "center" }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 1v5h5" />
              <path d="M3.51 10a5 5 0 1 0 .49-5.38L1 6" />
            </svg>
          </button>
          </HeaderTooltip>

          {!localMode && <button
            className="btn-ghost hidden md:inline-flex"
            onClick={() => setShowToken(!showToken)}
            style={showToken ? { color: "var(--accent)", borderColor: "var(--accent-dim)" } : {}}
          >
            Connect a bridge
          </button>}

        </div>

        <div className="ml-auto flex min-w-0 items-center gap-1.5 md:gap-2">
          <div role="group" aria-label="Connection overview" className="flex shrink-0 items-center gap-1.5 text-[var(--text-muted)]">
            <HeaderTooltip label={`Computers: ${bridges.length} connected`} focusable className="flex items-center">
              <span role="img" aria-label={`${bridges.length} bridges; ${readyBridges.length} encrypted connections ready`} className="flex items-center gap-1 text-[11px]"><NavigationIcon kind="bridge" /><span>{bridges.length}</span></span>
            </HeaderTooltip>
            <HeaderTooltip label={selectedTransportMode === "local" ? "Local: this computer" : localMode && connectionStatus === "connected" ? "Local: controller connected" : "Local: not in use"} focusable className={`${selectedTransportMode === "local" || localMode ? "flex" : "hidden md:flex"} items-center`}>
              <span role="img" aria-label={selectedTransportMode === "local" ? "Selected terminal: Local" : localMode && connectionStatus === "connected" ? "Local controller connected" : "No selected Local terminal"} style={{ color: selectedTransportMode === "local" || localMode && connectionStatus === "connected" ? "var(--status-running)" : "var(--text-faint)" }}><NavigationIcon kind="local" /></span>
            </HeaderTooltip>
            <HeaderTooltip label={selectedTransportMode === "direct" ? "Peer-to-peer: direct connection" : "Peer-to-peer: not in use"} focusable className={`${selectedTransportMode === "direct" ? "flex" : "hidden md:flex"} items-center`}>
              <span role="img" aria-label={selectedTransportMode === "direct" ? "Selected terminal: P2P" : "No selected P2P terminal"} style={{ color: selectedTransportMode === "direct" ? "var(--status-running)" : "var(--text-faint)" }}><NavigationIcon kind="p2p" /></span>
            </HeaderTooltip>
            {localMode ? <HeaderTooltip label="Cloud: not in use" focusable className="flex items-center text-[var(--text-faint)]"><span role="img" aria-label="Cloud not in use"><NavigationIcon kind="cloud" /></span></HeaderTooltip>
              : <div role="group" aria-label={`Cloud ${connectionStatus}`} className="[&>div>button]:min-h-11 [&>div>button]:min-w-11 [&>div>button]:justify-center md:[&>div>button]:min-h-8 md:[&>div>button]:min-w-8">
                <CloudConnectionNotice connectionStatus={connectionStatus} connectionError={connectionError} centrifugoUrl={centrifugoUrl} token={token} onRetry={() => window.location.reload()} directBridgeCount={directlyReachableBridgeIds.size}>
                  <span role="img" aria-label={`Cloud ${connectionStatus}${selectedTransportMode === "centrifugo" ? "; selected terminal: Cloud" : ""}`} style={{ color: connectionStatus === "connected" ? "var(--text-muted)" : "var(--status-pending)" }}><NavigationIcon kind="cloud" /></span>
                </CloudConnectionNotice>
              </div>}
          </div>
          <HeaderTooltip label="Dashboard menu" className="flex md:hidden">
          <button ref={navigationButtonRef} type="button" className="btn-ghost flex min-h-11 min-w-11 items-center justify-center" aria-label={showNavigation ? "Close navigation menu" : "Open navigation menu"} aria-expanded={showNavigation} aria-controls="dashboard-navigation" onClick={() => setShowNavigation(value => !value)}><NavigationIcon kind="menu" /></button>
          </HeaderTooltip>
          <nav id="dashboard-navigation" ref={navigationRef} aria-label="Dashboard actions" hidden={!isDesktop && !showNavigation}
            className={`${isDesktop || showNavigation ? "flex" : "hidden"} absolute right-2 top-full z-50 mt-1 max-h-[calc(100dvh_-_60px)] w-[min(288px,calc(100vw_-_16px))] flex-col gap-2 overflow-y-auto rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] p-3 shadow-xl md:static md:mt-0 md:w-auto md:max-h-none md:flex-row md:items-center md:overflow-visible md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none`}>
            {accountState?.status === "ready" && <HeaderTooltip label={pendingCount ? `Review ${pendingCount} pending device approvals` : "Review device approvals"} className="flex">
              <button type="button" className="btn-ghost relative flex min-h-11 items-center gap-2 text-left md:h-8 md:min-h-8 md:w-8 md:justify-center" style={{ padding: "4px 6px", color: pendingCount ? "var(--accent)" : undefined }} aria-label={pendingCount ? `Review ${pendingCount} pending device approvals` : "Review device approvals"} onClick={() => { if (showNavigation) closeNavigation(true); setSecurityView("devices"); setShowSecurity(true); }}>
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H5v18h14v-9M9 8h5M9 12h3M9 16h3M15 7l2 2 4-4" /></svg>
                <span className="md:sr-only">Review approvals{pendingCount ? ` (${pendingCount})` : ""}</span>
                {pendingCount > 0 && <span aria-hidden="true" className="hidden md:flex absolute -right-1 -top-1 min-w-4 h-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-bold text-[var(--bg-void)]">{pendingCount}</span>}
              </button>
            </HeaderTooltip>}
            <button type="button" className="btn-ghost flex min-h-11 items-center gap-2 text-left md:hidden" aria-label="Reconnect and refresh" title="Reconnect and refresh (reload this page)" onClick={() => window.location.reload()}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 1v5h5" /><path d="M3.51 10a5 5 0 1 0 .49-5.38L1 6" /></svg>
              <span>Reconnect and refresh</span>
            </button>
            <PushNotificationsControl localMode={localMode} accountId={userId} presentation="responsive" />
            <HeaderTooltip label={`Security: computer and browser access${pendingCount ? `; ${pendingCount} requests` : ""}`} className="flex"><button type="button" className="btn-ghost flex min-h-11 items-center gap-2 md:min-h-8 md:w-8 md:justify-center" style={{ padding: "4px 6px" }} aria-label="Open security" onClick={() => openSecurity()}><SecurityLockIcon state="unknown" /><span className="md:sr-only">Security{pendingCount > 0 ? ` (${pendingCount})` : ""}</span></button></HeaderTooltip>
            <HeaderTooltip label={localMode ? "Switch to cloud" : "Switch to this computer"} className="flex"><a href={localMode ? "/dashboard" : "/local"} style={{ padding: "4px 6px" }} aria-label={localMode ? "Use Cloud" : "Use This computer"} onClick={localMode ? () => closeNavigation() : event => { event.preventDefault(); closeNavigation(); void prepareLocalAccess().then(() => { window.location.href = "/local"; }); }} className="btn-ghost flex min-h-11 items-center gap-2 md:min-h-8 md:w-8 md:justify-center"><NavigationIcon kind="switch" /><span className="md:sr-only">{localMode ? "Cloud" : "This computer"}</span></a></HeaderTooltip>
            <p className="text-xs text-[var(--text-muted)] md:hidden">{localMode ? `This computer: ${connectionStatus}` : `Cloud: ${connectionStatus}`} · Selected terminal: {selectedTransportMode === "local" ? "Local" : selectedTransportMode === "direct" ? "P2P" : selectedTransportMode === "centrifugo" ? "Cloud" : "none / connecting"}{connectionError ? ` · ${connectionError}` : ""}</p>
            <HeaderTooltip label="FTown on GitHub" className="hidden md:flex">          <a
            href="https://github.com/fmktech/ftown"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View ftown on GitHub"
            style={{ color: "var(--text-faint)", display: "flex", alignItems: "center", transition: "color 0.15s" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
          </a></HeaderTooltip>
          <div ref={userMenuRef} hidden={!isDesktop} style={{ position: "relative" }}>
            <HeaderTooltip label={`Account: ${userId}`}>
            <button
              aria-label={`Account: ${userId}`}
              onClick={() => setShowUserMenu((v) => !v)}
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
            </HeaderTooltip>
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
                    void detachPushSubscription().catch(() => {}).finally(onDisconnect);
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
                  {localMode ? "Forget this browser" : "Disconnect"}
                </button>
              </div>
            )}
          </div>

          </nav>
        </div>
      </header>

      <AppUpdateNotice />

      {/* ── CLI Token bar ── */}
      {showToken && !localMode && (
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
                const text = connectCommand;
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
            {connectCommand}
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
          className={`dashboard-sidebar shrink-0 flex-col ${mobileTab === "sessions" ? "flex" : "hidden"} md:flex`}
          style={{
            "--dashboard-sidebar-width": `${sidebarCollapsed ? 60 : sidebarWidth}px`,
            borderRight: "1px solid var(--border-subtle)",
            background: "var(--bg-surface)",
            overflow: "hidden",
            position: "relative",
            transition: sidebarResizeRef.current ? "none" : "width 0.2s ease",
          } as CSSProperties}
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

          {!isDesktop && mobileTab === "sessions" && selectedSession && <section aria-label="Selected session header" className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-1">
            <span className="min-w-0 flex-1 truncate text-xs">{selectedSession.name || selectedSession.prompt?.slice(0, 48) || "Selected session"}</span>{sessionHeaderActions}
          </section>}
          <div className="flex-1 overflow-y-auto">
            <SessionList
              sessions={sessions}
              bridges={bridges}
              bridgeOrder={bridgeOrder}
              selectedSessionId={selectedSessionId}
              onSelectSession={handleSelectSession}
              onDismissSessionAttention={clearSessionAttention}
              onRenameSession={renameSession}
              onStopSession={stopSession}
              onRemoveSession={handleRemoveSession}
              onCloneSession={handleCloneSession}
              onSetSessionParent={setSessionParent}
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
              onOpenSecurity={openSecurity}
              bridgeSecurityStates={bridgeSecurityStates}
              bridgeUpdates={updateViews}
              onOpenUpdates={setUpdateBridgeId}
            />
          </div>
          {!sidebarCollapsed && (
            <div
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              aria-valuemin={MIN_SIDEBAR_WIDTH}
              aria-valuemax={MAX_SIDEBAR_WIDTH}
              aria-valuenow={sidebarWidth}
              tabIndex={0}
              onPointerDown={handleSidebarResizeStart}
              onPointerMove={handleSidebarResizeMove}
              onPointerUp={(event) => finishSidebarResize(event.currentTarget, event.pointerId)}
              onPointerCancel={(event) => finishSidebarResize(event.currentTarget, event.pointerId)}
              onLostPointerCapture={() => finishSidebarResize()}
              onKeyDown={handleSidebarResizeKeyDown}
              onDoubleClick={() => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
              className="sidebar-resize-handle hidden md:block"
              title="Drag to resize · double-click to reset"
            />
          )}
        </aside>

        {/* Terminal area */}
        <main aria-hidden={!isDesktop && mobileTab !== "terminal"} className={`flex-1 flex-col min-h-0 min-w-0 ${mobileTab === "terminal" ? "flex" : "hidden"} md:flex`}>
          <Terminal
            ref={terminalRef}
            transport={transport}
            sessionId={selectedSessionId}
            bridgeId={selectedSession?.bridgeId ?? null}
            isRunning={selectedSession?.status === "running"}
            headerActions={sessionHeaderActions}
            sessionName={selectedSession?.name ?? selectedSession?.prompt?.slice(0, 48) ?? null}
            pullRequestUrl={selectedSession?.pullRequestUrl}
            usage={selectedSessionId ? sessionActivity.get(selectedSessionId)?.usage : undefined}
            persistedUsage={selectedSession?.usage}
            onMobileTap={() => mobileControlRef.current?.focusInput()}
            shellType={selectedSession?.shellType}
            onInterrupt={handleTerminalInterrupt}
          />
          {selectedSessionId && (
            <MobileControlBar ref={mobileControlRef} onSendInput={(data) => terminalRef.current?.sendInput(data)} />
          )}
        </main>

      </div>

      <SecurityPanel open={showSecurity} onClose={() => setShowSecurity(false)} bridges={securityBridges}
        currentEndpointId={securityRuntime?.identity.endpoint.id ?? null} currentComputerIds={currentComputerIds} execute={executeSecurity}
        accountClient={accountClient} accountState={accountState}
        pendingClient={pending.client ?? undefined} pendingState={pending.snapshot} initialView={securityView}
        initialBridgeId={securityBridgeId} gatewayAvailable={!localMode && !securityRuntime?.ownerId.startsWith("solo:")} />
      {updateBridgeId && <BridgeUpdatesDialog open name={bridges.find(bridge => bridge.bridgeId === updateBridgeId)?.hostname ?? updateBridgeId}
        view={updates.get(updateBridgeId)} onClose={() => setUpdateBridgeId(null)} onCheck={() => void updates.check(updateBridgeId, true)} onUpdate={() => void updates.update(updateBridgeId)} />}
      <NewSessionModal
        isOpen={showNewSession}
        onClose={() => { setShowNewSession(false); setSessionDefaults(undefined); }}
        onSubmit={handleCreateSession}
        bridges={readyBridges}
        defaults={sessionDefaults}
        bridgeExec={bridgeExec}
      />

    </div>
    </PullRequestStatusProvider>
  );
}
