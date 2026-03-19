"use client";

import { useState, useEffect, useRef } from "react";
import { Centrifuge, Subscription } from "centrifuge";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
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

interface UseSessionEventsResult {
  usage: TokenUsage;
  activity: "thinking" | "tool_use" | "idle";
}

export function useSessionEvents(
  client: Centrifuge | null,
  sessionId: string | null,
  userId: string | null
): UseSessionEventsResult {
  const [usage, setUsage] = useState<TokenUsage>({ inputTokens: 0, outputTokens: 0 });
  const [activity, setActivity] = useState<"thinking" | "tool_use" | "idle">("idle");
  const subRef = useRef<Subscription | null>(null);

  useEffect(() => {
    if (!client || !sessionId || !userId) {
      setUsage({ inputTokens: 0, outputTokens: 0 });
      setActivity("idle");
      return;
    }

    const channel = `events:${sessionId}#${userId}`;

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

      if (msg.usage) {
        setUsage({
          inputTokens: msg.usage.inputTokens,
          outputTokens: msg.usage.outputTokens,
        });
      }

      switch (msg.eventName) {
        case "Stop":
          setActivity("idle");
          break;
        case "PreToolUse":
          setActivity("tool_use");
          break;
        case "PostToolUse":
          setActivity("thinking");
          break;
        case "Notification":
          break;
      }
    });

    sub.subscribe();
    subRef.current = sub;

    return () => {
      sub.removeAllListeners();
      sub.unsubscribe();
      client.removeSubscription(sub);
      subRef.current = null;
      setUsage({ inputTokens: 0, outputTokens: 0 });
      setActivity("idle");
    };
  }, [client, sessionId, userId]);

  return { usage, activity };
}
