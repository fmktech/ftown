"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type {
  FactoryBoardProps,
  FactoryTicket,
  TicketDetail,
  TicketHistoryEntry,
  TicketStatus,
} from "./types";

const STATUS_BADGE: Record<TicketStatus, string> = {
  queued: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  claimed: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  in_progress: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  done: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  rejected: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  blocked: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  dead_letter: "bg-red-500/15 text-red-300 border-red-500/30",
};

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0 || Number.isNaN(diff)) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatUntil(ms: number): string {
  const diff = ms - Date.now();
  if (Number.isNaN(diff)) return "unknown";
  if (diff <= 0) return `expired ${formatAgo(ms)}`;
  const s = Math.ceil(diff / 1000);
  if (s < 60) return `expires in ${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `expires in ${m}m`;
  const h = Math.floor(m / 60);
  return `expires in ${h}h ${m % 60}m`;
}

function historyLine(entry: TicketHistoryEntry): string {
  const parts: string[] = [];
  if (entry.from_stage !== null || entry.to_stage !== null) {
    parts.push(`${entry.from_stage ?? "?"} → ${entry.to_stage ?? "?"}`);
  }
  if (entry.from_status !== null || entry.to_status !== null) {
    parts.push(`${entry.from_status ?? "?"} → ${entry.to_status ?? "?"}`);
  }
  return parts.join(" · ");
}

interface DetailState {
  ticketId: number;
  loading: boolean;
  error: string | null;
  detail: TicketDetail | null;
}

function TicketDetailPanel({
  state,
  onClose,
}: {
  state: DetailState;
  onClose: () => void;
}) {
  return (
    <div className="mt-1 rounded border border-zinc-700/60 bg-zinc-900/60 p-2 text-xs text-zinc-300">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          Ticket #{state.ticketId}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1 text-zinc-500 hover:text-zinc-200"
          aria-label="Close ticket detail"
        >
          ✕
        </button>
      </div>
      {state.loading && (
        <div className="py-2 text-zinc-500">
          <span className="inline-block animate-pulse">Loading ticket…</span>
        </div>
      )}
      {!state.loading && state.error !== null && (
        <div className="py-2 text-red-400">{state.error}</div>
      )}
      {!state.loading && state.error === null && state.detail !== null && (
        <div className="space-y-2 pt-1">
          {state.detail.claim !== null && (
            <div className="rounded border border-amber-500/20 bg-amber-500/5 p-1.5">
              <div className="font-mono text-[10px] uppercase tracking-wider text-amber-400/80">
                Claim
              </div>
              <div className="truncate" title={state.detail.claim.worker_id}>
                worker: {state.detail.claim.worker_id}
              </div>
              <div>
                epoch {state.detail.claim.epoch} · renews{" "}
                {state.detail.claim.renew_count}
              </div>
              <div>{formatUntil(state.detail.claim.expires_at_ms)}</div>
            </div>
          )}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              History
            </div>
            {state.detail.history.length === 0 ? (
              <div className="text-zinc-500">No history entries.</div>
            ) : (
              <ol className="mt-1 max-h-48 space-y-1.5 overflow-y-auto border-l border-zinc-700/60 pl-2">
                {state.detail.history.map((entry) => {
                  const line = historyLine(entry);
                  const who = entry.actor ?? entry.worker_id;
                  return (
                    <li key={entry.id}>
                      <div className="flex items-baseline gap-1.5">
                        <span className="shrink-0 text-zinc-500">
                          {formatAgo(entry.at_ms)}
                        </span>
                        <span className="font-medium text-zinc-200">
                          {entry.kind}
                        </span>
                      </div>
                      {line !== "" && (
                        <div className="text-zinc-400">{line}</div>
                      )}
                      {who !== null && (
                        <div className="truncate text-zinc-500" title={who}>
                          {who}
                        </div>
                      )}
                      {entry.note !== null && entry.note !== "" && (
                        <div className="text-zinc-400 italic">{entry.note}</div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TicketCard({
  ticket,
  expanded,
  detailState,
  onToggle,
  onClose,
}: {
  ticket: FactoryTicket;
  expanded: boolean;
  detailState: DetailState | null;
  onToggle: (id: number) => void;
  onClose: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(ticket.id)}
        className={`w-full rounded border p-2 text-left transition-colors ${
          expanded
            ? "border-zinc-500/60 bg-zinc-800/80"
            : "border-zinc-700/50 bg-zinc-900/40 hover:border-zinc-600/60 hover:bg-zinc-800/50"
        }`}
      >
        <div className="flex items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-xs text-zinc-500">
            #{ticket.id}
          </span>
          <span className="line-clamp-2 text-sm text-zinc-200">
            {ticket.title}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span
            className={`rounded border px-1.5 py-px text-[10px] font-medium ${STATUS_BADGE[ticket.status]}`}
          >
            {ticket.status}
          </span>
          {ticket.bounce_count > 0 && (
            <span className="rounded border border-zinc-600/50 bg-zinc-700/30 px-1.5 py-px text-[10px] text-zinc-300">
              ↩ {ticket.bounce_count}
            </span>
          )}
          {ticket.orphaned === 1 && (
            <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-px text-[10px] text-red-300">
              orphaned
            </span>
          )}
          <span className="ml-auto text-[10px] text-zinc-500">
            {formatAgo(ticket.updated_at_ms)}
          </span>
        </div>
        {ticket.status === "blocked" && ticket.blocked_on !== null && (
          <div
            className="mt-1 truncate text-[11px] text-purple-300/80"
            title={ticket.blocked_on}
          >
            blocked on: {ticket.blocked_on}
          </div>
        )}
        {ticket.status === "dead_letter" &&
          ticket.dead_letter_reason !== null && (
            <div
              className="mt-1 truncate text-[11px] text-red-300/80"
              title={ticket.dead_letter_reason}
            >
              {ticket.dead_letter_reason}
            </div>
          )}
      </button>
      {expanded && detailState !== null && (
        <TicketDetailPanel state={detailState} onClose={onClose} />
      )}
    </div>
  );
}

export function FactoryBoard({
  snapshot,
  error,
  loading,
  onRefresh,
  showTicket,
}: FactoryBoardProps) {
  const [detailState, setDetailState] = useState<DetailState | null>(null);
  const requestSeq = useRef(0);
  const expandedIdRef = useRef<number | null>(null);

  const closeDetail = useCallback(() => {
    expandedIdRef.current = null;
    requestSeq.current += 1;
    setDetailState(null);
  }, []);

  const toggleTicket = useCallback(
    (id: number) => {
      if (expandedIdRef.current === id) {
        expandedIdRef.current = null;
        requestSeq.current += 1;
        setDetailState(null);
        return;
      }
      expandedIdRef.current = id;
      const seq = ++requestSeq.current;
      setDetailState({ ticketId: id, loading: true, error: null, detail: null });
      showTicket(id)
        .then((detail) => {
          if (requestSeq.current !== seq) return;
          setDetailState({ ticketId: id, loading: false, error: null, detail });
        })
        .catch((err: unknown) => {
          if (requestSeq.current !== seq) return;
          const message = err instanceof Error ? err.message : String(err);
          setDetailState({
            ticketId: id,
            loading: false,
            error: message,
            detail: null,
          });
        });
    },
    [showTicket],
  );

  const columns = useMemo<Array<{ stage: string; tickets: FactoryTicket[] }>>(() => {
    const knownStages = snapshot?.stages ?? [];
    const knownSet = new Set(knownStages);
    const byStage = new Map<string, FactoryTicket[]>();
    for (const stage of knownStages) byStage.set(stage, []);
    const unknownTickets: FactoryTicket[] = [];
    for (const ticket of snapshot?.tickets ?? []) {
      if (knownSet.has(ticket.stage)) {
        byStage.get(ticket.stage)?.push(ticket);
      } else {
        unknownTickets.push(ticket);
      }
    }
    const result: Array<{ stage: string; tickets: FactoryTicket[] }> =
      knownStages.map((stage) => ({ stage, tickets: byStage.get(stage) ?? [] }));
    if (unknownTickets.length > 0) {
      result.push({ stage: "unknown", tickets: unknownTickets });
    }
    return result;
  }, [snapshot]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-16 text-sm text-zinc-500">
        <span className="animate-pulse">Loading factory…</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error !== null && (
        <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">
          {error}
        </div>
      )}
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <span className="text-xs text-zinc-500">
          {snapshot !== null
            ? `updated ${formatAgo(snapshot.fetchedAt)}`
            : "no data yet"}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded border border-zinc-700/60 px-1.5 py-0.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
          title="Refresh"
          aria-label="Refresh"
        >
          ↻
        </button>
      </div>
      {snapshot === null ? (
        <div className="flex flex-1 items-center justify-center py-16 text-sm text-zinc-500">
          No snapshot available.
        </div>
      ) : snapshot.tickets.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-sm text-zinc-400">
          <div>No tickets yet — create one with:</div>
          <code className="rounded border border-zinc-700/60 bg-zinc-900/60 px-2 py-1 font-mono text-xs text-zinc-300">
            fts create --db .ffactory/factory.db --title &quot;…&quot;
          </code>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {columns.map(({ stage, tickets }) => (
            <div
              key={stage}
              className="flex min-h-0 w-64 shrink-0 flex-col rounded border border-zinc-800/80 bg-zinc-900/30"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-zinc-800/80 px-2.5 py-1.5">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                  {stage}
                </span>
                <span className="rounded-full bg-zinc-700/50 px-1.5 py-px text-[10px] text-zinc-300">
                  {tickets.length}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
                {tickets.length === 0 ? (
                  <div className="py-3 text-center text-[11px] text-zinc-600">
                    empty
                  </div>
                ) : (
                  tickets.map((ticket) => (
                    <TicketCard
                      key={ticket.id}
                      ticket={ticket}
                      expanded={detailState?.ticketId === ticket.id}
                      detailState={
                        detailState?.ticketId === ticket.id ? detailState : null
                      }
                      onToggle={toggleTicket}
                      onClose={closeDetail}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
