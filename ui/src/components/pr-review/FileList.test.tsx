// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DiffFile, DiffFileStatus } from "@/lib/pr-diff-types";
import { FileList } from "./FileList";

afterEach(cleanup);

function file(index: number, path: string, overrides: Partial<Omit<DiffFile, "index" | "path">> & { status?: DiffFileStatus } = {}): DiffFile {
  const status = overrides.status ?? "modified";
  return {
    index,
    oldPath: status === "added" ? null : path,
    newPath: status === "deleted" ? null : path,
    path,
    status,
    binary: false,
    modeChange: null,
    similarity: null,
    additions: 0,
    deletions: 0,
    hunks: [],
    ...overrides,
  };
}

const files: DiffFile[] = [
  file(0, "src/app/page.tsx", { additions: 3, deletions: 2 }),
  file(1, "README.md", { status: "added", additions: 5, deletions: 0 }),
  file(2, "old/gone.ts", { status: "deleted", additions: 0, deletions: 7 }),
  file(3, "logo.png", { binary: true }),
];

function item(path: string): HTMLElement {
  return screen.getByRole("button", { name: path });
}

it("renders a named navigation landmark with one button per file named by its path", () => {
  render(<FileList files={files} activeIndex={null} viewed={new Set()} onSelect={vi.fn()} />);
  const nav = screen.getByRole("navigation", { name: "Changed files" });
  expect(nav.querySelectorAll("li > button.pr-review-filelist-item")).toHaveLength(4);
  for (const f of files) {
    expect(item(f.path).getAttribute("title")).toBe(f.path);
    expect(item(f.path).getAttribute("aria-label")).toBe(f.path);
  }
});

it("renders status letters with their status classes", () => {
  render(<FileList files={files} activeIndex={null} viewed={new Set()} onSelect={vi.fn()} />);
  const letter = (path: string) => item(path).querySelector(".pr-review-status-letter");
  expect(letter("src/app/page.tsx")?.textContent).toBe("M");
  expect(letter("src/app/page.tsx")?.className).toContain("is-modified");
  expect(letter("README.md")?.textContent).toBe("A");
  expect(letter("README.md")?.className).toContain("is-added");
  expect(letter("old/gone.ts")?.textContent).toBe("D");
  expect(letter("old/gone.ts")?.className).toContain("is-deleted");
});

it("renders renamed and copied status letters", () => {
  render(
    <FileList
      files={[file(0, "new/name.ts", { status: "renamed", oldPath: "old/name.ts", newPath: "new/name.ts", similarity: 90 }), file(1, "copy.ts", { status: "copied", oldPath: "orig.ts", newPath: "copy.ts", similarity: 95 })]}
      activeIndex={null}
      viewed={new Set()}
      onSelect={vi.fn()}
    />,
  );
  expect(item("new/name.ts").querySelector(".pr-review-status-letter")?.textContent).toBe("R");
  expect(item("new/name.ts").querySelector(".pr-review-status-letter")?.className).toContain("is-renamed");
  expect(item("copy.ts").querySelector(".pr-review-status-letter")?.textContent).toBe("C");
  expect(item("copy.ts").querySelector(".pr-review-status-letter")?.className).toContain("is-copied");
});

it("splits the path into base and directory, omitting the directory span for root files", () => {
  const { container } = render(<FileList files={files} activeIndex={null} viewed={new Set()} onSelect={vi.fn()} />);
  const page = item("src/app/page.tsx");
  expect(page.querySelector(".pr-review-filelist-base")?.textContent).toBe("page.tsx");
  expect(page.querySelector(".pr-review-filelist-dir")?.textContent).toBe("src/app");
  const readme = item("README.md");
  expect(readme.querySelector(".pr-review-filelist-base")?.textContent).toBe("README.md");
  expect(readme.querySelector(".pr-review-filelist-dir")).toBeNull();
  expect(container.querySelectorAll(".pr-review-filelist-dir")).toHaveLength(2);
});

it("shows add and delete counts with a U+2212 minus and omits zero counts", () => {
  render(<FileList files={files} activeIndex={null} viewed={new Set()} onSelect={vi.fn()} />);
  const page = item("src/app/page.tsx");
  expect(page.querySelector(".pr-review-add")?.textContent).toBe("+3");
  expect(page.querySelector(".pr-review-del")?.textContent).toBe("−2");
  expect(page.textContent).toContain("−2");

  const readme = item("README.md");
  expect(readme.querySelector(".pr-review-add")?.textContent).toBe("+5");
  expect(readme.querySelector(".pr-review-del")).toBeNull();

  const gone = item("old/gone.ts");
  expect(gone.querySelector(".pr-review-add")).toBeNull();
  expect(gone.querySelector(".pr-review-del")?.textContent).toBe("−7");
});

