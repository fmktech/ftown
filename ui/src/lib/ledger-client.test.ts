import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import {
  accountIdOf, applyRevocations, authorityConsentChallenge, chooseLedger, ledgerChallenge, ledgerLastIssuedAt, ledgerRevocations, nextTransition, verifyLedger,
} from "@security/ledger/ledger";
import { confirmPairedLedger, createBridgePairRequest, encodePairLink, openPairApproval, PAIR_FRAGMENT_PREFIX, pairComparisonCode } from "@security/ledger/pairing";
import { generateAuthKey, parseAuthProof, verifyAuthProof } from "@security/ledger/proof";
import type { Ledger, LedgerBridge, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, PasskeySignature, Signed } from "@security/ledger/protocol";
import { createSoftPasskey } from "@security/ledger/testing";
import type { SoftPasskey } from "@security/ledger/testing";
import type { EndpointIdentity } from "@security/protocol";
import { LedgerClient, sanitizeLabel } from "./ledger-client";
import type { AttemptStorage, LedgerClientDeps } from "./ledger-client";
import { LedgerReplica, memoryReplicaStorage } from "./ledger-replica";
import type { LedgerReplicaStorage } from "./ledger-replica";
import type * as PasskeyModule from "./passkey";

const ORIGIN = "https://ftown.example";
const RP_ID = "ftown.example";
const b64url = (data: Uint8Array): string => Buffer.from(data).toString("base64url");
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const char = (code: number): string => String.fromCharCode(code);

/** In-memory server with the real fork choice, nonce store and session check, holding several accounts keyed by accountId (and unique handle). */
class FakeServer {
  ledgers = new Map<string, Ledger>();
  stickies = new Map<string, { deviceIds: string[]; bridgeIds: string[] }>();
  registrationOpen = true;
  /** A malicious server that serves its first ledger for any handle. */
  anyHandle = false;
  nonces = new Set<string>();
  mailbox = new Map<string, string>();
  sessions: string[] = [];
  proofs: string[] = [];
  requests: string[] = [];
  /** Bodies of POST /api/account/ledger. */
  posts: { ledger: unknown }[] = [];
  /** When set, the next POST that would create an account is answered with this (status, body) instead of being offered. */
  creationRefusal: { status: number; body: unknown } | null = null;

