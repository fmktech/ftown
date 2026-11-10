import { expect, request as apiRequest, type Page } from "@playwright/test";
import { createECDH, randomBytes, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerCheckpoint } from "../../bridge/src/security/ledger/protocol";
import { signWithBrowserDeviceKey } from "../helpers/browser-proof";
import { E2E_DIR, UI_BASE_URL } from "../helpers/config";
import { ledgerRow, withDb } from "../helpers/db";
import { test } from "../helpers/fixtures";
import { appendOperation, browserDeviceWithKey, requestRelayToken, serverLedger, serverNonce, signProof } from "../helpers/ledger-admin";
import { browserEndpointId, signIn, virtualAuthenticator } from "../helpers/passkey";
import { createSecondAccount, type SecondAccount } from "../helpers/second-account";

/**
 * Auth decisions read a checkpoint persisted with each ledger row, sealed with an HMAC keyed from AUTH_SECRET (which the
 * database does not hold; migration 0012). Here, on THROWAWAY accounts (never the shared account A):
 *  - a missing checkpoint is healed by re-verifying the passkey-signed chain, and auth keeps working;
 *  - a checkpoint edited in the database without a valid MAC is never trusted: a device injected that way gets nothing,
 *    the account's real device still works, and the row is healed back to what the chain says;
 *  - a row rolled back to its sealed state from BEFORE a revocation (revision, head, sticky, checkpoint and its valid MAC),
 *    under the newer chain, is not trusted either: the seal no longer matches the chain's length and tip, so the row is
 *    healed from the chain and the revoked device stays revoked;
 *  - every heal is logged by the UI server ("[ledger] checkpoint healed: account <8> reason <reason> revision <a>-><b>",
 *    read from the harness's e2e/ui.log);
 *  - /api/auth/relay-token's `key_revoked` evidence (with the ledger) goes only to the holder of the revoked key: a proof
 *    that merely CLAIMS a revoked key id, signed by any other key, is a plain 401 unauthorized without the ledger.
 *    (computer-removal.spec.ts asserts the evidence for a revoked bridge's own key.)
 *  - a FULL database rollback (the whole row, internally consistent and correctly sealed) is accepted by the server until a
 *    signed-in browser that holds the newer chain connects: its ledger client sees the server behind and re-offers its own
 *    chain without a passkey prompt (re-offer). With no browser open, the rollback stays.
 */

const audience = new URL(UI_BASE_URL).origin;
const jwtSub = (token: unknown): unknown => typeof token === "string"
  ? (JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub?: unknown }).sub : undefined;

/** A same-origin document without the app's scripts: B's IndexedDB (device key) stays reachable, nothing authenticates in the background. */
async function quiet(page: Page): Promise<void> {
  await page.goto(`${UI_BASE_URL}/api/version`);
}

async function browserProof(second: SecondAccount, accountId: string, keyId: string) {
  return signWithBrowserDeviceKey(second.page, { accountId, kind: "device", keyId, nonce: await serverNonce("relay"), purpose: "relay", audience });
}

/** The UI server's output as captured by scripts/start-services.sh (`next start` > e2e/ui.log). */
const UI_LOG = join(E2E_DIR, "ui.log");
const uiLog = (): string => { try { return readFileSync(UI_LOG, "utf8"); } catch { return ""; } };

/** The UI logged at least one heal of `accountId` with `reason` after log offset `from` (concurrent heals may log more than once). */
async function expectHealLogged(from: number, accountId: string, reason: string): Promise<void> {
  const line = new RegExp(`\\[ledger\\] checkpoint healed: account ${accountId.slice(0, 8).replace(/[-]/g, "\\-")} reason ${reason} revision \\d+->\\d+`);
  await expect.poll(() => line.test(uiLog().slice(from)), { timeout: 10_000, message: `heal of ${accountId.slice(0, 8)} with reason ${reason} in e2e/ui.log` }).toBe(true);
}

