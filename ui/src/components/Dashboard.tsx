"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Centrifuge } from "centrifuge";
import { ConnectionStatus } from "@/hooks/useCentrifugo";
import { Session, ShellType } from "@/types";
import { useSessions } from "@/hooks/useSessions";
import { useBridges } from "@/hooks/useBridges";
import { useAllSessionEvents } from "@/hooks/useAllSessionEvents";
import { SessionList } from "./SessionList";
import { Terminal, TerminalHandle } from "./Terminal";
import { MobileControlBar } from "./MobileControlBar";
import { NewSessionModal, SessionDefaults } from "./NewSessionModal";

interface DashboardProps {
  client: Centrifuge | null;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  userId: string;
  token: string;
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

export function Dashboard({ client, connectionStatus, connectionError, userId, token, onDisconnect }: DashboardProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showNewSession, setShowNewSession] = useState(false);
  const [sessionDefaults, setSessionDefaults] = useState<SessionDefaults | undefined>(undefined);
  const [showToken, setShowToken] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [mobileTab, setMobileTab] = useState<"sessions" | "terminal">("sessions");
  const terminalRef = useRef<TerminalHandle>(null);

  const { sessions: rawSessions, createSession, stopSession, retrySession, renameSession, removeSession, refreshSessions, bridgeExec } = useSessions(client, userId);
  const { bridges, hasBridges } = useBridges(client, userId);
  const sessionActivity = useAllSessionEvents(client, rawSessions, userId);

  const installedHookBridges = useRef(new Set<string>());

  useEffect(() => {
    for (const bridge of bridges) {
      if (installedHookBridges.current.has(bridge.bridgeId)) continue;
      installedHookBridges.current.add(bridge.bridgeId);

      const script = `
mkdir -p ~/.ftown
cat > ~/.ftown/notify.sh << 'HOOKEOF'
#!/bin/bash
INPUT=$(cat)
PORT="\${FTOWN_HOOK_PORT}"
SID="\${FTOWN_SESSION_ID}"
[ -z "$PORT" ] || [ -z "$SID" ] && exit 0
echo "$INPUT" | jq -c --arg sid "$SID" '. + {ftown_session_id: $sid}' | curl -s -X POST "http://localhost:\${PORT}/hook" -H "Content-Type: application/json" -d @- > /dev/null 2>&1
exit 0
HOOKEOF
chmod +x ~/.ftown/notify.sh
python3 -c "
import json, os
p = os.path.expanduser('~/.claude/settings.json')
s = {}
try:
    with open(p) as f: s = json.load(f)
except: pass
h = s.get('hooks', {})
e = {'matcher': '', 'hooks': [{'type': 'command', 'command': os.path.expanduser('~/.ftown/notify.sh'), 'async': True}]}
for ev in ['UserPromptSubmit','Stop','PreToolUse','PostToolUse','Notification']:
    h[ev] = [e]
s['hooks'] = h
os.makedirs(os.path.dirname(p), exist_ok=True)
with open(p, 'w') as f: json.dump(s, f, indent=2)
print('hooks installed')
"`;
      bridgeExec(script, "~", bridge.bridgeId).catch(() => {});
    }
  }, [bridges, bridgeExec]);

  const activeBridgeIds = useMemo(() => new Set(bridges.map((b) => b.bridgeId)), [bridges]);

  const sessions = useMemo(() =>
    rawSessions.map((s) =>
      s.status === "running" && activeBridgeIds.size > 0 && !activeBridgeIds.has(s.bridgeId)
        ? { ...s, status: "disconnected" as const }
        : s
    ),
    [rawSessions, activeBridgeIds]
  );

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;

  const handleCreateSession = useCallback(
    (prompt: string, options: { name?: string; model?: string; workingDir?: string; bridgeId?: string; shellType?: ShellType; claudeSessionId?: string }) => {
      createSession(prompt, options);
    },
    [createSession]
  );

  const handleStopSession = useCallback(() => {
    if (selectedSessionId) stopSession(selectedSessionId);
  }, [selectedSessionId, stopSession]);

  const handleRetrySession = useCallback(() => {
    if (selectedSessionId) retrySession(selectedSessionId);
  }, [selectedSessionId, retrySession]);

