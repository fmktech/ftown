"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { MessageClient, MessageSubscription } from "@/lib/message-client";
import { Session } from "@/types";
import { clearsManualInputNotice, hookEventToActivity, extractManualInputNotice, extractToolLabel, type ManualInputNotice } from "@/lib/hook-events";
import { TokenUsage } from "./useSessionEvents";
import type { BridgeRpc } from "./useBridgeRpc";
import type { PersistedSessionAttention, SessionAttentionResponse } from "@/types";
import { v4 as uuidv4 } from "uuid";

function snapshotResponse(value: unknown, sessionId: string): SessionAttentionResponse | null {
  if (!value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  if (response.sessionId !== sessionId || typeof response.sequence !== "number" || !Number.isSafeInteger(response.sequence) || response.sequence < 0) return null;
  if (response.attention === null) return { sessionId, attention: null, sequence: response.sequence };
  if (!response.attention || typeof response.attention !== "object") return null;
  const item = response.attention as Record<string, unknown>;
  if (item.type !== "agent_needs_input" || typeof item.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(item.id)
    || typeof item.sequence !== "number" || !Number.isSafeInteger(item.sequence) || item.sequence < 1
    || typeof item.title !== "string" || typeof item.message !== "string" || typeof item.createdAt !== "string"
    || !Number.isFinite(Date.parse(item.createdAt))) return null;
  if (item.sequence > response.sequence) return null;
  return { sessionId, attention: item as unknown as PersistedSessionAttention, sequence: response.sequence };
}

function restoredNotice(item: PersistedSessionAttention): ManualInputNotice {
  return { type: "agent_needs_input", title: item.title, message: item.message, receivedAt: Date.parse(item.createdAt),
    attentionId: item.id, attentionSequence: item.sequence };
}

export interface SessionActivity {
  activity: "thinking" | "tool_use" | "idle";
  toolName?: string;
  usage?: TokenUsage;
  attention?: ManualInputNotice;
}

interface HookEventMessage {
  type: "hook_event";
  eventName: string;
  data: Record<string, unknown>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface AllSessionEvents {
  sessionActivity: Map<string, SessionActivity>;
  /** Optimistically clear a session's activity (e.g. on a local ESC interrupt). */
  markSessionIdle: (sessionId: string) => void;
  clearSessionAttention: (sessionId: string, expected?: ManualInputNotice) => Promise<void>;
}

export function useAllSessionEvents(
  client: MessageClient | null,
  sessions: Session[],
  userId: string,
  rpc?: Pick<BridgeRpc, "sendCommand" | "onSubscribed">,
): AllSessionEvents {
  const [activityMap, setActivityMap] = useState<Map<string, SessionActivity>>(new Map());
  const subsRef = useRef<Map<string, { client: MessageClient; user: string; sub: MessageSubscription; queued: boolean; inFlight: boolean; dirty: boolean }>>(new Map());
  const clientRef = useRef(client);
  const userIdRef = useRef(userId);
  const rpcRef = useRef(rpc);
  const sessionsRef = useRef(sessions);
  const activityRef = useRef(activityMap);
  const activityOwner = useRef({ client, user: userId });
  const observations = useRef(new Map<string, number>());
  const reads = useRef(new Map<string, number>());
  const dismissedThrough = useRef(new Map<string, number>());
  const canonical = useRef(new Map<string, { sequence: number; activeId: string | null }>());
  clientRef.current = client;
  userIdRef.current = userId;
  rpcRef.current = rpc;
  sessionsRef.current = sessions;
  activityRef.current = activityMap;

  const readSnapshot = useCallback(async (sessionId: string) => {
    const owner = subsRef.current.get(sessionId);
    const user = owner?.user;
    const session = sessionsRef.current.find(row => row.id === sessionId && row.status === "running");
    if (!owner || owner.client !== clientRef.current || owner.user !== userIdRef.current || !session || !rpcRef.current) return;
    const observation = observations.current.get(sessionId) ?? 0;
    const read = (reads.current.get(sessionId) ?? 0) + 1;
    reads.current.set(sessionId, read);
    try {
      const response = await rpcRef.current.sendCommand({ type: "get_session_attention", requestId: uuidv4(),
        payload: { bridgeId: session.bridgeId, sessionId } });
      if (!response.success || userIdRef.current !== user || clientRef.current !== owner.client
        || subsRef.current.get(sessionId) !== owner || reads.current.get(sessionId) !== read
        || (observations.current.get(sessionId) ?? 0) !== observation
        || !sessionsRef.current.some(row => row.id === sessionId && row.bridgeId === session.bridgeId && row.status === "running")) return;
      const snapshot = snapshotResponse(response.data, sessionId);
      if (!snapshot) return;
      const known = canonical.current.get(sessionId);
      if (known && known.sequence > snapshot.sequence) return;
      canonical.current.set(sessionId, { sequence: snapshot.sequence, activeId: snapshot.attention?.id ?? null });
      setActivityMap(prev => {
        if (userIdRef.current !== user || clientRef.current !== owner.client || subsRef.current.get(sessionId) !== owner
          || (observations.current.get(sessionId) ?? 0) !== observation || reads.current.get(sessionId) !== read) return prev;
        const current = prev.get(sessionId) ?? { activity: "idle" as const };
        if (current.attention && (current.attention.type !== "agent_needs_input" || !current.attention.attentionId)) return prev;
        if ((current.attention?.attentionSequence ?? 0) > snapshot.sequence) return prev;
        const attention = snapshot.attention && snapshot.attention.sequence > (dismissedThrough.current.get(sessionId) ?? 0)
          ? restoredNotice(snapshot.attention) : undefined;
        return new Map(prev).set(sessionId, { ...current, attention });
      });
    } catch { /* Older/offline bridges retain the existing live-only dashboard. */ }
  }, []);

  const hydrate = useCallback((sessionId: string) => {
    const owner = subsRef.current.get(sessionId);
    if (!owner || owner.client !== clientRef.current || owner.user !== userIdRef.current) return;
    if (owner.inFlight) {
      // A later trigger requires a new snapshot; fence the old response now.
      reads.current.set(sessionId, (reads.current.get(sessionId) ?? 0) + 1);
      owner.dirty = true;
      return;
    }
    if (owner.queued) return;
    owner.queued = true;
    queueMicrotask(() => {
      if (subsRef.current.get(sessionId) !== owner || owner.client !== clientRef.current || owner.user !== userIdRef.current) return;
      owner.queued = false;
      owner.inFlight = true;
      void readSnapshot(sessionId).finally(() => {
        if (subsRef.current.get(sessionId) !== owner || owner.client !== clientRef.current || owner.user !== userIdRef.current) return;
        owner.inFlight = false;
        if (owner.dirty) {
          owner.dirty = false;
          hydrate(sessionId);
        }
      });
    });
  }, [readSnapshot]);

  const subscribe = useCallback((sessionId: string) => {
    const c = clientRef.current;
    const u = userIdRef.current;
    if (!c || !u) return;
    if (subsRef.current.has(sessionId)) return;

    const channel = `events:${sessionId}#${u}`;

    const onPublication = (ctx: { data: unknown }): void => {
      if (clientRef.current !== c || userIdRef.current !== u || subsRef.current.get(sessionId)?.sub !== sub) return;
      const msg = ctx.data as HookEventMessage;
      if (msg.type !== "hook_event") return;

      const attention = extractManualInputNotice(msg.eventName, msg.data);
      const activity = hookEventToActivity(msg.eventName);
      if ((attention && !attention.attentionId) || msg.eventName === "UserPromptSubmit" || msg.eventName === "beforeSubmitPrompt") {
        observations.current.set(sessionId, (observations.current.get(sessionId) ?? 0) + 1);
      }
      setActivityMap((prev) => {
        if (clientRef.current !== c || userIdRef.current !== u || subsRef.current.get(sessionId)?.sub !== sub) return prev;
        const current = prev.get(sessionId) ?? { activity: "idle" as const };
        // Use the latest queued notice, including a Notification from this React batch.
        // A delayed prompt publication may predate an already restored newer
        // request. Only the committed snapshot can resolve a stamped notice.
        const durablePrompt = (msg.eventName === "UserPromptSubmit" || msg.eventName === "beforeSubmitPrompt")
          && current.attention?.type === "agent_needs_input" && !!current.attention.attentionId;
        const clearsAttention = !durablePrompt && clearsManualInputNotice(msg.eventName, msg.data, current.attention);
        if (!activity && !attention && !clearsAttention) return prev;
        const toolName =
          activity === "tool_use"
            ? extractToolLabel(msg.eventName, msg.data)
            : undefined;

        if (clearsAttention && current.attention?.attentionSequence) dismissedThrough.current.set(sessionId,
          Math.max(dismissedThrough.current.get(sessionId) ?? 0, current.attention.attentionSequence));
        const incomingSequence = attention?.attentionSequence;
        const known = canonical.current.get(sessionId);
        const olderExplicit = incomingSequence !== undefined && (incomingSequence <= (dismissedThrough.current.get(sessionId) ?? 0)
          || (known !== undefined && incomingSequence <= known.sequence && attention?.attentionId !== known.activeId)
          || (current.attention?.type === "agent_needs_input" && incomingSequence < (current.attention.attentionSequence ?? 0)));
        const updated: SessionActivity = {
          ...current,
          ...(activity
            ? {
                activity,
                toolName: activity === "tool_use" ? toolName : undefined,
              }
            : {}),
          ...(attention && !olderExplicit ? { attention } : {}),
          ...(clearsAttention ? { attention: undefined } : {}),
          ...(activity === "idle" && msg.usage
            ? {
                usage: {
                  inputTokens: msg.usage.inputTokens,
                  outputTokens: msg.usage.outputTokens,
                },
              }
            : {}),
        };

        const next = new Map(prev);
        next.set(sessionId, updated);
        return next;
      });
      // Prompt hooks have already resolved the ledger. Learn its watermark
      // even if the first read was pending and no displayed ID was known yet.
      if (msg.eventName === "UserPromptSubmit" || msg.eventName === "beforeSubmitPrompt") void hydrate(sessionId);
    };

    const existing = c.getSubscription(channel);
    if (existing) {
      existing.removeAllListeners();
      existing.unsubscribe();
      c.removeSubscription(existing);
    }

    const sub = c.newSubscription(channel, {
      since: { offset: 0, epoch: "" },
    });

    sub.on("publication", onPublication);
    sub.on("subscribed", () => {
      if (clientRef.current === c && userIdRef.current === u && subsRef.current.get(sessionId)?.sub === sub) void hydrate(sessionId);
    });
    subsRef.current.set(sessionId, { client: c, user: u, sub, queued: false, inFlight: false, dirty: false });
    sub.subscribe();
    if (sub.state === "subscribed") void hydrate(sessionId);
  }, [hydrate]);

  const unsubscribe = useCallback((sessionId: string) => {
    const owned = subsRef.current.get(sessionId);
    if (owned) {
      const { client: owner, sub } = owned;
      sub.removeAllListeners();
      sub.unsubscribe();
      owner.removeSubscription(sub);
    }
    subsRef.current.delete(sessionId);
  }, []);

  // A subscription belongs to the Centrifuge client and user that created it.
  // Drop all old ownership before the session effect binds to a replacement.
  useEffect(() => {
    for (const sessionId of Array.from(subsRef.current.keys())) {
      unsubscribe(sessionId);
    }
    observations.current.clear(); reads.current.clear(); dismissedThrough.current.clear(); canonical.current.clear();
    activityOwner.current = { client, user: userId };
    setActivityMap(new Map());
  }, [client, userId, unsubscribe]);

  useEffect(() => rpc?.onSubscribed(() => {
    if (clientRef.current !== client || userIdRef.current !== userId) return;
    for (const id of subsRef.current.keys()) void hydrate(id);
  }), [rpc?.onSubscribed, client, userId, hydrate]);

  useEffect(() => {
    if (!client || !userId) return;

    const runningIds = new Set(
      sessions.filter((s) => s.status === "running").map((s) => s.id)
    );

    for (const sessionId of subsRef.current.keys()) {
      if (!runningIds.has(sessionId)) {
        unsubscribe(sessionId);
      }
    }

    setActivityMap((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const sessionId of next.keys()) {
        if (!runningIds.has(sessionId)) {
          next.delete(sessionId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    for (const id of runningIds) {
      subscribe(id);
    }
  }, [client, userId, sessions, subscribe, unsubscribe]);

  useEffect(() => {
    return () => {
      for (const sessionId of subsRef.current.keys()) {
        unsubscribe(sessionId);
      }
      setActivityMap(new Map());
    };
  }, [unsubscribe]);

  const markSessionIdle = useCallback((sessionId: string) => {
    setActivityMap((prev) => {
      const current = prev.get(sessionId);
      if (!current || current.activity === "idle") return prev;
      const next = new Map(prev);
      next.set(sessionId, { ...current, activity: "idle", toolName: undefined });
      return next;
    });
  }, []);

  const clearSessionAttention = useCallback(async (sessionId: string, expected?: ManualInputNotice) => {
    const sameNotice = (a: ManualInputNotice | undefined, b: ManualInputNotice | undefined) => {
      if (!a || !b || a.type !== b.type) return false;
      if (a.attentionId || b.attentionId) return !!a.attentionId && a.attentionId === b.attentionId && a.attentionSequence === b.attentionSequence;
      return a.receivedAt === b.receivedAt && a.title === b.title && a.message === b.message;
    };
    const currentNotice = activityRef.current.get(sessionId)?.attention;
    if (expected && !sameNotice(currentNotice, expected)) throw new Error("This message has changed. Review the latest notice.");
    const captured = expected ?? currentNotice;
    if (!captured) return;
    const session = sessionsRef.current.find(row => row.id === sessionId);
    const owner = subsRef.current.get(sessionId);
    const user = userIdRef.current;
    const activeClient = clientRef.current;
    if (activityOwner.current.client !== activeClient || activityOwner.current.user !== user
      || owner && (owner.client !== activeClient || owner.user !== user)) throw new Error("The session changed before dismissal could start.");
    if (captured.type === "agent_needs_input" && captured.attentionId) {
      if (!session || !owner || !rpcRef.current) throw new Error("The session is unavailable. Reconnect and try again.");
      observations.current.set(sessionId, (observations.current.get(sessionId) ?? 0) + 1);
      const observation = observations.current.get(sessionId);
      let response;
      try { response = await rpcRef.current.sendCommand({ type: "resolve_session_attention", requestId: uuidv4(),
        payload: { bridgeId: session.bridgeId, sessionId, eventId: captured.attentionId } }); }
      catch { throw new Error("Could not dismiss this message. Reconnect and try again."); }
      if (!response.success) throw new Error("Could not dismiss this message. Try again.");
      if (userIdRef.current !== user || clientRef.current !== owner.client || subsRef.current.get(sessionId) !== owner
        || !sessionsRef.current.some(row => row.id === sessionId && row.bridgeId === session.bridgeId)) throw new Error("The session changed before dismissal completed.");
      const snapshot = snapshotResponse(response.data, sessionId);
      if (!snapshot) throw new Error("Could not confirm dismissal. Try again.");
      dismissedThrough.current.set(sessionId, Math.max(dismissedThrough.current.get(sessionId) ?? 0, captured.attentionSequence ?? 0));
      if (observations.current.get(sessionId) !== observation) return;
      const known = canonical.current.get(sessionId);
      if (!known || snapshot.sequence >= known.sequence) canonical.current.set(sessionId, { sequence: snapshot.sequence, activeId: snapshot.attention?.id ?? null });
      observations.current.set(sessionId, (observations.current.get(sessionId) ?? 0) + 1);
      setActivityMap(prev => {
        if (userIdRef.current !== user || clientRef.current !== owner.client || subsRef.current.get(sessionId) !== owner) return prev;
        const current = prev.get(sessionId);
        if (!current || !sameNotice(current.attention, captured)) return prev;
        return new Map(prev).set(sessionId, { ...current, attention: snapshot.attention ? restoredNotice(snapshot.attention) : undefined });
      });
      return;
    }
    observations.current.set(sessionId, (observations.current.get(sessionId) ?? 0) + 1);
    setActivityMap(prev => {
      if (userIdRef.current !== user || clientRef.current !== activeClient || activityOwner.current.user !== user || activityOwner.current.client !== activeClient
        || subsRef.current.get(sessionId) !== owner) return prev;
      const current = prev.get(sessionId);
      if (!current || !sameNotice(current.attention, captured)) return prev;
      return new Map(prev).set(sessionId, { ...current, attention: undefined });
    });
  }, []);

  // Status guard at the source: activity is only meaningful for live sessions.
  // A session that completed/errored/stopped keeps its last hook activity in
  // activityMap, but that state is stale — drop it so every consumer reads
  // idle/absent for anything that is not running/pending.
  const sessionActivity = useMemo(() => {
    const liveStatus = new Map(sessions.map((s) => [s.id, s.status]));
    const effective = new Map<string, SessionActivity>();
    for (const [sessionId, activity] of activityMap) {
      const status = liveStatus.get(sessionId);
      if (status === "running" || status === "pending") {
        effective.set(sessionId, activity);
      }
    }
    return effective;
  }, [activityMap, sessions]);

  return { sessionActivity, markSessionIdle, clearSessionAttention };
}
