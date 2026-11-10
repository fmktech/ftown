import { expect, request as pwRequest, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login } from "../helpers/app";
import { browserEndpointId } from "../helpers/passkey";
import { serverLedger } from "../helpers/ledger-admin";
import { bridgeSecurityCommand } from "../helpers/secure-browser";
import { BRIDGE_HOME, UI_BASE_URL } from "../helpers/config";

// Display names are cosmetic, server-side metadata keyed by account id
// (/api/security/device-names). The passkey-signed ledger carries the signed
// labels and must never change because of a rename.
const origin = UI_BASE_URL;
const BRIDGE_HOME_2 = process.env.E2E_BRIDGE_HOME_2 ?? BRIDGE_HOME.replace(/\.bridge-home$/, ".bridge-home-2");

async function openAccess(page: Page) {
  const menu = page.getByRole("button", { name: "Open navigation menu", exact: true });
  if ((page.viewportSize()?.width ?? 1280) < 768) { await expect(menu).toBeVisible(); await menu.click(); }
  await page.getByRole("button", { name: "Open security", exact: true }).click();
  await expect(page.getByRole("list", { name: "Account devices", exact: true })).toBeVisible({ timeout: 60000 });
}
async function names(api: APIRequestContext) {
  const res = await api.get(`${origin}/api/security/device-names`);
  expect(res.status()).toBe(200);
  return await res.json() as { names: { kind: string; id: string; name: string }[]; eligible: { kind: string; id: string }[] };
}
/** PUT with the account write limit (60/min, shared by the whole run) honoured: wait out a 429 and retry. */
async function put(api: APIRequestContext, data: unknown, headers: Record<string, string> = { Origin: origin }) {
  for (let attempt = 0; ; attempt++) {
    const res = await api.put(`${origin}/api/security/device-names`, { headers, data });
    if (res.status() !== 429 || attempt >= 3) return res;
    await new Promise(resolve => setTimeout(resolve, (Number(res.headers()["retry-after"]) || 60) * 1000 + 500));
  }
}

test("display names sync between browsers of the account without changing trust", async ({ browser }) => {
  test.setTimeout(240000);
  const contexts: BrowserContext[] = [];
  let restore: (() => Promise<void>) | null = null;
  try {
    const ctxA = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 } }); contexts.push(ctxA);
    const ctxB = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 } }); contexts.push(ctxB);
    const a = await ctxA.newPage(); await login(a, { browserLabel: "Names browser A" });
    const b = await ctxB.newPage(); await login(b, { browserLabel: "Names browser B" });
    const idA = await browserEndpointId(a), idB = await browserEndpointId(b);
    expect(idA).not.toBe(idB);

    const { checkpoint } = await serverLedger();
    const bridgeId = checkpoint.bridges[0].bridgeId;
    const original = (await names(a.request)).names.find(n => n.kind === "bridge" && n.id === bridgeId)?.name ?? null;
    restore = async () => { await put(a.request, { kind: "bridge", id: bridgeId, name: original }); };

    const ledgerBefore = JSON.stringify((await serverLedger()).ledger);
    const devicesOf = async (home: string) => {
      const r = await bridgeSecurityCommand("security_devices", {}, home) as unknown as { devices: { endpoint: { id: string } }[] };
      return r.devices.map(d => d.endpoint.id);
    };
    for (const home of [BRIDGE_HOME, BRIDGE_HOME_2]) {
      await expect.poll(async () => { try { const ids = await devicesOf(home); return ids.includes(idA) && ids.includes(idB); } catch { return false; } }, { timeout: 60000 }).toBe(true);
    }

    // Rename the other browser (B) and the computer from context A, through the Security panel.
    await openAccess(a);
    const nameB = `Renamed phone ${Date.now()}`, nameBridge = `Office computer ${Date.now()} 💻`;
    await a.locator(`[data-access-node="${idB}"]`).click();
    const cardB = a.locator(`[data-access-card="browser:${idB}"]`);
    await cardB.getByRole("button", { name: /^Rename /, }).click();
    await cardB.getByLabel("Display name", { exact: true }).fill(nameB);
    await cardB.getByRole("button", { name: "Save", exact: true }).click();
    await expect(cardB.getByText(nameB, { exact: true })).toBeVisible();

    await a.locator(`[data-access-node="${bridgeId}"]`).click();
    const details = a.locator(`[data-computer-details="${bridgeId}"]`);
    await details.getByRole("button", { name: /^Rename /, }).click();
    await details.getByLabel("Display name", { exact: true }).fill(nameBridge);
    await details.getByRole("button", { name: "Save", exact: true }).click();
    await expect(details.getByText("Display name saved.")).toBeVisible();

    // Server side: both names are stored under the account.
    await expect.poll(async () => (await names(a.request)).names.map(n => `${n.kind}:${n.id}=${n.name}`).sort())
      .toEqual(expect.arrayContaining([`browser:${idB}=${nameB}`, `bridge:${bridgeId}=${nameBridge}`]));

    // Context B sees the new names after a reload.
    await b.reload(); await openAccess(b);
    await expect(b.locator(`[data-access-card="browser:${idB}"]`).getByText(nameB, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(b.locator(`[data-access-node="${bridgeId}"]`)).toContainText(nameBridge, { timeout: 30000 });
    expect((await names(b.request)).names).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "browser", id: idB, name: nameB }), expect.objectContaining({ kind: "bridge", id: bridgeId, name: nameBridge })]));

    // Trust unchanged: signed ledger is byte-identical and every bridge still lists both browsers.
    expect(JSON.stringify((await serverLedger()).ledger)).toBe(ledgerBefore);
    for (const home of [BRIDGE_HOME, BRIDGE_HOME_2]) {
      const ids = await devicesOf(home);
      expect(ids).toEqual(expect.arrayContaining([idA, idB]));
    }

    // Reset through the UI returns to the signed label.
    await a.locator(`[data-access-node="${bridgeId}"]`).click();
    await a.locator(`[data-computer-details="${bridgeId}"]`).getByRole("button", { name: "Reset name", exact: true }).click();
    await expect.poll(async () => (await names(a.request)).names.some(n => n.kind === "bridge" && n.id === bridgeId && n.name === nameBridge)).toBe(false);
  } finally {
    try { await restore?.(); } catch { /* best effort */ }
    for (const context of contexts.reverse()) await context.close().catch(() => undefined);
  }
});

