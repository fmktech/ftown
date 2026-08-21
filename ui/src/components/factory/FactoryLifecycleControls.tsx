"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Loop, Session } from "@/types";
import { ContextMenu, ContextMenuButton } from "@/components/ContextMenu";
import { factoryWorkerOf, type FactoryInfo } from "./types";
import {
  loopsForFactory,
  setFactoryLoopsEnabled,
  teardownFactoryLoops,
  type DeleteFactoryLoop,
  type UpdateFactoryLoop,
} from "./factory-lifecycle";

interface FactoryLifecycleControlsProps {
  factory: FactoryInfo;
  loops: Loop[];
  sessions: Session[];
  updateLoop: UpdateFactoryLoop;
  deleteLoop: DeleteFactoryLoop;
}

type BusyAction = "pause" | "resume" | "teardown" | null;

export function FactoryLifecycleControls({
  factory,
  loops,
  sessions,
  updateLoop,
  deleteLoop,
}: FactoryLifecycleControlsProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmTeardown, setConfirmTeardown] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const factoryLoops = useMemo(() => loopsForFactory(factory, loops), [factory, loops]);
  const workerCount = useMemo(
    () => sessions.filter((session) => factoryWorkerOf(session, [factory]) !== null).length,
    [factory, sessions],
  );
  const allPaused = factoryLoops.every((loop) => !loop.enabled);
  const allRunning = factoryLoops.every((loop) => loop.enabled);

  useEffect(() => {
    if (!confirmTeardown) return;
    confirmButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setConfirmTeardown(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmTeardown, busy]);

  const setEnabled = async (enabled: boolean): Promise<void> => {
    setMenu(null);
    setError(null);
    setBusy(enabled ? "resume" : "pause");
    try {
      await setFactoryLoopsEnabled(factory, factoryLoops, enabled, updateLoop);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const teardown = async (): Promise<void> => {
    setError(null);
    setBusy("teardown");
    try {
      await teardownFactoryLoops(factory, factoryLoops, updateLoop, deleteLoop);
      setConfirmTeardown(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (factoryLoops.length === 0) return null;

  return (
    <>
      {error && !confirmTeardown && (
        <span
          role="alert"
          title={error}
          style={{ maxWidth: 220, fontSize: 10, color: "var(--status-error)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {error}
        </span>
      )}
      <button
        type="button"
        aria-label="Factory actions"
        title="Factory actions"
        disabled={busy !== null}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.right - 140, y: rect.bottom + 4 });
        }}
        className="btn-ghost"
        style={{ flexShrink: 0, minWidth: 32, opacity: busy ? 0.6 : 1 }}
      >
        {busy ? "…" : "⋯"}
      </button>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={`Actions for factory ${factory.project}`}
          onClose={() => setMenu(null)}
        >
          <ContextMenuButton
            label="Pause factory"
            disabled={allPaused}
            onClick={() => void setEnabled(false)}
          />
          <ContextMenuButton
            label="Resume factory"
            disabled={allRunning}
            onClick={() => void setEnabled(true)}
          />
          <ContextMenuButton
            label="Teardown factory…"
            color="var(--status-error)"
            onClick={() => {
              setMenu(null);
              setError(null);
              setConfirmTeardown(true);
            }}
          />
        </ContextMenu>
      )}

      {confirmTeardown && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => {
            if (!busy) setConfirmTeardown(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="factory-teardown-title"
            className="w-full max-w-md rounded border border-zinc-700/60 bg-zinc-900 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2
              id="factory-teardown-title"
              className="border-b border-zinc-800 px-4 py-3 text-sm font-semibold text-zinc-100"
            >
              Teardown {factory.project}?
            </h2>
            <div className="space-y-3 px-4 py-4 text-xs text-zinc-300">
              <p>
                This pauses and deletes {factoryLoops.length} scheduling loop{factoryLoops.length === 1 ? "" : "s"}. No new factory workers will start.
              </p>
              {workerCount > 0 && (
                <p className="rounded border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-amber-200">
                  {workerCount} existing worker session{workerCount === 1 ? " is" : "s are"} not stopped and may continue running.
                </p>
              )}
              <p className="text-zinc-400">
                Ticket history in <code>.ffactory/</code> and the checked-in <code>factory/</code> definition are preserved.
              </p>
              <ul className="max-h-28 overflow-auto rounded bg-zinc-950 px-3 py-2 font-mono text-[11px] text-zinc-400">
                {factoryLoops.map((loop) => <li key={loop.id}>{loop.name}</li>)}
              </ul>
              {error && <p role="alert" className="text-red-400">{error}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
              <button
                type="button"
                className="btn-ghost"
                disabled={busy !== null}
                onClick={() => setConfirmTeardown(false)}
              >
                Cancel
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                disabled={busy !== null}
                onClick={() => void teardown()}
                className="rounded border border-red-700/60 bg-red-950/40 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-950/70 disabled:opacity-60"
              >
                {busy === "teardown" ? "Tearing down…" : "Teardown factory"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
