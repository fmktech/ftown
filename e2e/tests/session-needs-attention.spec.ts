import { expect, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedEmail, waitForBridgeOnline, runMarkerInTerminal } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";

async function postHook(sessionId: string, hookEvent: string, data: Record<string, string> = {}): Promise<void> {
  const response = await bridgeApiFetch("POST", "/hook", {
    body: { ftown_session_id: sessionId, hook_event_name: hookEvent, ...data },
  });
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(200);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
}

function originalRow(page: Page, name: string) {
  // Attention shortcuts deliberately repeat the original name, so restrict
  // original-row actions to the existing draggable bridge/folder tree.
  return page.locator('#dashboard-sidebar button[draggable="true"]')
    .filter({ has: page.getByText(name, { exact: true }) });
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test.describe(`${viewport.name} attention controls`, () => {
  test.use({ hasTouch: viewport.name === "mobile" });
  test(`manual attention shortcuts retain originals and navigate on ${viewport.name}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await login(page, sharedEmail());
    await waitForBridgeOnline(page);

    const suffix = Date.now().toString(36);
    const firstName = `Review deployment plan ${suffix}`;
    const secondName = `Approve API changes and review the complete migration checklist ${suffix}`;
    const idleName = `Waiting for work ${suffix}`;
    const sessionIds: string[] = [];
    let bridgeId = "";
    const isMobile = viewport.name === "mobile";
    const showWorkspace = async () => {
      if (isMobile) await page.getByRole("button", { name: "Workspace", exact: true }).click();
    };

    try {
      for (const name of [firstName, secondName, idleName]) {
        const response = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name } });
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        const created = (response.body as { session?: { id?: string; bridgeId?: string } }).session;
        const id = created?.id;
        expect(id).toBeTruthy();
        bridgeId = created?.bridgeId ?? bridgeId;
        sessionIds.push(id!);
      }
      const [firstId, secondId, idleId] = sessionIds;

      // Put distinct real PTY output in two sessions. Returning through the
      // shortcut must show the requested session's own terminal scrollback.
      await showWorkspace();
      await expect(originalRow(page, firstName)).toBeVisible({ timeout: 30_000 });
      await originalRow(page, firstName).click();
      const requestedMarker = `REQUESTED${suffix}`;
      await runMarkerInTerminal(page, requestedMarker);
      await showWorkspace();
      await originalRow(page, idleName).click();
      const idleMarker = `IDLE${suffix}`;
      await runMarkerInTerminal(page, idleMarker);
      await showWorkspace();

      // An ordinary idle hook must not invent a manual-input request.
      await postHook(idleId, "Stop");
      const attentionRegion = page.getByRole("region", { name: "Needs attention", exact: true });
      await expect(attentionRegion).toHaveCount(0);
      const message = `Review the complete deployment plan before proceeding. Reference: ${"migrationApprovalReference".repeat(12)}`;
      await postHook(secondId, "Notification", {
        notification_type: "agent_needs_input", title: "API approval requested", message: "Approve the API changes before continuing.",
      });
      await expect(attentionRegion.getByRole("button", { name: new RegExp(`^${secondName}:`) })).toBeVisible();
      await postHook(firstId, "Notification", {
        notification_type: "agent_needs_input", title: "Deployment approval requested", message,
      });
      const firstShortcut = attentionRegion.getByRole("button", {
        name: `${firstName}: Deployment approval requested. ${message}`, exact: true,
      });
      await expect(firstShortcut).toBeVisible();
      const messagePreview = firstShortcut.getByText(message, { exact: true });
      await expect(messagePreview).toBeVisible();
      await expect(originalRow(page, firstName).getByText(message, { exact: true })).toHaveCount(0);
      await expect(originalRow(page, firstName).getByRole("img", { name: "Input needed", exact: true })).toBeVisible();
      await expect(attentionRegion.locator("button[data-attention-open]")).toHaveCount(2);
      await expect(attentionRegion.locator("button[data-attention-open]").first()).toHaveAccessibleName(
        `${firstName}: Deployment approval requested. ${message}`,
      );
      await expect(originalRow(page, firstName)).toBeVisible();
      await expect(originalRow(page, secondName)).toBeVisible();
      await expect(attentionRegion.getByText(idleName, { exact: true })).toHaveCount(0);

      for (const row of await attentionRegion.locator("button[data-attention-open]").all()) {
        const box = await row.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        await expect(row.locator("[data-harness-icon]")).toHaveCount(1);
      }
      expect(await attentionRegion.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await messagePreview.evaluate(element => {
        const style = getComputedStyle(element);
        return element.scrollWidth <= element.clientWidth
          && element.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) * 3 + 1;
      })).toBe(true);
      await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
      for (const dismiss of await attentionRegion.getByRole("button", { name: /^Dismiss attention for / }).all()) {
        const box = await dismiss.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(await dismiss.locator("..").locator("button").count()).toBe(2);
      }
      expect(bridgeId).toBeTruthy();
      const bridgeHeader = page.locator(`[data-bridge-row="${bridgeId}"]`);
      const disclosure = bridgeHeader.getByRole("button", { name: /^(Collapse|Expand) / });
      const dragHandle = bridgeHeader.locator("[data-bridge-drag]");
      await expect(bridgeHeader).toBeVisible();
      if (isMobile) {
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: viewport.height });
          const headerBox = await bridgeHeader.boundingBox();
          expect(headerBox).not.toBeNull();
          expect(headerBox!.height).toBeGreaterThanOrEqual(52);
          for (const control of [...await bridgeHeader.getByRole("button").all(), dragHandle]) {
            const box = await control.boundingBox();
            expect(box).not.toBeNull();
            expect(box!.width).toBeGreaterThanOrEqual(44);
            expect(box!.height).toBeGreaterThanOrEqual(44);
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          }
          expect(await disclosure.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBe(14);
          expect(await dragHandle.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBe(18);
          expect(await bridgeHeader.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
          expect(await attentionRegion.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await disclosure.tap();
          await expect(disclosure).toHaveAttribute("aria-expanded", "false");
          await expect(originalRow(page, firstName)).toHaveCount(0);
          await expect(firstShortcut).toBeVisible();
          await disclosure.tap();
          await expect(disclosure).toHaveAttribute("aria-expanded", "true");
          await expect(originalRow(page, firstName)).toBeVisible();
          const controlsScreenshot = testInfo.outputPath(`mobile-bridge-controls-${width}.png`);
          await page.screenshot({ path: controlsScreenshot, fullPage: true });
          await testInfo.attach(`Mobile bridge controls ${width}`, { path: controlsScreenshot, contentType: "image/png" });
        }
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
      } else {
        expect((await bridgeHeader.boundingBox())!.height).toBeLessThan(52);
        expect(await disclosure.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBe(11);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      if (!isMobile) {
        // Enter a real keyboard-navigation sequence, retaining the visible
        // focus ring in the desktop review screenshot.
        await firstShortcut.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(firstShortcut).toBeFocused();
        expect(await firstShortcut.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
      }
      const screenshotPath = testInfo.outputPath(`needs-attention-${viewport.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach(`Needs attention ${viewport.name}`, { path: screenshotPath, contentType: "image/png" });

      if (isMobile) await firstShortcut.tap();
      else await page.keyboard.press("Enter");
      await expect(page.locator(".xterm").first()).toBeVisible();
      await expect(page.locator(".xterm-rows").first()).toContainText(requestedMarker, { timeout: 30_000 });
      await expect(page.locator(".xterm-rows").first()).not.toContainText(idleMarker);
      if (isMobile) {
        await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveClass(/mobile-tab-active/);
      }
      await showWorkspace();
      await expect(firstShortcut).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
      await expect(originalRow(page, firstName)).toBeVisible();
      await expect(attentionRegion.locator("button[data-attention-open]")).toHaveCount(2);

      // Original-row navigation and selecting the already open session retain
      // the same request; only a new prompt or explicit dismissal handles it.
      await originalRow(page, firstName).click();
      await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
      if (isMobile) await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveClass(/mobile-tab-active/);
      await showWorkspace();
      await expect(firstShortcut).toBeVisible();
      const openedScreenshot = testInfo.outputPath(`needs-attention-after-open-${viewport.name}.png`);
      await page.screenshot({ path: openedScreenshot, fullPage: true });
      await testInfo.attach(`Needs attention after open ${viewport.name}`, { path: openedScreenshot, contentType: "image/png" });
      // Prompt resolution is durable even when no dashboard receives its hook.
      await page.goto("about:blank");
      await postHook(firstId, "UserPromptSubmit");
      const continued = await bridgeApiFetch("GET", `/api/sessions/${firstId}/attention?includeResolved=true`);
      expect(continued.status, JSON.stringify(continued.body)).toBe(200);
      const continuedEvent = (continued.body as { events: Array<{ message: string; resolvedAt?: string; resolution?: string }> })
        .events.find(event => event.message === message);
      expect(continuedEvent?.resolvedAt).toBeTruthy();
      expect(continuedEvent?.resolution).toBe("user_prompt");
      await page.goto("/dashboard");
      await waitForBridgeOnline(page);
      await showWorkspace();
      await expect(originalRow(page, firstName)).toBeVisible();
      await expect(firstShortcut).toHaveCount(0);
      await expect(attentionRegion.locator("button[data-attention-open]")).toHaveCount(1);
      await originalRow(page, firstName).click();
      await showWorkspace();

      // A fresh request on the already selected session remains after another
      // selection. The explicit dismissal removes only that request.
      const freshMessage = "Request received while this session is already open.";
      await postHook(firstId, "Notification", { notification_type: "agent_needs_input", title: "Review still pending", message: freshMessage });
      const freshShortcut = attentionRegion.getByRole("button", { name: `${firstName}: Review still pending. ${freshMessage}`, exact: true });
      await expect(freshShortcut).toBeVisible();
      await originalRow(page, firstName).click();
      await expect(page.getByRole("alert").filter({ hasText: freshMessage })).toHaveCount(0);
      await showWorkspace();
      const dismiss = attentionRegion.getByRole("button", { name: `Dismiss attention for ${firstName}`, exact: true });
      if (isMobile) await dismiss.tap();
      else await dismiss.click();
      await expect(freshShortcut).toHaveCount(0);
      await expect(attentionRegion.locator("button[data-attention-open]")).toHaveCount(1);

      // Existing Hide behavior removes the shortcut without deleting the
      // session. Unhide restores the same unresolved request.
      await originalRow(page, secondName).getByRole("button", { name: "Session actions", exact: true }).click();
      await page.getByRole("menu", { name: "Session actions" }).getByRole("menuitem", { name: "Hide", exact: true }).click();
      await expect(attentionRegion).toHaveCount(0);
      await page.getByRole("button", { name: /Hidden \(1\)/ }).click();
      await page.locator("#dashboard-sidebar").getByRole("button", { name: new RegExp(secondName) }).click({ button: "right" });
      await page.getByRole("menu", { name: "Session actions" }).getByRole("menuitem", { name: "Unhide", exact: true }).click();
      await expect(attentionRegion.getByRole("button", { name: new RegExp(`^${secondName}:`) })).toBeVisible();
      await postHook(secondId, "UserPromptSubmit");
      await expect(attentionRegion).toHaveCount(0);
      await expect(originalRow(page, secondName)).toBeVisible();
      await page.reload();
      await waitForBridgeOnline(page);
      await showWorkspace();
      await expect(originalRow(page, firstName)).toBeVisible();
      await expect(originalRow(page, secondName)).toBeVisible();
      await expect(attentionRegion).toHaveCount(0);
    } finally {
      for (const id of sessionIds.reverse()) {
        await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined);
      }
    }
  });
  });
}
