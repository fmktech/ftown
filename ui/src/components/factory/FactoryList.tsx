"use client";

import { useMemo, useState } from "react";
import type { Session } from "@/types";
import { relativeTime } from "@/lib/relative-time";
import { formatUsageDetail } from "@/lib/format-usage";
import { HarnessIcon } from "@/components/HarnessIcon";
import { SessionStateIndicator } from "@/components/SessionStateIndicator";
import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import {
  factoryKey,
  factoryWorkerOf,
  type FactoryInfo,
  type FactoryListProps,
} from "./types";

type FactoryListViewProps = FactoryListProps & {
  /** Live hook-derived state for worker spinners and input-needed markers. */
  sessionActivity?: Map<string, SessionActivity>;
};

function repoBasename(repoRoot: string): string {
  const parts = repoRoot.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : repoRoot;
}

function initial(factory: FactoryInfo): string {
  return factory.project.slice(0, 1).toUpperCase() || "?";
}

function FactoryIcon({ selected = false }: { selected?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
        selected
          ? "border-emerald-800/60 bg-emerald-950/40 text-emerald-400"
          : "border-zinc-800 bg-zinc-900 text-zinc-500"
      }`}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <path d="M2 4.5h4l1.2 1.4H14v7.1H2V4.5Z" />
      </svg>
    </span>
  );
}

function NewFactoryButton({ onCreateFactory }: { onCreateFactory: () => void }) {
  return (
    <button
      type="button"
      onClick={onCreateFactory}
      aria-label="New factory…"
      title="New factory…"
      className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/70 text-base text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-100"
    >
      +
    </button>
  );
}

function WorkerRow({
  session,
  selected,
  onOpenSession,
  onRemoveSession,
  activity,
}: {
  session: Session;
  selected: boolean;
  onOpenSession: (sessionId: string) => void;
  onRemoveSession: (sessionId: string) => void;
  activity?: SessionActivity;
}) {
  const details = session.usage
    ? `${session.name}\n${formatUsageDetail(session.usage)}`
    : session.name;

  return (
    <div
      className={`group/worker flex items-center rounded-md transition-colors ${
        selected ? "bg-zinc-800/90" : "hover:bg-zinc-800/60"
      }`}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpenSession(session.id);
        }}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <SessionStateIndicator
          status={session.status}
          activity={activity?.activity}
          needsInput={Boolean(activity?.attention)}
        />
        <HarnessIcon harness={session.shellType} size={18} />
        <span
          title={details}
          className={`min-w-0 flex-1 truncate text-[11px] ${
            selected ? "text-zinc-100" : "text-zinc-400"
          }`}
        >
          {session.name}
        </span>
        <span className="shrink-0 text-[10px] text-zinc-600">
          {relativeTime(session.createdAt)}
        </span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRemoveSession(session.id);
        }}
        aria-label={`Stop and archive ${session.name}`}
        title="Stop and archive worker"
        className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] text-zinc-600 opacity-0 transition-all hover:bg-zinc-700 hover:text-zinc-200 focus:opacity-100 group-hover/worker:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}

function HiddenFactories({
  factories,
  onUnhideFactory,
}: {
  factories: FactoryInfo[];
  onUnhideFactory?: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (factories.length === 0) return null;

  return (
    <div className="mx-2 mt-2 border-t border-zinc-900 pt-2">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[10px] uppercase tracking-wider text-zinc-600 hover:bg-zinc-900/60 hover:text-zinc-400"
      >
        <span>Hidden {factories.length}</span>
        <span aria-hidden>{expanded ? "⌄" : "›"}</span>
      </button>
      {expanded && (
        <div className="mt-1 flex flex-col gap-0.5">
          {factories.map((factory) => {
            const key = factoryKey(factory);
            return (
              <button
                key={key}
                type="button"
                onClick={() => onUnhideFactory?.(key)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left opacity-60 hover:bg-zinc-900 hover:opacity-100"
                title="Unhide factory"
              >
                <FactoryIcon />
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">
                  {factory.project}
                </span>
                <span className="text-[10px] text-zinc-600">Unhide</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function FactoryList({
  factories,
  selectedKey,
  onSelect,
  collapsed,
  onCreateFactory,
  sessions,
  onOpenSession,
  onRemoveSession,
  selectedSessionId,
  sessionActivity,
  hiddenFactoryKeys,
  onHideFactory,
  onUnhideFactory,
}: FactoryListViewProps) {
  const [collapsedWorkers, setCollapsedWorkers] = useState<Record<string, boolean>>({});
  const hiddenSet = hiddenFactoryKeys ?? new Set<string>();
  const visibleFactories = useMemo(
    () => factories.filter((factory) => !hiddenSet.has(factoryKey(factory))),
    [factories, hiddenSet],
  );
  const hiddenFactories = useMemo(
    () => factories.filter((factory) => hiddenSet.has(factoryKey(factory))),
    [factories, hiddenSet],
  );
  const workersByFactoryKey = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const factory of factories) {
      const workers = sessions
        .filter((session) => factoryWorkerOf(session, [factory]) !== null)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      map.set(factoryKey(factory), workers);
    }
    return map;
  }, [factories, sessions]);

  if (factories.length === 0) {
    if (collapsed) return null;
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-[11px] text-zinc-600">
        <FactoryIcon />
        <span className="text-xs text-zinc-400">No factories detected</span>
        <span>Deploy one with the /factory skill.</span>
        {onCreateFactory && (
          <button type="button" onClick={onCreateFactory} className="btn-ghost mt-1">
            New factory…
          </button>
        )}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 py-2">
        {visibleFactories.map((factory) => {
          const key = factoryKey(factory);
          const selected = key === selectedKey;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(factory)}
              aria-label={`${factory.project} — ${factory.repoRoot}`}
              aria-current={selected ? "true" : undefined}
              title={`${factory.project}\n${factory.repoRoot}`}
              className={`flex h-9 w-9 items-center justify-center rounded-lg border text-xs font-semibold transition-colors ${
                selected
                  ? "border-emerald-700/60 bg-emerald-950/40 text-emerald-300"
                  : "border-transparent text-zinc-500 hover:border-zinc-800 hover:bg-zinc-900"
              }`}
            >
              {initial(factory)}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col pb-3">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-400">Projects</span>
          <span className="rounded-full bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-600">
            {visibleFactories.length}
          </span>
        </div>
        {onCreateFactory && <NewFactoryButton onCreateFactory={onCreateFactory} />}
      </div>

      <div className="flex flex-col gap-1 px-2">
        {visibleFactories.map((factory) => {
          const key = factoryKey(factory);
          const selected = key === selectedKey;
          const workers = workersByFactoryKey.get(key) ?? [];
          const workersExpanded = collapsedWorkers[key] !== true;
          return (
            <div
              key={key}
              className={`group/factory rounded-xl border transition-colors ${
                selected
                  ? "border-zinc-700/80 bg-zinc-900/90 shadow-sm"
                  : "border-transparent hover:bg-zinc-900/55"
              }`}
            >
              <div className="flex items-center pr-1">
                <button
                  type="button"
                  onClick={() => onSelect(factory)}
                  aria-current={selected ? "true" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
                >
                  <FactoryIcon selected={selected} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-xs font-medium ${selected ? "text-zinc-100" : "text-zinc-300"}`}>
                      {factory.project}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-zinc-600" title={factory.repoRoot}>
                      {repoBasename(factory.repoRoot)}
                    </span>
                  </span>
                  {workers.length > 0 && (
                    <span className="rounded-full bg-zinc-950/70 px-1.5 py-0.5 text-[10px] text-zinc-500">
                      {workers.length}
                    </span>
                  )}
                </button>
                {onHideFactory && (
                  <button
                    type="button"
                    onClick={() => onHideFactory(key)}
                    aria-label={`Hide ${factory.project}`}
                    title="Hide factory"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] text-zinc-600 opacity-0 hover:bg-zinc-800 hover:text-zinc-300 focus:opacity-100 group-hover/factory:opacity-100"
                  >
                    ✕
                  </button>
                )}
              </div>

              {selected && workers.length > 0 && (
                <div className="px-2 pb-2">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedWorkers((current) => ({
                        ...current,
                        [key]: workersExpanded,
                      }))
                    }
                    className="flex w-full items-center justify-between px-2 pb-1 pt-0.5 text-[10px] text-zinc-600 hover:text-zinc-400"
                  >
                    <span>
                      {workers.length} {workers.length === 1 ? "agent" : "agents"}
                    </span>
                    <span aria-hidden>{workersExpanded ? "⌄" : "›"}</span>
                  </button>
                  {workersExpanded && (
                    <div className="flex flex-col gap-0.5">
                      {workers.map((session) => (
                        <WorkerRow
                          key={session.id}
                          session={session}
                          selected={session.id === selectedSessionId}
                          onOpenSession={onOpenSession}
                          onRemoveSession={onRemoveSession}
                          activity={sessionActivity?.get(session.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <HiddenFactories
        factories={hiddenFactories}
        onUnhideFactory={onUnhideFactory}
      />
    </div>
  );
}
