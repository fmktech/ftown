import { createHash, randomBytes, webcrypto } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Ledger, LedgerCheckpoint, LedgerOperation, LedgerTransition, PasskeySignature, Signed } from "../../bridge/src/security/ledger/protocol";
import type { AuthProof, AuthProofFields } from "../../bridge/src/security/ledger/proof";
import { E2E_DIR, UI_BASE_URL } from "./config";
import { readRunAccount, RP_ID, type RunAccount } from "./passkey";

/**
 * Node-side tools over the run account, used for TEST HOUSEKEEPING and for
 * protocol-level assertions — never in place of a UI flow under test:
 *  - sign ledger transitions with the run's passkey (the private key exported
 *    from the virtual authenticator), building byte-faithful WebAuthn
 *    assertions exactly like the browser would for this origin;
 *  - read the server's ledger and verify it with the real shared verifier;
 *  - sign device/bridge key proofs (nonce + relay-token).
 * The ledger code is the built bridge module (bridge/dist), the same code the
 * bridge runs.
 */

type LedgerModule = typeof import("../../bridge/src/security/ledger/ledger");
type ProofModule = typeof import("../../bridge/src/security/ledger/proof");
const DIST = join(E2E_DIR, "..", "bridge", "dist", "security", "ledger");
let ledgerModule: Promise<LedgerModule> | null = null;
let proofModule: Promise<ProofModule> | null = null;
export function ledgerLib(): Promise<LedgerModule> {
  ledgerModule ??= import(pathToFileURL(join(DIST, "ledger.js")).href) as Promise<LedgerModule>;
  return ledgerModule;
}
export function proofLib(): Promise<ProofModule> {
  proofModule ??= import(pathToFileURL(join(DIST, "proof.js")).href) as Promise<ProofModule>;
  return proofModule;
}

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
/** A synthetic per-helper client source (x-real-ip is honoured only in this test deployment). */
const SOURCE = `2001:db8:a11:${randomBytes(10).toString("hex").match(/.{4}/g)!.join(":")}`;

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${UI_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", accept: "application/json", "x-real-ip": SOURCE },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { /* empty body */ }
  return { status: response.status, body };
}

/** The server's ledger for the run account, verified with the shared verifier. */
export async function serverLedger(account: RunAccount = readRunAccount()): Promise<{ ledger: Ledger; checkpoint: LedgerCheckpoint }> {
  const { status, body } = await api(`/api/account/ledger?accountId=${account.accountId}`);
  if (status !== 200) throw new Error(`GET /api/account/ledger: ${status}`);
  const lib = await ledgerLib();
  const ledger = lib.parseLedger(body.ledger);
  return { ledger, checkpoint: await lib.verifyLedger(ledger) };
}

/** CDP reports binary fields in standard base64; the ledger names credentials in base64url. */
export function ledgerCredentialId(account: RunAccount = readRunAccount()): string {
  return Buffer.from(account.credential.credentialId, "base64").toString("base64url");
}

/** A WebAuthn assertion by the run passkey over `challenge`, as Chrome would produce it for this origin (UP|UV). */
export async function passkeyAssertion(challenge: Uint8Array, account: RunAccount = readRunAccount()): Promise<PasskeySignature> {
  const key = await webcrypto.subtle.importKey("pkcs8", Buffer.from(account.credential.privateKey, "base64"), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const authenticatorData = Buffer.concat([createHash("sha256").update(account.credential.rpId ?? RP_ID).digest(), Buffer.from([0x05, 0, 0, 0, 0])]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin: new URL(account.origin).origin, crossOrigin: false }));
  const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
  const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signed));
  return { authenticatorData: b64url(authenticatorData), clientDataJSON: b64url(clientDataJSON), signature: b64url(rawToDer(raw)) };
}

function rawToDer(raw: Buffer): Buffer {
  const integer = (value: Buffer) => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start += 1;
    const body = value[start] & 0x80 ? Buffer.concat([Buffer.from([0]), value.subarray(start)]) : value.subarray(start);
    return Buffer.concat([Buffer.from([0x02, body.length]), body]);
  };
  const content = Buffer.concat([integer(raw.subarray(0, 32)), integer(raw.subarray(32, 64))]);
  return Buffer.concat([Buffer.from([0x30, content.length]), content]);
}

/**
 * Append one passkey-signed operation to the server's ledger (POST the whole
 * chain). Retries on a lost race: the record must be in the winning chain.
 */
export async function appendOperation(operation: LedgerOperation, account: RunAccount = readRunAccount()): Promise<Ledger> {
  const lib = await ledgerLib();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { ledger, checkpoint } = await serverLedger(account);
    const payload: LedgerTransition = lib.nextTransition(checkpoint, ledgerCredentialId(account), operation, Date.now(), lib.ledgerLastIssuedAt(ledger));
    const record: Signed<LedgerTransition> = { payload, signature: await passkeyAssertion(await lib.ledgerChallenge(payload), account) };
    const candidate: Ledger = { genesis: ledger.genesis, transitions: [...ledger.transitions, record] };
    const { status, body } = await api("/api/account/ledger", { method: "POST", body: { ledger: candidate } });
    if (status === 200 || status === 201) {
      const winner = lib.parseLedger(body.ledger);
      const head = await lib.ledgerHead(payload);
      if (await Promise.all(winner.transitions.map(item => lib.ledgerHead(item.payload))).then(heads => heads.includes(head))) return winner;
      continue; // a concurrent append won this revision: rebuild on the new head
    }
    if (status === 429 || status === 503) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
    throw new Error(`POST /api/account/ledger: ${status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  throw new Error("could not append the ledger operation");
}

/** Revoke browsers (housekeeping after a test). Ids already revoked or unknown are skipped. */
export async function revokeDevices(endpointIds: string[], account: RunAccount = readRunAccount()): Promise<void> {
  for (const endpointId of endpointIds) {
    const { checkpoint } = await serverLedger(account);
    if (!checkpoint.devices.some(device => device.endpoint.id === endpointId)) continue;
    await appendOperation({ type: "revoke_device", endpointId }, account);
  }
}

/** POST /api/auth/nonce. */
export async function serverNonce(purpose: "session" | "relay"): Promise<string> {
  const { status, body } = await api("/api/auth/nonce", { method: "POST", body: { purpose } });
  if (status !== 200 || typeof body.nonce !== "string") throw new Error(`POST /api/auth/nonce: ${status}`);
  return body.nonce;
}

/** Sign a key-possession proof with a private key (e.g. a bridge's auth key read from its identity file). */
export async function signProof(privateKey: CryptoKey, fields: Omit<AuthProofFields, "nonce" | "audience"> & { nonce?: string; audience?: string }): Promise<AuthProof> {
  const proof = await proofLib();
  return proof.signAuthProof(privateKey, {
    ...fields,
    nonce: fields.nonce ?? await serverNonce(fields.purpose),
    audience: fields.audience ?? new URL(UI_BASE_URL).origin,
  });
}

/** POST /api/auth/relay-token with a proof. */
export async function requestRelayToken(proof: AuthProof, head: string | null = null): Promise<{ status: number; body: Record<string, unknown> }> {
  return api("/api/auth/relay-token", { method: "POST", body: { proof, head } });
}

/** Import a bridge's ECDSA auth private key (JWK from <dataDir>/security/bridge-identity.json). */
export async function importAuthKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return webcrypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) as Promise<CryptoKey>;
}