test("sealed checkpoint: a missing one is healed from the chain; one edited without its MAC is never trusted", async ({ browser }) => {
  const second = await createSecondAccount(browser, { name: `E2E checkpoint ${randomBytes(3).toString("hex")}` });
  try {
    await quiet(second.page);
    await withDb(async db => {
      const sealed = await ledgerRow(db, second.accountId);
      expect(sealed.checkpoint).not.toBeNull();
      expect(sealed.checkpoint_mac).not.toBeNull();
      const original = JSON.parse(sealed.checkpoint!) as LedgerCheckpoint;
      expect(original.accountId).toBe(second.accountId);
      expect(original.devices.map(item => item.endpoint.id)).toEqual([second.endpointId]);

      // (a) No checkpoint: the next authenticated request re-verifies the chain, succeeds and re-seals the row.
      await db.query("UPDATE account_ledger SET checkpoint=NULL WHERE account_id=$1", [second.accountId]);
      expect((await ledgerRow(db, second.accountId)).checkpoint).toBeNull();
      const logAtA = uiLog().length;
      const minted = await second.page.request.post(`${UI_BASE_URL}/api/auth/token`);
      expect(minted.status()).toBe(200);
      expect(jwtSub((await minted.json() as { token: string }).token)).toBe(second.accountId);
      const healed = await ledgerRow(db, second.accountId);
      expect(healed.checkpoint).not.toBeNull();
      expect(healed.checkpoint_mac).not.toBeNull();
      expect(JSON.parse(healed.checkpoint!)).toEqual(original);
      expect(healed.version, "healing re-seals in place: it is not a ledger write").toBe(sealed.version);
      await expectHealLogged(logAtA, second.accountId, "absent");

      // (b) A device injected into the checkpoint text by SQL, MAC left as is (the database cannot compute it).
      const injected = await browserDeviceWithKey(second.accountId, "injected by SQL", Date.now());
      const forged: LedgerCheckpoint = { ...original, devices: [...original.devices, injected.device] };
      await db.query("UPDATE account_ledger SET checkpoint=$2 WHERE account_id=$1", [second.accountId, JSON.stringify(forged)]);
      expect((JSON.parse((await ledgerRow(db, second.accountId)).checkpoint!) as LedgerCheckpoint).devices.map(item => item.endpoint.id))
        .toContain(injected.device.endpoint.id);
      const logAtB = uiLog().length;
      const refused = await requestRelayToken(await signProof(injected.authKey, {
        accountId: second.accountId, kind: "device", keyId: injected.device.endpoint.id, purpose: "relay",
      }));
      expect(refused.status, "SECURITY: a device that exists only in an unsealed checkpoint was trusted").toBe(401);
      expect(refused.body).toEqual({ error: "unauthorized" });
      // The account's real device (B's browser, its non-extractable key) still gets a relay token.
      const legit = await requestRelayToken(await browserProof(second, second.accountId, second.endpointId));
      expect(legit.status).toBe(200);
      expect(jwtSub(legit.body.token)).toBe(second.accountId);
      const after = await ledgerRow(db, second.accountId);
      const stored = JSON.parse(after.checkpoint!) as LedgerCheckpoint;
      expect(stored.devices.map(item => item.endpoint.id)).not.toContain(injected.device.endpoint.id);
      expect(stored).toEqual(original);
      expect(after.version).toBe(sealed.version);
      await expectHealLogged(logAtB, second.accountId, "mac_mismatch");
    });
  } finally {
    await second.close();
  }
});

test("sealed checkpoint: a row rolled back to its seal from before a revocation is healed from the newer chain", async ({ browser }) => {
  const second = await createSecondAccount(browser, { name: `E2E checkpoint rollback ${randomBytes(3).toString("hex")}` });
  try {
    await quiet(second.page);
    const doomed = await browserDeviceWithKey(second.accountId, "E2E device revoked later", Date.now());
    const claim = { accountId: second.accountId, kind: "device" as const, keyId: doomed.device.endpoint.id, purpose: "relay" as const };
    await appendOperation({ type: "add_device", device: doomed.device }, second.account);
    expect((await requestRelayToken(await signProof(doomed.authKey, claim))).status, "control: trusted before the revocation").toBe(200);
    await withDb(async db => {
      type Snapshot = { revision: number; head: string; sticky: unknown; checkpoint: string; checkpoint_mac: string };
      const select = "SELECT revision, head, sticky, checkpoint, checkpoint_mac, jsonb_array_length(ledger->'transitions') AS chain_length FROM account_ledger WHERE account_id=$1";
      const before = (await db.query(select, [second.accountId])).rows[0] as Snapshot & { chain_length: number };
      expect(before.checkpoint).not.toBeNull();
      expect(before.chain_length).toBe(before.revision);
      await appendOperation({ type: "revoke_device", endpointId: doomed.device.endpoint.id }, second.account);
      const revoked = (await db.query(select, [second.accountId])).rows[0] as Snapshot & { chain_length: number };
      expect(revoked.revision).toBe(before.revision + 1);
      expect(revoked.head).not.toBe(before.head);

      // Roll back exactly the five sealed-state columns to their pre-revocation values; the newer chain stays in `ledger`.
      await db.query("UPDATE account_ledger SET revision=$2, head=$3, sticky=$4::jsonb, checkpoint=$5, checkpoint_mac=$6 WHERE account_id=$1",
        [second.accountId, before.revision, before.head, JSON.stringify(before.sticky), before.checkpoint, before.checkpoint_mac]);
      const rolledBack = (await db.query(select, [second.accountId])).rows[0] as Snapshot & { chain_length: number };
      expect([rolledBack.revision, rolledBack.head, rolledBack.checkpoint, rolledBack.chain_length]).toEqual([before.revision, before.head, before.checkpoint, revoked.revision]);

      const logAt = uiLog().length;
      const refused = await requestRelayToken(await signProof(doomed.authKey, claim));
      expect(refused.status, "SECURITY: a revoked device was trusted through a rolled-back seal").toBe(401);
      expect(refused.body.token).toBeUndefined();
      expect(refused.body.error).toBe("key_revoked");
      // The account's real device still works.
      const legit = await requestRelayToken(await browserProof(second, second.accountId, second.endpointId));
      expect(legit.status).toBe(200);
      expect(jwtSub(legit.body.token)).toBe(second.accountId);
      // The row describes the newer chain again.
      const after = (await db.query(select, [second.accountId])).rows[0] as Snapshot & { chain_length: number };
      expect([after.revision, after.head]).toEqual([revoked.revision, revoked.head]);
      expect((JSON.parse(after.checkpoint) as LedgerCheckpoint).revokedDeviceIds).toContain(doomed.device.endpoint.id);
      await expectHealLogged(logAt, second.accountId, "chain_mismatch");
    });
  } finally {
    await second.close();
  }
});