  /** The only account (or the first one created): the single-account tests' view of the server. */
  get ledger(): Ledger | null {
    return this.ledgers.values().next().value ?? null;
  }
  ledgerOf(accountId: string): Ledger | null {
    return this.ledgers.get(accountId) ?? null;
  }
  private byHandle(handle: string): Ledger | null {
    return [...this.ledgers.values()].find(item => item.genesis.payload.handle === handle) ?? null;
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    expect(url.origin).toBe(ORIGIN);
    const method = init?.method ?? "GET";
    this.requests.push(`${method} ${url.pathname}`);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (method === "POST" && url.pathname === "/api/auth/nonce") {
      expect(body).toEqual({ purpose: "session" });
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
      this.nonces.add(nonce);
      return json({ nonce, expiresAt: Date.now() + 60_000 });
    }
    if (url.pathname === "/api/account/ledger" && method === "GET") {
      const accountId = url.searchParams.get("accountId");
      const handle = url.searchParams.get("handle");
      const found = accountId !== null ? this.ledgerOf(accountId) : handle !== null ? (this.anyHandle ? this.ledger : this.byHandle(handle)) : null;
      return found !== null ? json({ ledger: found }) : json({ error: "not_found" }, 404);
    }
    if (url.pathname === "/api/account/ledger" && method === "POST") {
      const post = body as { ledger: unknown };
      this.posts.push(post);
      return this.offer(post.ledger);
    }
    const pair = /^\/api\/pair\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (pair && method === "PUT") {
      if (!this.sessions.length) return json({ error: "unauthorized" }, 401);
      this.mailbox.set(pair[1], (body as { sealed: string }).sealed);
      return new Response(null, { status: 204 });
    }
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;

  offer = async (candidate: unknown): Promise<Response> => {
    const accountId = await accountIdOf((candidate as Ledger).genesis.payload);
    const stored = this.ledgers.get(accountId) ?? null;
    if (stored === null) {
      if (this.creationRefusal !== null) return json(this.creationRefusal.body, this.creationRefusal.status);
      if (!this.registrationOpen) return json({ error: "registration_closed" }, 403);
      try {
        if (!(await verifyLedger(candidate as Ledger)).devices.length) return json({ error: "invalid_ledger" }, 400);
      } catch {
        return json({ error: "invalid_ledger" }, 400);
      }
      if (this.byHandle((candidate as Ledger).genesis.payload.handle) !== null) return json({ error: "handle_taken" }, 409);
      this.ledgers.set(accountId, wire(candidate as Ledger));
      return json({ decision: "created", ledger: this.ledgers.get(accountId), discarded: 0 }, 201);
    }
    const choice = await chooseLedger(stored, candidate as Ledger);
    if (choice.decision === "reject") return json({ error: "ledger_rejected", ledger: stored }, 409);
    const revoked = ledgerRevocations(candidate as Ledger);
    const before = this.stickies.get(accountId) ?? { deviceIds: [], bridgeIds: [] };
    this.stickies.set(accountId, {
      deviceIds: [...new Set([...before.deviceIds, ...revoked.deviceIds])], bridgeIds: [...new Set([...before.bridgeIds, ...revoked.bridgeIds])],
    });
    if (choice.decision === "adopt") this.ledgers.set(accountId, wire(candidate as Ledger));
    return json({ decision: choice.decision, ledger: this.ledgers.get(accountId), discarded: choice.discarded.length });
  };

  signIn = async (proofJson: string): Promise<boolean> => {
    this.proofs.push(proofJson);
    const proof = parseAuthProof(JSON.parse(proofJson));
    if (proof === null || !this.nonces.delete(proof.nonce)) return false;
    const stored = this.ledgers.get(proof.accountId);
    if (stored === undefined) return false;
    const trusted = applyRevocations(await verifyLedger(stored), this.stickies.get(proof.accountId) ?? { deviceIds: [], bridgeIds: [] });
    if (!await verifyAuthProof(trusted, proof, { audience: ORIGIN, purpose: "session" })) return false;
    this.sessions.push(proof.accountId);
    return true;
  };
}

interface CreateInput { rpId: string; rpName: string; handle: Uint8Array; userName: string; excludeCredentialIds?: string[] }
interface SignOptions { rpId: string; credentialId?: string; allowCredentialIds?: string[] }
interface IdentifyOptions { rpId: string; allowCredentialIds?: string[] }
interface ConsentInput { accountId: string; authority: { credentialId: string; publicKey: string }; rpId: string }
type Call = { name: "create"; options: CreateInput } | { name: "sign"; options: SignOptions } | { name: "identify"; options: IdentifyOptions }
  | { name: "consent"; options: ConsentInput };

/** The owner's passkeys behind the `passkey` dep, signing with the real soft authenticator. */
class FakeAuthenticator {
  keys: { soft: SoftPasskey; handle: string }[] = [];
  /** Index of the passkey the user picks in an identification prompt. */
  pick = 0;
  ignoreAllowList = false;
  /** Models a keychain that already holds the excluded credentials (InvalidStateError in a real browser). */
  sameKeychain = false;
  calls: Call[] = [];
  /** Runs while a ledger signature prompt is open (before it returns). */
  beforeSign: (() => Promise<void>) | null = null;
  readonly module: typeof PasskeyModule = {
    passkeySupported: () => true,
    createPasskey: async (input: CreateInput) => {
      this.calls.push({ name: "create", options: input });
      if (this.sameKeychain && (input.excludeCredentialIds ?? []).some(id => this.keys.some(key => key.soft.credentialId === id))) {
        throw new Error("passkey_already_registered");
      }
      const soft = await createSoftPasskey({ rpId: input.rpId, origin: ORIGIN });
      this.keys.push({ soft, handle: b64url(input.handle) });
      return { credentialId: soft.credentialId, publicKey: soft.publicKey };
    },
    signLedgerRecord: async <T extends LedgerGenesis | LedgerTransition>(payload: T, options: SignOptions): Promise<Signed<T>> => {
      this.calls.push({ name: "sign", options });
      if (this.beforeSign !== null) await this.beforeSign();
      const expected = payload.type === "ftown_account_genesis" ? payload.authority.credentialId : payload.credentialId;
      if (options.credentialId !== undefined && options.credentialId !== expected) throw new Error("passkey_wrong_credential");
      return { payload, signature: await this.key(expected).sign(await ledgerChallenge(payload), { rpId: options.rpId }) };
    },
    identifyPasskey: async (options: IdentifyOptions) => {
      this.calls.push({ name: "identify", options });
      const key = this.keys[this.pick];
      const allowed = this.ignoreAllowList || options.allowCredentialIds === undefined || options.allowCredentialIds.indexOf(key?.soft.credentialId ?? "") !== -1;
      if (key === undefined || !allowed) throw new Error("passkey_cancelled");
      return { credentialId: key.soft.credentialId, handle: key.handle };
    },
    signAuthorityConsent: async (input: ConsentInput): Promise<PasskeySignature> => {
      this.calls.push({ name: "consent", options: input });
      return this.key(input.authority.credentialId).sign(await authorityConsentChallenge(input.accountId, input.authority), { rpId: input.rpId });
    },
  };
  key(credentialId: string): SoftPasskey {
    const found = this.keys.filter(item => item.soft.credentialId === credentialId)[0];
    if (found === undefined) throw new Error("passkey_cancelled");
    return found.soft;
  }
  names(): string[] {
    return this.calls.map(call => call.name);
  }
}

interface Browser {
  client: LedgerClient;
  replica: LedgerReplica;
  storage: LedgerReplicaStorage;
  key: () => { publicKey: string; privateKey: CryptoKey };
  endpoint: (accountId: string) => Promise<EndpointIdentity>;
  resets: string[];
}
async function browser(
  server: FakeServer, authenticator: FakeAuthenticator,
  options: { storage?: LedgerReplicaStorage; attemptStorage?: AttemptStorage; deps?: Partial<LedgerClientDeps> } = {},
): Promise<Browser> {
  const storage = options.storage ?? memoryReplicaStorage();
  let key = await generateAuthKey(false);
  const endpoints = new Map<string, Promise<EndpointIdentity>>();
  const endpoint = (accountId: string): Promise<EndpointIdentity> => {
    const found = endpoints.get(accountId) ?? generateEndpoint(accountId, "browser", false);
    endpoints.set(accountId, found);
    return found;
  };
  const resets: string[] = [];
  const replica = new LedgerReplica(storage);
  const client = new LedgerClient({
    origin: ORIGIN, pageOrigin: ORIGIN, publicOrigin: `${ORIGIN}/`, rpId: RP_ID, fetchImpl: server.fetch, replica, passkey: authenticator.module,
    deviceKey: async () => key, endpoint, signIn: proof => server.signIn(proof), attemptStorage: options.attemptStorage,
    resetDeviceIdentity: async accountId => { resets.push(accountId); endpoints.delete(accountId); key = await generateAuthKey(false); },
    ...options.deps,
  });
  return { client, replica, storage, key: () => key, endpoint, resets };
}
async function owner(): Promise<{ server: FakeServer; authenticator: FakeAuthenticator; a: Browser; accountId: string }> {
  const server = new FakeServer();
  const authenticator = new FakeAuthenticator();
  const a = await browser(server, authenticator);
  await a.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: "owner" });
  const checkpoint = a.client.snapshot().checkpoint;
  if (checkpoint === null) throw new Error("no account");
  return { server, authenticator, a, accountId: checkpoint.accountId };
}
/** A record signed directly with the owner's first passkey (another device of the owner, offline). */
async function signed(ledger: Ledger, authenticator: FakeAuthenticator, operation: LedgerOperation): Promise<Ledger> {
  const key = authenticator.keys[0].soft;
  const payload = nextTransition(await verifyLedger(ledger), key.credentialId, operation, Date.now(), ledgerLastIssuedAt(ledger));
  return { genesis: ledger.genesis, transitions: [...ledger.transitions, { payload, signature: await key.sign(await ledgerChallenge(payload)) }] };
}
async function testDevice(accountId: string): Promise<LedgerDevice> {
  const endpoint = await generateEndpoint(accountId, "browser", false);
  return { endpoint: endpoint.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label: "Other", approvedAt: Date.now() - 1000 };
}
async function testBridge(accountId: string, bridgeId: string): Promise<LedgerBridge> {
  const endpoint = await generateEndpoint(accountId, "bridge", false);
  return { bridgeId, endpoint: endpoint.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label: "Bridge", approvedAt: Date.now() - 1000 };
}
const addDevices = async (ledger: Ledger, authenticator: FakeAuthenticator, accountId: string, count: number): Promise<Ledger> => {
  let result = ledger;
  for (let index = 0; index < count; index += 1) result = await signed(result, authenticator, { type: "add_device", device: await testDevice(accountId) });
  return result;
};
function current(server: FakeServer): Ledger {
  if (server.ledger === null) throw new Error("no ledger");
  return server.ledger;
}
/** Makes `ids` sticky-revoked in `a`'s replica via a losing branch that revokes them, while the winning chain keeps them. */
async function stickyRevoke(server: FakeServer, authenticator: FakeAuthenticator, a: Browser, accountId: string, operations: LedgerOperation[]): Promise<void> {
  const base = current(server);
  let losing = base;
  for (const operation of operations) losing = await signed(losing, authenticator, operation);
  const winning = await addDevices(base, authenticator, accountId, operations.length + 1);
  await server.offer(winning);
  await a.client.refresh({ force: true });
  await a.client.offer({ type: "ledger", ledger: losing });
  expect(a.replica.raw()?.checkpoint.head).toBe((await verifyLedger(winning)).head);
}
function memoryAttempts(): AttemptStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
async function pairing(bridgeId = "studio", now?: number): Promise<{ identity: EndpointIdentity; link: ReturnType<typeof createBridgePairRequest>; fragment: string; code: string }> {
  const identity = await generateEndpoint(b64url(crypto.getRandomValues(new Uint8Array(32))), "bridge", false);
  const auth = await generateAuthKey(true);
  const link = createBridgePairRequest({ bridgeId, endpointPublicKey: identity.endpoint.publicKey, authPublicKey: auth.publicKey, label: "Studio", now });
  return { identity, link, fragment: PAIR_FRAGMENT_PREFIX + encodePairLink(link), code: await pairComparisonCode(link.request) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LedgerClient account creation", () => {
  it("runs one ceremony per step and stores a chain that verifies, then signs in", async () => {
    const server = new FakeServer();
    const authenticator = new FakeAuthenticator();
    const a = await browser(server, authenticator);
    await a.client.createAccountStart({ passkeyLabel: `Mac${char(0x200d)}Book`, userName: "owner" });
    expect(a.client.snapshot().pending).toBe("passkey_created");
    await a.client.createAccountFinish();
    expect(a.client.snapshot().pending).toBe("enrollment_ready");
    expect(server.requests).toEqual([]);
    await a.client.enrollThisDevice({ deviceLabel: `${char(0x202e)}Laptop ` });

    const ledger = current(server);
    const checkpoint = await verifyLedger(ledger);
    const genesis = ledger.genesis.payload;
    const passkey = authenticator.keys[0];
    expect(genesis.rpId).toBe(RP_ID);
    expect(genesis.origins).toEqual([ORIGIN]);
    expect(genesis.handle).toBe(passkey.handle);
    expect(Buffer.from(genesis.handle, "base64url")).toHaveLength(32);
    expect(genesis.authority).toEqual({ credentialId: passkey.soft.credentialId, publicKey: passkey.soft.publicKey, label: "MacBook", addedAt: genesis.createdAt });
    const record = ledger.transitions[0].payload;
    const identity = await a.endpoint(checkpoint.accountId);
    expect(record.operation).toEqual({
      type: "add_device", device: { endpoint: identity.endpoint, authPublicKey: a.key().publicKey, label: "Laptop", approvedAt: record.issuedAt },
    });
    expect(server.sessions).toEqual([checkpoint.accountId]);
    expect(a.client.snapshot()).toMatchObject({ status: "ready", pending: "none", discarded: [] });
    expect(a.client.snapshot().checkpoint?.head).toBe(checkpoint.head);
    expect(authenticator.names()).toEqual(["create", "sign", "sign"]);
    expect(authenticator.calls.every(call => call.options.rpId === RP_ID)).toBe(true);
    const create = authenticator.calls[0];
    expect(create.name === "create" && create.options.excludeCredentialIds).toBeUndefined();
    // A bound browser never starts a second account.
    await expect(a.client.createAccountStart({ passkeyLabel: "x", userName: "y" })).rejects.toThrow("ledger_other_account");
  });

  it("refuses to create an account unless the page and the server's public origin equal the origin", async () => {
    const server = new FakeServer();
    const authenticator = new FakeAuthenticator();
    const page = await browser(server, authenticator, { deps: { pageOrigin: "https://evil.example" } });
    await expect(page.client.createAccountStart({ passkeyLabel: "x", userName: "y" })).rejects.toThrow("origin_mismatch");
    const configured = await browser(server, authenticator, { deps: { publicOrigin: "https://other.example" } });
    await expect(configured.client.createAccount({ passkeyLabel: "x", deviceLabel: "y", userName: "z" })).rejects.toThrow("origin_mismatch");
    expect(authenticator.calls).toEqual([]);
    expect(server.ledger).toBeNull();
  });

  it("keeps the account name out of the POST body, the stored ledger, the persisted state and the client", async () => {
    const name = "Quokka-Owner-7f3a9c";
    const server = new FakeServer();
    const authenticator = new FakeAuthenticator();
    const attempts = memoryAttempts();
    const setItem = vi.spyOn(attempts, "setItem");
    const a = await browser(server, authenticator, { attemptStorage: attempts });
    await a.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: name });
    const accountId = a.client.snapshot().checkpoint?.accountId ?? "";
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") });
    expect(server.posts).toHaveLength(2);
    // The name only reaches the passkey ceremony (the OS picker).
    const create = authenticator.calls[0];
    expect(create.name === "create" && create.options.userName).toBe(name);
    expect(JSON.stringify(server.posts)).not.toContain(name);
    expect(JSON.stringify(current(server))).not.toContain(name);
    expect(JSON.stringify(server.requests)).not.toContain(name);
    const persisted = JSON.stringify([await a.storage.bound(), await a.storage.read(accountId), a.client.snapshot()]);
    expect(persisted).not.toContain(name);
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify(a.client)).not.toContain(name);
    // No setup secret anywhere on the wire.
    expect(server.posts.every(post => !("bootstrap" in post))).toBe(true);
  });

  it.each([
    ["registration_closed", 403], ["creation_too_large", 413], ["invalid_ledger", 400], ["origin_mismatch", 400],
    ["server_full", 503], ["handle_taken", 409], ["rate_limited", 429],
  ] as const)("maps the server reason %s of a creation to the client code of the same name and keeps the pending creation", async (reason, status) => {
    const server = new FakeServer();
    server.creationRefusal = { status, body: { error: reason } };
    const authenticator = new FakeAuthenticator();
    const a = await browser(server, authenticator);
    await a.client.createAccountStart({ passkeyLabel: "Mac", userName: "owner" });
    await a.client.createAccountFinish();
    await expect(a.client.enrollThisDevice({ deviceLabel: "Laptop" })).rejects.toThrow(reason);
    expect(a.replica.raw()).toBeNull();
    expect(a.client.snapshot()).toMatchObject({ status: "signed_out", pending: "enrollment_ready" });
    // The same signed chain is re-sent without another passkey or signature, and the passkey is not minted again.
    await expect(a.client.retryCreateAccount()).rejects.toThrow(reason);
    expect(server.posts).toHaveLength(2);
    expect(JSON.stringify(server.posts[1].ledger)).toBe(JSON.stringify(server.posts[0].ledger));
    expect(authenticator.names()).toEqual(["create", "sign", "sign"]);
    await expect(a.client.createAccountStart({ passkeyLabel: "Mac", userName: "owner" })).rejects.toThrow("account_creation_pending");
    // Once the refusal goes away the same pending creation succeeds.
    server.creationRefusal = null;
    await a.client.retryCreateAccount();
    expect(a.client.snapshot()).toMatchObject({ status: "ready", pending: "none" });
    expect(authenticator.names()).toEqual(["create", "sign", "sign"]);
  });

  it("reads the reason from the body, not the status alone, and keeps generic handling for unknown codes", async () => {
    const server = new FakeServer();
    const authenticator = new FakeAuthenticator();
    const a = await browser(server, authenticator);
    await a.client.createAccountStart({ passkeyLabel: "Mac", userName: "owner" });
    await a.client.createAccountFinish();
    server.creationRefusal = { status: 403, body: { error: "something_new" } };
    await expect(a.client.enrollThisDevice({ deviceLabel: "Laptop" })).rejects.toThrow("ledger_rejected");
    server.creationRefusal = { status: 400, body: { error: "something_new" } };
    await expect(a.client.retryCreateAccount()).rejects.toThrow("ledger_rejected");
    server.creationRefusal = { status: 429, body: {} };
    await expect(a.client.retryCreateAccount()).rejects.toThrow("server_unavailable");
    server.creationRefusal = { status: 413, body: {} };
    await expect(a.client.retryCreateAccount()).rejects.toThrow("ledger_limit");
    server.creationRefusal = { status: 409, body: { error: "handle_taken" } };
    await expect(a.client.retryCreateAccount()).rejects.toThrow("handle_taken");
  });

  it("lets two browsers create two different accounts on one server, each bound to its own", async () => {
    const server = new FakeServer();
    const authA = new FakeAuthenticator();
    const authB = new FakeAuthenticator();
    const a = await browser(server, authA);
    const b = await browser(server, authB);
    await a.client.createAccount({ passkeyLabel: "A passkey", deviceLabel: "A laptop", userName: "alice" });
    await b.client.createAccount({ passkeyLabel: "B passkey", deviceLabel: "B laptop", userName: "bob" });
    const idA = a.client.snapshot().checkpoint?.accountId ?? "";
    const idB = b.client.snapshot().checkpoint?.accountId ?? "";
    expect(idA).not.toBe("");
    expect(idB).not.toBe(idA);
    expect([...server.ledgers.keys()].sort()).toEqual([idA, idB].sort());
    expect(server.sessions.sort()).toEqual([idA, idB].sort());
    // Each replica holds only its own chain.
    expect(a.replica.raw()?.checkpoint.accountId).toBe(idA);
    expect(b.replica.raw()?.checkpoint.accountId).toBe(idB);
    // Neither stays bound to, or trusts, the other's account: a read of the other's account never rebinds a bound browser.
    await expect(a.client.createAccountStart({ passkeyLabel: "x", userName: "y" })).rejects.toThrow("ledger_other_account");
    await a.client.refresh();
    expect(a.replica.raw()?.checkpoint.accountId).toBe(idA);
    // identifyAccount accepts only a ledger of the picked passkey's own handle: a server answering B's ledger for A's handle is refused.
    const fresh = await browser(server, authA);
    authA.pick = 0;
    const other = server.ledgerOf(idB);
    expect(other).not.toBeNull();
    const liar = new FakeServer();
    liar.ledgers.set(idB, other as Ledger);
    liar.anyHandle = true;
    const victim = await browser(liar, authA);
    await expect(victim.client.identifyAccount()).rejects.toThrow("ledger_other_account");
    expect(victim.replica.raw()).toBeNull();
    // With an honest server a fresh browser identifies A's passkey as account A, not B.
    await fresh.client.identifyAccount();
    expect(fresh.client.snapshot().pending).toBe("enrollment_ready");
    expect(fresh.replica.raw()).toBeNull();
    await fresh.client.enrollThisDevice({ deviceLabel: "A phone" });
    expect(fresh.replica.raw()?.checkpoint.accountId).toBe(idA);
    expect(server.ledgerOf(idB)?.transitions).toHaveLength(1);
    // The credential check is separate from the handle check: A's handle with a passkey that is not an authority of A is refused.
    await authA.module.createPasskey({ rpId: RP_ID, rpName: "FTown", handle: Buffer.from(server.ledgerOf(idA)?.genesis.payload.handle ?? "", "base64url"), userName: "alice" });
    authA.pick = authA.keys.length - 1;
    const stranger = await browser(server, authA);
    await expect(stranger.client.identifyAccount()).rejects.toThrow("passkey_not_authority");
    expect(stranger.replica.raw()).toBeNull();
  });

  it("rejects an account name that is empty or too long once sanitized, before any passkey prompt", async () => {
    const authenticator = new FakeAuthenticator();
    const a = await browser(new FakeServer(), authenticator);
    for (const name of ["", "   ", `${char(0x200b)}${char(0x200d)}`, "\u{1F600}".repeat(65)]) {
      await expect(a.client.createAccountStart({ passkeyLabel: "Mac", userName: name })).rejects.toThrow("invalid_account_name");
    }
    expect(authenticator.calls).toEqual([]);
    await a.client.createAccountStart({ passkeyLabel: "Mac", userName: `${char(0x200b)}${"\u{1F600}".repeat(64)}` });
    const create = authenticator.calls[0];
    expect(create.name === "create" && create.options.userName).toBe("\u{1F600}".repeat(64));
  });

  it("retries a refused creation with the same signed chain, without another passkey", async () => {
    const server = new FakeServer();
    server.registrationOpen = false;
    const authenticator = new FakeAuthenticator();
    const a = await browser(server, authenticator);
    await expect(a.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: "owner" })).rejects.toThrow("registration_closed");
    expect(a.client.snapshot().pending).toBe("enrollment_ready");
    await expect(a.client.createAccountStart({ passkeyLabel: "Mac", userName: "owner" })).rejects.toThrow("account_creation_pending");
    server.registrationOpen = true;
    await a.client.retryCreateAccount();
    expect(authenticator.names()).toEqual(["create", "sign", "sign"]);
    expect(server.posts).toHaveLength(2);
    expect(JSON.stringify(server.posts[0].ledger)).toBe(JSON.stringify(server.posts[1].ledger));
    expect(await verifyLedger(current(server))).toMatchObject({ revision: 1 });
    expect(a.client.snapshot()).toMatchObject({ status: "ready", pending: "none" });
    expect(server.sessions).toHaveLength(1);
    await expect(a.client.retryCreateAccount()).rejects.toThrow("account_creation_not_started");
  });

  it("forget() drops a pending creation", async () => {
    const server = new FakeServer();
    server.registrationOpen = false;
    const a = await browser(server, new FakeAuthenticator());
    await expect(a.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: "owner" })).rejects.toThrow("registration_closed");
    await a.client.forget();
    expect(a.client.snapshot().pending).toBe("none");
    await expect(a.client.retryCreateAccount()).rejects.toThrow("account_creation_not_started");
  });

  it("keeps the pending creation when the creating POST fails on the network", async () => {
    const server = new FakeServer();
    const authenticator = new FakeAuthenticator();
    let offline = true;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline) throw new TypeError("offline");
      return server.fetch(input, init);
    }) as typeof fetch;
    const a = await browser(server, authenticator, { deps: { fetchImpl } });
    await expect(a.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: "owner"}))
      .rejects.toThrow("network_unavailable");
    offline = false;
    await a.client.retryCreateAccount();
    expect(authenticator.names()).toEqual(["create", "sign", "sign"]);
    expect(a.client.snapshot().status).toBe("ready");
  });

  it("refuses to create an account while the public origin is unconfigured", async () => {
    const server = new FakeServer();
    const authenticator = new FakeAuthenticator();
    const a = await browser(server, authenticator, { deps: { publicOrigin: "" } });
    await expect(a.client.createAccountStart({ passkeyLabel: "Mac", userName: "owner" })).rejects.toThrow("origin_mismatch");
    expect(authenticator.calls).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("leaves the browser signed out when the server refuses registration", async () => {
    const server = new FakeServer();
    server.registrationOpen = false;
    const a = await browser(server, new FakeAuthenticator());
    await expect(a.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: "owner" })).rejects.toThrow("registration_closed");
    expect(a.replica.raw()).toBeNull();
    expect(a.client.snapshot().status).toBe("signed_out");
    expect(server.sessions).toEqual([]);
  });

  it("refuses an endpoint that is not this account's browser endpoint", async () => {
    for (const make of [
      () => generateEndpoint(b64url(crypto.getRandomValues(new Uint8Array(32))), "browser", false),
      (accountId: string) => generateEndpoint(accountId, "local-cli", false),
    ]) {
      const server = new FakeServer();
      const authenticator = new FakeAuthenticator();
      const a = await browser(server, authenticator, { deps: { endpoint: make } });
      await expect(a.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: "owner" })).rejects.toThrow("endpoint_invalid");
      expect(authenticator.names()).toEqual(["create", "sign"]);
      expect(server.ledger).toBeNull();
    }
  });

  it("never binds to the chain a server answers with (only to its own)", async () => {
    const otherServer = new FakeServer();
    const other = await browser(otherServer, new FakeAuthenticator());
    await other.client.createAccount({ passkeyLabel: "O", deviceLabel: "O", userName: "o" });
    const foreign = current(otherServer);
    const server = new FakeServer();
    server.offer = async () => json({ decision: "created", ledger: foreign, discarded: 0 }, 201);
    const v = await browser(server, new FakeAuthenticator());
    await expect(v.client.createAccount({ passkeyLabel: "V", deviceLabel: "V", userName: "v" })).rejects.toThrow("ledger_not_stored");
    const bound = v.replica.raw()?.checkpoint.accountId;
    expect(bound).not.toBe(await accountIdOf(foreign.genesis.payload));
    expect(bound).toBe(v.client.snapshot().checkpoint?.accountId);
    expect(server.sessions).toEqual([]);
  });
});

