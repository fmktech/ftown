import {
  TERMINAL_LINK_EDGE_SLACK,
  TERMINAL_LINK_MAX_INDENT,
  TERMINAL_LINK_MAX_URL_LENGTH,
  TERMINAL_URL_BODY_CHAR,
  TERMINAL_URL_REGEX,
  type FindTerminalLinks,
  type TerminalLink,
  type TerminalLinkBuffer,
  type TerminalLinkLine,
  type TerminalLinkRange,
} from "./terminal-link-types";

/**
 * URL detection for terminal links. Soft-wrapped rows are joined like @xterm/addon-web-links
 * (MIT, (c) 2019 The xterm.js authors); on top of that, a URL that a program hard-wrapped onto
 * the next row (new logical line, optional blank indent) is joined too.
 */

/** Rows searched above the requested row for URLs whose continuation reaches it. */
const LOOKBACK_ROWS = 64;

const URL_START = /^https?:\/\//i;

interface CellInfo {
  chars: string;
  width: number;
}

interface RowData {
  line: TerminalLinkLine;
  cells: CellInfo[];
}

/** Where one string char sits in the buffer (0-based; `w` is the cell width, 1 or 2). */
interface Pos {
  x: number;
  y: number;
  w: number;
}

/** The text of a logical line (a row plus the soft-wrapped rows that continue it). */
interface LineText {
  firstRow: number;
  lastRow: number;
  text: string;
  pos: Pos[];
}

interface Context {
  buffer: TerminalLinkBuffer;
  rows: Map<number, RowData | null>;
  lines: Map<number, LineText>;
}

/** A slice [from, to) of a logical line's text that belongs to one URL. */
interface Part {
  line: LineText;
  from: number;
  to: number;
}

/** Same check as the addon's `isUrl`. */
function isUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const parsedBase =
      url.password && url.username
        ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
        : url.username
          ? `${url.protocol}//${url.username}@${url.host}`
          : `${url.protocol}//${url.host}`;
    return urlString.toLocaleLowerCase().startsWith(parsedBase.toLocaleLowerCase());
  } catch {
    return false;
  }
}

function isBodyChar(ch: string | undefined): boolean {
  return ch !== undefined && TERMINAL_URL_BODY_CHAR.test(ch);
}

function getRow(ctx: Context, y: number): RowData | null {
  const cached = ctx.rows.get(y);
  if (cached !== undefined) return cached;
  let data: RowData | null = null;
  const line = y >= 0 && y < ctx.buffer.length ? ctx.buffer.getLine(y) : undefined;
  if (line) {
    const cells: CellInfo[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      cells.push({ chars: cell ? cell.getChars() : "", width: cell ? cell.getWidth() : 1 });
    }
    data = { line, cells };
  }
  ctx.rows.set(y, data);
  return data;
}

function isBlankCell(cell: CellInfo): boolean {
  return cell.width !== 0 && (cell.chars === "" || cell.chars === " ");
}

/** Row cap per direction so a pathological buffer cannot make us scan far past the URL budget. */
function maxLineRows(cols: number): number {
  return Math.max(1, Math.ceil(TERMINAL_LINK_MAX_URL_LENGTH / Math.max(1, cols)) + 1);
}

/** The logical line containing `row` (cached by its first row). */
function getLineText(ctx: Context, row: number): LineText | null {
  const start = getRow(ctx, row);
  if (!start) return null;
  const cap = maxLineRows(start.line.length);
  let firstRow = row;
  for (let n = 0; n < cap && firstRow > 0 && getRow(ctx, firstRow)?.line.isWrapped; n++) firstRow--;
  const cached = ctx.lines.get(firstRow);
  if (cached && cached.lastRow >= row) return cached;

  let lastRow = row;
  for (let n = 0; n < cap && getRow(ctx, lastRow + 1)?.line.isWrapped; n++) lastRow++;

  let text = "";
  const pos: Pos[] = [];
  for (let y = firstRow; y <= lastRow; y++) {
    const data = getRow(ctx, y);
    if (!data) break;
    data.cells.forEach((cell, x) => {
      if (cell.width === 0) return; // trailing half of a wide char: no string char
      // A wide char that did not fit was wrapped whole; the empty cell it left behind is not text.
      if (cell.chars === "" && x === data.cells.length - 1 && y < lastRow) {
        const nextRow = getRow(ctx, y + 1);
        if (nextRow?.line.isWrapped && nextRow.cells[0]?.width === 2) return;
      }
      const chars = cell.chars || " "; // empty cells render as a space
      for (let i = 0; i < chars.length; i++) {
        text += chars[i];
        pos.push({ x, y, w: cell.width });
      }
    });
  }
  const result: LineText = { firstRow, lastRow, text, pos };
  ctx.lines.set(firstRow, result);
  return result;
}

function rangeOf(line: LineText, from: number, to: number): TerminalLinkRange {
  const start = line.pos[from];
  const end = line.pos[to - 1];
  return {
    start: { x: start.x + 1, y: start.y + 1 },
    end: { x: end.x + end.w, y: end.y + 1 },
  };
}

function leadingBlankCells(data: RowData, limit: number): number {
  let k = 0;
  while (k < limit && k < data.cells.length && isBlankCell(data.cells[k])) k++;
  return k;
}

/**
 * Hard-wrap continuation (rules a-c of the spec). Returns the parts of the joined URL, or just the
 * first part when nothing continues it.
 */
