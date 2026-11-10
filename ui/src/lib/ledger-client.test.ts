import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import {
  accountIdOf, applyRevocations, authorityConsentChallenge, chooseLedger, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, ledgerRevocations, nextTransition, verifyLedger,
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
  /** Runs on every POST /api/account/ledger (already counted in `posts`); a Response answers it instead of the store, null lets it through. */
  postHook: ((ledger: Ledger) => Response | null | Promise<Response | null>) | null = null;
  /** Runs after a GET of a ledger was answered (the answer already holds the state before it): a change "right after that read". */
  afterGet: (() => void | Promise<void>) | null = null;

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
      const answer = found !== null ? json({ ledger: found }) : json({ error: "not_found" }, 404);
      if (this.afterGet !== null) await this.afterGet();
      return answer;
    }
    if (url.pathname === "/api/account/ledger" && method === "POST") {
      const post = body as { ledger: unknown; expectHead?: unknown };
      this.posts.push(post);
      const hooked = this.postHook === null ? null : await this.postHook(post.ledger as Ledger);
      return hooked ?? this.offer(post.ledger, typeof post.expectHead === "string" ? post.expectHead : undefined);
    }
    const pair = /^\/api\/pair\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (pair && method === "PUT") {
      if (!this.sessions.length) return json({ error: "unauthorized" }, 401);
      this.mailbox.set(pair[1], (body as { sealed: string }).sealed);
      return new Response(null, { status: 204 });
    }
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;

  /** The route's rules; `expectHead` (a re-offer): never creates (404 account_unknown), 409 head_changed when the stored head moved. */
  offer = async (candidate: unknown, expectHead?: string): Promise<Response> => {
    const accountId = await accountIdOf((candidate as Ledger).genesis.payload);
    const stored = this.ledgers.get(accountId) ?? null;
    if (expectHead !== undefined) {
      if (stored === null) return json({ error: "account_unknown" }, 404);
      const last = stored.transitions[stored.transitions.length - 1];
      if (await ledgerHead(last === undefined ? stored.genesis.payload : last.payload) !== expectHead) return json({ error: "head_changed", ledger: stored }, 409);
    }
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
/** Every client a test made; disposed after each test so no retry timer outlives it. */
const clients: LedgerClient[] = [];
/**
 * `identity`: another page of the same browser profile (its device key and endpoint), with `storage` its replica: a reload.
 * Without it the page gets keys of its own.
 */
async function browser(
  server: FakeServer, authenticator: FakeAuthenticator,
  options: { storage?: LedgerReplicaStorage; attemptStorage?: AttemptStorage; deps?: Partial<LedgerClientDeps>; identity?: Browser } = {},
): Promise<Browser> {
  const storage = options.storage ?? memoryReplicaStorage();
  let key = options.identity?.key() ?? await generateAuthKey(false);
  const endpoints = new Map<string, Promise<EndpointIdentity>>();
  const endpoint = options.identity?.endpoint ?? ((accountId: string): Promise<EndpointIdentity> => {
    const found = endpoints.get(accountId) ?? generateEndpoint(accountId, "browser", false);
    endpoints.set(accountId, found);
    return found;
  });
  const resets: string[] = [];
  // The clock looked up on each call, so a fake clock installed later (fakeTime) applies to verification too.
  const replica = new LedgerReplica(storage, () => Date.now());
  const client = new LedgerClient({
    origin: ORIGIN, pageOrigin: ORIGIN, publicOrigin: `${ORIGIN}/`, rpId: RP_ID, fetchImpl: server.fetch, replica, passkey: authenticator.module,
    deviceKey: async () => key, endpoint, signIn: proof => server.signIn(proof), attemptStorage: options.attemptStorage,
    resetDeviceIdentity: async accountId => { resets.push(accountId); endpoints.delete(accountId); key = await generateAuthKey(false); },
    // Looked up on each call, so a fake clock installed later (fakeTime) applies.
    now: () => Date.now(),
    ...options.deps,
  });
  clients.push(client);
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

/** The server's copy of the account cut back to its first `revision` records (a database restore, or a replayed old row). */
function rollBack(server: FakeServer, accountId: string, revision: number): Ledger {
  const stored = server.ledgerOf(accountId);
  if (stored === null) throw new Error("no ledger");
  const prefix = wire({ genesis: stored.genesis, transitions: stored.transitions.slice(0, revision) });
  server.ledgers.set(accountId, prefix);
  return prefix;
}
const headOf = async (ledger: Ledger): Promise<string> => (await verifyLedger(ledger)).head;
/** The RAW revision at every snapshot the client publishes from now on. */
function revisions(b: Browser): number[] {
  const seen: number[] = [];
  b.client.subscribe(() => { seen.push(b.replica.raw()?.checkpoint.revision ?? -1); });
  return seen;
}
const rateLimited = (seconds?: number): Response => new Response(JSON.stringify({ error: "rate_limited" }), {
  status: 429, headers: seconds === undefined ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", "Retry-After": String(seconds) },
});
const ledgerGets = (server: FakeServer): number => server.requests.filter(item => item === "GET /api/account/ledger").length;
/** Fake clock for setTimeout and Date only; WebCrypto, streams and setImmediate stay real. */
function fakeTime(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}
/** Lets real async work (WebCrypto digests and signatures, a few in a row per exchange) finish: event-loop turns, no clock. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) await new Promise(resolve => setImmediate(resolve));
}
/** Moves the fake clock by `ms` in steps, letting real async work finish between steps (so an attempt lands within one step). */
async function elapse(ms: number, step = 5_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    await settle();
  }
}
/** Gaps between attempts never shrink, up to one elapse() step of timing slack. */
const growing = (gaps: number[], slack = 5_000): boolean => gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1] - slack);
/** An account whose bridge was added and then revoked: revision 3, the revocation last. */
async function revokedBridge(): Promise<{ server: FakeServer; authenticator: FakeAuthenticator; a: Browser; accountId: string; full: Ledger }> {
  const { server, authenticator, a, accountId } = await owner();
  await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "studio") });
  await a.client.revokeBridge("studio");
  return { server, authenticator, a, accountId, full: current(server) };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    ["server_full", 503], ["handle_taken", 409], ["rate_limited", 429], ["server_misconfigured", 503],
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

  it("treats a 200 keep answer to the creating POST (the loser of a concurrent identical creation) as success", async () => {
    const server = new FakeServer();
    let first = true;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await server.fetch(input, init);
      if (first && init?.method === "POST" && new URL(String(input)).pathname === "/api/account/ledger") {
        first = false;
        const stored = await response.json() as { ledger: Ledger };
        return json({ decision: "keep", ledger: stored.ledger, discarded: 0 }, 200);
      }
      return response;
    }) as typeof fetch;
    const authenticator = new FakeAuthenticator();
    const a = await browser(server, authenticator, { deps: { fetchImpl } });
    await a.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: "owner" });
    expect(a.client.snapshot()).toMatchObject({ status: "ready", pending: "none" });
    expect(a.replica.raw()).not.toBeNull();
    expect(server.sessions).toHaveLength(1);
  });

  it("reports rate_limited (not done) for a 429 on an existing account's write and keeps the signed record locally", async () => {
    const server = new FakeServer();
    const authenticator = new FakeAuthenticator();
    let limited = false;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (limited && init?.method === "POST" && new URL(String(input)).pathname === "/api/account/ledger") return json({ error: "rate_limited" }, 429);
      return server.fetch(input, init);
    }) as typeof fetch;
    const a = await browser(server, authenticator, { deps: { fetchImpl } });
    await a.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: "owner" });
    const accountId = a.client.snapshot().checkpoint?.accountId ?? "";
    limited = true;
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") })).rejects.toThrow("rate_limited");
    // Kept exactly like after a transient failure: in the local chain, not on the server.
    expect(a.replica.raw()?.ledger.transitions).toHaveLength(2);
    expect(server.ledger?.transitions).toHaveLength(1);
    limited = false;
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b2") });
    expect(server.ledger?.transitions).toHaveLength(3);
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

  async function paced(): Promise<{ c: Browser; local: { head: string; revision: number }; gets: () => number; posts: () => number }> {
    const { server, authenticator, a } = await owner();
    const c = await browser(server, authenticator, { storage: a.storage, deps: { now: () => Date.now() } });
    await c.client.load();
    const local = c.replica.raw()?.checkpoint;
    if (local === undefined) throw new Error("unbound");
    server.requests = [];
    const before = server.posts.length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    return { c, local, gets: () => ledgerGets(server), posts: () => server.posts.length - before };
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

  it("ignores the same head, reads (paced) on a lower revision, and force skips the spacing but joins a read in flight", async () => {
    const { c, local, gets, posts } = await paced();
    await c.client.noteHead(local.head, local.revision);
    await c.client.offer({ type: "ledger_head", head: local.head, revision: local.revision });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gets()).toBe(0);
    // A lower revision may mean a server behind this chain: a read tells (this server is not behind, so nothing is sent).
    await c.client.noteHead("x".repeat(43), local.revision - 1);
    expect(gets()).toBe(1);
    const lower = c.client.offer({ type: "ledger_head", head: "x".repeat(43), revision: local.revision - 1 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(gets()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await lower;
    expect(gets()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await c.client.noteHead("y".repeat(43), local.revision);
    expect(gets()).toBe(3);
    await Promise.all([c.client.refresh({ force: true }), c.client.refresh({ force: true })]);
    expect(gets()).toBe(4);
    const pushed = c.client.offer({ type: "ledger_head", head: "y".repeat(43), revision: local.revision + 5 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gets()).toBe(4);
    await vi.advanceTimersByTimeAsync(1_000);
    await pushed;
    expect(gets()).toBe(5);
    expect(posts()).toBe(0);
  });
});

describe("LedgerClient re-offer", () => {
  it("brings a server rolled back to a prefix forward at the next read, with its own chain, no prompt, the local chain never shrinking", async () => {
    const { server, authenticator, a, accountId, full } = await revokedBridge();
    const head = await headOf(full);
    // The restored row has no revocation: a server that trusted it would let the revoked bridge back in.
    const old = rollBack(server, accountId, 2);
    const seen = revisions(a);
    const posts = server.posts.length;
    authenticator.calls = [];
    // A user write sends only its chain; a re-offer also names the server head it just read.
    expect(Object.keys(server.posts[posts - 1])).toEqual(["ledger"]);
    await a.client.refresh({ force: true });
    expect(server.posts).toHaveLength(posts + 1);
    expect(server.posts[posts]).toEqual({ ledger: full, expectHead: await headOf(old) });
    expect(await headOf(current(server))).toBe(head);
    expect((await verifyLedger(current(server))).revokedBridgeIds).toEqual(["studio"]);
    expect(a.replica.raw()?.checkpoint.head).toBe(head);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(revision => revision === 3)).toBe(true);
    // Converged: later reads send nothing.
    await a.client.refresh({ force: true });
    expect(server.posts).toHaveLength(posts + 1);
    expect(authenticator.calls).toEqual([]);
  });

  it("checks a shorter relay-pushed chain with a read, then brings the server forward", async () => {
    const { server, authenticator, a, accountId, full } = await revokedBridge();
    const old = rollBack(server, accountId, 2);
    const seen = revisions(a);
    const posts = server.posts.length;
    authenticator.calls = [];
    fakeTime();
    await vi.advanceTimersByTimeAsync(2_000);
    await a.client.offer({ type: "ledger", ledger: old });
    await vi.waitFor(async () => expect(await headOf(current(server))).toBe(await headOf(full)), { timeout: 5_000 });
    // Waits for the re-offer still finishing (its answer), then reads once more: nothing else is sent.
    await a.client.refresh({ force: true });
    expect(server.posts).toHaveLength(posts + 1);
    expect(seen.every(revision => revision === 3)).toBe(true);
    expect(a.replica.raw()?.checkpoint.head).toBe(await headOf(full));
    expect(authenticator.calls).toEqual([]);
  });

  it("checks an older relay head with a read, then brings the server forward", async () => {
    const { server, authenticator, a, accountId, full } = await revokedBridge();
    const old = rollBack(server, accountId, 2);
    const seen = revisions(a);
    const posts = server.posts.length;
    authenticator.calls = [];
    fakeTime();
    await vi.advanceTimersByTimeAsync(2_000);
    await a.client.noteHead(await headOf(old), 2);
    expect(server.posts).toHaveLength(posts + 1);
    expect(await headOf(current(server))).toBe(await headOf(full));
    expect(seen.every(revision => revision === 3)).toBe(true);
    expect(authenticator.calls).toEqual([]);
  });

  it("brings the server forward at sign-in, before the session proof, even when it lost this browser's own add_device", async () => {
    const { server, authenticator, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    const full = current(server);
    rollBack(server, accountId, 1);
    // The page reloads: same profile, same keys; this page never loaded its device before.
    const page = await browser(server, authenticator, { storage: b.storage, identity: b });
    const seen = revisions(page);
    const posts = server.posts.length;
    const sessions = server.sessions.length;
    authenticator.calls = [];
    expect(await page.client.signInKnownDevice()).toBe(true);
    expect(server.posts).toHaveLength(posts + 1);
    expect(await headOf(current(server))).toBe(await headOf(full));
    expect(server.sessions).toHaveLength(sessions + 1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(revision => revision === 2)).toBe(true);
    expect(authenticator.calls).toEqual([]);
  });

  /** An owner page (jitter pinned to -20%) and a phone; `refuse` answers the page's POSTs while it returns a Response. */
  async function withPhone(): Promise<{ server: FakeServer; authenticator: FakeAuthenticator; a: Browser; page: Browser; accountId: string; phone: string }> {
    const { server, authenticator, a, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    const phone = (await b.endpoint(accountId)).endpoint.id;
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0 } });
    return { server, authenticator, a, page, accountId, phone };
  }

  it.each([
    ["5 (s)", 24_000], ["0", 24_000], ["an HTTP date in the past", 24_000], ["an HTTP date 120 s ahead", 120_000],
  ] as const)("sends a revocation refused with 429 and Retry-After %s again after the later of it and the backoff floor, without a prompt", async (label, due) => {
    const { server, authenticator, page, phone } = await withPhone();
    fakeTime();
    const header = label === "5 (s)" ? "5" : label === "0" ? "0"
      : new Date(Date.now() + (label.includes("past") ? -60_000 : 120_000)).toUTCString();
    let refusals = 1;
    const times: number[] = [];
    server.postHook = () => {
      times.push(Date.now());
      return refusals-- > 0 ? new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "Retry-After": header } }) : null;
    };
    const posts = server.posts.length;
    authenticator.calls = [];
    await expect(page.client.revokeDevice(phone)).rejects.toThrow("rate_limited");
    expect(authenticator.names()).toEqual(["sign"]);
    expect(server.posts).toHaveLength(posts + 1);
    expect(current(server).transitions).toHaveLength(2);
    expect(page.replica.raw()?.checkpoint.revokedDeviceIds).toEqual([phone]);
    // Not a fork-lost removal (localOnly): one the server does not have yet.
    expect(page.client.snapshot().localOnly).toEqual({ deviceIds: [], bridgeIds: [] });
    expect(page.client.snapshot().unsaved).toEqual({ deviceIds: [phone], bridgeIds: [] });
    // Small steps, each letting the retry's read and POST finish: an early retry would land (and be stamped) early.
    await elapse(due + 2_000, 500);
    await vi.waitFor(async () => expect((await verifyLedger(current(server))).revokedDeviceIds).toEqual([phone]), { timeout: 5_000 });
    expect(times).toHaveLength(2);
    // An HTTP date has whole seconds: up to 1 s earlier than 120 s.
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(due - 1_000);
    expect(times[1] - times[0]).toBeLessThanOrEqual(due + 1_000);
    // Waits for the run to finish (its answer recorded), then reads once more.
    await page.client.refresh({ force: true });
    expect(server.posts).toHaveLength(posts + 2);
    expect(server.posts[posts + 1].ledger).toEqual(page.replica.raw()?.ledger);
    expect(page.client.snapshot().unsaved).toEqual({ deviceIds: [], bridgeIds: [] });
    await elapse(3_600_000, 60_000);
    expect(server.posts).toHaveLength(posts + 2);
    expect(authenticator.names()).toEqual(["sign"]);
  });

  it("unsaved lists a refused revocation only while the server is known to be behind; retryNow() sends it once, without a prompt", async () => {
    const { server, authenticator, a, page, phone } = await withPhone();
    let refuse = true;
    // No Retry-After: retryNow() may skip the backoff (a Retry-After it would honour, see S5).
    server.postHook = () => (refuse ? rateLimited() : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(page.client.revokeDevice(phone)).rejects.toThrow("rate_limited");
    expect(page.client.snapshot()).toMatchObject({ serverState: "behind", unsaved: { deviceIds: [phone], bridgeIds: [] }, conflict: false, canReoffer: true });
    expect(page.client.snapshot().retryAt).toBe(Date.now() + 24_000);
    expect(page.client.snapshot().retryNotBefore).toBeNull();
    // Another page of the profile, before any read: the confirmed server state persisted with the chain already tells.
    const other = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0 } });
    await other.client.load();
    expect(other.replica.raw()?.checkpoint.revokedDeviceIds).toEqual([phone]);
    expect(other.client.snapshot()).toMatchObject({ serverState: "behind", unsaved: { deviceIds: [phone], bridgeIds: [] } });
    // A profile with the same chain but no confirmed server state: unknown, and unknown is not "unsaved".
    const unread = await browser(server, authenticator, { storage: memoryReplicaStorage(), identity: a });
    const chain = page.replica.raw()?.ledger;
    expect((await unread.replica.offer(chain, { bind: true, expectAccountId: (await verifyLedger(current(server))).accountId })).decision).toBe("adopt");
    await unread.client.load();
    expect(unread.client.snapshot()).toMatchObject({ serverState: "unknown", unsaved: { deviceIds: [], bridgeIds: [] }, retryAt: null });
    other.client.dispose();
    unread.client.dispose();
    // retryNow(): past the 600 s Retry-After, one fresh read and one POST.
    refuse = false;
    const posts = server.posts.length;
    const gets = ledgerGets(server);
    authenticator.calls = [];
    await page.client.retryNow();
    expect(server.posts).toHaveLength(posts + 1);
    expect(ledgerGets(server)).toBe(gets + 1);
    expect((await verifyLedger(current(server))).revokedDeviceIds).toEqual([phone]);
    expect(page.client.snapshot().unsaved).toEqual({ deviceIds: [], bridgeIds: [] });
    // Repeated calls share one run; once saved nothing more is sent.
    await Promise.all([page.client.retryNow(), page.client.retryNow(), page.client.retryNow()]);
    expect(server.posts).toHaveLength(posts + 1);
    expect(authenticator.calls).toEqual([]);
  });

  it("does not loop: a server that keeps answering 429 gets a growing, bounded schedule, and nothing after dispose()", async () => {
    const { server, authenticator, a, accountId } = await revokedBridge();
    rollBack(server, accountId, 2);
    const times: number[] = [];
    server.postHook = () => {
      times.push(Date.now());
      return rateLimited(5);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Jitter pinned to its lowest (-20%): the tightest schedule the client can produce.
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0 } });
    authenticator.calls = [];
    fakeTime();
    await page.client.refresh({ force: true });
    expect(times).toHaveLength(1);
    await elapse(3_600_000);
    expect(times.length).toBeGreaterThanOrEqual(8);
    expect(times.length).toBeLessThanOrEqual(12);
    const gaps = times.slice(1).map((at, index) => at - times[index]);
    expect(gaps.every(gap => gap >= 24_000 && gap <= 730_000)).toBe(true);
    expect(growing(gaps)).toBe(true);
    // One warning per backoff step at most (30 s, 1, 2, 4, 8, 10 min).
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(6);
    const count = times.length;
    page.client.dispose();
    await page.client.refresh({ force: true });
    await elapse(3_600_000, 60_000);
    expect(times).toHaveLength(count);
    expect(authenticator.calls).toEqual([]);
    warn.mockRestore();
  });

  it("sends the same (local, server) head pair at most once per 30 s, however many reads see it", async () => {
    const { server, authenticator, a, accountId } = await revokedBridge();
    rollBack(server, accountId, 2);
    // A server that keeps failing on the network: the first backoff (24 s with the jitter pinned low) is shorter than the window.
    const times: number[] = [];
    server.postHook = () => {
      times.push(Date.now());
      return Promise.reject(new Error("offline"));
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0 } });
    authenticator.calls = [];
    fakeTime();
    for (let index = 0; index < 20; index += 1) {
      await page.client.refresh({ force: true });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(times).toHaveLength(1);
    await elapse(15_000, 1_000);
    await vi.waitFor(() => expect(times).toHaveLength(2), { timeout: 5_000 });
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(30_000);
    expect(page.replica.raw()?.checkpoint.revision).toBe(3);
    expect(authenticator.calls).toEqual([]);
  });

  it("backs off after a refusal that carried the server's chain while the server stays behind, and stops once it holds the chain", async () => {
    const { server, authenticator, a, accountId, full } = await revokedBridge();
    rollBack(server, accountId, 2);
    let refusing = true;
    const times: number[] = [];
    // This server refuses the chain and answers with its own (shorter) one.
    server.postHook = () => {
      times.push(Date.now());
      return refusing ? json({ error: "ledger_rejected", ledger: server.ledgerOf(accountId) }, 409) : null;
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0 } });
    authenticator.calls = [];
    fakeTime();
    await page.client.refresh({ force: true });
    await elapse(600_000);
    // 0, 30 s (24 s, then the pair window), 78 s, 174 s, 366 s.
    expect(times.length).toBeGreaterThanOrEqual(3);
    expect(times.length).toBeLessThanOrEqual(6);
    const gaps = times.slice(1).map((at, index) => at - times[index]);
    expect(gaps.every(gap => gap >= 24_000)).toBe(true);
    expect(growing(gaps)).toBe(true);
    refusing = false;
    await elapse(1_200_000);
    expect(await headOf(current(server))).toBe(await headOf(full));
    const count = times.length;
    await elapse(3_600_000, 60_000);
    expect(times).toHaveLength(count);
    expect(authenticator.calls).toEqual([]);
  });

  it.each([
    ["the server holds the local chain", false],
    ["the server is behind and refuses", true],
  ] as const)("a relay flood (1 notice per second for 10 min) while %s costs POSTs only on the backoff schedule", async (_state, refusing) => {
    const { server, authenticator, a, accountId } = await revokedBridge();
    if (refusing) {
      rollBack(server, accountId, 2);
      server.postHook = () => json({ error: "ledger_rejected", ledger: server.ledgerOf(accountId) }, 409);
    }
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0 } });
    await page.client.load();
    const posts = server.posts.length;
    authenticator.calls = [];
    fakeTime();
    for (let second = 0; second < 600; second += 1) {
      void page.client.noteHead("z".repeat(43), 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
    }
    if (refusing) {
      expect(server.posts.length - posts).toBeGreaterThanOrEqual(1);
      expect(server.posts.length - posts).toBeLessThanOrEqual(6);
    } else {
      expect(server.posts).toHaveLength(posts);
    }
    expect(authenticator.calls).toEqual([]);
  });

  it("a user write answered with a refusal is not sent straight back by the re-offer that answer queued", async () => {
    const { server, authenticator, a, accountId } = await owner();
    server.postHook = () => json({ error: "ledger_rejected", ledger: server.ledgerOf(accountId) }, 409);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") })).rejects.toThrow("ledger_rejected");
    const posts = server.posts.length;
    await elapse(29_000, 1_000);
    expect(server.posts).toHaveLength(posts);
    // After the pair window: one re-offer (fresh read, then the POST), refused again, so backing off from here.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(server.posts).toHaveLength(posts + 1), { timeout: 5_000 });
    expect(server.posts[posts]).toMatchObject({ expectHead: await headOf(current(server)) });
  });

  /** Revision 3 locally and on the server (add_bridge b1, add_bridge b2), plus the revision-2 prefix forks build on. */
  async function twoBridges(): Promise<{ server: FakeServer; authenticator: FakeAuthenticator; a: Browser; accountId: string; local: Ledger; base: Ledger }> {
    const { server, authenticator, a, accountId } = await owner();
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") });
    const base = current(server);
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b2") });
    return { server, authenticator, a, accountId, local: current(server), base };
  }
  /** A fork of `base` with one add_bridge and no revocation whose head sorts before (`smaller`) or after the local head. */
  async function tieFork(base: Ledger, authenticator: FakeAuthenticator, accountId: string, localHead: string, smaller: boolean): Promise<Ledger> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const fork = await signed(base, authenticator, { type: "add_bridge", bridge: await testBridge(accountId, `fork-${attempt}`) });
      if ((await headOf(fork) < localHead) === smaller) return fork;
    }
    throw new Error("no fork");
  }

  it("adopts a winning fork the server holds (more revocations, or the smaller head on a tie) and sends nothing", async () => {
    const { server, authenticator, a, accountId, local, base } = await twoBridges();
    const revoking = await signed(base, authenticator, { type: "revoke_bridge", bridgeId: "b1" });
    const smaller = await tieFork(base, authenticator, accountId, await headOf(local), true);
    const posts = server.posts.length;
    authenticator.calls = [];
    for (const fork of [revoking, smaller]) {
      // A trusted device (a's keys) bound to the local chain (revision 3, no revocation), facing a server that holds the winning fork.
      const page = await browser(server, authenticator, { storage: memoryReplicaStorage(), identity: a });
      expect((await page.replica.offer(local, { bind: true, expectAccountId: accountId })).decision).toBe("adopt");
      server.ledgers.set(accountId, wire(fork));
      const seen = revisions(page);
      await page.client.refresh({ force: true });
      expect(page.client.snapshot().status).toBe("ready");
      expect(page.replica.raw()?.checkpoint.head).toBe(await headOf(fork));
      expect(seen.every(revision => revision === 3)).toBe(true);
      expect(server.posts).toHaveLength(posts);
      expect(await headOf(current(server))).toBe(await headOf(fork));
    }
    expect(authenticator.calls).toEqual([]);
  });

  it("re-offers an equal-length local chain that wins the tie-break against the server's fork", async () => {
    const { server, authenticator, a, accountId, local, base } = await twoBridges();
    const larger = await tieFork(base, authenticator, accountId, await headOf(local), false);
    server.ledgers.set(accountId, wire(larger));
    const posts = server.posts.length;
    authenticator.calls = [];
    await a.client.refresh({ force: true });
    expect(server.posts).toHaveLength(posts + 1);
    expect(await headOf(current(server))).toBe(await headOf(local));
    expect(a.replica.raw()?.checkpoint.head).toBe(await headOf(local));
    expect(authenticator.calls).toEqual([]);
  });

  it("adopts a winning chain a 409 answers with, and sends nothing more", async () => {
    const { server, authenticator, a, accountId, base } = await twoBridges();
    const winning = await signed(base, authenticator, { type: "revoke_bridge", bridgeId: "b1" });
    rollBack(server, accountId, 2);
    server.postHook = () => json({ error: "ledger_rejected", ledger: winning }, 409);
    const posts = server.posts.length;
    authenticator.calls = [];
    fakeTime();
    await a.client.refresh({ force: true });
    expect(server.posts).toHaveLength(posts + 1);
    expect(a.replica.raw()?.checkpoint.head).toBe(await headOf(winning));
    expect(a.client.snapshot().discarded.map(item => item.payload.operation.type)).toEqual(["add_bridge"]);
    await elapse(3_600_000, 60_000);
    expect(server.posts).toHaveLength(posts + 1);
    expect(authenticator.calls).toEqual([]);
  });

  it("sends nothing when the server holds the local chain", async () => {
    const { server, authenticator, a } = await revokedBridge();
    const posts = server.posts.length;
    authenticator.calls = [];
    const raw = a.replica.raw();
    if (raw === null) throw new Error("unbound");
    await a.client.refresh({ force: true });
    await a.client.offer({ type: "ledger", ledger: raw.ledger });
    await a.client.noteHead(raw.checkpoint.head, raw.checkpoint.revision);
    await a.client.signInKnownDevice();
    expect(server.posts).toHaveLength(posts);
    expect(authenticator.calls).toEqual([]);
  });

  it("a browser whose own chain revokes it restores that revocation to a rolled-back server, loaded or not", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    const phone = (await b.endpoint(accountId)).endpoint.id;
    await a.client.revokeDevice(phone);
    // b adopts the chain that revokes it: its own RAW chain now holds the revocation.
    await b.client.refresh({ force: true });
    expect(b.client.snapshot()).toMatchObject({ status: "device_revoked", canReoffer: true });
    expect(b.replica.raw()?.checkpoint.revokedDeviceIds).toEqual([phone]);
    const full = current(server);
    for (const which of ["loaded", "reloaded"] as const) {
      rollBack(server, accountId, 2);
      const posts = server.posts.length;
      authenticator.calls = [];
      const page = which === "loaded" ? b : await browser(server, authenticator, { storage: b.storage, identity: b });
      await page.client.refresh({ force: true });
      expect(server.posts, which).toHaveLength(posts + 1);
      expect(await headOf(current(server)), which).toBe(await headOf(full));
      expect((await verifyLedger(current(server))).revokedDeviceIds).toEqual([phone]);
      expect(authenticator.calls).toEqual([]);
    }
  });

  it("never re-offers for a browser whose own removal it knows only from another chain (sticky): it cannot write", async () => {
    const { server, a, b, phone } = await phoneAhead();
    await a.client.revokeDevice(phone);
    const posts = server.posts.length;
    // A forced read: b keeps its longer chain, the revocation becomes sticky only.
    await b.client.refresh({ force: true });
    expect(b.replica.raw()?.checkpoint.revokedDeviceIds).toEqual([]);
    expect(b.client.snapshot()).toMatchObject({ status: "device_revoked", canReoffer: false, retryAt: null });
    await b.client.retryNow();
    await elapse(3_600_000, 60_000);
    expect(server.posts).toHaveLength(posts);
  });

  it("never re-offers while unbound or during an account creation, and arms no retry for a refused creation", async () => {
    const { server, authenticator } = await owner();
    const fresh = await browser(server, authenticator);
    await fresh.client.load();
    const requests = server.requests.length;
    await fresh.client.refresh({ force: true });
    await fresh.client.noteHead("x".repeat(43), 0);
    await fresh.client.offer({ type: "ledger", ledger: { genesis: current(server).genesis, transitions: [] } });
    expect(server.requests).toHaveLength(requests);

    const other = new FakeServer();
    other.creationRefusal = { status: 503, body: { error: "server_full" } };
    const creating = await browser(other, authenticator);
    fakeTime();
    await expect(creating.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: "owner" })).rejects.toThrow("server_full");
    await creating.client.refresh({ force: true });
    await elapse(3_600_000, 60_000);
    expect(other.posts).toHaveLength(1);
  });

  it("forget() and rotateDeviceIdentity() cancel a pending retry", async () => {
    for (const leave of ["forget", "rotate"] as const) {
      const { server, authenticator, a, accountId } = await revokedBridge();
      rollBack(server, accountId, 2);
      server.postHook = () => rateLimited(5);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      fakeTime();
      await a.client.refresh({ force: true });
      const posts = server.posts.length;
      if (leave === "forget") await a.client.forget(); else await a.client.rotateDeviceIdentity();
      await a.client.refresh({ force: true });
      await elapse(3_600_000, 60_000);
      expect(server.posts).toHaveLength(posts);
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("two triggers arriving together produce one POST", async () => {
    const { server, authenticator, a, accountId, full } = await revokedBridge();
    rollBack(server, accountId, 2);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    server.postHook = async () => {
      await gate;
      return null;
    };
    const posts = server.posts.length;
    const gets = ledgerGets(server);
    authenticator.calls = [];
    const first = a.client.refresh({ force: true });
    await vi.waitFor(() => expect(server.posts).toHaveLength(posts + 1));
    // The trigger's read and the run's fresh read; a third read while that POST is still open sees the server still behind.
    expect(ledgerGets(server)).toBe(gets + 2);
    const second = a.client.signInKnownDevice();
    await vi.waitFor(() => expect(ledgerGets(server)).toBe(gets + 3));
    release();
    await first;
    expect(await second).toBe(true);
    expect(server.posts).toHaveLength(posts + 1);
    expect(await headOf(current(server))).toBe(await headOf(full));
    expect(authenticator.calls).toEqual([]);
  });

  it("a pending retry that finds the account deleted sends nothing, re-creates nothing, and stops", async () => {
    const { server, a, accountId, authenticator } = await revokedBridge();
    rollBack(server, accountId, 2);
    let refusals = 1;
    server.postHook = () => (refusals-- > 0 ? rateLimited(60) : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0 } });
    fakeTime();
    await page.client.refresh({ force: true });
    const posts = server.posts.length;
    // The operator deletes the account.
    server.ledgers.delete(accountId);
    server.requests = [];
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(server.requests).toEqual(["GET /api/account/ledger"]), { timeout: 5_000 });
    await elapse(3_600_000, 60_000);
    expect(server.requests).toEqual(["GET /api/account/ledger"]);
    expect(server.posts).toHaveLength(posts);
    expect(server.ledgers.has(accountId)).toBe(false);
    expect(page.replica.raw()?.checkpoint.revision).toBe(3);
    expect(page.client.snapshot().unsaved).toEqual({ deviceIds: [], bridgeIds: [] });
  });

  it("an account deleted between the fresh read and the POST is not re-created: the re-offer names the head it read", async () => {
    const { server, a, accountId, authenticator } = await revokedBridge();
    const old = rollBack(server, accountId, 2);
    let gets = 0;
    // Deleted right after the second read (the run's fresh read, after the read that triggered it).
    server.afterGet = () => { gets += 1; if (gets === 2) server.ledgers.delete(accountId); };
    const posts = server.posts.length;
    authenticator.calls = [];
    fakeTime();
    await a.client.refresh({ force: true });
    expect(server.posts).toHaveLength(posts + 1);
    expect(server.posts[posts]).toMatchObject({ expectHead: await headOf(old) });
    expect(server.ledgers.has(accountId)).toBe(false);
    server.requests = [];
    await elapse(3_600_000, 60_000);
    expect(server.requests).toEqual([]);
    expect(server.ledgers.has(accountId)).toBe(false);
    expect(authenticator.calls).toEqual([]);
  });

  /** A phone whose two own writes were refused (Retry-After 120 s): its chain is two records ahead of the server's. */
  async function phoneAhead(): Promise<{ server: FakeServer; authenticator: FakeAuthenticator; a: Browser; b: Browser; accountId: string; phone: string; base: Ledger }> {
    const { server, authenticator, a, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    const phone = (await b.endpoint(accountId)).endpoint.id;
    const base = current(server);
    let refusals = 2;
    server.postHook = () => (refusals-- > 0 ? rateLimited(120) : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(b.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "x") })).rejects.toThrow("rate_limited");
    await expect(b.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "y") })).rejects.toThrow("rate_limited");
    expect(b.replica.raw()?.checkpoint.revision).toBe(4);
    return { server, authenticator, a, b, accountId, phone, base };
  }

  it("a phone revoked elsewhere while its own writes were refused learns it at the fresh read and sends nothing", async () => {
    const { server, a, b, phone } = await phoneAhead();
    await a.client.revokeDevice(phone);
    const revoked = current(server);
    const posts = server.posts.length;
    await elapse(150_000);
    await vi.waitFor(() => expect(b.client.snapshot().status).toBe("device_revoked"), { timeout: 5_000 });
    expect(server.posts).toHaveLength(posts);
    expect(current(server)).toEqual(revoked);
    expect((await verifyLedger(current(server))).revokedDeviceIds).toEqual([phone]);
    // The phone keeps its own (longer) chain, and the revocation as sticky.
    expect(b.replica.raw()?.checkpoint.revision).toBe(4);
    expect(b.replica.sticky()?.deviceIds).toEqual([phone]);
  });

  it("a revocation landing between the fresh read and the POST: head_changed, the phone learns it and stops", async () => {
    const { server, authenticator, b, accountId, phone, base } = await phoneAhead();
    const revoking = await signed(base, authenticator, { type: "revoke_device", endpointId: phone });
    let gets = 0;
    server.afterGet = () => { gets += 1; if (gets === 1) server.ledgers.set(accountId, wire(revoking)); };
    const posts = server.posts.length;
    await elapse(150_000);
    await vi.waitFor(() => expect(b.client.snapshot().status).toBe("device_revoked"), { timeout: 5_000 });
    // One POST, against the head it read; refused, and not sent again.
    expect(server.posts).toHaveLength(posts + 1);
    expect(server.posts[posts]).toMatchObject({ expectHead: await headOf(base) });
    expect(current(server)).toEqual(wire(revoking));
    await elapse(3_600_000, 60_000);
    expect(server.posts).toHaveLength(posts + 1);
  });

  it("an answer to a read sent before the re-offer's POST, arriving after its answer, does not overwrite what that answer recorded", async () => {
    const { server, authenticator, a, accountId, full } = await revokedBridge();
    rollBack(server, accountId, 2);
    let hold = false;
    let waiting = false;
    let release: () => void = () => undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? "GET") !== "GET" || !hold) return server.fetch(input, init);
      hold = false;
      // Answered by the server now, delivered later.
      const response = await server.fetch(input, init);
      waiting = true;
      await new Promise<void>(resolve => { release = resolve; });
      return response;
    }) as typeof fetch;
    let refusals = 1;
    server.postHook = () => (refusals-- > 0 ? rateLimited() : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0, fetchImpl } });
    fakeTime();
    // Refused once: the retry is due at 30 s (24 s backoff, then the pair window).
    await page.client.refresh({ force: true });
    await vi.advanceTimersByTimeAsync(29_000);
    hold = true;
    const late = page.client.refresh({ force: true });
    await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 5_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(async () => expect(await headOf(current(server))).toBe(await headOf(full)), { timeout: 5_000 });
    await vi.waitFor(() => expect(page.client.snapshot().unsaved).toEqual({ deviceIds: [], bridgeIds: [] }), { timeout: 5_000 });
    release();
    await late;
    expect(page.client.snapshot().unsaved).toEqual({ deviceIds: [], bridgeIds: [] });
    const gets = ledgerGets(server);
    const posts = server.posts.length;
    await elapse(120_000);
    expect(ledgerGets(server)).toBe(gets);
    expect(server.posts).toHaveLength(posts);
  });

  it("refresh(), noteHead() and signInKnownDevice() do not wait for a re-offer queued behind an open passkey prompt", async () => {
    const { server, authenticator, a, accountId, full } = await revokedBridge();
    rollBack(server, accountId, 2);
    let release: () => void = () => undefined;
    const prompt = new Promise<void>(resolve => { release = resolve; });
    authenticator.beforeSign = () => prompt;
    const bridge = await testBridge(accountId, "z");
    const posts = server.posts.length;
    fakeTime();
    // The append's read queues a re-offer; the append then holds the queue while its prompt is open.
    const append = a.client.append({ type: "add_bridge", bridge });
    await vi.waitFor(() => expect(authenticator.names()).toContain("sign"), { timeout: 5_000 });
    const done = { refresh: false, noteHead: false, signIn: false };
    void a.client.refresh({ force: true }).then(() => { done.refresh = true; });
    void a.client.noteHead("q".repeat(43), 9).then(() => { done.noteHead = true; });
    void a.client.signInKnownDevice().then(() => { done.signIn = true; });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(done).toEqual({ refresh: true, noteHead: true, signIn: true }), { timeout: 5_000 });
    expect(server.posts).toHaveLength(posts);
    authenticator.beforeSign = null;
    release();
    await append;
    expect((await verifyLedger(current(server))).revision).toBe(4);
    expect(current(server).transitions.slice(0, 3)).toEqual(full.transitions);
  });

  it("waits for a running re-offer no longer than the request timeout", async () => {
    const { server, a, accountId } = await revokedBridge();
    rollBack(server, accountId, 2);
    // A POST that is never answered.
    server.postHook = () => new Promise<Response | null>(() => undefined);
    const posts = server.posts.length;
    fakeTime();
    let done = false;
    void a.client.refresh({ force: true }).then(() => { done = true; });
    await vi.waitFor(() => expect(server.posts).toHaveLength(posts + 1), { timeout: 5_000 });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 5_000 });
  });

  it("S1: sends nothing that would drop another device's removal the server has (conflict), until it is signed again here", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    const c = await browser(server, authenticator);
    await c.client.signInNewDevice({ deviceLabel: "Tablet" });
    const tablet = (await c.endpoint(accountId)).endpoint.id;
    await a.client.refresh({ force: true });
    await b.client.refresh({ force: true });
    let refusals = 2;
    server.postHook = () => (refusals-- > 0 ? rateLimited(120) : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(b.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "x") })).rejects.toThrow("rate_limited");
    await expect(b.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "y") })).rejects.toThrow("rate_limited");
    await a.client.revokeDevice(tablet);
    const posts = server.posts.length;
    authenticator.calls = [];
    // b's retry: the fresh read shows the server's chain revoking the tablet, which b's longer chain still lists.
    await elapse(150_000);
    await vi.waitFor(() => expect(b.client.snapshot().conflict).toBe(true), { timeout: 5_000 });
    expect(server.posts).toHaveLength(posts);
    expect((await verifyLedger(current(server))).revokedDeviceIds).toEqual([tablet]);
    expect(b.client.snapshot()).toMatchObject({ serverState: "behind", retryAt: null, canReoffer: true, status: "ready" });
    expect(b.client.snapshot().localOnly.deviceIds).toEqual([tablet]);
    await b.client.retryNow();
    await elapse(3_600_000, 60_000);
    expect(server.posts).toHaveLength(posts);
    // The owner signs that removal again on this browser: a user write on top of b's chain, which keeps x and y.
    await b.client.revokeDevice(tablet);
    expect(authenticator.names()).toEqual(["sign"]);
    const served = await verifyLedger(current(server));
    expect(served.revokedDeviceIds).toEqual([tablet]);
    expect(served.bridges.map(item => item.bridgeId).sort()).toEqual(["x", "y"]);
    expect(b.client.snapshot()).toMatchObject({ conflict: false, serverState: "current", localOnly: { deviceIds: [], bridgeIds: [] } });
  });

  it("S2: a browser's own refused removal is sent again (not before Retry-After, retryNow included) and the server stops listing it", async () => {
    const { server, authenticator, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    const phone = (await b.endpoint(accountId)).endpoint.id;
    let refusals = 1;
    server.postHook = () => (refusals-- > 0 ? rateLimited(60) : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(b.client.revokeDevice(phone)).rejects.toThrow("rate_limited");
    expect(b.client.snapshot()).toMatchObject({ status: "device_revoked", canReoffer: true, serverState: "behind", unsaved: { deviceIds: [phone], bridgeIds: [] } });
    const posts = server.posts.length;
    authenticator.calls = [];
    await b.client.retryNow();
    expect(server.posts).toHaveLength(posts);
    await elapse(70_000, 1_000);
    await vi.waitFor(async () => expect((await verifyLedger(current(server))).revokedDeviceIds).toEqual([phone]), { timeout: 5_000 });
    expect(server.posts).toHaveLength(posts + 1);
    expect((await verifyLedger(current(server))).devices.some(item => item.endpoint.id === phone)).toBe(false);
    await b.client.refresh({ force: true });
    expect(b.client.snapshot()).toMatchObject({ serverState: "current", unsaved: { deviceIds: [], bridgeIds: [] } });
    expect(authenticator.calls).toEqual([]);
  });

  it.each(["account_unknown", "converged_reset", "refused_with_ours"] as const)("S3: a hostile server (%s, alternating prefixes, a hint every 2 s) gets POSTs only on the backoff schedule", async mode => {
    const { server, authenticator, a, full } = await revokedBridge();
    const p1 = wire({ genesis: full.genesis, transitions: full.transitions.slice(0, 1) });
    const p2 = wire({ genesis: full.genesis, transitions: full.transitions.slice(0, 2) });
    let reads = 0;
    let posts = 0;
    const sent: { at: number; head: unknown }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (new URL(String(input)).pathname !== "/api/account/ledger") return server.fetch(input, init);
      if (method === "GET") {
        reads += 1;
        if (mode !== "converged_reset") return json({ ledger: reads % 2 ? p1 : p2 });
        const turn = reads % 4;
        return json({ ledger: turn === 0 || turn === 2 ? full : turn === 1 ? p1 : p2 });
      }
      posts += 1;
      sent.push({ at: Date.now(), head: (JSON.parse(String(init?.body)) as { expectHead?: unknown }).expectHead });
      if (mode === "account_unknown") return json({ error: "account_unknown" }, 404);
      // refused_with_ours: a refusal that claims to hold this very chain, which leaves nothing to send.
      return json({ error: "head_changed", ledger: mode === "refused_with_ours" ? full : posts % 2 ? p1 : p2 }, 409);
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { fetchImpl, random: () => 0 } });
    fakeTime();
    await page.client.load();
    for (let at = 0; at < 600_000; at += 2_000) {
      void page.client.noteHead("z".repeat(43), 1);
      await vi.advanceTimersByTimeAsync(2_000);
      await settle();
    }
    // The backoff with the jitter pinned low: 0, 24 s (then the pair window), 72 s, 168 s, 360 s.
    expect(posts).toBeLessThanOrEqual(6);
    // The pair window holds for the head each fresh read returned: the same head is never sent twice within 30 s.
    for (const [index, item] of sent.entries()) {
      for (const later of sent.slice(index + 1)) if (later.head === item.head) expect(later.at - item.at).toBeGreaterThanOrEqual(30_000);
    }
    expect(page.replica.raw()?.checkpoint.revision).toBe(3);
  });

  it("L2: the pair window holds for the head the fresh read returns, not only for the one that triggered the attempt", async () => {
    const { server, authenticator, a, accountId, full } = await revokedBridge();
    const s1 = rollBack(server, accountId, 2);
    const s2 = wire({ genesis: full.genesis, transitions: full.transitions.slice(0, 1) });
    let serveS2 = false;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? "GET") === "GET" && serveS2 && new URL(String(input)).pathname === "/api/account/ledger") {
        serveS2 = false;
        return json({ ledger: s2 });
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const sent: { at: number; head: unknown }[] = [];
    server.postHook = () => rateLimited();
    const inner = server.fetch;
    server.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && new URL(String(input)).pathname === "/api/account/ledger") {
        sent.push({ at: Date.now(), head: (JSON.parse(String(init.body)) as { expectHead?: unknown }).expectHead });
      }
      return inner(input, init);
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Jitter pinned low: the first backoff (24 s) is shorter than the 30 s pair window.
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { fetchImpl, random: () => 0 } });
    fakeTime();
    await page.client.refresh({ force: true });
    expect(sent.map(item => item.head)).toEqual([await headOf(s1)]);
    // A read that shows another head: at 24 s the attempt is due for that pair, but its fresh read returns the one sent at 0 s.
    await elapse(10_000, 1_000);
    serveS2 = true;
    await page.client.refresh({ force: true });
    await elapse(25_000, 1_000);
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 5_000 });
    expect(sent[1].head).toBe(await headOf(s1));
    expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(30_000);
  });

  it("S4: after a reload with the server down, a removal the server never took is still unsaved (persisted confirmed state)", async () => {
    const { server, authenticator, a, accountId } = await owner();
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "studio") });
    server.postHook = () => new Response(JSON.stringify({ error: "ledger_unavailable" }), { status: 503 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(a.client.revokeBridge("studio")).rejects.toThrow("server_unavailable");
    expect(a.client.snapshot()).toMatchObject({ serverState: "behind", unsaved: { deviceIds: [], bridgeIds: ["studio"] } });
    a.client.dispose();
    const down = (async () => new Response(JSON.stringify({ error: "ledger_unavailable" }), { status: 503 })) as typeof fetch;
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { fetchImpl: down } });
    await page.client.load();
    expect(page.client.snapshot()).toMatchObject({ serverState: "behind", unsaved: { deviceIds: [], bridgeIds: ["studio"] } });
    await expect(page.client.refresh({ force: true })).rejects.toThrow("server_unavailable");
    expect(page.client.snapshot()).toMatchObject({ serverState: "behind", unsaved: { deviceIds: [], bridgeIds: ["studio"] } });
    expect((await verifyLedger(current(server))).revokedBridgeIds).toEqual([]);
  });

  it("a profile with no confirmed server state is 'unknown' while reads fail, and 'current' after the first read, which persists", async () => {
    const { server, authenticator, a, accountId } = await revokedBridge();
    let down = true;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => (down
      ? new Response(JSON.stringify({ error: "ledger_unavailable" }), { status: 503 }) : server.fetch(input, init))) as typeof fetch;
    const page = await browser(server, authenticator, { storage: memoryReplicaStorage(), identity: a, deps: { fetchImpl } });
    expect((await page.replica.offer(a.replica.raw()?.ledger, { bind: true, expectAccountId: accountId })).decision).toBe("adopt");
    await page.client.load();
    expect(page.client.snapshot()).toMatchObject({ serverState: "unknown", unsaved: { deviceIds: [], bridgeIds: [] }, conflict: false, retryAt: null });
    await expect(page.client.refresh({ force: true })).rejects.toThrow("server_unavailable");
    expect(page.client.snapshot().serverState).toBe("unknown");
    down = false;
    await page.client.refresh({ force: true });
    expect(page.client.snapshot()).toMatchObject({ serverState: "current", unsaved: { deviceIds: [], bridgeIds: [] } });
    expect(page.replica.confirmed()?.head).toBe(await headOf(current(server)));
    const again = await browser(server, authenticator, { storage: page.storage, identity: a });
    await again.client.load();
    expect(again.client.snapshot().serverState).toBe("current");
  });

  it("S5: retryNow() sends nothing before a pending Retry-After, however often it is called, and sends at once after it", async () => {
    const { server, a, accountId, authenticator } = await revokedBridge();
    rollBack(server, accountId, 2);
    let refusals = 1;
    server.postHook = () => (refusals-- > 0 ? rateLimited(10) : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Jitter pinned high: the automatic retry is due at 36 s, long after the 10 s Retry-After.
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 1 } });
    fakeTime();
    await page.client.refresh({ force: true });
    const posts = server.posts.length;
    expect(page.client.snapshot().retryNotBefore).toBe(Date.now() + 10_000);
    expect(page.client.snapshot().retryAt).toBe(Date.now() + 36_000);
    for (let index = 0; index < 20; index += 1) await page.client.retryNow();
    expect(server.posts).toHaveLength(posts);
    await vi.advanceTimersByTimeAsync(10_000);
    // A deadline, compared with the clock: now in the past.
    expect(page.client.snapshot().retryNotBefore).toBeLessThanOrEqual(Date.now());
    await page.client.retryNow();
    expect(server.posts).toHaveLength(posts + 1);
    expect(page.client.snapshot()).toMatchObject({ serverState: "current", retryAt: null, retryNotBefore: null });
  });

  it("S6: a user write requested while a slow hostile server keeps the re-offer busy still gets the queue", async () => {
    const { server, authenticator, a, accountId, full } = await revokedBridge();
    const p1 = wire({ genesis: full.genesis, transitions: full.transitions.slice(0, 1) });
    const p2 = wire({ genesis: full.genesis, transitions: full.transitions.slice(0, 2) });
    let reads = 0;
    let posts = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (new URL(String(input)).pathname !== "/api/account/ledger") return server.fetch(input, init);
      if (method === "GET") {
        reads += 1;
        const turn = reads % 4;
        return json({ ledger: turn === 0 || turn === 2 ? full : turn === 1 ? p1 : p2 });
      }
      posts += 1;
      await new Promise(resolve => setTimeout(resolve, 10_000));
      return json({ error: "head_changed", ledger: posts % 2 ? p1 : p2 }, 409);
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { fetchImpl, random: () => 0 } });
    const bridge = await testBridge(accountId, "q");
    fakeTime();
    await page.client.load();
    const t0 = Date.now();
    let prompted = -1;
    let settled = -1;
    authenticator.beforeSign = async () => { if (prompted < 0) prompted = Date.now() - t0; };
    for (let at = 0; at < 120_000; at += 2_000) {
      void page.client.noteHead("z".repeat(43), 1);
      if (at === 20_000) void page.client.append({ type: "add_bridge", bridge }).then(() => { settled = Date.now() - t0; }, () => { settled = Date.now() - t0; });
      await vi.advanceTimersByTimeAsync(2_000);
      await settle();
    }
    // At most one running re-offer (a fresh read and at most two 10 s POSTs) ahead of it.
    expect(prompted).toBeGreaterThanOrEqual(20_000);
    expect(prompted).toBeLessThanOrEqual(20_000 + 25_000);
    expect(settled).toBeGreaterThan(prompted);
    expect(settled).toBeLessThanOrEqual(prompted + 15_000);
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