describe("LedgerClient sign-in", () => {
  it("adds a new browser with an identification and one add_device signature", async () => {
    const { server, authenticator, accountId } = await owner();
    const credentialId = authenticator.keys[0].soft.credentialId;
    const b = await browser(server, authenticator);
    authenticator.calls = [];
    expect(await b.client.identifyAccount()).toEqual({ enrolled: false });
    expect(b.client.snapshot().pending).toBe("enrollment_ready");
    expect(b.replica.raw()).toBeNull();
    await b.client.enrollThisDevice({ deviceLabel: "Phone" });
    const checkpoint = await verifyLedger(current(server));
    expect(checkpoint.devices.map(item => item.label)).toEqual(["Laptop", "Phone"]);
    expect(checkpoint.devices[1].endpoint.id).toBe((await b.endpoint(accountId)).endpoint.id);
    expect(server.sessions).toEqual([accountId, accountId]);
    expect(authenticator.names()).toEqual(["identify", "sign"]);
    expect(authenticator.calls[0].options).toEqual({ rpId: RP_ID, allowCredentialIds: undefined });
    expect(authenticator.calls[1].options).toEqual({ rpId: RP_ID, credentialId });
    expect(b.client.snapshot()).toMatchObject({ status: "ready", pending: "none" });

    // Identifying again on an enrolled browser signs in without another record; the prompt is limited to the account's passkeys.
    authenticator.calls = [];
    expect(await b.client.identifyAccount()).toEqual({ enrolled: true });
    expect(authenticator.calls[0].options).toEqual({ rpId: RP_ID, allowCredentialIds: [credentialId] });
    expect(current(server).transitions).toHaveLength(2);

    const c = await browser(server, authenticator);
    await c.client.signInNewDevice({ deviceLabel: "Tablet" });
    expect((await verifyLedger(current(server))).devices).toHaveLength(3);
  });

  it("re-bases the add_device on the newest head when the account grew between the two gestures", async () => {
    const { server, authenticator, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.identifyAccount();
    await server.offer(await addDevices(current(server), authenticator, accountId, 1));
    await b.client.enrollThisDevice({ deviceLabel: "Phone" });
    const ledger = current(server);
    expect(ledger.transitions).toHaveLength(3);
    expect(ledger.transitions[2].payload.operation.type).toBe("add_device");
    expect(b.replica.raw()?.checkpoint.head).toBe((await verifyLedger(ledger)).head);
  });

  it("signs a known device in with a device-key proof for this origin and a server nonce", async () => {
    const { server, authenticator, a, accountId } = await owner();
    server.proofs = [];
    authenticator.calls = [];
    expect(await a.client.signInKnownDevice()).toBe(true);
    expect(authenticator.calls).toEqual([]);
    const proof = parseAuthProof(JSON.parse(server.proofs[0]));
    if (proof === null) throw new Error("bad proof");
    expect(proof).toMatchObject({ accountId, kind: "device", keyId: (await a.endpoint(accountId)).endpoint.id, purpose: "session", audience: ORIGIN });
    expect(server.nonces.size).toBe(0);
    const trusted = applyRevocations(await verifyLedger(current(server)), { deviceIds: [], bridgeIds: [] });
    expect(await verifyAuthProof(trusted, proof, { audience: ORIGIN, purpose: "session" })).toBe(true);

    const fresh = await browser(server, authenticator);
    expect(await fresh.client.signInKnownDevice()).toBe(false);
  });

  it("refuses a passkey or a server ledger of another account", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const otherServer = new FakeServer();
    const other = await browser(otherServer, authenticator);
    await other.client.createAccount({ passkeyLabel: "Other", deviceLabel: "Other", userName: "other" });
    const foreign = current(otherServer);
    const head = a.replica.raw()?.checkpoint.head;

    await a.client.offer(foreign);
    await a.client.offer({ type: "ledger", ledger: foreign });
    expect(a.replica.raw()?.checkpoint.head).toBe(head);
    expect(await a.replica.offer(foreign)).toEqual({ decision: "reject", discarded: [] });

    authenticator.pick = 1;
    authenticator.ignoreAllowList = true;
    await expect(a.client.signInNewDevice({ deviceLabel: "x" })).rejects.toThrow("ledger_other_account");
    expect(a.client.snapshot().checkpoint?.accountId).toBe(accountId);

    // An unbound browser: a server answering the handle with a ledger of another handle is refused before any signature.
    server.anyHandle = true;
    const fresh = await browser(server, authenticator);
    authenticator.calls = [];
    await expect(fresh.client.signInNewDevice({ deviceLabel: "x" })).rejects.toThrow("ledger_other_account");
    expect(authenticator.names()).toEqual(["identify"]);
    expect(fresh.replica.raw()).toBeNull();
  });

  it("refuses a passkey of the account's handle that is not one of its authorities", async () => {
    const { server, authenticator } = await owner();
    await authenticator.module.createPasskey({
      rpId: RP_ID, rpName: "FTown", handle: Buffer.from(current(server).genesis.payload.handle, "base64url"), userName: "owner",
    });
    authenticator.pick = 1;
    const b = await browser(server, authenticator);
    authenticator.calls = [];
    await expect(b.client.identifyAccount()).rejects.toThrow("passkey_not_authority");
    expect(b.client.snapshot().pending).toBe("none");
    await expect(b.client.signInNewDevice({ deviceLabel: "Phone" })).rejects.toThrow("passkey_not_authority");
    expect(authenticator.names()).toEqual(["identify", "identify"]);
    expect(b.replica.raw()).toBeNull();
    expect(current(server).transitions).toHaveLength(1);
  });

  it("refuses an attacker account that lists the victim's passkey as an authority without its consent", async () => {
    const { server, authenticator, accountId } = await owner();
    const victim = current(server).genesis.payload;
    const attacker = await createSoftPasskey({ rpId: RP_ID, origin: ORIGIN });
    const at = Date.now() - 5000;
    const genesis: LedgerGenesis = {
      type: "ftown_account_genesis", version: 2, rpId: RP_ID, origins: [ORIGIN], handle: victim.handle, createdAt: at,
      authority: { credentialId: attacker.credentialId, publicKey: attacker.publicKey, label: "Mac", addedAt: at },
    };
    const root = { payload: genesis, signature: await attacker.sign(await ledgerChallenge(genesis)) };
    const evilId = await accountIdOf(genesis);
    expect(evilId).not.toBe(accountId);
    const stolen = { credentialId: victim.authority.credentialId, publicKey: victim.authority.publicKey };
    // Neither the attacker's own assertion nor a replayed victim assertion is the victim's consent to this account.
    for (const consent of [await attacker.sign(await authorityConsentChallenge(evilId, stolen)), current(server).genesis.signature]) {
      const payload = nextTransition(await verifyLedger({ genesis: root, transitions: [] }), attacker.credentialId,
        { type: "add_authority", authority: { ...stolen, label: "Mac", addedAt: at + 1 }, consent }, at + 1, at);
      const evil: Ledger = { genesis: root, transitions: [{ payload, signature: await attacker.sign(await ledgerChallenge(payload)) }] };
      await expect(verifyLedger(evil)).rejects.toThrow();
      server.ledgers.clear();
      server.ledgers.set(evilId, evil);
      const b = await browser(server, authenticator);
      authenticator.calls = [];
      await expect(b.client.signInNewDevice({ deviceLabel: "Phone" })).rejects.toThrow("invalid_ledger");
      expect(authenticator.names()).toEqual(["identify"]);
      expect(b.replica.raw()).toBeNull();
      expect(current(server)).toEqual(evil);
      expect(server.mailbox.size).toBe(0);
    }
  });
});

