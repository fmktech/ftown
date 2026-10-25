import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { accountBrowserState, approveAccountComputer, createAccountShell, startAccountTestBridge, type AccountTestBridge } from "../helpers/account-pairing";
import { bridgeSecurityCommand } from "../helpers/secure-browser";
import { readBridgePointer } from "../helpers/bridge-api";
import type { ApprovedEndpoint } from "../../bridge/src/security/protocol";
import { login, makeUser, openSession, registerUser, runMarkerInTerminal } from "../helpers/app";

const origin = process.env.FTOWN_PUBLIC_URL ?? "https://localhost:8444";
async function devices(page: Page) {
  await page.getByRole("button", { name: "Open security", exact: true }).click();
  await page.getByRole("tab", { name: "Devices", exact: true }).click();
  await expect(page.getByRole("list", { name: "Account devices", exact: true })).toBeVisible();
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`account trust: one computer confirmation, one device approval, future computers and durable two-tab pins (${viewport.width})`, async ({ browser }, info) => {
    test.setTimeout(300000);
    const user = makeUser(`account-${viewport.width}`); await registerUser(user.email, user.password);
    const contexts: BrowserContext[] = []; const bridges: AccountTestBridge[] = []; let primaryFailed = false;
    try {
      const desktop = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: false, viewport }); contexts.push(desktop);
      const page = await desktop.newPage(); const frames: string[] = [];
      page.on("websocket", socket => socket.on("framereceived", ({ payload }) => frames.push(String(payload))));
      await login(page, user.email, user.password, { pairBridge: false });
      const first = await startAccountTestBridge(origin); bridges.push(first);
      const firstId = await approveAccountComputer(page, first);
      const initial = (await accountBrowserState(page))[0];
      expect(initial.hpkeExtractable).toBe(false); expect(initial.signingExtractable).toBe(false);
      expect(initial.trust?.checkpoint.devices).toHaveLength(1);
      await devices(page); await expect(page.getByRole("button", { name: /^Revoke account device / })).toBeDisabled();
      await expect(page.getByText(/last account administrator/)).toBeVisible(); await noOverflow(page);
      await page.screenshot({ path: info.outputPath("account-first-device.png"), fullPage: true });
      await page.getByRole("button", { name: "Close security" }).click();
      const second = await startAccountTestBridge(origin); bridges.push(second);
      const secondId = await approveAccountComputer(page, second);

      const phoneContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: false, viewport: { width: 390, height: 844 } }); contexts.push(phoneContext);
      const directPorts = new Set([readBridgePointer(first.home).port, readBridgePointer(second.home).port].map(String));
      await phoneContext.routeWebSocket(url => url.hostname === "127.0.0.1" && url.pathname === "/ws" && directPorts.has(url.port), socket => socket.close());
      await phoneContext.addInitScript(() => { Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: class { constructor() { throw new Error("Exercise encrypted cloud terminal delivery"); } } }); });
      const phone = await phoneContext.newPage();
      phone.on("websocket", socket => {
        socket.on("framesent", ({ payload }) => frames.push(String(payload)));
        socket.on("framereceived", ({ payload }) => frames.push(String(payload)));
      });
      await login(phone, user.email, user.password, { pairBridge: false });
      await expect(phone.getByRole("heading", { name: "Approve this device", exact: true })).toBeVisible();
      await phone.getByRole("textbox", { name: "Device name", exact: true }).fill("Account test phone");
      await phone.getByRole("button", { name: "Create approval link", exact: true }).click();
      const privateLink = await phone.getByRole("textbox", { name: "Private approval link", exact: true }).inputValue();
      const comparison = await phone.getByLabel("Comparison code", { exact: true }).textContent();
      await noOverflow(phone); await phone.screenshot({ path: info.outputPath("account-phone-pending.png"), fullPage: true });
      // A different signed-in owner must never acquire authority from the link.
      const foreign = makeUser("account-foreign"); await registerUser(foreign.email, foreign.password);
      const foreignContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: false }); contexts.push(foreignContext);
      const foreignPage = await foreignContext.newPage(); await login(foreignPage, foreign.email, foreign.password, { pairBridge: false });
      await foreignPage.goto(privateLink); await expect(foreignPage).toHaveURL(`${origin}/devices/approve`);
      await expect(foreignPage.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
      await expect(foreignPage.getByRole("button", { name: "Codes match — approve device", exact: true })).toBeDisabled();
      // Tampering with the candidate proof cannot be repaired by account login.
      const tampered = new URL(privateLink); const encoded = new URLSearchParams(tampered.hash.slice(1)).get("account")!;
      const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { request: { signingProof: string } };
      value.request.signingProof = `${value.request.signingProof[0] === "A" ? "B" : "A"}${value.request.signingProof.slice(1)}`;
      tampered.hash = `account=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
      const invalid = await desktop.newPage(); await invalid.goto(tampered.href);
      await expect(invalid.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible(); await invalid.close();
      await page.goto(privateLink); await expect(page).toHaveURL(`${origin}/devices/approve`);
      await expect(page.getByLabel("Comparison code", { exact: true })).toHaveText(comparison!);
      await noOverflow(page); await page.screenshot({ path: info.outputPath("account-device-confirmation.png"), fullPage: true });
      await page.getByRole("button", { name: "Codes match — approve device", exact: true }).click();
      await expect(page.getByText(/Device approved\. It can now finish connecting/)).toBeVisible();
      await expect(phone.locator(`[data-bridge-row="${firstId}"]`)).toBeVisible({ timeout: 60000 });
      await expect(phone.locator(`[data-bridge-row="${secondId}"]`)).toBeVisible({ timeout: 60000 });
      const phoneIdentity = (await accountBrowserState(phone))[0]; expect(phoneIdentity.endpointId).not.toBe(initial.endpointId);
      expect(phoneIdentity.hpkeExtractable).toBe(false); expect(phoneIdentity.signingExtractable).toBe(false);
      for (const [index, bridgeId] of [firstId, secondId].entries()) await createAccountShell(phone, bridgeId, `ACCOUNT_PRIVATE_${viewport.width}_${index}_${Date.now()}`);
      await phone.reload(); await expect(phone.locator(`[data-bridge-row="${firstId}"]`)).toBeVisible({ timeout: 45000 });
      expect((await accountBrowserState(phone))[0].endpointId).toBe(phoneIdentity.endpointId);

      await page.goto("/dashboard");
      const accountRead = await page.request.get(`${origin}/api/security/account`); expect(accountRead.ok()).toBe(true);
      const oldHistory: unknown = await accountRead.json();
      const staleTab = await desktop.newPage(); let release: () => void = () => {};
      const delayed = new Promise<void>(resolve => { release = resolve; });
      let delayedOnce = false;
      await staleTab.route("**/api/security/account", async route => {
        if (route.request().method() === "GET" && !delayedOnce) {
          delayedOnce = true; await delayed;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(oldHistory) });
        } else await route.continue();
      });
      await staleTab.goto("/dashboard"); await expect.poll(() => delayedOnce, { timeout: 30000 }).toBe(true);
      try {
        const third = await startAccountTestBridge(origin); bridges.push(third);
        const thirdId = await approveAccountComputer(page, third); directPorts.add(String(readBridgePointer(third.home).port));
        const advanced = (await accountBrowserState(page))[0];
        expect(advanced.trust!.checkpoint.revision).toBeGreaterThan(phoneIdentity.trust!.checkpoint.revision);
        release();
        await expect(staleTab.getByRole("alert").filter({ hasText: /\S/ })).toContainText(/older than|rollback|trust|conflict/i, { timeout: 30000 });
        const durable = (await accountBrowserState(page))[0];
        expect(durable.trust!.checkpoint.head).toBe(advanced.trust!.checkpoint.head);
        expect(durable.trust!.lastServerReadAt).toBeGreaterThanOrEqual(advanced.trust!.lastServerReadAt);
        expect(durable.trust!.lastObservedAt).toBeGreaterThanOrEqual(advanced.trust!.lastObservedAt);
        expect(durable.endpointId).toBe(initial.endpointId);
        await expect(phone.locator(`[data-bridge-row="${thirdId}"]`)).toBeVisible({ timeout: 60000 });
        const privateName = `ACCOUNT_FUTURE_PRIVATE_${Date.now()}`; await createAccountShell(phone, thirdId, privateName);
        await openSession(phone, privateName);
        const terminalTab = phone.getByRole("button", { name: "Terminal", exact: true });
        if (await terminalTab.isVisible()) await terminalTab.click();
        const marker = `ACCOUNT_TERMINAL_PRIVATE_${Date.now()}`; await runMarkerInTerminal(phone, marker);
        await expect(phone.locator("text=/^(P2P|Local|Cloud)$/").first()).toHaveText("Cloud", { timeout: 15000 });
        expect(frames.some(frame => frame.includes("ftown_encrypted"))).toBe(true);
        expect(frames.some(frame => frame.includes(privateName) || frame.includes(marker))).toBe(false);
      } finally { release(); await staleTab.close(); }

      await devices(page); await noOverflow(page);
      await expect(page.getByRole("list", { name: "Account devices", exact: true })).toContainText("Account test phone");
      await page.screenshot({ path: info.outputPath("account-devices.png"), fullPage: true });
      await page.getByRole("button", { name: "Revoke account device Account test phone", exact: true }).click();
      await page.getByRole("button", { name: "Confirm account revoke", exact: true }).click();
      await expect(page.getByRole("list", { name: "Account devices", exact: true })).not.toContainText("Account test phone");
      await expect(page.getByRole("button", { name: /^Revoke account device / })).toBeDisabled();
      await Promise.all(bridges.map(bridge => expect.poll(async () => {
        const result = await bridgeSecurityCommand("security_devices", {}, bridge.home) as unknown as { devices: ApprovedEndpoint[] };
        return result.devices.some(device => device.endpoint.id === phoneIdentity.endpointId);
      }, { timeout: 60000, message: "Revoked account device must be removed from every task-owned bridge" }).toBe(false)));
      await phone.reload(); await expect(phone.getByRole("alert").filter({ hasText: /\S/ })).toContainText(/revoked/i, { timeout: 30000 });
      await expect(phone.getByTitle("Create a new session", { exact: true })).toHaveCount(0);
    } catch (error) { primaryFailed = true; throw error; }
    finally {
      const failures: string[] = [];
      for (const context of contexts.reverse()) try { await context.close(); } catch { failures.push("browser-context"); }
      for (const bridge of bridges.reverse()) try { await bridge.stop(); } catch { failures.push("account-bridge"); }
      if (!primaryFailed && failures.length) throw new Error(`Isolated account fixture cleanup failed: ${failures.join(", ")}`);
    }
  });
}
