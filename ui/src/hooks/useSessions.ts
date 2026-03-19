"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Centrifuge, Subscription } from "centrifuge";
import { v4 as uuidv4 } from "uuid";
import {
  Session,
  Command,
  CommandResponse,
  CreateSessionPayload,
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

interface UseSessionsResult {
  sessions: Session[];
  createSession: (prompt: string, options?: { name?: string; model?: string; workingDir?: string }) => void;
  stopSession: (sessionId: string) => void;
  retrySession: (sessionId: string) => void;
  refreshSessions: () => void;
  lastResponse: CommandResponse | null;
}

export function useSessions(client: Centrifuge | null, userId: string | null): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [lastResponse, setLastResponse] = useState<CommandResponse | null>(null);
  const sessionsSubRef = useRef<Subscription | null>(null);
  const commandsSubRef = useRef<Subscription | null>(null);

  useEffect(() => {
    if (!client || !userId) return;

    const sessionsChannel = `sessions#${userId}`;
    const commandsChannel = `commands#${userId}`;

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
    });

    sessionsSub.subscribe();
    sessionsSubRef.current = sessionsSub;

    const commandsSub = client.newSubscription(commandsChannel);

    commandsSub.on("publication", (ctx) => {
      const data = ctx.data as CommandResponseMessage;

      if (data.type === 'command_response' && data.response) {
        setLastResponse(data.response);

        if (data.response.success && data.response.data) {
          const responseData = data.response.data as { sessions?: Session[] };
          if (Array.isArray(responseData.sessions)) {
            setSessions(responseData.sessions);
          }
        }
      }
    });

    commandsSub.subscribe();
    commandsSubRef.current = commandsSub;

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
    (prompt: string, options?: { name?: string; model?: string; workingDir?: string }) => {
      if (!userId) return;

      const payload: CreateSessionPayload = {
        prompt,
        name: options?.name,
        model: options?.model ?? "sonnet",
        workingDir: options?.workingDir,
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

  const refreshSessions = useCallback(() => {
    if (!userId) return;

    const command: Command = {
      type: "list_sessions",
      payload: {},
      requestId: uuidv4(),
    };

    publishCommand(command);
  }, [userId, publishCommand]);

  return {
    sessions,
    createSession,
    stopSession,
    retrySession,
    refreshSessions,
    lastResponse,
  };
}
