import { describe, expect, it } from "vitest";
import type { DiffHunk, DiffLine } from "@/lib/pr-diff-types";
import { emphasisByLine, toSplitRows } from "@/lib/pr-diff-split";

type Entry = [DiffLine["kind"], string];

function hunkOf(entries: Entry[]): DiffHunk {
  return {
    header: "@@ -1 +1 @@",
    section: "",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: entries.map(([kind, text]) => ({ kind, text, oldNumber: null, newNumber: null, noNewlineAtEnd: false })),
  };
}

describe("toSplitRows", () => {
  it("pads the shorter side of an unequal change block", () => {
    const hunk = hunkOf([
      ["delete", "d1"],
      ["delete", "d2"],
      ["delete", "d3"],
      ["add", "a1"],
    ]);
    const rows = toSplitRows(hunk);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.left?.text).toBe("d1");
    expect(rows[0]?.right?.text).toBe("a1");
    expect(rows[1]?.left?.text).toBe("d2");
    expect(rows[1]?.right).toBeNull();
    expect(rows[2]?.left?.text).toBe("d3");
    expect(rows[2]?.right).toBeNull();
  });

  it("pairs an interleaved -+-+ block by position, ignoring interleaving", () => {
    const hunk = hunkOf([
      ["delete", "a"],
      ["add", "A"],
      ["delete", "b"],
      ["add", "B"],
    ]);
    const rows = toSplitRows(hunk);
    expect(rows.map((row) => [row.left?.text, row.right?.text])).toEqual([
      ["a", "A"],
      ["b", "B"],
    ]);
  });

  it("places a context line on both sides as the same object", () => {
    const hunk = hunkOf([["context", "same"]]);
    const rows = toSplitRows(hunk);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.left).toBe(hunk.lines[0]);
    expect(rows[0]?.right).toBe(hunk.lines[0]);
  });

  it("handles multiple change blocks separated by context", () => {
    const hunk = hunkOf([
      ["context", "c0"],
      ["delete", "x"],
      ["add", "y"],
      ["context", "c1"],
      ["add", "z"],
    ]);
    const rows = toSplitRows(hunk);
    expect(rows.map((row) => [row.left?.text, row.right?.text])).toEqual([
      ["c0", "c0"],
      ["x", "y"],
      ["c1", "c1"],
      [undefined, "z"],
    ]);
  });

  it("returns no rows for an empty hunk", () => {
    expect(toSplitRows(hunkOf([]))).toEqual([]);
  });
});

describe("emphasisByLine", () => {
  it("emphasises the changed character of a paired edit on both sides", () => {
    const hunk = hunkOf([
      ["delete", "const a = 1"],
      ["add", "const a = 2"],
    ]);
    const map = emphasisByLine(hunk);
    expect(map.get(hunk.lines[0])).toEqual([10, 11]);
    expect(map.get(hunk.lines[1])).toEqual([10, 11]);
  });

  it("gives a pure insertion an entry only on the new side", () => {
    const hunk = hunkOf([
      ["delete", "ab"],
      ["add", "aXb"],
    ]);
    const map = emphasisByLine(hunk);
    expect(map.has(hunk.lines[0])).toBe(false);
    expect(map.get(hunk.lines[1])).toEqual([1, 2]);
  });

  it("pairs an interleaved -+-+ block and emphasises each pair", () => {
    const hunk = hunkOf([
      ["delete", "x = 1"],
      ["add", "x = 2"],
      ["delete", "y = 3"],
      ["add", "y = 4"],
    ]);
    const map = emphasisByLine(hunk);
    expect(map.get(hunk.lines[0])).toEqual([4, 5]);
    expect(map.get(hunk.lines[1])).toEqual([4, 5]);
    expect(map.get(hunk.lines[2])).toEqual([4, 5]);
    expect(map.get(hunk.lines[3])).toEqual([4, 5]);
  });

  it("does not split a surrogate pair", () => {
    const hunk = hunkOf([
      ["delete", "x😀y"],
      ["add", "x😁y"],
    ]);
    const map = emphasisByLine(hunk);
    expect(map.get(hunk.lines[0])).toEqual([1, 3]);
    expect(map.get(hunk.lines[1])).toEqual([1, 3]);
  });

  it("skips a pair whose changed span exceeds 70 % of the line on both sides", () => {
    const hunk = hunkOf([
      ["delete", "abcdefghij"],
      ["add", "abzzzzzzzz"],
    ]);
    expect(emphasisByLine(hunk).size).toBe(0);
  });

  it("produces no entries for an unequal change block", () => {
    const hunk = hunkOf([
      ["delete", "const a = 1"],
      ["delete", "const b = 1"],
      ["add", "const a = 2"],
    ]);
    expect(emphasisByLine(hunk).size).toBe(0);
  });

  it("skips pairs where either line is longer than 1000 characters", () => {
    const long = "a".repeat(1001);
    const hunk = hunkOf([
      ["delete", long],
      ["add", "a".repeat(1000) + "b"],
    ]);
    expect(emphasisByLine(hunk).size).toBe(0);
  });

  it("returns an empty map for a context-only hunk", () => {
    const hunk = hunkOf([
      ["context", "one"],
      ["context", "two"],
    ]);
    expect(emphasisByLine(hunk).size).toBe(0);
  });
});

