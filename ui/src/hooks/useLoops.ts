"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Centrifuge, Subscription } from "centrifuge";
import { v4 as uuidv4 } from "uuid";
import {
  Loop,
  LoopDraft,
  LoopRunRecord,
  Command,
  CommandResponse,
  CreateLoopPayload,
  ListLoopsPayload,
  UpdateLoopPayload,
  DeleteLoopPayload,
  RunLoopNowPayload,
  GetLoopRunsPayload,
} from "@/types";

interface LoopUpdateMessage {
  type: "loop_update";
  loop: Loop;
  timestamp: string;
}

interface LoopRemovedMessage {
  type: "loop_removed";
  loopId: string;
  timestamp: string;
}

type LoopChannelMessage = LoopUpdateMessage | LoopRemovedMessage;

export interface RunLoopNowResult {
  fired: boolean;
  reason?: "not_found" | "overlap";
}

interface UseLoopsResult {
  loops: Loop[];
  createLoop: (draft: LoopDraft) => Promise<Loop>;
  updateLoop: (bridgeId: string, loopId: string, patch: Partial<LoopDraft>) => Promise<Loop>;
  deleteLoop: (bridgeId: string, loopId: string) => Promise<boolean>;
  runLoopNow: (bridgeId: string, loopId: string) => Promise<RunLoopNowResult>;
  refreshLoops: () => Promise<void>;
  getLoopRuns: (bridgeId: string | undefined, loopId: string) => Promise<LoopRunRecord[]>;
}

/**
 * Owns ONLY the `loops:updates#{userId}` subscription (live push state,
 * mirroring useSessions' sessionsSub). RPC (create/update/delete/run-now/
 * list) reuses the existing `commands:rpc#{userId}` channel that useSessions
 * already owns — this hook never calls client.newSubscription for it and
 * instead issues every command through the injected sendCommand, so the two
 * hooks never fight over the same subscription (centrifuge-js throws on a
 * duplicate newSubscription(channel) call).
 */
