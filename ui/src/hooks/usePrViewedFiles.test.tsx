// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PR_REVIEW_STORAGE, PR_REVIEW_VIEWED_MAX_SCOPES } from "@/lib/pr-review-types";
import { usePrViewedFiles } from "./usePrViewedFiles";

const prefix = PR_REVIEW_STORAGE.viewedPrefix;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("loads existing viewed paths for the scope", () => {
  localStorage.setItem(prefix + "s1", JSON.stringify(["a.ts", "b.ts"]));
  const { result } = renderHook(() => usePrViewedFiles("s1"));
  expect([...result.current.viewed].sort()).toEqual(["a.ts", "b.ts"]);
});

it("toggles a path on and off and persists both changes", () => {
  const { result } = renderHook(() => usePrViewedFiles("s1"));
  const before = result.current.viewed;

  act(() => result.current.toggle("a.ts"));
  expect(result.current.viewed.has("a.ts")).toBe(true);
  expect(result.current.viewed).not.toBe(before);
  expect(localStorage.getItem(prefix + "s1")).toBe(JSON.stringify(["a.ts"]));
  expect(JSON.parse(localStorage.getItem(PR_REVIEW_STORAGE.viewedIndex) ?? "[]")).toEqual(["s1"]);

  act(() => result.current.toggle("a.ts"));
  expect(result.current.viewed.has("a.ts")).toBe(false);
  expect(localStorage.getItem(prefix + "s1")).toBeNull();
  expect(JSON.parse(localStorage.getItem(PR_REVIEW_STORAGE.viewedIndex) ?? "[]")).toEqual([]);
});

it("ignores invalid JSON and arrays containing non-string entries", () => {
  localStorage.setItem(prefix + "bad", "{not json");
  const first = renderHook(() => usePrViewedFiles("bad"));
  expect(first.result.current.viewed.size).toBe(0);
  first.unmount();

  localStorage.setItem(prefix + "mixed", JSON.stringify(["a.ts", 1, null]));
  const second = renderHook(() => usePrViewedFiles("mixed"));
  expect(second.result.current.viewed.size).toBe(0);
});

it("keeps the 50 most recently used scopes and removes evicted values", () => {
  for (let i = 0; i <= PR_REVIEW_VIEWED_MAX_SCOPES; i++) {
    const { result, unmount } = renderHook(() => usePrViewedFiles(`s${i}`));
    act(() => result.current.toggle("f.ts"));
    unmount();
  }
  const index: unknown = JSON.parse(localStorage.getItem(PR_REVIEW_STORAGE.viewedIndex) ?? "[]");
  expect(index).toHaveLength(PR_REVIEW_VIEWED_MAX_SCOPES);
  expect(index).toEqual(Array.from({ length: PR_REVIEW_VIEWED_MAX_SCOPES }, (_, i) => `s${PR_REVIEW_VIEWED_MAX_SCOPES - i}`));
  expect(localStorage.getItem(prefix + "s0")).toBeNull();
  expect(localStorage.getItem(prefix + `s${PR_REVIEW_VIEWED_MAX_SCOPES}`)).toBe(JSON.stringify(["f.ts"]));
});

it("still toggles in memory when storage throws", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("denied");
  });
  const { result } = renderHook(() => usePrViewedFiles("s1"));
  expect(result.current.viewed.size).toBe(0);
  act(() => result.current.toggle("a.ts"));
  expect(result.current.viewed.has("a.ts")).toBe(true);
  act(() => result.current.toggle("a.ts"));
  expect(result.current.viewed.size).toBe(0);
});

it("shows the other scope's set on the first render after a scope change", () => {
  localStorage.setItem(prefix + "s1", JSON.stringify(["a.ts"]));
  localStorage.setItem(prefix + "s2", JSON.stringify(["b.ts"]));
  const seen: string[][] = [];
  const { rerender, result } = renderHook(
    ({ scope }: { scope: string }) => {
      const value = usePrViewedFiles(scope);
      seen.push([...value.viewed]);
      return value;
    },
    { initialProps: { scope: "s1" } },
  );
  expect(seen[0]).toEqual(["a.ts"]);
  const before = seen.length;
  rerender({ scope: "s2" });
  expect(seen.slice(before)).not.toContainEqual(["a.ts"]);
  expect(seen[seen.length - 1]).toEqual(["b.ts"]);
  expect([...result.current.viewed]).toEqual(["b.ts"]);
});

it("composes two toggles issued in one act() and persists both", () => {
  const { result } = renderHook(() => usePrViewedFiles("s1"));
  act(() => {
    result.current.toggle("a.ts");
    result.current.toggle("b.ts");
  });
  expect([...result.current.viewed].sort()).toEqual(["a.ts", "b.ts"]);
  expect(JSON.parse(localStorage.getItem(prefix + "s1") ?? "[]")).toEqual(["a.ts", "b.ts"]);
});

it("renders an empty set on the first render after switching to a scope with no stored entry", () => {
  localStorage.setItem(prefix + "s1", JSON.stringify(["a.ts"]));
  const seen: string[][] = [];
  const { rerender, result } = renderHook(
    ({ scope }: { scope: string }) => {
      const value = usePrViewedFiles(scope);
      seen.push([...value.viewed]);
      return value;
    },
    { initialProps: { scope: "s1" } },
  );
  const before = seen.length;
  rerender({ scope: "s3" });
  expect(seen.slice(before)).not.toContainEqual(["a.ts"]);
  expect(seen[seen.length - 1]).toEqual([]);
  act(() => result.current.toggle("c.ts"));
  expect([...result.current.viewed]).toEqual(["c.ts"]);
  expect(localStorage.getItem(prefix + "s1")).toBe(JSON.stringify(["a.ts"]));
});

it("dedupes a corrupt index so duplicate slots cannot evict a kept scope", () => {
  const others = Array.from({ length: 49 }, (_, i) => `x${i + 1}`);
  localStorage.setItem(PR_REVIEW_STORAGE.viewedIndex, JSON.stringify(["s1", "s1", ...others]));
  for (const key of ["s1", ...others]) localStorage.setItem(prefix + key, JSON.stringify(["f.ts"]));
  const { result } = renderHook(() => usePrViewedFiles("new"));
  act(() => result.current.toggle("f.ts"));
  const index: unknown = JSON.parse(localStorage.getItem(PR_REVIEW_STORAGE.viewedIndex) ?? "[]");
  expect(index).toEqual(["new", "s1", ...others.slice(0, 48)]);
  expect(localStorage.getItem(prefix + "x48")).toBe(JSON.stringify(["f.ts"]));
  expect(localStorage.getItem(prefix + "x49")).toBeNull();
  expect(localStorage.getItem(prefix + "s1")).toBe(JSON.stringify(["f.ts"]));
});

it("treats a null scope as an empty, inert set", () => {
  const { result } = renderHook(() => usePrViewedFiles(null));
  expect(result.current.viewed.size).toBe(0);
  const emptyBefore = result.current.viewed;
  act(() => result.current.toggle("a.ts"));
  expect(result.current.viewed.size).toBe(0);
  expect(result.current.viewed).toBe(emptyBefore);
  expect(localStorage.length).toBe(0);
});

it("keeps toggle identity stable across rerenders for the same scope", () => {
  const { result, rerender } = renderHook(() => usePrViewedFiles("s1"));
  const toggle = result.current.toggle;
  act(() => result.current.toggle("a.ts"));
  rerender();
  expect(result.current.toggle).toBe(toggle);
});
