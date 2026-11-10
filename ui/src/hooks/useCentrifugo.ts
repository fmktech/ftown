"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Centrifuge, UnauthorizedError, type Subscription } from "centrifuge";
import { v4 as uuidv4 } from "uuid";
import { accountChannel } from "@security/ledger/channels";
import type { MessageClient } from "@/lib/message-client";
import { SecureMessageClient } from "@/lib/secure-message-client";
import type { SecureEndpointRuntime } from "@/lib/secure-endpoint-runtime";
import { HybridTerminalTransport } from "@/lib/direct-transport/hybrid-terminal-transport";
import { clearConnectionHistory, recordConnectionEvent } from "@/lib/connection-history";
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

/** The ledger client's replication entry points (LedgerClient satisfies it); every refresh it runs is throttled single-flight. */
export interface LedgerFeed {
  /** A full ledger pushed on the relay. */
  offer(candidate: unknown): Promise<void>;
  /** A head announcement: the client ignores lower revisions and refreshes at most at its own pace. Never a direct GET here. */
  noteHead(head: string, revision: number): Promise<void> | void;
  /** Re-read the ledger (throttled by the client). */
  refresh(): Promise<void>;
}

export type LedgerMessage =
  | { type: "ledger"; ledger: unknown }
  | { type: "ledger_head"; head: string; revision: number };

/** Strict shape check for `bridges:ledger` publications (mirrors the bridge's parseLedgerMessage); anything else is ignored. */
export function parseLedgerMessage(data: unknown): LedgerMessage | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.type === "ledger") {
    if (keys.length !== 2 || !keys.includes("ledger") || record.ledger === undefined || record.ledger === null) return null;
    return { type: "ledger", ledger: record.ledger };
  }
  if (record.type === "ledger_head") {
    if (keys.length !== 3 || !keys.includes("head") || !keys.includes("revision")) return null;
    const { head, revision } = record;
    if (typeof head !== "string" || head.length === 0) return null;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return null;
    return { type: "ledger_head", head, revision };
  }
  return null;
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

  recordConnectionEvent("token refresh HTTP", { status: response.status });

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
  client: MessageClient | null;
  /** The exact Centrifuge instance backing `client`; null exactly when `client` is. */
  rawClient: Centrifuge | null;
  status: ConnectionStatus;
  error: string | null;
  /** One HybridTerminalTransport per live connection; null while disconnected. */
  transport: TerminalTransportApi | null;
}

/**
 * Optional per-mode overrides (solo mode). Absent = hosted behavior exactly
 * as before: tokens come from the session-gated /api/auth/token route and a
 * permanent auth failure redirects to /login.
 */
interface UseCentrifugoOptions {
  /** Replaces the default session-gated token mint (solo: POST /api/solo/token). */
  securityRuntime?: SecureEndpointRuntime;
  tokenRefresher?: () => Promise<string>;
  /** Replaces the default "/login" redirect on a permanent auth rejection. */
  onUnauthorized?: () => void;
  /**
   * Account mode only (Solo/local never pass it): the page's ledger client. The connection subscribes to
   * `bridges:ledger#<userId>` and feeds the account's own publications to it; every (re)subscribe and every relay token renewal
   * (hourly) refreshes, so the browser re-reads the ledger even when no push arrives.
   */
  ledger?: LedgerFeed;
}

