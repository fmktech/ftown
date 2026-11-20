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
  HandoffSessionPayload,
  RenameSessionPayload,
  RemoveSessionPayload,
  UpdateSessionParentPayload,
  parseSessionBlock,
} from "@/types";
import type { BridgeRpc } from "@/hooks/useBridgeRpc";
import { accountChannel } from "@security/ledger/channels";
import { buildUsagePollBatches } from "@/lib/live-usage-polling";
import { isPreviewDescriptor } from "@/lib/session-preview";
import { parsePullRequestUrl } from "@/lib/pull-request-url";

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
type StreamPosition = { offset: number; epoch: string };
function streamPosition(value: { offset?: number; epoch?: string } | null | undefined): StreamPosition | null {
  return value && Number.isSafeInteger(value.offset) && value.offset! >= 0 && typeof value.epoch === "string" && value.epoch.length > 0
    ? { offset: value.offset!, epoch: value.epoch } : null;
}

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

function acceptSessionRow(value: unknown): Session | null {
  if (!isSessionRow(value)) return null;
  if (value.block !== undefined) {
    const block = parseSessionBlock(value.block);
    if (block) value.block = block;
    else delete value.block;
  }
  return value;
}

function isSessionRow(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const optionalStrings = ["projectName", "parentBridgeId", "prompt", "model", "workingDir", "shellType", "account", "claudeSessionId", "cursorSessionId", "codexSessionId", "piSessionId", "piSessionFile", "opencodeSessionId", "museSessionId", "grokSessionId", "antigravitySessionId", "command", "parentSessionId", "loopId"];
  return (row.preview === undefined || isPreviewDescriptor(row.preview))
    && optionalStrings.every(key => row[key] === undefined || typeof row[key] === "string")
    && (row.allowedAccounts === undefined || (Array.isArray(row.allowedAccounts) && row.allowedAccounts.every(id => typeof id === "string")))
    && (row.usage === undefined || isSessionUsage(row.usage))
    && (row.runtime === undefined || row.runtime === "tmux" || row.runtime === "direct")
    && typeof row.id === "string" && row.id.length > 0
    && typeof row.bridgeId === "string" && row.bridgeId.length > 0
    && typeof row.name === "string" && typeof row.createdAt === "string"
    && typeof row.updatedAt === "string"
    && typeof row.status === "string"
    && ["pending", "running", "completed", "error", "disconnected"].includes(row.status);
}

// An invalid registration must not leave a previously trusted frame active.
function clearInvalidPreviews(current: Session[], incoming: unknown[]): Session[] {
  const invalid = new Set<string>();
  for (const value of incoming) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (typeof row.id === "string" && typeof row.bridgeId === "string" && row.preview !== undefined && !isPreviewDescriptor(row.preview)) invalid.add(JSON.stringify([row.bridgeId, row.id]));
  }
  if (!invalid.size) return current;
  return current.map(session => {
    if (!session.preview || !invalid.has(JSON.stringify([session.bridgeId, session.id]))) return session;
    const next = { ...session }; delete next.preview; return next;
  });
}

export function mergeSessionSnapshot(current: Session | undefined, incoming: Session): Session {
  let merged = incoming;
  const pullRequest = parsePullRequestUrl(incoming.pullRequestUrl);
  if (pullRequest) {
    if (incoming.pullRequestUrl !== pullRequest.url) merged = { ...incoming, pullRequestUrl: pullRequest.url };
  } else if (Object.hasOwn(incoming, "pullRequestUrl")) {
    merged = { ...incoming };
    delete merged.pullRequestUrl;
  }
  if (!current) return merged;
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
  type: 'session_update'; session: Session; timestamp: string;
}
interface SessionSnapshotRequiredMessage {
  type: 'session_snapshot_required'; bridgeId: string; timestamp: string;
}

