import { expect, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { join } from "node:path";
import { createShellSession, getCentrifugoToken, login, openSession, runMarkerInTerminal, sharedAccountId, waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch, readBridgePointer } from "../helpers/bridge-api";
import { bridgeSecurityCommand, browserEndpointId } from "../helpers/secure-browser";
import { sessionIdsFor, waitForNewSessionId } from "../helpers/centrifugo";
import { E2E_DIR, UI_BASE_URL } from "../helpers/config";

test.setTimeout(180000);
const secondHome = process.env.E2E_SECOND_BRIDGE_HOME ?? join(E2E_DIR, ".bridge-home-2");

async function openSecurity(page: Page) {
  // The dashboard mounts after the browser identity opens. Checking visibility
  // before then can mistake a not-yet-rendered mobile menu for desktop.
  const actions = page.locator("#dashboard-navigation");
  await expect(actions).toBeAttached({ timeout: 30_000 });
  const mobile = await page.evaluate(() => window.matchMedia("(max-width: 767px)").matches);
  if (mobile) {
    const navigation = page.getByRole("button", { name: /^(Open|Close) navigation menu$/ });
    await expect(navigation).toBeVisible({ timeout: 30_000 });
    if (await navigation.getAttribute("aria-expanded") !== "true") await navigation.click();
  }
  await expect(actions).toBeVisible({ timeout: 30_000 });
  const security = actions.getByRole("button", { name: "Open security", exact: true });
  await expect(security).toBeVisible();
  await security.click();
  await expect(page.getByRole("dialog", { name: "Security", exact: true })).toBeVisible();
}

/** Browser endpoint ids a bridge currently trusts, with the source the bridge reports for each. */
async function listedBrowsers(home?: string): Promise<Map<string, string | undefined>> {
  const result = await bridgeSecurityCommand("security_devices", {}, home) as { devices?: { endpoint?: { id?: string }; source?: string }[] };
  const listed = new Map<string, string | undefined>();
  for (const device of result.devices ?? []) if (device.endpoint?.id) listed.set(device.endpoint.id, device.source);
  return listed;
}
async function expectListed(endpointId: string, listed: boolean, home?: string) {
  await expect.poll(async () => (await listedBrowsers(home)).has(endpointId), { timeout: 30_000, intervals: [250, 500, 1000], message: `bridge ${home ?? "primary"} listing of ${endpointId}` }).toBe(listed);
}
function captureBroker(page: Page): string[] {
  const frames: string[] = [];
  page.on("websocket", socket => {
    socket.on("framesent", ({ payload }) => frames.push(typeof payload === "string" ? payload : payload.toString()));
    socket.on("framereceived", ({ payload }) => frames.push(typeof payload === "string" ? payload : payload.toString()));
  });
  return frames;
}

test("a signed-in browser persists its non-extractable key; cloud terminal frames stay opaque; another signed-in browser can remove it", async ({ page, browser }) => {
  const pointer = readBridgePointer(); const accountId = sharedAccountId();
  const frames = captureBroker(page);
  await page.addInitScript(() => { Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: class { constructor() { throw new Error("Force the encrypted relay path for this test"); } } }); });
  await page.routeWebSocket(url => url.hostname === "127.0.0.1" && url.port === String(pointer.port) && url.pathname === "/ws", socket => socket.close());
  await login(page, { browserLabel: "E2E sec browser" }); await waitForBridgeOnline(page);
  const endpointId = await browserEndpointId(page); // asserts the private key is a non-extractable CryptoKey
  const before = await sessionIdsFor(accountId); const name = `E2EESESSION${Date.now()}`;
  let sessionId: string | undefined;
  const remover = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await createShellSession(page, name); sessionId = await waitForNewSessionId(accountId, before); await openSession(page, name);
    const marker = `E2EECONTENT${Date.now()}`; await runMarkerInTerminal(page, marker);
    await expect(page.locator("text=/^(P2P|Local|Cloud)$/").first()).toHaveText("Cloud", { timeout: 15000 });
    expect(frames.join("\n")).not.toContain(marker); expect(frames.join("\n")).not.toContain(name);
    expect(frames.some(frame => frame.includes("ftown_encrypted"))).toBe(true);
    await page.reload(); await waitForBridgeOnline(page); expect(await browserEndpointId(page)).toBe(endpointId);

    // Both shared bridges project this browser from the ledger; invitations are refused in account mode.
    for (const home of [undefined, secondHome]) { await expectListed(endpointId, true, home); expect((await listedBrowsers(home)).get(endpointId)).toBe("account"); }
    // The local CLI client reports the bridge's real refusal code.
    await expect(bridgeSecurityCommand("security_invite", { label: "E2E invite" })).rejects.toThrow(/account_managed/);

    // A second signed-in browser (the "mobile Security panel") removes this one with the account passkey.
    const phone = await remover.newPage(); await login(phone, { browserLabel: "E2E remover phone" }); await waitForBridgeOnline(phone);
    await openSecurity(phone);
    const dialog = phone.getByRole("dialog", { name: "Security", exact: true });
    await dialog.locator(`[data-access-kind="browser"][data-access-node="${endpointId}"]`).first().click();
    await dialog.getByRole("button", { name: /^Remove browser/ }).click();
    await expect(dialog.getByRole("group", { name: "Confirm browser removal" })).toBeVisible();
    await dialog.getByRole("button", { name: "Confirm remove browser", exact: true }).click();

    for (const home of [undefined, secondHome]) await expectListed(endpointId, false, home);
    // The removed browser is refused a relay token.
    await expect.poll(async () => (await page.request.post(`${UI_BASE_URL}/api/auth/token`)).status(), { timeout: 30_000, intervals: [500, 1000] }).toBe(401);
    await expect(getCentrifugoToken(page)).rejects.toThrow(/401/);
  } finally {
    await remover.close();
    if (sessionId) await bridgeApiFetch("DELETE", `/api/sessions/${sessionId}`);
  }
});

