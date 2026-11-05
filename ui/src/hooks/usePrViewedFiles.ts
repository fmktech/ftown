"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PR_REVIEW_STORAGE, PR_REVIEW_VIEWED_MAX_SCOPES, type ViewedFiles } from "@/lib/pr-review-types";

const EMPTY: ReadonlySet<string> = new Set<string>();

interface ViewedState {
  scopeKey: string | null;
  set: ReadonlySet<string>;
}

function readItem(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: state stays in memory only.
  }
}

function parseStringArray(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string") ? value : [];
  } catch {
    return [];
  }
}

/** MRU scope index, deduplicated so a corrupt index cannot occupy several slots of the cap. */
function readIndex(): string[] {
  return [...new Set(parseStringArray(readItem(PR_REVIEW_STORAGE.viewedIndex)))];
}

function loadViewed(scopeKey: string | null): ReadonlySet<string> {
  if (scopeKey === null) return EMPTY;
  return new Set(parseStringArray(readItem(PR_REVIEW_STORAGE.viewedPrefix + scopeKey)));
}

function persistViewed(scopeKey: string, viewed: ReadonlySet<string>): void {
  writeItem(PR_REVIEW_STORAGE.viewedPrefix + scopeKey, viewed.size === 0 ? null : JSON.stringify([...viewed]));
  const others = readIndex().filter((key) => key !== scopeKey);
  if (viewed.size === 0) {
    writeItem(PR_REVIEW_STORAGE.viewedIndex, JSON.stringify(others));
    return;
  }
  const index = [scopeKey, ...others];
  for (const evicted of index.slice(PR_REVIEW_VIEWED_MAX_SCOPES)) {
    writeItem(PR_REVIEW_STORAGE.viewedPrefix + evicted, null);
  }
  writeItem(PR_REVIEW_STORAGE.viewedIndex, JSON.stringify(index.slice(0, PR_REVIEW_VIEWED_MAX_SCOPES)));
}

/** Viewed-file paths for one PR scope, persisted to localStorage (MRU-capped across scopes). */
export function usePrViewedFiles(scopeKey: string | null): ViewedFiles {
  const [state, setState] = useState<ViewedState>(() => ({ scopeKey, set: loadViewed(scopeKey) }));
  // Mirrors the set currently displayed; updated synchronously by toggle so that
  // several toggles in one batch compose, and re-synced to the committed state after each commit.
  const shown = useRef<ViewedState>(state);

  let current = state;
  if (state.scopeKey !== scopeKey) {
    current = { scopeKey, set: loadViewed(scopeKey) };
    setState(current);
  }

  useEffect(() => {
    shown.current = current;
  });

  const toggle = useCallback(
    (path: string) => {
      if (scopeKey === null) return;
      const base = shown.current.scopeKey === scopeKey ? shown.current.set : loadViewed(scopeKey);
      const next = new Set(base);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      persistViewed(scopeKey, next);
      const nextState: ViewedState = { scopeKey, set: next };
      shown.current = nextState;
      setState(nextState);
    },
    [scopeKey],
  );

  return { viewed: current.set, toggle };
}
