import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { accountBrowserState, approveAccountComputer, createAccountShell, pendingBrowserRequest, startAccountTestBridge, type AccountTestBridge } from "../helpers/account-pairing";
import { readBridgePointer } from "../helpers/bridge-api";
import { login, makeUser, registerUser } from "../helpers/app";
const origin = process.env.FTOWN_PUBLIC_URL ?? "https://localhost:8444";
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
async function pendingId(page: Page): Promise<string> {
  await expect.poll(async () => (await pendingBrowserRequest(page))?.requestId ?? "", { timeout: 15000 }).not.toBe("");
  return (await pendingBrowserRequest(page))!.requestId!;
}
for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`automatic device approvals: browser and computer, both confirmations, reload and reject (${viewport.width})`, async ({ browser }, info) => {
    test.setTimeout(300000);
    const user = makeUser(`pending-${viewport.width}`); await registerUser(user.email, user.password);
    const contexts: BrowserContext[] = []; const bridges: AccountTestBridge[] = []; let failed = false;
    try {
      const trustedContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: false, viewport }); contexts.push(trustedContext);
      const trusted = await trustedContext.newPage();
      await trusted.goto("/");
      const diagram = trusted.getByRole("region", { name: "Follow the data, know the endpoints.", exact: true });
      await expect(diagram).toBeVisible(); await noOverflow(trusted);
      await trusted.screenshot({ path: info.outputPath("pending-main-page.png"), fullPage: true });
      await diagram.screenshot({ path: info.outputPath("pending-encryption-diagram.png") });
      await login(trusted, user.email, user.password, { pairBridge: false });
      // First-account bootstrap remains an explicit, independent trust ceremony.
      await expect(trusted.getByRole("heading", { name: "Waiting for device approval", exact: true })).toBeVisible();
      const first = await startAccountTestBridge(origin); bridges.push(first); const firstId = await approveAccountComputer(trusted, first);
      const initial = (await accountBrowserState(trusted))[0]; expect(initial.trust!.checkpoint.devices).toHaveLength(1);

      const candidateContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: false, viewport: { width: 390, height: 844 } }); contexts.push(candidateContext);
      const candidate = await candidateContext.newPage(); let createReplyDropped = false;
      await candidate.route(url => url.pathname === "/api/security/approvals", async route => {
        if (route.request().method() === "POST" && !createReplyDropped) {
          const committed = await route.fetch(); if (!committed.ok()) { await route.fulfill({ response: committed }); return; }
          createReplyDropped = true; await route.abort("connectionreset");
        } else await route.continue();
      });
      await login(candidate, user.email, user.password, { pairBridge: false });
      await expect(candidate.getByRole("heading", { name: "Waiting for device approval", exact: true })).toBeVisible();
      const requestId = await pendingId(candidate); const beforeReload = (await accountBrowserState(candidate))[0];
      await expect.poll(() => createReplyDropped, { timeout: 15000 }).toBe(true);
      await expect(candidate.getByLabel("Verification code", { exact: true })).toHaveCount(0);
      await expect(candidate.getByRole("textbox", { name: "Private approval link", exact: true })).toHaveCount(0);
      await candidate.reload();
      await expect(candidate.getByRole("heading", { name: "Waiting for device approval", exact: true })).toBeVisible();
      expect(await pendingId(candidate)).toBe(requestId); expect((await accountBrowserState(candidate))[0].endpointId).toBe(beforeReload.endpointId);
      expect((await accountBrowserState(candidate))[0].trust).toBeNull();
      const sibling = await candidateContext.newPage(); await sibling.goto("/dashboard");
      expect(await pendingId(sibling)).toBe(requestId);

      const reviewEntry = trusted.getByRole("button", { name: /^Review \d+ pending device approvals$/ });
      await expect(reviewEntry).toBeVisible({ timeout: 15000 }); await reviewEntry.click();
      const requestRow = trusted.locator(`[data-pending-request="${requestId}"]`); await expect(requestRow).toHaveCount(1);
      await requestRow.getByRole("button", { name: "Review", exact: true }).click();
      const review = trusted.getByRole("region", { name: "Review device approval", exact: true });
      await expect(review.getByLabel("Verification code", { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(candidate.getByLabel("Verification code", { exact: true })).toBeVisible({ timeout: 15000 });
      const comparison = await candidate.getByLabel("Verification code", { exact: true }).textContent();
      await expect(review.getByLabel("Verification code", { exact: true })).toHaveText(comparison!);
      await expect(sibling.getByLabel("Verification code", { exact: true })).toHaveText(comparison!);
      await noOverflow(trusted); await noOverflow(candidate);
      await trusted.screenshot({ path: info.outputPath("pending-trusted-review.png"), fullPage: true });
      await candidate.screenshot({ path: info.outputPath("pending-candidate-comparison.png"), fullPage: true });
      expect((await accountBrowserState(candidate))[0].trust).toBeNull();
      // Trusted confirmation alone may not finalize. Candidate confirmation must
      // be a separate local action on its actual browser.
      await review.getByRole("button", { name: "Codes match — approve device", exact: true }).click();
      await expect(review.getByText(/Confirmed here\. Waiting for confirmation/)).toBeVisible();
      expect((await accountBrowserState(candidate))[0].trust).toBeNull();
      let finalReplyDropped = false; const finals: string[] = [];
      await trusted.route(url => url.pathname === `/api/security/approvals/${requestId}`, async route => {
        const body: unknown = route.request().postDataJSON();
        const action = body && typeof body === "object" && "payload" in body ? (body as { payload?: { action?: { type?: string } } }).payload?.action : null;
        if (route.request().method() === "POST" && action?.type === "finish") {
          finals.push(route.request().postData()!);
          if (!finalReplyDropped) { const committed = await route.fetch(); if (!committed.ok()) { await route.fulfill({ response: committed }); return; } finalReplyDropped = true; await route.abort("connectionreset"); return; }
        }
        await route.continue();
      });
      await candidate.getByRole("button", { name: "Codes match on this device", exact: true }).click();
      // Exact replay and polling must recover without another confirmation click.
      await expect.poll(() => finalReplyDropped, { timeout: 15000 }).toBe(true);
      await expect.poll(() => finals.length >= 2, { timeout: 15000 }).toBe(true);
      expect(finals[0] === finals[1]).toBe(true);
      await expect(review.getByText(/Device approved\. It can now finish connecting/)).toBeVisible({ timeout: 15000 });
      await expect(review.getByRole("alert")).toHaveCount(0);
      await expect(candidate.locator(`[data-bridge-row="${firstId}"]`)).toBeVisible({ timeout: 60000 });
      await expect(sibling.locator(`[data-bridge-row="${firstId}"]`)).toBeVisible({ timeout: 60000 });
      await expect.poll(async () => (await pendingBrowserRequest(sibling))?.requestId ?? "", { timeout: 15000 }).toBe("");
      await sibling.close();
      const approved = (await accountBrowserState(candidate))[0]; expect(approved.hpkeExtractable).toBe(false); expect(approved.signingExtractable).toBe(false);
      expect(approved.trust!.checkpoint.devices.filter(device => device.endpoint.id === approved.endpointId)).toHaveLength(1);
      await expect(candidate.getByRole("alert").filter({ hasText: "Approve this device using an existing approved device first." })).toHaveCount(0);
      await review.getByRole("button", { name: "Close review", exact: true }).click();

      // An approval URL on an unapproved browser is never an approver shortcut.
      const untrustedContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: false, viewport: { width: 390, height: 844 } }); contexts.push(untrustedContext);
      const untrusted = await untrustedContext.newPage(); await login(untrusted, user.email, user.password, { pairBridge: false });
      const rejectedId = await pendingId(untrusted); const rejectedIdentity = (await accountBrowserState(untrusted))[0].endpointId;
      await untrusted.goto(`/devices/approve?request=${requestId}`);
      await expect(untrusted.getByText(/This browser is not approved and cannot approve another device/)).toBeVisible();
      await expect(untrusted.getByRole("button", { name: "Codes match — approve device", exact: true })).toHaveCount(0);
      expect(await pendingId(untrusted)).toBe(rejectedId);
      await trusted.locator(`[data-pending-request="${rejectedId}"]`).getByRole("button", { name: "Reject", exact: true }).click();
      await expect(untrusted.getByText("This request was rejected. Access was not granted by this request.", { exact: true })).toBeVisible({ timeout: 15000 });
      await untrusted.reload(); await expect(untrusted.getByText("This request was rejected. Access was not granted by this request.", { exact: true })).toBeVisible();
      expect(await pendingId(untrusted)).toBe(rejectedId); expect((await accountBrowserState(untrusted))[0].endpointId).toBe(rejectedIdentity); expect((await accountBrowserState(untrusted))[0].trust).toBeNull();

      if (viewport.width === 1280) {
        // Hold the valid approved history after remote finalization. A sibling
        // tab's local cancellation must atomically beat native-IDB admission.
        await untrusted.getByRole("button", { name: "Start a new request", exact: true }).click();
        await expect.poll(async () => (await pendingBrowserRequest(untrusted))?.requestId ?? "", { timeout: 15000 }).not.toBe(rejectedId);
        const cancelledBrowserId = await pendingId(untrusted);
        await trusted.locator(`[data-pending-request="${cancelledBrowserId}"]`).getByRole("button", { name: "Review", exact: true }).click();
        const cancelledBrowserReview = trusted.getByRole("region", { name: "Review device approval", exact: true });
        await expect(untrusted.getByLabel("Verification code", { exact: true })).toBeVisible({ timeout: 15000 });
        await expect(cancelledBrowserReview.getByLabel("Verification code", { exact: true })).toHaveText((await untrusted.getByLabel("Verification code", { exact: true }).textContent())!);
        const cancellingTab = await untrustedContext.newPage(); await cancellingTab.goto("/dashboard");
        await expect(cancellingTab.getByLabel("Verification code", { exact: true })).toBeVisible({ timeout: 15000 });
        let releaseHistory!: () => void; let heldHistories = 0;
        const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
        await untrustedContext.route(url => url.pathname === "/api/security/account", async route => {
          const response = await route.fetch();
          const body: unknown = await response.json();
          // IDs are public; only hold a history that includes this candidate.
          if (JSON.stringify(body).includes(rejectedIdentity)) { heldHistories++; await historyGate; }
          await route.fulfill({ response });
        });
        try {
          await cancelledBrowserReview.getByRole("button", { name: "Codes match — approve device", exact: true }).click();
          await untrusted.getByRole("button", { name: "Codes match on this device", exact: true }).click();
          await expect(cancelledBrowserReview.getByText(/Device approved\. It can now finish connecting/)).toBeVisible({ timeout: 20000 });
          await expect.poll(() => heldHistories, { timeout: 15000 }).toBeGreaterThan(0);
          await cancellingTab.getByRole("button", { name: "Codes differ — cancel", exact: true }).click();
          await expect(cancellingTab.getByText("This request was cancelled. Access was not granted by this request.", { exact: true })).toBeVisible();
        } finally { releaseHistory(); }
        await expect(untrusted.getByText("This request was cancelled. Access was not granted by this request.", { exact: true })).toBeVisible({ timeout: 15000 });
        expect((await accountBrowserState(untrusted))[0].trust).toBeNull();
        expect((await accountBrowserState(cancellingTab))[0].trust).toBeNull();
        await untrusted.reload();
        await expect(untrusted.getByText("This request was cancelled. Access was not granted by this request.", { exact: true })).toBeVisible();
        expect((await accountBrowserState(untrusted))[0].trust).toBeNull();
        await untrustedContext.unrouteAll({ behavior: "wait" }); await cancellingTab.close();
        await cancelledBrowserReview.getByRole("button", { name: "Close review", exact: true }).click();

        // Exercise actual local IPC cancellation after candidate confirmation,
        // while the trusted browser has deliberately not confirmed its code.
        const cancelled = await startAccountTestBridge(origin, user.email); bridges.push(cancelled);
        await expect.poll(async () => { try { return (await cancelled.pendingStatus()).phase; } catch { return "starting"; } }, { timeout: 30000 }).toBe("waiting");
        const cancelledId = (await cancelled.pendingStatus()).requestId;
        await trusted.locator(`[data-pending-request="${cancelledId}"]`).getByRole("button", { name: "Review", exact: true }).click();
        await expect.poll(async () => (await cancelled.pendingStatus()).phase, { timeout: 20000 }).toBe("comparing");
        const comparisonStatus = await cancelled.pendingStatus(); if (comparisonStatus.phase !== "comparing") throw new Error("Computer cancellation comparison did not become ready");
        const cancelledReview = trusted.getByRole("region", { name: "Review device approval", exact: true });
        await expect(cancelledReview.getByLabel("Verification code", { exact: true })).toHaveText(comparisonStatus.comparisonCode, { timeout: 15000 });
        const beforeResponse = await trusted.request.get("/api/security/account"); expect(beforeResponse.ok()).toBe(true);
        const beforeCancellation: unknown = await beforeResponse.json();
        await cancelled.confirmPending(comparisonStatus.comparisonCode);
        await expect.poll(async () => (await cancelled.pendingStatus()).phase, { timeout: 15000 }).toBe("confirming");
        await expect(cancelledReview.getByRole("button", { name: "Codes match — approve device", exact: true })).toBeEnabled();
        await cancelled.rejectPending();
        await expect.poll(async () => {
          const response = await trusted.request.get(`/api/security/approvals/${cancelledId}`);
          return response.ok() ? (await response.json() as { status: string }).status : "unavailable";
        }, { timeout: 15000 }).toBe("cancelled");
        await expect(cancelledReview.getByText("This request was cancelled. Access was not granted by this request.", { exact: true })).toBeVisible({ timeout: 15000 });
        await expect(cancelledReview.getByRole("button", { name: "Codes match — approve device", exact: true })).toHaveCount(0);
        const afterResponse = await trusted.request.get("/api/security/account"); expect(afterResponse.ok()).toBe(true);
        expect(JSON.stringify(await afterResponse.json()) === JSON.stringify(beforeCancellation)).toBe(true);
        await cancelledReview.getByRole("button", { name: "Close review", exact: true }).click();
      }

      // A virgin CLI computer uses its account inbox and confirms locally. No
      // private link or remote unauthenticated confirmation endpoint is used.
      const second = await startAccountTestBridge(origin, user.email); bridges.push(second);
      await expect.poll(async () => { try { return (await second.pendingStatus()).phase; } catch { return "starting"; } }, { timeout: 30000 }).toBe("waiting");
      const local = await second.pendingStatus(); const computerRow = trusted.locator(`[data-pending-request="${local.requestId}"]`);
      await computerRow.getByRole("button", { name: "Review", exact: true }).click();
      await expect.poll(async () => (await second.pendingStatus()).phase, { timeout: 20000 }).toBe("comparing");
      const localComparison = await second.pendingStatus(); if (localComparison.phase !== "comparing") throw new Error("Computer comparison did not become ready");
      const computerReview = trusted.getByRole("region", { name: "Review device approval", exact: true });
      await expect(computerReview.getByLabel("Verification code", { exact: true })).toHaveText(localComparison.comparisonCode, { timeout: 15000 });
      await second.confirmPending(localComparison.comparisonCode);
      await computerReview.getByRole("button", { name: "Codes match — approve device", exact: true }).click();
      await expect(computerReview.getByText(/Device approved\. It can now finish connecting/)).toBeVisible({ timeout: 20000 });
      await expect.poll(() => { try { return readBridgePointer(second.home).bridgeId; } catch { return ""; } }, { timeout: 30000 }).not.toBe("");
      const secondId = readBridgePointer(second.home).bridgeId;
      await expect(candidate.locator(`[data-bridge-row="${secondId}"]`)).toBeVisible({ timeout: 60000 });
      await createAccountShell(candidate, secondId, `PENDING_PRIVATE_${viewport.width}_${Date.now()}`);
      await noOverflow(candidate); await noOverflow(trusted);
      await trusted.screenshot({ path: info.outputPath("pending-computer-approved.png"), fullPage: true });
      expect((await accountBrowserState(candidate))[0].endpointId).toBe(approved.endpointId);
    } catch (error) { failed = true; throw error; }
    finally {
      const failures: string[] = [];
      for (const context of contexts.reverse()) try { await context.close(); } catch { failures.push("browser-context"); }
      for (const bridge of bridges.reverse()) try { await bridge.stop(); } catch { failures.push("account-bridge"); }
      if (!failed && failures.length) throw new Error(`Pending approval fixture cleanup failed: ${failures.join(", ")}`);
    }
  });
}
