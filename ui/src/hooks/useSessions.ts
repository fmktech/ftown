"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Centrifuge, Subscription, SubscriptionState } from "centrifuge";
import type { PublicationContext } from "centrifuge";
import { v4 as uuidv4 } from "uuid";
import {
  Session,
  ShellType,
  Command,
  CommandResponse,
  CreateSessionPayload,
  BridgeExecPayload,
  RenameSessionPayload,
  RemoveSessionPayload,
  UpdateSessionParentPayload,
} from "@/types";
import { buildCodexCommand, buildCursorAgentCommand, buildGrokCommand } from "@/lib/agent-commands";

// How long an optimistically-removed session id stays "tombstoned": a late
// status update or an in-flight list_sessions snapshot for that id is ignored
// for this window so a just-deleted row cannot reappear before the bridge's
// authoritative 'removed' broadcast arrives.
const REMOVED_TOMBSTONE_MS = 12_000;

interface SessionUpdateMessage {
  type: 'session_update';
  session: Session;
  timestamp: string;
}

interface CommandResponseMessage {
  type: 'command_response';
  response: CommandResponse;
  timestamp: string;
}

export interface BridgeExecResponse {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}

export interface CreateSessionOptions {
  name?: string;
  model?: string;
  workingDir?: string;
  bridgeId?: string;
  shellType?: ShellType;
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  env?: Record<string, string>;
  orchestrator?: boolean;
  createMissingWorkingDir?: boolean;
}

export class CreateSessionBridgeError extends Error {
  readonly code?: string;
  readonly workingDir?: string;
  readonly canCreate?: boolean;

  constructor(message: string, data?: unknown) {
    super(message);
    this.name = "CreateSessionBridgeError";
    const payload = data as { code?: unknown; workingDir?: unknown; canCreate?: unknown } | undefined;
    this.code = typeof payload?.code === "string" ? payload.code : undefined;
    this.workingDir = typeof payload?.workingDir === "string" ? payload.workingDir : undefined;
    this.canCreate = payload?.canCreate === true;
  }
}

interface UseSessionsResult {
  sessions: Session[];
  createSession: (prompt: string, options?: CreateSessionOptions) => Promise<void>;
  stopSession: (sessionId: string) => void;
  retrySession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  setSessionParent: (sessionId: string, parentSessionId: string | null) => void;
  removeSession: (sessionId: string, onlyIfFinished?: boolean, ownerOnline?: boolean) => void;
  refreshSessions: () => void;
  bridgeExec: (command: string, workingDir: string, bridgeId: string) => Promise<BridgeExecResponse>;
  /**
   * Generalized RPC helper over the same `commands:rpc#{userId}` channel/
   * pendingCallbacksRef/30s-timeout pattern as bridgeExec, exposed so other
   * hooks (e.g. useLoops) can issue commands without opening a second
   * subscription to the channel this hook already owns.
   */
  sendCommand: (command: Command) => Promise<CommandResponse>;
  /**
   * Broadcast variant of sendCommand: publishes once and RESOLVES WITH EVERY
   * response received within `windowMs` (default 1500ms), so a fan-out command
   * with no bridgeId (e.g. list_loops) merges replies from all connected
   * bridges instead of only the first responder.
   */
  sendCommandCollect: (command: Command, windowMs?: number) => Promise<CommandResponse[]>;
  lastResponse: CommandResponse | null;
}

