import { createHash, randomBytes, webcrypto } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Ledger, LedgerCheckpoint, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, PasskeySignature, Signed,
} from "../../bridge/src/security/ledger/protocol";
import type { AuthProof, AuthProofFields } from "../../bridge/src/security/ledger/proof";
import type { SoftPasskey } from "../../bridge/src/security/ledger/testing";
import { E2E_DIR, UI_BASE_URL } from "./config";
import { readRunAccount, RP_ID, type RunAccount } from "./passkey";

/**
 * Node-side tools over an account (default: the shared account A), used for
 * TEST HOUSEKEEPING and for protocol-level assertions — never in place of a UI
 * flow under test:
 *  - sign ledger transitions with an account's passkey (the private key exported
 *    from the virtual authenticator), building byte-faithful WebAuthn
 *    assertions exactly like the browser would for this origin;
 *  - read the server's ledger and verify it with the real shared verifier;
 *  - sign device/bridge key proofs (nonce + relay-token);
 *  - build complete creation chains for throwaway accounts (admission tests).
 * The ledger code is the built bridge module (bridge/dist), the same code the
 * bridge runs.
 */

type LedgerModule = typeof import("../../bridge/src/security/ledger/ledger");
type ProofModule = typeof import("../../bridge/src/security/ledger/proof");
type TestingModule = typeof import("../../bridge/src/security/ledger/testing");
type ChannelsModule = typeof import("../../bridge/src/security/ledger/channels");
const DIST = join(E2E_DIR, "..", "bridge", "dist", "security", "ledger");
let ledgerModule: Promise<LedgerModule> | null = null;
let proofModule: Promise<ProofModule> | null = null;
let testingModule: Promise<TestingModule> | null = null;
let channelsModule: Promise<ChannelsModule> | null = null;
export function ledgerLib(): Promise<LedgerModule> {
  ledgerModule ??= import(pathToFileURL(join(DIST, "ledger.js")).href) as Promise<LedgerModule>;
  return ledgerModule;
}
export function proofLib(): Promise<ProofModule> {
  proofModule ??= import(pathToFileURL(join(DIST, "proof.js")).href) as Promise<ProofModule>;
  return proofModule;
}
/** The TEST-ONLY software authenticator (createSoftPasskey). */
export function testingLib(): Promise<TestingModule> {
  testingModule ??= import(pathToFileURL(join(DIST, "testing.js")).href) as Promise<TestingModule>;
  return testingModule;
}
/** The channel-name builders the bridge and the UI use (`accountChannel`, `sessionChannel`). */
export function channelsLib(): Promise<ChannelsModule> {
  channelsModule ??= import(pathToFileURL(join(DIST, "channels.js")).href) as Promise<ChannelsModule>;
  return channelsModule;
}

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
/**
 * A synthetic client source per helper REQUEST (x-real-ip is honoured only in this test deployment; the server buckets IPv6
 * by /64, so the random part is in the /64). Housekeeping and polling helpers must never spend a per-source budget that a
 * later test's cleanup needs (a shared source hit `ledger-read` 120/min when tests polled the ledger).
 */
