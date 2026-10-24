import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { createShellSession, login, openSession, runMarkerInTerminal, sharedEmail, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { sessionIdsFor, waitForNewSessionId } from "../helpers/centrifugo";

const removed = {
  code: "automation_removed",
  error: "Recurring loops and factory automation have been removed",
};

test("retired loop HTTP routes reject authenticated callers after the existing auth guard", async () => {
  for (const path of ["/api/loops", "/api/loops/legacy", "/api/loops/legacy/run-now", "/api/loops/legacy/runs"]) {
    const unauthenticated = await bridgeApiFetch("GET", path, { bearer: null });
    expect(unauthenticated.status, `auth must run before retirement for ${path}`).toBe(401);
    for (const method of ["GET", "POST", "PATCH", "DELETE", "PUT"]) {
      const response = await bridgeApiFetch(method, path, { body: { enabled: true, task: "must not execute" } });
      expect(response.status, `${method} ${path}`).toBe(410);
      expect(response.body).toEqual(removed);
    }
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
      await page.getByRole("button", { name: "Workspace", exact: true }).click();
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

test("landing page presents MCP fleet control and attention with current setup guidance", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your fleet, in your MCP client." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Keep questions in view" })).toBeVisible();
  await expect(page.getByText("https://ftown-mcp.fly.dev/mcp", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "MCP setup & capabilities" })).toHaveAttribute("href", "https://github.com/fmktech/ftown/blob/main/docs/mcp.md");
  await expect(page.locator("body")).not.toContainText(/Scheduled loops|Cron for agents|Per-loop controls/);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /MCP fleet control/);
  await page.screenshot({ path: testInfo.outputPath("landing-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Your fleet, in your MCP client." })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("landing-mobile.png"), fullPage: true });
});
