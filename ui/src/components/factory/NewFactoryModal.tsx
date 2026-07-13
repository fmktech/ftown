"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FACTORY_INIT_HARNESSES, type FactoryInitHarness, type NewFactoryModalProps } from "./types";

const INPUT_CLASS =
  "w-full px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-base)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] outline-none focus-visible:border-[var(--accent)] focus-visible:shadow-[var(--focus-ring)] font-mono";

export function NewFactoryModal(props: NewFactoryModalProps) {
  const { bridges, onSubmit, onClose } = props;

  const [bridgeId, setBridgeId] = useState(bridges.length === 1 ? bridges[0].bridgeId : "");
  const [harness, setHarness] = useState<FactoryInitHarness>("claude");
  const [model, setModel] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [project, setProject] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);

  // Auto-select the only bridge; keep a valid selection if the list changes.
  useEffect(() => {
    if (bridges.length === 1) {
      setBridgeId(bridges[0].bridgeId);
    } else if (bridgeId && !bridges.some((b) => b.bridgeId === bridgeId)) {
      setBridgeId("");
    }
  }, [bridges, bridgeId]);

  useEffect(() => {
    const id = window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  const repoPathError = useMemo(() => {
    if (!repoPath.trim()) return null; // required — surfaced via disabled submit, not inline
    if (!repoPath.startsWith("/")) return "Repository path must be an absolute path (start with \"/\").";
    return null;
  }, [repoPath]);

  const projectTrimmed = project.trim();
  const repoPathTrimmed = repoPath.trim();

  const isValid =
    bridgeId !== "" &&
    repoPathTrimmed !== "" &&
    repoPathTrimmed.startsWith("/") &&
    projectTrimmed !== "";

  const handleSubmit = useCallback(async () => {
    if (!isValid || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const modelTrimmed = model.trim();
      await onSubmit({
        bridgeId,
        repoPath: repoPathTrimmed,
        project: projectTrimmed,
        harness,
        ...(modelTrimmed ? { model: modelTrimmed } : {}),
      });
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [isValid, submitting, onSubmit, bridgeId, repoPathTrimmed, projectTrimmed, harness, model, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
      if (e.key === "Enter" && e.metaKey) {
        void handleSubmit();
      }
    },
    [onClose, handleSubmit]
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
        aria-labelledby="new-factory-title"
        className="w-full max-w-md border border-[var(--border-default)] bg-[var(--bg-surface)] rounded-[var(--radius-md)] shadow-[var(--shadow-md)] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="new-factory-title"
          className="sticky top-0 z-10 bg-[var(--bg-surface)] px-5 py-4 border-b border-[var(--border-muted)] text-lg font-bold text-[var(--accent)]"
        >
          New Factory
        </h2>

        <div className="space-y-4 px-5 py-4">
          <p className="text-xs text-[var(--text-faint)]">
            Spawns a claude agent session on the bridge that deploys the factory (/factory init) —
            watch it in Sessions.
          </p>

          <div>
            <label htmlFor="nf-bridge" className="block text-sm text-[var(--text-muted)] mb-1">
              Bridge
            </label>
            {bridges.length === 0 ? (
              <div
                role="alert"
                className="px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--status-pending)] bg-[rgba(255,170,0,0.08)] text-xs text-[var(--status-pending)] flex items-start gap-2"
              >
                <span aria-hidden>⚠</span>
                <span>No bridges connected — start ftown-bridge on a machine first.</span>
              </div>
            ) : (
              <select
                id="nf-bridge"
                ref={firstFieldRef}
                value={bridgeId}
                onChange={(e) => setBridgeId(e.target.value)}
                required
                className={INPUT_CLASS + " text-sm"}
              >
                <option value="" disabled>
                  Select a bridge…
                </option>
                {bridges.map((b) => (
                  <option key={b.bridgeId} value={b.bridgeId}>
                    {b.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label htmlFor="nf-harness" className="block text-sm text-[var(--text-muted)] mb-1">
              Agent
            </label>
            <select
              id="nf-harness"
              value={harness}
              onChange={(e) => setHarness(e.target.value as FactoryInitHarness)}
              className={INPUT_CLASS + " text-sm"}
            >
              {FACTORY_INIT_HARNESSES.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="nf-model" className="block text-sm text-[var(--text-muted)] mb-1">
              Model
            </label>
            <input
              id="nf-model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="harness default"
              className={INPUT_CLASS + " text-sm"}
              onKeyDown={handleKeyDown}
            />
          </div>

          <div>
            <label htmlFor="nf-repo-path" className="block text-sm text-[var(--text-muted)] mb-1">
              Repository path
            </label>
            <input
              id="nf-repo-path"
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/absolute/path/to/repo"
              required
              aria-invalid={repoPathError ? "true" : undefined}
              className={INPUT_CLASS + " text-sm"}
              onKeyDown={handleKeyDown}
            />
            {repoPathError && (
              <p className="mt-1 text-xs text-[var(--status-error)]" role="alert">
                {repoPathError}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="nf-project" className="block text-sm text-[var(--text-muted)] mb-1">
              Project name
            </label>
            <input
              id="nf-project"
              type="text"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="my-project"
              required
              className={INPUT_CLASS + " text-sm"}
              onKeyDown={handleKeyDown}
            />
            <p className="mt-1 text-xs text-[var(--text-faint)]">used to label the factory&apos;s loops</p>
          </div>

          {submitError && (
            <div
              role="alert"
              aria-live="assertive"
              className="fade-in flex items-start gap-2 px-3 py-2.5 border-l-2 border border-[var(--status-error)] rounded-[var(--radius-sm)] bg-[rgba(255,68,102,0.08)] text-xs text-[var(--status-error)] break-words"
            >
              <span aria-hidden>⚠</span>
              <span>{submitError}</span>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 z-10 bg-[var(--bg-surface)] px-5 py-4 border-t border-[var(--border-muted)] flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!isValid || submitting}
            className="btn-accent"
          >
            {submitting ? "Creating…" : "Create factory"}
          </button>
        </div>
      </div>
    </div>
  );
}
