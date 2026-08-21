"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Centrifuge, Subscription } from "centrifuge";
import { v4 as uuidv4 } from "uuid";
import {
  Session,
  SessionUsage,
  ShellType,
  Command,
  CommandResponse,
  CreateSessionPayload,
  RenameSessionPayload,
  RemoveSessionPayload,
  UpdateSessionParentPayload,
} from "@/types";
import type { BridgeRpc } from "@/hooks/useBridgeRpc";
import { buildCodexCommand, buildCursorAgentCommand, buildGrokCommand, buildKimiCodeCommand, buildPiCommand } from "@/lib/agent-commands";
import { buildUsagePollBatches } from "@/lib/live-usage-polling";

// Re-exported for existing consumers (NewSessionModal, session pickers); the
// type now lives with the transport that produces it.
export type { BridgeExecResponse } from "@/hooks/useBridgeRpc";

// How long an optimistically-removed session id stays "tombstoned": a late
// status update or an in-flight list_sessions snapshot for that id is ignored
// for this window so a just-deleted row cannot reappear before the bridge's
// authoritative 'removed' broadcast arrives.
const REMOVED_TOMBSTONE_MS = 12_000;
const LIVE_USAGE_POLL_MS = 15_000;
const LIVE_USAGE_COALESCE_MS = 1_000;

function isSessionUsage(value: unknown): value is SessionUsage {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Record<string, unknown>;
  return typeof usage.inputTokens === "number"
    && typeof usage.outputTokens === "number"
    && typeof usage.cacheReadTokens === "number"
    && typeof usage.cacheWriteTokens === "number"
    && typeof usage.totalTokens === "number"
    && Array.isArray(usage.models)
    && usage.models.every((model) => typeof model === "string")
    && typeof usage.harness === "string"
    && typeof usage.collectedAt === "string";
}

function mergeSessionSnapshot(current: Session | undefined, incoming: Session): Session {
  if (
    current?.status === "running"
    && incoming.status === "running"
    && current.usage
    && (!incoming.usage || incoming.usage.collectedAt <= current.usage.collectedAt)
  ) {
    return { ...incoming, usage: current.usage };
  }
  return incoming;
}

interface SessionUpdateMessage {
  type: 'session_update';
  session: Session;
  timestamp: string;
}

export interface CreateSessionOptions {
  name?: string;
  model?: string;
  workingDir?: string;
  bridgeId?: string;
  shellType?: ShellType;
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  env?: Record<string, string>;
  orchestrator?: boolean;
  createMissingWorkingDir?: boolean;
}

export class CreateSessionBridgeError extends Error {
  readonly code?: string;
  readonly workingDir?: string;
  readonly canCreate?: boolean;

  constructor(message: string, data?: unknown) {
    super(message);
    this.name = "CreateSessionBridgeError";
    const payload = data as { code?: unknown; workingDir?: unknown; canCreate?: unknown } | undefined;
    this.code = typeof payload?.code === "string" ? payload.code : undefined;
    this.workingDir = typeof payload?.workingDir === "string" ? payload.workingDir : undefined;
    this.canCreate = payload?.canCreate === true;
  }
}

interface UseSessionsResult {
  sessions: Session[];
  createSession: (prompt: string, options?: CreateSessionOptions) => Promise<void>;
  stopSession: (sessionId: string) => void;
  retrySession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  setSessionParent: (sessionId: string, parentSessionId: string | null) => void;
  removeSession: (sessionId: string, onlyIfFinished?: boolean, ownerOnline?: boolean) => void;
  refreshSessions: () => void;
}

/**
 * Session domain state: owns the `sessions:updates#{userId}` subscription and
 * the session CRUD commands. All RPC (create/stop/rename/remove/list) goes
 * through the injected BridgeRpc transport (from useBridgeRpc), which owns the
 * shared `commands:rpc#{userId}` channel — this hook never subscribes to it.
 */