export function useCentrifugo(
  token: string | null,
  centrifugoUrl: string | null,
  userId: string | null,
  options?: UseCentrifugoOptions
): UseCentrifugoResult {
  // Destructured so the connect effect below depends on stable callback
  // identities, not a fresh options object literal every render.
  const securityRuntime = options?.securityRuntime;
  const tokenRefresher = options?.tokenRefresher;
  const onUnauthorized = options?.onUnauthorized;
  const ledger = options?.ledger;

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [transport, setTransport] = useState<TerminalTransportApi | null>(null);
  const clientRef = useRef<Centrifuge | null>(null);
  const secureClientRef = useRef<SecureMessageClient | null>(null);
  const transportRef = useRef<TerminalTransportApi | null>(null);
  // Stable per-tab id for the lifetime of this hook instance (survives
  // reconnects; a fresh page load gets a fresh id).
  const clientIdRef = useRef<string>("");
  useEffect(() => { clearConnectionHistory(); }, [userId]);
  if (!clientIdRef.current) clientIdRef.current = uuidv4();

  const cleanup = useCallback(() => {
    secureClientRef.current?.dispose();
    secureClientRef.current = null;
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
    if (!token || !centrifugoUrl || !userId || !securityRuntime) {
      cleanup();
      setStatus("disconnected");
      return;
    }

    cleanup();

    // A stale initial token would just get rejected by the server (connect
    // error 109) before getToken kicks in on the retry — skip that wasted
    // round trip and let getToken mint a fresh one right away.
    const initialToken = isTokenExpired(token) ? "" : token;

    const mint = tokenRefresher ?? fetchCentrifugoToken;
    const client = new Centrifuge(centrifugoUrl, {
      token: initialToken,
      getToken: ledger ? async () => {
        const renewed = await mint();
        void ledger.refresh().catch(() => {});
        return renewed;
      } : mint,
    });

    client.on("connecting", (ctx) => {
      recordConnectionEvent("cloud connecting", { code: ctx.code });
      setStatus("connecting");
      setError(null);
    });

    client.on("connected", () => {
      recordConnectionEvent("cloud connected");
      setStatus("connected");
      setError(null);
    });

    client.on("disconnected", (ctx) => {
      recordConnectionEvent("cloud disconnected", { code: ctx.code, unauthorized: ctx.reason === "unauthorized" });
      // getToken threw UnauthorizedError (401 from the token route): the
      // underlying credential itself is gone — NextAuth session (hosted) or
      // solo access key — not just the Centrifugo token. centrifuge-js stops
      // retrying in this case (reason "unauthorized"), so surface a clear
      // re-auth path instead of a silently dead dashboard.
      if (ctx.reason === "unauthorized") {
        setStatus("error");
        setError("Session expired — please sign in again.");
        if (onUnauthorized) {
          onUnauthorized();
          return;
        }
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
      recordConnectionEvent("cloud error", { code: ctx.error.code, type: ctx.type });
      setStatus("error");
      setError(`Connection error: ${ctx.error.message}`);
    });

    clientRef.current = client;
    const secureClient = new SecureMessageClient(client, userId, securityRuntime);
    secureClientRef.current = secureClient;

    // Signaling/watch commands ride the same commands:rpc#{userId} channel
    // useSessions publishes RPCs on; publish directly on the client so no
    // second Subscription object is created for it (useSessions owns that).
    const commandsChannel = accountChannel("commands:rpc", userId);
    const publishCommand = (msg: DirectCommandMessage) => {
      secureClient.publish(commandsChannel, msg).catch(() => {});
    };

    const hybridTransport = new HybridTerminalTransport({
      centrifuge: secureClient,
      securityRuntime,
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
      secureClient.getSubscription(commandsChannel) ?? secureClient.newSubscription(commandsChannel);
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

    // Account mode: the one ledger subscription of this page. Raw (not sealed): a ledger is
    // self-authenticating, the client verifies it from genesis. Only this account's own
    // publications are accepted (Centrifugo stamps the publisher as info.user); anything
    // malformed is dropped. A (re)subscribe may follow missed pushes, so it refreshes.
    let ledgerSub: Subscription | null = null;
    if (ledger) {
      const sub = client.newSubscription(accountChannel("bridges:ledger", userId));
      sub.on("subscribed", () => { void ledger.refresh().catch(() => {}); });
      sub.on("publication", (ctx) => {
        if (ctx.info?.user !== userId) return;
        const message = parseLedgerMessage(ctx.data);
        if (!message) return;
        // A head is only a hint (any connection of the account can publish one): the client throttles the resulting read.
        try {
          void Promise.resolve(message.type === "ledger" ? ledger.offer(message.ledger) : ledger.noteHead(message.head, message.revision)).catch(() => {});
        } catch { /* a failing ledger client never breaks the connection */ }
      });
      sub.subscribe();
      ledgerSub = sub;
    }

    client.connect();

    return () => {
      commandsSub.off("publication", handleInboundSignal);
      if (ledgerSub) {
        ledgerSub.removeAllListeners();
        ledgerSub.unsubscribe();
        client.removeSubscription(ledgerSub);
      }
      cleanup();
    };
  }, [token, centrifugoUrl, userId, cleanup, tokenRefresher, onUnauthorized, securityRuntime, ledger]);

  return {
    client: secureClientRef.current,
    rawClient: secureClientRef.current ? clientRef.current : null,
    status,
    error,
    transport,
  };
}
