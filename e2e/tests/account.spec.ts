import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { UI_BASE_URL } from "../helpers/config";
import { serverLedger } from "../helpers/ledger-admin";
import {
  BOOTSTRAP_SECRET, browserEndpointId, isolateClientSource, readRunAccount, signIn, virtualAuthenticator,
} from "../helpers/passkey";

/**
 * The ONE account of this server (created by tests/account.setup.ts through the
 * real first-time setup). Here: registration is closed afterwards, the synced
 * passkey signs another browser in (identify + add this browser), an enrolled
 * browser signs in again with its device key only, and UI sign-out fails closed.
 */

test("registration is closed once the account exists, even with the right setup secret", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await isolateClientSource(context);
    await virtualAuthenticator(page); // an empty authenticator: a brand-new passkey
    const before = await serverLedger();
    await page.goto("/login");
    await page.getByText("First time setup", { exact: true }).click();
    await page.locator("#passkey-label").fill("Intruder passkey");
    await page.locator("#create-device-label").fill("Intruder browser");
    await page.locator("#bootstrap").fill(BOOTSTRAP_SECRET);
    await page.getByRole("button", { name: "1. Create passkey" }).click();
    await page.getByRole("button", { name: "2. Sign the account" }).click();
    await page.getByRole("button", { name: "3. Add this browser" }).click();
    await expect(page.locator("#login-error")).toContainText("Account creation is closed", { timeout: 30_000 });
    await expect(page).toHaveURL(/\/login/);
    expect((await page.request.post(`${UI_BASE_URL}/api/auth/token`)).status()).toBe(401);
    const after = await serverLedger();
    expect(after.checkpoint.accountId).toBe(before.checkpoint.accountId);
    expect(after.checkpoint.authorities.map(a => a.label)).not.toContain("Intruder passkey");
  } finally {
    await context.close();
  }
});

test("a second browser signs in with the synced passkey, re-signs in with its device key, and UI sign-out fails closed", async ({ page }) => {
  const account = readRunAccount();
  const label = `E2E second browser ${Date.now()}`;
  await signIn(page, { browserLabel: label });

  // The session is the account and this browser's ledger device.
  const endpointId = await browserEndpointId(page);
  const session = await page.request.get("/api/auth/session");
  expect(session.status()).toBe(200);
  expect((await session.json()).user).toEqual({ id: account.accountId, endpointId });
  const token = await page.request.post("/api/auth/token");
  expect(token.status()).toBe(200);
  const minted = await token.json() as { token: string; accountId: string; expiresAt: number };
  expect(minted.accountId).toBe(account.accountId);
  const claims = JSON.parse(Buffer.from(minted.token.split(".")[1], "base64url").toString()) as { sub: string; aud: string | string[]; exp: number; iat: number };
  expect(claims.sub).toBe(account.accountId);
  expect(claims.exp - claims.iat).toBe(3600);
  const { checkpoint } = await serverLedger();
  const device = checkpoint.devices.find(item => item.endpoint.id === endpointId);
  expect(device?.label).toBe(label);
  expect(device?.endpoint.ownerId).toBe(account.accountId);

  // An enrolled browser signs in again with its device key alone: no passkey ceremony is possible here.
  const authenticator = await virtualAuthenticator(page);
  await authenticator.cdp.send("WebAuthn.clearCredentials", { authenticatorId: authenticator.authenticatorId });
  await page.context().clearCookies();
  await page.goto("/dashboard");
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
  expect((await (await page.request.get("/api/auth/session")).json()).user).toEqual({ id: account.accountId, endpointId });

  // Normal UI sign-out: the session ends, protected surfaces fail closed, and /login does NOT silently sign back in.
  const pagesBefore = page.context().pages();
  await page.getByRole("button", { name: `Account: ${account.accountId}`, exact: true }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.waitForURL("**/login**");
  const signedOut = await page.request.get("/api/auth/session");
  expect(signedOut.status()).toBe(200);
  expect((await signedOut.json())?.user).toBeUndefined();
  expect((await page.request.post("/api/auth/token")).status()).toBe(401);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  expect(page.context().pages()).toEqual(pagesBefore);

  // Signing in again with the passkey reuses this browser's ledger entry (one ceremony, no new device).
  await authenticator.addCredential(account.credential);
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
  expect((await (await page.request.get("/api/auth/session")).json()).user).toEqual({ id: account.accountId, endpointId });
  expect((await serverLedger()).checkpoint.devices.filter(item => item.label === label).map(item => item.endpoint.id)).toEqual([endpointId]);
});
