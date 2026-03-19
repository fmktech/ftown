"use client";

import { useEffect, useRef, useCallback } from "react";
import { Centrifuge, Subscription } from "centrifuge";

interface UseTerminalResult {
  subscribe: () => void;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
}

export function useTerminal(
  client: Centrifuge | null,
  sessionId: string | null,
  userId: string | null,
  onData: (data: string) => void
): UseTerminalResult {
  const outputSubRef = useRef<Subscription | null>(null);
  const inputSubRef = useRef<Subscription | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  const cleanup = useCallback(() => {
    if (outputSubRef.current && client) {
      outputSubRef.current.removeAllListeners();
      outputSubRef.current.unsubscribe();
      client.removeSubscription(outputSubRef.current);
      outputSubRef.current = null;
    }
    if (inputSubRef.current && client) {
      inputSubRef.current.removeAllListeners();
      inputSubRef.current.unsubscribe();
      client.removeSubscription(inputSubRef.current);
      inputSubRef.current = null;
    }
  }, [client]);

  const subscribe = useCallback(() => {
    if (!client || !sessionId || !userId) return;

    cleanup();

    const outputChannel = `terminal:${sessionId}#${userId}`;
    const existingOut = client.getSubscription(outputChannel);
    if (existingOut) {
      existingOut.removeAllListeners();
      existingOut.unsubscribe();
      client.removeSubscription(existingOut);
    }

    const outputSub = client.newSubscription(outputChannel);
    outputSub.on("publication", (ctx) => {
      const msg = ctx.data as { type: string; data?: string };
      if (msg.type === "output" && msg.data) {
        onDataRef.current(msg.data);
      }
    });
    outputSub.subscribe();
    outputSubRef.current = outputSub;

    const inputChannel = `terminal-input:${sessionId}#${userId}`;
    const existingIn = client.getSubscription(inputChannel);
    if (existingIn) {
      existingIn.removeAllListeners();
      existingIn.unsubscribe();
      client.removeSubscription(existingIn);
    }

    const inputSub = client.newSubscription(inputChannel);
    inputSub.subscribe();
    inputSubRef.current = inputSub;
  }, [client, sessionId, userId, cleanup]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const sendInput = useCallback(
    (data: string) => {
      if (!inputSubRef.current) return;
      inputSubRef.current.publish({ type: "input", data });
    },
    []
  );

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      if (!inputSubRef.current) return;
      inputSubRef.current.publish({ type: "resize", cols, rows });
    },
    []
  );

  return { subscribe, sendInput, sendResize };
}
