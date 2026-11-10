import { expect, type Page } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { UI_BASE_URL } from "../helpers/config";
import { serverLedger } from "../helpers/ledger-admin";
import { browserEndpointId, readRunAccount, signIn, virtualAuthenticator } from "../helpers/passkey";
import { createSecondAccount } from "../helpers/second-account";

/**
 * Accounts on a multi-account server. The shared account A was created by
 * tests/account.setup.ts through the real /login "Create an account" form.
 * Here: anyone can create a second, independent account B (each signs in and
 * sees only its own computers), the synced passkey signs another browser in
 * (identify + add this browser), an enrolled browser signs in again with its
 * device key only, and UI sign-out fails closed. Cross-account isolation in
 * depth: account-isolation.spec.ts.
 */

/** The dashboard header's computer count ("<n> bridges; <m> encrypted connections ready") once the relay is connected; -1 while unreadable. */
async function computerCount(page: Page): Promise<number> {
  try {
    if (!await page.getByRole("group", { name: "Cloud connected", exact: true }).isVisible()) return -1;
    const label = await page.getByRole("img", { name: /^\d+ bridges; \d+ encrypted connections ready$/ }).getAttribute("aria-label", { timeout: 2000 });
    const count = /^(\d+) bridges;/.exec(label ?? "")?.[1];
    return count === undefined ? -1 : Number(count);
  } catch { return -1; }
}

test("a second account can be created, and both accounts work independently", async ({ browser, page }) => {
  const a = readRunAccount();
  const aBefore = await serverLedger();
  const name = `E2E account name ${Date.now()}`;
  const b = await createSecondAccount(browser, { name, passkeyLabel: "E2E B passkey", browserLabel: "E2E B browser" });
  try {
    // B is its own account: its own genesis, passkey and first device; A's chain is untouched by B's creation.
    expect(b.accountId).not.toBe(a.accountId);
    expect((await b.page.request.get("/api/auth/session").then(response => response.json())).user).toEqual({ id: b.accountId, endpointId: b.endpointId });
    const minted = await b.page.request.post(`${UI_BASE_URL}/api/auth/token`).then(response => response.json()) as { token: string; accountId: string };
    expect(minted.accountId).toBe(b.accountId);
    expect(JSON.parse(Buffer.from(minted.token.split(".")[1], "base64url").toString()).sub).toBe(b.accountId);
    const bLedger = await serverLedger(b.account);
    expect(bLedger.checkpoint.accountId).toBe(b.accountId);
    expect(bLedger.checkpoint.authorities.map(item => item.label)).toEqual(["E2E B passkey"]);
    expect(bLedger.checkpoint.devices.map(item => [item.endpoint.id, item.label, item.endpoint.ownerId])).toEqual([[b.endpointId, "E2E B browser", b.accountId]]);
    expect(bLedger.checkpoint.bridges).toEqual([]);
    expect(bLedger.ledger.genesis.payload.handle).not.toBe(aBefore.ledger.genesis.payload.handle);
    expect((await serverLedger()).checkpoint.head).toBe(aBefore.checkpoint.head);
    // The account name is the passkey's WebAuthn user name only (so passkeys of different accounts are distinguishable in
    // the OS picker): it is not part of the signed account.
    expect(b.account.credential.userName).toBe(name);
    expect(readRunAccount().credential.userName).not.toBe(name);
    expect(JSON.stringify(bLedger.ledger)).not.toContain(name);

    // Each account sees only its own computers: B has none yet, A keeps its two shared bridges.
    await b.page.goto("/dashboard");
    await expect.poll(() => computerCount(b.page), { timeout: 30_000 }).toBe(0);
    await signIn(page, { browserLabel: `E2E account A browser ${Date.now()}` });
    await expect.poll(() => computerCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    expect(await computerCount(b.page), "A's computers never show up for B").toBe(0);
    expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(a.accountId);

    // B signs out and back in with its own passkey (its enrolled browser: one ceremony, no new device).
    await b.page.getByRole("button", { name: `Account: ${b.accountId}`, exact: true }).click();
    await b.page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await b.page.waitForURL("**/login**");
    expect((await b.page.request.post(`${UI_BASE_URL}/api/auth/token`)).status()).toBe(401);
    expect(await signIn(b.page, { account: b.account })).toEqual({ enrolled: null });
    expect((await (await b.page.request.get("/api/auth/session")).json()).user).toEqual({ id: b.accountId, endpointId: b.endpointId });
    await expect.poll(() => computerCount(b.page), { timeout: 30_000 }).toBe(0);
    expect((await serverLedger(b.account)).checkpoint.head).toBe(bLedger.checkpoint.head);
    // Neither ledger lists the other account's browsers.
    const aAfter = (await serverLedger()).checkpoint;
    expect(aAfter.devices.map(item => item.endpoint.id)).not.toContain(b.endpointId);
    expect(aAfter.devices.every(item => item.endpoint.ownerId === a.accountId)).toBe(true);
  } finally {
    await b.close();
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