test("relay-token: a claim of a revoked key id gets key_revoked evidence only when the revoked key itself signed it", async ({ browser }) => {
  const second = await createSecondAccount(browser, { name: `E2E revoked oracle ${randomBytes(3).toString("hex")}` });
  try {
    await quiet(second.page);
    const doomed = await browserDeviceWithKey(second.accountId, "E2E device to revoke", Date.now());
    const claim = { accountId: second.accountId, kind: "device" as const, keyId: doomed.device.endpoint.id, purpose: "relay" as const };
    await appendOperation({ type: "add_device", device: doomed.device }, second.account);
    // Control: while trusted, the device's own key gets a token.
    const live = await requestRelayToken(await signProof(doomed.authKey, claim));
    expect(live.status).toBe(200);
    expect(jwtSub(live.body.token)).toBe(second.accountId);
    await appendOperation({ type: "revoke_device", endpointId: doomed.device.endpoint.id }, second.account);

    // Claims of the revoked id signed by any OTHER key: plain 401, no evidence, no ledger.
    const stranger = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
    for (const [label, proof] of [
      ["a stranger's key", await signProof(stranger.privateKey, claim)],
      ["the account's own live browser key", await browserProof(second, second.accountId, doomed.device.endpoint.id)],
    ] as const) {
      const response = await requestRelayToken(proof);
      expect(response.status, label).toBe(401);
      expect(response.body, `${label}: the claim alone must not earn key_revoked or the ledger`).toEqual({ error: "unauthorized" });
    }
    // The revoked key itself: key_revoked with the signed evidence.
    const evidence = await requestRelayToken(await signProof(doomed.authKey, claim));
    expect(evidence.status).toBe(401);
    expect(evidence.body.error).toBe("key_revoked");
    expect(evidence.body.token).toBeUndefined();
    const ledger = evidence.body.ledger as { transitions: { payload: { operation: { type: string; endpointId?: string } } }[] };
    expect(ledger.transitions.some(item => item.payload.operation.type === "revoke_device" && item.payload.operation.endpointId === doomed.device.endpoint.id)).toBe(true);
  } finally {
    await second.close();
  }
});

// ---- Full database rollback and the browser's re-offer ----

type Tip = { revision: number; head: string };
type FullRow = Tip & { ledger: unknown; sticky: unknown; checkpoint: string; checkpoint_mac: string };

async function serverTip(accountId: string): Promise<Tip | null> {
  try {
    return await withDb(async db => (await db.query("SELECT revision, head FROM account_ledger WHERE account_id=$1", [accountId])).rows[0] as Tip);
  } catch { return null; }
}

/** The page's own ledger replica tip (IndexedDB `ftown-ledger`, store `replicas`), or null while unreadable (never throws). */
async function localTip(page: Page, accountId: string): Promise<Tip | null> {
  try {
    return await page.evaluate(async id => {
      // Never create the database: an empty one would shadow the app's own upgrade.
      if (!(await indexedDB.databases()).some(item => item.name === "ftown-ledger")) return null;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("ftown-ledger");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error("replica unavailable"));
      });
      try {
        if (!db.objectStoreNames.contains("replicas")) return null;
        const record = await new Promise<{ checkpoint?: { revision?: number; head?: string } } | undefined>((resolve, reject) => {
          const request = db.transaction("replicas").objectStore("replicas").get(id);
          request.onsuccess = () => resolve(request.result as { checkpoint?: { revision?: number; head?: string } } | undefined);
          request.onerror = () => reject(new Error("replica unavailable"));
        });
        const checkpoint = record?.checkpoint;
        return checkpoint && typeof checkpoint.revision === "number" && typeof checkpoint.head === "string" ? { revision: checkpoint.revision, head: checkpoint.head } : null;
      } finally { db.close(); }
    }, accountId);
  } catch { return null; }
}

/** The authenticator's signature counter for the account's passkey: it advances on every assertion (no prompt means no change). */
async function signCount(second: SecondAccount): Promise<number> {
  const held = await (await virtualAuthenticator(second.page)).credentials();
  const own = held.find(item => item.credentialId === second.account.credential.credentialId);
  if (!own) throw new Error("the account's passkey is not in its authenticator");
  return own.signCount;
}

interface RolledBack {
  second: SecondAccount;
  doomed: Awaited<ReturnType<typeof browserDeviceWithKey>>;
  claim: { accountId: string; kind: "device"; keyId: string; purpose: "relay" };
  /** The server's tip before (pre) and after (post) the revocation. */
  pre: Tip;
  post: Tip;
}

/**
 * A throwaway account whose browser holds the post-revocation chain while the server is fully rolled back to the row from
 * before the revocation. Its browser is left on a same-origin page WITHOUT the app (no ledger client running).
 */
