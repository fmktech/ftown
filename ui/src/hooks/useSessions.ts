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
  GetDiffPayload,
  RenameSessionPayload,
  RemoveSessionPayload,
} from "@/types";

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
  createSession: (prompt: string, options?: { name?: string; model?: string; workingDir?: string; bridgeId?: string; shellType?: ShellType; claudeSessionId?: string }) => void;
  stopSession: (sessionId: string) => void;
  retrySession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  removeSession: (sessionId: string) => void;
  refreshSessions: () => void;
  bridgeExec: (command: string, workingDir: string, bridgeId: string) => Promise<BridgeExecResponse>;
  getDiff: (sessionId: string, bridgeId?: string) => Promise<string>;
  lastResponse: CommandResponse | null;
}

export function useSessions(client: Centrifuge | null, userId: string | null): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [lastResponse, setLastResponse] = useState<CommandResponse | null>(null);
  const sessionsSubRef = useRef<Subscription | null>(null);
  const commandsSubRef = useRef<Subscription | null>(null);
  const pendingCallbacksRef = useRef<Map<string, (response: CommandResponse) => void>>(new Map());

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

    const sessionsSub = client.newSubscription(sessionsChannel);

    sessionsSub.on("publication", (ctx) => {
      const data = ctx.data as SessionUpdateMessage;

      if (data.type === 'session_update' && data.session) {
        if ((data.session.status as string) === 'removed') {
          setSessions((prev) => prev.filter((s) => s.id !== data.session.id));
        } else {
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
    (prompt: string, options?: { name?: string; model?: string; workingDir?: string; bridgeId?: string; shellType?: ShellType; claudeSessionId?: string }) => {
      if (!userId) return;

      const shellType = options?.shellType ?? "claude";
      let cmd: string;
      if (shellType === "shell") {
        cmd = "/bin/zsh -l";
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
        ...(prompt ? { initialInput: prompt + "\r", initialInputDelay: 2000 } : {}),
      };

      const command: Command = {
        type: "create_session",
        payload,
        requestId: uuidv4(),
      };

      publishCommand(command);
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

  const removeSession = useCallback(
    (sessionId: string) => {
      if (!userId) return;

      const payload: RemoveSessionPayload = { sessionId };
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

  const getDiff = useCallback(
    (sessionId: string, bridgeId?: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        if (!userId) {
          reject(new Error("Not connected"));
          return;
        }

        const requestId = uuidv4();
        const timeout = setTimeout(() => {
          pendingCallbacksRef.current.delete(requestId);
          reject(new Error("get_diff timed out"));
        }, 30_000);

        pendingCallbacksRef.current.set(requestId, (resp) => {
          clearTimeout(timeout);
          if (resp.success) {
            const data = resp.data as { diff: string };
            resolve(data.diff ?? "");
          } else {
            reject(new Error(resp.error ?? "get_diff failed"));
          }
        });

        const payload: GetDiffPayload = { sessionId, bridgeId };
        publishCommand({ type: "get_diff", payload, requestId });
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
    removeSession,
    refreshSessions,
    bridgeExec,
    getDiff,
    lastResponse,
  };
}
