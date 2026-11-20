// @vitest-environment jsdom
import { renderHook, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useBridgeIdentities } from "./useBridgeIdentities";

afterEach(() => { cleanup(); localStorage.clear(); });

it("retains numbers and known names when computers disconnect, reconnect or change order", () => {
  const sessions = [{ bridgeId: "desk" }];
  const first = [{ bridgeId: "desk", label: "Studio desk" }];
  const hook = renderHook(({ known }) => useBridgeIdentities("account", known, sessions), { initialProps: { known: first } });
  expect(hook.result.current.get("desk")).toEqual({ number: 1, name: "Studio desk" });
  hook.rerender({ known: [{ bridgeId: "air", label: "Air" }] });
  expect(hook.result.current.get("air")?.number).toBe(2);
  hook.unmount();
  const restore = renderHook(() => useBridgeIdentities("account", first, sessions));
  expect(restore.result.current.get("desk")).toEqual({ number: 1, name: "Studio desk" });
  expect(restore.result.current.get("air")?.number).toBe(2);
});
