import { test, expect } from "@playwright/test";
import { createShellSession, login, runMarkerInTerminal, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";

interface SessionRow { id: string; name: string; status: string }

for (const mobile of [false, true]) {
  test(`successful + creation opens its terminal immediately (${mobile ? "mobile" : "desktop"})`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const prefix = `navigate-${mobile ? "mobile" : "desktop"}-${Date.now()}`;
    const priorName = `${prefix}-existing`;
    const createdName = `${prefix}-created`;
    const owned = new Set<string>();
    async function rows(): Promise<SessionRow[]> {
      const result = await bridgeApiFetch("GET", "/api/sessions");
      expect(result.status).toBe(200);
      return (result.body as { sessions: SessionRow[] }).sessions;
    }
    try {
      const prior = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name: priorName } });
      expect(prior.status).toBe(201);
      const priorId = (prior.body as { session: SessionRow }).session.id;
      owned.add(priorId);
      await login(page, sharedEmail());
      await waitForBridgeOnline(page);
      await page.getByRole("button", { name: new RegExp(priorName) }).click();
      await expect(page.locator("main").getByText(priorName, { exact: true })).toBeVisible();
      if (mobile) await page.getByRole("button", { name: "Workspace", exact: true }).click();
      const pagesBefore = page.context().pages();
      const urlBefore = page.url();
      await createShellSession(page, createdName);
      await expect(page.getByText("New Session", { exact: true })).toBeHidden();
      // Deliberately never open/click the newly created sidebar row.
      await expect(page.locator("main").getByText(createdName, { exact: true })).toBeVisible();
      await expect(page.locator("main .xterm")).toBeVisible();
      if (mobile) await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveClass(/mobile-tab-active/);
      await runMarkerInTerminal(page, `AUTOSELECT${Date.now()}`);
      const inventory = await rows();
      const created = inventory.find(session => session.name === createdName);
      expect(created?.id).toBeTruthy();
      owned.add(created!.id);
      expect(created!.id).not.toBe(priorId);
      expect(inventory.find(session => session.id === priorId)?.status).toBe("running");
      expect(page.context().pages()).toEqual(pagesBefore);
      expect(page.url()).toBe(urlBefore);
      await testInfo.attach(`automatically-opened-${mobile ? "mobile" : "desktop"}`, {
        body: await page.screenshot({ fullPage: true }), contentType: "image/png",
      });
    } finally {
      // Also find a created row if a preceding UI assertion failed before its ID was read.
      for (const session of await rows().catch(() => [])) if (session.name === priorName || session.name === createdName) owned.add(session.id);
      for (const id of owned) await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined);
    }
  });
}
