"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Centrifuge, UnauthorizedError } from "centrifuge";
import { v4 as uuidv4 } from "uuid";
import { HybridTerminalTransport } from "@/lib/direct-transport/hybrid-terminal-transport";
import {
  DirectCommandMessage,
  TerminalTransportApi,
  isSignalMessage,
} from "@/lib/direct-transport/contract";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * Decodes the `exp` (seconds since epoch) claim of a JWT without verifying
 * its signature. Only used to decide whether to withhold an initial connect
 * token we already know the server would reject as expired — the server
 * remains the sole source of truth for validity.
 */
function decodeJwtExpMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);
    const claims = JSON.parse(json) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Clock-skew buffer so a token on the verge of expiry is treated as expired. */
const TOKEN_EXPIRY_SKEW_MS = 5_000;

function isTokenExpired(token: string): boolean {
  const expMs = decodeJwtExpMs(token);
  // Undecodable exp: let the server be the judge, don't preemptively drop it.
  if (expMs === null) return false;
  return expMs <= Date.now() + TOKEN_EXPIRY_SKEW_MS;
}

/**
 * Mints a fresh Centrifugo connect token from the session-gated token route.
 * centrifuge-js calls this whenever it needs a token: on the very first
 * connect if we withheld a stale initial token (see isTokenExpired above),
 * and automatically on server-signaled token expiry (connect error code 109,
 * "token expired") or a scheduled proactive refresh — no manual reconnect
 * wiring needed.
 *
 * A 401 here means the NextAuth session itself is gone (not just the
 * Centrifugo token). Throwing UnauthorizedError makes centrifuge-js fail the
 * connection permanently instead of retrying forever, which the caller turns
 * into a clear re-login prompt (see the "disconnected" handler below).
 */
async function fetchCentrifugoToken(): Promise<string> {
  const response = await fetch("/api/auth/token", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });

  if (response.status === 401) {
    throw new UnauthorizedError("session expired");
  }
  if (!response.ok) {
    throw new Error(`Failed to refresh Centrifugo token (status ${response.status})`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

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

    // A stale initial token would just get rejected by the server (connect
    // error 109) before getToken kicks in on the retry — skip that wasted
    // round trip and let getToken mint a fresh one right away.
    const initialToken = isTokenExpired(token) ? "" : token;

    const client = new Centrifuge(centrifugoUrl, {
      token: initialToken,
      getToken: fetchCentrifugoToken,
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
      // getToken threw UnauthorizedError (401 from /api/auth/token): the
      // NextAuth session itself is gone, not just the Centrifugo token.
      // centrifuge-js stops retrying in this case (reason "unauthorized"),
      // so surface a clear re-login path instead of a silently dead
      // dashboard.
      if (ctx.reason === "unauthorized") {
        setStatus("error");
        setError("Session expired — please sign in again.");
        if (typeof window !== "undefined") {
          window.location.href = "/login";
        }
        return;
      }
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
