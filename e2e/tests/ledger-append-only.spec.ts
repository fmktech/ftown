import { expect, type Page, type Route } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { waitForBridgeOnline } from "../helpers/app";
import { bridgeApiFetch, tryReadBridgePointer } from "../helpers/bridge-api";
import { bridgeSecurityCommand } from "../helpers/secure-browser";
import { signWithBrowserDeviceKey } from "../helpers/browser-proof";
import { UI_BASE_URL } from "../helpers/config";
import { withDb } from "../helpers/db";
import { test } from "../helpers/fixtures";
import {
  appendOperation, browserDevice, ledgerLib, offerChain, requestRelayToken, serverLedger, serverNonce, signedExtension,
} from "../helpers/ledger-admin";
import type { IsolatedBridge } from "../helpers/ledger-bridge";
import { browserEndpointId, signIn, virtualAuthenticator, type RunAccount } from "../helpers/passkey";
import { createSecondAccount, type SecondAccount } from "../helpers/second-account";

/**
 * The append-only ledger (bridge 0.22.0; CONTRACT §1–§13): every replica (server, browser, bridge) adopts another chain only
 * if it is valid and EXTENDS its own; a valid diverged chain is refused and reported; the owner resolves a divergence by
 * choosing a history. Throwaway accounts only (helpers/second-account.ts), each with its own browser(s) and, where a scenario
 * needs one, its own paired isolated bridge. Server state is read and rolled back through the fixture database.
 */

const audience = new URL(UI_BASE_URL).origin;
const hex = (bytes = 3) => randomBytes(bytes).toString("hex");
const WRITE_CONFLICT = "Something else changed first. Confirm again.";

type Tip = { revision: number; head: string };
type FullRow = { ledger: unknown; revision: number; head: string; sticky: unknown; checkpoint: string | null; checkpoint_mac: string | null };

async function serverTip(accountId: string): Promise<Tip | null> {
  try {
    return await withDb(async db => (await db.query("SELECT revision, head FROM account_ledger WHERE account_id=$1", [accountId])).rows[0] as Tip ?? null);
  } catch { return null; }
}
async function storedLedgerText(accountId: string): Promise<string> {
  return withDb(async db => (await db.query("SELECT ledger::text AS text FROM account_ledger WHERE account_id=$1", [accountId])).rows[0].text as string);
}
async function snapshotRow(accountId: string): Promise<FullRow> {
  return withDb(async db => (await db.query("SELECT ledger, revision, head, sticky, checkpoint, checkpoint_mac FROM account_ledger WHERE account_id=$1", [accountId])).rows[0] as FullRow);
}
/** A full database rollback: the whole row as it was (internally consistent and correctly sealed). */
async function restoreRow(accountId: string, row: FullRow): Promise<void> {
  await withDb(db => db.query("UPDATE account_ledger SET ledger=$2::jsonb, revision=$3, head=$4, sticky=$5::jsonb, checkpoint=$6, checkpoint_mac=$7 WHERE account_id=$1",
    [accountId, JSON.stringify(row.ledger), row.revision, row.head, JSON.stringify(row.sticky), row.checkpoint, row.checkpoint_mac]));
}

/** The page's own ledger replica tip (IndexedDB `ftown-ledger`), or null while unreadable (never throws, never creates the database). */
async function localTip(page: Page, accountId: string): Promise<Tip | null> {
  try {
    return await page.evaluate(async id => {
      if (!(await indexedDB.databases()).some(item => item.name === "ftown-ledger")) return null;
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ftown-ledger"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("x")); });
      try {
        if (!db.objectStoreNames.contains("replicas")) return null;
        const record = await new Promise<{ checkpoint?: { revision?: number; head?: string } } | undefined>((resolve, reject) => {
          const request = db.transaction("replicas").objectStore("replicas").get(id);
          request.onsuccess = () => resolve(request.result as { checkpoint?: { revision?: number; head?: string } } | undefined); request.onerror = () => reject(new Error("x"));
        });
        const checkpoint = record?.checkpoint;
        return checkpoint && typeof checkpoint.revision === "number" && typeof checkpoint.head === "string" ? { revision: checkpoint.revision, head: checkpoint.head } : null;
      } finally { db.close(); }
    }, accountId);
  } catch { return null; }
}

/** The account passkey's signature counter in this page's virtual authenticator (it advances on every assertion). */
async function signCount(page: Page, account: RunAccount): Promise<number> {
  const own = (await (await virtualAuthenticator(page)).credentials()).find(item => item.credentialId === account.credential.credentialId);
  if (!own) throw new Error("the account passkey is not in this page's authenticator");
  return own.signCount;
}

