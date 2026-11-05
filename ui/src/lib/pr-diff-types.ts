/**
 * Structured model of a unified diff (GitHub `application/vnd.github.v3.diff`).
 * Produced by `parseUnifiedDiff` (`./pr-diff`), consumed by the PR review UI.
 * All text is untrusted and must only ever be rendered as React text nodes.
 */

export type DiffLineKind = "context" | "add" | "delete";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content without the leading `+` / `-` / ` ` marker and without the trailing `\n`. */
  text: string;
  /** 1-based line number in the old file; null for `add` lines. */
  oldNumber: number | null;
  /** 1-based line number in the new file; null for `delete` lines. */
  newNumber: number | null;
  /** True when the diff marks this line with `\ No newline at end of file`. */
  noNewlineAtEnd: boolean;
}

export interface DiffHunk {
  /** The full `@@ -a,b +c,d @@ section` line, verbatim. */
  header: string;
  /** Text after the closing `@@`, trimmed (often the enclosing function); "" when absent. */
  section: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export interface DiffFile {
  /** Position in the diff, 0-based. Stable for a given diff string. */
  index: number;
  /** Path before the change (no `a/` prefix); null for added files. */
  oldPath: string | null;
  /** Path after the change (no `b/` prefix); null for deleted files. */
  newPath: string | null;
  /** Display/identity path: `newPath ?? oldPath`. Never empty. */
  path: string;
  status: DiffFileStatus;
  binary: boolean;
  modeChange: { oldMode: string; newMode: string } | null;
  /** `similarity index N%` for renames/copies; null when absent. */
  similarity: number | null;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** Total number of DiffLine entries across all hunks of all files. */
  lineCount: number;
}

/** One visual row of the side-by-side layout. Context lines appear on both sides (same object). */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Half-open [start, end) UTF-16 range inside `DiffLine.text` that changed within a paired line. */
export type EmphasisRange = readonly [start: number, end: number];

/** `parseUnifiedDiff` in `./pr-diff`. Returns null when the input cannot be parsed safely (caller shows raw text). Never throws. */
export type ParseUnifiedDiff = (diff: string) => ParsedDiff | null;
/** `toSplitRows` in `./pr-diff-split`. */
export type ToSplitRows = (hunk: DiffHunk) => SplitRow[];
/** `emphasisByLine` in `./pr-diff-split`. Keys are DiffLine objects of `hunk.lines` (identity). */
export type EmphasisByLine = (hunk: DiffHunk) => ReadonlyMap<DiffLine, EmphasisRange>;

/** Parser refuses (returns null) above this many diff lines. */
export const PR_DIFF_MAX_LINES = 200_000;
/** Files with more changed lines (additions + deletions) than this are not rendered until the user asks. */
export const PR_DIFF_LARGE_FILE_LINES = 400;
/** Lockfiles / generated artifacts: not rendered until the user asks. Tested against `DiffFile.path`. */
export const PR_DIFF_GENERATED_FILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.min\.(js|css)$|\.snap$/;
