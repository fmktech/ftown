import { expect, type BrowserContext } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login } from "../helpers/app";

/**
 * Regression guard (found by this suite). A browser enrolled right after another
 * ledger change (here: a second browser signing in) can reach the bridges before
 * they applied its add_device and be refused (approval_required). The bridge must
 * then refresh its ledger and the dashboard retry, so the new browser becomes
 * ready on its own, without a reload.
 */
test("a browser enrolled right after another ledger change becomes ready without a reload", async ({ browser }) => {
  test.setTimeout(120_000);
  const contexts: BrowserContext[] = [];
  try {
    for (const label of ["E2E race browser A", "E2E race browser B"]) {
      const context = await browser.newContext(); contexts.push(context);
      const page = await context.newPage();
      await login(page, { browserLabel: label });
    }
    const late = contexts[1].pages()[0];
    await expect(late.getByRole("button", { name: "Create a new session", exact: true }),
      "the second browser must reach a ready computer without reloading").toBeEnabled({ timeout: 30_000 });
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
  }
});