async function rolledBackAccount(browser: Parameters<typeof createSecondAccount>[0], name: string): Promise<RolledBack> {
  const second = await createSecondAccount(browser, { name: `${name} ${randomBytes(3).toString("hex")}` });
  const page = second.page;
  const doomed = await browserDeviceWithKey(second.accountId, "E2E device rolled back", Date.now());
  const claim = { accountId: second.accountId, kind: "device" as const, keyId: doomed.device.endpoint.id, purpose: "relay" as const };
  // Each server write is passkey-signed here (the account passkey, Node-side); the browser learns it like any change: on load.
  const learn = async (tip: Tip) => {
    await page.goto("/dashboard");
    await expect.poll(() => localTip(page, second.accountId), { timeout: 30_000, message: "the browser's replica follows the server" }).toEqual(tip);
  };
  await appendOperation({ type: "add_device", device: doomed.device }, second.account);
  expect((await requestRelayToken(await signProof(doomed.authKey, claim))).status, "D2 is trusted").toBe(200);
  const pre = (await serverTip(second.accountId))!;
  await learn(pre);
  const snapshot = await withDb(async db => (await db.query(
    "SELECT ledger, revision, head, sticky, checkpoint, checkpoint_mac FROM account_ledger WHERE account_id=$1", [second.accountId])).rows[0] as FullRow);
  expect(snapshot.checkpoint).not.toBeNull();

  await appendOperation({ type: "revoke_device", endpointId: doomed.device.endpoint.id }, second.account);
  const revoked = await requestRelayToken(await signProof(doomed.authKey, claim));
  expect(revoked.status).toBe(401);
  expect(revoked.body.error).toBe("key_revoked");
  const post = (await serverTip(second.accountId))!;
  expect(post.revision).toBe(pre.revision + 1);
  await learn(post);
  await quiet(page);

  // Full rollback: the whole row as it was before the revocation (internally consistent, correctly sealed).
  await withDb(db => db.query("UPDATE account_ledger SET ledger=$2::jsonb, revision=$3, head=$4, sticky=$5::jsonb, checkpoint=$6, checkpoint_mac=$7 WHERE account_id=$1",
    [second.accountId, JSON.stringify(snapshot.ledger), snapshot.revision, snapshot.head, JSON.stringify(snapshot.sticky), snapshot.checkpoint, snapshot.checkpoint_mac]));
  expect(await serverTip(second.accountId)).toEqual(pre);
  // The accepted window: until a holder of the newer chain shows up, the server serves the older chain, and D2 is trusted again.
  const reopened = await requestRelayToken(await signProof(doomed.authKey, claim));
  expect(reopened.status, "the rolled-back server trusts D2 again (accepted window)").toBe(200);
  expect(await localTip(page, second.accountId), "the browser keeps the newer chain").toEqual(post);
  return { second, doomed, claim, pre, post };
}

/** After the repair: the server is at the post-revocation tip again, D2 is refused, and the account's browser still works. */
async function expectRepaired(state: RolledBack, page: Page): Promise<void> {
  const { second, doomed, claim, post } = state;
  const refused = await requestRelayToken(await signProof(doomed.authKey, claim));
  expect(refused.status, "SECURITY: the revoked device is trusted after the repair").toBe(401);
  expect(refused.body.error).toBe("key_revoked");
  expect(refused.body.token).toBeUndefined();
  expect((await page.request.post(`${UI_BASE_URL}/api/auth/token`)).status()).toBe(200);
  const legit = await requestRelayToken(await signWithBrowserDeviceKey(page, {
    accountId: second.accountId, kind: "device", keyId: second.endpointId, nonce: await serverNonce("relay"), purpose: "relay", audience,
  }));
  expect(legit.status).toBe(200);
  expect(await serverTip(second.accountId)).toEqual(post);
}

test("re-offer: a fully rolled-back server is repaired by the next browser that connects, without a passkey prompt", async ({ browser }) => {
  test.setTimeout(180_000);
  const state = await rolledBackAccount(browser, "E2E reoffer");
  const { second, pre, post } = state;
  try {
    const page = second.page;
    const countBefore = await signCount(second);
    expect(countBefore, "the counter advances on assertions (account creation made some)").toBeGreaterThan(0);
    // Trigger: B1 loads its dashboard (as a user would). The app's ledger client refreshes on load (bridges:ledger subscribed).
    const local: (Tip | null)[] = [];
    const started = Date.now();
    await page.goto("/dashboard");
    await expect.poll(async () => {
      local.push(await localTip(page, second.accountId));
      return serverTip(second.accountId);
    }, { timeout: 60_000, intervals: [100], message: "the server row returns to the post-revocation tip" }).toEqual(post);
    const repairedMs = Date.now() - started;
    test.info().annotations.push({ type: "re-offer repair after dashboard load", description: `${repairedMs} ms` });
    console.log(`[ledger-checkpoint] re-offer repaired the rolled-back server ${repairedMs} ms after the dashboard load`);
    expect(await signCount(second), "no passkey assertion was made by the repair").toBe(countBefore);
    const readable = local.filter((tip): tip is Tip => tip !== null);
    expect(readable.length, "the local replica was readable during the repair").toBeGreaterThan(0);
    expect(readable.filter(tip => tip.revision !== post.revision || tip.head !== post.head), "B1's own chain never went back").toEqual([]);
    expect(pre.revision).toBe(post.revision - 1);
    await expectRepaired(state, page);
  } finally {
    await second.close();
  }
});