export interface CreateSessionOptions {
  name?: string;
  model?: string;
  workingDir?: string;
  bridgeId?: string;
  shellType?: ShellType;
  account?: string;
  allowedAccounts?: string[];
  projectName?: string;
  parentBridgeId?: string;
  parentSessionId?: string;
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  museSessionId?: string;
  grokSessionId?: string;
  antigravitySessionId?: string;
  piSessionId?: string;
  piSessionFile?: string;
  opencodeSessionId?: string;
  env?: Record<string, string>;
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
  createSession: (prompt: string, options?: CreateSessionOptions) => Promise<Session>;
  stopSession: (sessionId: string) => void;
  retrySession: (sessionId: string) => void;
  dismissSessionBlock: (session: Session) => Promise<void>;
  handoffSession: (sessionId: string, options?: { shellType?: string; model?: string; name?: string }) => Promise<Session>;
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
  rpc: BridgeRpc,
  usageViewSessionId: string | null = null,
): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const sessionsSubRef = useRef<MessageSubscription | null>(null);
  const sessionsRef = useRef<Session[]>([]);
  const usageRequestsRef = useRef(new Map<string, { dirty: boolean }>());
  const usageRefreshRef = useRef<() => Promise<void>>(async () => {});
  const usageGenerationRef = useRef(0);
  const confirmedRemovedRef = useRef(new Set<string>());
  const optimisticRef = useRef(new Map<string, { expiry: number; bridgeId?: string }>());
  const observationsRef = useRef(new Map<string, number>());
  const mutationRef = useRef(0);
  const sessionPositionRef = useRef<StreamPosition>({ offset: 0, epoch: "" });
  const sessionNeedsSnapshotRef = useRef(true);
  const readinessRevisionRef = useRef(0);
  const identityRef = useRef({ client, userId });
  if (identityRef.current.client !== client || identityRef.current.userId !== userId) identityRef.current = { client, userId };
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
    const runtime = client?.securityRuntime;
    if (!runtime) return;
    const identity = identityRef.current;
    let active = true;
    readinessRevisionRef.current = 0;
    let ready = new Set(runtime.snapshot().filter(state => state.status === "ready").map(state => state.bridgeId));
    const unsubscribe = runtime.onChange(() => {
      if (!active || identityRef.current !== identity) return;
      const next = new Set(runtime.snapshot().filter(state => state.status === "ready").map(state => state.bridgeId));
      const newlyReady = [...next].some(bridgeId => !ready.has(bridgeId));
      ready = next;
      updateSessions(previous => previous.filter(session => !["revoked", "key_changed"].includes(runtime.state(session.bridgeId).status)));
      if (!newlyReady) return;
      readinessRevisionRef.current += 1;
      if (sessionNeedsSnapshotRef.current && document.visibilityState !== "hidden") {
        sessionNeedsSnapshotRef.current = false;
        requestListRef.current(true);
      }
    });
    return () => { active = false; unsubscribe(); };
  }, [client, userId, updateSessions]);

  useEffect(() => {
    confirmedRemovedRef.current.clear();
    optimisticRef.current.clear();
    observationsRef.current.clear();
    mutationRef.current = 0;
    usageGenerationRef.current += 1;
    usageRequestsRef.current.clear();
    sessionPositionRef.current = { offset: 0, epoch: "" };
    sessionNeedsSnapshotRef.current = true;
    updateSessions(() => []);
    const runtime = client?.securityRuntime;
    if (!userId || !runtime?.identity?.endpoint.id || !runtime.pinnedBridges) return;
    const prefix = JSON.stringify([userId, runtime.identity.endpoint.id]);
    const loaded = new Map<string, string>();
    function restore() {
      if (!runtime) return;
      const pins = runtime.pinnedBridges().filter(pin => pin.permissions.includes("read") && !["revoked", "key_changed"].includes(runtime.state(pin.bridgeId).status));
      const keys = new Map(pins.map(pin => [pin.bridgeId, prefix + ":" + JSON.stringify([pin.bridgeId, pin.endpoint.id])]));
      const rows: Session[] = [];
      try {
        for (const key of Object.keys(localStorage)) {
          if (!key.startsWith(prefix + ":")) continue;
          const [owner] = JSON.parse(key.slice(prefix.length + 1));
          const replacement = keys.get(owner);
          if ((replacement && replacement !== key) || ["revoked", "key_changed"].includes(runtime.state(owner).status)) localStorage.removeItem(key);
        }
        for (const [owner, key] of keys) {
          if (loaded.get(owner) === key) continue;
          const stored = JSON.parse(localStorage.getItem(key) || "[]");
          if (Array.isArray(stored)) rows.push(...stored.filter((row): row is Session => isSessionRow(row) && row.bridgeId === owner).map(row => ({ ...row, lastKnownOnly: true as const })));
        }
      } catch { /* Storage may be unavailable. */ }
      updateSessions(previous => {
        const current = previous.filter(row => keys.has(row.bridgeId) && (!loaded.has(row.bridgeId) || loaded.get(row.bridgeId) === keys.get(row.bridgeId)));
        const ids = new Set(current.map(row => row.id));
        return [...current, ...rows.filter(row => !ids.has(row.id))];
      });
      loaded.clear();
      for (const [owner, key] of keys) loaded.set(owner, key);
    }
    restore();
    return runtime.onChange(restore);
  }, [client, userId, updateSessions]);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    let generation = 0;
    // Keep correlation alive for the same budget the transport allows its replies.
    const commandTimeoutMs = client?.commandTimeoutMs;
    const listReplyWindowMs = typeof commandTimeoutMs === "number" && Number.isFinite(commandTimeoutMs) && commandTimeoutMs > 0
      ? commandTimeoutMs : LIST_REPLY_WINDOW_MS;
    const contextGeneration = usageGenerationRef.current;
    let coalescingTimer: ReturnType<typeof setTimeout> | undefined;
    let rpcReadyObserved = false;
    let sessionsSubscribedOnce = false;
    const requests = new Map<string, { generation: number; contextGeneration: number; cutoff: number; expiry: number; applied: Set<string>; position: StreamPosition | null; failed: boolean; readinessRevision: number }>();
    const appliedByBridge = new Map<string, number>();
    const snapshotPositions = new Map<string, StreamPosition>();
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
        && [...requests.values()].some(r => r.generation === generation && r.applied.size === 0 && !r.failed)) return;
      const requestId = uuidv4();
      requests.set(requestId, { generation: ++generation, contextGeneration, cutoff: mutationRef.current,
        expiry: Date.now() + listReplyWindowMs, applied: new Set(), failed: false, readinessRevision: readinessRevisionRef.current,
        position: sessionsSubRef.current?.streamPosition?.() ?? streamPosition(sessionPositionRef.current) });
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

    function rememberOwner(bridgeId: string, next: Session[]) {
      const runtime = client?.securityRuntime;
      if (!runtime?.identity?.endpoint.id) return;
      const pin = runtime.bridge(bridgeId);
      if (pin?.permissions?.includes("read") && runtime?.identity?.endpoint.id && !["revoked", "key_changed"].includes(runtime.state(bridgeId).status)) {
        const summaries = next.filter(row => row.bridgeId === bridgeId).map(({ id, name, bridgeId, status, projectName, parentSessionId, parentBridgeId, createdAt, updatedAt }) =>
          ({ id, name, bridgeId, status, projectName, parentSessionId, parentBridgeId, createdAt, updatedAt }));
        try { localStorage.setItem(JSON.stringify([userId, runtime.identity.endpoint.id]) + ":" + JSON.stringify([bridgeId, pin.endpoint.id]), JSON.stringify(summaries)); } catch {}
      }
    }
    const unregisterResponse = onResponse((response: CommandResponse) => {
      if (!active) return;
      pruneRequests();
      // Broadcast remove replies cannot confirm ownership. A failure can
      // safely release optimism and reconcile; sticky confirmation still wins.
      if (!response.success) {
        const request = requests.get(response.requestId);
        if (request && request.generation === generation && !request.failed) {
          request.failed = true;
          sessionNeedsSnapshotRef.current = true;
          // A ready event can precede this asynchronous publish rejection.
          // Consume it once; a new request captures the current revision, so a
          // persistent denial cannot create a retry loop.
          if (request.readinessRevision < readinessRevisionRef.current && document.visibilityState !== "hidden") {
            sessionNeedsSnapshotRef.current = false;
            requestList(true);
          }
        }
        rollback(response.requestId); return;
      }
      if (!response.data || typeof response.data !== "object") return;
      const data = response.data as { sessions?: unknown; bridgeId?: unknown };
      if (!Array.isArray(data.sessions)) return;
      const snapshotRows = data.sessions;
      const rows = snapshotRows.map(acceptSessionRow).filter((row): row is Session => row !== null);
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
        if (request.position) snapshotPositions.set(bridgeId, request.position);
      }
      const cutoff = request?.cutoff;
      const newer = (id: string) => cutoff !== undefined && (observationsRef.current.get(id) ?? 0) > cutoff;
      updateSessions(prev => {
        const merged = new Map(clearInvalidPreviews(prev, snapshotRows.filter(value => {
          if (!value || typeof value !== "object") return false;
          const id = (value as Record<string, unknown>).id;
          return typeof id === "string" && !newer(id);
        })).map(s => [s.id, s]));
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
        const next = [...merged.values()];
        if (authoritative) {
          rememberOwner(bridgeId, next);
        }
        return next;
      });
    });
    // The first command-ready signal may follow security enrollment. Later
    // command resubscriptions defer to positioned sessions recovery.
    const unregisterSubscribed = onSubscribed(() => {
      const firstReady = !rpcReadyObserved;
      rpcReadyObserved = true;
      if (active && document.visibilityState !== "hidden" && (firstReady || sessionNeedsSnapshotRef.current)) {
        sessionNeedsSnapshotRef.current = false;
        requestList(true);
      }
    });
    let sessionsSub: MessageSubscription | null = null;
    if (client) {
      const channel = accountChannel("sessions:updates", userId);
      const existing = client.getSubscription(channel);
      if (existing) { existing.removeAllListeners(); existing.unsubscribe(); client.removeSubscription(existing); }
      const since = streamPosition(sessionPositionRef.current);
      sessionsSub = client.newSubscription(channel, { ...(since ? { since } : {}), recoverable: true, positioned: true });
      sessionsSub.on("publication", ctx => {
        if (!active) return;
        const nextPosition = streamPosition({ offset: ctx.offset, epoch: ctx.epoch ?? sessionPositionRef.current.epoch });
        const previousPosition = streamPosition(sessionPositionRef.current);
        if (nextPosition && (!previousPosition || nextPosition.epoch !== previousPosition.epoch || nextPosition.offset > previousPosition.offset)) sessionPositionRef.current = nextPosition;
        const data = ctx.data as SessionUpdateMessage | SessionSnapshotRequiredMessage;
        if (data?.type === "session_snapshot_required") {
          if (typeof data.bridgeId !== "string" || !data.bridgeId || typeof data.timestamp !== "string") return;
          sessionNeedsSnapshotRef.current = true;
          if (document.visibilityState !== "hidden") {
            sessionNeedsSnapshotRef.current = false;
            requestList(true);
          }
          return;
        }
        if (data?.type !== "session_update" || !data.session || typeof data.session.id !== "string") return;
        const authoritative = snapshotPositions.get(data.session.bridgeId);
        if (nextPosition && authoritative && nextPosition.epoch === authoritative.epoch && nextPosition.offset <= authoritative.offset) return;
        if ((data.session.status as string) === "removed") {
          confirm(data.session.id);
          updateSessions(prev => prev.filter(s => s.id !== data.session.id));
        } else if (!acceptSessionRow(data.session)) {
          updateSessions(prev => clearInvalidPreviews(prev, [data.session]));
        } else if (!blocked(data.session.id)) {
          const accepted = data.session;
          observe(accepted.id);
          updateSessions(prev => {
            const current = prev.find(s => s.id === accepted.id);
            const incoming = mergeSessionSnapshot(current, accepted);
            return current ? prev.map(s => s.id === incoming.id ? incoming : s) : [incoming, ...prev];
          });
        }
        rememberOwner(data.session.bridgeId, sessionsRef.current);
      });
      sessionsSub.on("subscribed", context => {
        if (!active) return;
        const initialSubscribe = !sessionsSubscribedOnce;
        sessionsSubscribedOnce = true;
        const nextPosition = streamPosition(context);
        const previousPosition = streamPosition(sessionPositionRef.current);
        const recovered = context?.recovered === true && context.positioned !== false && !!nextPosition && !!previousPosition
          && nextPosition.epoch === previousPosition.epoch && nextPosition.offset >= previousPosition.offset;
        sessionPositionRef.current = nextPosition ?? { offset: 0, epoch: "" };
        if (document.visibilityState === "hidden") {
          sessionNeedsSnapshotRef.current = true;
        } else if (sessionNeedsSnapshotRef.current || !recovered) {
          sessionNeedsSnapshotRef.current = false;
          requestList(initialSubscribe);
        }
      });
      sessionsSubRef.current = sessionsSub;
      sessionsSub.subscribe();
    }
    const visible = () => {
      if (document.visibilityState !== "visible") { sessionNeedsSnapshotRef.current = true; return; }
      requestList(false);
      sessionNeedsSnapshotRef.current = false;
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      usageGenerationRef.current += 1;
      unregisterResponse(); unregisterSubscribed();
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

  const refreshLiveUsage = useCallback(async () => {
    if (!userId || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    const selected = sessionsRef.current.filter(session => session.id === usageViewSessionId && session.status === "running");
    const batches = buildUsagePollBatches(selected);
    await Promise.all(batches.map(async (batch) => {
      const requestKey = `${batch.bridgeId}:${batch.sessionIds.join("|")}`;
      const pending = usageRequestsRef.current.get(requestKey);
      if (pending) { pending.dirty = true; return; }
      const entry = { dirty: false };
      usageRequestsRef.current.set(requestKey, entry);
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
          if (batch.sessionIds.includes(current.id) && current.status === "running" && current.bridgeId === batch.bridgeId && isSessionUsage(usage)) {
            observationsRef.current.set(current.id, ++mutationRef.current);
            return mergeSessionSnapshot(current, { ...current, usage });
          }
          return current;
        }));
      } catch {
        // Usage is best-effort; entry, visibility and session updates can retry.
      } finally {
        if (usageRequestsRef.current.get(requestKey) === entry) {
          usageRequestsRef.current.delete(requestKey);
          if (entry.dirty && requestGeneration === usageGenerationRef.current) void Promise.resolve().then(() => usageRefreshRef.current());
        }
      }
    }));
  }, [userId, sendCommand, updateSessions, usageViewSessionId]);
  usageRefreshRef.current = refreshLiveUsage;

  const usageTarget = sessions.find(session => session.id === usageViewSessionId);
  // Usage replies only change `usage`: they must never schedule another read.
  const usageUpdateKey = usageTarget ? JSON.stringify([usageTarget.id, usageTarget.bridgeId, usageTarget.status, usageTarget.updatedAt,
    usageTarget.shellType, usageTarget.workingDir, usageTarget.codexSessionId, usageTarget.claudeSessionId, usageTarget.museSessionId]) : "";
  useEffect(() => {
    if (!userId || usageViewSessionId === null) return;
    if (usageTarget?.status !== "running") return;
    let active = true;
    void Promise.resolve().then(() => { if (active) void refreshLiveUsage(); });
    return () => { active = false; };
  }, [userId, refreshLiveUsage, usageViewSessionId, usageUpdateKey, usageTarget?.status]);

  useEffect(() => {
    if (!userId) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible" && usageViewSessionId !== null) void refreshLiveUsage();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [userId, refreshLiveUsage, usageViewSessionId]);

  const createSession = useCallback(
    (prompt: string, options?: CreateSessionOptions): Promise<Session> => {
      if (!userId) {
        return Promise.reject(new Error("Not connected"));
      }

      const shellType = options?.shellType ?? "claude";
      const payload: CreateSessionPayload = {
        prompt,
        name: options?.name,
        model: options?.model,
        workingDir: options?.workingDir,
        bridgeId: options?.bridgeId,
        shellType,
        ...(options?.account !== undefined ? { account: options.account } : {}),
        ...(options?.allowedAccounts !== undefined ? { allowedAccounts: options.allowedAccounts } : {}),
        projectName: options?.projectName,
        parentBridgeId: options?.parentBridgeId,
        ...(options?.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
        claudeSessionId: options?.claudeSessionId,
        cursorSessionId: options?.cursorSessionId,
        codexSessionId: options?.codexSessionId,
        museSessionId: options?.museSessionId,
        grokSessionId: options?.grokSessionId,
        antigravitySessionId: options?.antigravitySessionId,
        piSessionId: options?.piSessionId,
        piSessionFile: options?.piSessionFile,
        opencodeSessionId: options?.opencodeSessionId,
        env: options?.env,
        ...(options?.createMissingWorkingDir ? { createMissingWorkingDir: true } : {}),
      };

      const command: Command = {
        type: "create_session",
        payload,
        requestId: uuidv4(),
      };

      const requestGeneration = usageGenerationRef.current;
      const requestCutoff = mutationRef.current;
      // sendCommand rejects with "create_session timed out" after 30s.
      return sendCommand(command).then((resp) => {
        if (!resp.success) {
          throw new CreateSessionBridgeError(resp.error ?? "create_session failed", resp.data);
        }
        if (requestGeneration !== usageGenerationRef.current) {
          throw new Error("Session creation context changed; refresh before retrying.");
        }
        const created = acceptSessionRow((resp.data as { session?: unknown } | undefined)?.session);
        if (!created || (options?.bridgeId && created.bridgeId !== options.bridgeId)) {
          throw new Error("Bridge returned an invalid created session; refresh before retrying.");
        }
        if (confirmedRemovedRef.current.has(created.id)
          || (optimisticRef.current.get(created.id)?.expiry ?? 0) > Date.now()) {
          throw new Error("Created session is no longer available.");
        }
        let reconciled = created;
        updateSessions(prev => {
          const current = prev.find(row => row.id === created.id);
          // A publication received while create was in flight is newer evidence.
          reconciled = current && (observationsRef.current.get(created.id) ?? 0) > requestCutoff
            ? current : mergeSessionSnapshot(current, created);
          return current ? prev.map(row => row.id === created.id ? reconciled : row) : [reconciled, ...prev];
        });
        observationsRef.current.set(created.id, ++mutationRef.current);
        return reconciled;
      });
    },
    [userId, sendCommand, updateSessions]
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

  const handoffSession = useCallback(
    (sessionId: string, options?: { shellType?: string; model?: string; name?: string }): Promise<Session> => {
      if (!userId) return Promise.reject(new Error("Not connected"));
      const payload: HandoffSessionPayload = { sessionId };
      if (options?.shellType) payload.shellType = options.shellType as ShellType;
      if (options?.model) payload.model = options.model;
      if (options?.name) payload.name = options.name;
      const command: Command = { type: "handoff_session", payload, requestId: uuidv4() };
      return sendCommand(command).then((resp) => {
        if (!resp.success) throw new Error(resp.error ?? "handoff_session failed");
        const created = acceptSessionRow((resp.data as { session?: unknown } | undefined)?.session);
        if (!created) throw new Error("Bridge returned an invalid session");
        updateSessions(prev => {
          const current = prev.find(row => row.id === created.id);
          const reconciled = mergeSessionSnapshot(current, created);
          return current ? prev.map(row => row.id === created.id ? reconciled : row) : [reconciled, ...prev];
        });
        return created;
      });
    },
    [userId, sendCommand, updateSessions],
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

  const dismissSessionBlock = useCallback(async (session: Session) => {
    if (!session.block) return;
    const response = await sendCommand({ type: 'dismiss_session_block', requestId: uuidv4(), payload: {
      sessionId: session.id, bridgeId: session.bridgeId,
      transitionKey: session.block.transitionKey, detectedAt: session.block.detectedAt,
    } });
    if (!response.success) throw new Error(response.error ?? 'Could not dismiss session block');
    const updated = acceptSessionRow((response.data as { session?: unknown } | undefined)?.session);
    if (updated) updateSessions(prev => prev.map(row => {
      if (row.id !== updated.id || row.block?.transitionKey !== session.block?.transitionKey || row.block?.detectedAt !== session.block?.detectedAt) return row;
      return mergeSessionSnapshot(row, updated);
    }));
  }, [sendCommand, updateSessions]);

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

      const payload: UpdateSessionParentPayload = { sessionId, parentSessionId, parentBridgeId: sessionsRef.current.find(s => s.id === parentSessionId)?.bridgeId };
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
    dismissSessionBlock,
    handoffSession,
    renameSession,
    setSessionParent,
    removeSession,
    refreshSessions,
  };
}
