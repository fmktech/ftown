"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { relativeTime } from "@/lib/relative-time";
import type {
  FactoryBoardProps,
  FactoryTicket,
  TicketArtifactFile,
  TicketDetail,
  TicketStatus,
} from "./types";
import {
  formatActivityLabel,
  groupFactoryActivity,
} from "./factory-activity";
import { TicketDetailsModal } from "./TicketDetailsModal";

const STATUS_BADGE: Record<TicketStatus, string> = {
  queued: "border-zinc-700/70 bg-zinc-800/70 text-zinc-300",
  claimed: "border-amber-800/60 bg-amber-950/50 text-amber-300",
  in_progress: "border-sky-800/60 bg-sky-950/50 text-sky-300",
  done: "border-emerald-800/60 bg-emerald-950/50 text-emerald-300",
  rejected: "border-orange-800/60 bg-orange-950/50 text-orange-300",
  blocked: "border-yellow-800/60 bg-yellow-950/50 text-yellow-300",
  dead_letter: "border-red-800/60 bg-red-950/50 text-red-300",
};

function stageTone(stage: string): string {
  const normalized = stage.toLowerCase();
  if (/verify|review|qa/.test(normalized)) {
    return "border-violet-900/50 bg-violet-950/35 text-violet-300";
  }
  if (/accept|handoff|done|complete/.test(normalized)) {
    return "border-emerald-900/50 bg-emerald-950/35 text-emerald-300";
  }
  if (/fix|build|implement/.test(normalized)) {
    return "border-sky-900/50 bg-sky-950/35 text-sky-300";
  }
  if (/rca|triage|plan/.test(normalized)) {
    return "border-zinc-800 bg-zinc-900/80 text-zinc-300";
  }
  return "border-indigo-900/50 bg-indigo-950/30 text-indigo-300";
}

