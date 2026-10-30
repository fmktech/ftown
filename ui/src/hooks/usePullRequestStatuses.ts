"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { parsePullRequestUrl } from "@/lib/pull-request-url";
import type { Command, CommandResponse, Session } from "@/types";
import type { PullRequestStatus } from "../../../bridge/src/pull-request-status-protocol";

type Send = (command: Command) => Promise<CommandResponse>;
type Candidate = { bridgeId: string; sessionId: string; url: string };
const minimumRefresh = 60_000;
const failureCooldown = 300_000;
const maxTimerDelay = 2_147_483_647;
function expiresAt(status: PullRequestStatus): number {
  if (!status.checkedAt || status.state === "merged") return Infinity;
  const ttl = status.state === "closed" ? 3_600_000 : status.state === "passed" || status.state === "failed" ? 300_000 : 60_000;
  return Date.parse(status.checkedAt) + ttl;
}
const states = new Set(["in_progress", "failed", "passed", "merged", "closed", "unknown"]);
const reasons = new Set(["no_checks", "unavailable", "rate_limited", "unauthenticated"]);
const keyFor = (url: string) => parsePullRequestUrl(url)?.url.toLowerCase();
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ownerKey = (bridgeId: string, url: string) => JSON.stringify([bridgeId, url]);

/** Linked owners retain provenance even when their bridge is temporarily offline. */
function linkedCandidates(sessions: readonly Pick<Session, "id" | "bridgeId" | "pullRequestUrl">[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const s of sessions) {
    const url = keyFor(s.pullRequestUrl ?? "");
    if (url && /^[A-Za-z0-9_-]{1,200}$/.test(s.id)) candidates.push({ bridgeId: s.bridgeId, sessionId: s.id, url });
  }
  return candidates.sort((a, b) => a.bridgeId.localeCompare(b.bridgeId) || a.sessionId.localeCompare(b.sessionId) || a.url.localeCompare(b.url));
}
/** Select one ready bridge for each PR; sorting makes the choice stable across renders. */
export function statusCandidates(sessions: readonly Pick<Session, "id" | "bridgeId" | "pullRequestUrl">[], readyIds: readonly string[]): Candidate[] {
  const ready = new Set(readyIds), seen = new Set<string>();
  return linkedCandidates(sessions).filter(c => ready.has(c.bridgeId) && !seen.has(c.url) && !!seen.add(c.url));
}

function parseStatus(value: unknown, allowed: Set<string>): PullRequestStatus | null {
  if (!object(value) || typeof value.url !== "string") return null;
  const url = keyFor(value.url);
  if (!url || !allowed.has(url) || typeof value.state !== "string" || !states.has(value.state) || typeof value.stale !== "boolean"
    || !(value.checkedAt === null || typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt)))
    || !(value.reason === undefined || typeof value.reason === "string" && reasons.has(value.reason))) return null;
  return { url, state: value.state as PullRequestStatus["state"], checkedAt: value.checkedAt as string | null, stale: value.stale, ...(value.reason ? { reason: value.reason as PullRequestStatus["reason"] } : {}) };
}

