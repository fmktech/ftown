import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { approveAccountComputer, startAccountTestBridge, type AccountTestBridge } from "../helpers/account-pairing";
import { login, makeUser, registerUser } from "../helpers/app";
import { bridgePresenceCount, waitForChannels } from "../helpers/centrifugo";
import { UI_BASE_URL } from "../helpers/config";

/**
 * Tokenless onboarding uses the explicit local private link, never operational
 * stdout or a public user code as encryption authority. The unchanged account
 * helper owns setup, isolated HOME/dataDir, fragment-safe approval, and precise
 * awaited child cleanup. This test retains bridge registration/revocation
 * coverage independently of the shared harness account and legacy bridges.
 */
test.describe("device pairing", () => {
  test("bridge with no token pairs via /pair approval and comes online", async ({ page }) => {
    const user = makeUser("e2e-pairing");
    let bridge: AccountTestBridge | undefined;
    let primaryFailed = false;
    try {
      await registerUser(user.email, user.password);
      await login(page, user.email, user.password, { pairBridge: false });

      // Leaving an invalid code must return to the dashboard without denying
      // a pending request or changing account trust.
      await page.goto("/pair");
      await page.getByLabel("Computer code").fill("AB");
      await page.getByRole("button", { name: "Look up code" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Enter the full eight-character computer code." })).toBeVisible();
      await page.getByRole("link", { name: "Back to dashboard" }).click();
      await expect(page).toHaveURL(/\/dashboard$/);

      bridge = await startAccountTestBridge(UI_BASE_URL);
      const bridgeId = await approveAccountComputer(page, bridge);

      // Presence proves the bridge consumed its approval, stored the issued
      // credentials and connected to the owning user's real broker channel.
      const presence = await waitForChannels(
        () => bridgePresenceCount(user.email),
        count => count >= 1,
        { timeoutMs: 30000, intervalMs: 2000 },
      );
      expect(presence, "paired bridge must reach its owner's broker presence").toBeGreaterThanOrEqual(1);

      await page.goto("/devices");
      await expect(page.getByRole("listitem")).toHaveCount(1);
      // The immutable bridge ID prefix stays stable as Active changes to
      // Revoked, so revocation cannot invalidate this locator mid-assertion.
      const deviceRow = page.getByRole("listitem").filter({ hasText: bridgeId.slice(0, 12) });
      await expect(deviceRow).toBeVisible();
      await expect(deviceRow.getByText("Active", { exact: true })).toBeVisible();
      page.once("dialog", dialog => void dialog.accept());
      await deviceRow.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(deviceRow.getByText("Revoked", { exact: true })).toBeVisible();
      await page.reload();
      await expect(deviceRow.getByText("Revoked", { exact: true })).toBeVisible();
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      if (bridge) {
        try { await bridge.stop(); }
        catch {
          // Always attempt owned cleanup without masking a primary assertion.
          if (!primaryFailed) throw new Error("Test-owned pairing bridge cleanup failed");
        }
      }
    }
  });
});
