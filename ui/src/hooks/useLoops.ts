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
  getLoopRuns: (bridgeId: string, loopId: string) => Promise<LoopRunRecord[]>;
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

    loopsSub.subscribe();
    loopsSubRef.current = loopsSub;

    return () => {
      loopsSub.removeAllListeners();
      loopsSub.unsubscribe();
      client.removeSubscription(loopsSub);
      loopsSubRef.current = null;
    };
  }, [client, userId]);

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

  // Secondary/CLI-parity path (§2c): loop state is delivered push-first over
  // loops:updates, so this merges by id rather than replacing the list, and is
  // only needed for an explicit manual "refresh" affordance. bridgeId is omitted
  // so EVERY connected bridge answers; sendCommandCollect gathers all replies
  // within its window and each responder's loops are merged (a single-shot
  // sendCommand would keep only the fastest bridge's loops).
  const refreshLoops = useCallback((): Promise<void> => {
    if (!userId) return Promise.resolve();

    const payload: ListLoopsPayload = {};
    const command: Command = { type: "list_loops", payload, requestId: uuidv4() };

    return sendCommandCollect(command).then((responses) => {
      const incoming: Loop[] = [];
      for (const resp of responses) {
        if (!resp.success || !resp.data) continue;
        const data = resp.data as { loops?: Loop[] };
        if (Array.isArray(data.loops)) incoming.push(...data.loops);
      }
      if (incoming.length === 0) return;
      setLoops((prev) => {
        const merged = new Map(prev.map((l) => [l.id, l]));
        for (const loop of incoming) merged.set(loop.id, loop);
        return Array.from(merged.values());
      });
    });
  }, [userId, sendCommandCollect]);

  const getLoopRuns = useCallback(
    (bridgeId: string, loopId: string): Promise<LoopRunRecord[]> => {
      return new Promise<LoopRunRecord[]>((resolve, reject) => {
        if (!userId) {
          reject(new Error("Not connected"));
          return;
        }

        const payload: GetLoopRunsPayload = { bridgeId, loopId };
        const command: Command = { type: "get_loop_runs", payload, requestId: uuidv4() };

        sendCommand(command)
          .then((resp) => {
            if (!resp.success) {
              reject(new Error(resp.error ?? "get_loop_runs failed"));
              return;
            }
            const data = resp.data as { runs?: LoopRunRecord[] } | undefined;
            resolve(data?.runs ?? []);
          })
          .catch(reject);
      });
    },
    [userId, sendCommand]
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
