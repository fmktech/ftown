import { defineConfig, devices } from "@playwright/test";
import type { PlaywrightTestConfig } from "@playwright/test";
import { resolve } from "node:path";
import { E2E_DIR, UI_BASE_URL } from "./helpers/config";

const expectedBrowserHome = resolve(E2E_DIR, ".browser-home");
const browserHome = process.env.E2E_BROWSER_HOME ?? expectedBrowserHome;
if (browserHome !== expectedBrowserHome) {
  throw new Error("E2E_BROWSER_HOME must be the canonical e2e/.browser-home path");
}

// Only these independently owned account fixtures may run alongside the shared lane.
function exactTestPath(filename: string): RegExp {
  const absolutePath = resolve(E2E_DIR, "tests", filename);
  return new RegExp(`^${absolutePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}
const isolatedTests = [
  exactTestPath("account-trust.spec.ts"),
  exactTestPath("pending-approvals.spec.ts"),
];

const chromiumUse: NonNullable<PlaywrightTestConfig["use"]> = {
  ...devices["Desktop Chrome"],
  // Use bundled Chromium's new headless mode instead of the separate headless shell.
  channel: "chromium",
  launchOptions: {
    // Trust only the fixture peer in the isolated browser NSS store.
    // Node keeps its own HOME, executable cache and artifact locations.
    env: {
      ...process.env,
      HOME: browserHome,
      XDG_DATA_HOME: resolve(browserHome, ".local/share"),
      XDG_CONFIG_HOME: resolve(browserHome, ".config"),
      XDG_CACHE_HOME: resolve(browserHome, ".cache"),
    },
    args: [
      // The bridge cannot resolve Chromium's mDNS host candidates. This lets
      // Test A exercise the direct WebRTC path without disabling TLS checks.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
};

/**
 * Both Chromium projects use services started OUTSIDE Playwright (by scripts/CI)
 * so the bridge has a scratch HOME and recorded PIDs for precise teardown.
 * No global webServer here.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["json", { outputFile: "test-results/results.json" }]],
  use: {
    baseURL: UI_BASE_URL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      workers: 1,
      fullyParallel: false,
      testIgnore: isolatedTests,
      use: chromiumUse,
    },
    {
      name: "chromium-isolated",
      fullyParallel: true,
      testMatch: isolatedTests,
      use: chromiumUse,
    },
  ],
});
