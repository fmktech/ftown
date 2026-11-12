import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedAccountId, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { BRIDGE_HOME, E2E_DIR } from "../helpers/config";
import { createPreviewFixture, previewSimpleHtml } from "../helpers/session-preview";
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
      if (viewport.name === "mobile") await page.getByRole("tab", { name: "Workspace", exact: true }).click();
      const trigger = page.getByRole("button", { name: /^Inbox, \d+ (waiting|messages?)$/ }); await expect(trigger).toBeVisible(); await expect(trigger).toHaveAccessibleName(/^Inbox, [1-9]\d* waiting$/);
      await trigger.click(); const inbox = page.getByRole("region", { name: "Inbox", exact: true }); await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeFocused(); await expect(page.getByRole("dialog", { name: "Inbox" })).toHaveCount(0); const item = inbox.locator(`[data-inbox-entry="${id}"]`);
      await expect(item.getByText("Review requested", { exact: true })).toBeVisible(); await expect(item.locator("p.whitespace-pre-wrap")).toHaveText(message);
      const openSession = item.getByRole("button", { name: "Open session" }); await openSession.focus(); await page.keyboard.press("Enter"); await expect(inbox).toBeHidden();
      await expect(page.getByRole("region", { name: `Session workspace: ${name}` })).toBeFocused();
      if (viewport.name === "mobile") { await expect(page.getByRole("tab", { name: "Waiting (1)" })).toHaveAttribute("aria-selected", "true"); await page.getByRole("tab", { name: "Workspace", exact: true }).click(); }
      await trigger.click(); await expect(item).toBeVisible();
      expect(await inbox.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`session-inbox-${viewport.name}.png`), fullPage: true });
      const reply = `Queued browser reply ${Date.now().toString(36)}`; await item.getByLabel(`Reply to ${name}`).fill(reply); await item.getByRole("button", { name: "Send reply" }).click();
      await expect.poll(async () => { const result = await bridgeApiFetch("GET", `/api/sessions/${id}/inbox?peek=1&all=1`); return JSON.stringify(result.body).includes(reply); }).toBe(true);
      const mail = await bridgeApiFetch("GET", `/api/sessions/${id}/inbox?peek=1&all=1`); expect(mail.status).toBe(200);
      const messages = (mail.body as { messages: Array<{ body: string; from: string; fromName?: string }> }).messages;
      expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ body: reply, from: "browser", fromName: "You" })]));
      // The successful reply re-reads the snapshot, so the item drops without Dismiss.
      await expect(item).toHaveCount(0);
      await inbox.getByRole("button", { name: "Back to workspace" }).click(); await expect(trigger).toBeFocused();
      await page.reload(); await waitForBridgeOnline(page); if (viewport.name === "mobile") await page.getByRole("tab", { name: "Workspace", exact: true }).click();
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
    // Opening A from the session list shows the waiting pane (no floating popup).
    await expect(row(nameA)).toBeVisible({ timeout: 30_000 });
    await row(nameA).click();
    const pane = page.getByRole("region", { name: "Waiting for you" });
    await expect(pane).toBeVisible();
    await expect(pane.getByText(`Please review A ${stamp}`)).toBeVisible();
    // Replying from the pane resolves exactly that item ('replied') and the pane goes away.
    await pane.getByLabel(`Reply to ${nameA}`).fill(`Pane reply ${stamp}`);
    await pane.getByRole("button", { name: "Send reply" }).click();
    await expect.poll(async () => {
      const after = await bridgeApiFetch("GET", `/api/sessions/${idA}/attention/${itemId}`);
      const event = (after.body as { event?: { resolvedAt?: string; resolution?: string } }).event;
      return event?.resolvedAt ? event.resolution : "open";
    }, { timeout: 30_000 }).toBe("replied");
    await expect(pane).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Inbox, 0 messages" })).toBeVisible();
    await expect.poll(() => page.title()).not.toMatch(/^\(\d+\) /);
  } finally {
    if (idA) await bridgeApiFetch("DELETE", `/api/sessions/${idA}`).catch(() => undefined);
    if (idB) await bridgeApiFetch("DELETE", `/api/sessions/${idB}`).catch(() => undefined);
  }
});