describe("LedgerClient revoked browser", () => {
  it("a revoked device loses its session, shows device_revoked, and re-enrolls only with rotated keys", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    const phone = (await b.endpoint(accountId)).endpoint.id;
    await a.client.revokeDevice(phone);

    expect(await b.client.signInKnownDevice()).toBe(false);
    expect(b.client.snapshot().status).toBe("device_revoked");
    authenticator.calls = [];
    await expect(b.client.signInNewDevice({ deviceLabel: "Phone" })).rejects.toThrow("ledger_device_revoked");
    expect(authenticator.names()).toEqual(["identify"]);

    await b.client.rotateDeviceIdentity();
    expect(b.resets).toEqual([accountId]);
    expect(b.client.snapshot().status).toBe("ready");
    expect(await b.client.identifyAccount()).toEqual({ enrolled: false });
    // Between the two gestures another device grows the account: the add_device is re-based on the newest head.
    await server.offer(await addDevices(current(server), authenticator, accountId, 1));
    const grown = current(server).transitions.length;
    await b.client.enrollThisDevice({ deviceLabel: "Phone" });
    const fresh = (await b.endpoint(accountId)).endpoint.id;
    expect(fresh).not.toBe(phone);
    expect(current(server).transitions).toHaveLength(grown + 1);
    const checkpoint = await verifyLedger(current(server));
    expect(checkpoint.revokedDeviceIds).toEqual([phone]);
    expect(checkpoint.devices.map(item => item.endpoint.id)).toContain(fresh);
    expect(checkpoint.devices.map(item => item.label)).toContain("Other");
    expect(b.client.snapshot().status).toBe("ready");
  });

  it("uses the sticky set for membership: a device revoked on a losing branch neither signs in nor re-enrolls", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const laptop = (await a.endpoint(accountId)).endpoint.id;
    await stickyRevoke(server, authenticator, a, accountId, [{ type: "revoke_device", endpointId: laptop }]);
    expect(a.replica.raw()?.checkpoint.devices.map(item => item.endpoint.id)).toContain(laptop);
    const proofs = server.proofs.length;
    expect(await a.client.signInKnownDevice()).toBe(false);
    expect(server.proofs).toHaveLength(proofs);
    expect(a.client.snapshot().status).toBe("device_revoked");
    authenticator.calls = [];
    await expect(a.client.signInNewDevice({ deviceLabel: "Laptop" })).rejects.toThrow("ledger_device_revoked");
    expect(authenticator.names()).toEqual(["identify"]);
    expect(server.proofs).toHaveLength(proofs);
  });
});

