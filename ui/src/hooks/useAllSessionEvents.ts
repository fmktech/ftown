"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Centrifuge, Subscription } from "centrifuge";
import { Session } from "@/types";
import { hookEventToActivity, extractToolLabel } from "@/lib/hook-events";
import { TokenUsage } from "./useSessionEvents";

export interface SessionActivity {
  activity: "thinking" | "tool_use" | "idle";
  toolName?: string;
  usage?: TokenUsage;
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
}

export function useAllSessionEvents(
  client: Centrifuge | null,
  sessions: Session[],
  userId: string
): AllSessionEvents {
  const [activityMap, setActivityMap] = useState<Map<string, SessionActivity>>(new Map());
  const subsRef = useRef<Map<string, Subscription>>(new Map());
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

      const activity = hookEventToActivity(msg.eventName);
      if (!activity) return;

      setActivityMap((prev) => {
        const current = prev.get(sessionId) ?? { activity: "idle" as const };
        const toolName =
          activity === "tool_use"
            ? extractToolLabel(msg.eventName, msg.data)
            : undefined;

        const updated: SessionActivity = {
          ...current,
          activity,
          toolName: activity === "tool_use" ? toolName : undefined,
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
    subsRef.current.set(sessionId, sub);
  }, []);

  const unsubscribe = useCallback((sessionId: string) => {
    const c = clientRef.current;
    const sub = subsRef.current.get(sessionId);
    if (sub) {
      sub.removeAllListeners();
      sub.unsubscribe();
      if (c) c.removeSubscription(sub);
    }
    subsRef.current.delete(sessionId);
  }, []);

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

  return { sessionActivity, markSessionIdle };
}
