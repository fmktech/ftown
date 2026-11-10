import { expect, type Page } from "@playwright/test";
import { randomBytes, webcrypto } from "node:crypto";
import type { LedgerCheckpoint } from "../../bridge/src/security/ledger/protocol";
import { signWithBrowserDeviceKey } from "../helpers/browser-proof";
import { UI_BASE_URL } from "../helpers/config";
import { ledgerRow, withDb } from "../helpers/db";
import { test } from "../helpers/fixtures";
import { appendOperation, browserDeviceWithKey, requestRelayToken, serverNonce, signProof } from "../helpers/ledger-admin";
import { createSecondAccount, type SecondAccount } from "../helpers/second-account";

/**
 * Auth decisions read a checkpoint persisted with each ledger row, sealed with an HMAC keyed from AUTH_SECRET (which the
 * database does not hold; migration 0012). Here, on THROWAWAY accounts (never the shared account A):
 *  - a missing checkpoint is healed by re-verifying the passkey-signed chain, and auth keeps working;
 *  - a checkpoint edited in the database without a valid MAC is never trusted: a device injected that way gets nothing,
 *    the account's real device still works, and the row is healed back to what the chain says;
 *  - /api/auth/relay-token's `key_revoked` evidence (with the ledger) goes only to the holder of the revoked key: a proof
 *    that merely CLAIMS a revoked key id, signed by any other key, is a plain 401 unauthorized without the ledger.
 *    (computer-removal.spec.ts asserts the evidence for a revoked bridge's own key.)
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
      const minted = await second.page.request.post(`${UI_BASE_URL}/api/auth/token`);
      expect(minted.status()).toBe(200);
      expect(jwtSub((await minted.json() as { token: string }).token)).toBe(second.accountId);
      const healed = await ledgerRow(db, second.accountId);
      expect(healed.checkpoint).not.toBeNull();
      expect(healed.checkpoint_mac).not.toBeNull();
      expect(JSON.parse(healed.checkpoint!)).toEqual(original);
      expect(healed.version, "healing re-seals in place: it is not a ledger write").toBe(sealed.version);

      // (b) A device injected into the checkpoint text by SQL, MAC left as is (the database cannot compute it).
      const injected = await browserDeviceWithKey(second.accountId, "injected by SQL", Date.now());
      const forged: LedgerCheckpoint = { ...original, devices: [...original.devices, injected.device] };
      await db.query("UPDATE account_ledger SET checkpoint=$2 WHERE account_id=$1", [second.accountId, JSON.stringify(forged)]);
      expect((JSON.parse((await ledgerRow(db, second.accountId)).checkpoint!) as LedgerCheckpoint).devices.map(item => item.endpoint.id))
        .toContain(injected.device.endpoint.id);
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
