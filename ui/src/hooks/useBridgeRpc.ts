"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import { Command, CommandResponse, BridgeExecPayload } from "@/types";

/** How long a request/response RPC waits before rejecting. */
const RPC_TIMEOUT_MS = 30_000;

/** Matches centrifuge's SubscriptionState.Subscribed without importing centrifuge. */
const SUBSCRIBED_STATE = "subscribed";

export interface BridgeExecResponse {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}

interface CommandResponseMessage {
  type: "command_response";
  response: CommandResponse;
  timestamp: string;
}

/**
 * Minimal structural view of a centrifuge Subscription — only what this hook
 * uses (mirrors the CentrifugoClientLike pattern in
 * lib/direct-transport/hybrid-terminal-transport.ts so tests can supply a mock
 * instead of a real Centrifuge client).
 */
export interface BridgeRpcSubscriptionLike {
  state: string;
  subscribe(): void;
  publish(data: unknown): Promise<unknown>;
  on(event: "publication", listener: (ctx: { data: unknown; info?: { user?: string } }) => void): unknown;
  on(event: "subscribed", listener: () => void): unknown;
  off(event: "publication", listener: (ctx: { data: unknown; info?: { user?: string } }) => void): unknown;
  off(event: "subscribed", listener: () => void): unknown;
}

/** Minimal structural view of the Centrifuge client — only what this hook uses. */
export interface CentrifugoClientLike {
  newSubscription(channel: string): BridgeRpcSubscriptionLike;
  getSubscription(channel: string): BridgeRpcSubscriptionLike | null;
}

/**
 * Pure request/response correlation core behind useBridgeRpc, factored out of
 * the hook so the timeout/collect semantics are unit-testable without React.
 *
 * - `sendCommand` resolves with the FIRST response matching the requestId
 *   (success or failure alike) and rejects with "<type> timed out" after 30s.
 * - `sendCommandCollect` is the broadcast variant: it accumulates EVERY
 *   response for the requestId until `windowMs` closes (default 1500ms), so a
 *   fan-out command with no bridgeId (e.g. list_loops) merges replies from all
 *   connected bridges instead of only the first responder.
 * - `bridgeExec` is the shell-exec convenience wrapper with its own
 *   requestId, resolving the response data on success.
 */
export interface RpcCore {
  handleResponse(response: CommandResponse): void;
  sendCommand(command: Command): Promise<CommandResponse>;
  sendCommandCollect(command: Command, windowMs?: number): Promise<CommandResponse[]>;
  bridgeExec(command: string, workingDir: string, bridgeId: string): Promise<BridgeExecResponse>;
}

