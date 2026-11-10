import { defineConfig, devices } from "@playwright/test";
import type { PlaywrightTestConfig } from "@playwright/test";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { E2E_DIR, UI_BASE_URL } from "./helpers/config";

// Defence in depth (env.sh already does this): specs spawn the ftown CLI with
// `{ ...process.env, HOME: <test bridge home> }`, so an inherited production
// bridge's FTOWN_* / tmux variables (a run started inside an ftown session) must
// never reach them. FTOWN_PUBLIC_URL / FTOWN_BOOTSTRAP_SECRET / FTOWN_TRUSTED_PROXY
// are the harness's own settings and are kept.
for (const name of Object.keys(process.env)) {
  if ((name.startsWith("FTOWN_") && !["FTOWN_PUBLIC_URL", "FTOWN_BOOTSTRAP_SECRET", "FTOWN_TRUSTED_PROXY"].includes(name))
    || name === "TMUX" || name === "TMUX_PANE" || name === "TMUX_TMPDIR") delete process.env[name];
}

const expectedBrowserHome = resolve(E2E_DIR, ".browser-home");
const browserHome = process.env.E2E_BROWSER_HOME ?? expectedBrowserHome;
if (browserHome !== expectedBrowserHome) {
  throw new Error("E2E_BROWSER_HOME must be the canonical e2e/.browser-home path");
}

const linux = process.platform === "linux";
const https = UI_BASE_URL.startsWith("https:");
const certPath = resolve(E2E_DIR, "certs/cert.pem");

/**
 * Chromium must treat the public origin as a VALID secure context: WebAuthn is
 * refused on pages with certificate errors, so ignoreHTTPSErrors is not enough.
 * Linux (CI): the fixture certificate is trusted in an isolated NSS store under
 * E2E_BROWSER_HOME (scripts/setup-browser-trust.mjs). Elsewhere (local macOS)
 * the run either uses http://localhost (a secure context) or pins exactly the
 * fixture certificate's SPKI.
 */
function fixtureSpki(): string | null {
  if (linux || !https || !existsSync(certPath)) return null;
  const spki = new X509Certificate(readFileSync(certPath)).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("base64");
}
const spki = fixtureSpki();

const chromiumUse: NonNullable<PlaywrightTestConfig["use"]> = {
  ...devices["Desktop Chrome"],
  // Use bundled Chromium's new headless mode instead of the separate headless shell.
  channel: "chromium",
  launchOptions: {
    // Linux: trust only the fixture peer in the isolated browser NSS store.
    // Node keeps its own HOME, executable cache and artifact locations.
    env: linux
      ? {
          ...process.env,
          HOME: browserHome,
          XDG_DATA_HOME: resolve(browserHome, ".local/share"),
          XDG_CONFIG_HOME: resolve(browserHome, ".config"),
          XDG_CACHE_HOME: resolve(browserHome, ".cache"),
        }
      : { ...process.env },
    args: [
      // The bridge cannot resolve Chromium's mDNS host candidates. This lets
      // Test A exercise the direct WebRTC path without disabling TLS checks.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      ...(spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : []),
    ],
  },
};

/**
 * Services (UI, TLS terminator, the two shared bridges) are started OUTSIDE
 * Playwright by scripts/start-services.sh, with scratch HOMEs and recorded PIDs
 * for precise teardown. The server holds exactly ONE account: the `setup`
 * project creates it through /login (virtual-authenticator passkey), exports
 * the passkey to e2e/.run-account.json and pairs both shared bridges through
 * /pair. Every spec then signs in its own browser contexts with that passkey.
 * Specs share the account and the bridges, so they run serially.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["json", { outputFile: "test-results/results.json" }]],
  use: {
    // Bound blocked UI actions independently of long scenario timeouts.
    actionTimeout: 15_000,
    baseURL: UI_BASE_URL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /account\.setup\.ts$/,
      // CI: after every project that depends on setup has finished, whatever their outcome. Not locally, where a
      // partial run would add another permanent passkey each time (run it with `--project=second-passkey`).
      teardown: process.env.CI ? "second-passkey" : undefined,
      use: chromiumUse,
    },
    {
      name: "chromium",
      dependencies: ["setup"],
      testIgnore: /second-passkey\.spec\.ts$/,
      use: chromiumUse,
    },
    {
      // Adds a PERMANENT second passkey to the shared account (authorities are add-only), after which every
      // browser must "Choose passkey" before signing: it runs last, as the setup project's teardown.
      name: "second-passkey",
      testMatch: /second-passkey\.spec\.ts$/,
      use: chromiumUse,
    },
  ],
});
