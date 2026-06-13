"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Centrifuge, Subscription } from "centrifuge";
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
import { buildCodexCommand, buildCursorAgentCommand } from "@/lib/agent-commands";

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

interface UseSessionsResult {
  sessions: Session[];
  createSession: (prompt: string, options?: { name?: string; model?: string; workingDir?: string; bridgeId?: string; shellType?: ShellType; claudeSessionId?: string; cursorSessionId?: string; env?: Record<string, string>; orchestrator?: boolean }) => Promise<void>;
  stopSession: (sessionId: string) => void;
  retrySession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  setSessionParent: (sessionId: string, parentSessionId: string | null) => void;
  removeSession: (sessionId: string, onlyIfFinished?: boolean, ownerOnline?: boolean) => void;
  refreshSessions: () => void;
  bridgeExec: (command: string, workingDir: string, bridgeId: string) => Promise<BridgeExecResponse>;
  lastResponse: CommandResponse | null;
}

export function useSessions(client: Centrifuge | null, userId: string | null): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [lastResponse, setLastResponse] = useState<CommandResponse | null>(null);
  const sessionsSubRef = useRef<Subscription | null>(null);
  const commandsSubRef = useRef<Subscription | null>(null);
  const pendingCallbacksRef = useRef<Map<string, (response: CommandResponse) => void>>(new Map());
  // sessionId -> tombstone expiry (ms). Set on optimistic delete; consulted by
  // the publication/merge handlers to keep a removed row from resurrecting.
  const recentlyRemovedRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!client || !userId) return;

    const sessionsChannel = `sessions:updates#${userId}`;
    const commandsChannel = `commands:rpc#${userId}`;

    for (const ch of [sessionsChannel, commandsChannel]) {
      const existing = client.getSubscription(ch);
      if (existing) {
        existing.removeAllListeners();
        existing.unsubscribe();
        client.removeSubscription(existing);
      }
    }

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

    const commandsSub = client.newSubscription(commandsChannel);

    commandsSub.on("publication", (ctx) => {
      const data = ctx.data as CommandResponseMessage;

      if (data.type === 'command_response' && data.response) {
        setLastResponse(data.response);

        const cb = pendingCallbacksRef.current.get(data.response.requestId);
        if (cb) {
          pendingCallbacksRef.current.delete(data.response.requestId);
          cb(data.response);
        }

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
    });

    commandsSub.subscribe();
    commandsSubRef.current = commandsSub;

    // Load existing sessions from bridges on connect
    commandsSub.publish({
      type: "list_sessions",
      payload: {},
      requestId: uuidv4(),
    });

    return () => {
      sessionsSub.removeAllListeners();
      sessionsSub.unsubscribe();
      client.removeSubscription(sessionsSub);
      commandsSub.removeAllListeners();
      commandsSub.unsubscribe();
      client.removeSubscription(commandsSub);
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
    (prompt: string, options?: { name?: string; model?: string; workingDir?: string; bridgeId?: string; shellType?: ShellType; claudeSessionId?: string; cursorSessionId?: string; codexSessionId?: string; env?: Record<string, string>; orchestrator?: boolean }): Promise<void> => {
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
            reject(new Error(resp.error ?? "create_session failed"));
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
    lastResponse,
  };
}