test("re-offer control: with no browser open a full rollback stays; opening the account's browser repairs it", async ({ browser }) => {
  test.setTimeout(180_000);
  const state = await rolledBackAccount(browser, "E2E reoffer control");
  const { second, pre, post } = state;
  try {
    // No browser of this account is open: close its only page (the context keeps its cookies and IndexedDB, like a closed tab).
    await second.page.close();
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      expect(await serverTip(second.accountId), "the server stays rolled back while no browser holds a connection").toEqual(pre);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    // The reopened page has NO virtual authenticator (one lives per page): the repair cannot involve a passkey at all.
    const page = await second.context.newPage();
    const started = Date.now();
    await page.goto("/dashboard");
    await expect.poll(() => serverTip(second.accountId), { timeout: 60_000, intervals: [100] }).toEqual(post);
    const repairedMs = Date.now() - started;
    test.info().annotations.push({ type: "re-offer repair after opening the browser", description: `${repairedMs} ms` });
    console.log(`[ledger-checkpoint] opening the browser repaired the rolled-back server after ${repairedMs} ms`);
    expect(await localTip(page, second.accountId)).toEqual(post);
    await expectRepaired(state, page);
  } finally {
    await second.close();
  }
});

/** Rows an account owns in each per-account table (all `REFERENCES accounts(account_id) ON DELETE CASCADE` in ui/schema.sql). */
const ACCOUNT_TABLES = ["accounts", "account_ledger", "security_endpoint_directory", "security_device_display_names", "pair_mailbox", "push_subscriptions", "push_events"] as const;
async function accountRows(accountId: string): Promise<Record<string, number>> {
  return withDb(async db => {
    const counts: Record<string, number> = {};
    for (const table of ACCOUNT_TABLES) counts[table] = (await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE account_id=$1`, [accountId])).rows[0].n as number;
    return counts;
  });
}

test("re-offer never re-creates a deleted account: the browser holding its chain cannot bring it back", async ({ browser }) => {
  test.setTimeout(180_000);
  const second = await createSecondAccount(browser, { name: `E2E deleted account ${randomBytes(3).toString("hex")}` });
  try {
    const page = second.page;
    const origin = { origin: UI_BASE_URL };
    // Per-account rows to watch cascade: directory entry, display name, pair mailbox entry and push subscription of this browser.
    const own = (await serverLedger(second.account)).checkpoint.devices.find(item => item.endpoint.id === second.endpointId)!;
    expect((await page.request.put("/api/security/endpoints", { headers: origin, data: { protocolVersion: 1, bridgeId: null, label: own.label, endpoint: own.endpoint } })).status()).toBe(200);
    expect((await page.request.put("/api/security/device-names", { headers: origin, data: { kind: "browser", id: second.endpointId, name: "E2E doomed browser" } })).status()).toBe(200);
    expect((await page.request.put(`/api/pair/${randomBytes(32).toString("base64url")}`, { data: { sealed: "e2e-doomed" } })).status()).toBe(204);
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
    expect((await page.request.post("/api/push", { headers: origin, data: {
      endpoint: `https://fcm.googleapis.com/fcm/send/e2e-doomed-${randomBytes(8).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    } })).status()).toBe(201);
    const local = await localTip(page, second.accountId);
    expect(local, "the browser's replica holds the account's chain").not.toBeNull();
    const countBefore = await signCount(second);
    const before = await accountRows(second.accountId);
    expect(before.accounts).toBe(1);
    await quiet(page);

    await withDb(db => db.query("DELETE FROM accounts WHERE account_id=$1", [second.accountId]));
    const after = await accountRows(second.accountId);
    test.info().annotations.push({ type: "cascade on account delete", description: ACCOUNT_TABLES.map(table => `${table} ${before[table]}->${after[table]}`).join(", ") });
    expect(Object.values(after).every(count => count === 0), JSON.stringify(after)).toBe(true);

    const posts: number[] = [];
    const started = Date.now();
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/account/ledger") posts.push(Date.now() - started);
    });
    await page.goto("/dashboard");
    // For 10 s the account stays gone: no row, and the public read is 404.
    const anonymous = await apiRequest.newContext({ baseURL: UI_BASE_URL, extraHTTPHeaders: { "x-real-ip": `2001:db8:de1:${randomBytes(10).toString("hex").match(/.{4}/g)!.join(":")}` } });
    try {
      while (Date.now() - started < 10_000) {
        expect((await anonymous.get(`/api/account/ledger?accountId=${second.accountId}`)).status(), "SECURITY: a deleted account was re-created").toBe(404);
        expect((await accountRows(second.accountId)).account_ledger).toBe(0);
        await page.waitForTimeout(1000);
      }
    } finally { await anonymous.dispose(); }
    // ...and the page settles: count the browser's ledger POSTs over 15 s from the load.
    await page.waitForTimeout(Math.max(0, 15_000 - (Date.now() - started)));
    const url = new URL(page.url()).pathname;
    const alert = await page.locator("#login-error").innerText().catch(() => "");
    const signInVisible = await page.getByRole("button", { name: "Sign in with passkey" }).isVisible().catch(() => false);
    const headings = (await page.getByRole("heading").allInnerTexts().catch(() => [])).join(" | ");
    const seen = `url ${url}; login error ${JSON.stringify(alert.trim())}; sign-in button ${signInVisible}; headings ${JSON.stringify(headings)}; ledger POSTs ${posts.length} at [${posts.join(", ")}] ms`;
    test.info().annotations.push({ type: "deleted account: what the user sees after 15 s", description: seen });
    console.log(`[ledger-checkpoint] deleted account, after 15 s: ${seen}`);
    expect(posts.length, "the page must not loop ledger writes").toBeLessThanOrEqual(2);
    // A sane end state: the sign-in page (observed: /login with "Sign in with passkey" and no error message).
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
    expect(await accountRows(second.accountId)).toEqual(after);
    expect(await signCount(second), "no passkey prompt").toBe(countBefore);
  } finally {
    await second.close();
  }
});

