import { expect, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedEmail, waitForBridgeOnline, runMarkerInTerminal } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";

async function postHook(sessionId: string, hookEvent: string, data: Record<string, string> = {}) {
  const response = await bridgeApiFetch("POST", "/hook", { body: { ftown_session_id: sessionId, hook_event_name: hookEvent, ...data } });
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(200); expect(response.status).toBeLessThan(300);
}
function originalRow(page: Page, name: string) { return page.locator('#dashboard-sidebar button[draggable="true"]').filter({ has: page.getByText(name, { exact: true }) }); }
for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test.describe(`${viewport.name} attention controls`, () => {
    test.use({ hasTouch: viewport.name === "mobile" });
    test(`manual notices retain originals and navigate on ${viewport.name}`, async ({ page }, info) => {
      test.setTimeout(180_000); await page.setViewportSize({ width: viewport.width, height: viewport.height }); await login(page, sharedEmail()); await waitForBridgeOnline(page);
      const suffix = Date.now().toString(36), firstName = `Review deployment ${suffix}`, secondName = `Approve API ${suffix}`, idleName = `Idle ${suffix}`;
      const ids: string[] = []; const mobile = viewport.name === "mobile";
      const workspace = async () => { if (mobile) await page.getByRole("tab", { name: "Workspace", exact: true }).click(); };
      const inbox = page.getByRole("region", { name: "Inbox", exact: true });
      const openInbox = async () => { await page.getByRole("button", { name: /^Inbox, / }).click(); await expect(inbox).toBeVisible(); };
      const closeInbox = async () => inbox.getByRole("button", { name: "Back to workspace", exact: true }).click();
      try {
        for (const name of [firstName, secondName, idleName]) {
          const response = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name } }); expect(response.status, JSON.stringify(response.body)).toBe(201);
          const id = (response.body as { session: { id: string } }).session.id; expect(id).toBeTruthy(); ids.push(id);
        }
        const [first, second, idle] = ids;
        await workspace(); await expect(originalRow(page, firstName)).toBeVisible({ timeout: 30_000 }); await originalRow(page, firstName).click();
        const marker = `REQUESTED${suffix}`; await runMarkerInTerminal(page, marker); await workspace(); await originalRow(page, idleName).click(); await workspace();
        await postHook(idle, "Stop"); await expect(page.getByRole("button", { name: "Inbox, 0 messages" })).toBeVisible();
        const message = `Review the complete deployment plan. ${"longReference".repeat(30)}`;
        await postHook(second, "Notification", { notification_type: "agent_needs_input", title: "API approval", message: "Approve the API changes." });
        await postHook(first, "Notification", { notification_type: "agent_needs_input", title: "Deployment approval", message });
        const trigger = page.getByRole("button", { name: "Inbox, 2 messages" }); await expect(trigger).toBeVisible();
        await expect(originalRow(page, firstName).getByRole("img", { name: "Input needed" })).toBeVisible(); await openInbox();
        const firstEntry = inbox.locator(`[data-inbox-entry="${first}"]`), secondEntry = inbox.locator(`[data-inbox-entry="${second}"]`);
        await expect(firstEntry.getByText(message, { exact: true })).toBeVisible(); await expect(secondEntry.getByText("Approve the API changes.", { exact: true })).toBeVisible();
        expect(await inbox.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        if (mobile) { await page.setViewportSize({ width: 320, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
        await page.screenshot({ path: info.outputPath(`inbox-${viewport.name}.png`), fullPage: true });
        await firstEntry.getByRole("button", { name: "Open session" }).click(); await expect(page.locator(".xterm-rows").first()).toContainText(marker, { timeout: 30_000 });
        await workspace(); await expect(trigger).toBeVisible(); await openInbox(); await expect(firstEntry.getByText(message, { exact: true })).toBeVisible(); await closeInbox();
        await page.goto("about:blank"); await postHook(first, "UserPromptSubmit"); await page.goto("/dashboard"); await waitForBridgeOnline(page); await workspace();
        await expect(page.getByRole("button", { name: "Inbox, 1 message" })).toBeVisible();
        await originalRow(page, secondName).getByRole("button", { name: "Session actions", exact: true }).click();
        await page.getByRole("menu", { name: "Session actions" }).getByRole("menuitem", { name: "Hide", exact: true }).click();
        await expect(page.getByRole("button", { name: "Inbox, 0 messages" })).toBeVisible();
        await page.getByRole("button", { name: /Hidden \(1\)/ }).click(); await page.locator("#dashboard-sidebar").getByRole("button", { name: new RegExp(secondName) }).click({ button: "right" });
        await page.getByRole("menu", { name: "Session actions" }).getByRole("menuitem", { name: "Unhide", exact: true }).click();
        await expect(page.getByRole("button", { name: "Inbox, 1 message" })).toBeVisible(); await postHook(second, "UserPromptSubmit");
        await expect(page.getByRole("button", { name: "Inbox, 0 messages" })).toBeVisible(); await page.reload(); await waitForBridgeOnline(page); await workspace();
        await expect(originalRow(page, firstName)).toBeVisible(); await expect(originalRow(page, secondName)).toBeVisible(); await expect(page.getByRole("button", { name: "Inbox, 0 messages" })).toBeVisible();
      } finally { for (const id of ids.reverse()) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined); }
    });
  });
}
