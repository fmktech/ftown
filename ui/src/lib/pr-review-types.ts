/**
 * Frozen contract for the PR review panel: hook state, component props, copy, glyphs,
 * storage keys and the DOM/class-name catalogue shared by components and CSS.
 *
 * Rules for everything rendered from this contract:
 * - PR title, body, branch names, paths and diff text are untrusted: render as React text only
 *   (no dangerouslySetInnerHTML, no inline <svg>/<img>; icons are the unicode glyphs below).
 * - Accessible names listed here are asserted by e2e and must not change.
 */
import type { PrReviewMetadata, PrReviewUnavailableReason } from "../../../bridge/src/pull-request-review-protocol";
import type { PullRequestStatus } from "../../../bridge/src/pull-request-status-protocol";
import type { PullRequestReference } from "./pull-request-url";
import type { DiffFile, DiffHunk, ParsedDiff } from "./pr-diff-types";

// ---------------------------------------------------------------------------
// Hook state (`usePullRequestReview` in `@/hooks/usePullRequestReview` re-exports ReviewState)

/** Refresh failures that keep the previously loaded data on screen. Any other failure replaces it. */
export type ReviewRefreshFailure = "timeout" | "rate_limited" | "unavailable" | "error";

export type ReviewState =
  | { kind: "no_link" | "old_bridge" | "offline" | "loading" | "error" }
  | { kind: "unavailable"; reason: PrReviewUnavailableReason }
  | {
      kind: "ready";
      metadata: PrReviewMetadata;
      diff: string;
      /** A background revalidation is in flight; data stays visible. */
      refreshing: boolean;
      /** Last background revalidation failed softly; data shown is from `metadata.fetchedAt`. */
      refreshFailed: ReviewRefreshFailure | null;
    };

export type ReviewNonReadyState = Exclude<ReviewState, { kind: "ready" }>;

// ---------------------------------------------------------------------------
// Component props (components live in `@/components/pr-review/*`)

export type DiffLayout = "unified" | "split";

/** `ReviewHeader` — panel header: title row, meta row, actions, refresh progress. */
export interface ReviewHeaderProps {
  /** null while not ready: render the minimal header (fallback title, actions only). */
  metadata: PrReviewMetadata | null;
  /** Validated reference parsed from the session's PR URL; null when unparsable. */
  pullRequest: PullRequestReference | null;
  /** Cached CI status for the PR from PullRequestStatusProvider. */
  checks: PullRequestStatus | undefined;
  refreshing: boolean;
  canRefresh: boolean;
  expanded: boolean;
  /** Epoch ms used for relative times; supplied by the parent (ticks every 30s). */
  now: number;
  onRefresh(): void;
  onToggleExpand(): void;
  onClose(): void;
}

/** `ReviewStatusView` — skeleton for `loading`, empty-state card for everything else. */
export interface ReviewStatusViewProps {
  state: ReviewNonReadyState;
  /** Validated PR URL for the secondary "View on GitHub" link; null hides it. */
  pullRequestUrl: string | null;
  onRetry(): void;
}

/** `FileList` — navigable list of changed files (already filtered by the parent). */
export interface FileListProps {
  files: readonly DiffFile[];
  /** `DiffFile.index` of the file currently in view; null when none. */
  activeIndex: number | null;
  /** Set of `DiffFile.path` values marked viewed. */
  viewed: ReadonlySet<string>;
  onSelect(index: number): void;
}

/** `DiffTable` — the line table for one file's hunks. Must be wrapped in React.memo. */
export interface DiffTableProps {
  hunks: readonly DiffHunk[];
  layout: DiffLayout;
  /** File path, used for the table's accessible name. */
  label: string;
}

/** `FileDiff` — one file card (sticky header + body). Must be wrapped in React.memo. */
export interface FileDiffProps {
  file: DiffFile;
  layout: DiffLayout;
  collapsed: boolean;
  viewed: boolean;
  active: boolean;
  /** Called with `file.index`. */
  onToggleCollapsed(index: number): void;
  /** Called with `file.path`. */
  onToggleViewed(path: string): void;
}

/** `FilesView` — toolbar + file list + file cards; owns filter/layout/collapse/viewed/active state. */
export interface FilesViewProps {
  diff: ParsedDiff;
  /** `${metadata.url}@${metadata.headOid}` — scopes the viewed-files memory. */
  viewedScopeKey: string;
}

/** `usePrViewedFiles(scopeKey)` in `@/hooks/usePrViewedFiles`. */
export interface ViewedFiles {
  /** Paths marked viewed for the current scope. New Set identity on every change. */
  viewed: ReadonlySet<string>;
  /** Stable identity for a given scopeKey. No-op when scopeKey is null. */
  toggle(path: string): void;
}
export type UsePrViewedFiles = (scopeKey: string | null) => ViewedFiles;

