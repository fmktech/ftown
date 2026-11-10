import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_DIR, UI_BASE_URL } from "./config";

/**
 * Passkeys in Playwright: Chrome's virtual authenticator over CDP.
 *
 * The server holds exactly ONE account. The Playwright `setup` project
 * (tests/account.setup.ts) creates it through the real /login page with a
 * virtual-authenticator passkey, then exports that credential to
 * e2e/.run-account.json. Every other browser context models "the same synced
 * passkey on another device": it imports the credential into its own virtual
 * authenticator and signs in as a NEW browser (identify + add this browser).
 */

/** A credential as returned by WebAuthn.getCredentials (privateKey: base64 PKCS#8; userHandle: base64). */
export interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

export interface RunAccount {
  accountId: string;
  origin: string;
  credential: VirtualCredential;
}

export const RUN_ACCOUNT_FILE = join(E2E_DIR, ".run-account.json");
export const RP_ID = process.env.NEXT_PUBLIC_FTOWN_RP_ID ?? new URL(UI_BASE_URL).hostname;
export const BOOTSTRAP_SECRET = process.env.FTOWN_BOOTSTRAP_SECRET ?? "";

export function readRunAccount(): RunAccount {
  if (!existsSync(RUN_ACCOUNT_FILE)) throw new Error("e2e/.run-account.json is missing: run the Playwright 'setup' project first");
  const parsed = JSON.parse(readFileSync(RUN_ACCOUNT_FILE, "utf8")) as RunAccount;
  if (typeof parsed.accountId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(parsed.accountId)) throw new Error("invalid .run-account.json");
  return parsed;
}

export function writeRunAccount(account: RunAccount): void {
  // Test-only passkey of a throwaway account in a throwaway database.
  writeFileSync(RUN_ACCOUNT_FILE, JSON.stringify(account, null, 2), { mode: 0o600 });
}

/** The run's account id: the channel suffix (`…#<accountId>`) and the relay token `sub`. */
export function sharedAccountId(): string {
  return process.env.E2E_ACCOUNT_ID ?? readRunAccount().accountId;
}

export interface VirtualAuthenticator {
  cdp: CDPSession;
  authenticatorId: string;
  credentials(): Promise<VirtualCredential[]>;
  addCredential(credential: VirtualCredential): Promise<void>;
  /** Simulate the user dismissing the OS prompt (no presence) for the next ceremonies. */
  setPresence(present: boolean): Promise<void>;
}

const authenticators = new WeakMap<Page, Promise<VirtualAuthenticator>>();

/** One ctap2 internal platform authenticator (resident keys, UV) attached to this page. Idempotent per page. */
export function virtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  let existing = authenticators.get(page);
  if (!existing) {
    existing = (async () => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable", { enableUI: false });
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      return {
        cdp,
        authenticatorId,
        async credentials() {
          const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
          return credentials as VirtualCredential[];
        },
        async addCredential(credential) {
          await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { ...credential, isResidentCredential: true, rpId: credential.rpId ?? RP_ID } });
        },
        async setPresence(present) {
          await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: present });
        },
      } satisfies VirtualAuthenticator;
    })();
    authenticators.set(page, existing);
  }
  return existing;
}

/** This page's authenticator, holding the run account's (synced) passkey. */
export async function withAccountPasskey(page: Page, account: RunAccount = readRunAccount()): Promise<VirtualAuthenticator> {
  const authenticator = await virtualAuthenticator(page);
  const held = await authenticator.credentials();
  if (!held.some(credential => credential.credentialId === account.credential.credentialId)) {
    await authenticator.addCredential(account.credential);
  }
  return authenticator;
}

const sources = new WeakMap<BrowserContext, Promise<void>>();

/**
 * One logical proxied client per browser context. The UI trusts x-real-ip
 * (FTOWN_TRUSTED_PROXY=1, test-only), so contexts do not share the per-IP
 * nonce / ledger-write / ledger-read budgets. Scoped to this UI's /api only.
 */
export async function isolateClientSource(context: BrowserContext): Promise<void> {
  let installed = sources.get(context);
  if (!installed) {
    const source = `2001:db8:${randomBytes(12).toString("hex").match(/.{4}/g)!.join(":")}`;
    installed = context.route(`${UI_BASE_URL}/api/**`, async route => {
      await route.continue({ headers: { ...route.request().headers(), "x-real-ip": source } });
    }).then(() => undefined);
    sources.set(context, installed);
  }
  await installed;
}

/**
 * First-time setup through the real /login page: passkey + genesis + this
 * browser, with the bootstrap secret. Returns the accountId (from the session).
 */
export async function createAccountViaUi(page: Page, labels: { passkey: string; browser: string } = { passkey: "E2E passkey", browser: "E2E setup browser" }): Promise<string> {
  await isolateClientSource(page.context());
  await virtualAuthenticator(page);
  await page.goto("/login");
  await page.getByText("First time setup", { exact: true }).click();
  await page.locator("#passkey-label").fill(labels.passkey);
  await page.locator("#create-device-label").fill(labels.browser);
  await page.locator("#bootstrap").fill(BOOTSTRAP_SECRET);
  await page.getByRole("button", { name: "1. Create passkey" }).click();
  const sign = page.getByRole("button", { name: "2. Sign the account" });
  await expect(sign).toBeEnabled();
  await sign.click();
  const add = page.getByRole("button", { name: "3. Add this browser" });
  await expect(add).toBeEnabled();
  await add.click();
  await failOnLoginError(page, page.waitForURL("**/dashboard", { timeout: 30_000 }));
  return sessionAccountId(page);
}

