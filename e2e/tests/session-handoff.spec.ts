import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";

function originalRow(page: Page, name: string) {
  return page.locator('#dashboard-sidebar button[draggable="true"]').filter({ has: page.getByText(name, { exact: true }) });
}

interface SessionRow {
  id: string;
  name?: string;
  status?: string;
  block?: { reason?: string; resetAt?: string };
}

async function createSession(body: Record<string, unknown>): Promise<string> {
  const response = await bridgeApiFetch("POST", "/api/sessions", { body });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const id = (response.body as { session: { id: string } }).session.id;
  expect(id).toBeTruthy();
  return id;
}

async function listed(): Promise<SessionRow[]> {
  const response = await bridgeApiFetch("GET", "/api/sessions");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body as { sessions: SessionRow[] }).sessions;
}

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test.describe(`${viewport.name} blocked session handoff`, () => {
    test.use({ hasTouch: viewport.name === "mobile" });
    test(`shows the blocked badge and hands the session off on ${viewport.name}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await login(page);
      await waitForBridgeOnline(page);
      const mobile = viewport.name === "mobile";
      const suffix = Date.now().toString(36);
      const parentName = `Handoff parent ${suffix}`;
      const childName = `Handoff child ${suffix}`;
      const dir = mkdtempSync(join(tmpdir(), "ftown-handoff-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      const ids = new Set<string>();
      try {
        const parentId = await createSession({
          shellType: "shell",
          name: parentName,
          prompt: "coordinate the handoff",
          workingDir: dir,
          command: "sleep 180",
        });
        ids.add(parentId);
        const childId = await createSession({
          shellType: "muse",
          name: childName,
          prompt: "original task",
          parentSessionId: parentId,
          workingDir: dir,
          command: "printf 'Usage limit reached\\nresets at 9:00 PM\\n'; sleep 180",
        });
        ids.add(childId);
        await expect.poll(async () => {
          const child = (await listed()).find(session => session.id === childId);
          return child?.block?.reason ?? child?.status ?? "missing";
        }, { timeout: 30_000 }).toBe("usage_limit");
        await expect.poll(async () => {
          const mail = await bridgeApiFetch("GET", `/api/sessions/${parentId}/inbox?peek=1&all=1`);
          const messages = (mail.body as { messages?: Array<{ type?: string; from?: string; body?: string }> }).messages ?? [];
          return messages.some(message => message.type === "escalation" && message.from === childId && message.body?.includes("usage_limit"));
        }, { timeout: 15_000 }).toBe(true);

        if (mobile) await page.getByRole("tab", { name: "Workspace", exact: true }).click();
        const childRow = originalRow(page, childName);
        await expect(childRow).toBeVisible({ timeout: 30_000 });
        await expect(childRow.getByLabel("Blocked: usage limit")).toBeVisible();
        await originalRow(page, parentName).click();
        if (mobile) await page.getByRole("tab", { name: "Overview", exact: true }).click();
        const overview = page.getByRole("region", { name: `Overview: ${parentName}` });
        await expect(overview).toBeVisible();
        const needs = overview.getByRole("region", { name: "Needs attention" });
        await expect(needs.getByLabel("Blocked: usage limit")).toBeVisible();
        await needs.getByRole("button", { name: `Hand off ${childName}` }).click();
        const dialog = page.getByRole("dialog", { name: "Hand off session" });
        await expect(dialog).toBeVisible();
        await dialog.getByLabel("Harness").selectOption("shell");
        await dialog.getByRole("button", { name: "Hand off", exact: true }).click();
        const nextName = `${childName} handoff`;
        // Hand off opens the new session. On a phone that leaves the Workspace
        // list, so the sidebar row stays mounted and hidden until that tab is shown.
        await expect(page.getByRole("region", { name: `Session workspace: ${nextName}` })).toBeVisible({ timeout: 60_000 });
        if (mobile) await page.getByRole("tab", { name: "Workspace", exact: true }).click();
        await expect(originalRow(page, nextName)).toBeVisible();
        await expect(originalRow(page, childName)).toHaveCount(0);
        const created = (await listed()).find(session => session.name === nextName);
        expect(created?.id).toBeTruthy();
        if (created) ids.add(created.id);
      } finally {
        const live = await listed().catch(() => []);
        for (const session of live) {
          if (session.name?.includes(suffix)) ids.add(session.id);
        }
        for (const id of ids) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
