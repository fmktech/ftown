import { expect, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "../helpers/fixtures";
import {
  sharedAccountId,
  login,
  waitForBridgeOnline,
  createShellSession,
  openSession,
  runMarkerInTerminal,
} from "../helpers/app";
import { sessionIdsFor, waitForNewSessionId } from "../helpers/centrifugo";
import { bridgeApiFetch, readBridgePointer } from "../helpers/bridge-api";
import { restartBridge } from "../helpers/bridge-process";
import { BRIDGE_HOME, seedClaudeTranscript } from "../helpers/bridge-fixtures";

/**
 * Session lifecycle e2e: the refactored launch/lifecycle paths
 * (createFtownSession / relaunchFtownSession / session-controller / terminal-pump)
 * that had ZERO coverage beyond fresh-create.
 *
 * Harness is SHELL ONLY (New Session modal → shellType "shell" = plain zsh), so
 * there is no claude binary, no API key and no LLM cost — the terminal-marker
 * round-trip (xterm has no local echo, so any echoed marker proves a live PTY over
 * a working bidirectional data plane) is the data-plane proof, exactly as in
 * direct-transport.spec.ts.
 *
 * Two authoritative signals are used:
 *  - The bridge loopback HTTP API via bridgeApiFetch("GET","/api/sessions/:id") →
 *    { session: { status } } (200) or { error } (404). status ∈
 *    'pending'|'running'|'completed'|'error' (bridge/src/types.ts). A stopped
 *    session becomes 'completed'; a dead/failed one 'error'. The encrypted CLI
 *    client re-reads bridge discovery on every call, so it survives a restart.
 *  - The session-list UI badge text: running→"running"/"idle", completed→"done".
 */

interface SessionEnvelope {
  session?: { id?: string; status?: string; parentSessionId?: string };
  error?: string;
}

/** Poll the bridge API for a session's reported status (or `http:<code>` on non-200). */
async function statusOf(sid: string): Promise<string | undefined> {
  const res = await bridgeApiFetch("GET", `/api/sessions/${sid}`);
  const body = res.body as SessionEnvelope;
  return body.session?.status ?? `http:${res.status}`;
}

async function createGroupedSession(name: string, parentSessionId?: string): Promise<string> {
  const res = await bridgeApiFetch("POST", "/api/sessions", {
    body: { projectName: "E2E", shellType: "shell", name, parentSessionId },
  });
  expect(res.status, `create grouped session: ${JSON.stringify(res.body)}`).toBe(201);
  const id = (res.body as SessionEnvelope).session?.id;
  expect(id).toBeTruthy();
  return id!;
}

async function parentOf(sid: string): Promise<string | null> {
  const res = await bridgeApiFetch("GET", `/api/sessions/${sid}`);
  expect(res.status).toBe(200);
  return (res.body as SessionEnvelope).session?.parentSessionId ?? null;
}

async function removeSessionQuietly(sid: string): Promise<void> {
  await bridgeApiFetch("DELETE", `/api/sessions/${sid}`).catch(() => undefined);
}

async function checkTerminalHeaderGeometry(page: Page, testInfo: TestInfo, action: "Stop" | "Rerun", dense = false) {
  for (const width of [1280, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const header = page.getByTestId("terminal-header");
    const content = page.getByTestId("terminal-header-content");
    const button = header.getByRole("button", { name: action, exact: true });
    await expect(header).toBeVisible();
    await expect(button).toBeVisible();
    await expect(button).toHaveCSS("min-height", width < 768 ? "44px" : "32px");
    const headerBox = await header.boundingBox();
    const contentBox = await content.boundingBox();
    const buttonBox = await button.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    const paddingRight = await header.evaluate((element) => parseFloat(getComputedStyle(element).paddingRight));
    expect(Math.abs(headerBox!.x + headerBox!.width - paddingRight - (buttonBox!.x + buttonBox!.width))).toBeLessThanOrEqual(1);
    expect(contentBox!.x + contentBox!.width).toBeLessThanOrEqual(buttonBox!.x);
    expect(buttonBox!.x).toBeGreaterThanOrEqual(0);
    expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(width);
    if (width < 768) expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (dense) {
      const usage = header.getByText("1.2M in · 456.8K out · sonnet-4-5-20250929", { exact: true });
      const metadata = action === "Stop" ? [usage, header.getByText("running", { exact: true })] : [usage];
      for (const node of metadata) {
        await expect(node).toBeVisible();
        const box = await node.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(headerBox!.x);
        expect(box!.x + box!.width).toBeLessThanOrEqual(buttonBox!.x);
        expect(box!.y).toBeGreaterThanOrEqual(headerBox!.y);
        expect(box!.y + box!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height);
        expect(await node.evaluate((element) => {
          const actionButton = element.closest('[data-testid="terminal-header"]')
            ?.querySelector('[role="group"][aria-label="Selected session actions"] button');
          return !!actionButton && !!(element.compareDocumentPosition(actionButton) & Node.DOCUMENT_POSITION_FOLLOWING);
        })).toBe(true);
      }
    }
    await testInfo.attach(`terminal-header-${action.toLowerCase()}-${width}`, {
      body: await header.screenshot(),
      contentType: "image/png",
    });
  }
}

test.describe("session lifecycle", () => {
  test("dense session header actions", async ({ page }, testInfo) => {
    const nativeId = randomUUID();
    const workingDir = join(BRIDGE_HOME, "header-actions-e2e", randomUUID());
    const name = `dense-long-session-name-for-header-layout-and-truncation-${Date.now()}`;
    const transcript = await seedClaudeTranscript(BRIDGE_HOME, nativeId, workingDir, [
      { model: "claude-sonnet-4-5-20250929", input: 1234567, output: 456789, cacheRead: 0, cacheWrite: 0 },
    ]);
    let sid: string | undefined;
    try {
      const created = await bridgeApiFetch("POST", "/api/sessions", {
        body: { projectName: "E2E", shellType: "shell", name, workingDir, createMissingWorkingDir: true, claudeSessionId: nativeId },
      });
      expect(created.status, `create session: ${JSON.stringify(created.body)}`).toBe(201);
      sid = (created.body as SessionEnvelope).session?.id;
      expect(sid).toBeTruthy();
      if (!sid) throw new Error("Created session has no ID");
      const stopped = await bridgeApiFetch("POST", `/api/sessions/${sid}/stop`);
      expect(stopped.status).toBe(200);
      await expect.poll(() => statusOf(sid!), { timeout: 30_000 }).toBe("completed");
      const usage = await bridgeApiFetch("GET", `/api/sessions/${sid}/usage`);
      expect(usage.status).toBe(200);
      expect(usage.body).toMatchObject({ usage: { inputTokens: 1234567, outputTokens: 456789, models: ["claude-sonnet-4-5-20250929"] } });

      await page.setViewportSize({ width: 1280, height: 900 });
      await login(page);
      await waitForBridgeOnline(page);
      await openSession(page, name);
      const header = page.getByTestId("terminal-header");
      await expect(header.getByText("1.2M in · 456.8K out · sonnet-4-5-20250929", { exact: true })).toBeVisible();
      await checkTerminalHeaderGeometry(page, testInfo, "Rerun", true);
      await header.getByRole("button", { name: "Rerun", exact: true }).click();
      await expect.poll(() => statusOf(sid!), { timeout: 30_000 }).toBe("running");
      await checkTerminalHeaderGeometry(page, testInfo, "Stop", true);
      await header.getByRole("button", { name: "Stop", exact: true }).click();
      await expect.poll(() => statusOf(sid!), { timeout: 30_000 }).toBe("completed");
      await header.getByRole("button", { name: "Rerun", exact: true }).click();
      await expect.poll(() => statusOf(sid!), { timeout: 30_000 }).toBe("running");
      await runMarkerInTerminal(page, `DENSE${Date.now()}`);
    } finally {
      try {
        if (sid) {
          const removed = await bridgeApiFetch("DELETE", `/api/sessions/${sid}`);
          expect(removed.status, `remove fixture session ${sid}`).toBe(200);
        }
      } finally {
        await rm(transcript, { force: true });
        await rmdir(dirname(transcript)).catch(() => undefined);
        await rm(workingDir, { recursive: true, force: true });
      }
    }
  });

  test("drag project headings to reorder and retain the order after reload", async ({ page }) => {
    await login(page);
    const names = ["A", "B", "C"].map(prefix => prefix + randomUUID());
    for (const name of names) {
      await page.getByRole("button", { name: "+ Create project", exact: true }).click();
      await page.getByRole("dialog").getByLabel("Project name", { exact: true }).fill(name);
      await page.getByRole("button", { name: "Create", exact: true }).click();
    }
    const heading = (name: string) => page.getByRole("button", { name, exact: true });
    await heading(names[2]).dragTo(heading(names[0]));
    const regions = page.locator("#dashboard-sidebar section").filter({ has: page.getByRole("button", { name: new RegExp(names.join("|")) }) });
    const order = () => regions.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
    await expect.poll(order).toEqual([names[2], names[0], names[1]]);
    await page.reload();
    await expect.poll(order).toEqual([names[2], names[0], names[1]]);
  });

  test("move a legacy No project session into a new empty project", async ({ page }) => {
    const id = randomUUID();
    const name = `Legacy worker ${id}`;
    const project = `First session ${id}`;
    const directory = join(BRIDGE_HOME, ".ftown", "data", "sessions", id);
    // Current creation requires a project. Seed a pre-project record in the isolated test bridge.
    const stamp = new Date().toISOString();
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(join(directory, "session.json"), JSON.stringify({
        id, name, bridgeId: readBridgePointer().bridgeId, command: "/bin/sh", shellType: "shell",
        status: "completed", createdAt: stamp, updatedAt: stamp,
      }));
      await login(page);
      await waitForBridgeOnline(page);
      const source = page.getByRole("region", { name: "No project", exact: true }).getByRole("button", { name: new RegExp(name) });
      await expect(source).toBeVisible();
      await page.getByRole("button", { name: "+ Create project", exact: true }).click();
      await page.getByRole("dialog").getByLabel("Project name", { exact: true }).fill(project);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      const target = page.getByRole("region", { name: project, exact: true });
      await source.dragTo(target.getByRole("button", { name: project, exact: true }));
      await expect.poll(async () => {
        const result = await bridgeApiFetch("GET", `/api/sessions/${id}`);
        return (result.body as { session?: { projectName?: string } }).session?.projectName;
      }).toBe(project);
      await page.reload();
      await expect(target.getByRole("button", { name: new RegExp(name) })).toBeVisible();
      await target.getByRole("button", { name: /^Open board for / }).click();
      const board = page.getByRole("main").getByRole("region", { name: project + " board" });
      await board.getByLabel("Ticket title").fill("Verify the handoff");
      await board.getByRole("button", { name: "Add ticket" }).click();
      await expect(board.getByRole("region", { name: "Backlog" }).getByText("Verify the handoff")).toBeVisible();
      const card = board.getByRole("article").filter({ has: page.getByRole("button", { name: "Verify the handoff", exact: true }) });
      await card.getByRole("button", { name: "Verify the handoff" }).click();
      const detail = page.getByRole("dialog", { name: "Verify the handoff" });
      await detail.getByLabel("Description").fill("Confirm the build on the assigned bridge.");
      await detail.getByLabel("Assignee").selectOption("bridge/" + readBridgePointer().bridgeId);
      await detail.getByRole("button", { name: "Save changes" }).click();
      await detail.getByLabel("New comment").fill("Ready for verification.");
      await detail.getByRole("button", { name: "Add comment" }).click();
      await expect(detail.getByText("Ready for verification.", { exact: true })).toBeVisible();
      await detail.getByLabel("Subtask title").fill("Check the build");
      await detail.getByRole("button", { name: "Add subtask" }).click();
      await expect(detail.getByRole("button", { name: "Check the build" })).toBeVisible();
      await detail.getByRole("button", { name: "Close ticket" }).click();
      const review = board.getByRole("region", { name: "Review", exact: true });
      await card.getByTitle("Drag Verify the handoff").dragTo(review);
      await expect(review.getByRole("button", { name: "Verify the handoff" })).toBeVisible();
      await expect.poll(async () => {
        const { body } = await bridgeApiFetch("GET", "/api/tickets/inbox?limit=100");
        return (body as { notifications: { projectName: string; reason: string; stage: string }[] }).notifications
          .filter(event => event.projectName === project).map(event => [event.reason, event.stage]);
      }).toEqual([["assignment", "Backlog"], ["stage", "Review"]]);
      await target.getByRole("button", { name: new RegExp(name) }).click();
      await expect(board).toBeHidden();
      await target.getByRole("button", { name: `More actions for ${project}` }).click();
      await page.getByRole("menuitem", { name: "Project settings" }).click();
      const settings = page.getByRole("dialog", { name: "Project settings" });
      const renamed = project + " renamed";
      await settings.getByLabel("Project name").fill(renamed);
      await settings.getByRole("button", { name: "Rename project" }).click();
      await expect(settings).toBeHidden();
      const renamedProject = page.getByRole("region", { name: renamed, exact: true });
      await expect(renamedProject.getByRole("button", { name: new RegExp(name) })).toBeVisible();
      await renamedProject.getByRole("button", { name: /^Open board for / }).click();
      const renamedBoard = page.getByRole("main").getByRole("region", { name: renamed + " board" });
      await expect(renamedBoard.getByRole("button", { name: "Verify the handoff", exact: true })).toBeVisible();
      await renamedBoard.getByRole("button", { name: "Board settings" }).click();
      const boardSettings = page.getByRole("dialog", { name: "Board settings" });
      await boardSettings.getByLabel("Column 4 name").fill("Verification");
      await boardSettings.getByRole("button", { name: "Save columns" }).click();
      await renamedBoard.getByRole("region", { name: "Verification" }).getByRole("button", { name: "Verify the handoff", exact: true }).click();
      await detail.getByRole("button", { name: "Delete ticket", exact: true }).click();
      await detail.getByRole("button", { name: "Confirm delete ticket" }).click();
      await expect(detail).toBeHidden();
      await expect(renamedBoard.getByRole("button", { name: "Check the build", exact: true })).toBeVisible();
      await renamedBoard.getByRole("button", { name: "Board settings" }).click();
      await boardSettings.getByRole("button", { name: "Delete board", exact: true }).click();
      await boardSettings.getByRole("button", { name: "Confirm delete board" }).click();
      await renamedBoard.getByRole("button", { name: "Create board" }).click();
      await expect(renamedBoard.getByRole("region", { name: "Review", exact: true })).toBeVisible();
      await expect(renamedBoard.getByRole("article")).toHaveCount(0);
      await renamedBoard.getByRole("button", { name: "Back to workspace" }).click();
      await renamedProject.getByRole("button", { name: `More actions for ${renamed}` }).click();
      await page.getByRole("menuitem", { name: "Project settings" }).click();
      await settings.getByRole("button", { name: "Delete project" }).click();
      await settings.getByRole("button", { name: "Confirm delete" }).click();
      await expect(settings).toBeHidden();
      await page.reload();
      await expect(source).toBeVisible();
      await expect(renamedProject).toHaveCount(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("drag a root between two children to enter their subgroup", async ({ page }) => {
    const accountId = sharedAccountId();
    await login(page);
    await waitForBridgeOnline(page);

    const suffix = Date.now();
    const parentName = `between-parent-${suffix}`;
    const firstChildName = `between-child-a-${suffix}`;
    const secondChildName = `between-child-b-${suffix}`;
    const draggedName = `between-dragged-${suffix}`;
    const parent = await createGroupedSession(parentName);
    const firstChild = await createGroupedSession(firstChildName, parent);
    const secondChild = await createGroupedSession(secondChildName, parent);
    const dragged = await createGroupedSession(draggedName);

    try {
      const parentRow = page.getByRole("button", { name: new RegExp(parentName) });
      await expect(parentRow).toBeVisible({ timeout: 20_000 });
      await parentRow.getByRole("button", { name: "Expand children" }).click();

      const draggedRow = page.getByRole("button", { name: new RegExp(draggedName) });
      const secondChildRow = page.getByRole("button", { name: new RegExp(secondChildName) });
      await expect(draggedRow).toBeVisible();
      await expect(secondChildRow).toBeVisible();
      await draggedRow.dragTo(secondChildRow, { targetPosition: { x: 24, y: 1 } });

      await expect.poll(() => parentOf(dragged), { timeout: 20_000 }).toBe(parent);
    } finally {
      await removeSessionQuietly(dragged);
      await removeSessionQuietly(firstChild);
      await removeSessionQuietly(secondChild);
      await removeSessionQuietly(parent);
    }
  });

  test("drag a child to another parent and back to the project root", async ({ page }) => {
    const accountId = sharedAccountId();
    await login(page);
    await waitForBridgeOnline(page);

    const suffix = Date.now();
    const parentAName = `parent-a-${suffix}`;
    const parentBName = `parent-b-${suffix}`;
    const childName = `child-${suffix}`;
    const parentA = await createGroupedSession(parentAName);
    const parentB = await createGroupedSession(parentBName);
    const child = await createGroupedSession(childName, parentA);

    try {
      const parentARow = page.getByRole("button", { name: new RegExp(parentAName) });
      const parentBRow = page.getByRole("button", { name: new RegExp(parentBName) });
      await expect(parentARow).toBeVisible({ timeout: 20_000 });
      await expect(parentBRow).toBeVisible({ timeout: 20_000 });
      await parentARow.getByRole("button", { name: "Expand children" }).click();

      const childRow = page.getByRole("button", { name: new RegExp(childName) });
      await expect(childRow).toBeVisible();
      const parentBBox = await parentBRow.boundingBox();
      expect(parentBBox).not.toBeNull();
      await childRow.dragTo(parentBRow, {
        targetPosition: { x: 24, y: Math.floor(parentBBox!.height / 2) },
      });
      await expect.poll(() => parentOf(child), { timeout: 20_000 }).toBe(parentB);

      await parentBRow.getByRole("button", { name: "Expand children" }).click();
      await expect(childRow).toBeVisible();
      const projectHeader = page.getByRole("region", { name: "E2E", exact: true }).getByRole("button", { name: "E2E", exact: true });
      await childRow.dragTo(projectHeader);
      await expect.poll(() => parentOf(child), { timeout: 20_000 }).toBeNull();
    } finally {
      await removeSessionQuietly(child);
      await removeSessionQuietly(parentA);
      await removeSessionQuietly(parentB);
    }
  });

  test("create → interact → stop → remove (controller CRUD round-trip)", async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const accountId = sharedAccountId();
    await login(page);
    await waitForBridgeOnline(page);

    // --- CREATE + INTERACT (data plane up) ---
    const name = `crud-long-session-name-for-header-layout-and-truncation-${Date.now()}`;
    const before = await sessionIdsFor(accountId);
    await createShellSession(page, name);
    const sid = await waitForNewSessionId(accountId, before);
    await openSession(page, name);
    await runMarkerInTerminal(page, `CRUD${Date.now()}`);

    const row = page.getByRole("button", { name: new RegExp(name) });

    // Bridge confirms it is live before we tear it down.
    await expect
      .poll(() => statusOf(sid), { timeout: 20_000, message: `session ${sid} should be running` })
      .toBe("running");

    // Selected actions belong to the session header, on both phone views.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "Workspace", exact: true }).click();
    const workspaceHeader = page.getByRole("region", { name: "Selected session header" });
    await expect(workspaceHeader).toContainText(name);
    await expect(workspaceHeader.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    const headerActions = page.getByRole("group", { name: "Selected session actions" });
    await expect(headerActions).toHaveCount(1);
    await checkTerminalHeaderGeometry(page, testInfo, "Stop");
    const stop = headerActions.getByRole("button", { name: "Stop", exact: true });
    await stop.focus();
    await expect(stop).toBeFocused();
    await stop.press("Enter");
    await expect.poll(() => statusOf(sid), { timeout: 30_000 }).toBe("completed");
    await expect(headerActions.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await checkTerminalHeaderGeometry(page, testInfo, "Rerun");
    await headerActions.getByRole("button", { name: "Rerun", exact: true }).click();
    await expect.poll(() => statusOf(sid), { timeout: 30_000 }).toBe("running");
    await expect(headerActions.getByRole("button", { name: "Rerun", exact: true })).toHaveCount(0);
    await runMarkerInTerminal(page, `RERUN${Date.now()}`);
    await page.setViewportSize({ width: 1280, height: 900 });

    // --- STOP via the row context menu (Stop menuitem renders only while running/pending) ---
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Session actions" });
    await menu.getByRole("menuitem", { name: "Stop" }).click();

    // session-controller stop() drives status → 'completed' (no 'stopped'/'exited' in the enum).
    await expect
      .poll(() => statusOf(sid), { timeout: 30_000, message: `stop must move ${sid} to completed` })
      .toBe("completed");
    // …and the icon-only UI state reflects it.
    await expect(row.getByTitle("Completed")).toBeVisible({ timeout: 15_000 });

    // --- REMOVE via the row context menu (Remove is always present) ---
    await row.click({ button: "right" });
    await page
      .getByRole("menu", { name: "Session actions" })
      .getByRole("menuitem", { name: "Remove" })
      .click();

    // It disappears from the list…
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    // …and the controller remove is real end-to-end: GET now 404s.
    await expect
      .poll(async () => (await bridgeApiFetch("GET", `/api/sessions/${sid}`)).status, {
        timeout: 20_000,
        message: `removed session ${sid} must 404 on the bridge API`,
      })
      .toBe(404);
  });

  test("resurrection across bridge restart (SessionResurrection + relaunch 'resume')", async ({
    page,
  }) => {
    // Restart (≤40s presence wait) + two marker round-trips need headroom over the 90s default.
    test.setTimeout(180_000);

    const accountId = sharedAccountId();
    await login(page);
    await waitForBridgeOnline(page);

    // --- CREATE + confirm running (marker round-trips) ---
    const name = `resurrect-${Date.now()}`;
    const before = await sessionIdsFor(accountId);
    await createShellSession(page, name);
    const sid = await waitForNewSessionId(accountId, before);
    await openSession(page, name);
    await runMarkerInTerminal(page, `PRE${Date.now()}`);
    await expect
      .poll(() => statusOf(sid), { timeout: 20_000, message: `session ${sid} should be running` })
      .toBe("running");

    // --- KILL + respawn the bridge on the SAME scratch HOME ---
    // The old transport dies with the old process; the new bridge re-onboards off
    // its persisted identity + refresh token and runs SessionResurrection.
    await restartBridge();

    // RESURRECTION SIGNAL (the exact assertion): the SAME session id re-appears in
    // the fresh bridge's session list reporting status 'running' — proving
    // SessionResurrection reattached (tmux) or relaunchFtownSession(..,'resume')
    // respawned it. A lost session would 404 (http:404); a session it could not
    // revive would be marked 'error'. Either fails this poll with detail.
    await expect
      .poll(() => statusOf(sid), {
        timeout: 60_000,
        message: `session ${sid} must be RESURRECTED as running after bridge restart (404/error ⇒ resurrection failed)`,
      })
      .toBe("running");

    // Re-onboard the client against the fresh bridge and re-attach the pty.
    await page.reload();
    await waitForBridgeOnline(page);
    await openSession(page, name);
    const row = page.getByRole("button", { name: new RegExp(name) });
    await expect(row.getByTitle(/Running|Idle/).first()).toBeVisible({ timeout: 30_000 });

    // A NEW marker proves the resurrected PTY is a LIVE process, not a stale record.
    await runMarkerInTerminal(page, `POST${Date.now()}`);
  });

  /**
   * RETRY: the affordance EXISTS but is unreachable in a shell-only harness.
   *
   * Retry is a selected-session header button (className "btn-warn",
   * getByRole("button",{name:"Retry"})) that renders ONLY when the selected
   * session's status === 'error'. It is NOT in the session context menu and is NOT
   * shown for a 'completed'/'done' session. A plain-zsh shell session that is
   * stopped becomes 'completed', never 'error', and this harness has no
   * deterministic, cost-free way to drive a session into 'error' via the UI. Rather
   * than fabricate a failure state, this case is skipped with the affordance
   * documented (per the task: SKIP with a note when there is no honest path).
   */
  test.skip("retry a stopped/errored session round-trips a new marker", async () => {
    // Intentionally skipped — Retry UI confirmed to exist (selected-session header,
    // error-gated) but not reachable with the shell-only harness. See note above.
  });
});