function TicketStatusIcon({ ticket }: { ticket: FactoryTicket }) {
  const status = ticket.status;
  const tone =
    status === "done"
      ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-400"
      : status === "dead_letter" || status === "rejected"
        ? "border-red-900/60 bg-red-950/40 text-red-400"
        : status === "blocked"
          ? "border-yellow-900/60 bg-yellow-950/40 text-yellow-400"
          : status === "in_progress"
            ? "border-sky-900/60 bg-sky-950/40 text-sky-400"
            : "border-zinc-800 bg-zinc-900 text-zinc-500";

  return (
    <span
      aria-hidden="true"
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${tone}`}
    >
      {ticket.kind === "epic" ? (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="m8 2 5 3-5 3-5-3 5-3Z" />
          <path d="m3 8 5 3 5-3M3 11l5 3 5-3" />
        </svg>
      ) : status === "done" ? (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m3 8 3 3 7-7" />
        </svg>
      ) : status === "dead_letter" || status === "rejected" ? (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="m4 4 8 8m0-8-8 8" />
        </svg>
      ) : status === "blocked" ? (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 4.5v4M8 11.5h.01" />
        </svg>
      ) : status === "in_progress" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="m6 4-4 4 4 4M10 4l4 4-4 4" />
        </svg>
      ) : (
        <span className="h-4 w-4 rounded-full border border-dashed border-current" />
      )}
    </span>
  );
}

interface DetailState {
  ticketId: number;
  loading: boolean;
  error: string | null;
  detail: TicketDetail | null;
}

interface ArtifactState {
  folderPath: string | null;
  files: TicketArtifactFile[];
  filesLoading: boolean;
  filesError: string | null;
  selectedRelPath: string | null;
  content: string | null;
  contentLoading: boolean;
  contentError: string | null;
}

const TERMINAL_STATUSES = new Set<TicketStatus>([
  "done",
  "rejected",
  "dead_letter",
]);

function hiddenTicketsStorageKey(factoryIdentity: string): string {
  return `ftown:hidden-factory-tickets:${factoryIdentity}`;
}

function emptyArtifacts(): ArtifactState {
  return {
    folderPath: null,
    files: [],
    filesLoading: false,
    filesError: null,
    selectedRelPath: null,
    content: null,
    contentLoading: false,
    contentError: null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function TicketRow({
  ticket,
  selected,
  onOpen,
}: {
  ticket: FactoryTicket;
  selected: boolean;
  onOpen: (id: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(ticket.id)}
      aria-label={`Open ticket #${ticket.id}: ${ticket.title}`}
      className={`grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-all ${
        selected
          ? "border-emerald-400/80 bg-emerald-950/20 shadow-[0_0_0_1px_rgba(52,211,153,0.12)]"
          : "border-transparent hover:border-zinc-800 hover:bg-zinc-900/70 focus-visible:border-emerald-500/70 focus-visible:outline-none"
      }`}
    >
      <TicketStatusIcon ticket={ticket} />
      <div className="min-w-0 md:flex md:items-center md:gap-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-xs text-zinc-500">
            #{ticket.id}
          </span>
          <span className="truncate text-sm font-medium text-zinc-100" title={ticket.title}>
            {ticket.title}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden md:ml-auto md:mt-0">
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_BADGE[ticket.status]}`}
            title={ticket.blocked_on ?? ticket.dead_letter_reason ?? undefined}
          >
            {ticket.status === "blocked"
              ? "Needs attention"
              : formatActivityLabel(ticket.status)}
          </span>
          {ticket.priority > 0 && (
            <span className="hidden shrink-0 rounded-full border border-zinc-700/70 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-400 sm:inline-flex">
              P{ticket.priority}
            </span>
          )}
          {ticket.bounce_count > 0 && (
            <span className="shrink-0 rounded-full border border-zinc-700/70 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-400">
              ↩ {ticket.bounce_count}
            </span>
          )}
          {ticket.orphaned === 1 && (
            <span className="shrink-0 rounded-full border border-red-900/60 bg-red-950/40 px-2 py-0.5 text-[10px] text-red-300">
              Orphaned
            </span>
          )}
        </div>
      </div>
      <span className="hidden min-w-16 text-right text-[11px] text-zinc-500 sm:block">
        {relativeTime(ticket.updated_at_ms)}
      </span>
    </button>
  );
}

export function FactoryBoard({
  factoryIdentity,
  snapshot,
  error,
  loading,
  onRefresh,
  showTicket,
  listTicketArtifacts,
  readTicketArtifact,
  stopTicket,
  requeueTicket,
}: FactoryBoardProps) {
  const [detailState, setDetailState] = useState<DetailState | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactState>(emptyArtifacts);
  const [hiddenTicketIds, setHiddenTicketIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [showHiddenTickets, setShowHiddenTickets] = useState(false);
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(
    () => new Set(),
  );
  const detailSeq = useRef(0);
  const fileListSeq = useRef(0);
  const fileReadSeq = useRef(0);

  useEffect(() => {
    setShowHiddenTickets(false);
    setCollapsedStages(new Set());
    try {
      const stored = window.localStorage.getItem(
        hiddenTicketsStorageKey(factoryIdentity),
      );
      const parsed: unknown = stored === null ? [] : JSON.parse(stored);
      setHiddenTicketIds(
        new Set(
          Array.isArray(parsed)
            ? parsed.filter(
                (value): value is number =>
                  typeof value === "number" && Number.isInteger(value),
              )
            : [],
        ),
      );
    } catch {
      setHiddenTicketIds(new Set());
    }
  }, [factoryIdentity]);

  const toggleStage = useCallback((stage: string) => {
    setCollapsedStages((current) => {
      const next = new Set(current);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }, []);

  const openFile = useCallback(
    (folderPath: string, relPath: string) => {
      const seq = ++fileReadSeq.current;
      setArtifacts((current) => ({
        ...current,
        folderPath,
        selectedRelPath: relPath,
        content: null,
        contentLoading: true,
        contentError: null,
      }));
      readTicketArtifact(folderPath, relPath)
        .then((content) => {
          if (fileReadSeq.current !== seq) return;
          setArtifacts((current) => ({
            ...current,
            content,
            contentLoading: false,
            contentError: null,
          }));
        })
        .catch((err: unknown) => {
          if (fileReadSeq.current !== seq) return;
          setArtifacts((current) => ({
            ...current,
            content: null,
            contentLoading: false,
            contentError: errorMessage(err),
          }));
        });
    },
    [readTicketArtifact],
  );

  const loadFiles = useCallback(
    (folderPath: string) => {
      const seq = ++fileListSeq.current;
      ++fileReadSeq.current;
      setArtifacts({
        ...emptyArtifacts(),
        folderPath,
        filesLoading: true,
      });
      listTicketArtifacts(folderPath)
        .then((files) => {
          if (fileListSeq.current !== seq) return;
          const first =
            files.find((file) => file.name === "request.md") ?? files[0] ?? null;
          setArtifacts({
            ...emptyArtifacts(),
            folderPath,
            files,
            selectedRelPath: first?.relPath ?? null,
          });
          if (first !== null) openFile(folderPath, first.relPath);
        })
        .catch((err: unknown) => {
          if (fileListSeq.current !== seq) return;
          setArtifacts({
            ...emptyArtifacts(),
            folderPath,
            filesError: errorMessage(err),
          });
        });
    },
    [listTicketArtifacts, openFile],
  );

  const closeDetail = useCallback(() => {
    detailSeq.current += 1;
    fileListSeq.current += 1;
    fileReadSeq.current += 1;
    setDetailState(null);
    setArtifacts(emptyArtifacts());
  }, []);

  const openTicket = useCallback(
    (id: number) => {
      const seq = ++detailSeq.current;
      ++fileListSeq.current;
      ++fileReadSeq.current;
      setArtifacts(emptyArtifacts());
      setDetailState({ ticketId: id, loading: true, error: null, detail: null });
      showTicket(id)
        .then((detail) => {
          if (detailSeq.current !== seq) return;
          setDetailState({ ticketId: id, loading: false, error: null, detail });
          loadFiles(detail.ticket.folder_path);
        })
        .catch((err: unknown) => {
          if (detailSeq.current !== seq) return;
          setDetailState({
            ticketId: id,
            loading: false,
            error: errorMessage(err),
            detail: null,
          });
        });
    },
    [loadFiles, showTicket],
  );

  const hideTicket = useCallback(
    (id: number) => {
      setHiddenTicketIds((current) => {
        const next = new Set(current);
        next.add(id);
        try {
          window.localStorage.setItem(
            hiddenTicketsStorageKey(factoryIdentity),
            JSON.stringify([...next]),
          );
        } catch {
          // Storage can be unavailable in hardened/private browser contexts;
          // keep the current-page dismissal useful anyway.
        }
        return next;
      });
      closeDetail();
    },
    [closeDetail, factoryIdentity],
  );

  const hiddenTicketCount = useMemo(
    () =>
      (snapshot?.tickets ?? []).filter((ticket) =>
        hiddenTicketIds.has(ticket.id),
      ).length,
    [hiddenTicketIds, snapshot],
  );

  const visibleTickets = useMemo(
    () =>
      (snapshot?.tickets ?? []).filter(
        (ticket) => showHiddenTickets || !hiddenTicketIds.has(ticket.id),
      ),
    [hiddenTicketIds, showHiddenTickets, snapshot],
  );

  const groups = useMemo(
    () => groupFactoryActivity(snapshot?.stages ?? [], visibleTickets),
    [snapshot?.stages, visibleTickets],
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-16 text-sm text-zinc-500">
        <span className="animate-pulse">Loading factory…</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950/20">
      {error !== null && (
        <div className="mx-3 mt-3 rounded-lg border border-amber-800/50 bg-amber-950/40 px-3 py-2 text-xs text-amber-300 sm:mx-5">
          {error}
        </div>
      )}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-900/80 px-3 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight text-zinc-100">
            Activity
          </h2>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {snapshot !== null
              ? `Updated ${relativeTime(snapshot.fetchedAt)}`
              : "No data yet"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hiddenTicketCount > 0 && (
            <button
              type="button"
              onClick={() => setShowHiddenTickets((visible) => !visible)}
              className="rounded-md border border-zinc-800 bg-zinc-900/70 px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
            >
              {showHiddenTickets
                ? "Hide removed"
                : `Removed ${hiddenTicketCount}`}
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/70 text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-100"
            title="Refresh activity"
            aria-label="Refresh activity"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 5V2l-2 2a5.5 5.5 0 1 0 1.5 5.5" />
            </svg>
          </button>
        </div>
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
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-5 sm:px-4">
          {groups.map(({ stage, tickets }) => {
            const collapsed = collapsedStages.has(stage);
            return (
              <section key={stage} className="pt-3">
                <button
                  type="button"
                  onClick={() => toggleStage(stage)}
                  aria-expanded={!collapsed}
                  aria-label={`${formatActivityLabel(stage)}, ${tickets.length} ${tickets.length === 1 ? "ticket" : "tickets"}`}
                  className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${stageTone(stage)}`}
                >
                  <svg
                    aria-hidden="true"
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
                  >
                    <path d="m4 6 4 4 4-4" />
                  </svg>
                  <span className="text-sm font-semibold">
                    {formatActivityLabel(stage)}
                  </span>
                  <span className="text-sm opacity-60">{tickets.length}</span>
                </button>
                {!collapsed && tickets.length > 0 && (
                  <div className="flex flex-col py-1">
                    {tickets.map((ticket) => (
                      <TicketRow
                        key={ticket.id}
                        ticket={ticket}
                        selected={detailState?.ticketId === ticket.id}
                        onOpen={openTicket}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      {detailState !== null && (
        <TicketDetailsModal
          ticketId={detailState.ticketId}
          detail={detailState.detail}
          detailLoading={detailState.loading}
          detailError={detailState.error}
          files={artifacts.files}
          filesLoading={artifacts.filesLoading}
          filesError={artifacts.filesError}
          selectedRelPath={artifacts.selectedRelPath}
          content={artifacts.content}
          contentLoading={artifacts.contentLoading}
          contentError={artifacts.contentError}
          stages={snapshot?.stages ?? []}
          onSelectFile={(relPath) => {
            if (artifacts.folderPath !== null) {
              openFile(artifacts.folderPath, relPath);
            }
          }}
          onRetryFiles={() => {
            if (artifacts.folderPath !== null) loadFiles(artifacts.folderPath);
          }}
          onRetryContent={() => {
            if (
              artifacts.folderPath !== null &&
              artifacts.selectedRelPath !== null
            ) {
              openFile(artifacts.folderPath, artifacts.selectedRelPath);
            }
          }}
          onStopTicket={
            detailState.detail !== null &&
            !TERMINAL_STATUSES.has(detailState.detail.ticket.status)
              ? () => stopTicket(detailState.ticketId)
              : undefined
          }
          onRequeueTicket={
            detailState.detail !== null &&
            TERMINAL_STATUSES.has(detailState.detail.ticket.status)
              ? (stage) => requeueTicket(detailState.ticketId, stage)
              : undefined
          }
          onHideTicket={
            detailState.detail !== null &&
            TERMINAL_STATUSES.has(detailState.detail.ticket.status)
              ? () => hideTicket(detailState.ticketId)
              : undefined
          }
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