function collectParts(ctx: Context, line: LineText, from: number, runEnd: number): Part[] {
  const parts: Part[] = [{ line, from, to: runEnd }];
  let joinedLength = runEnd - from;
  for (;;) {
    const last = parts[parts.length - 1];
    if (last.line.text.slice(last.to).trim() !== "") break; // run must be the line's last text
    const lastPos = last.line.pos[last.to - 1];
    const rowIdx = lastPos.y;
    if (rowIdx !== last.line.lastRow) break;
    const row = getRow(ctx, rowIdx);
    if (!row) break;
    if (lastPos.x + lastPos.w - 1 < row.line.length - 1 - TERMINAL_LINK_EDGE_SLACK) break;

    const startPos = last.line.pos[last.from];
    const c = startPos.y === rowIdx ? startPos.x : 0;

    const next = getRow(ctx, rowIdx + 1);
    if (!next || next.line.isWrapped) break;
    const k = leadingBlankCells(next, TERMINAL_LINK_MAX_INDENT + 1);
    if (k > TERMINAL_LINK_MAX_INDENT || k > c) break;

    const nextLine = getLineText(ctx, rowIdx + 1);
    if (!nextLine || nextLine.text.length <= k) break;
    if (!isBodyChar(nextLine.text[k]) || URL_START.test(nextLine.text.slice(k))) break;

    let end = k;
    while (end < nextLine.text.length && isBodyChar(nextLine.text[end])) end++;
    if (joinedLength + (end - k) > TERMINAL_LINK_MAX_URL_LENGTH) break;
    joinedLength += end - k;
    parts.push({ line: nextLine, from: k, to: end });
  }
  return parts;
}

/** The fragment links of one regex match: a single link, or one per row-fragment when joined. */
function linksForMatch(ctx: Context, line: LineText, index: number, matched: string): TerminalLink[] {
  const plain: TerminalLink[] = [{ url: matched, range: rangeOf(line, index, index + matched.length) }];

  let runEnd = index + matched.length;
  while (runEnd < line.text.length && isBodyChar(line.text[runEnd])) runEnd++;

  const parts = collectParts(ctx, line, index, runEnd);
  if (parts.length === 1) return plain;

  const joined = parts.map((p) => p.line.text.slice(p.from, p.to)).join("");
  const anchored = new RegExp(`^(?:${TERMINAL_URL_REGEX.source})`, TERMINAL_URL_REGEX.flags).exec(joined);
  if (!anchored || !isUrl(anchored[0]) || anchored[0].length <= matched.length) return plain;

  const url = anchored[0];
  const links: TerminalLink[] = [];
  let remaining = url.length;
  for (const part of parts) {
    const n = Math.min(remaining, part.to - part.from);
    if (n <= 0) break;
    links.push({ url, range: rangeOf(part.line, part.from, part.from + n) });
    remaining -= n;
  }
  return links;
}

/** All links (every fragment) of the URLs that start on `line`. */
function linksStartingOn(ctx: Context, line: LineText, lastMatchOnly: boolean): TerminalLink[] {
  const regex = new RegExp(TERMINAL_URL_REGEX.source, `${TERMINAL_URL_REGEX.flags}g`);
  const matches: { index: number; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line.text))) {
    if (isUrl(m[0])) matches.push({ index: m.index, text: m[0] });
  }
  const selected = lastMatchOnly ? matches.slice(-1) : matches;
  return selected.flatMap((match) => linksForMatch(ctx, line, match.index, match.text));
}

function compareStart(a: TerminalLink, b: TerminalLink): number {
  return a.range.start.y - b.range.start.y || a.range.start.x - b.range.start.x;
}

/** True when the two inclusive 1-based ranges share at least one cell. */
function rangesOverlap(a: TerminalLinkRange, b: TerminalLinkRange): boolean {
  const before = (p: { x: number; y: number }, q: { x: number; y: number }) =>
    p.y < q.y || (p.y === q.y && p.x < q.x);
  return !before(a.end, b.start) && !before(b.end, a.start);
}

export const findTerminalLinks: FindTerminalLinks = (buffer, bufferLineNumber) => {
  const row = bufferLineNumber - 1;
  if (!Number.isInteger(row) || row < 0 || row >= buffer.length) return [];

  const ctx: Context = { buffer, rows: new Map(), lines: new Map() };
  const current = getLineText(ctx, row);
  if (!current) return [];

  // Lines wrapped by the program itself: only the cells on the current logical line count.
  const touchesCurrent = (link: TerminalLink) =>
    link.range.start.y - 1 <= current.lastRow && link.range.end.y - 1 >= current.firstRow;

  const own = linksStartingOn(ctx, current, false).filter(touchesCurrent);

  const continuations: TerminalLink[] = [];
  let prevRow = current.firstRow - 1;
  while (prevRow >= 0 && prevRow >= current.firstRow - LOOKBACK_ROWS) {
    const prev = getLineText(ctx, prevRow);
    if (!prev) break;
    continuations.push(...linksStartingOn(ctx, prev, true).filter(touchesCurrent));
    prevRow = prev.firstRow - 1;
  }

  const regular = own.filter((link) => !continuations.some((c) => rangesOverlap(c.range, link.range)));
  const seen = new Set<string>();
  return [...continuations, ...regular]
    .filter((link) => {
      const { start, end } = link.range;
      const key = `${start.y}:${start.x}:${end.y}:${end.x}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareStart);
};
