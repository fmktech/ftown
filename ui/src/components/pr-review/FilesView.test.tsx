// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DiffFile, DiffLine, ParsedDiff } from "@/lib/pr-diff-types";
import { PR_REVIEW_STORAGE } from "@/lib/pr-review-types";
import { FilesView } from "./FilesView";

const line = (kind: DiffLine["kind"], text: string, oldNumber: number | null, newNumber: number | null): DiffLine => ({ kind, text, oldNumber, newNumber, noNewlineAtEnd: false });

function file(index: number, path: string, status: DiffFile["status"] = "modified", text = "new"): DiffFile {
  return {
    index, oldPath: status === "added" ? null : path, newPath: path, path, status, binary: false, modeChange: null, similarity: null, additions: 1, deletions: 1,
    hunks: [{ header: "@@ -1,1 +1,1 @@", section: "", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [line("delete", "old", 1, null), line("add", text, null, 1)] }],
  };
}
const files = [file(0, "src/alpha.ts"), file(1, "src/Beta.ts", "added"), file(2, "README.md")];
const diff: ParsedDiff = { files, additions: 3, deletions: 3, lineCount: 6 };
const SCOPE = "https://github.com/o/r/pull/1@abc";

function stubWide(width: number) {
  class FakeResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      const rect = { width, height: 600, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 600, toJSON: () => ({}) } as DOMRectReadOnly;
      this.cb([{ target, contentRect: rect, borderBoxSize: [{ inlineSize: width, blockSize: 600 }], contentBoxSize: [{ inlineSize: width, blockSize: 600 }], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width, height: 600, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 600, toJSON: () => ({}) } as DOMRect);
}

const renderView = (d: ParsedDiff = diff) => render(<FilesView diff={d} viewedScopeKey={SCOPE} />);
const card = (container: HTMLElement, index: number) => container.querySelector<HTMLElement>(`#pr-review-file-${index}`);

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it("shows only the empty note for a diff without files", () => {
  const { container } = renderView({ files: [], additions: 0, deletions: 0, lineCount: 0 });
  expect(container.querySelector(".pr-review-files")).toBeTruthy();
  expect(screen.getByText("No file changes in this pull request.").className).toContain("pr-review-empty-note");
  expect(container.querySelector(".pr-review-file")).toBeNull();
  expect(container.querySelector(".pr-review-toolbar")).toBeNull();
});

it("renders one card per file and is narrow without ResizeObserver", () => {
  const { container } = renderView();
  expect(container.querySelectorAll("section.pr-review-file")).toHaveLength(3);
  expect(container.querySelector(".pr-review-files")?.className).not.toContain("is-wide");
  expect(container.querySelector("aside.pr-review-sidebar")).toBeNull();
  expect(screen.queryByRole("group", { name: "Diff layout" })).toBeNull();
});

it("filters list and cards case-insensitively and shows a no-match note", () => {
  const { container } = renderView();
  const input = screen.getByLabelText("Filter changed files");
  fireEvent.change(input, { target: { value: "  BETA " } });
  expect(container.querySelectorAll("section.pr-review-file")).toHaveLength(1);
  expect(card(container, 1)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Files \(\d+\)$/ }));
  const nav = screen.getByRole("navigation", { name: "Changed files" });
  expect(within(nav).getAllByRole("button")).toHaveLength(1);
  expect(within(nav).getByRole("button", { name: "src/Beta.ts" })).toBeTruthy();
  fireEvent.change(input, { target: { value: "zzz" } });
  expect(container.querySelectorAll("section.pr-review-file")).toHaveLength(0);
  expect(screen.getByText("No files match “zzz”.").className).toContain("pr-review-empty-note");
});

it("viewed toggle collapses the card and updates progress", () => {
  const { container } = renderView();
  expect(screen.getByText("0 / 3 viewed")).toBeTruthy();
  const box = within(card(container, 0) as HTMLElement).getByRole("checkbox");
  fireEvent.click(box);
  expect(screen.getByText("1 / 3 viewed")).toBeTruthy();
  expect(card(container, 0)?.className).toContain("is-collapsed");
  expect(card(container, 0)?.className).toContain("is-viewed");
  expect(container.querySelector<HTMLElement>(".pr-review-viewed-fill")?.style.width).toMatch(/^33(\.\d+)?%$/);
  expect(card(container, 1)?.className).not.toContain("is-collapsed");
  fireEvent.click(within(card(container, 0) as HTMLElement).getByRole("checkbox"));
  expect(screen.getByText("0 / 3 viewed")).toBeTruthy();
  expect(card(container, 0)?.className).not.toContain("is-collapsed");
});

it("starts files already viewed in a previous visit collapsed", () => {
  localStorage.setItem(`${PR_REVIEW_STORAGE.viewedPrefix}${SCOPE}`, JSON.stringify(["README.md"]));
  const { container } = renderView();
  expect(screen.getByText("1 / 3 viewed")).toBeTruthy();
  expect(card(container, 2)?.className).toContain("is-collapsed");
  expect(card(container, 0)?.className).not.toContain("is-collapsed");
});

