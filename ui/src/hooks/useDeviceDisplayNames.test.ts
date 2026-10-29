// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDeviceDisplayNames } from "./useDeviceDisplayNames";

const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const deferred = () => { let resolve!: (response: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve }; };
const target = { kind: "browser" as const, id: "one" };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("fences a stale GET after saving and rejects concurrent local writes", async () => {
  const get = deferred(), put = deferred();
  const fetcher = vi.fn().mockReturnValueOnce(get.promise).mockReturnValueOnce(put.promise); vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useDeviceDisplayNames("owner"));
  let first!: Promise<boolean>, second!: Promise<boolean>;
  act(() => { first = result.current.setName({ ...target, name: "New" }); second = result.current.setName({ ...target, name: "Other" }); });
  expect(await second).toBe(false); expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { put.resolve(reply({ name: { ...target, name: "New" } })); expect(await first).toBe(true); });
  await act(async () => { get.resolve(reply({ names: [{ ...target, name: "Old" }], eligible: [target] })); await get.promise; });
  expect(result.current.names).toEqual([{ ...target, name: "New" }]);
});

it("aborts and fences reads and writes across owners", async () => {
  const oldGet = deferred(), oldPut = deferred(), newGet = deferred();
  const fetcher = vi.fn().mockReturnValueOnce(oldGet.promise).mockReturnValueOnce(oldPut.promise).mockReturnValueOnce(newGet.promise); vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = renderHook(({ owner }) => useDeviceDisplayNames(owner), { initialProps: { owner: "a" } });
  let save!: Promise<boolean>;
  act(() => { save = result.current.setName({ ...target, name: "Old owner" }); });
  rerender({ owner: "b" });
  expect((fetcher.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
  expect((fetcher.mock.calls[1][1].signal as AbortSignal).aborted).toBe(true);
  await act(async () => { newGet.resolve(reply({ names: [], eligible: [target] })); await newGet.promise; });
  await act(async () => { oldGet.resolve(reply({ names: [{ ...target, name: "Old" }], eligible: [target] })); oldPut.resolve(reply({ name: { ...target, name: "Old owner" } })); expect(await save).toBe(false); });
  expect(result.current.names).toEqual([]); expect(result.current.eligible).toEqual([target]);
});

it("keeps fallback available on failure and refreshes on focus without polling", async () => {
  const timer = vi.spyOn(window, "setInterval");
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(reply({ names: [], eligible: [target] })); vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useDeviceDisplayNames("owner"));
  expect(timer).not.toHaveBeenCalled();
  await waitFor(() => expect(result.current.error).toMatch(/Could not load/));
  expect(result.current.names).toEqual([]); expect(result.current.eligible).toEqual([]);
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(result.current.eligible).toEqual([target]));
  expect(fetcher).toHaveBeenCalledTimes(2);
});
