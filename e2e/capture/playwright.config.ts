import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

// Reuse the canonical browser HOME, NSS trust and Chromium launch settings.
// The capture is opt-in and does not inherit either regression project matcher.
const chromium = base.projects?.find(project => project.name === "chromium");
if (!chromium?.use) throw new Error("Canonical Chromium settings are unavailable");

export default defineConfig({
  testDir: ".",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 480_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: { ...base.use, ...chromium.use, trace: "off", video: "off", screenshot: "off" },
  projects: [
    // The shared account A (passkey) and the paired shared bridges come from the suite's setup project.
    { name: "setup", testDir: "../tests", testMatch: /account\.setup\.ts$/, use: chromium.use },
    { name: "capture", testMatch: "product.spec.ts", dependencies: ["setup"] },
  ],
});
