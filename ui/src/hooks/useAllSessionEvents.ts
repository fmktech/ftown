"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Centrifuge, Subscription } from "centrifuge";
import { Session } from "@/types";
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

export function useAllSessionEvents(
  client: Centrifuge | null,
  sessions: Session[],
  userId: string
): Map<string, SessionActivity> {
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

      setActivityMap((prev) => {
        const current = prev.get(sessionId) ?? { activity: "idle" as const };
        let updated: SessionActivity;

        switch (msg.eventName) {
          case "UserPromptSubmit":
            updated = { ...current, activity: "thinking", toolName: undefined };
            break;
          case "PreToolUse":
            updated = {
              ...current,
              activity: "tool_use",
              toolName: msg.data.tool_name as string | undefined,
            };
            break;
          case "PostToolUse":
            updated = { ...current, activity: "thinking", toolName: undefined };
            break;
          case "Stop":
            updated = {
              ...current,
              activity: "idle",
              toolName: undefined,
              ...(msg.usage
                ? { usage: { inputTokens: msg.usage.inputTokens, outputTokens: msg.usage.outputTokens } }
                : {}),
            };
            break;
          default:
            return prev;
        }

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

    // Unsubscribe from sessions no longer running
    for (const sessionId of subsRef.current.keys()) {
      if (!runningIds.has(sessionId)) {
        unsubscribe(sessionId);
      }
    }

    // Subscribe to new running sessions
    for (const id of runningIds) {
      subscribe(id);
    }
  }, [client, userId, sessions, subscribe, unsubscribe]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const sessionId of subsRef.current.keys()) {
        unsubscribe(sessionId);
      }
      setActivityMap(new Map());
    };
  }, [unsubscribe]);

  return activityMap;
}
