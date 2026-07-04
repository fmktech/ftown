"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Centrifuge } from "centrifuge";
import { v4 as uuidv4 } from "uuid";
import { HybridTerminalTransport } from "@/lib/direct-transport/hybrid-terminal-transport";
import {
  DirectCommandMessage,
  TerminalTransportApi,
  isSignalMessage,
} from "@/lib/direct-transport/contract";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface UseCentrifugoResult {
  client: Centrifuge | null;
  status: ConnectionStatus;
  error: string | null;
  /** One HybridTerminalTransport per live connection; null while disconnected. */
  transport: TerminalTransportApi | null;
}

export function useCentrifugo(
  token: string | null,
  centrifugoUrl: string | null,
  userId: string | null
): UseCentrifugoResult {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [transport, setTransport] = useState<TerminalTransportApi | null>(null);
  const clientRef = useRef<Centrifuge | null>(null);
  const transportRef = useRef<TerminalTransportApi | null>(null);
  // Stable per-tab id for the lifetime of this hook instance (survives
  // reconnects; a fresh page load gets a fresh id).
  const clientIdRef = useRef<string>("");
  if (!clientIdRef.current) clientIdRef.current = uuidv4();

  const cleanup = useCallback(() => {
    if (transportRef.current) {
      transportRef.current.dispose();
      transportRef.current = null;
      setTransport(null);
    }
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!token || !centrifugoUrl || !userId) {
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

    // Signaling/watch commands ride the same commands:rpc#{userId} channel
    // useSessions publishes RPCs on; publish directly on the client so no
    // second Subscription object is created for it (useSessions owns that).
    const commandsChannel = `commands:rpc#${userId}`;
    const publishCommand = (msg: DirectCommandMessage) => {
      client.publish(commandsChannel, msg).catch(() => {});
    };

    const hybridTransport = new HybridTerminalTransport({
      centrifuge: client,
      userId,
      clientId: clientIdRef.current,
      publishCommand,
    });
    transportRef.current = hybridTransport;
    setTransport(hybridTransport);

    // Inbound signaling (webrtc_answer/webrtc_ice/webrtc_close) arrives as
    // publications on this same commands:rpc#{userId} channel. useSessions
    // owns the Subscription object for it (Centrifuge allows only one per
    // channel per client) — get-or-create here so this listener is attached
    // regardless of which hook's effect runs first, and useSessions is made
    // tolerant of a pre-existing Subscription on this channel (see
    // useSessions.ts). Only remove this specific listener on cleanup; never
    // unsubscribe/removeSubscription, since useSessions may still need it.
    const commandsSub =
      client.getSubscription(commandsChannel) ?? client.newSubscription(commandsChannel);
    const handleInboundSignal = (ctx: { data: unknown }) => {
      try {
        const data = ctx.data as { type?: string };
        if (isSignalMessage(data)) {
          hybridTransport.handleSignal(data);
        }
      } catch {
        // Malformed publication must not break the sessions command flow.
      }
    };
    commandsSub.on("publication", handleInboundSignal);

    client.connect();

    return () => {
      commandsSub.off("publication", handleInboundSignal);
      cleanup();
    };
  }, [token, centrifugoUrl, userId, cleanup]);

  return {
    client: clientRef.current,
    status,
    error,
    transport,
  };
}