describe("LedgerClient writes", () => {
  it("appends on the refreshed head; revocations and bridges land on the server", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    const phone = (await b.endpoint(accountId)).endpoint.id;
    const laptop = (await a.endpoint(accountId)).endpoint.id;
    expect(a.replica.raw()?.checkpoint.revision).toBe(1);

    await a.client.revokeDevice(phone);
    const checkpoint = await verifyLedger(current(server));
    expect(checkpoint.revision).toBe(3);
    expect(checkpoint.revokedDeviceIds).toEqual([phone]);
    expect(a.client.snapshot().checkpoint?.devices.map(item => item.endpoint.id)).toEqual([laptop]);

    const studio = await testBridge(accountId, "studio");
    await a.client.append({ type: "add_bridge", bridge: studio });
    await a.client.revokeBridge("studio");
    const after = await verifyLedger(current(server));
    expect(after.revision).toBe(5);
    expect(after.revokedBridgeIds).toEqual(["studio"]);
    expect(a.replica.raw()?.checkpoint.head).toBe(after.head);
  });

  it("keeps a revocation the server silently dropped, locally and sticky", async () => {
    const { server, a, accountId } = await owner();
    const studio = await testBridge(accountId, "studio");
    await a.client.append({ type: "add_bridge", bridge: studio });
    server.offer = async () => json({ decision: "keep", ledger: server.ledger, discarded: 0 });
    await expect(a.client.revokeBridge("studio")).rejects.toThrow("ledger_not_stored");
    expect(() => a.client.assertBridgeAccess("studio", studio.endpoint.id)).toThrow("account_bridge_revoked");
    expect(a.replica.raw()?.checkpoint.revokedBridgeIds).toEqual(["studio"]);
    expect(a.client.snapshot().discarded).toEqual([]);
  });

  it("reports ledger_append_lost and lists the record when a longer chain displaced it", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const base = current(server);
    const fork = await addDevices(base, authenticator, accountId, 2);
    const original = server.offer;
    server.offer = async () => {
      await original(fork);
      return json({ decision: "keep", ledger: server.ledger, discarded: 0 });
    };
    await expect(a.client.revokeDevice((await a.endpoint(accountId)).endpoint.id)).rejects.toThrow("ledger_append_lost");
    const discarded = a.client.snapshot().discarded;
    expect(discarded).toHaveLength(1);
    expect(discarded[0].payload.operation.type).toBe("revoke_device");
    expect(a.replica.raw()?.checkpoint.head).toBe((await verifyLedger(fork)).head);
    // The revocation it signed stays sticky even though its record lost.
    expect(a.client.snapshot().status).toBe("device_revoked");
  });

  it("adds an authority in three gestures with the new passkey's consent", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const first = authenticator.keys[0].soft.credentialId;
    authenticator.sameKeychain = true;
    await expect(a.client.addAuthority("YubiKey")).rejects.toThrow("passkey_already_registered");
    expect(a.client.snapshot().pending).toBe("none");
    expect(current(server).transitions).toHaveLength(1);

    authenticator.sameKeychain = false;
    authenticator.calls = [];
    await a.client.addAuthorityStart({ label: "YubiKey" });
    expect(a.client.snapshot().pending).toBe("authority_created");
    await expect(a.client.addAuthorityFinish()).rejects.toThrow("authority_consent_required");
    const create = authenticator.calls[0];
    if (create.name !== "create") throw new Error("expected a create");
    expect(create.options.excludeCredentialIds).toEqual([first]);
    expect(b64url(create.options.handle)).toBe(current(server).genesis.payload.handle);
    await a.client.addAuthorityConsent();
    expect(a.client.snapshot().pending).toBe("authority_consented");
    const second = authenticator.keys[1].soft.credentialId;
    expect(authenticator.calls[1]).toEqual({
      name: "consent", options: { accountId, authority: { credentialId: second, publicKey: authenticator.keys[1].soft.publicKey }, rpId: RP_ID },
    });
    await a.client.addAuthorityFinish();
    expect(a.client.snapshot().pending).toBe("none");
    expect(authenticator.names()).toEqual(["create", "consent", "sign"]);
    const checkpoint = await verifyLedger(current(server));
    expect(checkpoint.authorities.map(item => item.label)).toEqual(["Mac", "YubiKey"]);
    const added = current(server).transitions[1].payload;
    expect(added.credentialId).toBe(first);
    expect(added.operation.type === "add_authority" && added.operation.authority.addedAt).toBe(added.issuedAt);

    // A new page session on the same browser must learn which of the two passkeys it holds, once.
    const again = await browser(server, authenticator, { storage: a.storage });
    authenticator.calls = [];
    await again.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") });
    await again.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b2") });
    expect(authenticator.names()).toEqual(["identify", "sign", "sign"]);
    expect(authenticator.calls[0].options).toEqual({ rpId: RP_ID, allowCredentialIds: [first, second] });

    // A passkey of another account picked in that prompt is refused.
    const otherServer = new FakeServer();
    await (await browser(otherServer, authenticator)).client.createAccount({ passkeyLabel: "O", deviceLabel: "O", userName: "o" });
    const third = await browser(server, authenticator, { storage: a.storage });
    authenticator.pick = 2;
    authenticator.ignoreAllowList = true;
    await expect(third.client.revokeBridge("b1")).rejects.toThrow("ledger_other_account");
  });
});

