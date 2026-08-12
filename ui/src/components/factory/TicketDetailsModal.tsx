"use client";

import { useEffect } from "react";
import { relativeTime } from "@/lib/relative-time";
import type {
  TicketArtifactFile,
  TicketDetail,
  TicketHistoryEntry,
} from "./types";

export interface TicketDetailsModalProps {
  ticketId: number;
  detail: TicketDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  files: TicketArtifactFile[];
  filesLoading: boolean;
  filesError: string | null;
  selectedRelPath: string | null;
  content: string | null;
  contentLoading: boolean;
  contentError: string | null;
  onSelectFile: (relPath: string) => void;
  onRetryFiles: () => void;
  onRetryContent: () => void;
  onClose: () => void;
}

function formatUntil(ms: number): string {
  if (Number.isNaN(ms)) return "unknown";
  if (ms - Date.now() <= 0) return `expired ${relativeTime(ms)}`;
  return `expires ${relativeTime(ms)}`;
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

const smallButton =
  "rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800";

export function TicketDetailsModal({
  ticketId,
  detail,
  detailLoading,
  detailError,
  files,
  filesLoading,
  filesError,
  selectedRelPath,
  content,
  contentLoading,
  contentError,
  onSelectFile,
  onRetryFiles,
  onRetryContent,
  onClose,
}: TicketDetailsModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const selectedName =
    files.find((file) => file.relPath === selectedRelPath)?.name ??
    selectedRelPath;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-2 sm:p-4"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ticket-detail-title"
        className="flex h-[min(88vh,860px)] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-zinc-800 px-4 py-3">
          <span className="mt-0.5 shrink-0 font-mono text-xs text-zinc-500">
            #{ticketId}
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="ticket-detail-title"
              className="truncate text-sm font-semibold text-zinc-100"
            >
              {detail?.ticket.title ?? `Ticket ${ticketId}`}
            </h2>
            {detail !== null && (
              <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-zinc-500">
                <span>{detail.ticket.stage}</span>
                <span aria-hidden>·</span>
                <span>{detail.ticket.status}</span>
                <span aria-hidden>·</span>
                <span>priority {detail.ticket.priority}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close ticket details"
          >
            ✕
          </button>
        </header>

        {detailLoading && (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
            <span className="animate-pulse">Loading ticket…</span>
          </div>
        )}
        {!detailLoading && detailError !== null && (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-red-400">
            {detailError}
          </div>
        )}
        {!detailLoading && detailError === null && detail !== null && (
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(10rem,38%)_minmax(0,1fr)] sm:grid-cols-[16rem_minmax(0,1fr)] sm:grid-rows-1">
            <aside className="flex min-h-0 flex-col border-b border-zinc-800 sm:border-b-0 sm:border-r">
              <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  Files
                </span>
                <span className="text-[10px] text-zinc-600">
                  {filesLoading ? "…" : files.length}
                </span>
              </div>
              <nav
                aria-label="Ticket files"
                className="min-h-0 flex-1 overflow-y-auto py-1"
              >
                {filesLoading && (
                  <div className="px-3 py-2 text-xs text-zinc-500">
                    Loading files…
                  </div>
                )}
                {!filesLoading && filesError !== null && (
                  <div className="px-3 py-2 text-xs">
                    <div className="break-words text-red-400">{filesError}</div>
                    <button
                      type="button"
                      className={`${smallButton} mt-2`}
                      onClick={onRetryFiles}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {!filesLoading && filesError === null && files.length === 0 && (
                  <div className="px-3 py-2 text-xs text-zinc-500">
                    No artifact files yet.
                  </div>
                )}
                {!filesLoading &&
                  filesError === null &&
                  files.map((file) => {
                    const selected = file.relPath === selectedRelPath;
                    return (
                      <button
                        key={file.relPath}
                        type="button"
                        title={file.name}
                        aria-current={selected ? "page" : undefined}
                        onClick={() => onSelectFile(file.relPath)}
                        className={`block w-full truncate px-3 py-1.5 text-left font-mono text-xs ${
                          selected
                            ? "bg-zinc-800 text-zinc-100"
                            : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                        }`}
                      >
                        {file.name}
                      </button>
                    );
                  })}
              </nav>

              <details className="max-h-52 shrink-0 overflow-y-auto border-t border-zinc-800 px-3 py-2 text-xs text-zinc-400">
                <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                  Activity ({detail.history.length})
                </summary>
                {detail.claim !== null && (
                  <div className="mt-2 rounded border border-amber-500/20 bg-amber-500/5 p-2">
                    <div className="truncate" title={detail.claim.worker_id}>
                      {detail.claim.worker_id}
                    </div>
                    <div className="text-zinc-500">
                      epoch {detail.claim.epoch} · renews {detail.claim.renew_count}
                    </div>
                    <div className="text-zinc-500">
                      {formatUntil(detail.claim.expires_at_ms)}
                    </div>
                  </div>
                )}
                {detail.history.length === 0 ? (
                  <div className="mt-2 text-zinc-600">No history entries.</div>
                ) : (
                  <ol className="mt-2 space-y-2 border-l border-zinc-800 pl-2">
                    {detail.history.map((entry) => {
                      const line = historyLine(entry);
                      const who = entry.actor ?? entry.worker_id;
                      return (
                        <li key={entry.id}>
                          <div className="text-zinc-300">
                            {entry.kind} · {relativeTime(entry.at_ms)}
                          </div>
                          {line !== "" && (
                            <div className="text-zinc-500">{line}</div>
                          )}
                          {who !== null && (
                            <div className="truncate text-zinc-600" title={who}>
                              {who}
                            </div>
                          )}
                          {entry.note && (
                            <div className="break-words italic text-zinc-500">
                              {entry.note}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </details>
            </aside>

            <main className="flex min-h-0 min-w-0 flex-col bg-zinc-950">
              <div className="shrink-0 border-b border-zinc-800 px-4 py-2 font-mono text-xs text-zinc-400">
                {selectedName ?? "Select a file"}
              </div>
              {selectedRelPath === null ? (
                <div className="flex flex-1 items-center justify-center p-6 text-sm text-zinc-600">
                  {files.length === 0
                    ? "This ticket has no artifacts yet."
                    : "Select a file to read it."}
                </div>
              ) : contentLoading ? (
                <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
                  Loading {selectedName}…
                </div>
              ) : contentError !== null ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
                  <div className="break-words text-red-400">{contentError}</div>
                  <button
                    type="button"
                    className={smallButton}
                    onClick={onRetryContent}
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-zinc-200 sm:text-sm">
                  {content === "" ? "(empty file)" : content}
                </pre>
              )}
            </main>
          </div>
        )}
      </section>
    </div>
  );
}
