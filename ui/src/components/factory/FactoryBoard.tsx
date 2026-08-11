"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { relativeTime } from "@/lib/relative-time";
import type {
  FactoryBoardProps,
  FactoryTicket,
  TicketArtifactFile,
  TicketDetail,
  TicketStatus,
} from "./types";
import { TicketDetailsModal } from "./TicketDetailsModal";

const STATUS_BADGE: Record<TicketStatus, string> = {
  queued: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  claimed: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  in_progress: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  done: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  rejected: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  blocked: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  dead_letter: "bg-red-500/15 text-red-300 border-red-500/30",
};

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

function TicketCard({
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
      className={`w-full rounded border p-2 text-left transition-colors ${
        selected
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
            {relativeTime(ticket.updated_at_ms)}
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
  );
}

export function FactoryBoard({
  snapshot,
  error,
  loading,
  onRefresh,
  showTicket,
  listTicketArtifacts,
  readTicketArtifact,
}: FactoryBoardProps) {
  const [detailState, setDetailState] = useState<DetailState | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactState>(emptyArtifacts);
  const detailSeq = useRef(0);
  const fileListSeq = useRef(0);
  const fileReadSeq = useRef(0);

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
            ? `updated ${relativeTime(snapshot.fetchedAt)}`
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
                      selected={detailState?.ticketId === ticket.id}
                      onOpen={openTicket}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
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
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
