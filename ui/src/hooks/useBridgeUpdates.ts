"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Command, CommandResponse } from "@/types";
import type { BridgeUpdateStatus, BridgeUpdateAccepted, BridgeUpdateOperation, GetBridgeUpdatePayload, UpdateBridgePayload } from "../../../bridge/src/update-protocol";

type Send = (command: Command) => Promise<CommandResponse>;
export type UpdateView = { status: BridgeUpdateStatus | null; loading: boolean; message: string | null; operation: { id: string; target: string } | null; complete: boolean };
const empty = (): UpdateView => ({ status: null, loading: false, message: null, operation: null, complete: false });
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const version = (v: unknown): v is string => typeof v === "string" && v.length <= 100 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
function atLeast(current: string, latest: string): boolean {
  const left = current.split(".").map(BigInt), right = latest.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return true;
}
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const date = (v: unknown) => typeof v === "string" && v.length < 80 && Number.isFinite(Date.parse(v));
const phases = ["staging", "prepared", "restarting", "succeeded", "failed"];
const blocks = ["permission_denied", "not_enabled", "unsupported_launch", "busy", "in_progress", "release_unavailable", "node_incompatible"];
const rejected = new Set(["invalid_update_request", "permission_denied", "updates_disabled", "bridge_busy", "update_in_progress", "release_unavailable", "update_target_changed", "node_incompatible"]);
const responseCode = (response: CommandResponse) => obj(response.data) && typeof response.data.code === "string" ? response.data.code : "";

function parseOperation(value: unknown): BridgeUpdateOperation | null | undefined {
  if (value === null) return null;
  if (!obj(value) || !id(value.id) || !version(value.targetVersion) || typeof value.phase !== "string" || !phases.includes(value.phase) || !date(value.startedAt) || !date(value.updatedAt) || !(value.error === null || typeof value.error === "string" && value.error.length <= 500)) return undefined;
  return value as unknown as BridgeUpdateOperation;
}
export function parseBridgeUpdateStatus(value: unknown, bridgeId: string): BridgeUpdateStatus | null {
  if (!obj(value) || value.schema !== 1 || value.bridgeId !== bridgeId || typeof value.currentVersion !== "string" || !/^[A-Za-z0-9.+_-]{1,100}$/.test(value.currentVersion)
    || !(value.latestVersion === null || version(value.latestVersion)) || !(value.checkedAt === null || date(value.checkedAt))
    || !(value.currentNodeVersion === undefined || version(value.currentNodeVersion))
    || !(value.requiredNodeEngine === undefined || typeof value.requiredNodeEngine === "string" && value.requiredNodeEngine.length <= 256 && value.requiredNodeEngine.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(value.requiredNodeEngine))
    || !["current", "available", "unknown"].includes(String(value.availability)) || typeof value.canUpdate !== "boolean"
    || !(value.blockedReason === null || typeof value.blockedReason === "string" && blocks.includes(value.blockedReason))
    || typeof value.manualCommand !== "string" || value.manualCommand.length > 200 || parseOperation(value.operation) === undefined) return null;
  if (value.availability === "current" && (!version(value.currentVersion) || !version(value.latestVersion) || !atLeast(value.currentVersion, value.latestVersion))) return null;
  if (value.availability === "available" && value.latestVersion === null) return null;
  if (value.canUpdate && value.blockedReason !== null) return null;
  return value as unknown as BridgeUpdateStatus;
}
function accepted(value: unknown, bridgeId: string, operationId: string, target: string): BridgeUpdateAccepted | null {
  if (!obj(value) || value.bridgeId !== bridgeId) return null;
  const op = parseOperation(value.operation);
  return op && op.id === operationId && op.targetVersion === target ? { bridgeId, operation: op } : null;
}

