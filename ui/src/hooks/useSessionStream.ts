"use client";

import { useState, useEffect, useRef } from "react";
import { Centrifuge, Subscription } from "centrifuge";
import { SessionMessage } from "@/types";

interface StreamMessage {
  type: 'stream_message';
  message: SessionMessage;
  timestamp: string;
}

interface UseSessionStreamResult {
  messages: SessionMessage[];
  isStreaming: boolean;
}

export function useSessionStream(
  client: Centrifuge | null,
  sessionId: string | null,
  userId: string | null
): UseSessionStreamResult {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const subRef = useRef<Subscription | null>(null);

  useEffect(() => {
    if (!client || !sessionId || !userId) {
      setMessages([]);
      setIsStreaming(false);
      return;
    }

    const channel = `stream:${sessionId}#${userId}`;

    const existing = client.getSubscription(channel);
    if (existing) {
      existing.removeAllListeners();
      existing.unsubscribe();
      client.removeSubscription(existing);
    }

    const sub = client.newSubscription(channel);

    sub.on("publication", (ctx) => {
      const data = ctx.data as StreamMessage;

      if (data.type === 'stream_message' && data.message) {
        setMessages((prev) => [...prev, data.message]);
        setIsStreaming(true);
      }
    });

    sub.on("subscribed", () => {
      setIsStreaming(true);
    });

    sub.subscribe();
    subRef.current = sub;

    return () => {
      sub.removeAllListeners();
      sub.unsubscribe();
      client.removeSubscription(sub);
      subRef.current = null;
      setMessages([]);
      setIsStreaming(false);
    };
  }, [client, sessionId, userId]);

  return {
    messages,
    isStreaming,
  };
}
