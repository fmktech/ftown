import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { E2E_DIR, UI_BASE_URL } from "./helpers/config";

const expectedBrowserHome = resolve(E2E_DIR, ".browser-home");
const browserHome = process.env.E2E_BROWSER_HOME ?? expectedBrowserHome;
if (browserHome !== expectedBrowserHome) {
  throw new Error("E2E_BROWSER_HOME must be the canonical e2e/.browser-home path");
}

/**
 * One chromium project. The UI, bridge, centrifugo, postgres and the neon shim are
 * started OUTSIDE Playwright (by scripts/CI) so we can control HOME for the bridge
 * and record PIDs for precise teardown. No global webServer here.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: UI_BASE_URL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Use bundled Chromium's new headless mode instead of the separate headless shell.
        channel: "chromium",
        // Direct transport needs WebRTC; ensure it is available and does not
        // require real network permissions in headless CI.
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
            // Chromium obfuscates local host ICE candidates behind mDNS `.local`
            // hostnames, which the bridge's libdatachannel cannot resolve on the
            // same host, so WebRTC pairing would always time out and fall back.
            // Disabling this makes the browser emit real host IPs so the direct
            // DataChannel can actually connect — WITHOUT this, Test A can never
            // exercise the direct path. (Does not affect Test B, which disables
            // WebRTC entirely.)
            "--disable-features=WebRtcHideLocalIpsWithMdns",
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
          ],
        },
      },
    },
  ],
});