describe("LedgerClient bridge pairing", () => {
  it("approves with the typed code: the bridge opens the approval and confirms the ledger", async () => {
    const { server, a, accountId } = await owner();
    const { identity, link, fragment, code } = await pairing();
    await a.client.approveBridge(fragment, code);
    const sealed = server.mailbox.get(link.request.requestId);
    if (sealed === undefined) throw new Error("no approval");
    const approval = await openPairApproval(sealed, link, identity);
    expect(approval.accountId).toBe(accountId);
    const checkpoint = await confirmPairedLedger(link, approval, current(server));
    expect(checkpoint.bridges.map(item => item.bridgeId)).toEqual(["studio"]);
    const endpointId = checkpoint.bridges[0].endpoint.id;
    expect(() => a.client.assertBridgeAccess("studio", endpointId)).not.toThrow();
    const wrongEndpoint = (await a.endpoint(accountId)).endpoint.id;
    expect(() => a.client.assertBridgeAccess("studio", wrongEndpoint)).toThrow("account_bridge_revoked");
    expect(() => a.client.assertBridgeAccess("other", endpointId)).toThrow("account_bridge_revoked");

    // A retry of the same link (say the mailbox PUT failed) re-seals without a second add_bridge.
    const length = current(server).transitions.length;
    await a.client.approveBridge(fragment, ` ${code.slice(0, 3)} ${code.slice(3)} `);
    expect(current(server).transitions).toHaveLength(length);
  });

  it("blocks a wrong code before any signature, and refuses the link after five wrong codes, across reloads", async () => {
    const { server, authenticator, a } = await owner();
    const attempts = memoryAttempts();
    const page = await browser(server, authenticator, { storage: a.storage, attemptStorage: attempts });
    const { fragment, code } = await pairing();
    const wrong = String((Number(code) + 1) % 1000000).padStart(6, "0");
    const before = JSON.stringify(current(server));
    authenticator.calls = [];
    await expect(page.client.approveBridge(fragment, wrong)).rejects.toThrow("pair_code_mismatch");
    expect(JSON.stringify(current(server))).toBe(before);
    expect(server.mailbox.size).toBe(0);
    expect(authenticator.calls).toEqual([]);
    for (let attempt = 0; attempt < 4; attempt += 1) await expect(page.client.approveBridge(fragment, "abcdef")).rejects.toThrow("pair_code_mismatch");
    await expect(page.client.approveBridge(fragment, code)).rejects.toThrow("pair_attempts_exceeded");
    // The page reloads: a new client on the same attempt storage still refuses the link.
    const reloaded = await browser(server, authenticator, { storage: a.storage, attemptStorage: attempts });
    await expect(reloaded.client.approveBridge(fragment, code)).rejects.toThrow("pair_attempts_exceeded");
    expect(JSON.stringify(current(server))).toBe(before);
    expect(server.mailbox.size).toBe(0);
  });

  it("refuses an expired link before any signature", async () => {
    const { server, authenticator, a } = await owner();
    const { fragment, code } = await pairing("studio", Date.now() - 700_000);
    authenticator.calls = [];
    await expect(a.client.approveBridge(fragment, code)).rejects.toThrow("pair_link_expired");
    expect(authenticator.calls).toEqual([]);
    expect(current(server).transitions).toHaveLength(1);
  });

  it("refuses to re-pair a bridge id that a seen (sticky) revocation removed", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const old = await testBridge(accountId, "studio");
    await stickyRevoke(server, authenticator, a, accountId, [{ type: "add_bridge", bridge: old }, { type: "revoke_bridge", bridgeId: "studio" }]);
    expect(a.replica.raw()?.checkpoint.bridges).toEqual([]);
    const { fragment, code } = await pairing("studio");
    const length = current(server).transitions.length;
    authenticator.calls = [];
    await expect(a.client.approveBridge(fragment, code)).rejects.toThrow("account_bridge_revoked");
    expect(authenticator.calls).toEqual([]);
    expect(current(server).transitions).toHaveLength(length);
  });
});

