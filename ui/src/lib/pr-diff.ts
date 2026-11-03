import {
  PR_DIFF_MAX_LINES,
  type DiffFile,
  type DiffFileStatus,
  type DiffHunk,
  type DiffLine,
  type ParsedDiff,
} from "@/lib/pr-diff-types";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([^]*)$/;
const DEV_NULL = "/dev/null";
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  "\\": 0x5c,
  '"': 0x22,
  t: 0x09,
  n: 0x0a,
  r: 0x0d,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  v: 0x0b,
};

interface Quoted {
  value: string;
  /** Index just past the closing quote. */
  end: number;
}

/** C-unquotes the `"..."` token starting at `start` (which must be a quote). Null when malformed. */
function parseQuoted(s: string, start: number): Quoted | null {
  if (s[start] !== '"') return null;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = start + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      return { value: new TextDecoder("utf-8").decode(Uint8Array.from(bytes)), end: i + 1 };
    }
    if (ch === "\\") {
      const next = s[i + 1];
      if (next === undefined) return null;
      if (next >= "0" && next <= "7") {
        let j = i + 1;
        let digits = "";
        while (j < s.length && digits.length < 3 && s[j] >= "0" && s[j] <= "7") {
          digits += s[j];
          j += 1;
        }
        const code = parseInt(digits, 8);
        if (code > 0xff) return null;
        bytes.push(code);
        i = j;
        continue;
      }
      const code = SIMPLE_ESCAPES[next];
      if (code === undefined) return null;
      bytes.push(code);
      i += 2;
      continue;
    }
    // Copy the full code point (surrogate pairs included) as UTF-8.
    const cp = s.codePointAt(i) ?? 0;
    const unit = String.fromCodePoint(cp);
    for (const b of encoder.encode(unit)) bytes.push(b);
    i += unit.length;
  }
  return null;
}

/** Parses a `---` / `+++` path operand. `undefined` = malformed quoting; `null` = /dev/null or empty. */
function parseMarkerPath(raw: string, prefix: "a/" | "b/"): string | null | undefined {
  let p = raw;
  if (p.startsWith('"')) {
    const q = parseQuoted(p, 0);
    if (!q) return undefined;
    p = q.value;
  } else {
    const tab = p.indexOf("\t");
    if (tab >= 0) p = p.slice(0, tab);
  }
  if (p === DEV_NULL) return null;
  if (p.startsWith(prefix)) p = p.slice(2);
  return p === "" ? null : p;
}

function stripPrefix(p: string, prefix: "a/" | "b/"): string | null {
  const out = p.startsWith(prefix) ? p.slice(2) : p;
  return out === "" ? null : out;
}

/** Best-effort paths from a `diff --git` header; empty when ambiguous or malformed. */
function parseGitHeaderPaths(rest: string): { oldPath: string | null; newPath: string | null } {
  const none = { oldPath: null, newPath: null };
  if (rest.startsWith('"')) {
    const first = parseQuoted(rest, 0);
    if (!first || rest[first.end] !== " ") return none;
    const tail = first.end + 1;
    let second: string;
    if (rest[tail] === '"') {
      const q = parseQuoted(rest, tail);
      if (!q || q.end !== rest.length) return none;
      second = q.value;
    } else {
      second = rest.slice(tail);
    }
    return { oldPath: stripPrefix(first.value, "a/"), newPath: stripPrefix(second, "b/") };
  }
  const len = rest.length;
  if (len < 5 || (len - 5) % 2 !== 0) return none;
  const n = (len - 5) / 2;
  const x = rest.slice(2, 2 + n);
  if (x === "" || rest !== `a/${x} b/${x}`) return none;
  return { oldPath: x, newPath: x };
}