// ---- Removals the server refused (the panel's unsaved states) ----

const UNSAVED_DETAIL = "Removal not saved to the server yet. It can still connect. Retrying…";
const UNSAVED_SELF_DETAIL = "This browser's removal is not saved to the server yet. It can still connect. Retrying…";

/**
 * Answers the page's ledger POSTs (reads always pass): `refuse(n)` decides for the n-th POST (1-based) whether to answer
 * 429 rate_limited and with which Retry-After (seconds; null: no header). Records each POST's time and outcome.
 */
async function refuseLedgerWrites(page: Page, refuse: (n: number) => { retryAfter: number | null } | null) {
  const log: { at: number; refused: boolean }[] = [];
  await page.route(url => url.pathname === "/api/account/ledger", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const decision = refuse(log.length + 1);
    log.push({ at: Date.now(), refused: decision !== null });
    if (!decision) return route.fallback();
    return route.fulfill({
      status: 429, contentType: "application/json", body: JSON.stringify({ error: "rate_limited" }),
      headers: { "Cache-Control": "no-store", ...(decision.retryAfter === null ? {} : { "Retry-After": String(decision.retryAfter) }) },
    });
  });
  return { log, refused: () => log.filter(item => item.refused).length };
}

async function openSecurity(page: Page) {
  await page.getByRole("button", { name: "Open security", exact: true }).click();
  return page.getByRole("dialog", { name: "Security", exact: true });
}

/** Select a browser in the access map and remove it with the panel (one confirmation, one passkey approval). */
async function removeBrowserInPanel(dialog: ReturnType<Page["getByRole"]>, endpointId: string): Promise<void> {
  const node = dialog.locator(`[data-access-kind="browser"][data-access-node="${endpointId}"]`).first();
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.click();
  const remove = dialog.getByRole("button", { name: /^Remove browser / });
  await expect(remove).toBeEnabled();
  await remove.click();
  await dialog.getByRole("group", { name: "Confirm browser removal", exact: true }).getByRole("button", { name: "Confirm remove browser", exact: true }).click();
}

async function serverRevoked(account: SecondAccount["account"], endpointId: string): Promise<boolean> {
  try { return (await serverLedger(account)).checkpoint.revokedDeviceIds.includes(endpointId); } catch { return false; }
}

/** A throwaway account whose browser B1 knows a second device D2 (added by the account passkey); B1 is on its dashboard. */
async function accountWithSecondDevice(browser: Parameters<typeof createSecondAccount>[0], name: string) {
  const second = await createSecondAccount(browser, { name: `${name} ${randomBytes(3).toString("hex")}` });
  const d2 = await browserDeviceWithKey(second.accountId, "E2E second device", Date.now());
  const claim = { accountId: second.accountId, kind: "device" as const, keyId: d2.device.endpoint.id, purpose: "relay" as const };
  await appendOperation({ type: "add_device", device: d2.device }, second.account);
  const added = (await serverTip(second.accountId))!;
  await second.page.goto("/dashboard");
  await expect.poll(() => localTip(second.page, second.accountId), { timeout: 30_000 }).toEqual(added);
  return { second, d2, claim, added };
}