/** The accountId of the page's session (POST /api/auth/token mints for it and echoes it). */
export async function sessionAccountId(page: Page): Promise<string> {
  const response = await page.request.post(`${UI_BASE_URL}/api/auth/token`);
  if (!response.ok()) throw new Error(`/api/auth/token failed: ${response.status()}`);
  const body = (await response.json()) as { accountId?: string };
  if (typeof body.accountId !== "string") throw new Error("/api/auth/token returned no accountId");
  return body.accountId;
}

/** Races a step against the /login error alert so a product error fails fast with its message. */
async function failOnLoginError<T>(page: Page, step: Promise<T>): Promise<T> {
  const alert = page.locator("#login-error");
  let done = false;
  const failure = (async () => {
    while (!done) {
      try {
        if (await alert.isVisible()) {
          const text = (await alert.textContent()) ?? "";
          if (!done) throw new Error(`/login reported an error: ${text.trim()}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("/login reported")) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return undefined as never;
  })();
  try { return await Promise.race([step, failure]); } finally { done = true; failure.catch(() => {}); }
}

/**
 * Sign `page` in with the run account's passkey and land on /dashboard.
 * A browser this context already enrolled signs in silently (device-key proof on
 * mount); a new one runs identify (passkey #1) + add this browser (passkey #2).
 */
export async function signIn(page: Page, options: { browserLabel?: string; account?: RunAccount } = {}): Promise<{ enrolled: string | null }> {
  await isolateClientSource(page.context());
  await withAccountPasskey(page, options.account);
  await page.goto("/login");
  const signInButton = page.getByRole("button", { name: "Sign in with passkey" });
  const addButton = page.getByRole("button", { name: "Add this browser" });
  await failOnLoginError(page, Promise.race([
    page.waitForURL("**/dashboard", { timeout: 30_000 }),
    signInButton.waitFor({ state: "visible", timeout: 30_000 }),
  ]));
  if (/\/dashboard/.test(new URL(page.url()).pathname)) return { enrolled: null };
  await signInButton.click();
  await failOnLoginError(page, Promise.race([
    page.waitForURL("**/dashboard", { timeout: 30_000 }),
    addButton.waitFor({ state: "visible", timeout: 30_000 }),
  ]));
  if (/\/dashboard/.test(new URL(page.url()).pathname)) return { enrolled: null };
  await page.locator("#device-label").fill(options.browserLabel ?? `E2E browser ${randomBytes(3).toString("hex")}`);
  await addButton.click();
  await failOnLoginError(page, page.waitForURL("**/dashboard", { timeout: 30_000 }));
  const endpointId = await browserEndpointId(page, (options.account ?? readRunAccount()).accountId);
  trackEnrolledBrowser(endpointId);
  return { enrolled: endpointId };
}

const enrolled = new Map<string, Set<string>>();
function trackEnrolledBrowser(endpointId: string): void {
  let testId: string;
  try { testId = test.info().testId; } catch { return; }
  const owned = enrolled.get(testId) ?? new Set<string>();
  owned.add(endpointId);
  enrolled.set(testId, owned);
}
/** Browsers (ledger devices) this test enrolled through signIn(); the suite fixture revokes them afterwards. */
export function takeEnrolledBrowsers(testId: string): string[] {
  const owned = enrolled.get(testId);
  enrolled.delete(testId);
  return owned ? [...owned] : [];
}

/** The browser's endpoint id for the account (its ledger device id), from IndexedDB; asserts the key is non-extractable. */
export async function browserEndpointId(page: Page, accountId: string = sharedAccountId()): Promise<string> {
  return page.evaluate(async owner => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ftown-endpoint-security"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Browser identity storage unavailable")); });
    try {
      const identity = await new Promise<{ endpoint: { id: string; ownerId: string }; keyPair: { privateKey: CryptoKey } } | undefined>((resolve, reject) => { const request = db.transaction("identities").objectStore("identities").get(owner); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Browser identity unavailable")); });
      if (!identity || identity.endpoint.ownerId !== owner) throw new Error("No browser identity for this account");
      if (!(identity.keyPair?.privateKey instanceof CryptoKey) || identity.keyPair.privateKey.type !== "private" || identity.keyPair.privateKey.extractable !== false) {
        throw new Error("Expected a non-extractable private CryptoKey in browser identity storage");
      }
      return identity.endpoint.id;
    } finally { db.close(); }
  }, accountId);
}

/** Approve a bridge's /pair link: type its 6-digit code and approve with the passkey. */
export async function approvePairLink(page: Page, link: string, code: string): Promise<void> {
  await withAccountPasskey(page);
  // A fragment-only change on an already-open /pair is a same-document navigation the page does not re-read.
  if (new URL(page.url() === "about:blank" ? "about:blank" : page.url()).pathname === "/pair") await page.goto("about:blank");
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Connect a computer" })).toBeVisible();
  await page.getByLabel("Code from your computer").fill(code);
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Computer added" })).toBeVisible({ timeout: 30_000 });
}
