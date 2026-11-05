import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { atomicHtml, createPreviewFixture, previewHtml } from "../helpers/session-preview";

const fileName = "pr-review-preview.html";
const frameDocument = (page: Page) => page.frameLocator(`iframe[title="HTML preview: ${fileName}"]`);
const review = (page: Page) => page.locator("#session-review-panel");
const lines = (text: string, value: string) => text.split("\n").filter(line => line === value).length;

async function selectSession(page: Page, name: string): Promise<void> {
  const workspace = page.getByRole("tab", { name: "Workspace", exact: true });
  if (await workspace.isVisible()) await workspace.click();
  const row = page.locator('#dashboard-sidebar button[draggable="true"]').filter({ has: page.getByText(name, { exact: true }) });
  await expect(row).toBeVisible();
  await row.getByText(name, { exact: true }).click();
}
async function screenshot(page: Page, info: TestInfo, label: string): Promise<void> {
  const path = info.outputPath(`${label}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(label, { path, contentType: "image/png" });
}
async function noPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test.describe(`PR review ${viewport.name}`, () => {
  test.use({ hasTouch: viewport.name === "mobile" });
  test(`is inert and preserves the live workspace`, async ({ page }, info) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const logPath = process.env.FTOWN_PR_REVIEW_FAKE_GH_LOG;
    if (!logPath) throw new Error("FTOWN_PR_REVIEW_FAKE_GH_LOG must name the isolated fake-gh log");
    const before = await readFile(logPath, "utf8");
    const fixture = await createPreviewFixture();
    const marker = `PR_REVIEW_PREVIEW_${info.workerIndex}_${Date.now().toString(36)}`;
    const name = `PR review ${marker}`;
    const outboundGithub: string[] = [];
    page.on("request", request => { if (new URL(request.url()).hostname === "github.com") outboundGithub.push(request.method()); });
    await page.route("https://github.com/**", route => route.abort());
    try {
      await atomicHtml(join(fixture.directory, fileName), previewHtml(marker, 1));
      const session = await fixture.create(name);
      await fixture.register(session, fileName);
      const linked = await fixture.cli(session, ["pr", "https://github.com/owner/repo/pull/12"]);
      expect(linked.code).toBe(0);
      await login(page, sharedEmail());
      await waitForBridgeOnline(page);
      await selectSession(page, name);
      await expect(frameDocument(page).getByRole("heading", { name: `${marker} version 1`, exact: true })).toBeVisible();
      const counter = frameDocument(page).getByRole("button", { name: "Count: 0", exact: true });
      await counter.click();
      await expect(frameDocument(page).getByRole("button", { name: "Count: 1", exact: true })).toBeVisible();
      await expect(page.locator(".xterm").first()).toBeAttached();
      await page.evaluate(() => {
        const state = window as Window & { __prReviewNodes?: { terminal: Element | null; frame: Element | null } };
        state.__prReviewNodes = { terminal: document.querySelector(".xterm"), frame: document.querySelector('iframe[title="HTML preview: pr-review-preview.html"]') };
      });
      if (viewport.name === "mobile") await page.getByRole("tab", { name: "Workspace", exact: true }).click();
      await page.getByRole("button", { name: "Review pull request", exact: true }).click();
      await expect(review(page)).toBeVisible();
      await expect(review(page).locator("h2")).toHaveText("<img src=x onerror=bad()>");
      await review(page).getByRole("tab", { name: "Description", exact: true }).click();
      await expect(review(page).locator(".pr-review-body")).toHaveText("<script>bad()</script>");
      await review(page).getByRole("tab", { name: /^Files changed/ }).click();
      await expect(review(page).locator(".pr-review-diff")).toContainText("+<svg onload=bad()>");
      for (const part of [review(page).locator("h2"), review(page).locator(".pr-review-diff")]) {
        await expect(part.locator("img, script, svg")).toHaveCount(0);
      }
      await review(page).getByRole("tab", { name: "Description", exact: true }).click();
      await expect(review(page).locator(".pr-review-body").locator("img, script, svg")).toHaveCount(0);
      await review(page).getByRole("tab", { name: /^Files changed/ }).click();
      const filesToggle = review(page).getByRole("button", { name: /^Files \(\d+\)$/ });
      if (await filesToggle.isVisible()) await filesToggle.click();
      const fileLink = review(page).getByRole("navigation", { name: "Changed files" }).getByRole("button", { name: "example.txt" });
      await expect(fileLink).toBeVisible();
      await fileLink.click();
      await expect(review(page).locator("#pr-review-file-0")).toBeInViewport();
      await expect(review(page).locator(".pr-review-checks")).toBeVisible();
      await expect.poll(async () => lines(await readFile(logPath, "utf8"), "metadata")).toBeGreaterThan(lines(before, "metadata"));
      await expect.poll(async () => lines(await readFile(logPath, "utf8"), "diff")).toBeGreaterThan(lines(before, "diff"));
      await noPageOverflow(page);
      if (viewport.name === "mobile") {
        for (const control of [page.getByRole("tab", { name: "PR review", exact: true }), page.getByRole("button", { name: "Close PR review", exact: true })]) {
          const box = await control.boundingBox(); expect(box).not.toBeNull(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
        }
      }
      await screenshot(page, info, `pr-review-${viewport.name}`);
      const previewTab = page.getByRole("tab", { name: "Preview", exact: true });
      const reviewTab = page.getByRole("tab", { name: "PR review", exact: true });
      await previewTab.click();
      await expect(previewTab).toHaveAttribute("aria-selected", "true");
      await expect(frameDocument(page).getByRole("button", { name: "Count: 1", exact: true })).toBeVisible();
      expect(await page.evaluate(() => {
        const state = (window as Window & { __prReviewNodes?: { terminal: Element | null; frame: Element | null } }).__prReviewNodes;
        return !!state && state.terminal === document.querySelector(".xterm") && state.frame === document.querySelector('iframe[title="HTML preview: pr-review-preview.html"]');
      })).toBe(true);
      await previewTab.focus(); await page.keyboard.press("End");
      await expect(reviewTab).toHaveAttribute("aria-selected", "true");
      await expect(reviewTab).toBeFocused();
      await expect(review(page).locator("h2")).toHaveText("<img src=x onerror=bad()>");
      await page.getByRole("button", { name: "Expand PR review", exact: true }).click();
      await expect(page.getByRole("button", { name: "Collapse PR review", exact: true })).toBeVisible();
      if (viewport.name === "mobile") {
        // UR-2: both click and keyboard selection of Terminal must dismiss
        // expansion without removing the existing terminal or preview iframe.
        const terminalTab = page.getByRole("tab", { name: "Terminal", exact: true });
        await terminalTab.click();
        await expect(terminalTab).toHaveAttribute("aria-selected", "true");
        await expect(page.locator(".xterm").first()).toBeVisible();
        await reviewTab.click();
        await expect(page.getByRole("button", { name: "Expand PR review", exact: true })).toBeVisible();
        await previewTab.click();
        await page.getByRole("button", { name: "Expand preview", exact: true }).click();
        await previewTab.focus(); await page.keyboard.press("ArrowLeft");
        await expect(terminalTab).toHaveAttribute("aria-selected", "true");
        await expect(terminalTab).toBeFocused();
        await expect(page.locator(".xterm").first()).toBeVisible();
        await previewTab.click();
        await expect(page.getByRole("button", { name: "Expand preview", exact: true })).toBeVisible();
        await expect(frameDocument(page).getByRole("button", { name: "Count: 1", exact: true })).toBeVisible();
        expect(await page.evaluate(() => {
          const state = (window as Window & { __prReviewNodes?: { terminal: Element | null; frame: Element | null } }).__prReviewNodes;
          return !!state && state.terminal === document.querySelector(".xterm") && state.frame === document.querySelector('iframe[title="HTML preview: pr-review-preview.html"]');
        })).toBe(true);
        await previewTab.focus(); await page.keyboard.press("End");
        await expect(reviewTab).toHaveAttribute("aria-selected", "true");
      } else {
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: "Expand PR review", exact: true })).toBeVisible();
      }
      await page.getByRole("button", { name: "Close PR review", exact: true }).click();
      await expect(review(page)).toHaveCount(0);
      await expect(frameDocument(page).getByRole("button", { name: "Count: 1", exact: true })).toBeVisible();
      expect(await page.evaluate(() => {
        const state = (window as Window & { __prReviewNodes?: { terminal: Element | null; frame: Element | null } }).__prReviewNodes;
        return !!state && state.terminal === document.querySelector(".xterm") && state.frame === document.querySelector('iframe[title="HTML preview: pr-review-preview.html"]');
      })).toBe(true);
      // UR-1: close the expanded preview with review open, then register a
      // replacement and remove it while Review is selected. Neither operation
      // may strand the user in a blank pane; only the removed iframe may die.
      if (viewport.name === "mobile") await page.getByRole("tab", { name: "Workspace", exact: true }).click();
      await page.getByRole("button", { name: "Review pull request", exact: true }).click();
      await expect(review(page)).toBeVisible();
      await page.getByRole("tab", { name: "Preview", exact: true }).click();
      await page.getByRole("button", { name: "Expand preview", exact: true }).click();
      await page.getByRole("button", { name: "Close preview", exact: true }).click();
      await expect(review(page)).toBeVisible();
      await expect(page.getByRole("button", { name: "Expand PR review", exact: true })).toBeVisible();
      if (viewport.name === "mobile") await expect(reviewTab).toHaveAttribute("aria-selected", "true");
      else await expect(page.locator(".xterm").first()).toBeVisible();
      expect(await page.evaluate(() => {
        const state = (window as Window & { __prReviewNodes?: { terminal: Element | null } }).__prReviewNodes;
        return !!state && state.terminal === document.querySelector(".xterm");
      })).toBe(true);
      await fixture.register(session, fileName);
      await expect(page.getByRole("tab", { name: "Preview", exact: true })).toBeVisible();
      await expect(review(page)).toBeVisible();
      const cleared = await fixture.cli(session, ["preview", "--clear"]);
      expect(cleared.code).toBe(0);
      await expect(page.getByRole("tab", { name: "Preview", exact: true })).toHaveCount(0);
      await expect(review(page)).toBeVisible();
      if (viewport.name === "mobile") await expect(reviewTab).toHaveAttribute("aria-selected", "true");
      expect(await page.evaluate(() => {
        const state = (window as Window & { __prReviewNodes?: { terminal: Element | null } }).__prReviewNodes;
        return !!state && state.terminal === document.querySelector(".xterm");
      })).toBe(true);
      await page.getByRole("button", { name: "Close PR review", exact: true }).click();
      await expect(page.locator(".xterm").first()).toBeVisible();
      if (viewport.name === "mobile") await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toHaveAttribute("aria-selected", "true");
      await noPageOverflow(page);
      expect(outboundGithub).toEqual([]);
    } finally { await fixture.cleanup(); }
  });
  test("sidebar badge and menu open the target session review", async ({ page }, info) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const fixture = await createPreviewFixture();
    const marker = `PR_REVIEW_ENTRY_${info.workerIndex}_${Date.now().toString(36)}`;
    const targetName = `Target ${marker}`;
    const otherName = `Other ${marker}`;
    const popups: Page[] = [];
    page.on("popup", popup => popups.push(popup));
    try {
      const target = await fixture.create(targetName);
      await fixture.create(otherName);
      const linked = await fixture.cli(target, ["pr", "https://github.com/owner/repo/pull/12"]);
      expect(linked.code).toBe(0);
      await login(page, sharedEmail());
      await waitForBridgeOnline(page);
      await selectSession(page, otherName);
      if (viewport.name === "mobile") await page.getByRole("tab", { name: "Workspace", exact: true }).click();
      const row = page.locator("[data-session-row]").filter({ has: page.getByText(targetName, { exact: true }) });
      const badge = row.getByRole("button", { name: /Review pull request: PR #12/ });
      await expect(badge).toBeVisible();
      if (viewport.name === "mobile") {
        const hit = await badge.boundingBox();
        const menuButton = await row.getByRole("button", { name: "Session actions", exact: true }).boundingBox();
        expect(hit).not.toBeNull(); expect(menuButton).not.toBeNull();
        expect(hit!.width).toBeGreaterThanOrEqual(44); expect(hit!.height).toBeGreaterThanOrEqual(44);
        expect(hit!.x + hit!.width).toBeLessThanOrEqual(menuButton!.x);
      }
      await badge.focus(); await page.keyboard.press("Enter");
      await expect(review(page)).toBeVisible();
      await expect(page.getByRole("region", { name: `Session workspace: ${targetName}` })).toBeVisible();
      await expect(review(page).locator("h2")).toHaveText("<img src=x onerror=bad()>");
      await expect(review(page).getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", "https://github.com/owner/repo/pull/12");
      if (viewport.name === "mobile") await expect(page.getByRole("tab", { name: "PR review", exact: true })).toHaveAttribute("aria-selected", "true");
      await selectSession(page, otherName);
      if (viewport.name === "mobile") await page.getByRole("tab", { name: "Workspace", exact: true }).click();
      await row.getByRole("button", { name: "Session actions", exact: true }).click();
      const menu = page.getByRole("menu", { name: "Session actions" });
      await expect(menu).toBeVisible();
      await menu.getByRole("menuitem", { name: "Review pull request", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(menu).toHaveCount(0);
      await expect(review(page)).toBeVisible();
      await expect(page.getByRole("region", { name: `Session workspace: ${targetName}` })).toBeVisible();
      await expect(review(page).locator("h2")).toHaveText("<img src=x onerror=bad()>");
      if (viewport.name === "mobile") await expect(page.getByRole("tab", { name: "PR review", exact: true })).toHaveAttribute("aria-selected", "true");
      expect(popups).toHaveLength(0);
      await noPageOverflow(page);
    } finally { await fixture.cleanup(); }
  });
  });
}
