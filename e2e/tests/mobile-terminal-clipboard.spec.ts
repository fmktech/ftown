import { expect, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { createShellSession, login, openSession, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { sessionIdsFor, waitForNewSessionId } from "../helpers/centrifugo";
import { UI_BASE_URL } from "../helpers/config";

/**
 * Mobile terminal copy sheet and key-bar paste.
 *
 * The control bar is only displayed under `@media (pointer: coarse)`, so every
 * test runs in a touch + isMobile context. On touch xterm's own textarea is
 * readonly, so typing goes through the key bar's hidden "Terminal input" field.
 *
 * Clipboard access uses Chromium's real clipboard-read/clipboard-write
 * permissions for the UI origin. If the CI Chromium refuses them, stub
 * navigator.clipboard through addInitScript instead (the paste and copy code
 * only calls readText/writeText).
 */
test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

async function openMobileShell(page: Page, holder: { sid?: string }): Promise<void> {
  const email = sharedEmail();
  await login(page, email);
  await waitForBridgeOnline(page);
  const name = `mobile-clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const before = await sessionIdsFor(email);
  await createShellSession(page, name);
  holder.sid = await waitForNewSessionId(email, before);
  // The UI selects the new session (and flips to the Terminal tab) only when its create call
  // resolves, which also closes the dialog. Wait for that before returning to Workspace.
  await page.getByRole("dialog", { name: "New Session" }).waitFor({ state: "hidden", timeout: 30_000 });
  // Creating a session switches the phone layout to the Terminal tab, which hides the
  // session list. Return to the Workspace tab so the row can be selected.
  await page.getByRole("tab", { name: "Workspace", exact: true }).tap();
  await openSession(page, name);
  await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Select terminal text to copy" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".xterm-rows").first()).toContainText(/[$%#>]/, { timeout: 30_000 });
}

async function removeSessionQuietly(sid: string | undefined): Promise<void> {
  if (!sid) return;
  await bridgeApiFetch("DELETE", `/api/sessions/${sid}`).catch(() => undefined);
}

/** Type through the key bar's hidden input (xterm's textarea is readonly on touch). */
async function typeViaKeyBar(page: Page, text: string): Promise<void> {
  await page.locator('input[aria-label="Terminal input"]').evaluate((el) => (el as HTMLInputElement).focus());
  await page.keyboard.type(text);
}

async function tapEnter(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Enter", exact: true }).tap();
}

test.describe("mobile terminal clipboard", () => {
  test("Select opens the copy sheet and Copy all writes the buffer to the clipboard", async ({ page, context }) => {
    test.setTimeout(150_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: UI_BASE_URL });
    const holder: { sid?: string } = {};
    try {
      await openMobileShell(page, holder);
      const result = "ftown-copy-42";
      await typeViaKeyBar(page, "echo ftown-copy-$((6*7))");
      await tapEnter(page);
      await expect(page.locator(".xterm-rows").first()).toContainText(result, { timeout: 20_000 });

      await page.getByRole("button", { name: "Select terminal text to copy" }).tap();
      const dialog = page.getByRole("dialog", { name: "Copy terminal text" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("terminal-copy-text")).toContainText(result);

      await dialog.getByRole("button", { name: "Copy all" }).tap();
      await expect(dialog.getByRole("status")).toHaveText("Copied");
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboard).toContain(result);

      await dialog.getByRole("button", { name: "Close" }).tap();
      await expect(dialog).toHaveCount(0);
    } finally {
      await removeSessionQuietly(holder.sid);
    }
  });

  test("key-bar Paste sends the client clipboard text to the terminal", async ({ page, context }) => {
    test.setTimeout(150_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: UI_BASE_URL });
    const holder: { sid?: string } = {};
    try {
      await openMobileShell(page, holder);
      const result = "ftown-paste-56";
      const command = "echo ftown-paste-$((7*8))";
      await page.evaluate((text) => navigator.clipboard.writeText(text), command);

      await page.getByRole("button", { name: "Paste clipboard into terminal" }).tap();
      await expect(page.locator(".xterm-rows").first()).toContainText(command, { timeout: 20_000 });
      await tapEnter(page);
      await expect(page.locator(".xterm-rows").first()).toContainText(result, { timeout: 20_000 });
    } finally {
      await removeSessionQuietly(holder.sid);
    }
  });

  test("Paste falls back to a text box when clipboard read fails", async ({ page }) => {
    test.setTimeout(150_000);
    // No clipboard-read permission granted; stub readText to reject so the result
    // is deterministic across Chromium builds.
    await page.addInitScript(() => {
      const denied = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
      if (navigator.clipboard) {
        Object.defineProperty(navigator.clipboard, "readText", { value: denied, configurable: true });
      } else {
        Object.defineProperty(navigator, "clipboard", { value: { readText: denied }, configurable: true });
      }
    });
    const holder: { sid?: string } = {};
    try {
      await openMobileShell(page, holder);
      const result = "ftown-fallback-72";
      const command = "echo ftown-fallback-$((8*9))";

      await page.getByRole("button", { name: "Paste clipboard into terminal" }).tap();
      const area = page.getByRole("textbox", { name: "Text to paste" });
      await expect(area).toBeVisible();
      await area.fill(command);
      await page.getByRole("button", { name: "Send", exact: true }).tap();
      await expect(page.locator(".xterm-rows").first()).toContainText(command, { timeout: 20_000 });
      await tapEnter(page);
      await expect(page.locator(".xterm-rows").first()).toContainText(result, { timeout: 20_000 });
    } finally {
      await removeSessionQuietly(holder.sid);
    }
  });
});
