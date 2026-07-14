"use client";

import { useMemo } from "react";
import type { SessionStatus } from "@/types";
import { workerSessionRe, type FactoryRunsProps, type WorkerRun } from "./types";

function formatRelative(timestamp: string): string {
  const ms = new Date(timestamp).getTime();
  if (Number.isNaN(ms)) return "unknown";
  const diffMs = Date.now() - ms;
  if (diffMs < 60000) return "just now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function statusDotClass(status: SessionStatus): string {
  switch (status) {
    case "running":
      return "bg-green-500 animate-pulse";
    case "pending":
      return "bg-zinc-400";
    case "completed":
      return "bg-zinc-600";
    case "error":
      return "bg-red-500";
    case "disconnected":
      return "bg-amber-500";
  }
}

export function FactoryRuns({ factory, sessions, onOpenSession }: FactoryRunsProps) {
  const groups = useMemo(() => {
    const re = workerSessionRe(factory.project);
    const runs: WorkerRun[] = [];
    for (const session of sessions) {
      if (session.bridgeId !== factory.bridgeId) continue;
      const match = re.exec(session.name);
      if (match) {
        runs.push({ session, ticketId: Number(match[1]), stage: match[2] });
      }
    }
    const byTicket = new Map<number, WorkerRun[]>();
    for (const run of runs) {
      const existing = byTicket.get(run.ticketId);
      if (existing) existing.push(run);
      else byTicket.set(run.ticketId, [run]);
    }
    return [...byTicket.entries()]
      .sort(([a], [b]) => b - a)
      .map(([ticketId, ticketRuns]) => ({
        ticketId,
        runs: ticketRuns.sort(
          (a, b) =>
            new Date(b.session.createdAt).getTime() -
            new Date(a.session.createdAt).getTime(),
        ),
      }));
  }, [sessions, factory.project]);

  if (groups.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-zinc-500">
        No worker runs yet — runs appear here when the dispatcher claims a
        ticket.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {groups.map(({ ticketId, runs }) => (
        <div key={ticketId}>
          <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Ticket #{ticketId}
          </div>
          <div className="flex flex-col">
            {runs.map(({ session, stage }) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onOpenSession(session.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-800/60"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(session.status)}`}
                  aria-hidden="true"
                />
                <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-300">
                  {stage}
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-500">
                  {session.name}
                </span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {formatRelative(session.createdAt)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
