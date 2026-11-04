import { describe, expect, it } from "vitest";

import { findTerminalLinks } from "./terminal-links";
import {
  TERMINAL_LINK_MAX_URL_LENGTH,
  type TerminalLink,
  type TerminalLinkBuffer,
  type TerminalLinkCell,
  type TerminalLinkLine,
} from "./terminal-link-types";

interface RowOptions {
  wrapped?: boolean;
  /** Cell indexes whose getChars() is "" (never written, e.g. skipped by a cursor-forward). */
  emptyCells?: number[];
}

const WIDE = "界";

function makeLine(text: string, cols: number, options: RowOptions = {}): TerminalLinkLine {
  const empty = new Set(options.emptyCells ?? []);
  const cells: TerminalLinkCell[] = [];
  for (const ch of Array.from(text)) {
    const index = cells.length;
    if (ch === WIDE) {
      cells.push({ getChars: () => ch, getWidth: () => 2 });
      cells.push({ getChars: () => "", getWidth: () => 0 });
    } else {
      const chars = empty.has(index) ? "" : ch;
      cells.push({ getChars: () => chars, getWidth: () => 1 });
    }
  }
  if (cells.length > cols) throw new Error(`row longer than cols (${cells.length} > ${cols}): ${text}`);
  while (cells.length < cols) cells.push({ getChars: () => "", getWidth: () => 1 });

  return {
    isWrapped: options.wrapped ?? false,
    length: cols,
    getCell: (x) => cells[x],
    translateToString(trimRight = false, startColumn = 0, endColumn = cols) {
      let out = "";
      for (let x = startColumn; x < Math.min(endColumn, cols); x++) {
        const cell = cells[x];
        if (cell.getWidth() === 0) continue;
        out += cell.getChars() === "" ? " " : cell.getChars();
      }
      return trimRight ? out.replace(/ +$/, "") : out;
    },
  };
}

type RowSpec = string | [text: string, options: RowOptions];

function makeBuffer(cols: number, rows: RowSpec[]): TerminalLinkBuffer {
  const lines = rows.map((row) => (typeof row === "string" ? makeLine(row, cols) : makeLine(row[0], cols, row[1])));
  return { length: lines.length, getLine: (y) => lines[y] };
}

function link(url: string, x1: number, y1: number, x2: number, y2: number): TerminalLink {
  return { url, range: { start: { x: x1, y: y1 }, end: { x: x2, y: y2 } } };
}

const FULL_URL =
  "https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstuvwxyz/0123456789/abcdefghijklmnopqrstuvwxyz/path-segment-x?q=END-OF-URL";
const CLAUDE_ROW0 = "⏺ https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstu";
const CLAUDE_ROW1_TEXT = "vwxyz/0123456789/abcdefghijklmnopqrstuvwxyz/path-segment-x?q=END-OF-URL";

