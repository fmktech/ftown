"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Centrifuge } from "centrifuge";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface UseCentrifugoResult {
  client: Centrifuge | null;
  status: ConnectionStatus;
  error: string | null;
}

export function useCentrifugo(token: string | null, centrifugoUrl: string | null): UseCentrifugoResult {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<Centrifuge | null>(null);

  const cleanup = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!token || !centrifugoUrl) {
      cleanup();
      setStatus("disconnected");
      return;
    }

    cleanup();

    const client = new Centrifuge(centrifugoUrl, {
      token,
    });

    client.on("connecting", () => {
      setStatus("connecting");
      setError(null);
    });

    client.on("connected", () => {
      setStatus("connected");
      setError(null);
    });

    client.on("disconnected", (ctx) => {
      setStatus("disconnected");
      if (ctx.reason && ctx.reason !== "clean disconnect") {
        setError(`Disconnected: ${ctx.reason}`);
      }
    });

    client.on("error", (ctx) => {
      setStatus("error");
      setError(`Connection error: ${ctx.error.message}`);
    });

    clientRef.current = client;
    client.connect();

    return () => {
      cleanup();
    };
  }, [token, centrifugoUrl, cleanup]);

  return {
    client: clientRef.current,
    status,
    error,
  };
}
