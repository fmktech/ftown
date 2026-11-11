import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedAccountId, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { BRIDGE_HOME, E2E_DIR } from "../helpers/config";
const execute = promisify(execFile);
for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 320, height: 844 }]) {
  test(`inbox queues a durable reply and dismissal survives reload on ${viewport.name}`, async ({ page }, info) => {
    test.setTimeout(180_000); await page.setViewportSize({ width: viewport.width, height: viewport.height }); await login(page); await waitForBridgeOnline(page);
    const name = `Inbox reply ${Date.now().toString(36)}`; let id = "";
    try {
      const created = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name } }); expect(created.status, JSON.stringify(created.body)).toBe(201);
      id = (created.body as { session: { id: string } }).session.id; expect(id).toBeTruthy();
      const message = `Please review this full request.\n${"LongUnbrokenReference".repeat(25)}`;
      await execute(process.execPath, [join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js"), "sessions", "attention", "--title", "Review requested", "--message", message], { env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: id }, timeout: 30_000 });
      if (viewport.name === "mobile") await page.getByRole("tab", { name: /^Workspace/ }).click();
      const trigger = page.getByRole("button", { name: /^Inbox, \d+ (waiting|messages?)$/ }); await expect(trigger).toBeVisible(); await expect(trigger).toHaveAccessibleName(/^Inbox, [1-9]\d* waiting$/);
      await trigger.click(); const inbox = page.getByRole("region", { name: "Inbox", exact: true }); await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeFocused(); await expect(page.getByRole("dialog", { name: "Inbox" })).toHaveCount(0); const item = inbox.locator(`[data-inbox-entry="${id}"]`);
      await expect(item.getByText("Review requested", { exact: true })).toBeVisible(); await expect(item.locator("p.whitespace-pre-wrap")).toHaveText(message);
      const openSession = item.getByRole("button", { name: "Open session" }); await openSession.focus(); await page.keyboard.press("Enter"); await expect(inbox).toBeHidden();
      await expect(page.getByRole("region", { name: `Session workspace: ${name}` })).toBeFocused();
      if (viewport.name === "mobile") { await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toHaveAttribute("aria-selected", "true"); await page.getByRole("tab", { name: /^Workspace/ }).click(); }
      await trigger.click(); await expect(item).toBeVisible();
      expect(await inbox.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`session-inbox-${viewport.name}.png`), fullPage: true });
      const reply = `Queued browser reply ${Date.now().toString(36)}`; await item.getByLabel(`Reply to ${name}`).fill(reply); await item.getByRole("button", { name: "Send reply" }).click();
      await expect(item.getByRole("status")).toHaveText("Reply queued."); await expect(item).toBeVisible();
      await expect.poll(async () => { const result = await bridgeApiFetch("GET", `/api/sessions/${id}/inbox?peek=1&all=1`); return JSON.stringify(result.body).includes(reply); }).toBe(true);
      const mail = await bridgeApiFetch("GET", `/api/sessions/${id}/inbox?peek=1&all=1`); expect(mail.status).toBe(200);
      const messages = (mail.body as { messages: Array<{ body: string; from: string; fromName?: string }> }).messages;
      expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ body: reply, from: "browser", fromName: "You" })]));
      // After the durable reply the bridge resolves the item; the Inbox page may
      // still show it until a snapshot re-read (shell sessions have no prompt hook),
      // so dismiss explicitly, which also re-reads the snapshot.
      const itemVisibleAfterReply = await item.isVisible().catch(() => false);
      if (itemVisibleAfterReply) { await item.getByRole("button", { name: "Dismiss" }).click(); await expect(item).toHaveCount(0); }
      else { await expect(item).toHaveCount(0); }
      await inbox.getByRole("button", { name: "Back to workspace" }).click(); await expect(trigger).toBeFocused();
      await page.reload(); await waitForBridgeOnline(page); if (viewport.name === "mobile") await page.getByRole("tab", { name: /^Workspace/ }).click();
      await page.getByRole("button", { name: /^Inbox, / }).click(); await expect(page.getByRole("region", { name: "Inbox" }).locator(`[data-inbox-entry="${id}"]`)).toHaveCount(0);
    } finally { if (id) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined); }
  });
}