it("Collapse all / Expand all act on visible files", () => {
  const { container } = renderView();
  fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
  expect(container.querySelectorAll(".pr-review-file.is-collapsed")).toHaveLength(3);
  expect(container.querySelector("table")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
  expect(container.querySelectorAll(".pr-review-file.is-collapsed")).toHaveLength(0);
  expect(container.querySelectorAll("table")).toHaveLength(3);
});

it("selecting a collapsed file in the list expands it and scrolls to it", () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: scrollIntoView });
  try {
    const { container } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    fireEvent.click(screen.getByRole("button", { name: "Files (3)" }));
    const nav = screen.getByRole("navigation", { name: "Changed files" });
    fireEvent.click(within(nav).getByRole("button", { name: "src/Beta.ts" }));
    expect(card(container, 1)?.className).not.toContain("is-collapsed");
    expect(card(container, 0)?.className).toContain("is-collapsed");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(screen.queryByRole("navigation", { name: "Changed files" })).toBeNull();
  } finally {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

it("narrow: Files toggle opens and closes the drawer", () => {
  const { container } = renderView();
  const toggle = screen.getByRole("button", { name: "Files (3)" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-controls")).toBe("pr-review-file-drawer");
  expect(container.querySelector("#pr-review-file-drawer")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("#pr-review-file-drawer")?.querySelector("nav")).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Diff layout" })).toBeNull();
  fireEvent.click(toggle);
  expect(container.querySelector("#pr-review-file-drawer")).toBeNull();
});

it("wide: shows sidebar, layout group, persists Split and applies it", () => {
  stubWide(1000);
  const { container } = renderView();
  expect(container.querySelector(".pr-review-files")?.className).toContain("is-wide");
  expect(container.querySelector("aside.pr-review-sidebar nav")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Files \(/ })).toBeNull();
  const group = screen.getByRole("group", { name: "Diff layout" });
  expect(within(group).getByRole("button", { name: "Unified" }).getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelectorAll("table.is-unified")).toHaveLength(3);
  fireEvent.click(within(group).getByRole("button", { name: "Split" }));
  expect(within(group).getByRole("button", { name: "Split" }).getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelectorAll("table.is-split")).toHaveLength(3);
  expect(JSON.parse(localStorage.getItem(PR_REVIEW_STORAGE.layout) ?? "{}")).toMatchObject({ layout: "split", wrap: false });
});

it("wide: restores a persisted split layout; narrow ignores it", () => {
  localStorage.setItem(PR_REVIEW_STORAGE.layout, JSON.stringify({ layout: "split", wrap: true }));
  const narrow = renderView();
  expect(narrow.container.querySelectorAll("table.is-split")).toHaveLength(0);
  expect(narrow.container.querySelector(".pr-review-files")?.className).toContain("is-wrapped");
  cleanup();
  stubWide(1000);
  const wide = renderView();
  expect(wide.container.querySelectorAll("table.is-split")).toHaveLength(3);
});

it("ignores invalid persisted layout preferences", () => {
  localStorage.setItem(PR_REVIEW_STORAGE.layout, JSON.stringify({ layout: "bogus", wrap: "yes" }));
  const { container } = renderView();
  expect(container.querySelector(".pr-review-files")?.className).not.toContain("is-wrapped");
  expect(screen.getByRole("button", { name: "Wrap" }).getAttribute("aria-pressed")).toBe("false");
});

it("Wrap toggles is-wrapped and aria-pressed", () => {
  const { container } = renderView();
  const wrap = screen.getByRole("button", { name: "Wrap" });
  expect(wrap.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(wrap);
  expect(wrap.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector(".pr-review-files")?.className).toContain("is-wrapped");
  expect(JSON.parse(localStorage.getItem(PR_REVIEW_STORAGE.layout) ?? "{}")).toMatchObject({ wrap: true });
  fireEvent.click(wrap);
  expect(container.querySelector(".pr-review-files")?.className).not.toContain("is-wrapped");
});

it("active tracking uses IntersectionObserver and disconnects on unmount", () => {
  const instances: { cb: IntersectionObserverCallback; observed: Element[]; disconnect: ReturnType<typeof vi.fn>; options?: IntersectionObserverInit }[] = [];
  class FakeIO {
    observed: Element[] = [];
    disconnect = vi.fn();
    constructor(public cb: IntersectionObserverCallback, public options?: IntersectionObserverInit) { instances.push(this); }
    observe(el: Element) { this.observed.push(el); }
    unobserve() {}
    takeRecords() { return []; }
  }
  vi.stubGlobal("IntersectionObserver", FakeIO);
  const { container, unmount } = renderView();
  expect(card(container, 0)?.className).toContain("is-active");
  const io = instances[instances.length - 1];
  expect(io.options?.rootMargin).toBe("0px 0px -70% 0px");
  expect(io.observed.length).toBeGreaterThanOrEqual(3);
  const target = card(container, 2) as HTMLElement;
  act(() => { io.cb([{ target, isIntersecting: true, boundingClientRect: { top: 0 } as DOMRectReadOnly } as unknown as IntersectionObserverEntry], io as unknown as IntersectionObserver); });
  expect(card(container, 2)?.className).toContain("is-active");
  expect(card(container, 0)?.className).not.toContain("is-active");
  unmount();
  expect(instances.some(i => i.disconnect.mock.calls.length > 0)).toBe(true);
});

it("renders hostile paths and diff text as inert text", () => {
  const evil = file(0, "<img src=x onerror=bad()>.ts", "modified", "<svg onload=bad()>");
  const { container } = renderView({ files: [evil], additions: 1, deletions: 1, lineCount: 2 });
  expect(container.querySelector("img,script,svg")).toBeNull();
  expect(container.textContent).toContain("<img src=x onerror=bad()>");
  expect(container.textContent).toContain("+<svg onload=bad()>");
});