/** Owns request coalescing, generation fences and one-shot mutation reconciliation. */
export class BridgeUpdatesController {
  private values = new Map<string, UpdateView>();
  private active = new Set<string>();
  private epochs = new Map<string, number>();
  private reads = new Map<string, Promise<void>>();
  private disposed = false;
  constructor(private readonly send: Send, private readonly changed: () => void, private readonly uuid: () => string = () => crypto.randomUUID()) {}
  get(id: string): UpdateView { return this.values.get(id) ?? empty(); }
  private put(id: string, next: UpdateView) { if (!this.disposed) { this.values.set(id, next); this.changed(); } }
  setActive(ids: readonly string[]) {
    const next = new Set(ids);
    for (const id of this.active) if (!next.has(id)) {
      this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1); this.reads.delete(id);
      const old = this.get(id); this.put(id, { ...old, status: null, loading: false, message: old.operation ? "Reconnecting to check update status." : "Computer offline or not approved." });
    }
    for (const id of next) if (!this.active.has(id)) this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.active = next;
  }
  dispose() { this.disposed = true; this.active.clear(); this.reads.clear(); }
  activate() { this.disposed = false; }
  async check(bridgeId: string, refresh = false): Promise<void> {
    if (this.disposed || !this.active.has(bridgeId)) return;
    const pending = this.reads.get(bridgeId); if (pending) return pending;
    const epoch = this.epochs.get(bridgeId);
    this.put(bridgeId, { ...this.get(bridgeId), loading: true });
    const payload: GetBridgeUpdatePayload = { bridgeId, ...(refresh ? { refresh: true } : {}) };
    const request = (async () => {
      try {
        const response = await this.send({ type: "get_bridge_update", requestId: this.uuid(), payload });
        if (this.disposed || !this.active.has(bridgeId) || this.epochs.get(bridgeId) !== epoch) return;
        const status = response.success ? parseBridgeUpdateStatus(response.data, bridgeId) : null;
        if (!status) { this.put(bridgeId, { ...this.get(bridgeId), status: null, loading: false, message: responseCode(response) === "permission_denied" ? "This device cannot read update information for this computer." : "Update information unavailable. This bridge may need a manual upgrade." }); return; }
        const prior = this.get(bridgeId);
        const op = prior.operation;
        const match = op && status.operation?.id === op.id && status.operation.targetVersion === op.target;
        const complete = Boolean(match && status.operation?.phase === "succeeded" && status.currentVersion === op?.target);
        const failed = Boolean(match && status.operation?.phase === "failed");
        this.put(bridgeId, { status, loading: false, operation: complete || failed ? null : op, complete,
          message: complete ? "Update completed and the computer reconnected." : failed ? "Update failed. Follow the manual setup instructions below." : op ? "Checking the update and reconnection." : null });
      } catch {
        if (!this.disposed && this.active.has(bridgeId) && this.epochs.get(bridgeId) === epoch) this.put(bridgeId, { ...this.get(bridgeId), status: null, loading: false, message: "Update information unavailable. This bridge may need a manual upgrade." });
      }
    })();
    this.reads.set(bridgeId, request);
    try { await request; } finally { if (this.reads.get(bridgeId) === request) this.reads.delete(bridgeId); }
  }
  async update(bridgeId: string): Promise<void> {
    const view = this.get(bridgeId); const status = view.status;
    if (!this.active.has(bridgeId) || view.operation || !status?.canUpdate || status.blockedReason !== null || status.availability !== "available" || !status.latestVersion) return;
    const operation = { id: this.uuid(), target: status.latestVersion };
    const epoch = this.epochs.get(bridgeId);
    this.put(bridgeId, { ...view, operation, complete: false, message: "Requesting update…" });
    const payload: UpdateBridgePayload = { bridgeId, targetVersion: operation.target, operationId: operation.id };
    try {
      const response = await this.send({ type: "update_bridge", requestId: this.uuid(), payload });
      if (this.disposed || this.epochs.get(bridgeId) !== epoch) return;
      if (response.success && accepted(response.data, bridgeId, operation.id, operation.target)) {
        this.put(bridgeId, { ...this.get(bridgeId), operation, message: "Update requested. Waiting for the computer to reconnect." });
      } else if (!response.success && rejected.has(responseCode(response))) {
        this.put(bridgeId, { ...this.get(bridgeId), operation: null, message: responseCode(response) === "permission_denied" ? "This device does not have control permission for this computer." : responseCode(response) === "node_incompatible" ? "Upgrade Node on this computer before updating the bridge." : "Update could not be started. Check the status and manual instructions." });
      } else this.put(bridgeId, { ...this.get(bridgeId), operation, message: "Update outcome is uncertain. Checking status before any retry." });
    } catch {
      if (!this.disposed && this.epochs.get(bridgeId) === epoch) this.put(bridgeId, { ...this.get(bridgeId), operation, message: "Update outcome is uncertain. Checking status before any retry." });
    }
    if (this.get(bridgeId).operation) void this.check(bridgeId);
  }
}

export function useBridgeUpdates(send: Send, activeIds: readonly string[]) {
  const [, render] = useState(0);
  const sendRef = useRef(send);
  sendRef.current = send;
  const controller = useMemo(() => new BridgeUpdatesController(command => sendRef.current(command), () => render(n => n + 1)), []);
  const key = [...activeIds].sort().join("\0");
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useEffect(() => {
    const ids = key ? key.split("\0") : [];
    controller.setActive(ids); ids.forEach(id => void controller.check(id));
    const periodic = setInterval(() => ids.forEach(id => void controller.check(id)), 60_000);
    const active = setInterval(() => ids.forEach(id => { if (controller.get(id).operation) void controller.check(id); }), 3_000);
    const visible = () => { if (document.visibilityState === "visible") ids.forEach(id => void controller.check(id)); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(periodic); clearInterval(active); document.removeEventListener("visibilitychange", visible); };
  }, [controller, key]);
  return controller;
}
