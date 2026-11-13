"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Command, CommandResponse } from "@/types";
import { parseModelRoutingSnapshot, parseSetModelRoutingResult } from "@/lib/model-routing";
import type { GetModelRoutingPayload, ModelRoutingConfig, ModelRoutingSnapshot, SetModelRoutingPayload } from "../../../bridge/src/quota/types";

type Send = (command: Command) => Promise<CommandResponse>;
export type ModelRoutingStatus = "idle" | "loading" | "ready" | "error" | "unsupported";
/** `invalidFileBlocked`: the last save wrote nothing because the stored routing file is invalid and replacing it was not confirmed. */
export type ModelRoutingView = { status: ModelRoutingStatus; snapshot: ModelRoutingSnapshot | null; error: string | null; saving: boolean; invalidFileBlocked: boolean };
export type ModelRoutingSaveOutcome = { saved: true } | { saved: false; errors: string[]; invalidFileBlocked?: true };
export type ModelRoutingSaveOptions = { overwriteInvalid: boolean };
export const MODEL_ROUTING_INVALID_FILE_MESSAGE = "The routing file on this bridge is invalid. Confirm replacing it, then save again.";

export const MODEL_ROUTING_UNSUPPORTED_MESSAGE = "This bridge needs to be updated to support model routing.";
const empty = (): ModelRoutingView => ({ status: "idle", snapshot: null, error: null, saving: false, invalidFileBlocked: false });
/** Exact wording of the bridge's generic failure for a command it does not know (bridge/src/command-rpc.ts default case). */
const unknownCommand = (response: CommandResponse, type: Command["type"]) => !response.success && response.error === `Unknown command type: ${type}`;
const code = (response: CommandResponse) => response.data && typeof response.data === "object" && "code" in response.data ? (response.data as { code?: unknown }).code : undefined;
const failure = (response: CommandResponse, fallback: string) => code(response) === "permission_denied" || response.error === "permission_denied" ? "This device does not have control permission for this computer."
  : typeof response.error === "string" && response.error.trim() ? response.error.trim().slice(0, 500) : fallback;
const thrown = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

/** Per-bridge read/save of the model-routing config; a newer read for the same bridge supersedes older replies. */
export class ModelRoutingController {
  private values = new Map<string, ModelRoutingView>();
  private reads = new Map<string, number>();
  private disposed = false;
  constructor(private readonly send: Send, private readonly changed: () => void, private readonly uuid: () => string = () => crypto.randomUUID()) {}
  get(bridgeId: string): ModelRoutingView { return this.values.get(bridgeId) ?? empty(); }
  private put(bridgeId: string, patch: Partial<ModelRoutingView>) { if (!this.disposed) { this.values.set(bridgeId, { ...this.get(bridgeId), ...patch }); this.changed(); } }
  dispose() { this.disposed = true; }
  activate() { this.disposed = false; }

  async load(bridgeId: string, refresh = false): Promise<void> {
    if (this.disposed) return;
    const generation = (this.reads.get(bridgeId) ?? 0) + 1;
    this.reads.set(bridgeId, generation);
    this.put(bridgeId, { status: "loading", error: null });
    const payload = { bridgeId, ...(refresh ? { refresh: true } : {}) } satisfies GetModelRoutingPayload & { bridgeId: string };
    try {
      const response = await this.send({ type: "get_model_routing", requestId: this.uuid(), payload });
      if (this.reads.get(bridgeId) !== generation) return;
      if (unknownCommand(response, "get_model_routing")) { this.put(bridgeId, { status: "unsupported", error: MODEL_ROUTING_UNSUPPORTED_MESSAGE }); return; }
      if (!response.success) { this.put(bridgeId, { status: "error", error: failure(response, "Could not read model routing from this bridge.") }); return; }
      const snapshot = parseModelRoutingSnapshot(response.data);
      if (!snapshot) { this.put(bridgeId, { status: "error", error: "The bridge sent a model routing reply this dashboard does not understand." }); return; }
      this.put(bridgeId, { status: "ready", snapshot, error: null });
    } catch (error) {
      if (this.reads.get(bridgeId) === generation) this.put(bridgeId, { status: "error", error: thrown(error, "Could not read model routing from this bridge.") });
    }
  }

  /** `overwriteInvalid` is sent only when true: it lets the bridge replace a stored routing file that is invalid. */
  async save(bridgeId: string, config: ModelRoutingConfig, options?: ModelRoutingSaveOptions): Promise<ModelRoutingSaveOutcome> {
    if (this.disposed) return { saved: false, errors: ["The dialog was closed before saving."] };
    if (this.get(bridgeId).saving) return { saved: false, errors: ["A save is already in progress."] };
    this.put(bridgeId, { saving: true, invalidFileBlocked: false });
    const payload = { bridgeId, config, ...(options?.overwriteInvalid === true ? { overwriteInvalid: true } : {}) } satisfies SetModelRoutingPayload & { bridgeId: string };
    let outcome: ModelRoutingSaveOutcome;
    try {
      const response = await this.send({ type: "set_model_routing", requestId: this.uuid(), payload });
      if (unknownCommand(response, "set_model_routing")) outcome = { saved: false, errors: [MODEL_ROUTING_UNSUPPORTED_MESSAGE] };
      else if (!response.success) outcome = { saved: false, errors: [failure(response, "The bridge could not save model routing.")] };
      else {
        const result = parseSetModelRoutingResult(response.data);
        outcome = !result ? { saved: false, errors: ["The bridge sent a save reply this dashboard does not understand."] }
          : result.saved ? { saved: true }
          : result.invalidFileBlocked ? { saved: false, errors: result.errors.length ? result.errors : [MODEL_ROUTING_INVALID_FILE_MESSAGE], invalidFileBlocked: true }
          : { saved: false, errors: result.errors.length ? result.errors : ["The bridge rejected the routing config."] };
      }
    } catch (error) {
      outcome = { saved: false, errors: [thrown(error, "The bridge could not save model routing.")] };
    }
    this.put(bridgeId, { saving: false, invalidFileBlocked: !outcome.saved && outcome.invalidFileBlocked === true });
    if (outcome.saved) await this.load(bridgeId);
    return outcome;
  }
}

export function useModelRouting(send: Send) {
  const [, render] = useState(0);
  const sendRef = useRef(send);
  sendRef.current = send;
  const controller = useMemo(() => new ModelRoutingController(command => sendRef.current(command), () => render(n => n + 1)), []);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  return controller;
}
