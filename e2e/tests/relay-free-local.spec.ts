import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, waitForBridgeOnline, createShellSession, openSession, runMarkerInTerminal } from "../helpers/app";

/**
 * A bridge on this machine stays usable when the browser cannot reach the relay.
 *
 * The first visit learns the bridge's localhost port from the relay and remembers it. The relay is then made unreachable for this
 * page only (its WebSocket is refused; the bridge and every other test keep their relay), and the page is reloaded. Nothing the
 * dashboard shows after that reload can have come through the relay.
 */
test("a local bridge is listed, read and driven while the relay is unreachable", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  await waitForBridgeOnline(page);
  const name = `relay-free-${Date.now()}`;
  await createShellSession(page, name);
  await expect.poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("ftown.bridgeLocalPorts.v1") ?? "{}")).length),
    { timeout: 30_000 }).toBeGreaterThan(0);

  let refused = 0;
  await page.routeWebSocket(/\/connection\/websocket/, socket => { refused++; void socket.close({ code: 1006, reason: "relay unreachable" }).catch(() => {}); });
  await page.reload();

  // The relay really is out of reach for this page, and stays so.
  await expect(page.locator('[aria-label^="Cloud "]').first()).not.toHaveAttribute("aria-label", /^Cloud connected/, { timeout: 30_000 });
  expect(refused).toBeGreaterThan(0);

  // Listed: the bridge and the session created before the reload.
  await openSession(page, name);
  await expect(page.getByRole("button", { name: "Create a new session", exact: true })).toBeEnabled({ timeout: 30_000 });

  // Read and driven: the terminal echoes over the localhost connection.
  await runMarkerInTerminal(page, `relayfree${Date.now()}`);
  await expect(page.locator('[aria-label="Selected terminal: Local"]')).toBeVisible();

  // A command that changes something works too.
  await createShellSession(page, `${name}-second`);
  await expect(page.locator('[aria-label^="Cloud "]').first()).not.toHaveAttribute("aria-label", /^Cloud connected/);
});