describe("findTerminalLinks", () => {
  it("finds a single-row URL inside prose", () => {
    const buffer = makeBuffer(40, ["see https://example.com/x here"]);
    expect(findTerminalLinks(buffer, 1)).toEqual([link("https://example.com/x", 5, 1, 25, 1)]);
  });

  it("drops surrounding parens and a trailing period", () => {
    const buffer = makeBuffer(40, ["(https://example.com/x)."]);
    expect(findTerminalLinks(buffer, 1)).toEqual([link("https://example.com/x", 2, 1, 22, 1)]);
  });

  it("returns two URLs on one row in order", () => {
    const buffer = makeBuffer(40, ["a https://a.com/1 b https://b.com/2"]);
    expect(findTerminalLinks(buffer, 1)).toEqual([
      link("https://a.com/1", 3, 1, 17, 1),
      link("https://b.com/2", 21, 1, 35, 1),
    ]);
  });

  it("is deterministic across repeated calls (regex state is not shared)", () => {
    const buffer = makeBuffer(40, ["a https://a.com/1 b https://b.com/2"]);
    const first = findTerminalLinks(buffer, 1);
    expect(findTerminalLinks(buffer, 1)).toEqual(first);
    expect(findTerminalLinks(buffer, 1)).toEqual(first);
  });

  it("returns [] for a row without URLs", () => {
    expect(findTerminalLinks(makeBuffer(40, ["just some prose"]), 1)).toEqual([]);
  });

  describe("soft-wrapped rows", () => {
    it("returns one link spanning both rows with a canonical end, for either row", () => {
      const buffer = makeBuffer(20, ["ab https://example.c", ["om/path rest", { wrapped: true }]]);
      const expected = [link("https://example.com/path", 4, 1, 7, 2)];
      expect(findTerminalLinks(buffer, 1)).toEqual(expected);
      expect(findTerminalLinks(buffer, 2)).toEqual(expected);
    });

    it("ends on the last cell of its own row when the URL ends at the edge", () => {
      const buffer = makeBuffer(20, ["ab https://example.c", ["om/pathabcdefghijklm", { wrapped: true }], ""]);
      const expected = [link("https://example.com/pathabcdefghijklm", 4, 1, 20, 2)];
      expect(findTerminalLinks(buffer, 1)).toEqual(expected);
      expect(findTerminalLinks(buffer, 2)).toEqual(expected);
      expect(findTerminalLinks(buffer, 3)).toEqual([]);
    });
  });

  describe("hard-wrapped rows", () => {
    it("joins the Claude Code reply (empty indent cells) across both rows", () => {
      const row0 = makeLine(CLAUDE_ROW0, 80);
      expect(Array.from(CLAUDE_ROW0)).toHaveLength(80);
      expect(row0.length).toBe(80);
      const buffer = makeBuffer(80, [CLAUDE_ROW0, ["  " + CLAUDE_ROW1_TEXT, { emptyCells: [0, 1] }]]);
      expect(findTerminalLinks(buffer, 1)).toEqual([link(FULL_URL, 3, 1, 80, 1)]);
      expect(findTerminalLinks(buffer, 2)).toEqual([link(FULL_URL, 3, 2, 73, 2)]);
    });

    it("joins the Claude Code reply when the indent is real spaces", () => {
      const buffer = makeBuffer(80, [CLAUDE_ROW0, "  " + CLAUDE_ROW1_TEXT]);
      expect(findTerminalLinks(buffer, 1)).toEqual([link(FULL_URL, 3, 1, 80, 1)]);
      expect(findTerminalLinks(buffer, 2)).toEqual([link(FULL_URL, 3, 2, 73, 2)]);
    });

    it("chains three rows where the middle row is full", () => {
      const url = "https://example.coaaaaaaaaaaaaaaaaaabbb";
      const buffer = makeBuffer(20, [
        "> https://example.co",
        ["  " + "a".repeat(18), { emptyCells: [0, 1] }],
        ["  bbb", { emptyCells: [0, 1] }],
      ]);
      expect(findTerminalLinks(buffer, 1)).toEqual([link(url, 3, 1, 20, 1)]);
      expect(findTerminalLinks(buffer, 2)).toEqual([link(url, 3, 2, 20, 2)]);
      expect(findTerminalLinks(buffer, 3)).toEqual([link(url, 3, 3, 5, 3)]);
    });

    it("joins a plain shell split at indent 0", () => {
      const url = "https://example.com/" + "a".repeat(38) + "xyz/end";
      const buffer = makeBuffer(60, ["B:https://example.com/" + "a".repeat(38), "xyz/end more"]);
      expect(findTerminalLinks(buffer, 1)).toEqual([link(url, 3, 1, 60, 1)]);
      expect(findTerminalLinks(buffer, 2)).toEqual([link(url, 1, 2, 7, 2)]);
    });

    it("keeps a regular link on the continuation row, sorted after the fragment", () => {
      const buffer = makeBuffer(20, [
        "> https://example.co",
        ["  mm/p https://b.co", { emptyCells: [0, 1] }],
      ]);
      expect(findTerminalLinks(buffer, 2)).toEqual([
        link("https://example.comm/p", 3, 2, 6, 2),
        link("https://b.co", 8, 2, 19, 2),
      ]);
    });

    it("does not join when the URL stops one cell before the edge", () => {
      const buffer = makeBuffer(20, ["ab https://exampl.c", "  and more"]);
      expect(findTerminalLinks(buffer, 1)).toEqual([link("https://exampl.c", 4, 1, 19, 1)]);
      expect(findTerminalLinks(buffer, 2)).toEqual([]);
    });

    it("does not join when the next row's indent exceeds where the URL started", () => {
      const buffer = makeBuffer(20, ["> https://example.co", ["    mmmm", { emptyCells: [0, 1, 2, 3] }]]);
      expect(findTerminalLinks(buffer, 1)).toEqual([link("https://example.co", 3, 1, 20, 1)]);
      expect(findTerminalLinks(buffer, 2)).toEqual([]);
    });

    it("does not join when the indent is deeper than the maximum", () => {
      const buffer = makeBuffer(40, ["x".repeat(19) + " https://example.com/", " ".repeat(10) + "tail"]);
      expect(findTerminalLinks(buffer, 1)).toEqual([link("https://example.com/", 21, 1, 40, 1)]);
      expect(findTerminalLinks(buffer, 2)).toEqual([]);
    });

    it("treats a next row that starts with https:// as a separate link", () => {
      const buffer = makeBuffer(20, ["> https://example.co", ["  https://o.org/x", { emptyCells: [0, 1] }]]);
      expect(findTerminalLinks(buffer, 1)).toEqual([link("https://example.co", 3, 1, 20, 1)]);
      expect(findTerminalLinks(buffer, 2)).toEqual([link("https://o.org/x", 3, 2, 17, 2)]);
    });

    it("falls back to the unjoined URL when the joined URL does not parse", () => {
      const buffer = makeBuffer(22, ["https://example.com:99", "999999x"]);
      expect(findTerminalLinks(buffer, 1)).toEqual([link("https://example.com:99", 1, 1, 22, 1)]);
      expect(findTerminalLinks(buffer, 2)).toEqual([]);
    });

    it("excludes a closing paren from the joined URL", () => {
      const buffer = makeBuffer(21, ["- (https://example.co", ["  m/path)", { emptyCells: [0, 1] }]]);
      const url = "https://example.com/path";
      expect(findTerminalLinks(buffer, 1)).toEqual([link(url, 4, 1, 21, 1)]);
      expect(findTerminalLinks(buffer, 2)).toEqual([link(url, 3, 2, 8, 2)]);
    });

    it("caps a very long chain at the maximum URL length without throwing", () => {
      const cols = 80;
      const rows: RowSpec[] = ["> https://example.com/" + "a".repeat(58)];
      for (let i = 0; i < 40; i++) rows.push(["  " + "a".repeat(78), { emptyCells: [0, 1] }]);
      const buffer = makeBuffer(cols, rows);

      const first = findTerminalLinks(buffer, 1);
      expect(first.length).toBeGreaterThanOrEqual(1);
      expect(first[0].url.startsWith("https://example.com/aaaa")).toBe(true);
      expect(first[0].url.length).toBeLessThanOrEqual(TERMINAL_LINK_MAX_URL_LENGTH);
      const fragments: TerminalLink[] = [];
      for (let y = 1; y <= rows.length; y++) {
        const found = findTerminalLinks(buffer, y);
        for (const l of found) {
          expect(l.url.length).toBeLessThanOrEqual(TERMINAL_LINK_MAX_URL_LENGTH);
        }
        if (found.length > 0) fragments.push(found[0]);
      }
      // fragments are contiguous from row 1, share one url, and fill every row but the last
      expect(fragments.length).toBeGreaterThan(1);
      fragments.forEach((f, i) => {
        expect(f.url).toBe(first[0].url);
        expect(f.range.start.y).toBe(i + 1);
        expect(f.range.end.y).toBe(i + 1);
        expect(f.range.start.x).toBe(3);
        if (i < fragments.length - 1) expect(f.range.end.x).toBe(cols);
      });
      const chars = fragments.reduce((n, f) => n + (f.range.end.x - f.range.start.x + 1), 0);
      expect(chars).toBe(first[0].url.length);
    });
  });

  it("shifts ranges by a preceding wide character", () => {
    const buffer = makeBuffer(40, [`${WIDE} https://example.com/x`]);
    // wide char = cells 0-1, space = cell 2, URL starts at cell 3
    expect(findTerminalLinks(buffer, 1)).toEqual([link("https://example.com/x", 4, 1, 24, 1)]);
  });

  it("handles an early-wrapped wide character (addon parity)", () => {
    // xterm leaves the last cell empty when a wide char does not fit, then soft-wraps it.
    const buffer = makeBuffer(12, [
      ["https://a/b", { emptyCells: [11] }],
      [`${WIDE}xyz`, { wrapped: true }],
    ]);
    const expected = [link(`https://a/b${WIDE}xyz`, 1, 1, 5, 2)];
    expect(findTerminalLinks(buffer, 1)).toEqual(expected);
    expect(findTerminalLinks(buffer, 2)).toEqual(expected);
  });

  it("returns [] for out-of-range rows", () => {
    const buffer = makeBuffer(40, ["https://example.com/x"]);
    expect(findTerminalLinks(buffer, 0)).toEqual([]);
    expect(findTerminalLinks(buffer, 2)).toEqual([]);
    expect(findTerminalLinks(buffer, -3)).toEqual([]);
  });
});
