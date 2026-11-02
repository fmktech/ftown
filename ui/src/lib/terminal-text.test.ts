import { describe, expect, it } from "vitest";

import { terminalBufferText, type TerminalBufferLike } from "./terminal-text";

type Row = [text: string, isWrapped: boolean];

function makeBuffer(rows: Row[]): TerminalBufferLike {
  return {
    length: rows.length,
    getLine(y: number) {
      const row = rows[y];
      if (!row) return undefined;
      const [text, isWrapped] = row;
      return {
        isWrapped,
        translateToString: () => text,
      };
    },
  };
}

describe("terminalBufferText", () => {
  it("joins plain lines with newlines", () => {
    const buffer = makeBuffer([
      ["first", false],
      ["second", false],
      ["third", false],
    ]);
    expect(terminalBufferText(buffer)).toBe("first\nsecond\nthird");
  });

  it("joins a wrapped row onto the previous row with no separator", () => {
    const buffer = makeBuffer([
      ["const value = someLongFunctionName(", false],
      ["argumentOne, argumentTwo)", true],
      ["next", false],
    ]);
    expect(terminalBufferText(buffer)).toBe(
      "const value = someLongFunctionName(argumentOne, argumentTwo)\nnext",
    );
  });

  it("trims trailing spaces from each logical line", () => {
    const buffer = makeBuffer([
      ["alpha     ", false],
      ["beta\t  ", false],
    ]);
    expect(terminalBufferText(buffer)).toBe("alpha\nbeta");
  });

  it("drops trailing blank lines but keeps middle blank lines", () => {
    const buffer = makeBuffer([
      ["top", false],
      ["", false],
      ["   ", false],
      ["bottom", false],
      ["", false],
      ["  ", false],
    ]);
    expect(terminalBufferText(buffer)).toBe("top\n\n\nbottom");
  });

  it("keeps only the last two logical lines when maxLines is 2 on five lines", () => {
    const buffer = makeBuffer([
      ["one", false],
      ["two", false],
      ["three", false],
      ["four", false],
      ["five", false],
    ]);
    expect(terminalBufferText(buffer, { maxLines: 2 })).toBe("four\nfive");
  });

  it("counts maxLines after dropping trailing blank lines", () => {
    const buffer = makeBuffer([
      ["one", false],
      ["two", false],
      ["three", false],
      ["", false],
      ["", false],
    ]);
    expect(terminalBufferText(buffer, { maxLines: 2 })).toBe("two\nthree");
  });

  it("treats maxLines 0, negative and undefined as all lines", () => {
    const buffer = makeBuffer([
      ["one", false],
      ["two", false],
      ["three", false],
    ]);
    expect(terminalBufferText(buffer, { maxLines: 0 })).toBe("one\ntwo\nthree");
    expect(terminalBufferText(buffer, { maxLines: -4 })).toBe("one\ntwo\nthree");
    expect(terminalBufferText(buffer, { maxLines: undefined })).toBe("one\ntwo\nthree");
    expect(terminalBufferText(buffer, {})).toBe("one\ntwo\nthree");
  });

  it("treats a missing row (getLine undefined) as an empty unwrapped row", () => {
    const rows: Array<Row | undefined> = [["before", false], undefined, ["after", false]];
    const buffer: TerminalBufferLike = {
      length: rows.length,
      getLine(y: number) {
        const row = rows[y];
        if (!row) return undefined;
        const [text, isWrapped] = row;
        return { isWrapped, translateToString: () => text };
      },
    };
    expect(terminalBufferText(buffer)).toBe("before\n\nafter");
  });

  it("joins a wrapped row onto a missing row, which is itself a logical line", () => {
    const rows: Array<Row | undefined> = [["head", false], undefined, ["tail", true]];
    const buffer: TerminalBufferLike = {
      length: rows.length,
      getLine(y: number) {
        const row = rows[y];
        if (!row) return undefined;
        const [text, isWrapped] = row;
        return { isWrapped, translateToString: () => text };
      },
    };
    expect(terminalBufferText(buffer)).toBe("head\ntail");
  });

  it("returns an empty string for an empty buffer", () => {
    expect(terminalBufferText(makeBuffer([]))).toBe("");
  });

  it("returns an empty string when every line is blank", () => {
    const buffer = makeBuffer([
      ["", false],
      ["   ", false],
    ]);
    expect(terminalBufferText(buffer)).toBe("");
  });
});