/** A relay-token request with a proof signed in the page by the browser's own device key. */
async function browserRelayToken(page: Page, accountId: string, keyId: string) {
  return requestRelayToken(await signWithBrowserDeviceKey(page, { accountId, kind: "device", keyId, nonce: await serverNonce("relay"), purpose: "relay", audience }));
}

async function openSecurity(page: Page) {
  await page.getByRole("button", { name: "Open security", exact: true }).click();
  return page.getByRole("dialog", { name: "Security", exact: true });
}

/** Select a browser in the access map and start its removal (one confirmation); the caller decides when to confirm. */
async function removeBrowserInPanel(dialog: ReturnType<Page["getByRole"]>, endpointId: string): Promise<void> {
  const node = dialog.locator(`[data-access-kind="browser"][data-access-node="${endpointId}"]`).first();
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.click();
  const remove = dialog.getByRole("button", { name: /^Remove browser / });
  await expect(remove).toBeEnabled();
  await remove.click();
  await dialog.getByRole("group", { name: "Confirm browser removal", exact: true }).getByRole("button", { name: "Confirm remove browser", exact: true }).click();
}

/** Second browser of the same account: the synced passkey on another context (identify + add this browser). */
async function secondBrowser(browserType: Parameters<typeof createSecondAccount>[0], account: RunAccount, label: string) {
  const context = await browserType.newContext();
  const page = await context.newPage();
  await signIn(page, { account, browserLabel: label });
  return { context, page, endpointId: await browserEndpointId(page, account.accountId) };
}

async function reloadUntilLocal(page: Page, accountId: string, tip: Tip): Promise<void> {
  await page.goto("/dashboard");
  await expect.poll(() => localTip(page, accountId), { timeout: 30_000, message: "the browser's replica follows the server" }).toEqual(tip);
}

