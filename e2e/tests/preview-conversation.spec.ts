import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { atomicHtml, createPreviewFixture, previewHtml } from "../helpers/session-preview";
import { makeConversationAgent } from "../helpers/preview-conversation";

async function select(page: Page, name: string) {
 const workspace = page.getByRole("tab", { name: "Workspace", exact: true });
 if (await workspace.isVisible()) await workspace.click();
 await page.locator('#dashboard-sidebar button[draggable="true"]').filter({ has: page.getByText(name, { exact: true }) }).getByText(name, { exact: true }).click();
}
async function openChat(page: Page) {
 await page.getByRole("button", { name: "Expand preview", exact: true }).click();
 await page.getByRole("button", { name: "Open conversation", exact: true }).click();
}
test("real encrypted conversation reaches a supported agent inbox and retains CLI replies", async ({ page }) => {
 test.setTimeout(150_000); await page.setViewportSize({ width: 1440, height: 900 });
 const fixture = await createPreviewFixture(); const suffix = Date.now().toString(36); const name = `Conversation ${suffix}`, other = `Conversation shell ${suffix}`;
 try {
  const file = "conversation.html"; await atomicHtml(join(fixture.directory, file), previewHtml("CONVERSATION", 1));
  const agent = await makeConversationAgent(fixture.directory);
  const session = await fixture.create(name, { shellType: "codex", command: agent.command });
  const shell = await fixture.create(other); await fixture.register(session, file); await fixture.register(shell, file);
  await login(page, sharedEmail()); await waitForBridgeOnline(page); await select(page, name);
  await openChat(page);
  const input = page.getByRole("textbox", { name: "Message the agent" });
  await input.fill("First line\nSecond line"); await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("First line\nSecond line", { exact: true })).toBeVisible();
  await expect.poll(async () => { try { return await readFile(agent.receipt, "utf8"); } catch { return ""; } }, { timeout: 30_000 }).toContain("First line\\nSecond line");
  await expect(page.getByText("Agent reply from the real CLI.\nSecond line.", { exact: true })).toBeVisible({ timeout: 30_000 });
  const id = randomUUID(), text = "idempotent retry";
  const body = { id, text };
  const first = await bridgeApiFetch("POST", `/api/sessions/${session}/preview-chat/send`, { body });
  const second = await bridgeApiFetch("POST", `/api/sessions/${session}/preview-chat/send`, { body });
  expect(first.status).toBe(200); expect(second.status).toBe(200); expect(second.body).toEqual(first.body);
  const denied = await bridgeApiFetch("POST", `/api/sessions/${shell}/preview-chat/send`, { body: { id: randomUUID(), text: "unsupported" } }); expect(denied.status).toBe(409);
  await select(page, other); await openChat(page); await expect(page.getByText("First line\nSecond line", { exact: true })).toHaveCount(0);
  await select(page, name); await openChat(page); await expect(page.getByText("Agent reply from the real CLI.\nSecond line.", { exact: true })).toBeVisible();
  await page.reload(); await waitForBridgeOnline(page); await select(page, name); await openChat(page);
  await expect(page.getByText("Agent reply from the real CLI.\nSecond line.", { exact: true })).toBeVisible();
 } finally { await fixture.cleanup(); }
});
