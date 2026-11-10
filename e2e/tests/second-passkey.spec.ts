import { expect, type CDPSession } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { login } from "../helpers/app";
import { ledgerCredentialId, revokeDevices, serverLedger } from "../helpers/ledger-admin";
import { browserEndpointId, readRunAccount, RP_ID, signIn, virtualAuthenticator, type VirtualCredential } from "../helpers/passkey";

/**
 * Adding a second passkey (authority) is PERMANENT (authorities are add-only), and
 * once an account has two passkeys every browser must first "Choose passkey"
 * before it can sign. This spec therefore runs in its own project, after the
 * whole suite (playwright.config.ts `second-passkey`).
 *
 * The second passkey lives on a second virtual authenticator of the same page
 * (a security key next to the platform passkey).
 */
test("a second passkey joins the account (create + consent + approval) and alone can sign a new browser in", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const account = readRunAccount();
  await login(page, { browserLabel: "E2E authority browser" });
  const before = (await serverLedger()).checkpoint.authorities.map(item => item.credentialId);
  expect(before).toContain(ledgerCredentialId(account));
  const platform = await virtualAuthenticator(page);
  const cdp: CDPSession = platform.cdp;
  const { authenticatorId: securityKey } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await page.getByRole("button", { name: "Open security", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Security", exact: true });
  const add = dialog.getByRole("group", { name: "Add another passkey", exact: true });
  await expect(add).toBeVisible({ timeout: 30_000 });
  await add.getByLabel("New passkey name").fill("E2E security key");
  // Step 1: only the security key answers the create ceremony (the platform authenticator holds an excluded credential).
  await platform.setPresence(false);
  await add.getByRole("button", { name: "Create passkey", exact: true }).click();
  // Step 2: the NEW passkey consents to joining this account.
  await add.getByRole("button", { name: "Confirm new passkey", exact: true }).click();
  // Step 3: an EXISTING passkey approves it.
  await platform.setPresence(true);
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: securityKey, enabled: false });
  await add.getByRole("button", { name: "Approve new passkey", exact: true }).click();

  const keyCredentials = (await cdp.send("WebAuthn.getCredentials", { authenticatorId: securityKey })).credentials as VirtualCredential[];
  expect(keyCredentials).toHaveLength(1);
  const newCredentialId = Buffer.from(keyCredentials[0].credentialId, "base64").toString("base64url");
  await expect.poll(async () => (await serverLedger()).checkpoint.authorities.map(item => item.credentialId), { timeout: 30_000 })
    .toEqual([...before, newCredentialId]);
  const { ledger, checkpoint } = await serverLedger();
  expect(checkpoint.authorities.at(-1)?.label).toBe("E2E security key");
  const record = ledger.transitions.find(item => item.payload.operation.type === "add_authority"
    && item.payload.operation.authority.credentialId === newCredentialId);
  expect(record?.payload.credentialId, "approved by the existing passkey").toBe(ledgerCredentialId(account));
  await expect(dialog.getByRole("list", { name: "Account passkeys" }).getByText("E2E security key", { exact: true })).toBeVisible();

  // The security key ALONE signs a brand-new browser in (identify by its handle + add_device signed by it).
  const context = await browser.newContext();
  let enrolled: string | null = null;
  try {
    const other = await context.newPage();
    await signIn(other, { browserLabel: "E2E security-key browser", account: { ...account, credential: { ...keyCredentials[0], rpId: keyCredentials[0].rpId ?? RP_ID } } });
    enrolled = await browserEndpointId(other, account.accountId);
    const after = await serverLedger();
    const added = after.ledger.transitions.find(item => item.payload.operation.type === "add_device" && item.payload.operation.device.endpoint.id === enrolled);
    expect(added?.payload.credentialId).toBe(newCredentialId);
    expect((await other.request.post("/api/auth/token")).status()).toBe(200);
  } finally {
    await context.close();
    if (enrolled) await revokeDevices([enrolled]);
  }
});