test("mail nudge survives agent mail, highlights the trigger and pops up on open", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page); await waitForBridgeOnline(page);
  const stamp = Date.now().toString(36);
  const nameA = `A ${stamp}`, nameB = `B ${stamp}`;
  let idA = ""; let idB = "";
  const FTOWN_CLI = join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js");
  const HARNESS_CLI = join(E2E_DIR, "..", "bridge", "dist", "harness-cli.js");
  const row = (name: string) => page.locator('#dashboard-sidebar button[draggable="true"]').filter({ has: page.getByText(name, { exact: true }) });
  try {
    const createdA = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name: nameA } });
    expect(createdA.status, JSON.stringify(createdA.body)).toBe(201);
    idA = (createdA.body as { session: { id: string } }).session.id;
    const createdB = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name: nameB } });
    expect(createdB.status, JSON.stringify(createdB.body)).toBe(201);
    idB = (createdB.body as { session: { id: string } }).session.id;
    // A raises an attention request via the real CLI.
    await execute(process.execPath, [FTOWN_CLI, "sessions", "attention", "--title", "Review A", "--message", `Please review A ${stamp}`], { env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: idA }, timeout: 30_000 });
    // Nothing is selected: the highlighted trigger and the title prefix show up, no popup yet.
    const trigger = page.getByRole("button", { name: "Inbox, 1 waiting" });
    await expect(trigger).toBeVisible();
    await expect.poll(() => page.title()).toMatch(/^\(1\) /);
    // B sends ftown mail to A via the real CLI; the bridge nudges A's terminal.
    await execute(process.execPath, [HARNESS_CLI, "mail", "send", idA, "--type", "message", `Agent mail for A ${stamp}`], { env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: idB }, timeout: 30_000 });
    await expect.poll(async () => {
      const screen = await bridgeApiFetch("GET", `/api/sessions/${idA}/screen?limit=200`);
      return JSON.stringify(screen.body).includes("You have new ftown mail");
    }, { timeout: 30_000 }).toBe(true);
    // A harness that echoes the injected line fires UserPromptSubmit with the nudge text: it must not resolve the item.
    const hook = await bridgeApiFetch("POST", "/hook", { body: { ftown_session_id: idA, ftown_session_source: "env", hook_event_name: "UserPromptSubmit", prompt: "[ftown msg from ftown-mail] You have new ftown mail — run `ftown harness mail read` to read it." } });
    expect(hook.status).toBe(200);
    // The bridge still holds the item unresolved.
    const listed = await bridgeApiFetch("GET", `/api/sessions/${idA}/attention`);
    const events = (listed.body as { events: Array<{ resolvedAt?: string }> }).events;
    const open = events.filter((event) => !event.resolvedAt);
    expect(open).toHaveLength(1);
    const itemId = (open[0] as { id: string }).id;
    // The UI still lists it after the nudge, with the trigger highlighted.
    await expect(trigger).toBeVisible();
    await expect(page.getByRole("region", { name: "Waiting for you" })).toHaveCount(0);
    await trigger.click();
    await expect(page.getByRole("region", { name: "Inbox", exact: true }).locator(`[data-inbox-entry="${idA}"]`)).toBeVisible();
    await page.getByRole("region", { name: "Inbox", exact: true }).getByRole("button", { name: "Back to workspace" }).click();
    // Opening A from the session list shows the popup.
    await expect(row(nameA)).toBeVisible({ timeout: 30_000 });
    await row(nameA).click();
    const popup = page.getByRole("region", { name: "Waiting for you" });
    await expect(popup).toBeVisible();
    await expect(popup.getByText(`Please review A ${stamp}`)).toBeVisible();
    // Replying from the popup resolves exactly that item ('replied') and the popup goes away.
    await popup.getByLabel(`Reply to ${nameA}`).fill(`Popup reply ${stamp}`);
    await popup.getByRole("button", { name: "Send reply" }).click();
    await expect.poll(async () => {
      const after = await bridgeApiFetch("GET", `/api/sessions/${idA}/attention/${itemId}`);
      const event = (after.body as { event?: { resolvedAt?: string; resolution?: string } }).event;
      return event?.resolvedAt ? event.resolution : "open";
    }, { timeout: 30_000 }).toBe("replied");
    await expect(popup).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Inbox, 0 messages" })).toBeVisible();
    await expect.poll(() => page.title()).not.toMatch(/^\(\d+\) /);
  } finally {
    if (idA) await bridgeApiFetch("DELETE", `/api/sessions/${idA}`).catch(() => undefined);
    if (idB) await bridgeApiFetch("DELETE", `/api/sessions/${idB}`).catch(() => undefined);
  }
});