const source = () => `2001:db8:a11:${randomBytes(10).toString("hex").match(/.{4}/g)!.join(":")}`;

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${UI_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", accept: "application/json", "x-real-ip": source() },
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

/** `ledger` extended by passkey-signed records for `operations`, in order, built exactly as a browser signs them (nothing is sent). */
export async function signedExtension(ledger: Ledger, operations: LedgerOperation[], account: RunAccount = readRunAccount()): Promise<Ledger> {
  const lib = await ledgerLib();
  let current = ledger;
  let checkpoint = await lib.verifyLedger(current);
  for (const operation of operations) {
    const payload: LedgerTransition = lib.nextTransition(checkpoint, ledgerCredentialId(account), operation, Date.now(), lib.ledgerLastIssuedAt(current));
    const record: Signed<LedgerTransition> = { payload, signature: await passkeyAssertion(await lib.ledgerChallenge(payload), account) };
    current = { genesis: current.genesis, transitions: [...current.transitions, record] };
    checkpoint = await lib.verifyLedger(current);
  }
  return current;
}

/** POST a chain for an EXISTING account, bound to the head it extends (expectHead), as every bound writer must; null sends it unbound. */
export async function offerChain(ledger: Ledger, expectHead: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  return api("/api/account/ledger", { method: "POST", body: expectHead === null ? { ledger } : { ledger, expectHead } });
}

/**
 * Append one passkey-signed operation to the server's ledger: the stored chain plus one record, POSTed with `expectHead` (the
 * stored head it extends). A concurrent write (409 head_changed) is retried on the new head.
 */
export async function appendOperation(operation: LedgerOperation, account: RunAccount = readRunAccount()): Promise<Ledger> {
  const lib = await ledgerLib();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { ledger, checkpoint } = await serverLedger(account);
    const candidate = await signedExtension(ledger, [operation], account);
    const { status, body } = await offerChain(candidate, checkpoint.head);
    if (status === 200 || status === 201) return lib.parseLedger(body.ledger);
    if (status === 409 && body.error === "head_changed") continue; // a concurrent write won: rebuild on the new head
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

/** A fresh browser device of `accountId` for an add_device operation: ECDH endpoint point (id = SHA-256(point)) and a distinct ECDSA auth key. */
export async function browserDevice(accountId: string, label: string, approvedAt: number): Promise<LedgerDevice> {
  return (await browserDeviceWithKey(accountId, label, approvedAt)).device;
}

/** browserDevice plus the device's ECDSA auth private key, so a test can sign proofs as that device. */
export async function browserDeviceWithKey(accountId: string, label: string, approvedAt: number): Promise<{ device: LedgerDevice; authKey: CryptoKey }> {
  const endpoint = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const auth = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const point = Buffer.from(await webcrypto.subtle.exportKey("raw", endpoint.publicKey));
  const device: LedgerDevice = {
    endpoint: { version: 1, id: createHash("sha256").update(point).digest("base64url"), ownerId: accountId, kind: "browser", publicKey: b64url(point) },
    authPublicKey: b64url(Buffer.from(await webcrypto.subtle.exportKey("raw", auth.publicKey))),
    label,
    approvedAt,
  };
  return { device, authKey: auth.privateKey as CryptoKey };
}

export interface CreationLedger {
  ledger: Ledger;
  /** accountIdOf(genesis): the id the server would create. */
  accountId: string;
  passkey: SoftPasskey;
}

/**
 * A complete, validly signed chain that CREATES a new account, as the browser builds it: a software-passkey genesis
 * (origins [origin], rpId) followed by `devices` add_device transitions (default 1; the server requires at least one).
 * `origin` defaults to this run's public origin (an admissible chain); a foreign origin yields a self-consistent chain
 * that this server must refuse. `handle` defaults to 32 fresh random bytes. `deviceLabelLength` pads every device label
 * (at most 200, the ledger's label limit) to build large chains.
 */
export async function creationLedger(options: { origin?: string; devices?: number; handle?: string; label?: string; deviceLabelLength?: number } = {}): Promise<CreationLedger> {
  const [lib, testing] = await Promise.all([ledgerLib(), testingLib()]);
  const origin = options.origin ?? new URL(UI_BASE_URL).origin;
  const passkey = await testing.createSoftPasskey({ rpId: RP_ID, origin });
  const createdAt = Date.now();
  const payload: LedgerGenesis = {
    type: "ftown_account_genesis", version: 2, rpId: RP_ID, origins: [origin],
    handle: options.handle ?? randomBytes(32).toString("base64url"), createdAt,
    authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: options.label ?? "e2e soft passkey", addedAt: createdAt },
  };
  const accountId = await lib.accountIdOf(payload);
  let ledger: Ledger = { genesis: { payload, signature: await passkey.sign(await lib.ledgerChallenge(payload)) }, transitions: [] };
  let checkpoint = await lib.verifyLedger(ledger);
  for (let index = 0; index < (options.devices ?? 1); index += 1) {
    const device = await browserDevice(accountId, `e2e device ${index + 1}`.padEnd(options.deviceLabelLength ?? 0, "x"), createdAt);
    const next = lib.nextTransition(checkpoint, passkey.credentialId, { type: "add_device", device }, Date.now(), lib.ledgerLastIssuedAt(ledger));
    ledger = { genesis: ledger.genesis, transitions: [...ledger.transitions, { payload: next, signature: await passkey.sign(await lib.ledgerChallenge(next)) }] };
    // The verifier's add_device rule, applied without re-verifying the whole chain each round (verified once below).
    checkpoint = { ...checkpoint, revision: next.revision, head: await lib.ledgerHead(next), devices: [...checkpoint.devices, device] };
  }
  const verified = await lib.verifyLedger(ledger);
  if (verified.head !== checkpoint.head || verified.accountId !== accountId) throw new Error("creationLedger built an inconsistent chain");
  return { ledger, accountId, passkey };
}