test("replying to one of two open items clears exactly that one", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page); await waitForBridgeOnline(page);
  const stamp = Date.now().toString(36);
  const name = `Two items ${stamp}`; let id = "";
  const FTOWN_CLI = join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js");
  try {
    const created = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    id = (created.body as { session: { id: string } }).session.id;
    const msg1 = `First ${stamp}`, msg2 = `Second ${stamp}`;
    await execute(process.execPath, [FTOWN_CLI, "sessions", "attention", "--title", "First", "--message", msg1], { env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: id }, timeout: 30_000 });
    await execute(process.execPath, [FTOWN_CLI, "sessions", "attention", "--title", "Second", "--message", msg2], { env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: id }, timeout: 30_000 });
    const listed = await bridgeApiFetch("GET", `/api/sessions/${id}/attention`);
    const events = (listed.body as { events: Array<{ id: string; title: string; resolvedAt?: string }> }).events;
    expect(events.filter((event) => !event.resolvedAt)).toHaveLength(2);
    const first = events.find((event) => event.title === "First")!;
    const second = events.find((event) => event.title === "Second")!;
    // The dashboard holds ONE entry per session (latest explicit), so the
    // trigger counts sessions, not bridge events: 2 events still say 1 waiting,
    // and the entry shows the newest (Second).
    const trigger = page.getByRole("button", { name: "Inbox, 1 waiting" });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    const article = inbox.locator(`[data-inbox-entry="${id}"]`);
    await expect(article).toHaveCount(1);
    await expect(article.getByText(msg2, { exact: true })).toBeVisible();
    await expect(article.getByText(msg1, { exact: true })).toHaveCount(0);
    await article.getByLabel(`Reply to ${name}`).fill(`Answer to newest ${stamp}`);
    await article.getByRole("button", { name: "Send reply" }).click();
    await expect.poll(async () => {
      const after = await bridgeApiFetch("GET", `/api/sessions/${id}/attention/${second.id}`);
      const event = (after.body as { event?: { resolvedAt?: string; resolution?: string } }).event;
      return event?.resolvedAt ? event.resolution : "open";
    }, { timeout: 30_000 }).toBe("replied");
    const stillOpen = await bridgeApiFetch("GET", `/api/sessions/${id}/attention/${first.id}`);
    const firstEvent = (stillOpen.body as { event?: { resolvedAt?: string } }).event!;
    expect(firstEvent.resolvedAt).toBeFalsy();
    // The entry stays, now showing the remaining (older) item; trigger stays 1.
    await expect(article).toHaveCount(1);
    await expect(article.getByText(msg1, { exact: true })).toBeVisible();
    await expect(article.getByText(msg2, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Inbox, 1 waiting" })).toBeVisible();
  } finally { if (id) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined); }
});

