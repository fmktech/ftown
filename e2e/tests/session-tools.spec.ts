import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { login, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { BRIDGE_HOME, E2E_DIR } from "../helpers/config";

const execute = promisify(execFile);
interface SessionResult { session: { id: string; pullRequestUrl?: string } }
interface AttentionEvent { id: string; title: string; message: string }
interface AttentionResult { event: AttentionEvent }
interface AttentionPage { events: AttentionEvent[] }

/** Use the real installed-command entry point and the scratch bridge pointer. */
async function sessionCommand<T>(sessionId: string, args: string[]): Promise<T> {
  const { stdout } = await execute(process.execPath, [join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js"), "sessions", ...args], {
    env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: sessionId },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

function originalRow(page: Page, name: string) {
  return page.locator('#dashboard-sidebar button[draggable="true"]')
    .filter({ has: page.getByText(name, { exact: true }) });
}

async function tabIntoHeaderLink(page: Page, link: Locator, mobile: boolean) {
  // These are the actual preceding controls in the visible DOM. Tab forward
  // proves the link is keyboard reachable without entering xterm, where
  // Shift+Tab intentionally sends a terminal escape sequence.
  const precedingControl = mobile
    ? page.getByRole("button", { name: "Terminal", exact: true })
    : page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await precedingControl.focus();
  await expect(precedingControl).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  expect(await link.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`agent CLI attention and session PR association on ${viewport.name}`, async ({ page, context }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // Clicking the real link must open its canonical destination while keeping
    // this integration test entirely independent of GitHub/network availability.
    await context.route("https://github.com/**", route => route.fulfill({
      status: 200, contentType: "text/html", body: "<!doctype html><title>PR destination intercepted</title>",
    }));
    await login(page, sharedEmail());
    await waitForBridgeOnline(page);

    const suffix = `${testInfo.workerIndex}-${Date.now().toString(36)}`;
    const targetName = `PR review ${suffix}`;
    const otherName = `Unchanged observer ${suffix}`;
    const created: string[] = [];
    const mobile = viewport.name === "mobile";
    const showWorkspace = async () => {
      if (mobile) await page.getByRole("button", { name: "Workspace", exact: true }).click();
    };
    const screenshot = async (name: string) => {
      const path = testInfo.outputPath(`${name}-${viewport.name}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`${name} ${viewport.name}`, { path, contentType: "image/png" });
    };
    const prOne = "https://github.com/fmktech/ftown/pull/123";
    const prTwo = "https://github.com/fmktech/ftown/pull/456";

    try {
      for (const name of [targetName, otherName]) {
        const response = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name } });
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        const id = (response.body as SessionResult).session?.id;
        expect(id).toBeTruthy();
        created.push(id);
      }
      const [targetId, otherId] = created;
      const capabilities = await bridgeApiFetch("GET", `/api/sessions/${targetId}`);
      expect(capabilities.status, JSON.stringify(capabilities.body)).toBe(200);
      expect(capabilities.body).toMatchObject({ capabilities: { attention: { version: 1, request: true }, sessionMetadata: { pullRequest: true } } });
      await showWorkspace();
      await expect(originalRow(page, targetName)).toBeVisible({ timeout: 30_000 });
      await originalRow(page, targetName).click();

      const attached = await sessionCommand<SessionResult>(targetId, ["pr", `${prOne}/?tab=files#review`]);
      expect(attached.session.id).toBe(targetId);
      expect(attached.session.pullRequestUrl).toBe(prOne);
      const headerLink = page.locator("main").getByRole("link", { name: `PR #123 in fmktech/ftown: ${prOne}`, exact: true });
      await expect(headerLink).toBeVisible();
      await expect(headerLink).toHaveAttribute("href", prOne);
      await expect(headerLink).toHaveAttribute("target", "_blank");
      await expect(headerLink).toHaveAttribute("rel", "noopener noreferrer");
      const box = await headerLink.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      await tabIntoHeaderLink(page, headerLink, mobile);
      const [destination] = await Promise.all([context.waitForEvent("page"), headerLink.click()]);
      await expect(destination).toHaveURL(prOne);
      await expect(destination).toHaveTitle("PR destination intercepted");
      await destination.close();

      // The full list on reload must retain persisted metadata, even before
      // another live update has occurred.
      await page.reload();
      await waitForBridgeOnline(page);
      await showWorkspace();
      await expect(originalRow(page, targetName).getByText("PR #123", { exact: true })).toBeVisible();
      await expect(originalRow(page, otherName).getByText(/PR #/)).toHaveCount(0);
      await originalRow(page, targetName).click();
      await expect(headerLink).toBeVisible();

      // Explicit identity overrides a different self env. Only target changes.
      const replaced = await sessionCommand<SessionResult>(otherId, ["pr", prTwo, "--session-id", targetId]);
      expect(replaced.session.id).toBe(targetId);
      expect(replaced.session.pullRequestUrl).toBe(prTwo);
      const replacementLink = page.locator("main").getByRole("link", { name: `PR #456 in fmktech/ftown: ${prTwo}`, exact: true });
      await expect(replacementLink).toBeVisible();
      await expect(headerLink).toHaveCount(0);
      await showWorkspace();
      await expect(originalRow(page, targetName).getByText("PR #456", { exact: true })).toBeVisible();
      await expect(originalRow(page, targetName).locator("a")).toHaveCount(0);
      await originalRow(page, otherName).click();
      await expect(page.locator("main").getByRole("link", { name: /PR #/ })).toHaveCount(0);
      await showWorkspace();

      const title = "PR review requested";
      const message = "Please inspect the associated pull request before I continue.";
      const attention = await sessionCommand<AttentionResult>(targetId, ["attention", "--title", title, "--message", message]);
      expect(attention.event).toMatchObject({ title, message });
      expect(attention.event.id).toBeTruthy();
      const targetAttention = await bridgeApiFetch("GET", `/api/sessions/${targetId}/attention`);
      expect(targetAttention.status, JSON.stringify(targetAttention.body)).toBe(200);
      expect((targetAttention.body as AttentionPage).events).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: attention.event.id, title, message }),
      ]));
      const observerAttention = await bridgeApiFetch("GET", `/api/sessions/${otherId}/attention`);
      expect(observerAttention.status, JSON.stringify(observerAttention.body)).toBe(200);
      expect((observerAttention.body as AttentionPage).events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: attention.event.id }),
      ]));
      const region = page.getByRole("region", { name: "Needs attention", exact: true });
      const shortcut = region.getByRole("button", { name: `${targetName}: ${title}. ${message}`, exact: true });
      await expect(shortcut).toBeVisible();
      await expect(region.getByRole("button", { name: new RegExp(otherName) })).toHaveCount(0);
      await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
      await expect(originalRow(page, targetName).getByText("PR #456", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await screenshot("attention-with-associated-pr");
      await shortcut.click();
      await expect(replacementLink).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
      if (mobile) await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveClass(/mobile-tab-active/);
      await tabIntoHeaderLink(page, replacementLink, mobile);
      await screenshot("selected-session-pr-link");
      await showWorkspace();
      await expect(region.getByRole("button", { name: new RegExp(targetName) })).toHaveCount(0);

      const unchanged = await bridgeApiFetch("GET", `/api/sessions/${otherId}`);
      expect(unchanged.status).toBe(200);
      expect((unchanged.body as SessionResult).session).not.toHaveProperty("pullRequestUrl");
      const cleared = await sessionCommand<SessionResult>(targetId, ["pr", "--clear"]);
      expect(cleared.session.id).toBe(targetId);
      expect(cleared.session).not.toHaveProperty("pullRequestUrl");
      await expect(originalRow(page, targetName).getByText(/PR #/)).toHaveCount(0);
      await originalRow(page, targetName).click();
      await expect(replacementLink).toHaveCount(0);
      await page.reload();
      await waitForBridgeOnline(page);
      await showWorkspace();
      await expect(originalRow(page, targetName)).toBeVisible();
      await expect(originalRow(page, targetName).getByText(/PR #/)).toHaveCount(0);
      await originalRow(page, targetName).click();
      await expect(page.locator("main").getByRole("link", { name: /PR #/ })).toHaveCount(0);
    } finally {
      // Session IDs are recorded only after this test created them.
      for (const id of created.reverse()) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined);
    }
  });
}
