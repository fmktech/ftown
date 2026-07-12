"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loop } from "@/types";
import {
  BridgeExecFn,
  FACTORY_GROUP_PREFIX,
  FactoryInfo,
  FactorySnapshot,
  FactoryTicket,
  LIST_SKILLS_CMD,
  SKILL_PATH_RE,
  SkillFile,
  STAGES_CMD,
  TICKETS_CMD,
  TicketDetail,
  UseFactoryResult,
  readSkillCmd,
  showTicketCmd,
  writeSkillCmd,
} from "./types";

/** Derive the set of factories from a bridge's loops (dispatch + triage loops
 *  created by `factory up` share group/workdir — dedupe by project). */
export function deriveFactories(loops: Loop[]): FactoryInfo[] {
  const byProject = new Map<string, FactoryInfo>();
  for (const loop of loops) {
    const group = loop.group;
    if (!group || !group.startsWith(FACTORY_GROUP_PREFIX)) continue;
    if (!loop.workdir) continue;
    const project = group.slice(FACTORY_GROUP_PREFIX.length).trim();
    if (!project || byProject.has(project)) continue;
    byProject.set(project, {
      project,
      repoRoot: loop.workdir,
      bridgeId: loop.bridgeId,
    });
  }
  return [...byProject.values()].sort((a, b) =>
    a.project.localeCompare(b.project),
  );
}

/** sqlite3 -json prints EMPTY stdout for zero rows — blank means []. */
function parseJsonRows<T>(stdout: string): T[] {
  const text = stdout.trim();
  if (!text) return [];
  return JSON.parse(text) as T[];
}

function trimmedStderr(stderr: string | undefined): string {
  return (stderr ?? "").trim().slice(0, 200);
}

function execErrorMessage(prefix: string, stderr: string | undefined): string {
  const detail = trimmedStderr(stderr);
  return detail ? `${prefix}: ${detail}` : prefix;
}

function shortMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.trim().slice(0, 200) || "poll failed";
}

export function useFactory(
  factory: FactoryInfo | null,
  bridgeExec: BridgeExecFn,
  pollMs = 5000,
): UseFactoryResult {
  const [snapshot, setSnapshot] = useState<FactorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const project = factory?.project ?? null;
  const bridgeId = factory?.bridgeId ?? null;
  const repoRoot = factory?.repoRoot ?? null;
  // Factory identity — polls in flight when this changes are discarded.
  const identityKey =
    project !== null && bridgeId !== null ? `${project}\u0000${bridgeId}` : null;

  const identityRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doPoll = useCallback(async () => {
    if (repoRoot === null || bridgeId === null || identityKey === null) return;
    const key = identityKey;
    try {
      const [stagesRes, ticketsRes] = await Promise.all([
        bridgeExec(STAGES_CMD, repoRoot, bridgeId),
        bridgeExec(TICKETS_CMD, repoRoot, bridgeId),
      ]);
      if (identityRef.current !== key) return; // stale — factory changed/unmounted
      const failed = [stagesRes, ticketsRes].find(
        (res) => (res.exitCode ?? 0) !== 0,
      );
      if (failed) {
        setError(execErrorMessage("factory query failed", failed.stderr));
      } else {
        const stageRows = parseJsonRows<{ name: string; ord: number }>(
          stagesRes.stdout,
        );
        const tickets = parseJsonRows<FactoryTicket>(ticketsRes.stdout);
        const stages = [...stageRows]
          .sort((a, b) => a.ord - b.ord)
          .map((row) => row.name);
        setSnapshot({ stages, tickets, fetchedAt: Date.now() });
        setError(null);
      }
    } catch (err) {
      if (identityRef.current !== key) return;
      setError(shortMessage(err));
    } finally {
      if (identityRef.current === key) setLoading(false);
    }
  }, [bridgeExec, bridgeId, identityKey, repoRoot]);

  useEffect(() => {
    identityRef.current = identityKey;
    setSnapshot(null);
    setError(null);
    if (identityKey === null) {
      setLoading(false);
      return () => {
        identityRef.current = null;
      };
    }
    setLoading(true);
    void doPoll();
    timerRef.current = setInterval(() => {
      void doPoll();
    }, pollMs);
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
      timerRef.current = null;
      identityRef.current = null;
    };
  }, [identityKey, doPoll, pollMs]);

  const refresh = useCallback(() => {
    if (identityRef.current === null) return;
    // Reset the interval so the forced poll doesn't double up with a tick.
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        void doPoll();
      }, pollMs);
    }
    void doPoll();
  }, [doPoll, pollMs]);

  const showTicket = useCallback(
    async (id: number): Promise<TicketDetail> => {
      if (repoRoot === null || bridgeId === null) {
        throw new Error("no factory selected");
      }
      const res = await bridgeExec(showTicketCmd(id), repoRoot, bridgeId);
      if ((res.exitCode ?? 0) !== 0) {
        throw new Error(trimmedStderr(res.stderr) || "fts show failed");
      }
      try {
        return JSON.parse(res.stdout) as TicketDetail;
      } catch {
        throw new Error(trimmedStderr(res.stderr) || "fts show failed");
      }
    },
    [bridgeExec, bridgeId, repoRoot],
  );

  const listSkills = useCallback(async (): Promise<SkillFile[]> => {
    if (repoRoot === null || bridgeId === null) {
      throw new Error("no factory selected");
    }
    const res = await bridgeExec(LIST_SKILLS_CMD, repoRoot, bridgeId);
    if (!res.stdout.trim()) return [];
    return res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && SKILL_PATH_RE.test(line))
      .map((relPath) => ({
        relPath,
        name: relPath.slice(relPath.lastIndexOf("/") + 1),
      }));
  }, [bridgeExec, bridgeId, repoRoot]);

  const readSkill = useCallback(
    async (relPath: string): Promise<string> => {
      if (!SKILL_PATH_RE.test(relPath)) throw new Error("invalid skill path");
      if (repoRoot === null || bridgeId === null) {
        throw new Error("no factory selected");
      }
      const res = await bridgeExec(readSkillCmd(relPath), repoRoot, bridgeId);
      if ((res.exitCode ?? 0) !== 0) {
        throw new Error(trimmedStderr(res.stderr) || "failed to read skill");
      }
      return res.stdout; // verbatim — file content, do not trim
    },
    [bridgeExec, bridgeId, repoRoot],
  );

  const writeSkill = useCallback(
    async (relPath: string, content: string): Promise<void> => {
      if (!SKILL_PATH_RE.test(relPath)) throw new Error("invalid skill path");
      if (repoRoot === null || bridgeId === null) {
        throw new Error("no factory selected");
      }
      const res = await bridgeExec(
        writeSkillCmd(relPath, content),
        repoRoot,
        bridgeId,
      );
      if ((res.exitCode ?? 0) !== 0) {
        throw new Error(trimmedStderr(res.stderr) || "failed to write skill");
      }
    },
    [bridgeExec, bridgeId, repoRoot],
  );

  return {
    snapshot,
    error,
    loading,
    refresh,
    showTicket,
    listSkills,
    readSkill,
    writeSkill,
  };
}