test("a refused removal waits for the server's Retry-After, then the automatic retry delivers it (no click)", async ({ browser }) => {
  test.setTimeout(180_000);
  const { second, d2, claim, added } = await accountWithSecondDevice(browser, "E2E unsaved removal");
  try {
    const page = second.page;
    const writes = await refuseLedgerWrites(page, n => n === 1 ? { retryAfter: 3 } : null);
    const countBefore = await signCount(second);
    const dialog = await openSecurity(page);
    await removeBrowserInPanel(dialog, d2.device.endpoint.id);
    const refusedAt = Date.now();

    // While the server's delay is pending: the amber text and a disabled "Retry in N s".
    const unsaved = dialog.getByRole("group", { name: "Removal not saved", exact: true });
    await expect(unsaved).toBeVisible({ timeout: 30_000 });
    await expect(unsaved).toContainText(UNSAVED_DETAIL);
    const waiting = unsaved.getByRole("button", { name: /^Retry in \d+ s$/ });
    await expect(waiting).toBeVisible();
    await expect(waiting).toBeDisabled();
    expect(writes.refused()).toBe(1);
    expect(await serverTip(second.accountId)).toEqual(added);
    expect((await requestRelayToken(await signProof(d2.authKey, claim))).status, "the refused removal is not in force").toBe(200);
    expect(await signCount(second), "the removal itself asked for the passkey once").toBe(countBefore + 1);
    // After the delay the button is enabled again ("Retry now") — not clicked here.
    await expect(unsaved.getByRole("button", { name: "Retry now", exact: true })).toBeEnabled({ timeout: 10_000 });

    // The automatic retry delivers the removal on its own.
    await expect.poll(() => serverRevoked(second.account, d2.device.endpoint.id), { timeout: 90_000, intervals: [250], message: "the automatic retry stores the revocation" }).toBe(true);
    const deliveredMs = Date.now() - refusedAt;
    test.info().annotations.push({ type: "automatic retry delivered the refused removal", description: `${deliveredMs} ms after the refusal (Retry-After 3 s); POSTs ${writes.log.length}` });
    await expect(unsaved).toBeHidden({ timeout: 15_000 });
    await expect(dialog.getByText("Removal not saved to the server yet", { exact: false })).toHaveCount(0);
    await expect(dialog.locator(`[data-access-kind="browser"][data-access-node="${d2.device.endpoint.id}"]`)).toHaveCount(0);
    const revoked = await requestRelayToken(await signProof(d2.authKey, claim));
    expect(revoked.status).toBe(401);
    expect(revoked.body.error).toBe("key_revoked");
    expect(await signCount(second), "exactly one passkey assertion in total (the removal)").toBe(countBefore + 1);
  } finally {
    await second.close();
  }
});

test("a refused removal without Retry-After is delivered at once by Retry now, long before the automatic retry", async ({ browser }) => {
  test.setTimeout(180_000);
  const { second, d2, claim, added } = await accountWithSecondDevice(browser, "E2E retry now");
  try {
    const page = second.page;
    const writes = await refuseLedgerWrites(page, n => n <= 2 ? { retryAfter: null } : null);
    const countBefore = await signCount(second);
    const dialog = await openSecurity(page);
    await removeBrowserInPanel(dialog, d2.device.endpoint.id);
    const refusedAt = Date.now();
    const unsaved = dialog.getByRole("group", { name: "Removal not saved", exact: true });
    await expect(unsaved).toBeVisible({ timeout: 30_000 });
    await expect(unsaved).toContainText(UNSAVED_DETAIL);
    expect(await serverTip(second.accountId)).toEqual(added);
    // No server delay: "Retry now" is enabled; each click sends at once (two POSTs are refused in all).
    const retry = unsaved.getByRole("button", { name: "Retry now", exact: true });
    let clicks = 0;
    while (!await serverRevoked(second.account, d2.device.endpoint.id) && Date.now() - refusedAt < 25_000) {
      await expect(retry).toBeEnabled({ timeout: 10_000 });
      await retry.click();
      clicks += 1;
      await expect.poll(async () => await serverRevoked(second.account, d2.device.endpoint.id) || writes.log.length > clicks, { timeout: 10_000 }).toBe(true);
      await page.waitForTimeout(300);
    }
    const deliveredMs = Date.now() - refusedAt;
    expect(await serverRevoked(second.account, d2.device.endpoint.id), "Retry now delivered the removal").toBe(true);
    expect(deliveredMs, "delivered by the click, not by the ≥ 24 s automatic retry").toBeLessThan(24_000);
    expect(writes.refused()).toBe(2);
    test.info().annotations.push({ type: "Retry now delivered the refused removal", description: `${clicks} click(s), ${deliveredMs} ms after the first refusal; POSTs ${writes.log.length} (2 refused)` });
    await expect(unsaved).toBeHidden({ timeout: 15_000 });
    expect((await requestRelayToken(await signProof(d2.authKey, claim))).body.error).toBe("key_revoked");
    expect(await signCount(second), "exactly one passkey assertion in total (the removal)").toBe(countBefore + 1);
  } finally {
    await second.close();
  }
});

test("a refused removal survives a reload: still shown as not saved, then delivered once the server accepts writes", async ({ browser }) => {
  test.setTimeout(180_000);
  const { second, d2, claim, added } = await accountWithSecondDevice(browser, "E2E unsaved reload");
  try {
    const page = second.page;
    let refusing = true;
    const writes = await refuseLedgerWrites(page, () => refusing ? { retryAfter: null } : null);
    const countBefore = await signCount(second);
    let dialog = await openSecurity(page);
    await removeBrowserInPanel(dialog, d2.device.endpoint.id);
    await expect(dialog.getByRole("group", { name: "Removal not saved", exact: true })).toContainText(UNSAVED_DETAIL, { timeout: 30_000 });

    await page.reload();
    await waitForBridgeAgnosticDashboard(page);
    dialog = await openSecurity(page);
    const node = dialog.locator(`[data-access-kind="browser"][data-access-node="${d2.device.endpoint.id}"]`).first();
    await expect(node, "the refused removal is still listed after the reload").toBeVisible({ timeout: 30_000 });
    await node.click();
    const unsaved = dialog.getByRole("group", { name: "Removal not saved", exact: true });
    await expect(unsaved).toContainText(UNSAVED_DETAIL);
    expect(await serverTip(second.accountId)).toEqual(added);
    expect((await requestRelayToken(await signProof(d2.authKey, claim))).status).toBe(200);

    refusing = false;
    const refusedSoFar = writes.refused();
    const retry = unsaved.getByRole("button", { name: "Retry now", exact: true });
    await expect(retry).toBeEnabled({ timeout: 15_000 });
    await retry.click();
    await expect.poll(() => serverRevoked(second.account, d2.device.endpoint.id), { timeout: 30_000 }).toBe(true);
    await expect(unsaved).toBeHidden({ timeout: 15_000 });
    test.info().annotations.push({ type: "unsaved removal across a reload", description: `${refusedSoFar} POSTs refused (incl. after the reload), then delivered by Retry now` });
    expect((await requestRelayToken(await signProof(d2.authKey, claim))).body.error).toBe("key_revoked");
    expect(await signCount(second), "exactly one passkey assertion in total (the removal)").toBe(countBefore + 1);
  } finally {
    await second.close();
  }
});

