// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DiffHunk, DiffLine } from "@/lib/pr-diff-types";
import { REVIEW_LABELS } from "@/lib/pr-review-types";
import { DiffTable } from "./DiffTable";

afterEach(cleanup);

const line = (kind: DiffLine["kind"], text: string, oldNumber: number | null, newNumber: number | null, noNewlineAtEnd = false): DiffLine => ({ kind, text, oldNumber, newNumber, noNewlineAtEnd });

const header = "@@ -1,2 +1,3 @@ function f()";

const unifiedHunk: DiffHunk = {
  header,
  section: "function f()",
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 3,
  lines: [
    line("context", "const x = 0", 1, 1),
    line("delete", "const a = 1", 2, null),
    line("add", "const a = 2", null, 2),
    line("add", "<svg onload=bad()>", null, 3, true),
  ],
};

const splitHunk: DiffHunk = {
  header: "@@ -1,3 +1,2 @@",
  section: "",
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 2,
  lines: [line("context", "keep", 1, 1), line("delete", "old1", 2, null), line("delete", "old2", 3, null), line("add", "new1", null, 2)],
};

const pairHunk: DiffHunk = {
  header: "@@ -1 +1 @@",
  section: "",
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  lines: [line("delete", "const a = 1", 1, null), line("add", "const a = 2", null, 1)],
};

const rowsOf = (container: HTMLElement) => Array.from(container.querySelectorAll("tr.pr-review-line"));

describe("DiffTable unified layout", () => {
  it("names the table after the file path and marks it unified", () => {
    const { container } = render(<DiffTable hunks={[unifiedHunk]} layout="unified" label="src/a.ts" />);
    const table = screen.getByRole("table", { name: "Diff for src/a.ts" });
    expect(table.classList.contains("pr-review-diff")).toBe(true);
    expect(table.classList.contains("is-unified")).toBe(true);
    expect(container.querySelector("table.is-split")).toBeNull();
  });

  it("renders the hunk header as a spanning row", () => {
    const { container } = render(<DiffTable hunks={[unifiedHunk]} layout="unified" label="src/a.ts" />);
    const hunkRow = container.querySelector("tr.pr-review-hunk");
    expect(hunkRow).not.toBeNull();
    expect(hunkRow?.querySelector("td")?.getAttribute("colspan")).toBe("3");
    expect(hunkRow?.textContent).toContain(header);
  });

  it("classes each row by kind and shows old/new line numbers", () => {
    const { container } = render(<DiffTable hunks={[unifiedHunk]} layout="unified" label="src/a.ts" />);
    const rows = rowsOf(container);
    expect(rows.map(r => r.className.split(" ").find(c => c.startsWith("is-")))).toEqual(["is-ctx", "is-del", "is-add", "is-add"]);
    const numbers = (row: Element) => Array.from(row.querySelectorAll("td.pr-review-num")).map(td => td.textContent);
    expect(numbers(rows[0])).toEqual(["1", "1"]);
    expect(numbers(rows[1])).toEqual(["2", ""]);
    expect(numbers(rows[2])).toEqual(["", "2"]);
  });

  it("keeps the sign and text contiguous and inert", () => {
    const { container } = render(<DiffTable hunks={[unifiedHunk]} layout="unified" label="src/a.ts" />);
    const rows = rowsOf(container);
    expect(rows[1].querySelector("span.pr-review-sign")?.textContent).toBe("-");
    expect(rows[2].querySelector("span.pr-review-sign")?.textContent).toBe("+");
    expect(rows[0].querySelector("span.pr-review-sign")?.textContent).toBe(" ");
    expect(screen.getByText("const x = 0", { selector: "span.pr-review-text" })).toBeTruthy();
    expect(container.textContent).toContain("+<svg onload=bad()>");
    expect(container.querySelector("img,script,svg")).toBeNull();
  });

  it("shows the no-newline marker with its accessible label", () => {
    const { container } = render(<DiffTable hunks={[unifiedHunk]} layout="unified" label="src/a.ts" />);
    const eof = container.querySelectorAll("span.pr-review-eof");
    expect(eof).toHaveLength(1);
    expect(eof[0].getAttribute("aria-label")).toBe(REVIEW_LABELS.eof);
    expect(eof[0].getAttribute("title")).toBe(REVIEW_LABELS.eof);
    expect(eof[0].textContent).toBe("⊘");
  });

  it("wraps the changed span of a paired line in mark.pr-review-emph", () => {
    const { container } = render(<DiffTable hunks={[pairHunk]} layout="unified" label="src/a.ts" />);
    const marks = Array.from(container.querySelectorAll("mark.pr-review-emph")).map(m => m.textContent);
    expect(marks).toEqual(["1", "2"]);
    const rows = rowsOf(container);
    expect(rows[0].querySelector("span.pr-review-text")?.textContent).toBe("const a = 1");
    expect(rows[1].querySelector("span.pr-review-text")?.textContent).toBe("const a = 2");
  });
});

describe("DiffTable split layout", () => {
  it("marks the table split and renders four cells per row", () => {
    const { container } = render(<DiffTable hunks={[splitHunk]} layout="split" label="src/b.ts" />);
    const table = screen.getByRole("table", { name: "Diff for src/b.ts" });
    expect(table.classList.contains("is-split")).toBe(true);
    expect(table.classList.contains("is-unified")).toBe(false);
    const rows = rowsOf(container);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.classList.contains("is-split")).toBe(true);
      expect(row.children).toHaveLength(4);
    }
    expect(container.querySelector("span.pr-review-sign")).toBeNull();
    expect(container.querySelector("tr.pr-review-hunk td")?.getAttribute("colspan")).toBe("4");
  });

  it("pairs deletions with additions and marks unequal blocks as empty", () => {
    const { container } = render(<DiffTable hunks={[splitHunk]} layout="split" label="src/b.ts" />);
    const rows = rowsOf(container);
    const cls = (cell: Element | undefined) => cell?.className ?? "";
    const cells = (row: Element) => Array.from(row.children);

    const context = cells(rows[0]);
    expect(cls(context[0])).toContain("is-ctx");
    expect(cls(context[1])).toContain("is-ctx");
    expect(cls(context[2])).toContain("is-ctx");
    expect(cls(context[3])).toContain("is-ctx");
    expect(context[0].textContent).toBe("1");
    expect(context[2].textContent).toBe("1");

    const first = cells(rows[1]);
    expect(cls(first[0])).toContain("is-del");
    expect(cls(first[1])).toContain("is-del");
    expect(cls(first[2])).toContain("is-add");
    expect(cls(first[3])).toContain("is-add");
    expect(first[1].textContent).toContain("old1");
    expect(first[3].textContent).toContain("new1");

    const second = cells(rows[2]);
    expect(cls(second[1])).toContain("is-del");
    expect(second[1].textContent).toContain("old2");
    expect(cls(second[2])).toContain("is-empty");
    expect(cls(second[3])).toContain("is-empty");
    expect(second[3].textContent).toBe("");
  });

  it("renders emphasis and the inert text inside split code cells", () => {
    const { container } = render(<DiffTable hunks={[pairHunk, { ...splitHunk, lines: [line("add", "<img src=x onerror=bad()>", null, 1)] }]} layout="split" label="src/c.ts" />);
    const marks = Array.from(container.querySelectorAll("mark.pr-review-emph")).map(m => m.textContent);
    expect(marks).toEqual(["1", "2"]);
    expect(container.querySelector("img,script,svg")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=bad()>");
  });
});
