import type { DiffHunk, DiffLine, EmphasisRange, SplitRow } from "@/lib/pr-diff-types";

/** Lines longer than this are never intra-line emphasised (keeps the pairing cost bounded). */
const EMPHASIS_MAX_LINE_LENGTH = 1000;
/** A pair whose changed span exceeds this share of its line on both sides is a rewrite, not an edit. */
const EMPHASIS_MAX_SPAN_RATIO = 0.7;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Side-by-side rows for one hunk. A change block (maximal run of non-context lines) pairs its
 * deletions and additions by position; the shorter side is padded with null.
 */
export function toSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    const count = Math.max(dels.length, adds.length);
    for (let k = 0; k < count; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "context") {
      flush();
      rows.push({ left: line, right: line });
    } else if (line.kind === "delete") {
      dels.push(line);
    } else {
      adds.push(line);
    }
  }
  flush();
  return rows;
}

/**
 * Changed sub-ranges of paired lines. Only change blocks with equal delete/add counts are paired
 * (position i with position i). Context lines never receive an entry.
 */
export function emphasisByLine(hunk: DiffHunk): ReadonlyMap<DiffLine, EmphasisRange> {
  const map = new Map<DiffLine, EmphasisRange>();
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    if (dels.length > 0 && dels.length === adds.length) {
      for (let k = 0; k < dels.length; k++) {
        const del = dels[k];
        const add = adds[k];
        if (del && add) emphasisPair(del, add, map);
      }
    }
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "context") {
      flush();
    } else if (line.kind === "delete") {
      dels.push(line);
    } else {
      adds.push(line);
    }
  }
  flush();
  return map;
}

function emphasisPair(del: DiffLine, add: DiffLine, map: Map<DiffLine, EmphasisRange>): void {
  const a = del.text;
  const b = add.text;
  if (a.length > EMPHASIS_MAX_LINE_LENGTH || b.length > EMPHASIS_MAX_LINE_LENGTH) return;

  const minLength = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < minLength && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  const maxSuffix = minLength - prefix;
  while (
    suffix < maxSuffix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) {
    suffix++;
  }

  if (prefix > 0 && (isHighSurrogate(a.charCodeAt(prefix - 1)) || isHighSurrogate(b.charCodeAt(prefix - 1)))) {
    prefix--;
  }
  if (suffix > 0 && (isLowSurrogate(a.charCodeAt(a.length - suffix)) || isLowSurrogate(b.charCodeAt(b.length - suffix)))) {
    suffix--;
  }

  const oldSpan = a.length - prefix - suffix;
  const newSpan = b.length - prefix - suffix;
  if (oldSpan > a.length * EMPHASIS_MAX_SPAN_RATIO && newSpan > b.length * EMPHASIS_MAX_SPAN_RATIO) return;

  const oldEnd = a.length - suffix;
  const newEnd = b.length - suffix;
  if (oldEnd > prefix) map.set(del, [prefix, oldEnd]);
  if (newEnd > prefix) map.set(add, [prefix, newEnd]);
}
