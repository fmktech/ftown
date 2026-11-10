import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "../helpers/fixtures";
import { login } from "../helpers/app";
import { bridgeApiFetch, tryReadBridgePointer } from "../helpers/bridge-api";
import { E2E_DIR } from "../helpers/config";
import { importAuthKey, requestRelayToken, serverLedger, signProof } from "../helpers/ledger-admin";
import { startIsolatedBridge, type IsolatedBridge } from "../helpers/ledger-bridge";
import { approvePairLink, readRunAccount } from "../helpers/passkey";

type PairingModule = typeof import("../../bridge/src/security/ledger/pairing");
const pairing = () => import(pathToFileURL(join(E2E_DIR, "..", "bridge", "dist", "security", "ledger", "pairing.js")).href) as Promise<PairingModule>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Copied from the product (SecurityDevices REMOVE_CONFIRM, revoked-restart.ts) so a copy change fails here.
const removeConfirm = (label: string) => `Remove ${label} from your account? It loses access immediately. To use it again, pair it as a new computer.`;
const REMOVED_MESSAGE = "This computer was removed from your ftown account. Creating a new identity; pair it again with the link below.";

interface LedgerIdentityFile { authPrivateKey: JsonWebKey; endpoint?: { id: string } }

test("removing a computer in Security: the bridge re-execs as a new identity with a new link, and its old key is refused", async ({ page }, info) => {
  test.setTimeout(240_000);
  const account = readRunAccount();
  let bridge: IsolatedBridge | null = null;
  try {
    bridge = await startIsolatedBridge();
    const prompt = await bridge.pairing();
    const bridgeId = bridge.bridgeIdFile();
    expect(bridgeId).toMatch(UUID_V4);
    await login(page, { browserLabel: "E2E removal browser" });
    await approvePairLink(page, prompt.link, prompt.code);
    await expect.poll(() => bridge!.output(), { timeout: 30_000 }).toContain("Paired with account");
    const identity = JSON.parse(readFileSync(join(bridge.dataDir, "security", "ledger-identity.json"), "utf8")) as LedgerIdentityFile;
    const oldKey = await importAuthKey(identity.authPrivateKey);

    // "Paired with account" precedes the account startup after which the bridge publishes its local API pointer, so wait
    // for THIS process's pointer for THIS identity before calling the API (bridgeApiFetch throws without one).
    await expect.poll(() => {
      const pointer = tryReadBridgePointer(bridge!.home);
      return pointer && { pid: pointer.pid, bridgeId: pointer.bridgeId };
    }, { timeout: 30_000, message: "The paired bridge must publish its local API pointer" }).toEqual({ pid: bridge.pid, bridgeId });

    // A session on this computer survives the identity reset (tmux keeps it).
    await expect.poll(async () => (await bridgeApiFetch("GET", "/api/sessions", { bridgeHome: bridge!.home })).status, { timeout: 30_000 }).toBe(200);
    const created = await bridgeApiFetch("POST", "/api/sessions", { bridgeHome: bridge.home, body: { shellType: "shell", name: `REMOVAL_SURVIVOR_${Date.now()}` } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sessionId = (created.body as { session: { id: string } }).session.id;
    await expect.poll(() => bridge!.hasTmuxSession(sessionId), { timeout: 30_000 }).toBe(true);

    // Before removal the bridge's key earns a relay token.
    const before = await requestRelayToken(await signProof(oldKey, { accountId: account.accountId, kind: "bridge", keyId: bridgeId!, purpose: "relay" }));
    expect(before.status, JSON.stringify(before.body)).toBe(200);

    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Open security", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Security", exact: true });
    const computer = dialog.locator(`[data-computer-access="${bridgeId}"]`);
    await expect(computer).toBeVisible({ timeout: 60_000 });
    await computer.click();
    const remove = dialog.getByRole("button", { name: /^Remove computer / });
    await expect(remove).toBeEnabled({ timeout: 60_000 });
    const label = ((await remove.getAttribute("aria-label")) ?? "").replace(/^Remove computer /, "");
    expect(label).not.toBe("");
    await remove.click();
    const confirmation = dialog.getByRole("group", { name: "Confirm computer removal", exact: true });
    await expect(confirmation.getByText(removeConfirm(label), { exact: true })).toBeVisible();
    await confirmation.getByRole("button", { name: "Confirm remove computer", exact: true }).click();
    await expect(confirmation).toBeHidden({ timeout: 30_000 });

    // (a) The signed ledger records the removal. (The browser adopts its own signed revocation before the POST
    // returns, so the confirmation can disappear first: wait for the server's copy.)
    await expect.poll(async () => (await serverLedger()).checkpoint.revokedBridgeIds.includes(bridgeId!), { timeout: 30_000 }).toBe(true);
    const { ledger, checkpoint } = await serverLedger();
    expect(checkpoint.bridges.some(item => item.bridgeId === bridgeId)).toBe(false);
    expect(checkpoint.revokedBridgeIds).toContain(bridgeId);
    expect(ledger.transitions.some(record => record.payload.operation.type === "revoke_bridge" && record.payload.operation.bridgeId === bridgeId)).toBe(true);
    await expect(dialog.getByText("This computer was removed from your account. To use it again, pair it as a new computer.")).toBeVisible({ timeout: 30_000 });

    // (b) The bridge process re-execs in place (same PID) with a new identity and prints a NEW pairing link for it.
    let newBridgeId = "";
    await expect.poll(() => {
      const current = bridge!.bridgeIdFile();
      if (current && current !== bridgeId) newBridgeId = current;
      return newBridgeId;
    }, { timeout: 90_000, message: "The bridge must write a new bridge-id after the signed revocation" }).toMatch(UUID_V4);
    expect(bridge.running(), "The bridge must re-exec in place, never exit").toBe(true);
    const removedAt = bridge.output().indexOf(REMOVED_MESSAGE);
    expect(removedAt, "The bridge must announce the removal").toBeGreaterThanOrEqual(0);
    await expect.poll(() => bridge!.output().slice(removedAt).includes(`[Bridge] New identity for this computer: ${bridgeId} -> ${newBridgeId}`), { timeout: 15_000 }).toBe(true);
    const fresh = await bridge.pairing({ afterOffset: removedAt, timeoutMs: 30_000 });
    expect(fresh.link).not.toBe(prompt.link);
    expect((await (await pairing()).parsePairLink(new URL(fresh.link).hash)).request.bridgeId).toBe(newBridgeId);
    expect(await bridge.hasTmuxSession(sessionId), "Sessions must survive the identity reset").toBe(true);
    // The pre-exec shutdown unlinks the revoked identity's pointer and the unpaired image publishes none until it is paired
    // again, so no CLI is pointed at the revoked identity's port and token.
    expect(tryReadBridgePointer(bridge.home), "The revoked identity's local API pointer must not outlive the re-exec").toBeNull();

    // (c) The old key is refused for relay tokens, with the signed evidence.
    const after = await requestRelayToken(await signProof(oldKey, { accountId: account.accountId, kind: "bridge", keyId: bridgeId!, purpose: "relay" }));
    expect(after.status).toBe(401);
    expect(after.body.error).toBe("key_revoked");
    expect(after.body.token).toBeUndefined();
    const evidence = after.body.ledger as { transitions: { payload: { operation: { type: string; bridgeId?: string } } }[] };
    expect(evidence.transitions.some(record => record.payload.operation.type === "revoke_bridge" && record.payload.operation.bridgeId === bridgeId)).toBe(true);

    // (d) The browser no longer lists it as a computer of the account.
    await page.getByRole("button", { name: "Close security", exact: true }).click();
    await expect(page.locator(`[data-bridge-row="${bridgeId}"]`)).toHaveCount(0, { timeout: 60_000 });
  } catch (error) {
    if (bridge) await info.attach("removed-bridge.log", { body: bridge.output(), contentType: "text/plain" });
    throw error;
  } finally {
    await bridge?.stop();
  }
});
