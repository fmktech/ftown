import { expect, type BrowserContext } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "../helpers/fixtures";
import { approveAccountComputer, waitForComputerTrust } from "../helpers/account-pairing";
import { bridgeApiFetch } from "../helpers/bridge-api";
import { login, makeUser, registerUser } from "../helpers/app";
import { mintBridgeBootstrapToken } from "../helpers/jwt";
import { browserAccountRoster, enrollmentLinkBridgeId, startRevocableAccountBridge, type RevocableAccountBridge } from "../helpers/bridge-revocation";

const origin = process.env.FTOWN_PUBLIC_URL ?? "https://localhost:8444";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Copied from the frozen contract (C6 REMOVE_CONFIRM, C13 revoked restart) so a copy change fails here.
const removeConfirm = (label: string) => `Remove ${label} from your account? It loses access immediately. To use it again, pair it as a new computer.`;
const REMOVED_MESSAGE = "This computer was removed from your ftown account. Creating a new identity; pair it again with the link below.";

type Operation = { type?: string; bridgeId?: string };
type HistoryBody = { history?: { transitions?: { payload?: { operation?: Operation } }[] } };
const lastOperation = (body: HistoryBody) => body.history?.transitions?.at(-1)?.payload?.operation;

test("removing a computer revokes it for every browser and the bridge re-pairs as a new identity", async ({ browser }, info) => {
  test.setTimeout(240000);
  const user = makeUser("revocation"); await registerUser(user.email, user.password);
  const contexts: BrowserContext[] = []; const bridges: RevocableAccountBridge[] = []; let primaryFailed = false;
  try {
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 } }); contexts.push(context);
    const page = await context.newPage(); await login(page, user.email, user.password, { pairBridge: false });
    const bridge = await startRevocableAccountBridge(origin); bridges.push(bridge);
    const bridgeId = await approveAccountComputer(page, bridge);
    expect(bridge.bridgeIdFile()).toBe(bridgeId);
    // The bridge resets only on evidence it verifies against its own pinned account state.
    await waitForComputerTrust(page, bridge.home);
    const created = await bridgeApiFetch("POST", "/api/sessions", { bridgeHome: bridge.home, body: { shellType: "shell", name: `REVOKE_SURVIVOR_${Date.now()}` } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sessionId = (created.body as { session: { id: string } }).session.id;
    await expect.poll(() => bridge.hasTmuxSession(sessionId), { timeout: 30000, message: "The session must run in the bridge's tmux server" }).toBe(true);

    await page.getByRole("button", { name: "Open security", exact: true }).click();
    await expect(page.getByRole("list", { name: "Account devices", exact: true })).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "Security", exact: true });
    const computer = dialog.locator(`[data-computer-access="${bridgeId}"]`);
    await expect(computer).toBeVisible({ timeout: 60000 });
    await computer.click();
    const label = (await computer.locator("span.font-semibold").first().textContent())?.trim() ?? "";
    expect(label, "The computer card must show its label").not.toBe("");
    const remove = dialog.getByRole("button", { name: `Remove computer ${label}`, exact: true });
    await expect(remove).toBeEnabled({ timeout: 60000 });
    await remove.click();
    const confirmation = dialog.getByRole("group", { name: "Confirm computer removal", exact: true });
    await expect(confirmation.getByText(removeConfirm(label), { exact: true })).toBeVisible();
    const oldRefreshToken = bridge.refreshTokenFile();
    expect(oldRefreshToken, "The paired bridge must hold a refresh token before removal").toBeTruthy();
    await confirmation.getByRole("button", { name: "Confirm remove computer", exact: true }).click();
    // The confirmation closes only after the signed revoke_bridge append succeeded.
    await expect(confirmation).toBeHidden({ timeout: 30000 });

    // (a) The browser no longer trusts the computer.
    await expect.poll(async () => {
      const roster = await browserAccountRoster(page);
      return roster && { member: roster.bridges.includes(bridgeId), revoked: roster.revokedBridgeIds.includes(bridgeId) };
    }, { timeout: 30000, message: "The browser's verified account roster must tombstone the computer" }).toEqual({ member: false, revoked: true });
    await expect(remove).toHaveCount(0);
    await expect.poll(async () => await computer.count() === 0 ? "gone" : await computer.getAttribute("aria-label", { timeout: 1000 }).catch(() => "") ?? "",
      { message: "A removed computer is either gone or blocked in the Security panel" }).toMatch(/^gone$|: Access needs attention\. /);
    const account = await page.request.get(`${origin}/api/security/account`);
    expect(account.status()).toBe(200);
    expect(lastOperation(await account.json() as HistoryBody)).toEqual({ type: "revoke_bridge", bridgeId });

    // (b) The bridge process replaces its identity in place and returns to fragment-link pairing.
    let newBridgeId = "";
    await expect.poll(() => {
      const current = bridge.bridgeIdFile();
      if (current && current !== bridgeId) newBridgeId = current;
      return newBridgeId;
    }, { timeout: 90000, message: "The bridge must write a new bridge-id after the signed revocation" }).toMatch(UUID_V4);
    const link = await bridge.link();
    expect(enrollmentLinkBridgeId(link), "The new pairing link must enroll the new identity").toBe(newBridgeId);
    expect(bridge.running(), "The bridge must re-exec in place, never exit").toBe(true);
    await expect.poll(() => {
      const output = bridge.output(); const start = output.indexOf(REMOVED_MESSAGE);
      const after = start === -1 ? "" : output.slice(start);
      return { removed: start !== -1, identity: after.includes(`[Bridge] New identity for this computer: ${bridgeId} -> ${newBridgeId}`),
        fragment: after.includes("Waiting for encrypted computer approval.") };
    }, { timeout: 15000, message: "The bridge must announce the removal, its new identity and the private-link pairing" }).toEqual({ removed: true, identity: true, fragment: true });
    expect(bridge.refreshTokenFile(), "The revoked refresh token must be deleted").toBeNull();
    expect(existsSync(join(bridge.dataDir, "security", "pending-approval-status.json")), "The reset must never select pending-v1 approval").toBe(false);
    const approvals = await page.request.get(`${origin}/api/security/approvals`);
    expect(approvals.status()).toBe(200);
    const inbox = await approvals.json() as { requests: { request: { kind?: string } }[] };
    expect(inbox.requests.filter(item => item.request.kind === "bridge"), "No computer approval may reach the account inbox").toEqual([]);
    await expect(page.locator(`[data-bridge-row="${bridgeId}"]`)).toHaveCount(0, { timeout: 60000 });
    await expect(page.locator(`[data-bridge-row="${newBridgeId}"]`)).toHaveCount(0);
    expect(await bridge.hasTmuxSession(sessionId), "Sessions must survive the identity reset").toBe(true);

    // (c) The old credentials are refused, and the tombstone cannot be re-bootstrapped.
    const refresh = await page.request.post(`${origin}/api/auth/bridge/refresh`, { data: { refreshToken: oldRefreshToken, bridgeId, hostname: "e2e-revoked-computer" } });
    expect(refresh.status()).toBe(401);
    const refused = await refresh.json() as HistoryBody & { error?: string };
    if (refused.error === "bridge_revoked") expect(lastOperation(refused), "The evidence ends at the revocation").toEqual({ type: "revoke_bridge", bridgeId });
    else expect(refused.error).toBe("Refresh token has been rotated or revoked");
    const exchange = await page.request.post(`${origin}/api/auth/bridge`, { data: { token: mintBridgeBootstrapToken(user.email), bridgeId, hostname: "e2e-revoked-computer" } });
    expect(exchange.status()).toBe(403);
    expect(await exchange.json()).toEqual({ error: "bridge_revoked" });
  } catch (error) {
    primaryFailed = true;
    for (const [index, bridge] of bridges.entries()) await info.attach(`revocable-bridge-${index}.log`, { body: bridge.output(), contentType: "text/plain" });
    throw error;
  }
  finally {
    const failures: string[] = [];
    for (const context of contexts.reverse()) try { await context.close(); } catch { failures.push("browser-context"); }
    for (const bridge of bridges.reverse()) try { await bridge.stop(); } catch { failures.push("revocable-bridge"); }
    if (failures.length && !primaryFailed) throw new Error(`Cleanup failed: ${failures.join(", ")}`);
  }
});