test("Remove this browser, refused: 'Removing this browser…' until the server stores it, then 'This browser was removed'", async ({ browser }) => {
  test.setTimeout(180_000);
  const second = await createSecondAccount(browser, { name: `E2E remove self ${randomBytes(3).toString("hex")}` });
  const contextB2 = await browser.newContext();
  try {
    // B2: the same account's synced passkey on another browser (identify + add this browser).
    const pageB2 = await contextB2.newPage();
    await signIn(pageB2, { account: second.account, browserLabel: "E2E B2" });
    const idB2 = await browserEndpointId(pageB2, second.accountId);
    const proofB2 = async () => requestRelayToken(await signWithBrowserDeviceKey(pageB2, {
      accountId: second.accountId, kind: "device", keyId: idB2, nonce: await serverNonce("relay"), purpose: "relay", audience,
    }));
    const authenticatorB2 = await virtualAuthenticator(pageB2);
    const countB2 = async () => (await authenticatorB2.credentials()).find(item => item.credentialId === second.account.credential.credentialId)?.signCount ?? -1;
    const countBefore = await countB2(); // after B2's own sign-in (identify + add this browser)
    expect(countBefore).toBeGreaterThan(0);
    const writes = await refuseLedgerWrites(pageB2, n => n === 1 ? { retryAfter: 2 } : null);
    const dialog = await openSecurity(pageB2);
    await removeBrowserInPanel(dialog, idB2);
    await expect.poll(() => writes.refused(), { timeout: 15_000 }).toBe(1);
    const refusedAt = Date.now();

    // The full page (the Security panel is not mounted there) while the server still lists B2.
    const removing = pageB2.getByRole("heading", { name: "Removing this browser…", exact: true });
    await expect(removing).toBeVisible({ timeout: 10_000 });
    await expect(pageB2.getByRole("status").filter({ hasText: UNSAVED_SELF_DETAIL })).toBeVisible();
    await expect(pageB2.getByRole("status").filter({ hasText: UNSAVED_SELF_DETAIL })).toHaveText(UNSAVED_SELF_DETAIL);
    await expect(pageB2.getByRole("button", { name: /^Retry in \d+ s$/ })).toBeDisabled();
    await expect(pageB2.getByRole("button", { name: "Sign in again", exact: true })).toHaveCount(0);
    await expect(pageB2.getByRole("heading", { name: "This browser was removed", exact: true })).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    const unsavedLedger = (await serverLedger(second.account)).checkpoint;
    expect(unsavedLedger.devices.map(item => item.endpoint.id), "the server still lists B2").toContain(idB2);
    expect(unsavedLedger.revokedDeviceIds).not.toContain(idB2);
    expect((await proofB2()).status, "B2's key still gets a token while the removal is not stored").toBe(200);

    // Delivered by the user's click once the Retry-After has passed (the automatic retry would take ~30 s more).
    const retry = pageB2.getByRole("button", { name: "Retry now", exact: true });
    await expect(retry).toBeEnabled({ timeout: 10_000 });
    await retry.click();
    await expect.poll(() => serverRevoked(second.account, idB2), { timeout: 15_000, intervals: [250], message: "Retry now stores B2's removal" }).toBe(true);
    const deliveredMs = Date.now() - refusedAt;
    // Live switch to the confirmed screen.
    await expect(pageB2.getByRole("heading", { name: "This browser was removed", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(pageB2.getByRole("alert").filter({ hasText: "This browser was removed from your account, so it can no longer open encrypted sessions. Sign in with your passkey to add it again." })).toBeVisible();
    await expect(pageB2.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();
    await expect(removing).toHaveCount(0);
    test.info().annotations.push({ type: "Remove this browser: delivered by Retry now", description: `${deliveredMs} ms after the refusal (Retry-After 2 s); POSTs ${writes.log.length} (1 refused)` });
    const refused = await proofB2();
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("key_revoked");
    expect(await countB2(), "exactly one passkey assertion for the removal").toBe(countBefore + 1);
  } finally {
    await contextB2.close();
    await second.close();
  }
});

/** The dashboard after a reload, whether or not the account has computers. */
async function waitForBridgeAgnosticDashboard(page: Page): Promise<void> {
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Open security", exact: true })).toBeVisible({ timeout: 30_000 });
}
