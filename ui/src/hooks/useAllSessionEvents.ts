"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Centrifuge, Subscription } from "centrifuge";
import { Session } from "@/types";
import { clearsManualInputNotice, hookEventToActivity, extractManualInputNotice, extractToolLabel, type ManualInputNotice } from "@/lib/hook-events";
import { TokenUsage } from "./useSessionEvents";

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
  clearSessionAttention: (sessionId: string) => void;
}

export function useAllSessionEvents(
  client: Centrifuge | null,
  sessions: Session[],
  userId: string
): AllSessionEvents {
  const [activityMap, setActivityMap] = useState<Map<string, SessionActivity>>(new Map());
  const subsRef = useRef<Map<string, { client: Centrifuge; sub: Subscription }>>(new Map());
  const clientRef = useRef(client);
  const userIdRef = useRef(userId);
  clientRef.current = client;
  userIdRef.current = userId;

  const subscribe = useCallback((sessionId: string) => {
    const c = clientRef.current;
    const u = userIdRef.current;
    if (!c || !u) return;
    if (subsRef.current.has(sessionId)) return;

    const channel = `events:${sessionId}#${u}`;

    const onPublication = (ctx: { data: unknown }): void => {
      const msg = ctx.data as HookEventMessage;
      if (msg.type !== "hook_event") return;

      const attention = extractManualInputNotice(msg.eventName, msg.data);
      const clearsAttention = clearsManualInputNotice(msg.eventName, msg.data);
      const activity = hookEventToActivity(msg.eventName);
      if (!activity && !attention && !clearsAttention) return;

      setActivityMap((prev) => {
        const current = prev.get(sessionId) ?? { activity: "idle" as const };
        const toolName =
          activity === "tool_use"
            ? extractToolLabel(msg.eventName, msg.data)
            : undefined;

        const updated: SessionActivity = {
          ...current,
          ...(activity
            ? {
                activity,
                toolName: activity === "tool_use" ? toolName : undefined,
              }
            : {}),
          ...(attention ? { attention } : {}),
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

    sub.subscribe();
    subsRef.current.set(sessionId, { client: c, sub });
  }, []);

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
  }, [client, userId, unsubscribe]);

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

  const clearSessionAttention = useCallback((sessionId: string) => {
    setActivityMap((prev) => {
      const current = prev.get(sessionId);
      if (!current?.attention) return prev;
      const next = new Map(prev);
      next.set(sessionId, { ...current, attention: undefined });
      return next;
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
