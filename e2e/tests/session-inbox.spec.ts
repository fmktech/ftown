import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { BRIDGE_HOME, E2E_DIR } from "../helpers/config";
const execute = promisify(execFile);
for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 320, height: 844 }]) {
  test(`inbox queues a durable reply and dismissal survives reload on ${viewport.name}`, async ({ page }, info) => {
    test.setTimeout(180_000); await page.setViewportSize({ width: viewport.width, height: viewport.height }); await login(page, sharedEmail()); await waitForBridgeOnline(page);
    const name = `Inbox reply ${Date.now().toString(36)}`; let id = "";
    try {
      const created = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name } }); expect(created.status, JSON.stringify(created.body)).toBe(201);
      id = (created.body as { session: { id: string } }).session.id; expect(id).toBeTruthy();
      const message = `Please review this full request.\n${"LongUnbrokenReference".repeat(25)}`;
      await execute(process.execPath, [join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js"), "sessions", "attention", "--title", "Review requested", "--message", message], { env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: id }, timeout: 30_000 });
      if (viewport.name === "mobile") await page.getByRole("tab", { name: "Workspace", exact: true }).click();
      const trigger = page.getByRole("button", { name: /^Inbox, [1-9]\d* messages?$/ }); await expect(trigger).toBeVisible();
      await trigger.click(); const dialog = page.getByRole("dialog", { name: "Inbox", exact: true }); const item = dialog.locator(`[data-inbox-entry="${id}"]`);
      await expect(item.getByText("Review requested", { exact: true })).toBeVisible(); await expect(item.locator("p.whitespace-pre-wrap")).toHaveText(message);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`session-inbox-${viewport.name}.png`), fullPage: true });
      const reply = `Queued browser reply ${Date.now().toString(36)}`; await item.getByLabel(`Reply to ${name}`).fill(reply); await item.getByRole("button", { name: "Send reply" }).click();
      await expect(item.getByRole("status")).toHaveText("Reply queued."); await expect(item).toBeVisible();
      await expect.poll(async () => { const result = await bridgeApiFetch("GET", `/api/sessions/${id}/inbox?peek=1&all=1`); return JSON.stringify(result.body).includes(reply); }).toBe(true);
      const mail = await bridgeApiFetch("GET", `/api/sessions/${id}/inbox?peek=1&all=1`); expect(mail.status).toBe(200);
      const messages = (mail.body as { messages: Array<{ body: string; from: string; fromName?: string }> }).messages;
      expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ body: reply, from: "browser", fromName: "You" })]));
      await item.getByRole("button", { name: "Dismiss" }).click(); await expect(item).toHaveCount(0); await dialog.getByRole("button", { name: "Close" }).click();
      await page.reload(); await waitForBridgeOnline(page); if (viewport.name === "mobile") await page.getByRole("tab", { name: "Workspace", exact: true }).click();
      await page.getByRole("button", { name: /^Inbox, / }).click(); await expect(page.getByRole("dialog", { name: "Inbox" }).locator(`[data-inbox-entry="${id}"]`)).toHaveCount(0);
    } finally { if (id) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined); }
  });
}
