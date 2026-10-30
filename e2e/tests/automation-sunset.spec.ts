import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { createShellSession, login, openSession, runMarkerInTerminal, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { sessionIdsFor, waitForNewSessionId } from "../helpers/centrifugo";

const removed = {
  code: "automation_removed",
  error: "Recurring loops and factory automation have been removed",
};

test("retired loop HTTP routes require encryption and return retirement to authenticated callers", async () => {
  for (const path of ["/api/loops", "/api/loops/legacy", "/api/loops/legacy/run-now", "/api/loops/legacy/runs"]) {
    const unauthenticated = await bridgeApiFetch("GET", path, { bearer: null });
    expect(unauthenticated.status, `plaintext must require an upgrade for ${path}`).toBe(426);
    expect(unauthenticated.body).toEqual({ error: "upgrade_required", code: "upgrade_required" });
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const response = await bridgeApiFetch(method, path, { body: { enabled: true, task: "must not execute" } });
      expect(response.status, `${method} ${path}`).toBe(410);
      expect(response.body).toEqual(removed);
    }
    const unsupported = await bridgeApiFetch("PUT", path, { body: { enabled: true, task: "must not execute" } });
    expect(unsupported.status, `unsupported PUT ${path} must fail closed`).toBe(403);
    expect(unsupported.body).toEqual({ error: "permission_denied", code: "permission_denied", outcomeUnknown: false });
  }
  expect((await bridgeApiFetch("GET", "/api/sessions")).status).toBe(200);
});

for (const storedTab of ["crons", "factory"]) {
  test(`legacy ${storedTab} sidebar state opens ordinary sessions on desktop and mobile`, async ({ page }, testInfo) => {
    const sentFrames: string[] = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      sentFrames.push(typeof payload === "string" ? payload : payload.toString());
    }));
    await page.addInitScript((tab) => localStorage.setItem("ftown:sidebarTab", tab), storedTab);
    await login(page, sharedEmail());
    await waitForBridgeOnline(page);

    const name = `sunset-session-${storedTab}-${Date.now()}`;
    const before = await sessionIdsFor(sharedEmail());
    let sessionId: string | undefined;
    try {
      await expect(page.getByRole("tablist", { name: "Sidebar sections" })).toHaveCount(0);
      await expect(page.getByTitle("Create a new loop")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /New Factory|Create Factory/ })).toHaveCount(0);
      await createShellSession(page, name);
      sessionId = await waitForNewSessionId(sharedEmail(), before);
      await openSession(page, name);
      await runMarkerInTerminal(page, `SUNSET${Date.now()}`);
      await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("tab", { name: "Workspace", exact: true }).click();
      await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
      await expect(page.getByTitle("Create a new loop")).toHaveCount(0);
      await expect(page.getByRole("tablist", { name: "Sidebar sections" })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
      await openSession(page, name);
      await expect(page.locator(".xterm").first()).toBeVisible();

      expect(sentFrames.join("\n")).not.toMatch(/loops:updates|"(?:create_loop|list_loops|update_loop|delete_loop|run_loop_now|get_loop_runs)"/);
      expect(await page.evaluate(() => localStorage.getItem("ftown:sidebarTab"))).toBe(storedTab);
    } finally {
      if (sessionId) await bridgeApiFetch("DELETE", `/api/sessions/${sessionId}`);
    }
  });
}
