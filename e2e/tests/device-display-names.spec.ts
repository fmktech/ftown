import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { accountBrowserState, approveAccountComputer, createAccountShell, startAccountTestBridge, usePrivateApprovalLink, type AccountTestBridge } from "../helpers/account-pairing";
import { bridgeSecurityCommand } from "../helpers/secure-browser";
import { login, makeUser, registerUser } from "../helpers/app";
import type { ApprovedEndpoint } from "../../bridge/src/security/protocol";

const origin = process.env.FTOWN_PUBLIC_URL ?? "https://localhost:8444";
async function access(page: Page) {
  const menu = page.getByRole("button", { name: "Open navigation menu", exact: true });
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await expect(menu).toBeVisible();
    await menu.click();
  }
  await page.getByRole("button", { name: "Open security", exact: true }).click();
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await expect(page.getByRole("list", { name: "Account devices", exact: true })).toBeVisible();
}
async function rename(card: Locator, button: string, name: string) {
  await card.getByRole("button", { name: button, exact: true }).click();
  await card.getByLabel("Display name", { exact: true }).fill(name);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText("Display name saved.")).toBeVisible();
}

test("account names synchronize between approved browsers without changing trust", async ({ browser }, info) => {
  test.setTimeout(240000);
  const user = makeUser("display-names"); await registerUser(user.email, user.password);
  const contexts: BrowserContext[] = []; const bridges: AccountTestBridge[] = []; let primaryFailed = false;
  try {
    const desktop = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 } }); contexts.push(desktop);
    const page = await desktop.newPage(); await login(page, user.email, user.password, { pairBridge: false });
    const bridge = await startAccountTestBridge(origin); bridges.push(bridge);
    const bridgeId = await approveAccountComputer(page, bridge);
    const phoneContext = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 } }); contexts.push(phoneContext);
    const phone = await phoneContext.newPage(); await login(phone, user.email, user.password, { pairBridge: false });
    await usePrivateApprovalLink(phone);
    await phone.getByRole("textbox", { name: "Device name", exact: true }).fill("Account test phone");
    await phone.getByRole("button", { name: "Create approval link", exact: true }).click();
    const privateLink = await phone.getByRole("textbox", { name: "Private approval link", exact: true }).inputValue();
    await page.goto(privateLink);
    await page.getByRole("button", { name: "Codes match — approve device", exact: true }).click();
    await expect(page.getByText(/Device approved\. It can now finish connecting/)).toBeVisible();
    await expect(phone.locator(`[data-bridge-row="${bridgeId}"]`)).toBeVisible({ timeout: 60000 });
    const phoneId = (await accountBrowserState(phone))[0].endpointId;
    // Match the account-trust fixture: exercise an encrypted command, then
    // reconnect so the approved identity and bridge pins are restored.
    const shellName = `DISPLAY_NAMES_${Date.now()}`;
    await createAccountShell(phone, bridgeId, shellName);
    await phone.getByRole("button", { name: "Open navigation menu", exact: true }).click();
    await Promise.all([
      phone.waitForEvent("load"),
      phone.getByRole("navigation", { name: "Dashboard actions" }).getByRole("button", { name: "Reconnect and refresh", exact: true }).click(),
    ]);
    await expect(phone.locator(`[data-bridge-row="${bridgeId}"]`)).toBeVisible();
    expect((await accountBrowserState(phone))[0].endpointId).toBe(phoneId);
    await expect(phone.getByRole("button", { name: new RegExp(shellName) })).toBeVisible();
    await access(phone);
    await expect(phone.locator(`[data-computer-access="${bridgeId}"]`)).toContainText("Shared with your approved browsers");
    await phone.getByRole("button", { name: "Close security" }).click();
    await page.goto("/dashboard"); await expect(page.locator(`[data-bridge-row="${bridgeId}"]`)).toBeVisible({ timeout: 60000 });
    const trustBefore = await (await page.request.get(`${origin}/api/security/account`)).json();
    await expect.poll(async () => {
      try {
        const result = await bridgeSecurityCommand("security_devices", {}, bridge.home) as unknown as { devices: ApprovedEndpoint[] };
        return result.devices.some(device => device.endpoint.id === phoneId && device.label === "Account test phone" && device.source === "account");
      } catch (error) { return `transient: ${error instanceof Error ? error.message : String(error)}`; }
    }).toBe(true);
    const grantsBefore = await bridgeSecurityCommand("security_devices", {}, bridge.home);
    await access(page);
    await expect(page.locator(`[data-computer-access="${bridgeId}"]`)).toContainText("Shared with your approved browsers", { timeout: 60000 });
    const browserCard = page.locator(`[data-access-card="browser:${phoneId}"]`);
    const browserSelection = page.locator(`[data-access-node="${phoneId}"]`);
    await browserSelection.click();
    await rename(browserCard, "Rename Account test phone", "Browser");
    await expect(browserCard.getByText("Browser", { exact: true })).toBeVisible();
    await expect(browserSelection).toHaveAccessibleName(/^Browser Browser: Approved for your account/);
    await page.locator(`[data-computer-access="${bridgeId}"]`).click();
    const computerLabel = await page.locator(`[data-computer-access="${bridgeId}"] span.font-semibold`).first().textContent();
    expect(computerLabel).toBeTruthy(); await rename(page.locator(`[data-access-card="bridge:${bridgeId}"]`), `Rename ${computerLabel}`, "Office 💻");
    const helper = page.getByText("Display names appear across your signed-in browsers.", { exact: true });
    await page.setViewportSize({ width: 900, height: 760 });
    await expect(helper).toBeHidden();
    await page.getByRole("button", { name: "Rename Office 💻", exact: true }).click();
    await expect(helper).toBeVisible(); await helper.scrollIntoViewIfNeeded();
    await expect.poll(() => helper.evaluate(element => {
      const content = element.closest<HTMLElement>("[data-security-content]")!;
      const box = element.getBoundingClientRect(), bounds = content.getBoundingClientRect();
      return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom && content.scrollWidth <= content.clientWidth;
    })).toBe(true);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 767, height: 900 });
    for (const name of ["Rename Office 💻", "Reset name"]) {
      await expect.poll(() => page.getByRole("button", { name, exact: true }).evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "Rename Office 💻", exact: true }).click();
    for (const control of [page.getByLabel("Display name", { exact: true }), page.getByRole("button", { name: "Save", exact: true }), page.getByRole("button", { name: "Cancel", exact: true })]) {
      await expect.poll(() => control.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const dialog = page.getByRole("dialog", { name: "Security", exact: true });
      await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (width < 640) await expect.poll(() => dialog.evaluate(element => [...element.querySelectorAll<HTMLElement>("button,summary,input")].filter(item => item.checkVisibility()).every(item => item.getBoundingClientRect().height >= 44))).toBe(true);
      await page.screenshot({ path: info.outputPath(`display-names-${width}.png`), fullPage: true });
    }
    await phone.reload(); await access(phone);
    const phoneCard = phone.locator(`[data-access-card="browser:${phoneId}"]`);
    const phoneSelection = phone.locator(`[data-access-node="${phoneId}"]`);
    await expect(phoneCard.getByText("Browser", { exact: true })).toBeVisible();
    await expect(phoneSelection).toHaveAccessibleName(/^Browser Browser \(this browser\): Approved for your account/);
    await expect(phone.locator(`[data-computer-access="${bridgeId}"]`)).toContainText("Office 💻");
    const foreign = makeUser("display-names-foreign"); await registerUser(foreign.email, foreign.password);
    const foreignContext = await browser.newContext({ baseURL: origin }); contexts.push(foreignContext);
    const foreignPage = await foreignContext.newPage(); await login(foreignPage, foreign.email, foreign.password, { pairBridge: false });
    const foreignNames = await (await foreignPage.request.get(`${origin}/api/security/device-names`)).json();
    expect(foreignNames.names).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: phoneId })]));
    for (const target of [{ kind: "browser", id: phoneId }, { kind: "bridge", id: bridgeId }]) {
      const response = await foreignPage.request.put(`${origin}/api/security/device-names`, { headers: { Origin: origin }, data: { ...target, name: "Intruder" } });
      expect(response.status()).toBe(404);
    }
    await phone.locator(`[data-computer-access="${bridgeId}"]`).click(); await phone.getByRole("button", { name: "Reset name" }).click();
    await expect(phone.locator(`[data-computer-access="${bridgeId}"]`)).not.toContainText("Office 💻");
    await phoneSelection.click();
    await phoneCard.getByRole("button", { name: "Rename Browser", exact: true }).click();
    await phoneCard.getByRole("button", { name: "Reset name", exact: true }).click();
    await expect(phoneCard.getByText("Account test phone", { exact: true })).toBeVisible();
    await expect(phoneSelection).toHaveAccessibleName(/^Browser Account test phone \(this browser\): Approved for your account/);
    expect(await (await page.request.get(`${origin}/api/security/account`)).json()).toEqual(trustBefore);
    expect(await bridgeSecurityCommand("security_devices", {}, bridge.home)).toEqual(grantsBefore);
  } catch (error) { primaryFailed = true; throw error; }
  finally {
    const failures: string[] = [];
    for (const context of contexts.reverse()) try { await context.close(); } catch { failures.push("browser-context"); }
    for (const bridge of bridges.reverse()) try { await bridge.stop(); } catch { failures.push("account-bridge"); }
    if (failures.length && !primaryFailed) throw new Error(`Cleanup failed: ${failures.join(", ")}`);
  }
});
