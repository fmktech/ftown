"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Command, CommandResponse, Session } from "@/types";
import type { PullRequestStatus } from "../../../bridge/src/pull-request-status-protocol";
import { usePullRequestStatuses } from "@/hooks/usePullRequestStatuses";

const StatusContext = createContext<(url: string) => PullRequestStatus | undefined>(() => undefined);
export const usePullRequestStatus = (url: string) => useContext(StatusContext)(url);

export function PullRequestStatusProvider({ send, sessions, readyBridgeIds, connected, children }: {
  send: (command: Command) => Promise<CommandResponse>;
  sessions: readonly Pick<Session, "id" | "bridgeId" | "pullRequestUrl">[];
  readyBridgeIds: readonly string[];
  connected: boolean;
  children: ReactNode;
}) {
  const controller = usePullRequestStatuses(send, sessions, readyBridgeIds, connected);
  return <StatusContext.Provider value={url => controller.get(url)}>{children}</StatusContext.Provider>;
}