test("device-names API validates names and refuses unauthenticated writes", async ({ browser }) => {
  test.setTimeout(180000);
  const context = await browser.newContext({ baseURL: origin });
  try {
    const page = await context.newPage(); await login(page, { browserLabel: "Names validator" });
    const id = await browserEndpointId(page);
    const target = { kind: "browser", id };
    const ok = async (name: unknown) => (await put(page.request, { ...target, name })).status();
    const before = (await names(page.request)).names.find(n => n.id === id)?.name ?? null;
    try {
      expect(await ok("x")).toBe(200);
      expect(await ok("y".repeat(80))).toBe(200);
      expect(await ok("")).toBe(400);
      expect(await ok("   ")).toBe(400);
      expect(await ok("y".repeat(81))).toBe(400);
      expect(await ok("bad\u0000name")).toBe(400);
      expect(await ok("bad\nname")).toBe(400);
      expect(await ok("bad‮name")).toBe(400);
      expect(await ok("bad⁧name")).toBe(400);
      expect(await ok(42)).toBe(400);
      expect((await put(page.request, { ...target, name: "x", extra: 1 })).status()).toBe(400);
      expect((await put(page.request, { kind: "browser", id: "not-in-account-id", name: "x" })).status()).toBe(404);
      expect((await put(page.request, { ...target, name: "x" }, { Origin: "https://evil.example" })).status()).toBe(403);
      expect((await names(page.request)).names.find(n => n.id === id)?.name).toBe("y".repeat(80));
    } finally {
      await put(page.request, { ...target, name: before });
    }
    // Unauthenticated: no session cookie.
    const anon = await pwRequest.newContext({ ignoreHTTPSErrors: true });
    try {
      expect((await put(anon, { ...target, name: "Intruder" })).status()).toBe(401);
      expect((await anon.get(`${origin}/api/security/device-names`)).status()).toBe(401);
    } finally { await anon.dispose(); }
    expect((await names(page.request)).names.find(n => n.id === id)?.name).not.toBe("Intruder");
  } finally { await context.close().catch(() => undefined); }
});
