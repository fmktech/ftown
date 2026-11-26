import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedAccountId, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch, readBridgePointer } from "../helpers/bridge-api";

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`bridge update menu displays real status at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await login(page);
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/version" && response.ok()),
      page.reload(),
    ]);
    await waitForBridgeOnline(page);
    const bridgeId = readBridgePointer().bridgeId;
    await page.getByRole("button", { name: "Computers", exact: true }).click();
    const row = page.locator(`[data-bridge-row="${bridgeId}"]`);
    await expect(row).toBeVisible();
    const version = row.getByText(/^Bridge version \d+\.\d+\.\d+$/);
    await expect(version).toBeVisible();
    const runningVersion = await version.textContent();
    const report = await bridgeApiFetch("GET", "/api/host-resources");
    expect(report.status).toBe(200);
    const { resources } = report.body as { resources: { totalRamBytes: number; availableRamBytes?: number; memoryPressure?: string } };
    const ramLabel = resources.availableRamBytes === undefined ? "RAM free" : "RAM available";
    const ram = row.locator("dl > div").filter({ has: page.getByText(ramLabel, { exact: true }) });
    const totalGiB = await page.evaluate(bytes => (bytes / 2 ** 30).toLocaleString(undefined, { maximumFractionDigits: 1 }), resources.totalRamBytes);
    await expect(ram.locator("dd")).toContainText(` / ${totalGiB} GiB`);
    await expect(ram.getByRole("meter", { name: "RAM usage" })).toBeVisible();
    if (resources.memoryPressure) await expect(ram.getByText(/^(normal|warning|critical) pressure$/)).toBeVisible();
    else await expect(ram.getByText(/pressure$/)).toHaveCount(0);
    const actions = row.getByRole("button", { name: "Updates…" });
    const bounds = await actions.boundingBox();
    expect(bounds && bounds.width >= 44 && bounds.height >= 44).toBeTruthy();
    await actions.click();
    const dialog = page.getByRole("dialog", { name: "Bridge updates" });
    await expect(dialog).toBeVisible();
    const installedRow = dialog.locator("dl > div").filter({ has: page.getByText("Installed", { exact: true }) });
    const latestRow = dialog.locator("dl > div").filter({ has: page.getByText("Latest", { exact: true }) });
    await expect(installedRow.locator("dd")).not.toHaveText("Unknown", { timeout: 30_000 });
    const installedText = await installedRow.locator("dd").textContent();
    const latestText = await latestRow.locator("dd").textContent();
    const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
    const installed = installedText ?? "";
    const latest = latestText ?? "";
    expect(installed).toMatch(stable);
    expect(runningVersion).toBe(`Bridge version ${installed}`);
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
    await expect(page.getByRole("dialog", { name: "App update available", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`bridge-updates-${viewport.width}.png`) });
    await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(actions).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("application build change requires an explicit reload", async ({ page }) => {
  await page.route("**/api/version", route => route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ buildId: "e2e-distinct-build" }) }));
  await login(page);
  const notice = page.getByRole("dialog", { name: "App update available", exact: true });
  await expect(notice).toBeVisible();
  await expect(notice.getByText(/unsent dialog input may be lost/)).toBeVisible();
  await expect(notice.getByRole("button", { name: "Reload", exact: true })).toBeEnabled();
  const later = notice.getByRole("button", { name: "Later", exact: true });
  await expect(later).toBeFocused();
  await later.click(); await expect(notice).toBeHidden();
});