describe("LedgerClient replication", () => {
  it("surfaces the local records a longer fork discarded", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const base = current(server);
    await a.client.append({ type: "add_device", device: await testDevice(accountId) });
    const mine = current(server).transitions[1];
    const fork = await addDevices(base, authenticator, accountId, 2);
    expect((await server.offer(fork)).status).toBe(200);
    await a.client.refresh({ force: true });
    expect(a.client.snapshot().discarded).toEqual([mine]);
    expect(a.client.snapshot().checkpoint?.head).toBe((await verifyLedger(fork)).head);
    await a.client.dismissDiscarded();
    expect(a.client.snapshot().discarded).toEqual([]);
  });

  it("keeps a revocation seen on a losing branch: assertBridgeAccess uses the sticky set", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const studio = await testBridge(accountId, "studio");
    await a.client.append({ type: "add_bridge", bridge: studio });
    expect(() => a.client.assertBridgeAccess("studio", studio.endpoint.id)).not.toThrow();
    await stickyRevoke(server, authenticator, a, accountId, [{ type: "revoke_bridge", bridgeId: "studio" }]);
    expect(a.replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(["studio"]);
    expect(() => a.client.assertBridgeAccess("studio", studio.endpoint.id)).toThrow("account_bridge_revoked");
    expect(a.client.snapshot().checkpoint?.bridges).toEqual([]);
  });

  it("forget() keeps the account's sticky revocations for the next sign-in", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const studio = await testBridge(accountId, "studio");
    await a.client.append({ type: "add_bridge", bridge: studio });
    await stickyRevoke(server, authenticator, a, accountId, [{ type: "revoke_bridge", bridgeId: "studio" }]);
    await a.client.forget();
    expect(a.client.snapshot()).toMatchObject({ status: "signed_out", checkpoint: null });
    await a.client.signInNewDevice({ deviceLabel: "Laptop" });
    expect(a.replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(["studio"]);
    expect(() => a.client.assertBridgeAccess("studio", studio.endpoint.id)).toThrow("account_bridge_revoked");
  });

  it("refreshes on a relay head it does not have", async () => {
    const { server, authenticator, a } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    server.requests = [];
    await a.client.offer({ type: "ledger_head", head: a.replica.raw()?.checkpoint.head, revision: 1 });
    expect(server.requests).toEqual([]);
    await a.client.offer({ type: "ledger_head", head: "x".repeat(43), revision: 2 });
    expect(server.requests).toEqual(["GET /api/account/ledger"]);
    expect(a.replica.raw()?.checkpoint.revision).toBe(2);
  });

  it("an unbound client ignores relay pushes without even offering them", async () => {
    const { server, authenticator } = await owner();
    const fresh = await browser(server, authenticator);
    await fresh.client.load();
    const offer = vi.spyOn(fresh.replica, "offer");
    await fresh.client.offer(current(server));
    await fresh.client.offer({ type: "ledger", ledger: current(server) });
    expect(offer).not.toHaveBeenCalled();
    expect(fresh.replica.raw()).toBeNull();
    expect(fresh.client.snapshot().status).toBe("signed_out");
  });

  it("a relay push never re-binds an account another tab forgot", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const grown = await addDevices(current(server), authenticator, accountId, 1);
    const otherTab = new LedgerReplica(a.storage);
    await otherTab.load();
    await otherTab.clear();
    await a.client.offer({ type: "ledger", ledger: grown });
    expect(await a.storage.bound()).toBeNull();
    expect(a.replica.raw()).toBeNull();
  });

  it("notifies subscribers with a new snapshot", async () => {
    const { a, accountId } = await owner();
    const seen: string[] = [];
    const unsubscribe = a.client.subscribe(() => seen.push(a.client.snapshot().status));
    const before = a.client.snapshot();
    await a.client.append({ type: "add_device", device: await testDevice(accountId) });
    expect(seen.length).toBeGreaterThan(0);
    expect(a.client.snapshot()).not.toBe(before);
    unsubscribe();
    const count = seen.length;
    await a.client.forget();
    expect(seen).toHaveLength(count);
    expect(a.client.snapshot()).toMatchObject({ status: "signed_out", checkpoint: null });
  });
});

