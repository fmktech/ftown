import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import type { Session } from "@/types";

export interface VisibleSessionAttention {
  sessionId: string;
  sessionName: string;
  title: string;
  message: string;
  receivedAt: number;
}

interface LatestVisibleSessionAttentionInput {
  sessions: Session[];
  sessionActivity: Map<string, SessionActivity>;
  hiddenSessionIds: ReadonlySet<string>;
  hiddenBridgeIds: ReadonlySet<string>;
}

/** Return the newest input request that is visible on this computer. */
export function latestVisibleSessionAttention({
  sessions,
  sessionActivity,
  hiddenSessionIds,
  hiddenBridgeIds,
}: LatestVisibleSessionAttentionInput): VisibleSessionAttention | null {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  let latest: VisibleSessionAttention | null = null;

  for (const [sessionId, activity] of sessionActivity) {
    const session = sessionsById.get(sessionId);
    if (
      !activity.attention
      || !session
      || hiddenSessionIds.has(sessionId)
      || hiddenBridgeIds.has(session.bridgeId)
    ) {
      continue;
    }

    const candidate = {
      sessionId,
      sessionName: session.name || session.prompt?.slice(0, 48) || "Session",
      ...activity.attention,
    };
    if (!latest || candidate.receivedAt > latest.receivedAt) latest = candidate;
  }

  return latest;
}