  const handleRemoveSession = useCallback((sessionId: string) => {
    removeSession(sessionId);
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null);
    }
  }, [removeSession, selectedSessionId]);

  const handleSelectSession = useCallback((id: string | null) => {
    setSelectedSessionId(id);
    if (id) setMobileTab("terminal");
  }, []);

  const handleMobileTabSwitch = useCallback((tab: "sessions" | "terminal") => {
    setMobileTab(tab);
    if (tab === "terminal") {
      requestAnimationFrame(() => terminalRef.current?.refit());
    }
  }, []);

  const handleCloneSession = useCallback((session: Session) => {
    setSessionDefaults({
      workingDir: session.workingDir,
      bridgeId: session.bridgeId,
      shellType: session.shellType,
    });
    setShowNewSession(true);
  }, []);

  return (
    <div
      className="h-dvh flex flex-col"
      style={{ background: "var(--bg-void)" }}
    >
      {/* ── Top Chrome ── */}
      <header
        className="shrink-0 flex items-center justify-between px-4"
        style={{
          height: 44,
          borderBottom: "1px solid var(--border-muted)",
          background: "linear-gradient(180deg, var(--bg-surface) 0%, var(--bg-base) 100%)",
        }}
      >
        {/* Left cluster */}
        <div className="flex items-center gap-3">
          {/* Wordmark */}
          <span
            style={{
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: "0.15em",
              color: "var(--accent)",
              textTransform: "uppercase",
              textShadow: "0 0 12px var(--accent-glow)",
              userSelect: "none",
            }}
          >
            ftown
          </span>

          <span style={{ width: 1, height: 16, background: "var(--border-muted)" }} />

          <button
            className="btn-accent"
            onClick={() => setShowNewSession(true)}
            disabled={!hasBridges}
            title={hasBridges ? "Create a new session" : "No bridges online — start a bridge first"}
          >
            + New Session
          </button>

          <button className="btn-ghost hidden md:inline-flex" onClick={refreshSessions}>
            Refresh
          </button>

          <button
            className="btn-ghost hidden md:inline-flex"
            onClick={() => setShowToken(!showToken)}
            style={showToken ? { color: "var(--accent)", borderColor: "var(--accent-dim)" } : {}}
          >
            CLI Token
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
            <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "capitalize" }}>
              {connectionStatus}
            </span>
          </div>

          <span style={{ width: 1, height: 12, background: "var(--border-muted)" }} />

          <span style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {userId}
          </span>

          <button
            onClick={onDisconnect}
            style={{ fontSize: 11, color: "var(--text-faint)", background: "none", border: "none", cursor: "pointer", padding: "2px 4px", fontFamily: "var(--font-mono)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--status-error)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
          >
            disconnect
          </button>
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
              Start your bridge with:
            </span>
            <button
              className="btn-ghost"
              onClick={async () => {
                const text = `npx ftown-bridge --token ${token} --api-url ${window.location.origin}`;
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
            npx ftown-bridge --token {token} --api-url {typeof window !== "undefined" ? window.location.origin : ""}
          </code>
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
          Sessions{sessions.length > 0 ? ` (${sessions.length})` : ""}
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
          className={`shrink-0 flex-col w-full md:w-[260px] ${mobileTab === "sessions" ? "flex" : "hidden"} md:flex`}
          style={{
            borderRight: "1px solid var(--border-subtle)",
            background: "var(--bg-surface)",
            overflow: "hidden",
          }}
        >
          <div
            className="shrink-0 hidden md:flex items-center justify-between px-4"
            style={{
              height: 36,
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--text-muted)",
              }}
            >
              Sessions
            </span>
            <span
              style={{
                fontSize: 10,
                color: "var(--text-faint)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {sessions.length}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto">
            <SessionList
              sessions={sessions}
              selectedSessionId={selectedSessionId}
              onSelectSession={handleSelectSession}
              onRenameSession={renameSession}
              onStopSession={stopSession}
              onRemoveSession={handleRemoveSession}
              onCloneSession={handleCloneSession}
              sessionActivity={sessionActivity}
            />
          </div>
        </aside>

        {/* Terminal area */}
        <main className={`flex-1 flex-col min-h-0 min-w-0 ${mobileTab === "terminal" ? "flex" : "hidden"} md:flex`}>
          <Terminal
            ref={terminalRef}
            client={client}
            sessionId={selectedSessionId}
            userId={userId}
            isRunning={selectedSession?.status === "running"}
            sessionName={selectedSession?.name ?? selectedSession?.prompt?.slice(0, 48) ?? null}
            usage={selectedSessionId ? sessionActivity.get(selectedSessionId)?.usage : undefined}
          />
          {selectedSessionId && (
            <MobileControlBar onSendInput={(data) => terminalRef.current?.sendInput(data)} />
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
    </div>
  );
}
