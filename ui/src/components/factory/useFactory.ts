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
  NewTicketInput,
  SKILL_PATH_RE,
  SkillFile,
  SQLITE_TRANSIENT_RE,
  STAGES_CMD,
  TICKETS_CMD,
  TicketDetail,
  TicketArtifactFile,
  UseFactoryResult,
  createTicketCmd,
  factoryKey,
  listTicketArtifactsCmd,
  parseTicketArtifactFiles,
  readTicketArtifactCmd,
  readSkillCmd,
  showTicketCmd,
  slugify,
  writeSkillCmd,
} from "./types";

/** A transient lock is tolerated silently for this many consecutive polls
 *  before it surfaces as an error (~15s at the default 5s poll interval). */
const TRANSIENT_FAILURE_THRESHOLD = 3;

/** Derive the set of factories from a bridge's loops (dispatch + triage loops
 *  created by `factory up` share group/workdir — dedupe by factoryKey, so
 *  same-named projects on different bridges both appear). */
export function deriveFactories(loops: Loop[]): FactoryInfo[] {
  const byKey = new Map<string, FactoryInfo>();
  for (const loop of loops) {
    const group = loop.group;
    if (!group || !group.startsWith(FACTORY_GROUP_PREFIX)) continue;
    if (!loop.workdir) continue;
    const project = group.slice(FACTORY_GROUP_PREFIX.length).trim();
    if (!project) continue;
    const info: FactoryInfo = {
      project,
      repoRoot: loop.workdir,
      bridgeId: loop.bridgeId,
    };
    const key = factoryKey(info);
    if (byKey.has(key)) continue;
    byKey.set(key, info);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.project.localeCompare(b.project) ||
      a.bridgeId.localeCompare(b.bridgeId),
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

/** The bridge's bridge_exec success path always sets exitCode: 0 explicitly;
 *  its exec-failure path replies success with exitCode: execErr.code, which is
 *  undefined when the process was timeout- or signal-killed. Success therefore
 *  requires a strict exitCode === 0 — a missing exitCode is never success.
 *  Returns an error message on failure, or null on success. */
function execFailure(
  res: { exitCode?: number | null; stderr?: string },
  prefix: string,
): string | null {
  if (res.exitCode === 0) return null;
  if (res.exitCode === undefined || res.exitCode === null) {
    return execErrorMessage("exec failed (killed or timed out)", res.stderr);
  }
  return execErrorMessage(prefix, res.stderr);
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
  // Consecutive poll failures whose error text matched SQLITE_TRANSIENT_RE.
  // Reset on any successful poll and whenever the factory identity changes.
  const transientFailureCountRef = useRef(0);
  // Monotonic poll ordering: overlapping polls (interval tick + refresh(), or
  // a slow tick finishing after a fast one) may resolve out of order. Each
  // poll captures a seq at dispatch; a resolving poll applies state only if
  // its seq is greater than the last APPLIED seq.
  const pollSeqRef = useRef(0);
  const lastAppliedSeqRef = useRef(0);

  const doPoll = useCallback(async () => {
    if (repoRoot === null || bridgeId === null || identityKey === null) return;
    const key = identityKey;
    const seq = ++pollSeqRef.current;
    try {
      const [stagesRes, ticketsRes] = await Promise.all([
        bridgeExec(STAGES_CMD, repoRoot, bridgeId),
        bridgeExec(TICKETS_CMD, repoRoot, bridgeId),
      ]);
      if (identityRef.current !== key) return; // stale — factory changed/unmounted
      if (seq <= lastAppliedSeqRef.current) return; // a newer poll already applied
      lastAppliedSeqRef.current = seq;
      let failedMessage: string | null = null;
      let failedRes: typeof stagesRes | null = null;
      for (const res of [stagesRes, ticketsRes]) {
        const message = execFailure(res, "factory query failed");
        if (message !== null) {
          failedMessage = message;
          failedRes = res;
          break;
        }
      }
      if (failedRes !== null && failedMessage !== null) {
        const combinedText = `${failedRes.stderr ?? ""}\n${failedRes.stdout ?? ""}`;
        if (SQLITE_TRANSIENT_RE.test(combinedText)) {
          transientFailureCountRef.current += 1;
          if (transientFailureCountRef.current >= TRANSIENT_FAILURE_THRESHOLD) {
            setError(failedMessage);
          }
          // else: stay quiet — snapshot is already retained, previous error
          // state (if any) is left as-is; a lock this short will likely
          // clear by the next poll.
        } else {
          transientFailureCountRef.current = 0;
          setError(failedMessage);
        }
      } else {
        transientFailureCountRef.current = 0;
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
      if (seq <= lastAppliedSeqRef.current) return; // a newer poll already applied
      lastAppliedSeqRef.current = seq;
      const message = shortMessage(err);
      if (SQLITE_TRANSIENT_RE.test(message)) {
        transientFailureCountRef.current += 1;
        if (transientFailureCountRef.current >= TRANSIENT_FAILURE_THRESHOLD) {
          setError(message);
        }
      } else {
        transientFailureCountRef.current = 0;
        setError(message);
      }
    } finally {
      if (identityRef.current === key) setLoading(false);
    }
  }, [bridgeExec, bridgeId, identityKey, repoRoot]);

  useEffect(() => {
    identityRef.current = identityKey;
    transientFailureCountRef.current = 0;
    // In-flight polls from the previous identity are already discarded by the
    // identity guard; realign the applied watermark for the new identity.
    lastAppliedSeqRef.current = pollSeqRef.current;
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
    // Scheduled ticks skip while the tab is hidden; a visibilitychange back to
    // visible triggers an immediate catch-up poll. Manual refresh() bypasses
    // this by calling doPoll directly.
    timerRef.current = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void doPoll();
    }, pollMs);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void doPoll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
        if (document.visibilityState !== "visible") return;
        void doPoll();
      }, pollMs);
    }
    // Manual refresh always polls, regardless of visibility.
    void doPoll();
  }, [doPoll, pollMs]);

  const showTicket = useCallback(
    async (id: number): Promise<TicketDetail> => {
      if (repoRoot === null || bridgeId === null) {
        throw new Error("no factory selected");
      }
      const res = await bridgeExec(showTicketCmd(id), repoRoot, bridgeId);
      const failure = execFailure(res, "fts show failed");
      if (failure !== null) throw new Error(failure);
      try {
        return JSON.parse(res.stdout) as TicketDetail;
      } catch {
        throw new Error(trimmedStderr(res.stderr) || "fts show failed");
      }
    },
    [bridgeExec, bridgeId, repoRoot],
  );

  const listTicketArtifacts = useCallback(
    async (folderPath: string): Promise<TicketArtifactFile[]> => {
      if (repoRoot === null || bridgeId === null) {
        throw new Error("no factory selected");
      }
      const res = await bridgeExec(
        listTicketArtifactsCmd(folderPath),
        repoRoot,
        bridgeId,
      );
      const failure = execFailure(res, "failed to list ticket artifacts");
      if (failure !== null) throw new Error(failure);
      return parseTicketArtifactFiles(folderPath, res.stdout);
    },
    [bridgeExec, bridgeId, repoRoot],
  );

  const readTicketArtifact = useCallback(
    async (folderPath: string, relPath: string): Promise<string> => {
      if (repoRoot === null || bridgeId === null) {
        throw new Error("no factory selected");
      }
      const res = await bridgeExec(
        readTicketArtifactCmd(folderPath, relPath),
        repoRoot,
        bridgeId,
      );
      const failure = execFailure(res, "failed to read ticket artifact");
      if (failure !== null) throw new Error(failure);
      return res.stdout;
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
      const failure = execFailure(res, "failed to read skill");
      if (failure !== null) throw new Error(failure);
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
      const failure = execFailure(res, "failed to write skill");
      if (failure !== null) throw new Error(failure);
    },
    [bridgeExec, bridgeId, repoRoot],
  );

  const createTicket = useCallback(
    async (input: NewTicketInput): Promise<number> => {
      if (repoRoot === null || bridgeId === null) {
        throw new Error("no factory selected");
      }
      const title = input.title.trim();
      if (!title) throw new Error("title required");
      if (!input.stage) throw new Error("stage required");
      const folder = `.ffactory/tickets/${slugify(title)}-${Date.now().toString(36)}`;
      const res = await bridgeExec(
        createTicketCmd({ ...input, title }, folder),
        repoRoot,
        bridgeId,
      );
      const failure = execFailure(res, "fts create failed");
      if (failure !== null) throw new Error(failure);
      const stdout = res.stdout.trim();
      const match = /\d+/.exec(stdout);
      if (!match) {
        throw new Error(
          `could not parse ticket id from: ${stdout.slice(0, 120)}`,
        );
      }
      const id = Number.parseInt(match[0], 10);
      refresh();
      return id;
    },
    [bridgeExec, bridgeId, refresh, repoRoot],
  );

  return {
    snapshot,
    error,
    loading,
    refresh,
    showTicket,
    listTicketArtifacts,
    readTicketArtifact,
    listSkills,
    readSkill,
    writeSkill,
    createTicket,
  };
}