it("shows no counts for binary files", () => {
  render(<FileList files={files} activeIndex={null} viewed={new Set()} onSelect={vi.fn()} />);
  const logo = item("logo.png");
  expect(logo.querySelector(".pr-review-add")).toBeNull();
  expect(logo.querySelector(".pr-review-del")).toBeNull();
  expect(logo.textContent).not.toMatch(/[+−]\d/);
});

it("marks viewed files with is-viewed and a hidden check mark", () => {
  render(<FileList files={files} activeIndex={null} viewed={new Set(["README.md"])} onSelect={vi.fn()} />);
  const readme = item("README.md");
  expect(readme.className).toContain("is-viewed");
  const check = readme.querySelector(".pr-review-filelist-viewed");
  expect(check?.textContent).toBe("✓");
  expect(check?.getAttribute("aria-hidden")).toBe("true");

  const page = item("src/app/page.tsx");
  expect(page.className).not.toContain("is-viewed");
  expect(page.querySelector(".pr-review-filelist-viewed")).toBeNull();
});

it("sets aria-current only on the active file", () => {
  render(<FileList files={files} activeIndex={1} viewed={new Set()} onSelect={vi.fn()} />);
  expect(item("README.md").getAttribute("aria-current")).toBe("true");
  expect(item("src/app/page.tsx").hasAttribute("aria-current")).toBe(false);
  expect(item("old/gone.ts").hasAttribute("aria-current")).toBe(false);
  expect(item("logo.png").hasAttribute("aria-current")).toBe(false);
});

it("sets no aria-current when activeIndex is null", () => {
  const { container } = render(<FileList files={files} activeIndex={null} viewed={new Set()} onSelect={vi.fn()} />);
  expect(container.querySelector("[aria-current]")).toBeNull();
});

it("calls onSelect with the file index when an item is clicked", () => {
  const onSelect = vi.fn();
  render(<FileList files={files} activeIndex={null} viewed={new Set()} onSelect={onSelect} />);
  fireEvent.click(item("old/gone.ts"));
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith(2);
  fireEvent.click(item("src/app/page.tsx"));
  expect(onSelect).toHaveBeenLastCalledWith(0);
});

it("moves focus down and up with ArrowDown and ArrowUp without wrapping", () => {
  render(<FileList files={files} activeIndex={null} viewed={new Set()} onSelect={vi.fn()} />);
  const buttons = files.map(f => item(f.path));
  buttons[0]!.focus();
  expect(document.activeElement).toBe(buttons[0]);

  fireEvent.keyDown(buttons[0]!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(buttons[1]);
  fireEvent.keyDown(buttons[1]!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(buttons[2]);

  fireEvent.keyDown(buttons[2]!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(buttons[1]);
  fireEvent.keyDown(buttons[1]!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(buttons[0]);

  fireEvent.keyDown(buttons[0]!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(buttons[0]);

  buttons[3]!.focus();
  fireEvent.keyDown(buttons[3]!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(buttons[3]);
});

it("does not call onSelect on arrow key navigation", () => {
  const onSelect = vi.fn();
  render(<FileList files={files} activeIndex={null} viewed={new Set()} onSelect={onSelect} />);
  fireEvent.keyDown(item("src/app/page.tsx"), { key: "ArrowDown" });
  expect(onSelect).not.toHaveBeenCalled();
});

it("renders hostile path text as inert text with no markup elements", () => {
  const hostile = "<img src=x onerror=alert(1)>/<svg onload=bad()>.ts";
  const { container } = render(
    <FileList files={[file(0, hostile, { additions: 1 }), file(1, "<script>bad()<script>.md", { status: "added" })]} activeIndex={0} viewed={new Set([hostile])} onSelect={vi.fn()} />,
  );
  expect(container.querySelector("img,script,svg")).toBeNull();
  expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  expect(screen.getByText("<script>bad()<script>.md")).toBeTruthy();
  expect(container.textContent).toContain("<svg onload=bad()>.ts");
});