export function useSessions(
  client: Centrifuge | null,
  userId: string | null,
  rpc: BridgeRpc
): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const sessionsSubRef = useRef<Subscription | null>(null);
  const sessionsRef = useRef<Session[]>([]);
  const usageRequestsRef = useRef<Set<string>>(new Set());
  const usageGenerationRef = useRef(0);
  sessionsRef.current = sessions;
  // sessionId -> tombstone expiry (ms). Set on optimistic delete; consulted by
  // the publication/merge handlers to keep a removed row from resurrecting.
  const recentlyRemovedRef = useRef<Map<string, number>>(new Map());

  const { publishCommand, sendCommand, onResponse, onSubscribed } = rpc;

  // A session the user just deleted is removed optimistically. While its
  // tombstone is live, ignore any late update or stale snapshot that names it
  // so the row does not flicker back in before the bridge confirms removal.
  const isRecentlyRemoved = useCallback((id: string): boolean => {
    const expiry = recentlyRemovedRef.current.get(id);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      recentlyRemovedRef.current.delete(id);
      return false;
    }
    return true;
  }, []);

  useEffect(() => {
    if (!client || !userId) return;

    const sessionsChannel = `sessions:updates#${userId}`;

    // sessionsChannel is exclusively owned by this hook: always start clean.
    const existingSessionsSub = client.getSubscription(sessionsChannel);
    if (existingSessionsSub) {
      existingSessionsSub.removeAllListeners();
      existingSessionsSub.unsubscribe();
      client.removeSubscription(existingSessionsSub);
    }

    const sessionsSub = client.newSubscription(sessionsChannel);

    sessionsSub.on("publication", (ctx) => {
      const data = ctx.data as SessionUpdateMessage;

      if (data.type === 'session_update' && data.session) {
        if ((data.session.status as string) === 'removed') {
          setSessions((prev) => prev.filter((s) => s.id !== data.session.id));
        } else if (!isRecentlyRemoved(data.session.id)) {
          setSessions((prev) => {
            const idx = prev.findIndex((s) => s.id === data.session.id);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = mergeSessionSnapshot(prev[idx], data.session);
              return updated;
            }
            return [data.session, ...prev];
          });
        }
      }
    });

    sessionsSub.subscribe();
    sessionsSubRef.current = sessionsSub;

    return () => {
      // Exclusively owned: full teardown.
      sessionsSub.removeAllListeners();
      sessionsSub.unsubscribe();
      client.removeSubscription(sessionsSub);
      sessionsSubRef.current = null;
    };
  }, [client, userId, isRecentlyRemoved]);

  useEffect(() => {
    if (!userId) return;

    // Any successful command response carrying a sessions array (list_sessions
    // snapshots in particular) is merged into state.
    const unregisterResponse = onResponse((response: CommandResponse) => {
      if (!response.success || !response.data) return;
      const responseData = response.data as { sessions?: Session[] };
      if (Array.isArray(responseData.sessions)) {
        setSessions((prev) => {
          const merged = new Map(prev.map((s) => [s.id, s]));
          for (const s of responseData.sessions!) {
            if (isRecentlyRemoved(s.id)) continue;
            merged.set(s.id, mergeSessionSnapshot(merged.get(s.id), s));
          }
          return Array.from(merged.values());
        });
      }
    });

    // Re-request the session list on every (re)subscribe — not just the first —
    // so the UI recovers its list after a Centrifugo reconnect instead of
    // showing a stale/empty list until a page reload. (onSubscribed also fires
    // immediately when the shared channel is already live at registration.)
    const unregisterSubscribed = onSubscribed(() => {
      publishCommand({
        type: "list_sessions",
        payload: {},
        requestId: uuidv4(),
      });
    });

    return () => {
      unregisterResponse();
      unregisterSubscribed();
    };
  }, [userId, onResponse, onSubscribed, publishCommand, isRecentlyRemoved]);

  useEffect(() => {
    usageGenerationRef.current += 1;
  }, [client, userId]);

  const pollLiveUsage = useCallback(async () => {
    if (!userId || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    const batches = buildUsagePollBatches(sessionsRef.current);
    await Promise.all(batches.map(async (batch) => {
      const requestKey = `${batch.bridgeId}:${batch.sessionIds.join("|")}`;
      if (usageRequestsRef.current.has(requestKey)) return;
      usageRequestsRef.current.add(requestKey);
      const requestGeneration = usageGenerationRef.current;
      try {
        const response = await sendCommand({
          type: "get_sessions_usage",
          payload: { sessionIds: batch.sessionIds, bridgeId: batch.bridgeId },
          requestId: uuidv4(),
        });
        if (!response.success) return;
        const usages = (response.data as { usages?: unknown } | undefined)?.usages;
        if (typeof usages !== "object" || usages === null || requestGeneration !== usageGenerationRef.current) return;
        const usageBySession = usages as Record<string, unknown>;
        setSessions((prev) => prev.map((current) => {
          const usage = usageBySession[current.id];
          return current.status === "running"
            && current.bridgeId === batch.bridgeId
            && isSessionUsage(usage)
            ? { ...current, usage }
            : current;
        }));
      } catch {
        // Live usage is best-effort; the next interval retries without
        // disrupting terminal input or session status updates.
      } finally {
        usageRequestsRef.current.delete(requestKey);
      }
    }));
  }, [userId, sendCommand]);

  const usagePollKey = JSON.stringify(buildUsagePollBatches(sessions));

  useEffect(() => {
    if (!userId || usagePollKey === "[]") return;
    const timeout = window.setTimeout(() => void pollLiveUsage(), LIVE_USAGE_COALESCE_MS);
    return () => window.clearTimeout(timeout);
  }, [userId, usagePollKey, pollLiveUsage]);

  useEffect(() => {
    if (!userId) return;
    const interval = window.setInterval(() => void pollLiveUsage(), LIVE_USAGE_POLL_MS);
    return () => window.clearInterval(interval);
  }, [userId, pollLiveUsage]);

  useEffect(() => {
    if (!userId) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void pollLiveUsage();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [userId, pollLiveUsage]);

  const createSession = useCallback(
    (prompt: string, options?: CreateSessionOptions): Promise<void> => {
      if (!userId) {
        return Promise.reject(new Error("Not connected"));
      }

      const shellType = options?.shellType ?? "claude";
      let cmd: string;
      if (shellType === "shell") {
        cmd = "/bin/zsh -l";
      } else if (shellType === "opencode") {
        // Empty command: the bridge rebuilds from the harness registry, which
        // passes the prompt as a --prompt CLI arg instead of typing it into
        // the TUI after a delay.
        cmd = "";
      } else if (shellType === "cursor") {
        cmd = buildCursorAgentCommand({
          workingDir: options?.workingDir,
          model: options?.model,
          cursorSessionId: options?.cursorSessionId,
        });
      } else if (shellType === "codex") {
        cmd = buildCodexCommand({
          model: options?.model,
          codexSessionId: options?.codexSessionId,
        });
      } else if (shellType === "grok") {
        cmd = buildGrokCommand({
          model: options?.model,
        });
      } else if (shellType === "pi") {
        cmd = buildPiCommand({
          model: options?.model,
        });
      } else if (shellType === "kimi-code") {
        cmd = buildKimiCodeCommand({
          model: options?.model,
        });
      } else if (options?.claudeSessionId) {
        cmd = `claude --allow-dangerously-skip-permissions --resume ${options.claudeSessionId}`;
      } else {
        cmd = "claude --allow-dangerously-skip-permissions";
      }

      const payload: CreateSessionPayload = {
        command: cmd,
        prompt,
        name: options?.name,
        model: options?.model,
        workingDir: options?.workingDir,
        bridgeId: options?.bridgeId,
        shellType,
        claudeSessionId: options?.claudeSessionId,
        cursorSessionId: options?.cursorSessionId,
        codexSessionId: options?.codexSessionId,
        env: options?.env,
        ...(options?.orchestrator && shellType !== "shell" ? { orchestrator: true } : {}),
        ...(options?.createMissingWorkingDir ? { createMissingWorkingDir: true } : {}),
        ...(prompt && shellType !== "opencode" ? { initialInput: prompt + "\r", initialInputDelay: 2000 } : {}),
      };

      const command: Command = {
        type: "create_session",
        payload,
        requestId: uuidv4(),
      };

      // sendCommand rejects with "create_session timed out" after 30s.
      return sendCommand(command).then((resp) => {
        if (!resp.success) {
          throw new CreateSessionBridgeError(resp.error ?? "create_session failed", resp.data);
        }
      });
    },
    [userId, sendCommand]
  );

  const stopSession = useCallback(
    (sessionId: string) => {
      if (!userId) return;

      const command: Command = {
        type: "stop_session",
        payload: { sessionId },
        requestId: uuidv4(),
      };

      publishCommand(command);
    },
    [userId, publishCommand]
  );

  const retrySession = useCallback(
    (sessionId: string) => {
      if (!userId) return;

      const command: Command = {
        type: "retry_session",
        payload: { sessionId },
        requestId: uuidv4(),
      };

      publishCommand(command);
    },
    [userId, publishCommand]
  );

  const renameSession = useCallback(
    (sessionId: string, name: string) => {
      if (!userId) return;

      const payload: RenameSessionPayload = { sessionId, name };
      const command: Command = {
        type: "rename_session",
        payload,
        requestId: uuidv4(),
      };

      publishCommand(command);
    },
    [userId, publishCommand]
  );

  const setSessionParent = useCallback(
    (sessionId: string, parentSessionId: string | null) => {
      if (!userId) return;

      const payload: UpdateSessionParentPayload = { sessionId, parentSessionId };
      const command: Command = {
        type: "update_session_parent",
        payload,
        requestId: uuidv4(),
      };

      publishCommand(command);
    },
    [userId, publishCommand]
  );

  const removeSession = useCallback(
    (sessionId: string, onlyIfFinished?: boolean, ownerOnline: boolean = true) => {
      if (!userId) return;

      // Explicit deletes are optimistic: when the owning bridge is online,
      // removeFtownSession always removes an existing session, so the outcome is
      // decided the moment the user acts. Drop the row now instead of waiting for
      // the 'removed' broadcast to round-trip (which can be slow or dropped,
      // leaving the row until a manual refresh). A tombstone makes the removal
      // sticky so a late status update or in-flight list snapshot cannot
      // resurrect it.
      //
      // Two cases are deliberately NOT optimistic, to avoid faking a delete that
      // never happens: (a) onlyIfFinished bulk-clear, where the bridge may decline
      // a finished session retried back to running; (b) ownerOnline === false,
      // where the command is dropped (the commands channel has no history) and the
      // session genuinely still exists — the row must truthfully stay until the
      // bridge reconnects and processes the removal.
      if (!onlyIfFinished && ownerOnline) {
        const now = Date.now();
        for (const [id, exp] of recentlyRemovedRef.current) {
          if (exp <= now) recentlyRemovedRef.current.delete(id);
        }
        recentlyRemovedRef.current.set(sessionId, now + REMOVED_TOMBSTONE_MS);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      }

      const payload: RemoveSessionPayload = { sessionId, onlyIfFinished };
      const command: Command = {
        type: "remove_session",
        payload,
        requestId: uuidv4(),
      };

      publishCommand(command);
    },
    [userId, publishCommand]
  );

  const refreshSessions = useCallback(() => {
    if (!userId) return;

    const command: Command = {
      type: "list_sessions",
      payload: {},
      requestId: uuidv4(),
    };

    publishCommand(command);
  }, [userId, publishCommand]);

  return {
    sessions,
    createSession,
    stopSession,
    retrySession,
    renameSession,
    setSessionParent,
    removeSession,
    refreshSessions,
  };
}