test.describe("append-only ledger", () => {
  test("B: a longer diverged chain is never adopted by the server", async ({ browser }) => {
    const second = await createSecondAccount(browser, { name: `E2E diverged offer ${hex()}` });
    try {
      const lib = await ledgerLib();
      const x = (await serverLedger(second.account)).ledger;
      // X+a on the server.
      await appendOperation({ type: "add_device", device: await browserDevice(second.accountId, "E2E a", Date.now()) }, second.account);
      const stored = await storedLedgerText(second.accountId);
      const xa = (await serverLedger(second.account)).ledger;
      const xaTip = (await serverTip(second.accountId))!;
      // X+b+c: valid, longer, built on the same head X.
      const xbc = await signedExtension(x, [
        { type: "add_device", device: await browserDevice(second.accountId, "E2E b", Date.now()) },
        { type: "add_device", device: await browserDevice(second.accountId, "E2E c", Date.now()) },
      ], second.account);
      expect((await lib.verifyLedger(xbc)).revision).toBe(xaTip.revision + 1);
      // Offered bound to the server's head (it claims to extend X+a) and unbound: refused either way, nothing written.
      for (const expectHead of [xaTip.head, null]) {
        const answer = await offerChain(xbc, expectHead);
        expect(answer.status, `a valid diverged chain is refused (expectHead ${expectHead === null ? "absent" : "= server head"})`).toBe(409);
        expect(answer.body.error).toBe("diverged");
        expect(answer.body.ledger).toEqual(xa);
      }
      expect(await storedLedgerText(second.accountId), "the stored chain is byte-identical").toBe(stored);
      expect(await serverTip(second.accountId)).toEqual(xaTip);
      const read = await serverLedger(second.account);
      expect(read.ledger).toEqual(xa);
      expect(read.checkpoint.head).toBe(xaTip.head);
    } finally {
      await second.close();
    }
  });

  test("A: concurrent writes on the same head: the second browser must confirm again", async ({ browser }) => {
    test.setTimeout(240_000);
    const second = await createSecondAccount(browser, { name: `E2E concurrent ${hex()}` });
    const b2 = await secondBrowser(browser, second.account, "E2E B2");
    try {
      const b1 = second.page;
      const d2 = await browserDevice(second.accountId, "E2E target of B1", Date.now());
      const d3 = await browserDevice(second.accountId, "E2E target of B2", Date.now());
      await appendOperation({ type: "add_device", device: d2 }, second.account);
      await appendOperation({ type: "add_device", device: d3 }, second.account);
      const h = (await serverTip(second.accountId))!;
      await reloadUntilLocal(b1, second.accountId, h);
      await reloadUntilLocal(b2.page, second.accountId, h);
      const b1Before = await signCount(b1, second.account);
      const b2Before = await signCount(b2.page, second.account);

      // Hold B2's first ledger POST until B1's change is on the server.
      let releaseHeld!: () => void;
      const heldRelease = new Promise<void>(resolve => { releaseHeld = resolve; });
      let arrivedHeld!: () => void;
      const heldArrived = new Promise<void>(resolve => { arrivedHeld = resolve; });
      let holding = true;
      await b2.page.route(url => url.pathname === "/api/account/ledger", async (route: Route) => {
        if (route.request().method() !== "POST" || !holding) return route.fallback();
        holding = false;
        arrivedHeld();
        await heldRelease;
        return route.fallback();
      });
      const dialog2 = await openSecurity(b2.page);
      await removeBrowserInPanel(dialog2, d3.endpoint.id);
      await heldArrived; // B2 signed on H; its POST is held
      const dialog1 = await openSecurity(b1);
      await removeBrowserInPanel(dialog1, d2.endpoint.id);
      await expect.poll(async () => (await serverLedger(second.account)).checkpoint.revokedDeviceIds.includes(d2.endpoint.id), { timeout: 30_000 }).toBe(true);
      const afterB1 = (await serverTip(second.accountId))!;
      expect(afterB1.revision).toBe(h.revision + 1);
      releaseHeld();

      await expect(dialog2.getByText(WRITE_CONFLICT, { exact: true })).toBeVisible({ timeout: 30_000 });
      const server = (await serverLedger(second.account)).checkpoint;
      expect(server.revokedDeviceIds, "B2's change is in no chain (server)").not.toContain(d3.endpoint.id);
      expect(server.head).toBe(afterB1.head);
      await expect.poll(() => localTip(b2.page, second.accountId), { timeout: 15_000, message: "B2 adopted the server's extension" }).toEqual(afterB1);
      await expect.poll(() => localTip(b1, second.accountId), { timeout: 15_000 }).toEqual(afterB1);
      expect(await signCount(b1, second.account) - b1Before, "B1: one passkey assertion").toBe(1);
      expect(await signCount(b2.page, second.account) - b2Before, "B2: one passkey assertion so far").toBe(1);

      // Meanwhile B2 still enforces its own removal locally ("Removed on this browser only"), and offers to sign it again.
      await expect(dialog2.getByRole("heading", { name: "Some account changes were not kept", exact: true })).toBeVisible();
      await expect(dialog2.locator(`[data-access-kind="browser"][data-access-node="${d3.endpoint.id}"]`).first())
        .toHaveAccessibleName(/Removed on this browser only — not yet applied to your account/);
      // B2 confirms again ("Sign again"): saved on top of B1's change.
      await dialog2.getByRole("button", { name: "Sign again: Remove browser “E2E target of B2”", exact: true }).click();
      await expect.poll(async () => (await serverLedger(second.account)).checkpoint.revokedDeviceIds.includes(d3.endpoint.id), { timeout: 30_000 }).toBe(true);
      expect((await serverTip(second.accountId))!.revision).toBe(h.revision + 2);
      expect(await signCount(b1, second.account) - b1Before, "B1: 1 passkey assertion").toBe(1);
      expect(await signCount(b2.page, second.account) - b2Before, "B2: 2 passkey assertions").toBe(2);
    } finally {
      await b2.context.close();
      await second.close();
    }
  });

  test("C: a rolled-back server is repaired by a bridge with no browser open", async ({ browser }) => {
    test.setTimeout(240_000);
    const { second, bridge } = await accountWithBridge(browser, "E2E bridge repair");
    try {
      const h1Row = await snapshotRow(second.accountId);
      await appendOperation({ type: "add_device", device: await browserDevice(second.accountId, "E2E tail", Date.now()) }, second.account);
      const h2 = (await serverTip(second.accountId))!;
      await expect.poll(() => bridge.replicaTip(), { timeout: 30_000, message: "M1 follows the server to H2" }).toEqual(h2);
      await second.page.close(); // no browser open
      await bridge.stopProcess();
      await restoreRow(second.accountId, h1Row);
      expect((await serverTip(second.accountId))!.revision).toBe(h2.revision - 1);
      // Trigger: the computer restarts (its startup relay-token read returns the server's older chain: behind → re-offer).
      const from = bridge.output().length;
      const started = Date.now();
      await bridge.startProcess();
      await expect.poll(() => serverTip(second.accountId), { timeout: 90_000, intervals: [500], message: "the bridge re-offers its chain" }).toEqual(h2);
      const repairedMs = Date.now() - started;
      test.info().annotations.push({ type: "C: server repaired by the bridge", description: `${repairedMs} ms after the bridge restart` });
      const after = bridge.output().slice(from);
      expect(after, "no divergence is reported").not.toMatch(/REFUSED|diverge/i);
      expect(bridge.replicaTip()).toEqual(h2);
      const info = await bridgeLedgerInfo(bridge);
      expect(info?.divergence ?? null).toBeNull();
    } finally {
      await second.close();
    }
  });

  for (const keep of ["mine", "theirs"] as const) {
    test(`D+E: real divergence: the bridge refuses and says so; the owner keeps ${keep === "mine" ? "this browser's" : "the other"} history`, async ({ browser }) => {
      test.setTimeout(300_000);
      const state = await divergedAccount(browser, `E2E diverged ${keep}`);
      const { second, bridge, h2, removable, freshLabel } = state;
      try {
        // ---- D: what M1 does with the server's diverged chain ----
        const refused = () => (bridge.output().slice(state.restartedAt).match(/\[ledger\] REFUSED a different account history from server/g) ?? []).length;
        await expect.poll(refused, { timeout: 60_000, message: "M1 logs that it refuses the server's history" }).toBe(1);
        await second.page.waitForTimeout(5000);
        expect(refused(), "exactly one REFUSED line for that head").toBe(1);
        expect(bridge.replicaTip(), "M1 keeps its own chain").toEqual(h2);
        expect(bridge.bridgeIdFile(), "M1 keeps its identity").toBe(state.bridgeId);
        const tail = bridge.output().slice(state.restartedAt);
        expect(tail).not.toContain("New identity for this computer");
        expect(archives(bridge)).toEqual([]);
        const keyRefused = tail.includes("did not accept this computer's key");
        test.info().annotations.push({ type: "D: M1 after restart", description: `${tail.match(/\[ledger\] REFUSED[^\n]*/)?.[0] ?? "no REFUSED line"}; server refused its key: ${keyRefused}; running: ${bridge.running()}` });
        if (keyRefused) expect(tail, "a computer that may hold the only copy must not be told to reset").toContain("Do NOT run --new-identity");
        await expect.poll(async () => (await bridgeLedgerInfo(bridge))?.divergence?.source ?? null, { timeout: 30_000 }).toBe("server");

        // ---- E: B1 (on M1's history) sees both histories and the owner chooses ----
        const page = second.page;
        await page.goto("/dashboard");
        const dialog = await openSecurity(page);
        await expect(dialog.getByRole("heading", { name: "Two different histories of this account exist", exact: true })).toBeVisible({ timeout: 30_000 });
        const column = (title: string) => dialog.getByRole("region", { name: title, exact: true });
        const mine = column("This browser's history");
        const theirs = column("The other history");
        await expect(mine).toContainText("Removed browser “E2E removable”");
        await expect(theirs).toContainText(`Added browser “${freshLabel}”`);
        await expect(dialog).toContainText("The server holds the other history.");
        await expect(dialog).toContainText("Other changes to your account are turned off until you choose one history.");
        await expect(mine).toContainText("Keeping this history discards the other one's changes listed opposite.");
        await expect(theirs).toContainText("Keeping this history re-applies 1 removal from the other one, then discards the rest. You will confirm 2 times.");
        // Nothing else can be SIGNED meanwhile (removals); display names are not signed and stay editable.
        for (const button of await dialog.getByRole("button", { name: /^(Remove browser|Remove computer) / }).all()) await expect(button).toBeDisabled();
        const k = keep === "mine" ? 1 : 2;
        const before = await signCount(page, second.account);
        await (keep === "mine" ? mine : theirs).getByRole("button", { name: "Keep this history", exact: true }).click();
        const lastOp = async () => { try { const { ledger } = await serverLedger(second.account); return ledger.transitions[ledger.transitions.length - 1]?.payload.operation.type ?? null; } catch { return null; } };
        await expect.poll(lastOp, { timeout: 60_000, message: "the server's chain ends with resolve_fork" }).toBe("resolve_fork");
        expect(await signCount(page, second.account) - before, `exactly ${k} passkey assertion(s)`).toBe(k);
        const chosen = (await serverLedger(second.account)).checkpoint;
        expect(chosen.revokedDeviceIds, "the removal is in the chosen chain").toContain(removable.endpoint.id);
        const final = (await serverTip(second.accountId))!;
        await expect.poll(() => localTip(page, second.accountId), { timeout: 30_000 }).toEqual(final);
        await expect(dialog.getByRole("heading", { name: "Two different histories of this account exist", exact: true })).toHaveCount(0, { timeout: 30_000 });
        // M1 adopts the chosen history through its normal reads; no new REFUSED line, divergence cleared, nothing wiped.
        const adoptStarted = Date.now();
        await expect.poll(() => bridge.replicaTip(), { timeout: 90_000, intervals: [500], message: "M1 adopts the chosen history" }).toEqual(final);
        test.info().annotations.push({ type: `E (${keep}): M1 adopted the resolution`, description: `${Date.now() - adoptStarted} ms after the server stored it; K=${k}` });
        expect(refused(), "no REFUSED line for the resolved head").toBe(1);
        await expect.poll(async () => (await bridgeLedgerInfo(bridge))?.divergence ?? null, { timeout: 30_000 }).toBeNull();
        expect(bridge.output().slice(state.restartedAt)).not.toContain("This bridge is not in its account ledger");
        expect(archives(bridge), "no identity reset happened").toEqual([]);
      } finally {
        await second.close();
      }
    });
  }

  test("D2: a computer the rolled-back server does not know keeps its chain and is told not to reset", async ({ browser }) => {
    test.setTimeout(240_000);
    // H1 is taken BEFORE M1 is paired: M1's add_bridge is only on its own branch, so the server (at H1 + z) refuses M1's key.
    const second = await createSecondAccount(browser, { name: `E2E unknown computer ${hex()}` });
    try {
      const h1Row = await snapshotRow(second.accountId);
      const paired = await second.pairBridge();
      const bridge = paired.bridge;
      const h2 = (await serverTip(second.accountId))!;
      await expect.poll(() => bridge.replicaTip(), { timeout: 30_000 }).toEqual(h2);
      await quiet(second.page);
      await bridge.stopProcess();
      await restoreRow(second.accountId, h1Row);
      const fresh = await secondBrowser(browser, second.account, `E2E history-less ${hex()}`);
      await fresh.context.close();
      const from = bridge.output().length;
      await bridge.startProcess();
      await expect.poll(() => /did not accept this computer's key|REFUSED|Do NOT run/.test(bridge.output().slice(from)), { timeout: 60_000 }).toBe(true);
      await second.page.waitForTimeout(3000);
      const tail = bridge.output().slice(from);
      test.info().annotations.push({ type: "D2: M1 output after restart", description: tail.split("\n").filter(line => /\[(Bridge|ledger|Security)\]/.test(line)).slice(-6).join(" | ").slice(0, 600) });
      expect(bridge.replicaTip(), "M1 keeps its chain (ledger.json)").toEqual(h2);
      expect(bridge.bridgeIdFile(), "M1 keeps its identity").toBe(paired.bridgeId);
      expect(archives(bridge)).toEqual([]);
      expect(tail, "a computer that may hold the only copy is told not to reset").toContain("Do NOT run --new-identity");
      expect(tail).not.toContain("run `ftown start --new-identity` to pair it again");
    } finally {
      await second.close();
    }
  });

  test("F: a removal on the other history is enforced before the owner resolves", async ({ browser }) => {
    test.setTimeout(300_000);
    const { second, bridge, bridgeId } = await accountWithBridge(browser, "E2E seen removal");
    const bx = await secondBrowser(browser, second.account, "E2E Bx");
    try {
      await waitForBridgeOnline(bx.page);
      await expect.poll(() => bridgeTrusts(bridge, bx.endpointId), { timeout: 30_000, message: "M1 trusts Bx before the divergence" }).toBe(true);
      const h1Row = await snapshotRow(second.accountId);
      await appendOperation({ type: "add_device", device: await browserDevice(second.accountId, "E2E tail", Date.now()) }, second.account);
      const h2 = (await serverTip(second.accountId))!;
      await expect.poll(() => bridge.replicaTip(), { timeout: 30_000 }).toEqual(h2);
      await expect.poll(() => localTip(bx.page, second.accountId), { timeout: 30_000, message: "Bx follows to H2 (M1's history)" }).toEqual(h2);
      await quiet(second.page);
      await bridge.stopProcess();
      await restoreRow(second.accountId, h1Row);
      // The server's branch revokes Bx (signed by the account passkey, an authority at the fork).
      await appendOperation({ type: "revoke_device", endpointId: bx.endpointId }, second.account);
      const from = bridge.output().length;
      await bridge.startProcess();
      await expect.poll(() => /\[ledger\] REFUSED a different account history from server/.test(bridge.output().slice(from)), { timeout: 60_000 }).toBe(true);
      test.info().annotations.push({ type: "F: M1 ledger status", description: JSON.stringify(await bridgeLedgerInfo(bridge)) });
      expect(bridge.replicaTip(), "M1 adopted nothing").toEqual(h2);
      // M1 enforces the removal it saw on the refused history: Bx is no longer among the browsers it trusts, while M1's own chain
      // (where Bx is a member) is unchanged.
      await expect.poll(() => bridgeTrusts(bridge, bx.endpointId), { timeout: 30_000, message: "M1 stops trusting Bx" }).toBe(false);
      expect(bridge.replicaTip()).toEqual(h2);
      // Bx itself enforces it too: its dashboard is replaced by the removed screen (so it cannot send M1 a command at all).
      await expect(bx.page.getByRole("heading", { name: "This browser was removed", exact: true })).toBeVisible({ timeout: 30_000 });
      // ...and the server refuses Bx a relay token.
      const token = await browserRelayToken(bx.page, second.accountId, bx.endpointId);
      expect(token.status).toBe(401);
      expect(token.body.error).toBe("key_revoked");
    } finally {
      await bx.context.close();
      await second.close();
    }
  });

  test("G: a signed removal blocks the computer locally at once; Discard, then Dismiss, restores it", async ({ browser }) => {
    test.setTimeout(240_000);
    const { second, bridgeId } = await accountWithBridge(browser, "E2E blocked computer");
    try {
      const page = second.page;
      await page.goto("/dashboard");
      await waitForBridgeOnline(page);
      const posts: number[] = [];
      await page.route(url => url.pathname === "/api/account/ledger", async route => {
        if (route.request().method() !== "POST") return route.fallback();
        posts.push(Date.now());
        if (posts.length === 1) return route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "600" }, body: JSON.stringify({ error: "rate_limited" }) });
        return route.fallback();
      });
      const before = await signCount(page, second.account);
      const dialog = await openSecurity(page);
      const node = dialog.locator(`[data-access-kind="bridge"][data-access-node="${bridgeId}"]`).first();
      await expect(node).toBeVisible({ timeout: 30_000 });
      await node.click();
      await dialog.getByRole("button", { name: /^Remove computer / }).click();
      await dialog.getByRole("group", { name: "Confirm computer removal", exact: true }).getByRole("button", { name: "Confirm remove computer", exact: true }).click();
      await expect.poll(() => posts.length, { timeout: 30_000 }).toBe(1);
      // At once, before the server has it: the computer is blocked here.
      await expect(node).toHaveAccessibleName(/Removal not saved to the server yet/, { timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Create a new session", exact: true }), "no session can be started on the removed computer").toBeDisabled({ timeout: 15_000 });
      expect((await serverLedger(second.account)).checkpoint.revokedBridgeIds).not.toContain(bridgeId);
      expect(await signCount(page, second.account) - before).toBe(1);
      const discard = dialog.getByRole("button", { name: "Discard this change", exact: true });
      await expect(discard).toBeVisible();
      await discard.click();
      // The row now says the removal is on this browser only, with "Sign removal again" and its own "Dismiss".
      const row = dialog.getByRole("group", { name: "Removal not applied", exact: true });
      await expect(row).toContainText("Removed on this browser only — not yet applied to your account", { timeout: 15_000 });
      await expect(row.getByRole("button", { name: "Sign removal again", exact: true })).toBeVisible();
      const dismiss = row.getByRole("button", { name: "Dismiss", exact: true });
      await expect(dismiss).toBeVisible();
      await dismiss.click();
      await expect(page.getByRole("button", { name: "Create a new session", exact: true }), "the computer is usable again").toBeEnabled({ timeout: 30_000 });
      await expect(node).not.toHaveAccessibleName(/not saved|Removed/);
      expect((await serverLedger(second.account)).checkpoint.revokedBridgeIds, "the server never received the removal").not.toContain(bridgeId);
      expect(posts.length, "the only POST was the refused one").toBe(1);
      expect(await signCount(page, second.account) - before).toBe(1);
    } finally {
      await second.close();
    }
  });

  test("H: before signing, a browser behind a rolled-back server adopts the computer's longer chain and writes on top", async ({ browser }) => {
    test.setTimeout(300_000);
    const { second, bridge } = await accountWithBridge(browser, "E2E prepare repair");
    const b2 = await secondBrowser(browser, second.account, "E2E B2 at H1");
    try {
      const target = await browserDevice(second.accountId, "E2E target", Date.now());
      await appendOperation({ type: "add_device", device: target }, second.account);
      const h1Row = await snapshotRow(second.accountId);
      const h1 = { revision: h1Row.revision, head: h1Row.head };
      await reloadUntilLocal(b2.page, second.accountId, h1);
      await b2.page.close(); // B2's replica stays at H1
      await appendOperation({ type: "add_device", device: await browserDevice(second.accountId, "E2E tail", Date.now()) }, second.account);
      const h2 = (await serverTip(second.accountId))!;
      await expect.poll(() => bridge.replicaTip(), { timeout: 30_000 }).toEqual(h2);
      await reloadUntilLocal(second.page, second.accountId, h2);
      await restoreRow(second.accountId, h1Row); // server rolled back; B1 and M1 online at H2
      const page = await b2.context.newPage();
      const outputFrom = bridge.output().length;
      const opened = Date.now();
      await page.goto("/dashboard");
      await waitForBridgeOnline(page);
      // A virtual authenticator lives per page: the reopened page gets one holding the synced passkey, counted from here.
      await (await virtualAuthenticator(page)).addCredential(second.account.credential);
      const start = await signCount(page, second.account);
      const dialog = await openSecurity(page);
      const localBefore = await localTip(page, second.accountId);
      await removeBrowserInPanel(dialog, target.endpoint.id);
      await expect.poll(async () => (await serverLedger(second.account)).checkpoint.revokedDeviceIds.includes(target.endpoint.id), { timeout: 60_000 }).toBe(true);
      const final = (await serverTip(second.accountId))!;
      const asked = (bridge.output().slice(outputFrom).match(/Received command: ledger_(head|chain)/g) ?? []).join(", ");
      test.info().annotations.push({ type: "H: what B2 knew", description: `B2 local tip before confirming: rev ${localBefore?.revision ?? "?"} (H1 ${h1.revision}, H2 ${h2.revision}), ${Date.now() - opened} ms after opening; M1 received: ${asked || "no ledger RPC"}; server ended at rev ${final.revision}` });
      expect(final.revision, "the change landed on top of H2").toBe(h2.revision + 1);
      const { ledger } = await serverLedger(second.account);
      expect(await (await ledgerLib()).ledgerHead(ledger.transitions[h2.revision - 1].payload)).toBe(h2.head);
      expect(await signCount(page, second.account) - start, "exactly one passkey assertion").toBe(1);
      await expect(dialog.getByRole("heading", { name: "Two different histories of this account exist", exact: true })).toHaveCount(0);
      expect((await bridgeLedgerInfo(bridge))?.divergence ?? null).toBeNull();
      await expect.poll(() => bridge.replicaTip(), { timeout: 30_000 }).toEqual(final);
    } finally {
      await b2.context.close();
      await second.close();
    }
  });

  test("I: a silent computer does not block a write (best effort, ≤ ~2 s)", async ({ browser }) => {
    test.setTimeout(240_000);
    const { second, bridge } = await accountWithBridge(browser, "E2E silent computer");
    try {
      const page = second.page;
      const target = await browserDevice(second.accountId, "E2E target", Date.now());
      await appendOperation({ type: "add_device", device: target }, second.account);
      await reloadUntilLocal(page, second.accountId, (await serverTip(second.accountId))!);
      await waitForBridgeOnline(page);
      const posts: number[] = [];
      page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/account/ledger") posts.push(Date.now()); });
      const before = await signCount(page, second.account);
      const dialog = await openSecurity(page);
      bridge.freeze(); // our own bridge process: still connected to the relay, but it answers nothing
      try {
        const node = dialog.locator(`[data-access-kind="browser"][data-access-node="${target.endpoint.id}"]`).first();
        await node.click();
        await dialog.getByRole("button", { name: /^Remove browser / }).click();
        const confirm = dialog.getByRole("group", { name: "Confirm browser removal", exact: true }).getByRole("button", { name: "Confirm remove browser", exact: true });
        const clicked = Date.now();
        await confirm.click();
        await expect.poll(() => posts.length, { timeout: 15_000 }).toBeGreaterThan(0);
        const delay = posts[0] - clicked;
        test.info().annotations.push({ type: "I: write delay with a silent computer", description: `${delay} ms from confirm to POST` });
        expect(delay, "silence never blocks for long").toBeLessThan(6000);
        await expect.poll(async () => (await serverLedger(second.account)).checkpoint.revokedDeviceIds.includes(target.endpoint.id), { timeout: 30_000 }).toBe(true);
        expect(await signCount(page, second.account) - before, "one passkey assertion").toBe(1);
      } finally { bridge.thaw(); }
    } finally {
      await second.close();
    }
  });

  test("J: after an accepted write the computer adopts the new head", async ({ browser }) => {
    test.setTimeout(240_000);
    const { second, bridge } = await accountWithBridge(browser, "E2E announce");
    try {
      const page = second.page;
      const target = await browserDevice(second.accountId, "E2E target", Date.now());
      await appendOperation({ type: "add_device", device: target }, second.account);
      await reloadUntilLocal(page, second.accountId, (await serverTip(second.accountId))!);
      await waitForBridgeOnline(page);
      const dialog = await openSecurity(page);
      await removeBrowserInPanel(dialog, target.endpoint.id);
      await expect.poll(async () => (await serverLedger(second.account)).checkpoint.revokedDeviceIds.includes(target.endpoint.id), { timeout: 30_000 }).toBe(true);
      const final = (await serverTip(second.accountId))!;
      const started = Date.now();
      await expect.poll(() => bridge.replicaTip(), { timeout: 30_000, intervals: [250] }).toEqual(final);
      test.info().annotations.push({ type: "J: M1 adopted B1's write", description: `${Date.now() - started} ms after the server stored it` });
    } finally {
      await second.close();
    }
  });

  test.fixme("J (UI): B1 lists M1 as having confirmed the new head", async () => {
    // Not observable: the dashboard renders no per-replica confirmation ("Applied on …") and the bridge's local API
    // (GET /api/security/info) exposes divergence / serverBehind / removedOnOtherHistory, not its announcement counters.
  });
});

