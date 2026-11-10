import type { Page } from "@playwright/test";
import type { AuthProof, AuthProofFields } from "../../bridge/src/security/ledger/proof";

/**
 * Sign an auth proof with the page's OWN browser device key, inside the page (the key is a non-extractable CryptoKey in
 * IndexedDB "ftown-device-auth"): the same bytes signAuthProof (bridge/src/security/ledger/proof.ts) signs, low-S
 * normalized. Lets a test present a proof that only that browser could have produced, for any fields it chooses.
 */
export async function signWithBrowserDeviceKey(page: Page, fields: AuthProofFields): Promise<AuthProof> {
  return page.evaluate(async f => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ftown-device-auth");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("device auth storage unavailable"));
    });
    try {
      const record = await new Promise<{ privateKey?: CryptoKey } | undefined>((resolve, reject) => {
        const request = db.transaction("device-auth-v2").objectStore("device-auth-v2").get("device");
        request.onsuccess = () => resolve(request.result as { privateKey?: CryptoKey } | undefined);
        request.onerror = () => reject(new Error("device auth key unavailable"));
      });
      const key = record?.privateKey;
      if (!(key instanceof CryptoKey) || key.type !== "private" || key.extractable !== false) throw new Error("expected this browser's non-extractable device auth key");
      const text = "ftown-auth-proof-v1\n" + JSON.stringify({ accountId: f.accountId, audience: f.audience, keyId: f.keyId, kind: f.kind, nonce: f.nonce, purpose: f.purpose });
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(text)));
      const order = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
      const s = BigInt("0x" + Array.from(raw.subarray(32), byte => byte.toString(16).padStart(2, "0")).join(""));
      if (s > order / BigInt(2)) {
        const low = (order - s).toString(16).padStart(64, "0");
        for (let index = 0; index < 32; index += 1) raw[32 + index] = parseInt(low.slice(index * 2, index * 2 + 2), 16);
      }
      let binary = "";
      for (const byte of raw) binary += String.fromCharCode(byte);
      return { ...f, signature: btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
    } finally { db.close(); }
  }, fields);
}