interface FileState {
  headerOld: string | null;
  headerNew: string | null;
  minusPath: string | null;
  minusNull: boolean;
  plusPath: string | null;
  plusNull: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  copyFrom: string | null;
  copyTo: string | null;
  added: boolean;
  deleted: boolean;
  binary: boolean;
  oldMode: string | null;
  newMode: string | null;
  similarity: number | null;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

function newFileState(headerRest: string): FileState {
  const h = parseGitHeaderPaths(headerRest);
  return {
    headerOld: h.oldPath,
    headerNew: h.newPath,
    minusPath: null,
    minusNull: false,
    plusPath: null,
    plusNull: false,
    renameFrom: null,
    renameTo: null,
    copyFrom: null,
    copyTo: null,
    added: false,
    deleted: false,
    binary: false,
    oldMode: null,
    newMode: null,
    similarity: null,
    hunks: [],
    additions: 0,
    deletions: 0,
  };
}

function finalizeFile(s: FileState, index: number): DiffFile | null {
  let oldPath = s.renameFrom ?? s.copyFrom ?? s.minusPath ?? s.headerOld;
  let newPath = s.renameTo ?? s.copyTo ?? s.plusPath ?? s.headerNew;
  if (s.minusNull) oldPath = null;
  if (s.plusNull) newPath = null;
  if (s.added) oldPath = null;
  if (s.deleted) newPath = null;
  const path = newPath ?? oldPath;
  if (!path) return null;
  const renamed = s.renameFrom !== null || s.renameTo !== null;
  const copied = s.copyFrom !== null || s.copyTo !== null;
  let status: DiffFileStatus;
  if (renamed) status = "renamed";
  else if (copied) status = "copied";
  else if (s.added || oldPath === null) status = "added";
  else if (s.deleted || newPath === null) status = "deleted";
  else status = "modified";
  return {
    index,
    oldPath,
    newPath,
    path,
    status,
    binary: s.binary,
    modeChange:
      s.oldMode !== null && s.newMode !== null ? { oldMode: s.oldMode, newMode: s.newMode } : null,
    similarity: s.similarity,
    additions: s.additions,
    deletions: s.deletions,
    hunks: s.hunks,
  };
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * Parses a unified diff (GitHub `.diff`) into files/hunks/lines. Returns null when the input
 * cannot be parsed safely. Never throws.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff | null {
  try {
    return parse(diff);
  } catch {
    return null;
  }
}

function parse(diff: string): ParsedDiff | null {
  if (diff.trim() === "") return { files: [], additions: 0, deletions: 0, lineCount: 0 };
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const n = lines.length;
  if (n > PR_DIFF_MAX_LINES) return null;

  const files: DiffFile[] = [];
  let totalAdd = 0;
  let totalDel = 0;
  let lineCount = 0;
  let cur: FileState | null = null;

  const finish = (): boolean => {
    if (!cur) return true;
    const f = finalizeFile(cur, files.length);
    if (!f) return false;
    files.push(f);
    totalAdd += f.additions;
    totalDel += f.deletions;
    cur = null;
    return true;
  };

  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      if (!finish()) return null;
      cur = newFileState(line.slice(11));
      i += 1;
      continue;
    }
    if (!cur) {
      if (isBlank(line)) {
        i += 1;
        continue;
      }
      return null;
    }
    const st: FileState = cur;

    if (line.startsWith("@@ ")) {
      const m = HUNK_HEADER.exec(line);
      if (!m) return null;
      const oldStart = parseInt(m[1], 10);
      const oldLines = m[2] === undefined ? 1 : parseInt(m[2], 10);
      const newStart = parseInt(m[3], 10);
      const newLines = m[4] === undefined ? 1 : parseInt(m[4], 10);
      const hunk: DiffHunk = {
        header: line,
        section: m[5].trim(),
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      let remOld = oldLines;
      let remNew = newLines;
      let oldNo = oldStart;
      let newNo = newStart;
      i += 1;
      while (remOld > 0 || remNew > 0) {
        if (i >= n) return null;
        const l = lines[i];
        const c = l.length === 0 ? " " : l[0];
        let dl: DiffLine;
        if (c === " ") {
          if (remOld <= 0 || remNew <= 0) return null;
          dl = { kind: "context", text: l.slice(1), oldNumber: oldNo, newNumber: newNo, noNewlineAtEnd: false };
          oldNo += 1;
          newNo += 1;
          remOld -= 1;
          remNew -= 1;
        } else if (c === "+") {
          if (remNew <= 0) return null;
          dl = { kind: "add", text: l.slice(1), oldNumber: null, newNumber: newNo, noNewlineAtEnd: false };
          newNo += 1;
          remNew -= 1;
          st.additions += 1;
        } else if (c === "-") {
          if (remOld <= 0) return null;
          dl = { kind: "delete", text: l.slice(1), oldNumber: oldNo, newNumber: null, noNewlineAtEnd: false };
          oldNo += 1;
          remOld -= 1;
          st.deletions += 1;
        } else if (c === "\\") {
          const prev = hunk.lines[hunk.lines.length - 1];
          if (!prev) return null;
          prev.noNewlineAtEnd = true;
          i += 1;
          continue;
        } else {
          return null;
        }
        hunk.lines.push(dl);
        i += 1;
      }
      while (i < n && lines[i].startsWith("\\")) {
        const prev = hunk.lines[hunk.lines.length - 1];
        if (prev) prev.noNewlineAtEnd = true;
        i += 1;
      }
      lineCount += hunk.lines.length;
      st.hunks.push(hunk);
      // The next line must be another hunk, a new file, trailing blanks, or the end.
      if (i < n) {
        const next = lines[i];
        if (!next.startsWith("@@ ") && !next.startsWith("diff --git ")) {
          for (let j = i; j < n; j += 1) if (!isBlank(lines[j])) return null;
          i = n;
        }
      }
      continue;
    }

    // Extended header lines (before the first hunk).
    if (st.hunks.length > 0) return null;
    if (line.startsWith("old mode ")) st.oldMode = line.slice(9);
    else if (line.startsWith("new mode ")) st.newMode = line.slice(9);
    else if (line.startsWith("new file mode ")) st.added = true;
    else if (line.startsWith("deleted file mode ")) st.deleted = true;
    else if (line.startsWith("similarity index ")) {
      const sm = /^(\d+)%?/.exec(line.slice(17));
      if (sm) st.similarity = parseInt(sm[1], 10);
    } else if (line.startsWith("rename from ")) st.renameFrom = line.slice(12);
    else if (line.startsWith("rename to ")) st.renameTo = line.slice(10);
    else if (line.startsWith("copy from ")) st.copyFrom = line.slice(10);
    else if (line.startsWith("copy to ")) st.copyTo = line.slice(8);
    else if (line.startsWith("Binary files ") && line.endsWith(" differ")) st.binary = true;
    else if (line.startsWith("GIT binary patch")) {
      st.binary = true;
      i += 1;
      while (i < n && !lines[i].startsWith("diff --git ")) i += 1;
      continue;
    } else if (line.startsWith("--- ")) {
      const p = parseMarkerPath(line.slice(4), "a/");
      if (p === undefined) return null;
      st.minusPath = p;
      st.minusNull = p === null;
    } else if (line.startsWith("+++ ")) {
      const p = parseMarkerPath(line.slice(4), "b/");
      if (p === undefined) return null;
      st.plusPath = p;
      st.plusNull = p === null;
    }
    i += 1;
  }
  if (!finish()) return null;
  return { files, additions: totalAdd, deletions: totalDel, lineCount };
}
