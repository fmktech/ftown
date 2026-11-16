import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login } from "../helpers/app";
import { bridgeApiFetch, tryReadBridgePointer } from "../helpers/bridge-api";
import { appendOperation, serverLedger } from "../helpers/ledger-admin";
import { startIsolatedBridge, type IsolatedBridge } from "../helpers/ledger-bridge";
import { approvePairLink } from "../helpers/passkey";

interface SessionRow { id: string; name: string; account?: string; status: string }

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`dashboard creates a non-default harness account session (${viewport.name})`, async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    let bridge: IsolatedBridge | null = null;
    let bridgeId: string | null = null;
    const accountDiagnostics: string[] = [];
    page.on("console", message => {
      const text = message.text();
      if (/^\[get_accounts\] (?:response:[a-z0-9_]{1,64}|send:(?:timeout|rejected))$/.test(text)) accountDiagnostics.push(text);
    });
    try {
      bridge = await startIsolatedBridge();
      const prompt = await bridge.pairing();
      bridgeId = bridge.bridgeIdFile();
      expect(bridgeId).toBeTruthy();
      const accountDir = join(bridge.home, "coding-account");
      const fakeBin = join(bridge.home, "fake-bin");
      const receipt = join(bridge.home, "account-receipt");
      await mkdir(accountDir);
      await mkdir(fakeBin);
      await writeFile(join(fakeBin, "codex"), '#!/bin/sh\nprintf "%s" "$CODEX_HOME" > "$ACCOUNT_TEST_RECEIPT"\nprintf "Account fixture ready\\n"\nwhile :; do sleep 30; done\n', { mode: 0o755 });
      await writeFile(join(bridge.home, ".ftown", "accounts.json"), JSON.stringify({ version: 1, accounts: [{ id: "coding", harness: "codex", label: "Coding subscription", configDir: accountDir }] }), { mode: 0o600 });
      await login(page);
      await approvePairLink(page, prompt.link, prompt.code);
      await expect.poll(() => tryReadBridgePointer(bridge!.home)?.bridgeId, { timeout: 30_000 }).toBe(bridgeId);
      await page.goto("/dashboard");
      if (viewport.name === "mobile") await page.getByRole("tab", { name: "Workspace", exact: true }).click();
      await expect(page.locator(`[data-bridge-row="${bridgeId}"]`).first()).toBeVisible({ timeout: 30_000 });
      const env = { PATH: `${fakeBin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`, ACCOUNT_TEST_RECEIPT: receipt };
      await page.evaluate(vars => localStorage.setItem("ftown:envVars", JSON.stringify(vars)), env);
      await page.getByRole("button", { name: "Create a new session", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "New Session", exact: true });
      await modal.getByLabel("Shell Type", { exact: true }).selectOption("codex");
      await modal.locator("#ns-bridge").selectOption(bridgeId!);
      const picker = modal.getByLabel("Account", { exact: true });
      await expect(picker).toBeEnabled();
      await expect(picker.locator("option")).toHaveText(["Default account", "Coding subscription (coding)"]);
      await picker.selectOption("coding");
      const name = `Account session ${viewport.name}`;
      await modal.getByLabel(/Session Name/).fill(name);
      await testInfo.attach(`account-picker-${viewport.name}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      await modal.getByRole("button", { name: "Create Session", exact: true }).click();
      await expect(modal).toBeHidden();
      const workspace = page.getByRole("region", { name: `Session workspace: ${name}`, exact: true });
      await expect(workspace.getByLabel("Account: coding", { exact: true })).toBeVisible();
      await expect.poll(() => readFile(receipt, "utf8").catch(() => ""), { timeout: 20_000 }).toBe(accountDir);
      const listed = await bridgeApiFetch("GET", "/api/sessions", { bridgeHome: bridge.home });
      expect(listed.status).toBe(200);
      const created = (listed.body as { sessions: SessionRow[] }).sessions.find(session => session.name === name);
      expect(created).toMatchObject({ account: "coding", status: "running" });
      await testInfo.attach(`account-header-${viewport.name}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      if (viewport.name === "mobile") await page.getByRole("tab", { name: "Workspace", exact: true }).click();
      const row = page.locator('#dashboard-sidebar button[draggable="true"]').filter({ has: page.getByText(name, { exact: true }) });
      await expect(row.getByLabel("Account: coding", { exact: true })).toBeVisible();
      await testInfo.attach(`account-sidebar-${viewport.name}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } catch (error) {
      await testInfo.attach("account-lookup-diagnostics.txt", { body: accountDiagnostics.join("\n") || "No account lookup failure diagnostic captured.", contentType: "text/plain" });
      if (bridge) await testInfo.attach("account-test-bridge.log", { body: bridge.output(), contentType: "text/plain" });
      throw error;
    } finally {
      await page.evaluate(() => localStorage.removeItem("ftown:envVars")).catch(() => undefined);
      await bridge?.stop();
      if (bridgeId && (await serverLedger()).checkpoint.bridges.some(item => item.bridgeId === bridgeId)) {
        await appendOperation({ type: "revoke_bridge", bridgeId });
      }
    }
  });
}
