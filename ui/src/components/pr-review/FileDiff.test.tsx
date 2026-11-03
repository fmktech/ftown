// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DiffFile, DiffHunk, DiffLine } from "@/lib/pr-diff-types";
import { FileDiff } from "./FileDiff";

const line = (kind: DiffLine["kind"], text: string, oldNumber: number | null, newNumber: number | null): DiffLine => ({ kind, text, oldNumber, newNumber, noNewlineAtEnd: false });

const hunk = (lines: DiffLine[]): DiffHunk => ({ header: "@@ -1,1 +1,1 @@", section: "", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines });

const defaultHunks = (): DiffHunk[] => [hunk([line("delete", "const a = 1;", 1, null), line("add", "const a = 2;", null, 1), line("context", "export {};", 2, 2)])];

const file = (overrides: Partial<DiffFile> = {}): DiffFile => ({
  index: 0,
  oldPath: "src/app.ts",
  newPath: "src/app.ts",
  path: "src/app.ts",
  status: "modified",
  binary: false,
  modeChange: null,
  similarity: null,
  additions: 1,
  deletions: 1,
  hunks: defaultHunks(),
  ...overrides,
});

const renderFileDiff = (overrides: Partial<Parameters<typeof FileDiff>[0]> = {}) => {
  const props = {
    file: file(),
    layout: "unified" as const,
    collapsed: false,
    viewed: false,
    active: false,
    onToggleCollapsed: vi.fn(),
    onToggleViewed: vi.fn(),
    ...overrides,
  };
  const utils = render(<FileDiff {...props} />);
  return { ...utils, props };
};

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

it("renders the section with the per-index DOM id, path label and active modifier", () => {
  const { container } = renderFileDiff({ file: file({ index: 3 }), active: true });
  const section = container.querySelector("section");
  expect(section?.id).toBe("pr-review-file-3");
  expect(section?.getAttribute("aria-label")).toBe("src/app.ts");
  expect(section?.classList.contains("pr-review-file")).toBe(true);
  expect(section?.classList.contains("is-active")).toBe(true);
  expect(section?.classList.contains("is-collapsed")).toBe(false);
  expect(container.querySelector("#pr-review-file-3-body")).not.toBeNull();
});

