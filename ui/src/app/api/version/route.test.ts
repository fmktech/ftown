import { afterEach, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());
it("returns the configured build identity without caching", async () => {
  vi.stubEnv("FTOWN_UI_BUILD_ID", "build-one");
  const response = GET();
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({ buildId: "build-one" });
});