test("two isolated browser installations signed in with the same passkey retain distinct keys and both open a terminal on each bridge", async ({ page, browser }) => {
  const accountId = sharedAccountId();
  await login(page, { browserLabel: "E2E browser" }); await waitForBridgeOnline(page);
  const firstId = await browserEndpointId(page);
  const second = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const sessions: { id: string; home?: string }[] = [];
  try {
    const phone = await second.newPage(); await login(phone, { browserLabel: "E2E phone" }); await waitForBridgeOnline(phone);
    const secondId = await browserEndpointId(phone);
    expect(secondId).not.toBe(firstId);
    for (const home of [undefined, secondHome]) { await expectListed(firstId, true, home); await expectListed(secondId, true, home); }
    for (const [who, client] of [["desk", page], ["phone", phone]] as const) {
      for (const home of [undefined, secondHome]) {
        const bridgeId = readBridgePointer(home).bridgeId; const before = await sessionIdsFor(accountId); const name = `E2EDISTINCT${who}${home ? "B" : "A"}${Date.now()}`;
        await client.getByRole("button", { name: "Create a new session", exact: true }).click();
        await expect(client.getByText("New Session", { exact: true })).toBeVisible();
        await client.locator("#ns-shell-type").selectOption("shell");
        await client.locator("#ns-bridge").selectOption(bridgeId);
        await client.locator('input[placeholder="Optional name for this session"]').fill(name);
        await client.getByRole("button", { name: "Create Session" }).click();
        sessions.push({ id: await waitForNewSessionId(accountId, before), home });
        // On a phone-width layout creating a session already opens its Terminal tab; the sidebar row is not on screen.
        if (who === "desk") await openSession(client, name);
        await expect(client.locator(".xterm").first()).toBeVisible({ timeout: 30_000 }); await runMarkerInTerminal(client, `E2EMARK${who}${Date.now()}`);
      }
    }
  } finally {
    await second.close();
    for (const { id, home } of sessions) await bridgeApiFetch("DELETE", `/api/sessions/${id}`, { bridgeHome: home }).catch(() => undefined);
  }
});