export function createRpcCore(publish: (command: Command) => void): RpcCore {
  // First-response callbacks: resolve once, then self-delete.
  const pendingCallbacks = new Map<string, (response: CommandResponse) => void>();
  // Broadcast-collect callbacks: unlike pendingCallbacks (which resolves on
  // the FIRST response and deletes itself), these accumulate EVERY response
  // for a requestId until a time window closes — so a broadcast command can
  // merge replies from every connected bridge instead of silently dropping
  // all but the fastest.
  const collectingCallbacks = new Map<string, (response: CommandResponse) => void>();

  const handleResponse = (response: CommandResponse): void => {
    const cb = pendingCallbacks.get(response.requestId);
    if (cb) {
      pendingCallbacks.delete(response.requestId);
      cb(response);
    }

    // Broadcast collectors accumulate every bridge's reply (not deleted here;
    // the collect window clears them on timeout).
    const collector = collectingCallbacks.get(response.requestId);
    if (collector) collector(response);
  };

  const sendCommand = (command: Command): Promise<CommandResponse> => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingCallbacks.delete(command.requestId);
        reject(new Error(`${command.type} timed out`));
      }, RPC_TIMEOUT_MS);

      pendingCallbacks.set(command.requestId, (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      });

      publish(command);
    });
  };

  const sendCommandCollect = (command: Command, windowMs = 1500): Promise<CommandResponse[]> => {
    return new Promise((resolve) => {
      const responses: CommandResponse[] = [];
      collectingCallbacks.set(command.requestId, (resp) => {
        responses.push(resp);
      });
      // Fixed window rather than resolve-on-first: a broadcast has an unknown
      // number of responders, so we collect until the window closes.
      setTimeout(() => {
        collectingCallbacks.delete(command.requestId);
        resolve(responses);
      }, windowMs);

      publish(command);
    });
  };

  const bridgeExec = (
    command: string,
    workingDir: string,
    bridgeId: string
  ): Promise<BridgeExecResponse> => {
    return new Promise((resolve, reject) => {
      const requestId = uuidv4();
      const timeout = setTimeout(() => {
        pendingCallbacks.delete(requestId);
        reject(new Error("bridge_exec timed out"));
      }, RPC_TIMEOUT_MS);

      pendingCallbacks.set(requestId, (resp) => {
        clearTimeout(timeout);
        if (resp.success) {
          resolve(resp.data as BridgeExecResponse);
        } else {
          reject(new Error(resp.error ?? "bridge_exec failed"));
        }
      });

      const payload: BridgeExecPayload = { command, workingDir, bridgeId };
      publish({ type: "bridge_exec", payload, requestId });
    });
  };

  return { handleResponse, sendCommand, sendCommandCollect, bridgeExec };
}

export interface BridgeRpc {
  /** Fire-and-forget publish on the commands channel (no-op when not connected). */
  publishCommand: (command: Command) => void;
  /** Request/response RPC: first matching response wins; 30s timeout. */
  sendCommand: (command: Command) => Promise<CommandResponse>;
  /** Broadcast RPC: collects every response within windowMs (default 1500ms). */
  sendCommandCollect: (command: Command, windowMs?: number) => Promise<CommandResponse[]>;
  /** Run a shell command on a specific bridge. */
  bridgeExec: (command: string, workingDir: string, bridgeId: string) => Promise<BridgeExecResponse>;
  /**
   * Observe EVERY command_response arriving on the channel (including replies
   * to fire-and-forget publishes). Returns an unregister function.
   */
  onResponse: (listener: (response: CommandResponse) => void) => () => void;
  /**
   * Run a listener on every (re)subscribe of the commands channel — and
   * immediately, if the channel is already subscribed when registering (e.g.
   * StrictMode remount reusing useCentrifugo's subscription, where the
   * 'subscribed' event won't re-fire). Returns an unregister function.
   */
  onSubscribed: (listener: () => void) => () => void;
  lastResponse: CommandResponse | null;
}

/**
 * Owns the shared `commands:rpc#{userId}` channel: requestId correlation,
 * the 30s timeout pattern, and broadcast-collect — the bridge-RPC transport
 * that sessions, loops, and factory consume as peers. Exactly one instance
 * should exist per Dashboard; other hooks receive the returned object instead
 * of opening a second subscription to the same channel (centrifuge-js throws
 * on a duplicate newSubscription(channel) call).
 */