export function useSessions(client: Centrifuge | null, userId: string | null): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [lastResponse, setLastResponse] = useState<CommandResponse | null>(null);
  const sessionsSubRef = useRef<Subscription | null>(null);
  const commandsSubRef = useRef<Subscription | null>(null);
  const pendingCallbacksRef = useRef<Map<string, (response: CommandResponse) => void>>(new Map());
  // Broadcast-collect callbacks: unlike pendingCallbacksRef (which resolves on
  // the FIRST response and deletes itself), these accumulate EVERY response for
  // a requestId until a time window closes — so a broadcast command (e.g.
  // list_loops with no bridgeId) can merge replies from every connected bridge
  // instead of silently dropping all but the fastest.
  const collectingCallbacksRef = useRef<Map<string, (response: CommandResponse) => void>>(new Map());
  // sessionId -> tombstone expiry (ms). Set on optimistic delete; consulted by
  // the publication/merge handlers to keep a removed row from resurrecting.
  const recentlyRemovedRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!client || !userId) return;

    const sessionsChannel = `sessions:updates#${userId}`;
    const commandsChannel = `commands:rpc#${userId}`;

    // sessionsChannel is exclusively owned by this hook: always start clean.
    const existingSessionsSub = client.getSubscription(sessionsChannel);
    if (existingSessionsSub) {
      existingSessionsSub.removeAllListeners();
      existingSessionsSub.unsubscribe();
      client.removeSubscription(existingSessionsSub);
    }
    // commandsChannel is shared: useCentrifugo may already have created (and
    // attached an inbound-signal listener to) this Subscription before this
    // effect runs. Reuse it instead of tearing it down, so that listener
    // survives — Centrifuge only allows one Subscription object per channel.

    // A session the user just deleted is removed optimistically. While its
    // tombstone is live, ignore any late update or stale snapshot that names it
    // so the row does not flicker back in before the bridge confirms removal.
    const isRecentlyRemoved = (id: string): boolean => {
      const expiry = recentlyRemovedRef.current.get(id);
      if (expiry === undefined) return false;
      if (expiry <= Date.now()) {
        recentlyRemovedRef.current.delete(id);
        return false;
      }
      return true;
    };

    const sessionsSub = client.newSubscription(sessionsChannel);

    sessionsSub.on("publication", (ctx) => {
      const data = ctx.data as SessionUpdateMessage;

      if (data.type === 'session_update' && data.session) {
        if ((data.session.status as string) === 'removed') {
          setSessions((prev) => prev.filter((s) => s.id !== data.session.id));
        } else if (!isRecentlyRemoved(data.session.id)) {
          setSessions((prev) => {
            const idx = prev.findIndex((s) => s.id === data.session.id);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = data.session;
              return updated;
            }
            return [data.session, ...prev];
          });
        }
      }
    });

    sessionsSub.subscribe();
    sessionsSubRef.current = sessionsSub;

    const commandsSub =
      client.getSubscription(commandsChannel) ?? client.newSubscription(commandsChannel);

    // Named handlers so cleanup can off() exactly these listeners: the shared
    // commands subscription must never see removeAllListeners()/unsubscribe(),
    // or useCentrifugo's inbound-signal listener would be silently stripped
    // (e.g. under StrictMode double-mount, where this cleanup runs while
    // useCentrifugo's listener must stay alive).
    const onCommandsPublication = (ctx: PublicationContext) => {
      const data = ctx.data as CommandResponseMessage;

      if (data.type === 'command_response' && data.response) {
        setLastResponse(data.response);

        const cb = pendingCallbacksRef.current.get(data.response.requestId);
        if (cb) {
          pendingCallbacksRef.current.delete(data.response.requestId);
          cb(data.response);
        }

        // Broadcast collectors accumulate every bridge's reply (not deleted here;
        // the collect window clears them on timeout).
        const collector = collectingCallbacksRef.current.get(data.response.requestId);
        if (collector) collector(data.response);

        if (data.response.success && data.response.data) {
          const responseData = data.response.data as { sessions?: Session[] };
          if (Array.isArray(responseData.sessions)) {
            setSessions((prev) => {
              const merged = new Map(prev.map((s) => [s.id, s]));
              for (const s of responseData.sessions!) {
                if (isRecentlyRemoved(s.id)) continue;
                merged.set(s.id, s);
              }
              return Array.from(merged.values());
            });
          }
        }
      }
    };
    commandsSub.on("publication", onCommandsPublication);

    // Re-request the session list on every (re)subscribe — not just the first —
    // so the UI recovers its list after a Centrifugo reconnect instead of
    // showing a stale/empty list until a page reload.
    const requestSessionList = () => {
      commandsSub.publish({
        type: "list_sessions",
        payload: {},
        requestId: uuidv4(),
      });
    };
    commandsSub.on("subscribed", requestSessionList);

    commandsSub.subscribe();
    // The shared subscription may already be live (e.g. StrictMode remount
    // reusing useCentrifugo's subscription): 'subscribed' won't re-fire then,
    // so request the initial list explicitly.
    if (commandsSub.state === SubscriptionState.Subscribed) {
      requestSessionList();
    }
    commandsSubRef.current = commandsSub;

    return () => {
      // Exclusively owned: full teardown.
      sessionsSub.removeAllListeners();
      sessionsSub.unsubscribe();
      client.removeSubscription(sessionsSub);
      // Shared with useCentrifugo: detach ONLY this hook's listeners. The
      // subscription's lifecycle ends with the client (client.disconnect in
      // useCentrifugo's teardown) — never unsubscribe/remove it here.
      commandsSub.off("publication", onCommandsPublication);
      commandsSub.off("subscribed", requestSessionList);
      sessionsSubRef.current = null;
      commandsSubRef.current = null;
    };
  }, [client, userId]);

  const publishCommand = useCallback(
    (command: Command) => {
      if (!commandsSubRef.current) return;
      commandsSubRef.current.publish(command);
    },
    []
  );

  const createSession = useCallback(
    (prompt: string, options?: CreateSessionOptions): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        if (!userId) {
          reject(new Error("Not connected"));
          return;
        }

        const shellType = options?.shellType ?? "claude";
        let cmd: string;
        if (shellType === "shell") {
          cmd = "/bin/zsh -l";
        } else if (shellType === "opencode") {
          cmd = "opencode";
        } else if (shellType === "cursor") {
          cmd = buildCursorAgentCommand({
            workingDir: options?.workingDir,
            model: options?.model,
            cursorSessionId: options?.cursorSessionId,
          });
        } else if (shellType === "codex") {
          cmd = buildCodexCommand({
            model: options?.model,
            codexSessionId: options?.codexSessionId,
          });
        } else if (shellType === "grok") {
          cmd = buildGrokCommand({
            model: options?.model,
          });
        } else if (options?.claudeSessionId) {
          cmd = `claude --allow-dangerously-skip-permissions --resume ${options.claudeSessionId}`;
        } else {
          cmd = "claude --allow-dangerously-skip-permissions";
        }

        const payload: CreateSessionPayload = {
          command: cmd,
          prompt,
          name: options?.name,
          model: options?.model,
          workingDir: options?.workingDir,
          bridgeId: options?.bridgeId,
          shellType,
          claudeSessionId: options?.claudeSessionId,
          cursorSessionId: options?.cursorSessionId,
          codexSessionId: options?.codexSessionId,
          env: options?.env,
          ...(options?.orchestrator && shellType !== "shell" ? { orchestrator: true } : {}),
          ...(options?.createMissingWorkingDir ? { createMissingWorkingDir: true } : {}),
          ...(prompt ? { initialInput: prompt + "\r", initialInputDelay: 2000 } : {}),
        };

        const requestId = uuidv4();
        const timeout = setTimeout(() => {
          pendingCallbacksRef.current.delete(requestId);
          reject(new Error("create_session timed out"));
        }, 30_000);

        pendingCallbacksRef.current.set(requestId, (resp) => {
          clearTimeout(timeout);
          if (resp.success) {
            resolve();
          } else {
            reject(new CreateSessionBridgeError(resp.error ?? "create_session failed", resp.data));
          }
        });

        const command: Command = {
          type: "create_session",
          payload,
          requestId,
        };

        publishCommand(command);
      });
    },
    [userId, publishCommand]
  );

  const stopSession = useCallback(
    (sessionId: string) => {
      if (!userId) return;

      const command: Command = {
        type: "stop_session",
        payload: { sessionId },
        requestId: uuidv4(),
      };

      publishCommand(command);
    },
    [userId, publishCommand]
  );

  const retrySession = useCallback(
    (sessionId: string) => {
      if (!userId) return;

      const command: Command = {
        type: "retry_session",
        payload: { sessionId },
        requestId: uuidv4(),
      };

      publishCommand(command);
    },
    [userId, publishCommand]
  );

  const renameSession = useCallback(
    (sessionId: string, name: string) => {
      if (!userId) return;

      const payload: RenameSessionPayload = { sessionId, name };
      const command: Command = {
        type: "rename_session",
        payload,
        requestId: uuidv4(),
      };

      publishCommand(command);
    },
    [userId, publishCommand]
  );

  const setSessionParent = useCallback(
    (sessionId: string, parentSessionId: string | null) => {
      if (!userId) return;

      const payload: UpdateSessionParentPayload = { sessionId, parentSessionId };
      const command: Command = {
        type: "update_session_parent",
        payload,
        requestId: uuidv4(),
      };

      publishCommand(command);
    },
    [userId, publishCommand]
  );

  const removeSession = useCallback(
    (sessionId: string, onlyIfFinished?: boolean, ownerOnline: boolean = true) => {
      if (!userId) return;

      // Explicit deletes are optimistic: when the owning bridge is online,
      // removeFtownSession always removes an existing session, so the outcome is
      // decided the moment the user acts. Drop the row now instead of waiting for
      // the 'removed' broadcast to round-trip (which can be slow or dropped,
      // leaving the row until a manual refresh). A tombstone makes the removal
      // sticky so a late status update or in-flight list snapshot cannot
      // resurrect it.
      //
      // Two cases are deliberately NOT optimistic, to avoid faking a delete that
      // never happens: (a) onlyIfFinished bulk-clear, where the bridge may decline
      // a finished session retried back to running; (b) ownerOnline === false,
      // where the command is dropped (the commands channel has no history) and the
      // session genuinely still exists — the row must truthfully stay until the
      // bridge reconnects and processes the removal.
      if (!onlyIfFinished && ownerOnline) {
        const now = Date.now();
        for (const [id, exp] of recentlyRemovedRef.current) {
          if (exp <= now) recentlyRemovedRef.current.delete(id);
        }
        recentlyRemovedRef.current.set(sessionId, now + REMOVED_TOMBSTONE_MS);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      }

      const payload: RemoveSessionPayload = { sessionId, onlyIfFinished };
      const command: Command = {
        type: "remove_session",
        payload,
        requestId: uuidv4(),
      };

      publishCommand(command);
    },
    [userId, publishCommand]
  );

  const refreshSessions = useCallback(() => {
    if (!userId) return;

    const command: Command = {
      type: "list_sessions",
      payload: {},
      requestId: uuidv4(),
    };

    publishCommand(command);
  }, [userId, publishCommand]);

  const bridgeExec = useCallback(
    (command: string, workingDir: string, bridgeId: string): Promise<BridgeExecResponse> => {
      return new Promise((resolve, reject) => {
        if (!userId) {
          reject(new Error("Not connected"));
          return;
        }

        const requestId = uuidv4();
        const timeout = setTimeout(() => {
          pendingCallbacksRef.current.delete(requestId);
          reject(new Error("bridge_exec timed out"));
        }, 30_000);

        pendingCallbacksRef.current.set(requestId, (resp) => {
          clearTimeout(timeout);
          if (resp.success) {
            resolve(resp.data as BridgeExecResponse);
          } else {
            reject(new Error(resp.error ?? "bridge_exec failed"));
          }
        });

        const payload: BridgeExecPayload = { command, workingDir, bridgeId };
        publishCommand({ type: "bridge_exec", payload, requestId });
      });
    },
    [userId, publishCommand]
  );

  const sendCommand = useCallback(
    (command: Command): Promise<CommandResponse> => {
      return new Promise((resolve, reject) => {
        if (!commandsSubRef.current) {
          reject(new Error("Not connected"));
          return;
        }

        const timeout = setTimeout(() => {
          pendingCallbacksRef.current.delete(command.requestId);
          reject(new Error(`${command.type} timed out`));
        }, 30_000);

        pendingCallbacksRef.current.set(command.requestId, (resp) => {
          clearTimeout(timeout);
          resolve(resp);
        });

        publishCommand(command);
      });
    },
    [publishCommand]
  );

  const sendCommandCollect = useCallback(
    (command: Command, windowMs = 1500): Promise<CommandResponse[]> => {
      return new Promise((resolve, reject) => {
        if (!commandsSubRef.current) {
          reject(new Error("Not connected"));
          return;
        }

        const responses: CommandResponse[] = [];
        collectingCallbacksRef.current.set(command.requestId, (resp) => {
          responses.push(resp);
        });
        // Fixed window rather than resolve-on-first: a broadcast has an unknown
        // number of responders, so we collect until the window closes.
        setTimeout(() => {
          collectingCallbacksRef.current.delete(command.requestId);
          resolve(responses);
        }, windowMs);

        publishCommand(command);
      });
    },
    [publishCommand]
  );

  return {
    sessions,
    createSession,
    stopSession,
    retrySession,
    renameSession,
    setSessionParent,
    removeSession,
    refreshSessions,
    bridgeExec,
    sendCommand,
    sendCommandCollect,
    lastResponse,
  };
}
