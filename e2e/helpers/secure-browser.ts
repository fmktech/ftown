import { expect, test as base, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { ApplicationJson, BridgeInvitation } from "../../bridge/src/security/protocol.js";
import { readBridgePointer } from "./bridge-api";
import { BRIDGE_HOME, E2E_DIR, UI_BASE_URL } from "./config";

interface LocalCli {
  securityCommand(pointer: unknown, type: "security_devices" | "security_invite" | "security_revoke", payload?: Record<string, ApplicationJson>): Promise<ApplicationJson>;
}
const approvals = new Map<string, { endpointId: string; bridgeHome?: string }[]>();
class InvitationPageError extends Error {}
async function failOnInvitationAlert<T>(page: Page, step: Promise<T>): Promise<T> {
  const invitation = page.getByRole("main").locator("section").filter({ has: page.getByRole("heading", { name: "Approve this browser", exact: true }) });
  const alert = invitation.getByRole("alert").filter({ hasText: /\S/ }).first();
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    const check = async () => {
      if (finished) return;
      try {
        if (await alert.isVisible()) {
          if (!finished) reject(new InvitationPageError("Real encrypted browser invitation pairing failed: /connect reported an error"));
          return;
        }
      } catch {
        // Navigation can destroy the old document while the successful step settles.
      }
      if (!finished) timer = setTimeout(() => { void check(); }, 50);
    };
    void check();
  });
  try { return await Promise.race([step, failure]); }
  finally { finished = true; clearTimeout(timer); }
}
export async function cleanupBrowserApprovals(testId: string): Promise<void> {
  const owned = approvals.get(testId) ?? []; approvals.delete(testId);
  const failures: unknown[] = [];
  for (const approval of owned) try { await bridgeSecurityCommand("security_revoke", { endpointId: approval.endpointId }, approval.bridgeHome); }
  catch (error) { failures.push(error); }
  if (failures.length) throw new Error(`Could not revoke ${failures.length} task-created browser approvals`);
}

/** Uses the production OS-local CLI authority and encrypted command path. */
export async function bridgeSecurityCommand(type: "security_devices" | "security_invite" | "security_revoke", payload: Record<string, ApplicationJson> = {}, bridgeHome = BRIDGE_HOME): Promise<ApplicationJson> {
  const cli = await import(pathToFileURL(join(E2E_DIR, "..", "bridge", "dist", "cli-client.js")).href) as LocalCli;
  return cli.securityCommand(readBridgePointer(bridgeHome), type, payload);
}

/** Pair through /connect and explicit browser approval; no plaintext test mode. */
export async function pairBrowser(page: Page, options: { bridgeHome?: string; origin?: string; label?: string; email?: string; password?: string } = {}): Promise<void> {
  const invitation = await bridgeSecurityCommand("security_invite", { label: options.label ?? "E2E browser" }, options.bridgeHome) as unknown as BridgeInvitation;
  const origin = options.origin ?? UI_BASE_URL;
  try {
    await page.goto(`${origin}/connect#invite=${encodeURIComponent(JSON.stringify(invitation))}`);
    await expect(page.getByRole("heading", { name: "Approve this browser" })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/connect`);
    await failOnInvitationAlert(page, page.locator("#invite-email").or(page.getByRole("button", { name: "Approve browser and connect" })).first().waitFor({ state: "visible", timeout: 45000 }));
    if (await page.locator("#invite-email").isVisible()) {
      if (!options.email || !options.password) throw new Error("Invitation requires the matching account login");
      await page.locator("#invite-email").fill(options.email);
      await page.locator("#invite-password").fill(options.password);
      await page.getByRole("button", { name: "Sign in to approve" }).click();
      await failOnInvitationAlert(page, page.getByRole("button", { name: "Approve browser and connect" }).waitFor({ state: "visible", timeout: 45000 }));
    }
    await page.getByPlaceholder("e.g. My phone").fill(options.label ?? "E2E browser");
    await page.getByRole("button", { name: "Approve browser and connect" }).click();
    await failOnInvitationAlert(page, page.waitForURL(invitation.ownerId.startsWith("solo:") ? "**/local" : "**/dashboard", { timeout: 45000 }));
    const endpointId = await browserEndpointId(page, invitation.ownerId);
    const testId = base.info().testId;
    const owned = approvals.get(testId) ?? [];
    if (!owned.some(item => item.endpointId === endpointId && item.bridgeHome === options.bridgeHome)) owned.push({ endpointId, bridgeHome: options.bridgeHome });
    approvals.set(testId, owned);
  } catch (error) {
    // Avoid including a fragment-bearing URL or secret in fixture error output.
    if (error instanceof InvitationPageError) throw error;
    throw new Error("Real encrypted browser invitation pairing failed");
  }
}

export async function browserEndpointId(page: Page, ownerId?: string): Promise<string> {
  return page.evaluate(async owner => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ftown-endpoint-security", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Browser identity storage unavailable")); });
    try {
      const identities = await new Promise<{ endpoint: { id: string; ownerId: string }; keyPair: { privateKey: CryptoKey } }[]>((resolve, reject) => { const request = db.transaction("identities").objectStore("identities").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Browser identity unavailable")); });
      const matching = owner ? identities.filter(identity => identity.endpoint.ownerId === owner) : identities;
      if (matching.length !== 1) throw new Error("Expected exactly one matching account identity in this isolated browser");
      if (!(matching[0].keyPair?.privateKey instanceof CryptoKey) || matching[0].keyPair.privateKey.type !== "private" || matching[0].keyPair.privateKey.extractable !== false) {
        throw new Error("Expected a non-extractable private CryptoKey in browser identity storage");
      }
      return matching[0].endpoint.id;
    } finally { db.close(); }
  }, ownerId);
}