// ---------------------------------------------------------------------------
// Shared helpers

export type DiffBarSegment = "add" | "del" | "neutral";

/** Five-block diffstat bar (rendered as `span.pr-review-bar-seg.is-<segment>`). */
export function diffBarSegments(additions: number, deletions: number): DiffBarSegment[] {
  const total = additions + deletions;
  const filled = Math.min(5, total);
  let add = total === 0 ? 0 : Math.round((filled * additions) / total);
  if (additions > 0 && add === 0) add = 1;
  if (deletions > 0 && add === filled && filled > 1) add = filled - 1;
  return [...Array<DiffBarSegment>(add).fill("add"), ...Array<DiffBarSegment>(filled - add).fill("del"), ...Array<DiffBarSegment>(5 - filled).fill("neutral")];
}

export const prReviewFileDomId = (index: number) => `pr-review-file-${index}`;
export const prReviewFileBodyDomId = (index: number) => `pr-review-file-${index}-body`;

export const PR_REVIEW_STORAGE = {
  /** + scopeKey → JSON string[] of viewed paths. */
  viewedPrefix: "ftown.prReview.viewed.v1:",
  /** JSON string[] of scopeKeys, most recently used first. */
  viewedIndex: "ftown.prReview.viewed.v1:index",
  /** JSON { layout: DiffLayout; wrap: boolean }. */
  layout: "ftown.prReview.layout.v1",
} as const;
export const PR_REVIEW_VIEWED_MAX_SCOPES = 50;
/** FilesView container width (px) at/above which the sidebar and split layout are available. */
export const PR_REVIEW_WIDE_MIN_PX = 860;

export const REVIEW_GLYPHS = {
  refresh: "↻",
  close: "×",
  expand: "⊞",
  collapse: "⊟",
  external: "↗",
  chevronOpen: "▾",
  chevronClosed: "▸",
  copy: "⧉",
  check: "✓",
  arrow: "→",
  eof: "⊘",
} as const;

/** Accessible names asserted by e2e / smoke specs. Do not change. */
export const REVIEW_LABELS = {
  panel: "PR review",
  openOnGitHub: "Open on GitHub",
  viewOnGitHub: "View on GitHub",
  refresh: "Refresh PR review",
  expand: "Expand PR review",
  collapse: "Collapse PR review",
  close: "Close PR review",
  fileNav: "Changed files",
  sections: "Review sections",
  filesTab: "Files changed",
  descriptionTab: "Description",
  filter: "Filter changed files",
  layoutGroup: "Diff layout",
  copyPath: "Copy file path",
  eof: "No newline at end of file",
} as const;

export interface ReviewCopy {
  glyph: string;
  title: string;
  detail: string;
}

/** Titles are the pre-existing strings (some are asserted by tests); keep them verbatim. */
export const REVIEW_STATE_COPY: Record<Exclude<ReviewNonReadyState["kind"], "unavailable">, ReviewCopy> = {
  loading: { glyph: "", title: "Loading pull request…", detail: "" },
  no_link: { glyph: "∅", title: "No pull request is linked to this session.", detail: "Link a pull request to this session to review it here." },
  old_bridge: { glyph: "↑", title: "This bridge needs an update or the pull request must be relinked before review.", detail: "Update ftown-bridge on the machine running this session, then relink the pull request." },
  offline: { glyph: "⋯", title: "Reconnect and restore read access to load this pull request.", detail: "The review loads automatically once the bridge is reachable again." },
  error: { glyph: "!", title: "Could not load pull request.", detail: "Something went wrong while transferring the diff from the bridge." },
};

export const REVIEW_UNAVAILABLE_COPY: Record<PrReviewUnavailableReason, ReviewCopy> = {
  unlinked: { glyph: "∅", title: "No pull request is linked to this session.", detail: "Link a pull request to this session to review it here." },
  unauthenticated: { glyph: "!", title: "GitHub authentication is unavailable on this bridge.", detail: "Run `gh auth login` on the bridge machine, then retry." },
  rate_limited: { glyph: "!", title: "GitHub rate limit reached. Try again later.", detail: "GitHub is throttling the account signed in on this bridge. Retry in a few minutes." },
  not_found_or_forbidden: { glyph: "!", title: "Pull request not found or access denied.", detail: "The GitHub account signed in on this bridge can't see this pull request." },
  timeout: { glyph: "!", title: "Pull request request timed out.", detail: "GitHub took too long to respond. Retry in a moment." },
  too_large: { glyph: "!", title: "Pull request is too large to display.", detail: "Diffs over 1 MB can't be shown here. Open it on GitHub instead." },
  unsupported: { glyph: "!", title: "This pull request cannot be displayed.", detail: "Only github.com pull requests can be reviewed here." },
  stale: { glyph: "!", title: "The pull request changed while loading. Refresh to try again.", detail: "New commits landed while the diff was loading." },
  unavailable: { glyph: "!", title: "Pull request is unavailable.", detail: "The bridge couldn't load this pull request. Retry in a moment." },
};