// ---- Bridge scenarios: shared setup ----

/** A throwaway account whose browser B1 paired an isolated bridge M1 (B1 on its dashboard, M1 at the server's head). */
async function accountWithBridge(browserType: Parameters<typeof createSecondAccount>[0], name: string) {
  const second = await createSecondAccount(browserType, { name: `${name} ${hex()}` });
  try {
    const paired = await second.pairBridge();
    const tip = (await serverTip(second.accountId))!;
    await expect.poll(() => paired.bridge.replicaTip(), { timeout: 30_000 }).toEqual(tip);
    return { second, bridge: paired.bridge, bridgeId: paired.bridgeId };
  } catch (error) { await second.close(); throw error; }
}

/** The bridge's own ledger status from its local API (GET /api/security/info → .ledger). */
async function bridgeLedgerInfo(bridge: IsolatedBridge): Promise<{ divergence: { source: string } | null; serverBehind: boolean; removedOnOtherHistory: unknown } | null> {
  try {
    if (!tryReadBridgePointer(bridge.home)) return null;
    const response = await bridgeApiFetch("GET", "/api/security/info", { bridgeHome: bridge.home });
    return response.status === 200 ? (response.body as { ledger?: { divergence: { source: string } | null; serverBehind: boolean; removedOnOtherHistory: unknown } }).ledger ?? null : null;
  } catch { return null; }
}

