import { expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "../helpers/fixtures";
import { login } from "../helpers/app";
import { E2E_DIR, UI_BASE_URL } from "../helpers/config";
import { appendOperation, ledgerCredentialId, serverLedger } from "../helpers/ledger-admin";
import { startIsolatedBridge, type IsolatedBridge, type PairingPrompt } from "../helpers/ledger-bridge";
import { approvePairLink, readRunAccount, withAccountPasskey } from "../helpers/passkey";

type PairingModule = typeof import("../../bridge/src/security/ledger/pairing");
const pairing = () => import(pathToFileURL(join(E2E_DIR, "..", "bridge", "dist", "security", "ledger", "pairing.js")).href) as Promise<PairingModule>;

const CODE_MISMATCH = "That code does not match the one on your computer.";
const ATTEMPTS_EXCEEDED = "Too many wrong codes. This link was discarded. Request a new link on the computer.";

async function decodeLink(prompt: PairingPrompt) {
  return (await pairing()).parsePairLink(new URL(prompt.link).hash);
}

/** Housekeeping: stop the test bridge, then take it out of the shared account if it was added. */
async function retire(bridge: IsolatedBridge | null, bridgeId: string | null): Promise<void> {
  await bridge?.stop();
  if (!bridgeId) return;
  const { checkpoint } = await serverLedger();
  if (checkpoint.bridges.some(item => item.bridgeId === bridgeId)) await appendOperation({ type: "revoke_bridge", bridgeId });
}

async function openPairLink(page: Page, link: string): Promise<void> {
  await withAccountPasskey(page);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Connect a computer" })).toBeVisible();
}

test("an unpaired computer prints a private link + code; typing the code and one passkey approval pairs it", async ({ page }, info) => {
  test.setTimeout(150_000);
  const account = readRunAccount();
  let bridge: IsolatedBridge | null = null;
  let bridgeId: string | null = null;
  try {
    bridge = await startIsolatedBridge();
    const prompt = await bridge.pairing();
    bridgeId = bridge.bridgeIdFile();
    expect(new URL(prompt.link).origin).toBe(new URL(UI_BASE_URL).origin);
    expect(new URL(prompt.link).pathname).toBe("/pair");
    expect(prompt.code).toMatch(/^\d{6}$/);
    const link = await decodeLink(prompt);
    expect(link.request.bridgeId).toBe(bridgeId);
    expect(await (await pairing()).pairComparisonCode(link.request)).toBe(prompt.code);
    // The secret travels in the fragment only: the mailbox is still empty.
    expect((await fetch(`${UI_BASE_URL}/api/pair/${link.request.requestId}`)).status).toBe(404);

    await login(page);
    await approvePairLink(page, prompt.link, prompt.code);

    // The bridge verified the approval and names the account and the signing passkey.
    await expect.poll(() => bridge!.output(), { timeout: 30_000 })
      .toContain(`Paired with account ${account.accountId.slice(0, 8)} (passkey "E2E passkey")`);
    const { checkpoint, ledger } = await serverLedger();
    const entry = checkpoint.bridges.find(item => item.bridgeId === bridgeId);
    expect(entry?.label).toBe(link.request.label);
    expect(entry?.authPublicKey).toBe(link.request.authPublicKey);
    expect(entry?.endpoint.ownerId).toBe(account.accountId);
    const added = ledger.transitions.find(record => record.payload.operation.type === "add_bridge"
      && record.payload.operation.bridge.bridgeId === bridgeId);
    expect(added?.payload.credentialId).toBe(ledgerCredentialId(account));

    // The computer comes online for the account's browsers.
    await page.goto("/dashboard");
    await expect(page.locator(`[data-bridge-row="${bridgeId}"]`).first()).toBeVisible({ timeout: 60_000 });
  } catch (error) {
    if (bridge) await info.attach("pairing-bridge.log", { body: bridge.output(), contentType: "text/plain" });
    throw error;
  } finally {
    await retire(bridge, bridgeId);
  }
});

test("five wrong codes discard the link; nothing is approved and the computer keeps waiting", async ({ page }, info) => {
  test.setTimeout(120_000);
  let bridge: IsolatedBridge | null = null;
  let bridgeId: string | null = null;
  try {
    bridge = await startIsolatedBridge();
    const prompt = await bridge.pairing();
    bridgeId = bridge.bridgeIdFile();
    const link = await decodeLink(prompt);
    const wrong = String((Number(prompt.code) + 1) % 1_000_000).padStart(6, "0");
    await login(page);
    await openPairLink(page, prompt.link);
    const code = page.getByLabel("Code from your computer");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await code.fill(wrong);
      await page.getByRole("button", { name: "Approve with passkey" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toHaveText(CODE_MISMATCH);
    }
    await code.fill(wrong);
    await page.getByRole("button", { name: "Approve with passkey" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(ATTEMPTS_EXCEEDED);
    await expect(page.getByLabel("Code from your computer")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve with passkey" })).toHaveCount(0);
    // The link is gone from the address bar and from session storage.
    expect(new URL(page.url()).hash).toBe("");
    await page.goto("/pair");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("Open the private link shown on your computer.");

    const { checkpoint } = await serverLedger();
    expect(checkpoint.bridges.some(item => item.bridgeId === bridgeId)).toBe(false);
    expect((await fetch(`${UI_BASE_URL}/api/pair/${link.request.requestId}`)).status).toBe(404);
    expect(bridge.running()).toBe(true);
    expect(bridge.output()).not.toContain("Paired with account");
  } catch (error) {
    if (bridge) await info.attach("pairing-bridge.log", { body: bridge.output(), contentType: "text/plain" });
    throw error;
  } finally {
    await retire(bridge, bridgeId);
  }
});

test("an expired pairing link cannot be approved", async ({ page }) => {
  test.setTimeout(120_000);
  let bridge: IsolatedBridge | null = null;
  let bridgeId: string | null = null;
  try {
    bridge = await startIsolatedBridge();
    const prompt = await bridge.pairing();
    bridgeId = bridge.bridgeIdFile();
    const link = await decodeLink(prompt);
    expect(link.request.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(link.request.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    await login(page);
    // The page's clock is past the link's expiry (the bridge's own 10-minute window is not waited out here).
    await page.clock.install({ time: new Date(link.request.expiresAt + 60_000) });
    await openPairLink(page, prompt.link);
    await expect(page.getByText("This pairing link has expired.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve with passkey" })).toHaveCount(0);
    expect((await serverLedger()).checkpoint.bridges.some(item => item.bridgeId === bridgeId)).toBe(false);
  } finally {
    await retire(bridge, bridgeId);
  }
});
