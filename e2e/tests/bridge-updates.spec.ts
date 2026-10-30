import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { readBridgePointer } from "../helpers/bridge-api";

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`bridge update menu displays real status at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/version" && response.ok()),
      login(page, sharedEmail()),
    ]);
    await waitForBridgeOnline(page);
    const bridgeId = readBridgePointer().bridgeId;
    const row = page.locator(`[data-bridge-row="${bridgeId}"]`);
    await expect(row).toBeVisible();
    const actions = row.getByRole("button", { name: /^Actions for / });
    const bounds = await actions.boundingBox();
    expect(bounds && bounds.width >= 44 && bounds.height >= 44).toBeTruthy();
    await actions.click(); await page.getByRole("menuitem", { name: "Updates…" }).click();
    const dialog = page.getByRole("dialog", { name: "Bridge updates" });
    await expect(dialog).toBeVisible();
    const installedRow = dialog.locator("dl > div").filter({ has: dialog.getByText("Installed", { exact: true }) });
    const latestRow = dialog.locator("dl > div").filter({ has: dialog.getByText("Latest", { exact: true }) });
    await expect(installedRow.locator("dd")).not.toHaveText("Unknown", { timeout: 30_000 });
    const installedText = await installedRow.locator("dd").textContent();
    const latestText = await latestRow.locator("dd").textContent();
    const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
    const installed = installedText ?? "";
    const latest = latestText ?? "";
    expect(installed).toMatch(stable);
    expect(latest === "Unknown" || stable.test(latest)).toBe(true);
    const compare = (a: string, b: string) => {
      const left = a.split(".").map(BigInt), right = b.split(".").map(BigInt);
      for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
      return 0;
    };
    const manualVersion = latest !== "Unknown" && compare(latest, installed) > 0 ? latest : installed;
    await dialog.getByText("Setup & runtime details").click();
    await expect(dialog.getByText(/Manual setup on this computer/)).toBeVisible();
    await expect(dialog.locator("code").first()).toHaveText(`npx ftown@${manualVersion} setup`);
    await expect(dialog.getByRole("button", { name: "Update and restart" })).toHaveCount(0);
    await expect(dialog.getByText(/Automatic updates aren’t available/)).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "App update available" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`bridge-updates-${viewport.width}.png`) });
    await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(actions).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("application build change requires an explicit reload", async ({ page }) => {
  await page.route("**/api/version", route => route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ buildId: "e2e-distinct-build" }) }));
  await login(page, sharedEmail());
  const notice = page.getByRole("status").filter({ hasText: "App update available" });
  await expect(notice).toBeVisible();
  await expect(notice.getByText(/unsent dialog input may be lost/)).toBeVisible();
  await notice.getByRole("button", { name: "Later" }).click(); await expect(notice).toBeHidden();
});
