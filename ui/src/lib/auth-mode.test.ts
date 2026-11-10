// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ signOut: vi.fn(), assign: vi.fn() }));
vi.mock("next-auth/react", () => ({ signOut: m.signOut }));

import { hostedSignOut } from "./auth-mode";

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear(); window.sessionStorage.clear();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign: m.assign } });
});

it("signs out without a server redirect, sets the flag, and navigates to the relative /login", async () => {
  m.signOut.mockResolvedValue(undefined);
  await hostedSignOut();
  expect(m.signOut).toHaveBeenCalledWith({ redirect: false });
  expect(window.localStorage.getItem("ftown-signed-out")).toBe("1");
  expect(m.assign).toHaveBeenCalledWith("/login");
});

it("still navigates when signOut fails", async () => {
  m.signOut.mockRejectedValue(new Error("x"));
  await hostedSignOut().catch(() => undefined);
  expect(m.assign).toHaveBeenCalledWith("/login");
});