/** One scheduler per dashboard; per-bridge requests are coalesced and fenced on input changes. */
export class PullRequestStatusesController {
  private candidates: Candidate[] = [];
  private inputKey = "";
  private values = new Map<string, { bridgeId: string; status: PullRequestStatus }>();
  private due = new Map<string, number>();
  private notBefore = new Map<string, number>();
  private linkedOwners = new Set<string>();
  private pendingOwners = new Set<string>();
  private cursor = new Map<string, number>();
  private reads = new Set<string>();
  private generation = 0;
  private enabled = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private send: Send, private changed: () => void, private now: () => number = Date.now, private requestId: () => string = uuid) {}
  get(url: string): PullRequestStatus | undefined {
    const key = keyFor(url); const status = key ? this.values.get(key)?.status : undefined;
    return status && !status.stale && expiresAt(status) <= this.now() ? { ...status, stale: true } : status;
  }
  setInputs(candidates: Candidate[], enabled: boolean, linked: Candidate[] = candidates) {
    const inputKey = JSON.stringify([candidates, linked]);
    if (inputKey !== this.inputKey) {
      this.inputKey = inputKey; this.candidates = candidates; this.generation++;
      const owners = new Set(linked.map(c => ownerKey(c.bridgeId, c.url)));
      for (const owner of owners) if (!this.linkedOwners.has(owner)) this.pendingOwners.add(owner);
      for (const owner of this.pendingOwners) if (!owners.has(owner)) this.pendingOwners.delete(owner);
      this.linkedOwners = owners;
      const readyOwners = new Set(candidates.map(c => ownerKey(c.bridgeId, c.url)));
      let changed = false;
      for (const [url, value] of this.values) {
        const owner = ownerKey(value.bridgeId, url);
        if (!owners.has(owner)) { this.values.delete(url); changed = true; }
        else if (!readyOwners.has(owner) && value.status.state !== "merged" && !value.status.stale) {
          this.values.set(url, { ...value, status: { ...value.status, stale: true, reason: value.status.reason ?? "unavailable" } }); changed = true;
        }
      }
      if (changed) this.changed();
    }
    if (this.enabled !== enabled) {
      this.enabled = enabled; this.generation++;
      if (!enabled) {
        let changed = false;
        for (const [url, value] of this.values) if (value.status.state !== "merged" && !value.status.stale) {
          this.values.set(url, { ...value, status: { ...value.status, stale: true, reason: value.status.reason ?? "unavailable" } }); changed = true;
        }
        if (changed) this.changed();
      }
    }
    this.schedule();
  }
  dispose() { this.disposed = true; this.generation++; if (this.timer) clearTimeout(this.timer); }
  activate() { this.disposed = false; }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || !this.enabled) return;
    const bridges = [...new Set(this.candidates.filter(c => this.values.get(c.url)?.status.state !== "merged").map(c => c.bridgeId))];
    let next = Infinity;
    let aged = false;
    for (const [url, value] of this.values) {
      if (value.status.stale) continue;
      const expiry = expiresAt(value.status);
      if (expiry <= this.now()) {
        this.values.set(url, { ...value, status: { ...value.status, stale: true } }); aged = true;
      } else next = Math.min(next, expiry);
    }
    if (aged) this.changed();
    for (const bridge of bridges) {
      if (this.reads.has(bridge)) continue;
      const hard = this.notBefore.get(bridge) ?? 0;
      const hasPending = this.candidates.some(c => c.bridgeId === bridge && this.values.get(c.url)?.status.state !== "merged" && this.pendingOwners.has(ownerKey(c.bridgeId, c.url)));
      const due = hasPending ? hard : Math.max(hard, this.due.get(bridge) ?? 0);
      if (due <= this.now()) void this.read(bridge);
      else next = Math.min(next, due);
    }
    if (Number.isFinite(next)) this.timer = setTimeout(() => this.schedule(), Math.min(maxTimerDelay, Math.max(0, next - this.now())));
  }
  private async read(bridgeId: string) {
    const available = this.candidates.filter(c => c.bridgeId === bridgeId && this.values.get(c.url)?.status.state !== "merged");
    if (!available.length || this.reads.has(bridgeId)) return;
    const start = (this.cursor.get(bridgeId) ?? 0) % available.length;
    const batch = [...available.slice(start), ...available.slice(0, start)].slice(0, 100);
    this.cursor.set(bridgeId, (start + batch.length) % available.length);
    this.reads.add(bridgeId);
    for (const candidate of batch) this.pendingOwners.delete(ownerKey(candidate.bridgeId, candidate.url));
    const started = this.now(); this.notBefore.set(bridgeId, started + minimumRefresh); this.due.set(bridgeId, started + minimumRefresh);
    const generation = this.generation;
    const allowed = new Set(batch.map(c => c.url));
    try {
      const response = await this.send({ type: "get_pull_request_statuses", requestId: this.requestId(), payload: { bridgeId, sessionIds: batch.map(c => c.sessionId) } });
      if (this.disposed || generation !== this.generation) return;
      const data = response.data;
      if (!response.success || !object(data) || data.bridgeId !== bridgeId || !Array.isArray(data.statuses)
        || typeof data.nextRefreshAt !== "string" || !Number.isFinite(Date.parse(data.nextRefreshAt))) throw new Error("unavailable");
      this.due.set(bridgeId, Math.max(started + minimumRefresh, Date.parse(data.nextRefreshAt)));
      for (const item of data.statuses) {
        const status = parseStatus(item, allowed);
        if (status) this.values.set(status.url, { bridgeId, status });
      }
      this.changed();
    } catch {
      if (this.disposed || generation !== this.generation) return;
      const retry = this.now() + failureCooldown;
      this.notBefore.set(bridgeId, Math.max(this.notBefore.get(bridgeId) ?? 0, retry));
      this.due.set(bridgeId, retry);
      for (const url of allowed) {
        const existing = this.values.get(url);
        if (existing?.bridgeId === bridgeId) this.values.set(url, { bridgeId, status: { ...existing.status, stale: true, reason: "unavailable" } });
      }
      this.changed();
    } finally { this.reads.delete(bridgeId); this.schedule(); }
  }
}

export function usePullRequestStatuses(send: Send, sessions: readonly Pick<Session, "id" | "bridgeId" | "pullRequestUrl">[], readyIds: readonly string[], connected: boolean) {
  const [, render] = useState(0);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const sendRef = useRef(send); sendRef.current = send;
  const controller = useMemo(() => new PullRequestStatusesController(command => sendRef.current(command), () => render(n => n + 1)), []);
  const key = JSON.stringify([statusCandidates(sessions, readyIds), linkedCandidates(sessions)]);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useEffect(() => {
    const visibility = () => setVisible(document.visibilityState === "visible");
    const connectivity = () => setOnline(navigator.onLine);
    document.addEventListener("visibilitychange", visibility); window.addEventListener("online", connectivity); window.addEventListener("offline", connectivity);
    return () => { document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", connectivity); window.removeEventListener("offline", connectivity); };
  }, []);
  useEffect(() => { const [ready, linked] = JSON.parse(key) as [Candidate[], Candidate[]]; controller.setInputs(ready, connected && visible && online, linked); }, [controller, key, connected, visible, online]);
  return controller;
}
