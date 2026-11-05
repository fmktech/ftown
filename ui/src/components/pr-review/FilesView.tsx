"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileDiff } from "@/components/pr-review/FileDiff";
import { FileList } from "@/components/pr-review/FileList";
import { usePrViewedFiles } from "@/hooks/usePrViewedFiles";
import type { DiffFile } from "@/lib/pr-diff-types";
import {
  PR_REVIEW_STORAGE,
  PR_REVIEW_WIDE_MIN_PX,
  REVIEW_LABELS,
  prReviewFileDomId,
  type DiffLayout,
  type FilesViewProps,
} from "@/lib/pr-review-types";

interface LayoutPrefs {
  layout: DiffLayout;
  wrap: boolean;
}

const DEFAULT_PREFS: LayoutPrefs = { layout: "unified", wrap: false };
const DRAWER_ID = "pr-review-file-drawer";

function loadPrefs(): LayoutPrefs {
  try {
    const raw = window.localStorage.getItem(PR_REVIEW_STORAGE.layout);
    if (!raw) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;
    const rec = parsed as Record<string, unknown>;
    return {
      layout: rec.layout === "split" || rec.layout === "unified" ? rec.layout : DEFAULT_PREFS.layout,
      wrap: typeof rec.wrap === "boolean" ? rec.wrap : DEFAULT_PREFS.wrap,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: LayoutPrefs): void {
  try {
    window.localStorage.setItem(PR_REVIEW_STORAGE.layout, JSON.stringify(prefs));
  } catch {
    // storage unavailable: preferences simply don't persist
  }
}

interface CollapseState {
  diff: FilesViewProps["diff"];
  scope: string;
  set: ReadonlySet<number>;
}

export function FilesView({ diff, viewedScopeKey }: FilesViewProps) {
  const { viewed, toggle } = usePrViewedFiles(viewedScopeKey);
  const rootRef = useRef<HTMLDivElement>(null);
  const diffsRef = useRef<HTMLDivElement>(null);

  const [wide, setWide] = useState(false);
  const [prefs, setPrefs] = useState<LayoutPrefs>(loadPrefs);
  const [filter, setFilter] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeState, setActiveState] = useState<number | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ index: number } | null>(null);

  // Collapsed set: initialised once per diff/scope from the viewed files, then user-driven.
  const [collapseState, setCollapseState] = useState<CollapseState>(() => ({
    diff,
    scope: viewedScopeKey,
    set: new Set(diff.files.filter((f) => viewed.has(f.path)).map((f) => f.index)),
  }));
  let collapsed = collapseState.set;
  if (collapseState.diff !== diff || collapseState.scope !== viewedScopeKey) {
    collapsed = new Set(diff.files.filter((f) => viewed.has(f.path)).map((f) => f.index));
    setCollapseState({ diff, scope: viewedScopeKey, set: collapsed });
  }

  const viewedRef = useRef(viewed);
  useEffect(() => {
    viewedRef.current = viewed;
  }, [viewed]);

  // Width tracking.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = (width: number) => {
      const isWide = width >= PR_REVIEW_WIDE_MIN_PX;
      setWide(isWide);
      if (isWide) setDrawerOpen(false);
    };
    update(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) update(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const trimmedFilter = filter.trim();
  const visible = useMemo<DiffFile[]>(() => {
    if (!trimmedFilter) return diff.files;
    const needle = trimmedFilter.toLowerCase();
    return diff.files.filter((f) => f.path.toLowerCase().includes(needle));
  }, [diff.files, trimmedFilter]);

  const activeIndex =
    activeState !== null && visible.some((f) => f.index === activeState) ? activeState : (visible[0]?.index ?? null);

  // Active-file tracking: the topmost section crossing the top 30% of the scroll container.
  useEffect(() => {
    const root = diffsRef.current;
    if (!root || typeof IntersectionObserver === "undefined" || visible.length === 0) return;
    const byElement = new Map<Element, number>();
    const intersecting = new Set<number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = byElement.get(entry.target);
          if (index === undefined) continue;
          if (entry.isIntersecting) intersecting.add(index);
          else intersecting.delete(index);
        }
        if (intersecting.size === 0) return;
        setActiveState(Math.min(...intersecting));
      },
      { root, rootMargin: "0px 0px -70% 0px" },
    );
    for (const file of visible) {
      const el = document.getElementById(prReviewFileDomId(file.index));
      if (!el) continue;
      byElement.set(el, file.index);
      io.observe(el);
    }
    return () => io.disconnect();
  }, [visible]);

  // Scroll to a selected file after the commit that un-collapsed it.
  useEffect(() => {
    if (!scrollTarget) return;
    const el = document.getElementById(prReviewFileDomId(scrollTarget.index));
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" });
  }, [scrollTarget]);

  const effectiveLayout: DiffLayout = wide ? prefs.layout : "unified";

  const updatePrefs = (patch: Partial<LayoutPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };

  const onToggleCollapsed = useCallback((index: number) => {
    setCollapseState((prev) => {
      const set = new Set(prev.set);
      if (!set.delete(index)) set.add(index);
      return { ...prev, set };
    });
  }, []);

  const onToggleViewed = useCallback(
    (path: string) => {
      const wasViewed = viewedRef.current.has(path);
      toggle(path);
      const file = diff.files.find((f) => f.path === path);
      if (!file) return;
      setCollapseState((prev) => {
        const set = new Set(prev.set);
        if (wasViewed) set.delete(file.index);
        else set.add(file.index);
        return { ...prev, set };
      });
    },
    [toggle, diff.files],
  );

  const onSelect = useCallback((index: number) => {
    setCollapseState((prev) => {
      if (!prev.set.has(index)) return prev;
      const set = new Set(prev.set);
      set.delete(index);
      return { ...prev, set };
    });
    setActiveState(index);
    setDrawerOpen(false);
    setScrollTarget({ index });
  }, []);

  const allVisibleCollapsed = visible.length > 0 && visible.every((f) => collapsed.has(f.index));
  const onCollapseAll = () => {
    setCollapseState((prev) => {
      const set = new Set(prev.set);
      for (const f of visible) {
        if (allVisibleCollapsed) set.delete(f.index);
        else set.add(f.index);
      }
      return { ...prev, set };
    });
  };

  const rootClass = ["pr-review-files", wide ? "is-wide" : "", prefs.wrap ? "is-wrapped" : ""].filter(Boolean).join(" ");

  if (diff.files.length === 0) {
    return (
      <div ref={rootRef} className={rootClass}>
        <p className="pr-review-empty-note">No file changes in this pull request.</p>
      </div>
    );
  }

  const total = diff.files.length;
  const viewedCount = diff.files.reduce((n, f) => (viewed.has(f.path) ? n + 1 : n), 0);
  const percent = Math.round((viewedCount / total) * 100);

  return (
    <div ref={rootRef} className={rootClass}>
      <div className="pr-review-toolbar">
        {!wide && (
          <button
            type="button"
            className="btn-ghost pr-review-button pr-review-files-toggle"
            aria-expanded={drawerOpen}
            aria-controls={DRAWER_ID}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {`Files (${visible.length})`}
          </button>
        )}
        <input
          type="search"
          className="pr-review-filter"
          aria-label={REVIEW_LABELS.filter}
          placeholder="Filter files…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="pr-review-viewed-progress">
          <span>{`${viewedCount} / ${total} viewed`}</span>
          <span className="pr-review-viewed-bar">
            <span className="pr-review-viewed-fill" style={{ width: `${percent}%` }} />
          </span>
        </span>
        {wide && (
          <div className="pr-review-segmented" role="group" aria-label={REVIEW_LABELS.layoutGroup}>
            <button type="button" aria-pressed={effectiveLayout === "unified"} onClick={() => updatePrefs({ layout: "unified" })}>
              Unified
            </button>
            <button type="button" aria-pressed={effectiveLayout === "split"} onClick={() => updatePrefs({ layout: "split" })}>
              Split
            </button>
          </div>
        )}
        {effectiveLayout === "unified" && (
          <button
            type="button"
            className="btn-ghost pr-review-button"
            aria-pressed={prefs.wrap}
            onClick={() => updatePrefs({ wrap: !prefs.wrap })}
          >
            Wrap
          </button>
        )}
        <button type="button" className="btn-ghost pr-review-button" disabled={visible.length === 0} onClick={onCollapseAll}>
          {allVisibleCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>
      <div className="pr-review-files-body">
        {wide && (
          <aside className="pr-review-sidebar">
            <FileList files={visible} activeIndex={activeIndex} viewed={viewed} onSelect={onSelect} />
          </aside>
        )}
        {!wide && drawerOpen && (
          <div className="pr-review-drawer" id={DRAWER_ID}>
            <FileList files={visible} activeIndex={activeIndex} viewed={viewed} onSelect={onSelect} />
          </div>
        )}
        <div ref={diffsRef} className="pr-review-diffs">
          {visible.length === 0 ? (
            <p className="pr-review-empty-note">{`No files match “${trimmedFilter}”.`}</p>
          ) : (
            visible.map((file) => (
              <FileDiff
                key={file.index}
                file={file}
                layout={effectiveLayout}
                collapsed={collapsed.has(file.index)}
                viewed={viewed.has(file.path)}
                active={file.index === activeIndex}
                onToggleCollapsed={onToggleCollapsed}
                onToggleViewed={onToggleViewed}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