export const REVIEW_REFRESH_FAILED_COPY: Record<ReviewRefreshFailure, string> = {
  timeout: "GitHub timed out",
  rate_limited: "GitHub rate limit reached",
  unavailable: "the bridge couldn't reach GitHub",
  error: "the transfer failed",
};

export const REVIEW_PR_STATE_LABEL: Record<PrReviewMetadata["state"], string> = { open: "Open", merged: "Merged", closed: "Closed" };

/** Checks chip. `merged`/`closed` statuses render no chip (the state pill covers them). */
export const REVIEW_CHECKS_LABEL = {
  passed: "Checks passed",
  failed: "Checks failing",
  in_progress: "Checks running",
  unknown: "Checks unknown",
} as const;

/**
 * DOM / class-name catalogue (CSS in ui/src/app/globals.css, "Read-only pull request review" block).
 * Modifier classes are written `.is-*`. Existing shared classes: `btn-ghost`.
 *
 * Shell (PullRequestReview.tsx)
 *   section#session-review-panel.session-review-pane.pr-review-root[role=tabpanel][aria-label="PR review"][hidden]
 *     <ReviewHeader/>
 *     div.pr-review-banner[role=status]                     soft refresh failure
 *       span.pr-review-banner-text + button.btn-ghost.pr-review-button "Retry"
 *     div.pr-review-sections[role=tablist][aria-label="Review sections"]
 *       button.pr-review-section-tab[role=tab][aria-selected][aria-controls]  "Files changed" + span.pr-review-count, "Description"
 *     div.pr-review-main                                   flex:1 column, min-height:0
 *       <FilesView/> | div.pr-review-description[role=tabpanel] > div.pr-review-body (pre-wrap prose) | p.pr-review-empty-note
 *       raw fallback: div.pr-review-raw-wrap > p.pr-review-raw-notice + pre.pr-review-raw > span.pr-diff-add|pr-diff-delete|pr-diff-hunk|(plain) per line
 *     <ReviewStatusView/> for non-ready states (inside .pr-review-main)
 *   span.pr-review-sr-only                                  visually hidden text (any component)
 *
 * ReviewHeader
 *   header.pr-review-header
 *     div.pr-review-header-top
 *       span.pr-review-state.is-open|is-merged|is-closed   pill
 *       h2.pr-review-title[title]                          one line, ellipsis
 *       span.pr-review-number                              "#123"
 *       div.pr-review-actions
 *         a.pr-review-link[target=_blank][rel="noopener noreferrer"]  "Open on GitHub" + span.pr-review-glyph[aria-hidden] "↗"
 *         button.btn-ghost.pr-review-icon (refresh; inner span.pr-review-glyph.is-spinning while refreshing), (expand/collapse), (close)
 *     div.pr-review-meta                                   wraps; small text
 *       span.pr-review-meta-item.pr-review-author          "@login"
 *       span.pr-review-meta-item.pr-review-branches > code.pr-review-branch (head) + span.pr-review-arrow "→" + code.pr-review-branch (base)
 *       span.pr-review-meta-item.pr-review-checks.is-passed|is-failed|is-running|is-unknown > span.pr-review-dot + label
 *       span.pr-review-meta-item.pr-review-stat > span.pr-review-add "+12" span.pr-review-del "−3" <DiffBar/>
 *       span.pr-review-meta-item "4 files"
 *       time.pr-review-meta-item.pr-review-fetched[dateTime][title]  "Fetched 2m ago"
 *     div.pr-review-progress                               2px indeterminate bar, only while refreshing
 *   DiffBar (also used in FileDiff): span.pr-review-bar[aria-hidden] > 5 × span.pr-review-bar-seg.is-add|is-del|is-neutral
 *
 * ReviewStatusView
 *   loading: div.pr-review-skeleton[role=status][aria-busy=true] > span.pr-review-sr-only "Loading pull request…"
 *            + div.pr-review-skel-line.is-title, div.pr-review-skel-line.is-short, 3 × div.pr-review-skel-card > 4 × div.pr-review-skel-line
 *   other:   div.pr-review-empty[role=status] > span.pr-review-empty-glyph[aria-hidden] + p.pr-review-empty-title + p.pr-review-empty-detail
 *            + div.pr-review-empty-actions > button.btn-ghost.pr-review-button "Retry" + a.pr-review-link "View on GitHub"
 *
 * FilesView
 *   div.pr-review-files(.is-wide)(.is-wrapped)
 *     div.pr-review-toolbar
 *       button.btn-ghost.pr-review-button.pr-review-files-toggle[aria-expanded][aria-controls]  narrow only, "Files (12)"
 *       input.pr-review-filter[type=search][aria-label="Filter changed files"][placeholder="Filter files…"]
 *       span.pr-review-viewed-progress > span "3 / 12 viewed" + span.pr-review-viewed-bar > span.pr-review-viewed-fill[style.width]
 *       div.pr-review-segmented[role=group][aria-label="Diff layout"] > button[aria-pressed] "Unified" | "Split"   wide only
 *       button.btn-ghost.pr-review-button[aria-pressed] "Wrap"
 *       button.btn-ghost.pr-review-button "Collapse all" | "Expand all"
 *     div.pr-review-files-body
 *       aside.pr-review-sidebar > <FileList/>                wide only
 *       div.pr-review-drawer#pr-review-file-drawer > <FileList/>   narrow, when toggled open
 *       div.pr-review-diffs                                 the scroll container (overflow:auto); FileDiff headers stick to its top
 *         <FileDiff/>* | p.pr-review-empty-note
 *
 * FileList
 *   nav.pr-review-filelist[aria-label="Changed files"] > ul > li >
 *     button.pr-review-filelist-item(.is-viewed)[aria-label=path][title=path][aria-current=true when active]
 *       span.pr-review-status-letter.is-added|is-deleted|is-modified|is-renamed|is-copied   "A" "D" "M" "R" "C"
 *       span.pr-review-filelist-name > span.pr-review-filelist-base + span.pr-review-filelist-dir
 *       span.pr-review-filelist-counts > span.pr-review-add + span.pr-review-del
 *       span.pr-review-filelist-viewed[aria-hidden] "✓"   only when viewed
 *
 * FileDiff
 *   section.pr-review-file(.is-active)(.is-viewed)(.is-collapsed)#pr-review-file-N[aria-label=path]
 *     div.pr-review-file-header                           position:sticky; top:0
 *       button.pr-review-file-toggle[aria-expanded][aria-controls=body id][aria-label="Collapse <path>"|"Expand <path>"] > span.pr-review-chevron "▾"|"▸"
 *       span.pr-review-file-status.is-added|is-deleted|is-modified|is-renamed|is-copied   "Added" "Deleted" "Modified" "Renamed" "Copied"
 *       h3.pr-review-file-path[title] > span.pr-review-file-dir + span.pr-review-file-base      (renamed/copied: span.pr-review-file-old + " → " + span.pr-review-file-new)
 *       button.btn-ghost.pr-review-icon.pr-review-copy[aria-label="Copy file path"] "⧉" (shows "Copied" for 1.5s)
 *       span.pr-review-file-counts > span.pr-review-add + span.pr-review-del + <DiffBar/>
 *       label.pr-review-viewed-toggle > input[type=checkbox] + "Viewed"
 *     div.pr-review-file-body#pr-review-file-N-body          absent while collapsed
 *       p.pr-review-file-note (+ button.btn-ghost.pr-review-button "Load diff")  binary / mode-only / rename-only / large / generated
 *       div.pr-review-diff-scroll > <DiffTable/>             horizontal scroll per file
 *
 * DiffTable
 *   table.pr-review-diff.is-unified|is-split[aria-label="Diff for <path>"] > tbody
 *     tr.pr-review-hunk > td[colSpan=3|4] "@@ -a,b +c,d @@ section"
 *     unified: tr.pr-review-line.is-add|is-del|is-ctx > td.pr-review-num (old) + td.pr-review-num (new)
 *              + td.pr-review-code > span.pr-review-sign "+"|"-"|" " + span.pr-review-text (text, optional mark.pr-review-emph)
 *              + span.pr-review-eof[title][aria-label="No newline at end of file"] "⊘" when noNewlineAtEnd
 *     split:   tr.pr-review-line.is-split > td.pr-review-num.is-del|is-ctx|is-empty + td.pr-review-code.is-del|is-ctx|is-empty
 *              + td.pr-review-num.is-add|is-ctx|is-empty + td.pr-review-code.is-add|is-ctx|is-empty
 *              (split code cells hold the same span.pr-review-text / mark.pr-review-emph / span.pr-review-eof children; no sign span)
 */