test("a second page sees reply and dismiss without reload", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.setViewportSize({ width: 1280, height: 900 });
  let id = "";
  const FTOWN_CLI = join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js");
  try {
    await login(page); await waitForBridgeOnline(page);
    await login(page2); await waitForBridgeOnline(page2);
    const stamp = Date.now().toString(36);
    const name = `Cross tab ${stamp}`;
    const created = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    id = (created.body as { session: { id: string } }).session.id;
    const msg1 = `First ${stamp}`;
    await execute(process.execPath, [FTOWN_CLI, "sessions", "attention", "--title", "First", "--message", msg1], { env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: id }, timeout: 30_000 });
    const trigger2 = page2.getByRole("button", { name: "Inbox, 1 waiting" });
    await expect(trigger2).toBeVisible();
    await trigger2.click();
    const inbox2 = page2.getByRole("region", { name: "Inbox", exact: true });
    const item2 = inbox2.locator(`[data-inbox-entry="${id}"]`);
    await expect(item2).toBeVisible();
    // Reply from page 1; page 2 drops the item without page2.reload().
    await page.getByRole("button", { name: "Inbox, 1 waiting" }).click();
    const inbox1 = page.getByRole("region", { name: "Inbox", exact: true });
    const item1 = inbox1.locator(`[data-inbox-entry="${id}"]`);
    await expect(item1).toBeVisible();
    await item1.getByLabel(`Reply to ${name}`).fill(`Cross tab reply ${stamp}`);
    await item1.getByRole("button", { name: "Send reply" }).click();
    await expect.poll(() => pollAttentionOpen(id), { timeout: 30_000 }).toBe(false);
    await expect(item2).toHaveCount(0, { timeout: 30_000 });
    await expect(page2.getByRole("button", { name: "Inbox, 0 messages" })).toBeVisible({ timeout: 30_000 });
    // Dismiss from page 1; page 2 drops the new item without reload.
    await page1DismissSecond(page, id, `Second ${stamp}`, FTOWN_CLI);
    const trigger2Again = page2.getByRole("button", { name: "Inbox, 1 waiting" });
    await expect(trigger2Again).toBeVisible({ timeout: 30_000 });
    await trigger2Again.click();
    const item2Again = inbox2.locator(`[data-inbox-entry="${id}"]`);
    await expect(item2Again).toBeVisible({ timeout: 30_000 });
    await page1DismissCurrent(page, id);
    await expect(item2Again).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await ctx2.close().catch(() => undefined);
    if (id) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined);
  }
});

async function pollAttentionOpen(sessionId: string): Promise<boolean> {
  const listed = await bridgeApiFetch("GET", `/api/sessions/${sessionId}/attention`);
  const events = (listed.body as { events: Array<{ resolvedAt?: string }> }).events ?? [];
  return events.some((event) => !event.resolvedAt);
}
async function page1DismissSecond(page: Page, id: string, message: string, FTOWN_CLI: string): Promise<void> {
  await execute(process.execPath, [FTOWN_CLI, "sessions", "attention", "--title", "Second", "--message", message], { env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: id }, timeout: 30_000 });
  await page.getByRole("button", { name: "Inbox, 1 waiting" }).click();
  await expect(page.getByRole("region", { name: "Inbox", exact: true }).locator(`[data-inbox-entry="${id}"]`)).toBeVisible({ timeout: 30_000 });
}
async function page1DismissCurrent(page: Page, id: string): Promise<void> {
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const item = inbox.locator(`[data-inbox-entry="${id}"]`);
  await item.getByRole("button", { name: "Dismiss" }).click();
}

test("waiting pane keeps terminal focus when selecting and typing", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page); await waitForBridgeOnline(page);
  const stamp = Date.now().toString(36);
  const name = `Focus ${stamp}`;
  let id = "";
  const FTOWN_CLI = join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js");
  const row = (n: string) => page.locator('#dashboard-sidebar button[draggable="true"]').filter({ has: page.getByText(n, { exact: true }) });
  try {
    const created = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    id = (created.body as { session: { id: string } }).session.id;
    await expect(row(name)).toBeVisible({ timeout: 30_000 });
    await row(name).click();
    await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 30_000 });
    await page.locator(".xterm").first().click();
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? "")).toContain("xterm-helper-textarea");
    // The pane appears only after the real CLI raises the item; focus must stay in the terminal.
    await execute(process.execPath, [FTOWN_CLI, "sessions", "attention", "--title", "Focus", "--message", `Please review ${stamp}`], { env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: id }, timeout: 30_000 });
    const popup = page.getByRole("region", { name: "Waiting for you" });
    await expect(popup).toBeVisible({ timeout: 30_000 });
    await expect(popup.getByText(`Please review ${stamp}`)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? "")).toContain("xterm-helper-textarea");
  } finally { if (id) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined); }
});

