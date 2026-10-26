import { expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { accountBrowserState, approveAccountComputer, createAccountShell, startAccountTestBridge, usePrivateApprovalLink, type AccountTestBridge } from "../helpers/account-pairing";
import { bridgeSecurityCommand } from "../helpers/secure-browser";
import { readBridgePointer } from "../helpers/bridge-api";
import type { ApprovedEndpoint } from "../../bridge/src/security/protocol";
import { login, makeUser, openSession, registerUser, runMarkerInTerminal } from "../helpers/app";

const origin = process.env.FTOWN_PUBLIC_URL ?? "https://localhost:8444";
async function devices(page: Page) {
  await page.getByRole("button", { name: "Open security", exact: true }).click();
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await page.getByText(/^Browsers with access/).click();
  await expect(page.getByRole("list", { name: "Account devices", exact: true })).toBeVisible();
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }


async function waitForSecurityLayout(page: Page, width: number) {
  await expect.poll(() => page.getByRole("dialog", { name: "Security", exact: true }).evaluate((element, mobile) => {
    const transitioning = element.getAnimations({ subtree: true }).some(animation => animation instanceof CSSTransition && animation.playState === "running");
    const controls = [...element.querySelectorAll<HTMLElement>("button,select,summary")].filter(control => control.checkVisibility());
    return !transitioning && controls.length > 0 && controls.every(control => mobile ? control.getBoundingClientRect().height >= 44 : control.getBoundingClientRect().height <= 36);
  }, width < 640), { timeout: 2000, intervals: [25, 50, 100], message: "Security responsive transitions and control geometry must settle" }).toBe(true);
}

async function compactAccessEvidence(page: Page, info: TestInfo, bridgeIds: string[]) {
  await page.getByRole("button", { name: "Open security", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Security", exact: true });
  await expect(dialog.getByRole("tab", { name: "Access", exact: true })).toHaveAttribute("aria-selected", "true");
  for (const bridgeId of bridgeIds) await expect(dialog.locator(`[data-computer-access="${bridgeId}"]`)).toContainText("Shared with your approved browsers", { timeout: 60000 });
  const measurements = [];
  for (const size of [{ width: 1280, height: 900 }, { width: 900, height: 760 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await waitForSecurityLayout(page, size.width);
    await dialog.locator("[data-security-content]").evaluate(element => { element.scrollTop = 0; });
    const measured = await dialog.evaluate((element, ids) => {
      const content = element.querySelector<HTMLElement>("[data-security-content]")!;
      const bounds = content.getBoundingClientRect();
      return { headerHeight: element.querySelector("header")!.getBoundingClientRect().height,
        contentTop: bounds.top, contentBottom: bounds.bottom, scrollTop: content.scrollTop,
        overflow: element.scrollWidth > element.clientWidth || content.scrollWidth > content.clientWidth,
        rows: ids.map(id => { const row = element.querySelector(`[data-computer-access="${id}"]`)!.getBoundingClientRect(); return { top: row.top, bottom: row.bottom, height: row.height }; }),
        targets: [...element.querySelectorAll<HTMLElement>("button,select,summary")].filter(control => control.checkVisibility()).map(control => control.getBoundingClientRect().height) };
    }, bridgeIds);
    expect(measured.headerHeight).toBeLessThanOrEqual(64);
    expect(measured.overflow).toBe(false); expect(measured.scrollTop).toBe(0);
    expect(measured.rows).toHaveLength(3);
    for (const row of measured.rows) {
      expect(row.height).toBeLessThanOrEqual(size.width < 640 ? 100 : 76);
      if (size.width >= 640) { expect(row.top).toBeGreaterThanOrEqual(measured.contentTop); expect(row.bottom).toBeLessThanOrEqual(measured.contentBottom); }
    }
    if (size.width < 640) for (const height of measured.targets) expect(height).toBeGreaterThanOrEqual(44);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath(`security-compact-access-${size.width}.png`), fullPage: true });
    await dialog.getByText(/^Browsers with access/).click();
    const browserList = dialog.getByRole("list", { name: "Account devices", exact: true });
    await expect(browserList).toBeVisible();
    const browserHeights = await browserList.getByRole("listitem").evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    for (const height of browserHeights) expect(height).toBeLessThanOrEqual(size.width < 640 ? 128 : 76);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath(`security-compact-browsers-${size.width}.png`), fullPage: true });
    measurements.push({ ...size, ...measured, browserHeights });
    await dialog.getByText(/^Browsers with access/).click();
  }
  await info.attach("security-density.json", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  await dialog.getByRole("button", { name: "Close security" }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
}

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
      await page.getByRole("button", { name: "Open security", exact: true }).click();
      await expect(page.getByRole("tab", { name: "Access", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("heading", { name: "Your computers", exact: true })).toBeVisible();
      await expect(page.locator(`[data-computer-access="${firstId}"]`)).toContainText("Shared with your approved browsers", { timeout: 60000 });
      await noOverflow(page); await page.screenshot({ path: info.outputPath(`security-access-${viewport.width}.png`), fullPage: true });
      await page.getByText(/^Browsers with access/).click();
      await expect(page.getByRole("button", { name: /^Remove access for / })).toBeDisabled();
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
      await usePrivateApprovalLink(phone);
      await expect(phone.getByRole("heading", { name: "Approve this device", exact: true })).toBeVisible();
      await phone.getByRole("textbox", { name: "Device name", exact: true }).fill("Account test phone");
      await phone.getByRole("button", { name: "Create approval link", exact: true }).click();
      const privateLink = await phone.getByRole("textbox", { name: "Private approval link", exact: true }).inputValue();
      const comparison = await phone.getByLabel("Comparison code", { exact: true }).textContent();
      const encoded = new URLSearchParams(new URL(privateLink).hash.slice(1)).get("account")!;
      const pendingRequest = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { request: { requestId: string; signingProof: string } };
      const enrollmentPath = `/api/security/account/enrollments/${pendingRequest.request.requestId}`;
      const pendingIdentity = (await accountBrowserState(phone))[0];
      expect(pendingIdentity.trust).toBeNull();
      // Reload must restore the exact persisted request and restart its poll.
      // No Generate/Refresh action is allowed between reload and approval.
      const resumedPoll = phone.waitForRequest(request => request.method() === "GET" && new URL(request.url()).pathname === enrollmentPath, { timeout: 15000 })
        .then(() => true, () => false);
      await phone.reload();
      await expect(phone.getByRole("heading", { name: "Approve this device", exact: true })).toBeVisible();
      const restoredLink = phone.getByRole("textbox", { name: "Private approval link", exact: true });
      await expect(restoredLink).toBeVisible();
      // Compare privately so assertion diagnostics cannot print the fragment.
      expect(await restoredLink.inputValue() === privateLink).toBe(true);
      await expect(phone.getByLabel("Comparison code", { exact: true })).toHaveText(comparison!);
      expect(await resumedPoll).toBe(true);
      expect((await accountBrowserState(phone))[0].endpointId).toBe(pendingIdentity.endpointId);
      await noOverflow(phone); await phone.screenshot({ path: info.outputPath("account-phone-pending.png"), fullPage: true });
      // A different signed-in owner must never acquire authority from the link.
      const foreign = makeUser("account-foreign"); await registerUser(foreign.email, foreign.password);
      const foreignContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: false }); contexts.push(foreignContext);
      const foreignPage = await foreignContext.newPage(); await login(foreignPage, foreign.email, foreign.password, { pairBridge: false });
      await foreignPage.goto(privateLink); await expect(foreignPage).toHaveURL(`${origin}/devices/approve`);
      await expect(foreignPage.getByRole("heading", { name: "Waiting for device approval", exact: true })).toBeVisible();
      await expect(foreignPage.getByRole("button", { name: "Codes match — approve device", exact: true })).toHaveCount(0);
      expect((await accountBrowserState(foreignPage))[0].trust).toBeNull();
      // Tampering with the candidate proof cannot be repaired by account login.
      const tampered = new URL(privateLink); const value = structuredClone(pendingRequest);
      value.request.signingProof = `${value.request.signingProof[0] === "A" ? "B" : "A"}${value.request.signingProof.slice(1)}`;
      tampered.hash = `account=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
      const invalid = await desktop.newPage(); await invalid.goto(tampered.href);
      await expect(invalid.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible(); await invalid.close();
      await page.goto(privateLink); await expect(page).toHaveURL(`${origin}/devices/approve`);
      await expect(page.getByLabel("Comparison code", { exact: true })).toHaveText(comparison!);
      await noOverflow(page); await page.screenshot({ path: info.outputPath("account-device-confirmation.png"), fullPage: true });
      // Simulate an ambiguous reply only after the real server commits the
      // approval. The retry must deliver the same request without adding again.
      const enrollmentRoute = (url: URL) => url.pathname === enrollmentPath;
      let committedResponseDropped = false;
      await page.route(enrollmentRoute, async route => {
        if (route.request().method() === "POST" && !committedResponseDropped) {
          const committed = await route.fetch();
          if (!committed.ok()) { await route.fulfill({ response: committed }); return; }
          committedResponseDropped = true;
          await route.abort("connectionreset");
        } else await route.continue();
      });
      const approve = page.getByRole("button", { name: "Codes match — approve device", exact: true });
      await approve.click();
      await expect.poll(() => committedResponseDropped, { timeout: 15000 }).toBe(true);
      await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
      await expect(approve).toBeEnabled();
      const committedTrust = (await accountBrowserState(page))[0].trust!;
      expect(committedTrust.checkpoint.devices.filter(device => device.endpoint.id === pendingIdentity.endpointId)).toHaveLength(1);
      await approve.click();
      await expect(page.getByText(/Device approved\. It can now finish connecting/)).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
      const retriedTrust = (await accountBrowserState(page))[0].trust!;
      expect(retriedTrust.checkpoint.revision).toBe(committedTrust.checkpoint.revision);
      expect(retriedTrust.checkpoint.devices.filter(device => device.endpoint.id === pendingIdentity.endpointId)).toHaveLength(1);
      await page.unroute(enrollmentRoute);
      await expect(phone.locator(`[data-bridge-row="${firstId}"]`)).toBeVisible({ timeout: 60000 });
      await expect(phone.locator(`[data-bridge-row="${secondId}"]`)).toBeVisible({ timeout: 60000 });
      await expect(phone.getByRole("heading", { name: "Approve this device", exact: true })).toHaveCount(0);
      await expect(phone.getByRole("alert").filter({ hasText: "Approve this device using an existing approved device first." })).toHaveCount(0);
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
        if (viewport.width === 1280) await compactAccessEvidence(page, info, [firstId, secondId, thirdId]);
      } finally { release(); await staleTab.close(); }

      await devices(page); await noOverflow(page);
      await expect(page.getByRole("list", { name: "Account devices", exact: true })).toContainText("Account test phone");
      await page.screenshot({ path: info.outputPath("account-devices.png"), fullPage: true });
      await page.getByRole("button", { name: "Remove access for Account test phone", exact: true }).click();
      await page.getByRole("button", { name: "Confirm remove access", exact: true }).click();
      await expect(page.getByRole("list", { name: "Account devices", exact: true })).not.toContainText("Account test phone");
      await expect(page.getByRole("button", { name: /^Remove access for / })).toBeDisabled();
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