export function useLoops(
  client: Centrifuge | null,
  userId: string | null,
  sendCommand: (command: Command) => Promise<CommandResponse>,
  sendCommandCollect: (command: Command, windowMs?: number) => Promise<CommandResponse[]>
): UseLoopsResult {
  const [loops, setLoops] = useState<Loop[]>([]);
  const loopsSubRef = useRef<Subscription | null>(null);

  // Secondary/CLI-parity path (§2c): loop state is delivered push-first over
  // loops:updates, but refreshLoops itself is the authoritative snapshot for a
  // manual/soft refresh — it REPLACES loops state with only what the freshly
  // collected list_loops responses report, so a loop deleted on the bridge
  // (and thus absent from the fresh response) is dropped from UI state instead
  // of lingering from a stale merge. bridgeId is omitted so EVERY connected
  // bridge answers; sendCommandCollect gathers all replies within its window
  // and each responder's loops are unioned into the new snapshot (a single-
  // shot sendCommand would keep only the fastest bridge's loops). If NO bridge
  // responds successfully at all (e.g. a transient connectivity blip), the
  // existing state is left untouched rather than wiped to empty.
  const refreshLoops = useCallback((): Promise<void> => {
    if (!userId) return Promise.resolve();

    const payload: ListLoopsPayload = {};
    const command: Command = { type: "list_loops", payload, requestId: uuidv4() };

    return sendCommandCollect(command).then((responses) => {
      const incoming: Loop[] = [];
      let sawSuccess = false;
      for (const resp of responses) {
        if (!resp.success || !resp.data) continue;
        sawSuccess = true;
        const data = resp.data as { loops?: Loop[] };
        if (Array.isArray(data.loops)) incoming.push(...data.loops);
      }
      if (!sawSuccess) return;
      const byId = new Map<string, Loop>();
      for (const loop of incoming) byId.set(loop.id, loop);
      setLoops(Array.from(byId.values()));
    });
  }, [userId, sendCommandCollect]);

  useEffect(() => {
    if (!client || !userId) return;

    const loopsChannel = `loops:updates#${userId}`;

    const existing = client.getSubscription(loopsChannel);
    if (existing) {
      existing.removeAllListeners();
      existing.unsubscribe();
      client.removeSubscription(existing);
    }

    const loopsSub = client.newSubscription(loopsChannel);

    loopsSub.on("publication", (ctx) => {
      const data = ctx.data as LoopChannelMessage;

      if (data.type === "loop_update" && data.loop) {
        setLoops((prev) => {
          const idx = prev.findIndex((l) => l.id === data.loop.id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = data.loop;
            return updated;
          }
          return [data.loop, ...prev];
        });
      } else if (data.type === "loop_removed" && data.loopId) {
        setLoops((prev) => prev.filter((l) => l.id !== data.loopId));
      }
    });

    // Request the loop list on every (re)subscribe — mirroring useSessions'
    // list_sessions — otherwise a fresh page load shows no loops until the next
    // run publishes a loop_update. The commands RPC sub (owned by useSessions)
    // may ack a beat later than this sub, so one delayed retry covers that race.
    loopsSub.on("subscribed", () => {
      void refreshLoops().catch(() => {
        setTimeout(() => void refreshLoops().catch(() => undefined), 2000);
      });
    });

    loopsSub.subscribe();
    loopsSubRef.current = loopsSub;

    return () => {
      loopsSub.removeAllListeners();
      loopsSub.unsubscribe();
      client.removeSubscription(loopsSub);
      loopsSubRef.current = null;
    };
  }, [client, userId, refreshLoops]);

  const createLoop = useCallback(
    (draft: LoopDraft): Promise<Loop> => {
      return new Promise<Loop>((resolve, reject) => {
        if (!userId) {
          reject(new Error("Not connected"));
          return;
        }

        const payload: CreateLoopPayload = { ...draft };
        const command: Command = { type: "create_loop", payload, requestId: uuidv4() };

        sendCommand(command)
          .then((resp) => {
            if (!resp.success) {
              reject(new Error(resp.error ?? "create_loop failed"));
              return;
            }
            const data = resp.data as { loop?: Loop } | undefined;
            if (!data?.loop) {
              reject(new Error("create_loop returned no loop"));
              return;
            }
            resolve(data.loop);
          })
          .catch(reject);
      });
    },
    [userId, sendCommand]
  );

  const updateLoop = useCallback(
    (bridgeId: string, loopId: string, patch: Partial<LoopDraft>): Promise<Loop> => {
      return new Promise<Loop>((resolve, reject) => {
        if (!userId) {
          reject(new Error("Not connected"));
          return;
        }

        const payload: UpdateLoopPayload = { bridgeId, loopId, patch };
        const command: Command = { type: "update_loop", payload, requestId: uuidv4() };

        sendCommand(command)
          .then((resp) => {
            if (!resp.success) {
              reject(new Error(resp.error ?? "update_loop failed"));
              return;
            }
            const data = resp.data as { loop?: Loop } | undefined;
            if (!data?.loop) {
              reject(new Error("update_loop returned no loop"));
              return;
            }
            resolve(data.loop);
          })
          .catch(reject);
      });
    },
    [userId, sendCommand]
  );

  const deleteLoop = useCallback(
    (bridgeId: string, loopId: string): Promise<boolean> => {
      return new Promise<boolean>((resolve, reject) => {
        if (!userId) {
          reject(new Error("Not connected"));
          return;
        }

        // Optimistic removal mirrors useSessions.removeSession: drop the row
        // immediately instead of waiting on the round trip. The authoritative
        // loop_removed broadcast (or a later loops:updates push) confirms it.
        // Capture the removed row so a FAILED delete can restore it — otherwise
        // the loop silently vanishes from the UI while still alive on the bridge.
        let removedLoop: Loop | undefined;
        setLoops((prev) => {
          removedLoop = prev.find((l) => l.id === loopId);
          return prev.filter((l) => l.id !== loopId);
        });
        const restore = (): void => {
          setLoops((prev) => (!removedLoop || prev.some((l) => l.id === loopId) ? prev : [removedLoop, ...prev]));
        };

        const payload: DeleteLoopPayload = { bridgeId, loopId };
        const command: Command = { type: "delete_loop", payload, requestId: uuidv4() };

        sendCommand(command)
          .then((resp) => {
            if (!resp.success) {
              restore();
              reject(new Error(resp.error ?? "delete_loop failed"));
              return;
            }
            const data = resp.data as { removed?: boolean } | undefined;
            resolve(data?.removed ?? true);
          })
          .catch((err) => {
            restore();
            reject(err);
          });
      });
    },
    [userId, sendCommand]
  );

  const runLoopNow = useCallback(
    (bridgeId: string, loopId: string): Promise<RunLoopNowResult> => {
      return new Promise<RunLoopNowResult>((resolve, reject) => {
        if (!userId) {
          reject(new Error("Not connected"));
          return;
        }

        const payload: RunLoopNowPayload = { bridgeId, loopId };
        const command: Command = { type: "run_loop_now", payload, requestId: uuidv4() };

        sendCommand(command)
          .then((resp) => {
            if (!resp.success) {
              reject(new Error(resp.error ?? "run_loop_now failed"));
              return;
            }
            const data = resp.data as RunLoopNowResult | undefined;
            resolve(data ?? { fired: false });
          })
          .catch(reject);
      });
    },
    [userId, sendCommand]
  );

  const getLoopRuns = useCallback(
    (bridgeId: string | undefined, loopId: string): Promise<LoopRunRecord[]> => {
      return new Promise<LoopRunRecord[]>((resolve, reject) => {
        if (!userId) {
          reject(new Error("Not connected"));
          return;
        }

        const payload: GetLoopRunsPayload = bridgeId ? { bridgeId, loopId } : { loopId };
        const command: Command = { type: "get_loop_runs", payload, requestId: uuidv4() };

        sendCommandCollect(command, 1500)
          .then((responses) => {
            const successfulRuns: LoopRunRecord[] = [];
            let firstError: string | undefined;
            for (const resp of responses) {
              if (!resp.success) {
                firstError ??= resp.error;
                continue;
              }
              const data = resp.data as { runs?: LoopRunRecord[] } | undefined;
              if (Array.isArray(data?.runs)) successfulRuns.push(...data.runs);
            }

            if (successfulRuns.length > 0) {
              const byId = new Map<string, LoopRunRecord>();
              for (const run of successfulRuns) byId.set(run.id, run);
              resolve(
                Array.from(byId.values()).sort(
                  (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
                )
              );
              return;
            }
            if (responses.some((resp) => resp.success)) {
              resolve([]);
              return;
            }
            reject(new Error(firstError ?? "No bridge responded with loop runs"));
          })
          .catch(reject);
      });
    },
    [userId, sendCommandCollect]
  );

  return {
    loops,
    createLoop,
    updateLoop,
    deleteLoop,
    runLoopNow,
    refreshLoops,
    getLoopRuns,
  };
}