export function useBridgeRpc(client: CentrifugoClientLike | null, userId: string | null): BridgeRpc {
  const [lastResponse, setLastResponse] = useState<CommandResponse | null>(null);
  const commandsSubRef = useRef<BridgeRpcSubscriptionLike | null>(null);
  const responseListenersRef = useRef<Set<(response: CommandResponse) => void>>(new Set());
  const subscribedListenersRef = useRef<Set<() => void>>(new Set());
  const coreRef = useRef<RpcCore | null>(null);
  if (coreRef.current === null) {
    coreRef.current = createRpcCore((command) => {
      commandsSubRef.current?.publish(command);
    });
  }
  const core = coreRef.current;

  useEffect(() => {
    if (!client || !userId) return;

    const commandsChannel = `commands:rpc#${userId}`;

    // commandsChannel is shared: useCentrifugo may already have created (and
    // attached an inbound-signal listener to) this Subscription before this
    // effect runs. Reuse it instead of tearing it down, so that listener
    // survives — Centrifuge only allows one Subscription object per channel.
    const commandsSub =
      client.getSubscription(commandsChannel) ?? client.newSubscription(commandsChannel);

    // Named handlers so cleanup can off() exactly these listeners: the shared
    // commands subscription must never see removeAllListeners()/unsubscribe(),
    // or useCentrifugo's inbound-signal listener would be silently stripped
    // (e.g. under StrictMode double-mount, where this cleanup runs while
    // useCentrifugo's listener must stay alive).
    const onCommandsPublication = (ctx: { data: unknown; info?: { user?: string } }) => {
      // Fail-closed: Centrifugo gates SUBSCRIBE but not PUBLISH on user-limited
      // channels, so a foreign authenticated user could publish a spoofed
      // command_response to resolve/pollute our pending RPCs. Accept only
      // publications from the channel owner (the bridge connects with sub ==
      // userId, so its responses carry info.user == userId). Missing/mismatched
      // publisher identity is dropped.
      if (ctx.info?.user !== userId) return;

      const data = ctx.data as CommandResponseMessage;

      if (data.type === "command_response" && data.response) {
        setLastResponse(data.response);
        core.handleResponse(data.response);
        for (const listener of responseListenersRef.current) listener(data.response);
      }
    };
    commandsSub.on("publication", onCommandsPublication);

    const onSubscribedEvent = () => {
      for (const listener of subscribedListenersRef.current) listener();
    };
    commandsSub.on("subscribed", onSubscribedEvent);

    commandsSubRef.current = commandsSub;
    commandsSub.subscribe();

    return () => {
      // Shared with useCentrifugo: detach ONLY this hook's listeners. The
      // subscription's lifecycle ends with the client (client.disconnect in
      // useCentrifugo's teardown) — never unsubscribe/remove it here.
      commandsSub.off("publication", onCommandsPublication);
      commandsSub.off("subscribed", onSubscribedEvent);
      commandsSubRef.current = null;
    };
  }, [client, userId, core]);

  const publishCommand = useCallback((command: Command) => {
    if (!commandsSubRef.current) return;
    commandsSubRef.current.publish(command);
  }, []);

  const sendCommand = useCallback(
    (command: Command): Promise<CommandResponse> => {
      if (!commandsSubRef.current) return Promise.reject(new Error("Not connected"));
      return core.sendCommand(command);
    },
    [core]
  );

  const sendCommandCollect = useCallback(
    (command: Command, windowMs?: number): Promise<CommandResponse[]> => {
      if (!commandsSubRef.current) return Promise.reject(new Error("Not connected"));
      return core.sendCommandCollect(command, windowMs);
    },
    [core]
  );

  const bridgeExec = useCallback(
    (command: string, workingDir: string, bridgeId: string): Promise<BridgeExecResponse> => {
      if (!userId) return Promise.reject(new Error("Not connected"));
      return core.bridgeExec(command, workingDir, bridgeId);
    },
    [userId, core]
  );

  const onResponse = useCallback((listener: (response: CommandResponse) => void) => {
    responseListenersRef.current.add(listener);
    return () => {
      responseListenersRef.current.delete(listener);
    };
  }, []);

  const onSubscribed = useCallback((listener: () => void) => {
    subscribedListenersRef.current.add(listener);
    // The shared subscription may already be live when a consumer registers
    // (its 'subscribed' event won't re-fire), so invoke immediately.
    if (commandsSubRef.current?.state === SUBSCRIBED_STATE) listener();
    return () => {
      subscribedListenersRef.current.delete(listener);
    };
  }, []);

  return useMemo(
    () => ({
      publishCommand,
      sendCommand,
      sendCommandCollect,
      bridgeExec,
      onResponse,
      onSubscribed,
      lastResponse,
    }),
    [publishCommand, sendCommand, sendCommandCollect, bridgeExec, onResponse, onSubscribed, lastResponse]
  );
}