/** Whether the bridge's own security view (local CLI `security_devices`, account mode) lists the browser as trusted. */
async function bridgeTrusts(bridge: IsolatedBridge, endpointId: string): Promise<boolean | null> {
  try {
    if (!tryReadBridgePointer(bridge.home)) return null;
    const result = await bridgeSecurityCommand("security_devices", {}, bridge.home) as unknown as { devices?: { endpoint: { id: string } }[] };
    return (result.devices ?? []).some(device => device.endpoint.id === endpointId);
  } catch { return null; }
}

/** Ledger archives an identity reset would leave (security/ledger.<timestamp>.archived.json). */
function archives(bridge: IsolatedBridge): string[] {
  try { return readdirSync(join(bridge.dataDir, "security")).filter(name => /^ledger\..*\.archived\.json$/.test(name)); } catch { return []; }
}

async function quiet(page: Page): Promise<void> {
  await page.goto(`${UI_BASE_URL}/api/version`);
}

/**
 * A real divergence (CONTRACT §6/§12): M1 and B1 hold H1 + one removal (H2); M1 is stopped, the server is rolled back to H1,
 * and a HISTORY-LESS browser signs in (identify + add this browser: no prepare, it is not a member yet) so the server holds
 * H1 + that add_device. Then M1 starts again. B1 is left on a page without the app.
 */
