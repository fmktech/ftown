"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SecurityEvent, SecurityPage } from "@security/protocol";
import { securityErrorMessage, type SecurityBridge, type SecurityCommandExecutor } from "./SecurityPanel";

interface Props {
  bridgeId: string;
  selectedBridge?: SecurityBridge;
  execute: SecurityCommandExecutor;
  gatewayAvailable: boolean;
}

const statuses: Record<SecurityEvent["status"], string> = {
  started: "In progress", succeeded: "Succeeded", rejected: "Rejected", failed: "Failed", unknown: "Outcome unknown",
};

function safeTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

function mergeEvents(previous: SecurityEvent[], incoming: SecurityEvent[]): SecurityEvent[] {
  const events = new Map(previous.map(event => [`${event.source}:${event.id}`, event]));
  for (const event of incoming) events.set(`${event.source}:${event.id}`, event);
  return [...events.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
}

export function SecurityActivity({ bridgeId, selectedBridge, execute, gatewayAvailable }: Props) {
  const [source, setSource] = useState<"gateway" | "bridge">(gatewayAvailable ? "gateway" : "bridge");
  const [page, setPage] = useState<SecurityPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const ready = selectedBridge?.security.status === "ready";
  const available = source === "gateway" ? gatewayAvailable : !!bridgeId && ready;

  const load = useCallback(async (cursor?: string) => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const request = ++generation.current;
    setLoading(true); setError(null);
    try {
      let result: SecurityPage;
      if (source === "gateway") {
        const query = new URLSearchParams({ limit: "50" });
        if (bridgeId) query.set("bridgeId", bridgeId);
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(`/api/security/activity?${query}`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          const code = body && typeof body === "object" && "code" in body ? String(body.code) : "audit_unavailable";
          throw { code };
        }
        result = await response.json() as SecurityPage;
      } else {
        result = await execute({ type: "security_activity", bridgeId, page: { ...(cursor ? { cursor } : {}), limit: 50 } });
      }
      if (controller.signal.aborted || request !== generation.current) return;
      setPage(previous => ({ ...result, events: cursor && !result.reset ? mergeEvents(previous?.events ?? [], result.events) : result.events }));
    } catch (failure) {
      if (!controller.signal.aborted && request === generation.current) setError(securityErrorMessage(failure));
    } finally {
      if (!controller.signal.aborted && request === generation.current) setLoading(false);
    }
  }, [bridgeId, execute, source]);

  useEffect(() => {
    active.current?.abort(); generation.current++; setPage(null); setError(null); setLoading(false);
    if (available) void load();
    return () => { active.current?.abort(); generation.current++; };
  }, [available, load]);

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-muted)]">Evidence source
        <select aria-label="Activity source" value={source} onChange={event => setSource(event.target.value as "gateway" | "bridge")}
          className="min-h-11 max-w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] px-3 text-sm text-[var(--text-primary)]">
          {gatewayAvailable && <option value="gateway">MCP gateway</option>}
          <option value="bridge">Bridge execution</option>
        </select>
      </label>
      <button type="button" className="btn-ghost min-h-11" disabled={loading || !available} onClick={() => void load()}>Refresh activity</button>
    </div>
    <p className="text-xs leading-relaxed text-[var(--text-muted)]">
      {source === "gateway" ? "Gateway records include authenticated MCP attempts, denied calls, and calls that never reach a bridge. This history is available while bridges are offline."
        : "Bridge records show authenticated operations received by this bridge. Compare their action IDs with gateway records to investigate delivery."}
      {" "}A timeout or unknown outcome does not prove an action was not executed.
    </p>
    {!available && <p role="status" className="rounded-md border border-[var(--border-muted)] p-4 text-sm text-[var(--text-secondary)]">
      {!bridgeId ? "Choose a bridge to inspect its execution log." : "Connect and approve this bridge to read its execution log. Gateway activity remains available separately."}
    </p>}
    {error && <div role="alert" className="rounded-md border border-[var(--status-error)] p-3 text-sm text-[var(--status-error)]">
      {error}{page && <span className="block text-xs text-[var(--text-muted)]">Previously loaded activity is still shown.</span>}
    </div>}
    {loading && <p role="status" className="text-sm text-[var(--text-muted)]">Loading security activity…</p>}
    {available && page?.events.length === 0 && <p className="rounded-md border border-[var(--border-muted)] p-6 text-sm text-[var(--text-muted)]">No MCP activity in the retained history for this selection.</p>}
    {page && page.events.length > 0 && <ol aria-label="MCP security activity" className="space-y-3">
      {page.events.map(event => <li key={`${event.source}:${event.id}`} className="rounded-lg border border-[var(--border-muted)] bg-[var(--bg-base)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 break-words text-sm font-semibold">{event.tool}{event.operation ? ` · ${event.operation}` : ""}</div>
          <span className={`shrink-0 rounded border px-2 py-1 text-xs ${event.status === "succeeded" ? "border-[var(--accent-dim)] text-[var(--accent)]" : event.status === "unknown" || event.status === "failed" ? "border-[var(--status-error)] text-[var(--status-error)]" : "border-[var(--border-muted)] text-[var(--text-muted)]"}`}>{statuses[event.status]}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
          <time dateTime={event.startedAt}>{safeTime(event.startedAt)}</time>
          <span>{event.source === "gateway" ? "Gateway evidence" : "Bridge evidence"}</span>
          <span>{event.mutating ? "Control action" : "Read action"}</span>
        </div>
        <dl className="mt-3 grid min-w-0 grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          <div><dt className="text-[var(--text-faint)]">Bridge</dt><dd className="break-all text-[var(--text-secondary)]">{event.bridgeId ?? "Fleet / no bridge reached"}</dd></div>
          <div><dt className="text-[var(--text-faint)]">Client</dt><dd className="break-all text-[var(--text-secondary)]">{event.clientId ?? event.endpointId ?? "Unavailable"}</dd></div>
          {event.sessionId && <div><dt className="text-[var(--text-faint)]">Session</dt><dd className="break-all text-[var(--text-secondary)]">{event.sessionId}</dd></div>}
          <div><dt className="text-[var(--text-faint)]">Action ID</dt><dd className="break-all font-mono text-[var(--text-secondary)]">{event.actionId}</dd></div>
        </dl>
        {event.status === "unknown" && <p className="mt-3 text-xs text-[var(--text-muted)]">Execution may have occurred. Check bridge evidence before retrying.</p>}
      </li>)}
    </ol>}
    {page && <div className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
      <p className="text-xs leading-relaxed text-[var(--text-faint)]">Retained for {page.retentionDays} days, up to {page.maxEvents.toLocaleString()} events per store.
        {page.oldestAvailableAt ? ` Oldest available: ${safeTime(page.oldestAvailableAt)}.` : ""}
        {page.truncated ? " Older activity has been removed by retention limits." : ""}
        {page.reset ? " History changed; the newest available page is shown." : ""}
      </p>
      {page.nextCursor && <button type="button" className="btn-ghost min-h-11 w-full sm:w-auto" disabled={loading} onClick={() => void load(page.nextCursor ?? undefined)}>Load older activity</button>}
    </div>}
  </div>;
}
