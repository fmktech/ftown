"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NewTicketFormProps } from "./types";

export function NewTicketForm({ stages, onCreate, onClose }: NewTicketFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [stage, setStage] = useState(stages[0] ?? "");
  const [priority, setPriority] = useState(0);
  const [kind, setKind] = useState<"task" | "epic">("task");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => titleRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  const canSubmit =
    title.trim() !== "" && description.trim() !== "" && stages.length > 0 && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        description: description.trim(),
        stage,
        priority,
        kind,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [canSubmit, onCreate, onClose, title, description, stage, priority, kind]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-ticket-title"
        className="w-full max-w-lg rounded border border-zinc-700/60 bg-zinc-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="new-ticket-title"
          className="border-b border-zinc-800 px-4 py-3 text-sm font-semibold text-zinc-100"
        >
          New ticket
        </h2>

        <div className="space-y-3 px-4 py-3">
          <div>
            <label htmlFor="nt-title" className="mb-1 block text-xs text-zinc-400">
              Title
            </label>
            <textarea
              id="nt-title"
              ref={titleRef}
              required
              rows={3}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ticket title"
              disabled={submitting}
              className="w-full resize-none rounded border border-zinc-700/60 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 disabled:opacity-60"
              onKeyDown={handleKeyDown}
            />
          </div>

          <div>
            <label htmlFor="nt-description" className="mb-1 block text-xs text-zinc-400">
              Description
            </label>
            <textarea
              id="nt-description"
              required
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What should be built / investigated? This becomes the ticket's request.md — the groom worker's input."
              disabled={submitting}
              className="w-full resize-none rounded border border-zinc-700/60 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 disabled:opacity-60"
              onKeyDown={handleKeyDown}
            />
          </div>

          <div>
            <label htmlFor="nt-stage" className="mb-1 block text-xs text-zinc-400">
              Stage
            </label>
            <select
              id="nt-stage"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              disabled={submitting || stages.length === 0}
              className="w-full rounded border border-zinc-700/60 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500 disabled:opacity-60"
            >
              {stages.length === 0 ? (
                <option value="">no stages available</option>
              ) : (
                stages.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label htmlFor="nt-priority" className="mb-1 block text-xs text-zinc-400">
                Priority
              </label>
              <input
                id="nt-priority"
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number.isNaN(e.target.valueAsNumber) ? 0 : e.target.valueAsNumber)}
                disabled={submitting}
                className="w-full rounded border border-zinc-700/60 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500 disabled:opacity-60"
                onKeyDown={handleKeyDown}
              />
            </div>

            <div className="flex-1">
              <label htmlFor="nt-kind" className="mb-1 block text-xs text-zinc-400">
                Kind
              </label>
              <select
                id="nt-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as "task" | "epic")}
                disabled={submitting}
                className="w-full rounded border border-zinc-700/60 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500 disabled:opacity-60"
              >
                <option value="task">task</option>
                <option value="epic">epic</option>
              </select>
            </div>
          </div>

          {error !== null && (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-xs text-red-300"
            >
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded border border-zinc-700/60 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="rounded border border-zinc-500/60 bg-zinc-700/40 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create ticket"}
          </button>
        </div>
      </div>
    </div>
  );
}