describe("emphasisByLine boundaries", () => {
  it("still emphasises a 1000-character pair", () => {
    const hunk = hunkOf([
      ["delete", "a".repeat(1000)],
      ["add", "a".repeat(999) + "b"],
    ]);
    const map = emphasisByLine(hunk);
    expect(map.get(hunk.lines[0])).toEqual([999, 1000]);
    expect(map.get(hunk.lines[1])).toEqual([999, 1000]);
  });

  it("gives no entries when one line of the pair is 1001 characters", () => {
    const hunk = hunkOf([
      ["delete", "a".repeat(1001)],
      ["add", "x"],
    ]);
    expect(emphasisByLine(hunk).size).toBe(0);
  });

  it("emphasises when one side is over 70 % and the other is under", () => {
    const hunk = hunkOf([
      ["delete", "abc" + "X".repeat(17)],
      ["add", "abc" + "1234567"],
    ]);
    const map = emphasisByLine(hunk);
    expect(map.get(hunk.lines[0])).toEqual([3, 20]);
    expect(map.get(hunk.lines[1])).toEqual([3, 10]);
  });

  it("emphasises when both sides are exactly 70 % (the skip is strict)", () => {
    const hunk = hunkOf([
      ["delete", "abc" + "X".repeat(7)],
      ["add", "abc" + "Y".repeat(7)],
    ]);
    const map = emphasisByLine(hunk);
    expect(map.get(hunk.lines[0])).toEqual([3, 10]);
    expect(map.get(hunk.lines[1])).toEqual([3, 10]);
  });

  it("backs off a suffix that would split a surrogate pair", () => {
    const hunk = hunkOf([
      ["delete", "x\u{1F600}y"],
      ["add", "x\u{1FA00}y"],
    ]);
    const map = emphasisByLine(hunk);
    expect(map.get(hunk.lines[0])).toEqual([1, 3]);
    expect(map.get(hunk.lines[1])).toEqual([1, 3]);
  });

  it("caps prefix and suffix so the ranges stay valid", () => {
    const hunk = hunkOf([
      ["delete", "aa"],
      ["add", "aaa"],
    ]);
    const map = emphasisByLine(hunk);
    expect(map.has(hunk.lines[0])).toBe(false);
    expect(map.get(hunk.lines[1])).toEqual([2, 3]);
  });

  it("emphasises only the old side of a pure deletion inside a line", () => {
    const hunk = hunkOf([
      ["delete", "aXb"],
      ["add", "ab"],
    ]);
    const map = emphasisByLine(hunk);
    expect(map.get(hunk.lines[0])).toEqual([1, 2]);
    expect(map.has(hunk.lines[1])).toBe(false);
  });

  it("does not pair a delete and an add separated by a context line", () => {
    const hunk = hunkOf([
      ["delete", "a1"],
      ["context", "c"],
      ["add", "b1"],
    ]);
    expect(emphasisByLine(hunk).size).toBe(0);
  });

  it("emphasises only the equal block when a later block is unequal", () => {
    const hunk = hunkOf([
      ["delete", "const a = 1"],
      ["add", "const a = 2"],
      ["context", "c"],
      ["delete", "x"],
      ["delete", "y"],
      ["add", "z"],
    ]);
    const map = emphasisByLine(hunk);
    expect(map.size).toBe(2);
    expect(map.get(hunk.lines[0])).toEqual([10, 11]);
    expect(map.get(hunk.lines[1])).toEqual([10, 11]);
    expect(map.has(hunk.lines[3])).toBe(false);
    expect(map.has(hunk.lines[4])).toBe(false);
    expect(map.has(hunk.lines[5])).toBe(false);
  });
});

describe("toSplitRows trailing adds", () => {
  it("leaves left null on trailing rows when adds outnumber deletes", () => {
    const hunk = hunkOf([
      ["delete", "d"],
      ["add", "a1"],
      ["add", "a2"],
      ["add", "a3"],
    ]);
    const rows = toSplitRows(hunk);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.left?.text).toBe("d");
    expect(rows[1]?.left).toBeNull();
    expect(rows[1]?.right?.text).toBe("a2");
    expect(rows[2]?.left).toBeNull();
    expect(rows[2]?.right?.text).toBe("a3");
  });
});