test("mobile Workspace tab keeps its name with a waiting description", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 320, height: 844 });
  await login(page); await waitForBridgeOnline(page);
  const stamp = Date.now().toString(36);
  const name = `Mobile tab ${stamp}`;
  let id = "";
  const FTOWN_CLI = join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js");
  try {
    const created = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    id = (created.body as { session: { id: string } }).session.id;
    await execute(process.execPath, [FTOWN_CLI, "sessions", "attention", "--title", "Mobile", "--message", `Please review ${stamp}`], { env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: id }, timeout: 30_000 });
    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    const workspaceTab = page.getByRole("tab", { name: "Workspace", exact: true });
    await expect(workspaceTab).toBeVisible();
    const describedby = await workspaceTab.getAttribute("aria-describedby");
    expect(describedby).toBe("mobile-tab-inbox-waiting");
    await expect(page.locator("#mobile-tab-inbox-waiting")).toHaveText("1 waiting");
    expect(await workspaceTab.locator(".mobile-tab-inbox-badge").textContent()).toBe("1");
  } finally { if (id) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined); }
});

test("preview showing switches to the waiting item, file back, reply returns to file", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = await createPreviewFixture();
  let id = "";
  try {
    await login(page); await waitForBridgeOnline(page);
    const stamp = Date.now().toString(36);
    const name = `Pane ${stamp}`;
    await writeFile(join(fixture.directory, "a.html"), previewSimpleHtml(`Pane ${stamp}`, 1), "utf8");
    id = await fixture.create(name);
    await fixture.register(id, "a.html");
    const row = page.locator('#dashboard-sidebar button[draggable="true"]').filter({ has: page.getByText(name, { exact: true }) });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    const iframe = page.frameLocator('iframe[title="Preview: a.html"]');
    await expect(iframe.locator(`text=Pane ${stamp}`).first()).toBeVisible({ timeout: 30_000 });
    // Item arrives while the file is showing: the pane switches to the item.
    await execute(process.execPath, [join(E2E_DIR, "..", "bridge/dist/ftown-cli.js"), "sessions", "attention", "--title", "Pane ask", "--message", `Please review ${stamp}`], { env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: id }, timeout: 30_000 });
    const pane = page.getByRole("region", { name: "Waiting for you" });
    await expect(pane).toBeVisible({ timeout: 30_000 });
    await expect(pane.getByText(`Please review ${stamp}`)).toBeVisible();
    // Choosing the file tab brings the file back with the item still in the Inbox.
    const list = page.getByRole("tablist", { name: "Side pane view" });
    await list.getByRole("tab", { name: "a.html" }).click();
    await expect(iframe.locator(`text=Pane ${stamp}`).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Inbox, 1 waiting" }).click();
    await expect(page.getByRole("region", { name: "Inbox", exact: true }).locator(`[data-inbox-entry="${id}"]`)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("region", { name: "Inbox", exact: true }).getByRole("button", { name: "Back to workspace" }).click();
    // Back on the waiting view, reply returns the pane to the file.
    await pane.getByRole("tab", { name: "Waiting (1)" }).click().catch(() => undefined);
    const waitTab = page.getByRole("tab", { name: "Waiting for you" });
    await waitTab.click().catch(() => undefined);
    await expect(pane).toBeVisible({ timeout: 30_000 });
    await pane.getByLabel(`Reply to ${name}`).fill(`Pane reply ${stamp}`);
    await pane.getByRole("button", { name: "Send reply" }).click();
    await expect.poll(async () => {
      const listed = await bridgeApiFetch("GET", `/api/sessions/${id}/attention`);
      const events = (listed.body as { events: Array<{ resolvedAt?: string; resolution?: string }> }).events;
      return events.some((event) => event.resolvedAt && event.resolution === "replied");
    }, { timeout: 30_000 }).toBe(true);
    await expect(pane).toHaveCount(0);
    await expect(iframe.locator(`text=Pane ${stamp}`).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await fixture.cleanup().catch(() => undefined);
    void id;
  }
});
