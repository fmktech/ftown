"use client";

import { useState, useEffect, useRef } from "react";
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

  useEffect(() => {
    if (!client || !userId) {
      setActivityMap(new Map());
      return;
    }

    const runningSessions = sessions.filter((s) => s.status === "running");
    const runningIds = new Set(runningSessions.map((s) => s.id));
    const currentSubs = subsRef.current;

    for (const [sessionId, sub] of currentSubs) {
      if (!runningIds.has(sessionId)) {
        sub.removeAllListeners();
        sub.unsubscribe();
        client.removeSubscription(sub);
        currentSubs.delete(sessionId);
        setActivityMap((prev) => {
          const next = new Map(prev);
          next.delete(sessionId);
          return next;
        });
      }
    }

    for (const session of runningSessions) {
      if (currentSubs.has(session.id)) continue;

      const channel = `events:${session.id}#${userId}`;

      const existing = client.getSubscription(channel);
      if (existing) {
        existing.removeAllListeners();
        existing.unsubscribe();
        client.removeSubscription(existing);
      }

      const sub = client.newSubscription(channel, {
        since: { offset: 0, epoch: "" },
      });

      sub.on("publication", (ctx) => {
        const msg = ctx.data as HookEventMessage;
        if (msg.type !== "hook_event") return;

        const sessionId = session.id;

        setActivityMap((prev) => {
          const current = prev.get(sessionId) ?? { activity: "idle" as const };
          let updated: SessionActivity;

          switch (msg.eventName) {
            case "PreToolUse":
              updated = {
                ...current,
                activity: "tool_use",
                toolName: msg.data.tool_name as string | undefined,
              };
              break;
            case "PostToolUse":
              updated = {
                ...current,
                activity: "thinking",
                toolName: undefined,
              };
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
      });

      sub.subscribe();
      currentSubs.set(session.id, sub);
    }

    return () => {
      for (const [, sub] of currentSubs) {
        sub.removeAllListeners();
        sub.unsubscribe();
        client.removeSubscription(sub);
      }
      currentSubs.clear();
      setActivityMap(new Map());
    };
  }, [client, sessions, userId]);

  return activityMap;
}
