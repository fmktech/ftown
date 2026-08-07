import type { Session } from "@/types";

export interface UsagePollBatch {
  bridgeId: string;
  sessionIds: string[];
}

const MAX_USAGE_BATCH_SIZE = 200;

function hasCollectableUsage(session: Session): boolean {
  if (session.status !== "running") return false;
  if (session.codexSessionId) return true;
  if (session.claudeSessionId && session.workingDir) return true;
  return session.shellType === "kimi-code" && Boolean(session.workingDir);
}

/** Build one stable usage request per bridge, excluding sessions no collector can read. */
export function buildUsagePollBatches(sessions: Session[]): UsagePollBatch[] {
  const grouped = new Map<string, string[]>();
  for (const session of sessions) {
    if (!hasCollectableUsage(session)) continue;
    const ids = grouped.get(session.bridgeId) ?? [];
    ids.push(session.id);
    grouped.set(session.bridgeId, ids);
  }

  const batches: UsagePollBatch[] = [];
  const groups = Array.from(grouped).sort(([a], [b]) => a.localeCompare(b));
  for (const [bridgeId, unsortedIds] of groups) {
    const sessionIds = unsortedIds.sort();
    for (let offset = 0; offset < sessionIds.length; offset += MAX_USAGE_BATCH_SIZE) {
      batches.push({ bridgeId, sessionIds: sessionIds.slice(offset, offset + MAX_USAGE_BATCH_SIZE) });
    }
  }
  return batches;
}
