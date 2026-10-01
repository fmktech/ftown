"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { MessageClient, MessageSubscription } from "@/lib/message-client";
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
import { buildCodexCommand, buildCursorAgentCommand, buildGrokCommand, buildKimiCodeCommand, buildMuseCommand, buildPiCommand } from "@/lib/agent-commands";
import { buildUsagePollBatches } from "@/lib/live-usage-polling";

// Re-exported for existing consumers (NewSessionModal, session pickers); the
// type now lives with the transport that produces it.
export type { BridgeExecResponse } from "@/hooks/useBridgeRpc";

// How long an optimistically-removed session id stays "tombstoned": a late
// status update or an in-flight list_sessions snapshot for that id is ignored
// for this window so a just-deleted row cannot reappear before the bridge's
// authoritative 'removed' broadcast arrives.
const REMOVED_TOMBSTONE_MS = 12_000;
const LIST_REPLY_WINDOW_MS = 30_000;
const MAX_LIST_REQUESTS = 64;
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

export function mergeSessionSnapshot(current: Session | undefined, incoming: Session): Session {
  if (!current) return incoming;
  let merged = incoming;
  if (
    current.usage
    && (!incoming.usage || incoming.usage.collectedAt <= current.usage.collectedAt)
  ) {
    merged = { ...merged, usage: current.usage };
  }
  if (!incoming.bridgeId && current.bridgeId) {
    merged = { ...merged, bridgeId: current.bridgeId };
  }
  return merged;
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
  museSessionId?: string;
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
  client: MessageClient | null,
  userId: string | null,
  rpc: BridgeRpc
): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const sessionsSubRef = useRef<MessageSubscription | null>(null);
  const sessionsRef = useRef<Session[]>([]);
  const usageRequestsRef = useRef<Set<string>>(new Set());
  const usageGenerationRef = useRef(0);
  const confirmedRemovedRef = useRef(new Set<string>());
  const optimisticRef = useRef(new Map<string, { expiry: number; bridgeId?: string }>());
  const observationsRef = useRef(new Map<string, number>());
  const mutationRef = useRef(0);
  const requestListRef = useRef<(coalesce?: boolean) => void>(() => {});
  const removeRef = useRef<(id: string, optimistic: boolean, command: Command) => void>(() => {});
  const { publishCommand, sendCommand, onResponse, onSubscribed } = rpc;

  // Update the synchronous view before React schedules a render. Request
  // cutoffs and tombstones must reflect all callbacks delivered in one batch.
  const updateSessions = useCallback((update: (prev: Session[]) => Session[]) => {
    const next = update(sessionsRef.current);
    sessionsRef.current = next;
    setSessions(next);
  }, []);

  useEffect(() => {
    confirmedRemovedRef.current.clear();
    optimisticRef.current.clear();
    observationsRef.current.clear();
    mutationRef.current = 0;
    usageGenerationRef.current += 1;
    usageRequestsRef.current.clear();
    updateSessions(() => []);
  }, [userId, updateSessions]);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    let generation = 0;
    const contextGeneration = usageGenerationRef.current;
    let coalescingTimer: ReturnType<typeof setTimeout> | undefined;
    const requests = new Map<string, { generation: number; contextGeneration: number; cutoff: number; expiry: number; applied: Set<string> }>();
    const appliedByBridge = new Map<string, number>();
    const removals = new Map<string, { id: string; timer: ReturnType<typeof setTimeout> }>();
    const pruneRequests = () => {
      for (const [id, request] of requests) {
        if (request.expiry <= Date.now()) requests.delete(id);
      }
    };
    const requestList = (coalesce = false) => {
      if (!active) return;
      pruneRequests();
      // Recovery callbacks delivered in the same turn share an unanswered
      // broadcast. Manual refresh and rollback always issue a new cutoff.
      if (coalesce && coalescingTimer !== undefined
        && [...requests.values()].some(r => r.generation === generation && r.applied.size === 0)) return;
      const requestId = uuidv4();
      requests.set(requestId, { generation: ++generation, contextGeneration, cutoff: mutationRef.current,
        expiry: Date.now() + LIST_REPLY_WINDOW_MS, applied: new Set() });
      while (requests.size > MAX_LIST_REQUESTS) requests.delete(requests.keys().next().value!);
      clearTimeout(coalescingTimer);
      coalescingTimer = setTimeout(() => { coalescingTimer = undefined; }, 0);
      // Registration precedes publish, including synchronous subscribe/replies.
      publishCommand({ type: "list_sessions", payload: {}, requestId });
    };
    requestListRef.current = requestList;
    const blocked = (id: string) => confirmedRemovedRef.current.has(id)
      || (optimisticRef.current.get(id)?.expiry ?? 0) > Date.now();
    const confirm = (id: string) => {
      confirmedRemovedRef.current.add(id);
      optimisticRef.current.delete(id);
      observationsRef.current.delete(id);
    };
    const observe = (id: string) => observationsRef.current.set(id, ++mutationRef.current);
    const isRow = (value: unknown): value is Session => {
      if (!value || typeof value !== "object") return false;
      const row = value as Record<string, unknown>;
      const optionalStrings = ["prompt", "model", "workingDir", "shellType", "claudeSessionId", "cursorSessionId", "codexSessionId", "piSessionId", "piSessionFile", "opencodeSessionId", "museSessionId", "command", "parentSessionId", "loopId"];
      return optionalStrings.every(key => row[key] === undefined || typeof row[key] === "string")
        && (row.usage === undefined || isSessionUsage(row.usage))
        && (row.runtime === undefined || row.runtime === "tmux" || row.runtime === "direct")
        && typeof row.id === "string" && row.id.length > 0
        && typeof row.bridgeId === "string" && row.bridgeId.length > 0
        && typeof row.name === "string" && typeof row.createdAt === "string"
        && typeof row.updatedAt === "string"
        && typeof row.status === "string"
        && ["pending", "running", "completed", "error", "disconnected"].includes(row.status);
    };
    const rollback = (requestId: string) => {
      const removal = removals.get(requestId);
      if (!removal) return;
      clearTimeout(removal.timer);
      removals.delete(requestId);
      // Another remove of the same ID may have superseded this request.
      if (![...removals.values()].some(r => r.id === removal.id)) optimisticRef.current.delete(removal.id);
      requestList();
    };
    removeRef.current = (id, optimistic, command) => {
      if (!active) return;
      if (optimistic && !confirmedRemovedRef.current.has(id)) {
        const bridgeId = sessionsRef.current.find(s => s.id === id)?.bridgeId
          ?? optimisticRef.current.get(id)?.bridgeId;
        optimisticRef.current.set(id, { expiry: Date.now() + REMOVED_TOMBSTONE_MS, bridgeId });
        updateSessions(prev => prev.filter(s => s.id !== id));
        const timer = setTimeout(() => { if (active) rollback(command.requestId); }, REMOVED_TOMBSTONE_MS);
        removals.set(command.requestId, { id, timer });
      }
      try { publishCommand(command); } catch { rollback(command.requestId); }
    };

    const unregisterResponse = onResponse((response: CommandResponse) => {
      if (!active) return;
      pruneRequests();
      // Broadcast remove replies cannot confirm ownership. A failure can
      // safely release optimism and reconcile; sticky confirmation still wins.
      if (!response.success) { rollback(response.requestId); return; }
      if (!response.data || typeof response.data !== "object") return;
      const data = response.data as { sessions?: unknown; bridgeId?: unknown };
      if (!Array.isArray(data.sessions)) return;
      const rows = data.sessions.filter(isRow);
      const candidate = requests.get(response.requestId);
      const request = candidate?.contextGeneration === usageGenerationRef.current ? candidate : undefined;
      const bridgeId = typeof data.bridgeId === "string" && data.bridgeId.length > 0 ? data.bridgeId : (request ? client?.sessionSnapshotBridgeId : undefined);
      // Owner-tagged full lists need an active cutoff; expired/evicted/unknown
      // requests must not fall through to a merge over newer observations.
      if (bridgeId && !request) return;
      const authoritative = request && bridgeId && rows.length === data.sessions.length
        && rows.every(s => s.bridgeId === bridgeId);
      if (authoritative) {
        if (request.applied.has(bridgeId) || (appliedByBridge.get(bridgeId) ?? 0) > request.generation) return;
        request.applied.add(bridgeId);
        appliedByBridge.set(bridgeId, request.generation);
      }
      const cutoff = request?.cutoff;
      const newer = (id: string) => cutoff !== undefined && (observationsRef.current.get(id) ?? 0) > cutoff;
      updateSessions(prev => {
        const merged = new Map(prev.map(s => [s.id, s]));
        if (authoritative) {
          const present = new Set(rows.map(s => s.id));
          for (const current of prev) {
            if (current.bridgeId === bridgeId && !present.has(current.id) && !newer(current.id)) {
              confirm(current.id); merged.delete(current.id);
            }
          }
          // Optimistically hidden rows also need durable confirmation when
          // this complete owner snapshot proves their absence.
          for (const [id, optimistic] of optimisticRef.current) {
            if (optimistic.bridgeId === bridgeId && !present.has(id) && !newer(id)) confirm(id);
          }
        }
        for (const row of rows) {
          if (blocked(row.id) || newer(row.id)) continue;
          merged.set(row.id, mergeSessionSnapshot(merged.get(row.id), row));
          observe(row.id);
        }
        return [...merged.values()];
      });
    });
    const unregisterSubscribed = onSubscribed(() => requestList(true));
    let sessionsSub: MessageSubscription | null = null;
    if (client) {
      const channel = `sessions:updates#${userId}`;
      const existing = client.getSubscription(channel);
      if (existing) { existing.removeAllListeners(); existing.unsubscribe(); client.removeSubscription(existing); }
      sessionsSub = client.newSubscription(channel);
      sessionsSub.on("publication", ctx => {
        if (!active) return;
        const data = ctx.data as SessionUpdateMessage;
        if (data?.type !== "session_update" || !data.session || typeof data.session.id !== "string") return;
        if ((data.session.status as string) === "removed") {
          confirm(data.session.id);
          updateSessions(prev => prev.filter(s => s.id !== data.session.id));
        } else if (isRow(data.session) && !blocked(data.session.id)) {
          observe(data.session.id);
          updateSessions(prev => {
            const current = prev.find(s => s.id === data.session.id);
            const incoming = mergeSessionSnapshot(current, data.session);
            return current ? prev.map(s => s.id === incoming.id ? incoming : s) : [incoming, ...prev];
          });
        }
      });
      sessionsSub.on("subscribed", () => { if (active) requestList(true); });
      sessionsSubRef.current = sessionsSub;
      sessionsSub.subscribe();
    }
    const periodic = window.setInterval(() => {
      pruneRequests();
      if (document.visibilityState !== "hidden") requestList(true);
    }, LIVE_USAGE_POLL_MS);
    const visible = () => { if (document.visibilityState === "visible") requestList(true); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      usageGenerationRef.current += 1;
      unregisterResponse(); unregisterSubscribed();
      window.clearInterval(periodic);
      clearTimeout(coalescingTimer);
      document.removeEventListener("visibilitychange", visible);
      for (const removal of removals.values()) clearTimeout(removal.timer);
      removals.clear(); requests.clear();
      requestListRef.current = () => {};
      removeRef.current = () => {};
      if (sessionsSub) { sessionsSub.removeAllListeners(); sessionsSub.unsubscribe(); client!.removeSubscription(sessionsSub); }
      sessionsSubRef.current = null;
    };
  }, [client, userId, onResponse, onSubscribed, publishCommand, updateSessions]);

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
        updateSessions((prev) => prev.map((current) => {
          const usage = usageBySession[current.id];
          if (current.status === "running" && current.bridgeId === batch.bridgeId && isSessionUsage(usage)) {
            observationsRef.current.set(current.id, ++mutationRef.current);
            return mergeSessionSnapshot(current, { ...current, usage });
          }
          return current;
        }));
      } catch {
        // Live usage is best-effort; the next interval retries without
        // disrupting terminal input or session status updates.
      } finally {
        usageRequestsRef.current.delete(requestKey);
      }
    }));
  }, [userId, sendCommand, updateSessions]);

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
      } else if (shellType === "muse") {
        cmd = buildMuseCommand({
          workingDir: options?.workingDir,
          model: options?.model,
          museSessionId: options?.museSessionId,
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
        museSessionId: options?.museSessionId,
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
      const payload: RemoveSessionPayload = { sessionId, onlyIfFinished };
      removeRef.current(sessionId, !onlyIfFinished && ownerOnline, {
        type: "remove_session", payload, requestId: uuidv4(),
      });
    }, [userId]
  );

  const refreshSessions = useCallback(() => {
    if (userId) requestListRef.current();
  }, [userId]);

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