async function divergedAccount(browserType: Parameters<typeof createSecondAccount>[0], name: string) {
  const { second, bridge, bridgeId } = await accountWithBridge(browserType, name);
  try {
    const removable = await browserDevice(second.accountId, "E2E removable", Date.now());
    await appendOperation({ type: "add_device", device: removable }, second.account);
    const h1Row = await snapshotRow(second.accountId);
    await appendOperation({ type: "revoke_device", endpointId: removable.endpoint.id }, second.account);
    const h2 = (await serverTip(second.accountId))!;
    await expect.poll(() => bridge.replicaTip(), { timeout: 30_000, message: "M1 at H2" }).toEqual(h2);
    await reloadUntilLocal(second.page, second.accountId, h2);
    await quiet(second.page);
    await bridge.stopProcess();
    await restoreRow(second.accountId, h1Row);
    const freshLabel = `E2E history-less ${hex()}`;
    const fresh = await secondBrowser(browserType, second.account, freshLabel);
    await fresh.context.close();
    const z = (await serverTip(second.accountId))!;
    expect(z.revision, "the server holds H1 + the new browser").toBe(h1Row.revision + 1);
    expect(z.head).not.toBe(h2.head);
    const restartedAt = bridge.output().length;
    await bridge.startProcess();
    return { second, bridge, bridgeId, h2, z, removable, freshLabel, restartedAt };
  } catch (error) { await second.close(); throw error; }
}

