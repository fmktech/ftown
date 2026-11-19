import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login, waitForBridgeOnline, createShellSession, openSession, runMarkerInTerminal } from "../helpers/app";

/**
 * A bridge is reachable by its remembered network address, with no relay and no localhost port.
 *
 * The first visit asks the bridge where it listens (get_direct_address) and remembers the answer. The page then forgets the
 * bridge's localhost port and cannot reach the relay, so after a reload the only way to the bridge is the remembered address:
 * a WebRTC connection the browser sets up entirely by itself.
 */
test("a bridge is reached by its remembered address with the relay unreachable and no localhost port", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  await waitForBridgeOnline(page);
  const name = `direct-address-${Date.now()}`;
  await createShellSession(page, name);
  await expect.poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("ftown.bridgeDirectAddresses.v1") ?? "{}")).length),
    { timeout: 30_000 }).toBeGreaterThan(0);
  const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem("ftown.bridgeDirectAddresses.v1")!));
  for (const address of Object.values(remembered) as { port: number; fingerprint: string; addresses: string[] }[]) {
    expect(address.port).toBeGreaterThan(0);
    expect(address.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(address.addresses.length).toBeGreaterThan(0);
    expect(address.addresses).not.toContain("127.0.0.1");
  }

  await page.evaluate(() => localStorage.removeItem("ftown.bridgeLocalPorts.v1"));
  // Even the localhost WebSocket is refused, so a terminal that works cannot be on the Local rung.
  await page.routeWebSocket(/\/connection\/websocket|127\.0\.0\.1:\d+\/ws/, socket => { void socket.close({ code: 1006, reason: "unreachable" }).catch(() => {}); });
  await page.reload();
  await expect(page.locator('[aria-label^="Cloud "]').first()).not.toHaveAttribute("aria-label", /^Cloud connected/, { timeout: 30_000 });

  await openSession(page, name);
  await runMarkerInTerminal(page, `addressed${Date.now()}`);
  await expect(page.locator('[aria-label="Selected terminal: P2P"]')).toBeVisible();
  await createShellSession(page, `${name}-second`);
});