describe("LedgerClient local-only removals and discarded records", () => {
  it("a removal displaced by a longer chain stays local-only, persists as discarded, and can be signed again", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const studio = await testBridge(accountId, "studio");
    await a.client.append({ type: "add_bridge", bridge: studio });
    const fork = await addDevices(current(server), authenticator, accountId, 2);
    const original = server.offer;
    server.offer = async () => {
      await original(fork);
      return json({ decision: "keep", ledger: server.ledger, discarded: 0 });
    };
    await expect(a.client.revokeBridge("studio")).rejects.toThrow("ledger_append_lost");
    server.offer = original;
    const lost = a.client.snapshot();
    expect(lost.localOnly).toEqual({ deviceIds: [], bridgeIds: ["studio"] });
    expect(lost.discarded.map(item => item.payload.operation)).toEqual([{ type: "revoke_bridge", bridgeId: "studio" }]);
    expect(a.replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(["studio"]);
    expect(() => a.client.assertBridgeAccess("studio", studio.endpoint.id)).toThrow("account_bridge_revoked");

    // Persisted: a reloaded page still shows both.
    const reloaded = await browser(server, authenticator, { storage: a.storage });
    await reloaded.client.load();
    expect(reloaded.client.snapshot().discarded).toEqual(lost.discarded);
    expect(reloaded.client.snapshot().localOnly.bridgeIds).toEqual(["studio"]);

    // The local-only id is still on the RAW chain, so the removal can be signed again; its discarded entry then disappears.
    await a.client.revokeBridge("studio");
    expect(a.client.snapshot().localOnly).toEqual({ deviceIds: [], bridgeIds: [] });
    expect(a.client.snapshot().discarded).toEqual([]);
    expect((await verifyLedger(current(server))).revokedBridgeIds).toEqual(["studio"]);
    await expect(a.client.revokeBridge("studio")).rejects.toThrow("bridge_not_found");
    await expect(a.client.revokeDevice("x".repeat(43))).rejects.toThrow("device_not_found");
  });

  it("an own record that lost to a chain pushed while the prompt was open is kept as discarded", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const other = await testDevice(accountId);
    await a.client.append({ type: "add_device", device: other });
    const fork = await addDevices(current(server), authenticator, accountId, 2);
    const posts = server.posts.length;
    authenticator.beforeSign = async () => {
      authenticator.beforeSign = null;
      await server.offer(fork);
      await a.client.offer({ type: "ledger", ledger: fork });
    };
    await expect(a.client.revokeDevice(other.endpoint.id)).rejects.toThrow("ledger_append_lost");
    expect(server.posts).toHaveLength(posts);
    expect(a.client.snapshot().discarded.map(item => item.payload.operation)).toEqual([{ type: "revoke_device", endpointId: other.endpoint.id }]);
    expect(a.client.snapshot().localOnly.deviceIds).toEqual([other.endpoint.id]);
    await a.client.dismissDiscarded();
    expect(a.client.snapshot().discarded).toEqual([]);
    const reloaded = await browser(server, authenticator, { storage: a.storage });
    await reloaded.client.load();
    expect(reloaded.client.snapshot().discarded).toEqual([]);
  });
});

describe("LedgerClient refresh pacing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function paced(): Promise<{ c: Browser; local: { head: string; revision: number }; gets: () => number }> {
    const { server, authenticator, a } = await owner();
    const c = await browser(server, authenticator, { storage: a.storage, deps: { now: () => Date.now() } });
    await c.client.load();
    const local = c.replica.raw()?.checkpoint;
    if (local === undefined) throw new Error("unbound");
    server.requests = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    return { c, local, gets: () => server.requests.filter(item => item === "GET /api/account/ledger").length };
  }

  it("reads at once when idle, and defers a notice inside the window to one trailing read at the window's end", async () => {
    const { c, local, gets } = await paced();
    await c.client.noteHead("y".repeat(43), local.revision + 1);
    expect(gets()).toBe(1);
    const deferred = c.client.noteHead("z".repeat(43), local.revision + 2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(gets()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await deferred;
    expect(gets()).toBe(2);
    // refresh() is paced the same way: deferred, not dropped.
    const later = c.client.refresh();
    expect(gets()).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await later;
    expect(gets()).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gets()).toBe(3);
  });

  it("a burst of 50 notices costs at most 2 reads, the last one after the burst", async () => {
    const { c, local, gets } = await paced();
    const notices = Array.from({ length: 50 }, (_, index) => c.client.noteHead(`n${index}`.padEnd(43, "x"), local.revision + 1 + index));
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(notices);
    expect(gets()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gets()).toBe(2);
  });

  it("ignores a lower revision and the same head; force skips the spacing but joins a read in flight", async () => {
    const { c, local, gets } = await paced();
    await c.client.noteHead(local.head, local.revision);
    await c.client.noteHead("x".repeat(43), local.revision - 1);
    await c.client.offer({ type: "ledger_head", head: "x".repeat(43), revision: local.revision - 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gets()).toBe(0);
    await c.client.noteHead("y".repeat(43), local.revision);
    expect(gets()).toBe(1);
    await Promise.all([c.client.refresh({ force: true }), c.client.refresh({ force: true })]);
    expect(gets()).toBe(2);
    const pushed = c.client.offer({ type: "ledger_head", head: "y".repeat(43), revision: local.revision + 5 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gets()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await pushed;
    expect(gets()).toBe(3);
  });
});

describe("LedgerClient signer", () => {
  it("is the only authority without a prompt, and otherwise the credential learned from a prompt", async () => {
    const { server, authenticator, a } = await owner();
    const first = authenticator.keys[0].soft.credentialId;
    expect(a.client.snapshot().signer).toBe(first);
    const fresh = await browser(server, authenticator, { storage: a.storage });
    await fresh.client.load();
    expect(fresh.client.snapshot().signer).toBe(first);
    await a.client.addAuthority("YubiKey");
    expect(a.client.snapshot().signer).toBe(first);

    authenticator.calls = [];
    const again = await browser(server, authenticator, { storage: a.storage });
    await again.client.load();
    expect(again.client.snapshot().signer).toBeNull();
    expect(authenticator.calls).toEqual([]);
    authenticator.pick = 1;
    await again.client.selectPasskey();
    expect(again.client.snapshot().signer).toBe(authenticator.keys[1].soft.credentialId);
  });
});

describe("LedgerClient environment", () => {
  it("reports secure_context_required on an insecure origin", async () => {
    const a = await browser(new FakeServer(), new FakeAuthenticator());
    vi.stubGlobal("crypto", undefined);
    await expect(a.client.load()).rejects.toThrow("secure_context_required");
    expect(a.client.snapshot()).toMatchObject({ status: "error", error: "secure_context_required" });
  });

  it("checks the secure context itself, whatever replica it is given", async () => {
    class LooseReplica extends LedgerReplica {
      override load(): Promise<null> { return Promise.resolve(null); }
    }
    const a = await browser(new FakeServer(), new FakeAuthenticator(), { deps: { replica: new LooseReplica(memoryReplicaStorage()) } });
    vi.stubGlobal("crypto", undefined);
    await expect(a.client.load()).rejects.toThrow("secure_context_required");
  });

  it("requires a canonical origin", async () => {
    const server = new FakeServer();
    await expect(browser(server, new FakeAuthenticator(), { deps: { origin: `${ORIGIN}/` } })).rejects.toThrow("invalid_origin");
    await expect(browser(server, new FakeAuthenticator())).resolves.toBeDefined();
  });
});

describe("sanitizeLabel", () => {
  it("strips zero-width, bidi and control characters and lone surrogates, normalizes, trims and caps", () => {
    expect(sanitizeLabel(`  My${char(0x200d)}Mac${char(0x202e)}${char(0xfeff)}${char(0x07)}${char(0x200b)} `)).toBe("MyMac");
    expect(sanitizeLabel(`${char(0x2066)}Studio${char(0x2069)}${char(0x061c)}`)).toBe("Studio");
    expect(sanitizeLabel(`a${char(0xd800)}b${char(0xdc00)}`)).toBe("ab");
    expect(sanitizeLabel(`e${char(0x301)}`)).toBe(char(0xe9));
    const emoji = String.fromCodePoint(0x1f600);
    expect(sanitizeLabel(`${"x".repeat(199)}${emoji}`)).toBe("x".repeat(199));
    expect(sanitizeLabel(`${"x".repeat(198)}${emoji}`)).toBe(`${"x".repeat(198)}${emoji}`);
    expect(sanitizeLabel("y".repeat(300))).toHaveLength(200);
  });
});
