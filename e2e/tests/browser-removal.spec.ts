import { expect, type BrowserContext } from "@playwright/test";
import { join } from "node:path";
import { test } from "../helpers/fixtures";
import { login } from "../helpers/app";
import { BRIDGE_HOME } from "../helpers/config";
import { revokeDevices, serverLedger } from "../helpers/ledger-admin";
import { bridgeSecurityCommand } from "../helpers/secure-browser";
import { browserEndpointId } from "../helpers/passkey";

const SECOND_BRIDGE_HOME = process.env.E2E_SECOND_BRIDGE_HOME ?? join(BRIDGE_HOME, "..", ".bridge-home-2");

async function bridgeLists(home: string, endpointId: string): Promise<boolean> {
  const result = await bridgeSecurityCommand("security_devices", {}, home) as unknown as { devices: { endpoint: { id: string }; source?: string }[] };
  return result.devices.some(device => device.endpoint.id === endpointId && device.source === "account");
}

test("removing a browser in Security: every computer drops it, the server refuses it, and it can rejoin only with new keys", async ({ browser }) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  let rejoinedId: string | null = null;
  try {
    const contextA = await browser.newContext(); contexts.push(contextA);
    const contextB = await browser.newContext(); contexts.push(contextB);
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await login(pageA, { browserLabel: "E2E admin browser" });
    const labelB = `E2E doomed browser ${Date.now()}`;
    await login(pageB, { browserLabel: labelB });
    const idB = await browserEndpointId(pageB);

    // Both shared computers trust B (projected from the ledger).
    for (const home of [BRIDGE_HOME, SECOND_BRIDGE_HOME]) {
      await expect.poll(() => bridgeLists(home, idB), { timeout: 30_000, message: "the bridge must list the signed-in browser" }).toBe(true);
    }

    // A removes B: one confirmation, one passkey approval.
    await pageA.goto("/dashboard");
    await pageA.getByRole("button", { name: "Open security", exact: true }).click();
    const dialog = pageA.getByRole("dialog", { name: "Security", exact: true });
    const node = dialog.locator(`[data-access-kind="browser"][data-access-node="${idB}"]`).first();
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.click();
    const remove = dialog.getByRole("button", { name: /^Remove browser / });
    await expect(remove).toBeEnabled();
    await remove.click();
    const confirmation = dialog.getByRole("group", { name: "Confirm browser removal", exact: true });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Confirm remove browser", exact: true }).click();
    await expect.poll(async () => (await serverLedger()).checkpoint.revokedDeviceIds.includes(idB), { timeout: 30_000 }).toBe(true);
    expect((await serverLedger()).checkpoint.devices.some(device => device.endpoint.id === idB)).toBe(false);

    // Every computer drops it.
    for (const home of [BRIDGE_HOME, SECOND_BRIDGE_HOME]) {
      await expect.poll(() => bridgeLists(home, idB), { timeout: 30_000, message: "the bridge must drop the removed browser" }).toBe(false);
    }

    // The server refuses the removed browser: no relay token, no dashboard; its device key cannot sign in again.
    expect((await pageB.request.post("/api/auth/token")).status()).toBe(401);
    await pageB.goto("/dashboard");
    await expect(pageB).toHaveURL(/\/login/, { timeout: 30_000 });
    await expect(pageB.getByRole("button", { name: "Reset this browser" })).toBeVisible({ timeout: 30_000 });
    expect((await pageB.request.post("/api/auth/token")).status()).toBe(401);

    // It can come back only as a NEW browser (new keys), signed in with the passkey.
    await pageB.getByRole("button", { name: "Reset this browser" }).click();
    await pageB.getByRole("button", { name: "Sign in with passkey" }).click();
    await pageB.locator("#device-label").fill(`${labelB} (new keys)`);
    await pageB.getByRole("button", { name: "Add this browser" }).click();
    await pageB.waitForURL("**/dashboard", { timeout: 30_000 });
    rejoinedId = await browserEndpointId(pageB);
    expect(rejoinedId).not.toBe(idB);
    const { checkpoint } = await serverLedger();
    expect(checkpoint.devices.some(device => device.endpoint.id === rejoinedId)).toBe(true);
    expect(checkpoint.revokedDeviceIds).toContain(idB);
    expect((await pageB.request.post("/api/auth/token")).status()).toBe(200);
  } finally {
    for (const context of contexts.reverse()) await context.close().catch(() => {});
    if (rejoinedId) await revokeDevices([rejoinedId]);
  }
});