it("toggle exposes aria-expanded, aria-controls and the expand/collapse label", () => {
  const { container } = renderFileDiff({ file: file({ index: 2 }) });
  const toggle = screen.getByRole("button", { name: "Collapse src/app.ts" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-controls")).toBe("pr-review-file-2-body");
  expect(toggle.classList.contains("pr-review-file-toggle")).toBe(true);
  expect(container.querySelector(".pr-review-chevron")?.textContent).toBe("▾");
});

it("clicking the toggle calls onToggleCollapsed with file.index", () => {
  const { props } = renderFileDiff({ file: file({ index: 4 }) });
  fireEvent.click(screen.getByRole("button", { name: "Collapse src/app.ts" }));
  expect(props.onToggleCollapsed).toHaveBeenCalledWith(4);
});

it("collapsed: label flips, aria-expanded is false, body and table are absent", () => {
  const { container } = renderFileDiff({ collapsed: true, file: file({ index: 1 }) });
  const toggle = screen.getByRole("button", { name: "Expand src/app.ts" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".pr-review-chevron")?.textContent).toBe("▸");
  expect(container.querySelector("section")?.classList.contains("is-collapsed")).toBe(true);
  expect(container.querySelector("#pr-review-file-1-body")).toBeNull();
  expect(container.querySelector("table")).toBeNull();
});

it.each([
  ["added", "Added"],
  ["deleted", "Deleted"],
  ["modified", "Modified"],
  ["renamed", "Renamed"],
  ["copied", "Copied"],
] as const)("status %s shows the pill text %s with a matching modifier", (status, text) => {
  const { container } = renderFileDiff({ file: file({ status, oldPath: "src/app.ts", newPath: "src/app.ts" }) });
  const pill = container.querySelector(".pr-review-file-status");
  expect(pill?.textContent).toBe(text);
  expect(pill?.classList.contains(`is-${status}`)).toBe(true);
});

it("renamed file with distinct paths shows old → new in the path heading", () => {
  const { container } = renderFileDiff({
    file: file({ status: "renamed", oldPath: "src/old.ts", newPath: "src/new/name.ts", path: "src/new/name.ts", similarity: 90, hunks: [] }),
  });
  expect(container.querySelector(".pr-review-file-old")?.textContent).toBe("src/old.ts");
  expect(container.querySelector(".pr-review-file-new")?.textContent).toBe("src/new/name.ts");
  const heading = container.querySelector("h3.pr-review-file-path");
  expect(heading?.getAttribute("title")).toBe("src/new/name.ts");
  expect(heading?.textContent).toContain("→");
});

it("path heading splits into dir (with trailing slash) and base spans", () => {
  const { container } = renderFileDiff({ file: file({ path: "src/components/app.ts", oldPath: "src/components/app.ts", newPath: "src/components/app.ts" }) });
  const heading = container.querySelector("h3.pr-review-file-path");
  expect(heading?.getAttribute("title")).toBe("src/components/app.ts");
  expect(container.querySelector(".pr-review-file-dir")?.textContent).toBe("src/components/");
  expect(container.querySelector(".pr-review-file-base")?.textContent).toBe("app.ts");
});

it("root-level file has no dir span", () => {
  const { container } = renderFileDiff({ file: file({ path: "README.md", oldPath: "README.md", newPath: "README.md" }) });
  expect(container.querySelector(".pr-review-file-dir")).toBeNull();
  expect(container.querySelector(".pr-review-file-base")?.textContent).toBe("README.md");
});

it("shows +N and U+2212 −N counts plus a five-segment diff bar", () => {
  const { container } = renderFileDiff({ file: file({ additions: 3, deletions: 2 }) });
  expect(container.querySelector(".pr-review-add")?.textContent).toBe("+3");
  expect(container.querySelector(".pr-review-del")?.textContent).toBe("−2");
  expect(container.querySelectorAll(".pr-review-bar-seg")).toHaveLength(5);
});

it("viewed checkbox reflects the viewed prop and calls onToggleViewed with file.path", () => {
  const { container, props } = renderFileDiff({ viewed: false, file: file({ path: "src/app.ts" }) });
  const label = container.querySelector("label.pr-review-viewed-toggle");
  expect(label?.textContent).toContain("Viewed");
  const checkbox = label?.querySelector("input[type=checkbox]") as HTMLInputElement | null;
  expect(checkbox).not.toBeNull();
  expect(checkbox?.checked).toBe(false);
  fireEvent.click(checkbox as HTMLInputElement);
  expect(props.onToggleViewed).toHaveBeenCalledWith("src/app.ts");
});

it("viewed: checkbox is checked and the section gets is-viewed", () => {
  const { container } = renderFileDiff({ viewed: true });
  const checkbox = container.querySelector("label.pr-review-viewed-toggle input[type=checkbox]") as HTMLInputElement | null;
  expect(checkbox?.checked).toBe(true);
  expect(container.querySelector("section")?.classList.contains("is-viewed")).toBe(true);
});

it("binary file shows the binary note, no counts and no table", () => {
  const { container } = renderFileDiff({ file: file({ binary: true, hunks: [], additions: 0, deletions: 0 }) });
  expect(container.querySelector(".pr-review-file-note")?.textContent).toContain("Binary file not shown.");
  expect(container.querySelector(".pr-review-add")).toBeNull();
  expect(container.querySelector(".pr-review-del")).toBeNull();
  expect(container.querySelector(".pr-review-bar")).toBeNull();
  expect(container.querySelector("table")).toBeNull();
});

it("mode-only change shows the old and new mode", () => {
  const { container } = renderFileDiff({
    file: file({ hunks: [], additions: 0, deletions: 0, modeChange: { oldMode: "100644", newMode: "100755" } }),
  });
  expect(container.querySelector(".pr-review-file-note")?.textContent).toContain("File mode changed from 100644 to 100755.");
  expect(container.querySelector("table")).toBeNull();
});

it("rename without content changes shows the rename note", () => {
  const { container } = renderFileDiff({
    file: file({ status: "renamed", oldPath: "a.ts", newPath: "b.ts", path: "b.ts", similarity: 100, hunks: [], additions: 0, deletions: 0 }),
  });
  expect(container.querySelector(".pr-review-file-note")?.textContent).toContain("File renamed without changes.");
});

it("copied file without content changes shows the copy note", () => {
  const { container } = renderFileDiff({
    file: file({ status: "copied", oldPath: "a.ts", newPath: "b.ts", path: "b.ts", similarity: 100, hunks: [], additions: 0, deletions: 0 }),
  });
  expect(container.querySelector(".pr-review-file-note")?.textContent).toContain("File copied without changes.");
});

it("added file with no hunks shows the empty-file note", () => {
  const { container } = renderFileDiff({
    file: file({ status: "added", oldPath: null, newPath: "new.ts", path: "new.ts", hunks: [], additions: 0, deletions: 0 }),
  });
  expect(container.querySelector(".pr-review-file-note")?.textContent).toContain("Empty file.");
});

it("modified file with no hunks and no mode change shows the no-changes note", () => {
  const { container } = renderFileDiff({ file: file({ hunks: [], additions: 0, deletions: 0 }) });
  expect(container.querySelector(".pr-review-file-note")?.textContent).toContain("No changes to show.");
});

it("normal file renders the diff table inside the scroll wrapper with the path label", () => {
  const { container } = renderFileDiff({ file: file({ path: "src/app.ts", index: 0 }) });
  const table = container.querySelector("table.pr-review-diff");
  expect(table).not.toBeNull();
  expect(table?.getAttribute("aria-label")).toBe("Diff for src/app.ts");
  expect(container.querySelector("#pr-review-file-0-body .pr-review-diff-scroll table")).not.toBeNull();
  expect(container.querySelector(".pr-review-file-note")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load diff" })).toBeNull();
});

it("large file (over 400 changed lines) is gated until Load diff is pressed", () => {
  const { container } = renderFileDiff({ file: file({ additions: 300, deletions: 150 }) });
  const note = container.querySelector(".pr-review-file-note");
  expect(note?.textContent).toContain(`Large diff not rendered (${(450).toLocaleString()} changed lines).`);
  expect(container.querySelector("table")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
  expect(container.querySelector("table.pr-review-diff")?.getAttribute("aria-label")).toBe("Diff for src/app.ts");
  expect(container.querySelector(".pr-review-file-note")).toBeNull();
});

it("large-file count uses locale grouping (1,001 changed lines)", () => {
  const { container } = renderFileDiff({ file: file({ additions: 1000, deletions: 1 }) });
  expect(container.querySelector(".pr-review-file-note")?.textContent).toContain(`(${(1001).toLocaleString()} changed lines).`);
});

it.each(["package-lock.json", "src/__snapshots__/a.test.ts.snap"])("generated file %s is gated until Load diff is pressed", (path) => {
  const { container } = renderFileDiff({ file: file({ path, oldPath: path, newPath: path }) });
  expect(container.querySelector(".pr-review-file-note")?.textContent).toContain("Generated file not rendered.");
  expect(container.querySelector("table")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
  expect(container.querySelector("table.pr-review-diff")).not.toBeNull();
});

it("copy button writes the path, shows Copied for 1500 ms, then reverts", async () => {
  vi.useFakeTimers();
  const { container } = renderFileDiff({ file: file({ path: "src/app.ts" }) });
  const copy = container.querySelector("button.pr-review-copy") as HTMLButtonElement;
  expect(copy.getAttribute("aria-label")).toBe("Copy file path");
  expect(copy.textContent).toBe("⧉");
  await act(async () => {
    fireEvent.click(copy);
  });
  expect(writeText).toHaveBeenCalledWith("src/app.ts");
  expect(copy.textContent).toBe("Copied");
  act(() => {
    vi.advanceTimersByTime(1499);
  });
  expect(copy.textContent).toBe("Copied");
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(copy.textContent).toBe("⧉");
  expect(copy.getAttribute("aria-label")).toBe("Copy file path");
});

it("copy does not show Copied when the clipboard write is rejected", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  const { container } = renderFileDiff();
  const copy = container.querySelector("button.pr-review-copy") as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(copy);
  });
  expect(writeText).toHaveBeenCalledWith("src/app.ts");
  expect(copy.textContent).toBe("⧉");
});

it("copy does not throw or show Copied when the clipboard write throws synchronously", async () => {
  writeText.mockImplementation(() => {
    throw new Error("denied");
  });
  const { container } = renderFileDiff();
  const copy = container.querySelector("button.pr-review-copy") as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(copy);
  });
  expect(copy.textContent).toBe("⧉");
});

it("untrusted path and diff text render as inert text", () => {
  const hostilePath = "dir<img src=x onerror=bad()>/<script>bad()</script>.ts";
  const { container } = renderFileDiff({
    file: file({
      path: hostilePath,
      oldPath: hostilePath,
      newPath: hostilePath,
      hunks: [hunk([line("add", "<svg onload=bad()>", null, 1)])],
      additions: 1,
      deletions: 0,
    }),
  });
  expect(container.querySelector("img,script,svg")).toBeNull();
  expect(container.textContent).toContain(hostilePath);
  expect(container.textContent).toContain("+<svg onload=bad()>");
});
