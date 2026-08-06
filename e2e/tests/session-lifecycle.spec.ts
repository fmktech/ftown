import { test, expect } from "@playwright/test";
import {
  sharedEmail,
  login,
  waitForBridgeOnline,
  createShellSession,
  openSession,
  runMarkerInTerminal,
} from "../helpers/app";
import { sessionIdsFor, waitForNewSessionId } from "../helpers/centrifugo";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { restartBridge } from "../helpers/bridge-process";

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
 *    session becomes 'completed'; a dead/failed one 'error'. The pointer
 *    (port+bearer) is re-read fresh on every call, so it survives a bridge restart.
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
    body: { shellType: "shell", name, parentSessionId },
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

test.describe("session lifecycle", () => {
  test("drag a child to another parent and back to the bridge root", async ({ page }) => {
    const email = sharedEmail();
    await login(page, email);
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
      const bridgeRoot = page.getByTitle(
        "Drop a child session here to move it back to the bridge root",
      );
      await childRow.dragTo(bridgeRoot);
      await expect.poll(() => parentOf(child), { timeout: 20_000 }).toBeNull();
    } finally {
      await removeSessionQuietly(child);
      await removeSessionQuietly(parentA);
      await removeSessionQuietly(parentB);
    }
  });

  test("create → interact → stop → remove (controller CRUD round-trip)", async ({ page }) => {
    const email = sharedEmail();
    await login(page, email);
    await waitForBridgeOnline(page);

    // --- CREATE + INTERACT (data plane up) ---
    const name = `crud-${Date.now()}`;
    const before = await sessionIdsFor(email);
    await createShellSession(page, name);
    const sid = await waitForNewSessionId(email, before);
    await openSession(page, name);
    await runMarkerInTerminal(page, `CRUD${Date.now()}`);

    const row = page.getByRole("button", { name: new RegExp(name) });

    // Bridge confirms it is live before we tear it down.
    await expect
      .poll(() => statusOf(sid), { timeout: 20_000, message: `session ${sid} should be running` })
      .toBe("running");

    // --- STOP via the row context menu (Stop menuitem renders only while running/pending) ---
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Session actions" });
    await menu.getByRole("menuitem", { name: "Stop" }).click();

    // session-controller stop() drives status → 'completed' (no 'stopped'/'exited' in the enum).
    await expect
      .poll(() => statusOf(sid), { timeout: 30_000, message: `stop must move ${sid} to completed` })
      .toBe("completed");
    // …and the UI badge reflects it (completed renders as "done").
    await expect(row.getByText("done", { exact: true })).toBeVisible({ timeout: 15_000 });

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

    const email = sharedEmail();
    await login(page, email);
    await waitForBridgeOnline(page);

    // --- CREATE + confirm running (marker round-trips) ---
    const name = `resurrect-${Date.now()}`;
    const before = await sessionIdsFor(email);
    await createShellSession(page, name);
    const sid = await waitForNewSessionId(email, before);
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
    await expect(row.getByText(/running|idle/).first()).toBeVisible({ timeout: 30_000 });

    // A NEW marker proves the resurrected PTY is a LIVE process, not a stale record.
    await runMarkerInTerminal(page, `POST${Date.now()}`);
  });

  /**
   * RETRY: the affordance EXISTS but is unreachable in a shell-only harness.
   *
   * Retry is a Dashboard toolbar button (className "btn-warn",
   * getByRole("button",{name:"Retry"})) that renders ONLY when the selected
   * session's status === 'error'. It is NOT in the session context menu and is NOT
   * shown for a 'completed'/'done' session. A plain-zsh shell session that is
   * stopped becomes 'completed', never 'error', and this harness has no
   * deterministic, cost-free way to drive a session into 'error' via the UI. Rather
   * than fabricate a failure state, this case is skipped with the affordance
   * documented (per the task: SKIP with a note when there is no honest path).
   */
  test.skip("retry a stopped/errored session round-trips a new marker", async () => {
    // Intentionally skipped — Retry UI confirmed to exist (Dashboard toolbar,
    // error-gated) but not reachable with the shell-only harness. See note above.
  });
});
