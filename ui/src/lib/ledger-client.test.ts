import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import {
  accountIdOf, applyRevocations, authorityConsentChallenge, chooseLedger, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, ledgerRevocations, nextTransition,
  resolutionPlan, resolveForkTransition, verifyLedger,
} from "@security/ledger/ledger";
import { confirmPairedLedger, createBridgePairRequest, encodePairLink, openPairApproval, PAIR_FRAGMENT_PREFIX, pairComparisonCode } from "@security/ledger/pairing";
import { generateAuthKey, parseAuthProof, verifyAuthProof } from "@security/ledger/proof";
import type { Ledger, LedgerBridge, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, PasskeySignature, Signed } from "@security/ledger/protocol";
import { LEDGER_LIMITS } from "@security/ledger/protocol";
import { createSoftPasskey } from "@security/ledger/testing";
import type { SoftPasskey } from "@security/ledger/testing";
import type { EndpointIdentity } from "@security/protocol";
import { LedgerClient, sanitizeLabel } from "./ledger-client";
import type { AttemptStorage, LedgerClientDeps } from "./ledger-client";
import { LedgerReplica, memoryReplicaStorage } from "./ledger-replica";
import type { LedgerReplicaStorage, ReplicaRecord } from "./ledger-replica";
import type * as PasskeyModule from "./passkey";

/*
 * Deterministic time. Timers and Date are fake (fakeTime()); the real asynchronous work (WebCrypto, which completes off the main
 * thread) is not. Every WebCrypto call and every harness delay is tracked in `pending`: quiet() returns once none is pending and the
 * microtask queue is drained, so the client and the fake server have finished reacting. advance(ms) fires the due timers one at a
 * time, in order, waiting for quiet() after each, so an event happens at the fake instant its timer fired whatever the machine's
 * speed, and the fake clock never moves while real work is still running. Nothing waits a guessed number of ticks.
 * Slow mode re-runs everything with every WebCrypto result and every fake-server answer delayed by real milliseconds:
 *   LEDGER_TEST_SLOW=1 npx vitest run src/lib/ledger-client.test.ts      (15 ms; LEDGER_TEST_SLOW=<n> for n ms)
 */
const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;
const SLOW_MS = ((value: string | undefined): number => {
  const ms = Number(value);
  return value === undefined || !Number.isFinite(ms) || ms <= 0 ? 0 : ms === 1 ? 15 : ms;
})(process.env.LEDGER_TEST_SLOW);
if (SLOW_MS > 0) vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const pending = new Set<Promise<unknown>>();
function track<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  const done = (): void => { pending.delete(work); };
  work.then(done, done);
  return work;
}
const realDelay = (ms: number): Promise<void> => new Promise(resolve => { realSetTimeout(resolve, ms); });
const SUBTLE = ["decrypt", "deriveBits", "deriveKey", "digest", "encrypt", "exportKey", "generateKey", "importKey", "sign", "unwrapKey", "verify", "wrapKey"] as const;
/** Every WebCrypto call is tracked (and, in slow mode, answered late). */
function instrumentCrypto(): void {
  const subtle = globalThis.crypto.subtle;
  for (const name of SUBTLE) {
    const original = (subtle[name] as unknown as (...args: unknown[]) => Promise<unknown>).bind(subtle);
    vi.spyOn(subtle, name).mockImplementation(((...args: unknown[]) => track((async () => {
      const result = await original(...args);
      if (SLOW_MS > 0) await realDelay(SLOW_MS);
      return result;
    })())) as never);
  }
}
let testToken = 0;
/** Until no tracked real work is pending and an event-loop turn found the system idle (microtasks drained). */
async function quiet(): Promise<void> {
  const token = testToken;
  while (token === testToken) {
    await new Promise(resolve => { realSetImmediate(resolve); });
    if (token !== testToken) return;
    if (pending.size > 0) {
      await Promise.allSettled([...pending]);
    } else {
      return;
    }
  }
}
/** Moves the fake clock forward by `ms`: each due timer fires at its own instant, and the system is quiet before the clock moves on. */
async function advance(ms: number): Promise<void> {
  const token = testToken;
  await quiet();
  if (token !== testToken) return;
  let reached = false;
  setTimeout(() => { reached = true; }, ms);
  while (!reached && token === testToken) {
    vi.advanceTimersToNextTimer();
    await quiet();
  }
}

const ORIGIN = "https://ftown.example";
const RP_ID = "ftown.example";
const b64url = (data: Uint8Array): string => Buffer.from(data).toString("base64url");
const responseOf = (body: string | null, status = 200, headers: Record<string, string> = {}): Response => {
  const map = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: map,
    text: async () => body ?? "",
    json: async () => (body ? JSON.parse(body) : null),
  } as unknown as Response;
};
const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  responseOf(JSON.stringify(value), status, { "Content-Type": "application/json", ...headers });
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const char = (code: number): string => String.fromCharCode(code);

/** Requests that broke a client invariant (checked after every test): see FakeServer.fetch. */
const violations: string[] = [];
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
  /** Every request, stamped with the fake clock at the instant the client called fetch. */
  log: { at: number; method: string; path: string; body: unknown }[] = [];
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
    this.log.push({ at: Date.now(), method, path: url.pathname, body });
    if (SLOW_MS > 0) await track(realDelay(SLOW_MS));
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
      // Invariant: a chain of an account the server holds is never POSTed without expectHead (it could re-create a deleted account).
      try {
        const id = await accountIdOf((post.ledger as Ledger).genesis.payload);
        if (this.ledgers.has(id) && typeof post.expectHead !== "string") violations.push(`POST of account ${id.slice(0, 8)} without expectHead`);
      } catch {
        // Not a chain: the store refuses it.
      }
      const hooked = this.postHook === null ? null : await this.postHook(post.ledger as Ledger);
      return hooked ?? this.offer(post.ledger, typeof post.expectHead === "string" ? post.expectHead : undefined);
    }
    const pair = /^\/api\/pair\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (pair && method === "PUT") {
      if (!this.sessions.length) return json({ error: "unauthorized" }, 401);
      this.mailbox.set(pair[1], (body as { sealed: string }).sealed);
      return responseOf(null, 204);
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
    // The server is a replica like any other: the one acceptance rule, nothing rewritten.
    const choice = await chooseLedger(stored, candidate as Ledger);
    if (choice.decision === "reject") return json({ error: "ledger_rejected", ledger: stored }, 409);
    if (choice.decision === "keep" && choice.relation === "diverged") return json({ error: "diverged", ledger: stored }, 409);
    if (choice.decision === "adopt") {
      const revoked = ledgerRevocations(candidate as Ledger);
      const before = this.stickies.get(accountId) ?? { deviceIds: [], bridgeIds: [] };
      this.stickies.set(accountId, {
        deviceIds: [...new Set([...before.deviceIds, ...revoked.deviceIds, ...choice.discarded.deviceIds])],
        bridgeIds: [...new Set([...before.bridgeIds, ...revoked.bridgeIds, ...choice.discarded.bridgeIds])],
      });
      this.ledgers.set(accountId, wire(candidate as Ledger));
    }
    return json({ decision: choice.decision, ledger: this.ledgers.get(accountId), discarded: choice.discarded.records.length });
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
    // No jitter unless a test pins it: every backoff instant is exact.
    random: () => 0.5,
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
/**
 * Sticky-only revocations now exist only in replicas of older code (a lost fork); nothing creates new ones. `a`'s stored record gets
 * `ids` in its sticky set (the chain still lists them, or never did), and the page reloads: returns the reloaded page.
 */
async function stickyRevoke(server: FakeServer, authenticator: FakeAuthenticator, a: Browser, accountId: string, ids: { deviceIds?: string[]; bridgeIds?: string[] }): Promise<Browser> {
  a.client.dispose();
  const stored = await a.storage.read(accountId) as ReplicaRecord;
  const sticky = { deviceIds: [...stored.sticky.deviceIds, ...(ids.deviceIds ?? [])], bridgeIds: [...stored.sticky.bridgeIds, ...(ids.bridgeIds ?? [])] };
  expect(await a.storage.commit({ ...stored, version: 1 as unknown as 2, serial: stored.serial + 1, sticky }, stored.serial)).toBe(true);
  const page = await browser(server, authenticator, { storage: a.storage, identity: a });
  await page.client.load();
  return page;
}
/** `chosen` + the operations the plan carries from `other` + the owner's resolve_fork discarding `other`, signed with the first passkey. */
async function resolving(chosen: Ledger, other: Ledger, authenticator: FakeAuthenticator): Promise<Ledger> {
  let chain = chosen;
  for (const operation of (await resolutionPlan(chosen, other)).carry) chain = await signed(chain, authenticator, operation);
  const key = authenticator.keys[0].soft;
  const payload = await resolveForkTransition(chain, other, key.credentialId, Date.now());
  return { genesis: chain.genesis, transitions: [...chain.transitions, { payload, signature: await key.sign(await ledgerChallenge(payload)) }] };
}
/** What the owner was shown of the divergence: resolveDivergence resolves exactly that or nothing. */
function shown(b: Browser): { source: "server" | "relay" | "peer"; otherHead: string } {
  const divergence = b.client.snapshot().divergence;
  if (!divergence) throw new Error("no divergence shown");
  return { source: divergence.source, otherHead: divergence.otherHead };
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
const rateLimited = (seconds?: number): Response => json({ error: "rate_limited" }, 429, seconds === undefined ? {} : { "Retry-After": String(seconds) });
const ledgerGets = (server: FakeServer): number => server.requests.filter(item => item === "GET /api/account/ledger").length;
/**
 * Fake clock for setTimeout and Date only (WebCrypto and setImmediate stay real; see advance() and quiet()). It starts on a whole
 * second, after everything signed so far, so an HTTP-date Retry-After (whole seconds) is exact. Returns that start.
 */
function fakeTime(): number {
  const start = (Math.floor(Date.now() / 1000) + 1) * 1000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: start });
  return start;
}
/** The fake-clock instants at which the client called POST /api/account/ledger, from `since` on, relative to `origin`. */
const postsAt = (server: FakeServer, origin: number, since = 0): number[] => server.log
  .filter(item => item.method === "POST" && item.path === "/api/account/ledger" && item.at >= since).map(item => item.at - origin);
/** An account whose bridge was added and then revoked: revision 3, the revocation last. */
async function revokedBridge(): Promise<{ server: FakeServer; authenticator: FakeAuthenticator; a: Browser; accountId: string; full: Ledger }> {
  const { server, authenticator, a, accountId } = await owner();
  await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "studio") });
  await a.client.revokeBridge("studio");
  return { server, authenticator, a, accountId, full: current(server) };
}

beforeEach(() => {
  testToken += 1;
  instrumentCrypto();
});
afterEach(() => {
  testToken += 1;
  expect(violations.splice(0)).toEqual([]);
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

  it("reports rate_limited (not done) for a 429 on an existing account's write and keeps the signed record pending, not in the chain", async () => {
    const server = new FakeServer();
    const authenticator = new FakeAuthenticator();
    let limited = false;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (limited && init?.method === "POST" && new URL(String(input)).pathname === "/api/account/ledger") return json({ error: "rate_limited" }, 429);
      return server.fetch(input, init);
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await browser(server, authenticator, { deps: { fetchImpl } });
    await a.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: "owner" });
    const accountId = a.client.snapshot().checkpoint?.accountId ?? "";
    limited = true;
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") })).rejects.toThrow("rate_limited");
    // Pending: neither in the local chain nor on the server.
    expect(a.replica.raw()?.ledger.transitions).toHaveLength(1);
    expect(server.ledger?.transitions).toHaveLength(1);
    expect(a.client.snapshot().pendingWrite).toMatchObject({ operation: "add_bridge", bridgeId: "b1" });
    limited = false;
    // One change at a time: the next one waits for this one.
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b2") })).rejects.toThrow("write_pending");
    await a.client.retryNow();
    expect(server.ledger?.transitions).toHaveLength(2);
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b2") });
    expect(server.ledger?.transitions).toHaveLength(3);
    expect(authenticator.names()).toEqual(["create", "sign", "sign", "sign", "sign"]);
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
    expect(await a.replica.offer(foreign)).toEqual({ decision: "reject", relation: null, discarded: [], covered: false });

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

  it("uses the sticky set for membership: a device revoked only on this browser (older replica) neither signs in nor re-enrolls", async () => {
    const { server, authenticator, a: first, accountId } = await owner();
    const laptop = (await first.endpoint(accountId)).endpoint.id;
    const a = await stickyRevoke(server, authenticator, first, accountId, { deviceIds: [laptop] });
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

  it("a revocation the server answers 200 without: ledger_not_stored, kept pending (enforced here, not in the chain), and sent again", async () => {
    const { server, a, accountId } = await owner();
    const studio = await testBridge(accountId, "studio");
    await a.client.append({ type: "add_bridge", bridge: studio });
    const original = server.offer;
    server.offer = async () => json({ decision: "keep", ledger: server.ledger, discarded: 0 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(a.client.revokeBridge("studio")).rejects.toThrow("ledger_not_stored");
    // Not in the chain before the server holds it, but enforced here at once (the local block): the computer is no longer trusted.
    expect(() => a.client.assertBridgeAccess("studio", studio.endpoint.id)).toThrow("account_bridge_revoked");
    expect(a.replica.raw()?.checkpoint.revokedBridgeIds).toEqual([]);
    expect(a.client.snapshot()).toMatchObject({
      pendingWrite: { operation: "revoke_bridge", bridgeId: "studio" }, unsaved: { deviceIds: [], bridgeIds: ["studio"] }, discarded: [],
      blocked: { deviceIds: [], bridgeIds: ["studio"] }, localOnly: { deviceIds: [], bridgeIds: [] },
    });
    expect(a.client.snapshot().checkpoint?.bridges).toEqual([]);
    server.offer = original;
    await a.client.retryNow();
    expect((await verifyLedger(current(server))).revokedBridgeIds).toEqual(["studio"]);
    expect(() => a.client.assertBridgeAccess("studio", studio.endpoint.id)).toThrow("account_bridge_revoked");
    // In the chain now: the local block is lifted (the chain enforces it).
    expect(a.client.snapshot()).toMatchObject({ pendingWrite: null, unsaved: { deviceIds: [], bridgeIds: [] }, blocked: { deviceIds: [], bridgeIds: [] } });
  });

  it("a write answered with a longer chain that lacks it: write_conflict, the chain adopted, the record kept only to sign again", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const base = current(server);
    const fork = await addDevices(base, authenticator, accountId, 2);
    const original = server.offer;
    server.offer = async () => {
      await original(fork);
      return json({ decision: "keep", ledger: server.ledger, discarded: 0 });
    };
    const laptop = (await a.endpoint(accountId)).endpoint.id;
    await expect(a.client.revokeDevice(laptop)).rejects.toThrow("write_conflict");
    const discarded = a.client.snapshot().discarded;
    expect(discarded).toHaveLength(1);
    expect(discarded[0].payload.operation.type).toBe("revoke_device");
    expect(a.replica.raw()?.checkpoint.head).toBe((await verifyLedger(fork)).head);
    // In no chain; enforced on this browser only (its own removal: removed here) until the owner dismisses the dropped record.
    expect(a.client.snapshot()).toMatchObject({
      status: "device_revoked", pendingWrite: null, lastConflict: { operation: "revoke_device", deviceId: laptop, reason: "write_conflict" },
      blocked: { deviceIds: [laptop], bridgeIds: [] }, localOnly: { deviceIds: [], bridgeIds: [] },
    });
    expect(a.replica.sticky()).toEqual({ deviceIds: [], bridgeIds: [] });
    expect(a.client.snapshot().canReoffer).toBe(true);
    // Never signed again by itself.
    expect(authenticator.names()).toEqual(["create", "sign", "sign", "sign"]);
    await a.client.dismissDiscarded(discarded);
    expect(a.client.snapshot()).toMatchObject({ status: "ready", blocked: { deviceIds: [], bridgeIds: [] }, discarded: [] });
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
    const { server, authenticator, a: first, accountId } = await owner();
    const a = await stickyRevoke(server, authenticator, first, accountId, { bridgeIds: ["studio"] });
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
  it("a LONGER valid different history on the server is never adopted: local byte-identical, divergence published, nothing sent", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const base = current(server);
    await a.client.append({ type: "add_device", device: await testDevice(accountId) });
    const local = JSON.stringify(a.replica.raw());
    // A rolled-back server that a browser without history then wrote to, twice.
    const fork = await addDevices(base, authenticator, accountId, 2);
    server.ledgers.set(accountId, wire(fork));
    const posts = server.posts.length;
    authenticator.calls = [];
    await a.client.refresh({ force: true });
    expect(JSON.stringify(a.replica.raw())).toBe(local);
    const divergence = a.client.snapshot().divergence;
    expect(divergence).toMatchObject({ source: "server", other: fork, fork: { relation: "diverged", fork: { revision: 1 } },
      mine: { carry: [], canKeep: true, reason: null }, theirs: { carry: [], canKeep: true, reason: null } });
    expect(divergence?.fork.mine).toHaveLength(1);
    expect(divergence?.fork.theirs).toHaveLength(2);
    expect(a.client.snapshot()).toMatchObject({ status: "ready", serverState: "unknown", discarded: [], retryAt: null });
    // Writes are refused before any prompt; reads and relay hints send nothing.
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") })).rejects.toThrow("ledger_diverged");
    await a.client.noteHead("q".repeat(43), 9);
    await a.client.retryNow();
    expect(server.posts).toHaveLength(posts);
    expect(authenticator.calls).toEqual([]);
    expect(current(server)).toEqual(fork);
    // Persisted: a reload still holds both histories.
    const reloaded = await browser(server, authenticator, { storage: a.storage, identity: a });
    await reloaded.client.load();
    expect(reloaded.client.snapshot().divergence?.other).toEqual(fork);
  });

  it("keeps a revocation seen only on this browser (older replica): assertBridgeAccess uses the sticky set", async () => {
    const { server, authenticator, a: first, accountId } = await owner();
    const studio = await testBridge(accountId, "studio");
    await first.client.append({ type: "add_bridge", bridge: studio });
    expect(() => first.client.assertBridgeAccess("studio", studio.endpoint.id)).not.toThrow();
    const a = await stickyRevoke(server, authenticator, first, accountId, { bridgeIds: ["studio"] });
    expect(a.replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(["studio"]);
    expect(() => a.client.assertBridgeAccess("studio", studio.endpoint.id)).toThrow("account_bridge_revoked");
    expect(a.client.snapshot().checkpoint?.bridges).toEqual([]);
    expect(a.client.snapshot().localOnly).toEqual({ deviceIds: [], bridgeIds: ["studio"] });
  });

  it("forget() keeps the account's sticky revocations for the next sign-in", async () => {
    const { server, authenticator, a: first, accountId } = await owner();
    const studio = await testBridge(accountId, "studio");
    await first.client.append({ type: "add_bridge", bridge: studio });
    const a = await stickyRevoke(server, authenticator, first, accountId, { bridgeIds: ["studio"] });
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

describe("LedgerClient dropped changes and discarded records", () => {
  it("a removal overtaken by another change persists as discarded, stays enforced here (blocked, not in the chain), and can be signed again", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const studio = await testBridge(accountId, "studio");
    await a.client.append({ type: "add_bridge", bridge: studio });
    const fork = await addDevices(current(server), authenticator, accountId, 2);
    const original = server.offer;
    server.offer = async () => {
      await original(fork);
      return json({ decision: "keep", ledger: server.ledger, discarded: 0 });
    };
    await expect(a.client.revokeBridge("studio")).rejects.toThrow("write_conflict");
    server.offer = original;
    const lost = a.client.snapshot();
    expect(lost.localOnly).toEqual({ deviceIds: [], bridgeIds: [] });
    expect(lost.discarded.map(item => item.payload.operation)).toEqual([{ type: "revoke_bridge", bridgeId: "studio" }]);
    expect(a.replica.raw()?.checkpoint.head).toBe(await headOf(fork));
    expect(a.replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(["studio"]);
    expect(() => a.client.assertBridgeAccess("studio", studio.endpoint.id)).toThrow("account_bridge_revoked");
    expect(lost.blocked).toEqual({ deviceIds: [], bridgeIds: ["studio"] });

    // Persisted: a reloaded page still lists it and still enforces it.
    const reloaded = await browser(server, authenticator, { storage: a.storage });
    await reloaded.client.load();
    expect(reloaded.client.snapshot().discarded).toEqual(lost.discarded);
    expect(() => reloaded.client.assertBridgeAccess("studio", studio.endpoint.id)).toThrow("account_bridge_revoked");
    reloaded.client.dispose();

    // Confirmed again on the new head; its discarded entry then disappears (its effect is in the chain).
    await a.client.revokeBridge("studio");
    expect(a.client.snapshot().discarded).toEqual([]);
    expect(a.client.snapshot().lastConflict).toBeNull();
    expect((await verifyLedger(current(server))).revokedBridgeIds).toEqual(["studio"]);
    await expect(a.client.revokeBridge("studio")).rejects.toThrow("bridge_not_found");
    await expect(a.client.revokeDevice("x".repeat(43))).rejects.toThrow("device_not_found");
  });

  it("an own record overtaken by a chain pushed while the prompt was open is never sent: write_conflict, kept as discarded", async () => {
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
    await expect(a.client.revokeDevice(other.endpoint.id)).rejects.toThrow("write_conflict");
    expect(server.posts).toHaveLength(posts);
    expect(a.client.snapshot().discarded.map(item => item.payload.operation)).toEqual([{ type: "revoke_device", endpointId: other.endpoint.id }]);
    expect(a.client.snapshot()).toMatchObject({ localOnly: { deviceIds: [], bridgeIds: [] }, pendingWrite: null, lastConflict: { deviceId: other.endpoint.id, reason: "write_conflict" } });
    await a.client.dismissDiscarded();
    expect(a.client.snapshot()).toMatchObject({ discarded: [], lastConflict: null });
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
    fakeTime();
    return { c, local, gets: () => ledgerGets(server), posts: () => server.posts.length - before };
  }

  it("reads at once when idle, and defers a notice inside the window to one trailing read at the window's end", async () => {
    const { c, local, gets } = await paced();
    await c.client.noteHead("y".repeat(43), local.revision + 1);
    expect(gets()).toBe(1);
    const deferred = c.client.noteHead("z".repeat(43), local.revision + 2);
    await advance(1_999);
    expect(gets()).toBe(1);
    await advance(1);
    await deferred;
    expect(gets()).toBe(2);
    // refresh() is paced the same way: deferred, not dropped.
    const later = c.client.refresh();
    expect(gets()).toBe(2);
    await advance(2_000);
    await later;
    expect(gets()).toBe(3);
    await advance(10_000);
    expect(gets()).toBe(3);
  });

  it("a burst of 50 notices costs at most 2 reads, the last one after the burst", async () => {
    const { c, local, gets } = await paced();
    const notices = Array.from({ length: 50 }, (_, index) => c.client.noteHead(`n${index}`.padEnd(43, "x"), local.revision + 1 + index));
    await advance(2_000);
    await Promise.all(notices);
    expect(gets()).toBe(2);
    await advance(10_000);
    expect(gets()).toBe(2);
  });

  it("ignores the same head, reads (paced) on a lower revision, and force skips the spacing but joins a read in flight", async () => {
    const { c, local, gets, posts } = await paced();
    await c.client.noteHead(local.head, local.revision);
    await c.client.offer({ type: "ledger_head", head: local.head, revision: local.revision });
    await advance(5_000);
    expect(gets()).toBe(0);
    // A lower revision may mean a server behind this chain: a read tells (this server is not behind, so nothing is sent).
    await c.client.noteHead("x".repeat(43), local.revision - 1);
    expect(gets()).toBe(1);
    const lower = c.client.offer({ type: "ledger_head", head: "x".repeat(43), revision: local.revision - 1 });
    await advance(1_999);
    expect(gets()).toBe(1);
    await advance(1);
    await lower;
    expect(gets()).toBe(2);
    await advance(5_000);
    await c.client.noteHead("y".repeat(43), local.revision);
    expect(gets()).toBe(3);
    await Promise.all([c.client.refresh({ force: true }), c.client.refresh({ force: true })]);
    expect(gets()).toBe(4);
    const pushed = c.client.offer({ type: "ledger_head", head: "y".repeat(43), revision: local.revision + 5 });
    await advance(1_000);
    expect(gets()).toBe(4);
    await advance(1_000);
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
    fakeTime();
    authenticator.calls = [];
    // Every bound POST, a user write's included, names the server head it just read.
    expect(Object.keys(server.posts[posts - 1]).sort()).toEqual(["expectHead", "ledger"]);
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
    await advance(2_000);
    await a.client.offer({ type: "ledger", ledger: old });
    // offer() only starts the read; once quiet, that read and the re-offer it caused are done.
    await quiet();
    expect(await headOf(current(server))).toBe(await headOf(full));
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
    await advance(2_000);
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
    fakeTime();
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
  ] as const)("sends a revocation refused with 429 and Retry-After %s again exactly at the later of it and the backoff floor, without a prompt", async (label, due) => {
    const { server, authenticator, page, phone } = await withPhone();
    const start = fakeTime();
    // The backoff floor with the jitter pinned to -20%: 0.8 × 30 s = 24 s. The fake clock starts on a whole second: dates are exact.
    const header = label === "5 (s)" ? "5" : label === "0" ? "0"
      : new Date(start + (label.includes("past") ? -60_000 : 120_000)).toUTCString();
    let refusals = 1;
    server.postHook = () => (refusals-- > 0 ? json({ error: "rate_limited" }, 429, { "Retry-After": header }) : null);
    const posts = server.posts.length;
    authenticator.calls = [];
    await expect(page.client.revokeDevice(phone)).rejects.toThrow("rate_limited");
    expect(authenticator.names()).toEqual(["sign"]);
    expect(server.posts).toHaveLength(posts + 1);
    expect(current(server).transitions).toHaveLength(2);
    // Not in the chain until the server takes it: pending, shown as a removal the server does not have yet.
    expect(page.replica.raw()?.checkpoint.revokedDeviceIds).toEqual([]);
    expect(page.client.snapshot().localOnly).toEqual({ deviceIds: [], bridgeIds: [] });
    expect(page.client.snapshot().unsaved).toEqual({ deviceIds: [phone], bridgeIds: [] });
    expect(page.client.snapshot().pendingWrite).toMatchObject({ operation: "revoke_device", deviceId: phone });
    expect(postsAt(server, start, start)).toEqual([0]);
    await advance(due - 1);
    expect(postsAt(server, start, start)).toEqual([0]);
    await advance(1);
    expect(postsAt(server, start, start)).toEqual([0, due]);
    expect((await verifyLedger(current(server))).revokedDeviceIds).toEqual([phone]);
    expect(page.replica.raw()?.checkpoint.revokedDeviceIds).toEqual([phone]);
    await page.client.refresh({ force: true });
    expect(server.posts).toHaveLength(posts + 2);
    expect(server.posts[posts + 1].ledger).toEqual(page.replica.raw()?.ledger);
    expect(page.client.snapshot()).toMatchObject({ pendingWrite: null, unsaved: { deviceIds: [], bridgeIds: [] } });
    await advance(3_600_000);
    expect(server.posts).toHaveLength(posts + 2);
    expect(authenticator.names()).toEqual(["sign"]);
  });

  it("unsaved lists a pending revocation (persisted for every page of the profile); retryNow() sends it once, without a prompt", async () => {
    const { server, authenticator, a, page, phone } = await withPhone();
    let refuse = true;
    // No Retry-After: retryNow() may skip the backoff (a Retry-After it would honour, see S5).
    server.postHook = () => (refuse ? rateLimited() : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(page.client.revokeDevice(phone)).rejects.toThrow("rate_limited");
    // The server still holds the local chain: it is current; the revocation is the pending write.
    expect(page.client.snapshot()).toMatchObject({ serverState: "current", unsaved: { deviceIds: [phone], bridgeIds: [] }, canReoffer: true });
    expect(page.client.snapshot().retryAt).toBe(Date.now() + 24_000);
    expect(page.client.snapshot().retryNotBefore).toBeNull();
    // Another page of the profile, before any read: the pending write is persisted with the chain (its own first read is held back here).
    const other = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0, fetchImpl: (async () => new Promise<Response>(() => undefined)) as typeof fetch } });
    await other.client.load();
    expect(other.replica.raw()?.checkpoint.revokedDeviceIds).toEqual([]);
    expect(other.client.snapshot()).toMatchObject({ pendingWrite: { operation: "revoke_device", deviceId: phone }, unsaved: { deviceIds: [phone], bridgeIds: [] } });
    // Another profile with the same chain: no pending write there, nothing unsaved.
    const unread = await browser(server, authenticator, { storage: memoryReplicaStorage(), identity: a });
    const chain = page.replica.raw()?.ledger;
    expect((await unread.replica.offer(chain, { bind: true, expectAccountId: (await verifyLedger(current(server))).accountId })).decision).toBe("adopt");
    await unread.client.load();
    expect(unread.client.snapshot()).toMatchObject({ serverState: "unknown", pendingWrite: null, unsaved: { deviceIds: [], bridgeIds: [] }, retryAt: null });
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
    server.postHook = () => rateLimited(5);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Jitter pinned to its lowest (-20%): the tightest schedule the client can produce.
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0 } });
    authenticator.calls = [];
    const start = fakeTime();
    await page.client.refresh({ force: true });
    expect(postsAt(server, start, start)).toEqual([0]);
    await advance(3_600_000);
    // The n-th failure waits max(Retry-After 5 s, 0.8 × min(30 s × 2^(n-1), 10 min)), and never less than the 30 s pair window:
    // 30 (24, then the window), +48, +96, +192, +384, then +480 (the 10 min cap) up to the hour.
    expect(postsAt(server, start, start)).toEqual([0, 30_000, 78_000, 174_000, 366_000, 750_000, 1_230_000, 1_710_000, 2_190_000, 2_670_000, 3_150_000]);
    // One warning per backoff step: 30 s, 1, 2, 4, 8, 10 min.
    expect(warn).toHaveBeenCalledTimes(6);
    page.client.dispose();
    await page.client.refresh({ force: true });
    await advance(3_600_000);
    expect(postsAt(server, start, start)).toHaveLength(11);
    expect(authenticator.calls).toEqual([]);
  });

  it("sends the same (local, server) head pair at most once per 30 s, however many reads see it", async () => {
    const { server, authenticator, a, accountId } = await revokedBridge();
    rollBack(server, accountId, 2);
    // A server that keeps failing on the network: the first backoff (24 s with the jitter pinned low) is shorter than the window.
    server.postHook = () => Promise.reject(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0 } });
    authenticator.calls = [];
    const start = fakeTime();
    for (let index = 0; index < 20; index += 1) {
      await page.client.refresh({ force: true });
      await advance(1_000);
    }
    expect(postsAt(server, start, start)).toEqual([0]);
    await advance(15_000);
    expect(postsAt(server, start, start)).toEqual([0, 30_000]);
    expect(page.replica.raw()?.checkpoint.revision).toBe(3);
    expect(authenticator.calls).toEqual([]);
  });

  it("backs off after a refusal that carried the server's chain while the server stays behind, and stops once it holds the chain", async () => {
    const { server, authenticator, a, accountId, full } = await revokedBridge();
    rollBack(server, accountId, 2);
    let refusing = true;
    // This server refuses the chain and answers with its own (shorter) one.
    server.postHook = () => (refusing ? json({ error: "ledger_rejected", ledger: server.ledgerOf(accountId) }, 409) : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { random: () => 0 } });
    authenticator.calls = [];
    const start = fakeTime();
    await page.client.refresh({ force: true });
    await advance(600_000);
    // 0, 30 s (24 s, then the pair window), +48, +96, +192 s.
    expect(postsAt(server, start, start)).toEqual([0, 30_000, 78_000, 174_000, 366_000]);
    refusing = false;
    // The next try (+384 s, at 750 s) is taken.
    await advance(1_200_000);
    expect(postsAt(server, start, start)).toEqual([0, 30_000, 78_000, 174_000, 366_000, 750_000]);
    expect(await headOf(current(server))).toBe(await headOf(full));
    await advance(3_600_000);
    expect(postsAt(server, start, start)).toHaveLength(6);
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
    authenticator.calls = [];
    const start = fakeTime();
    const token = testToken;
    for (let second = 0; second < 600 && token === testToken; second += 1) {
      void page.client.noteHead("z".repeat(43), 1);
      await advance(1_000);
    }
    // Refusing: exactly the backoff schedule (as in the test above), whatever the notices; holding the chain: nothing.
    expect(postsAt(server, start, start)).toEqual(refusing ? [0, 30_000, 78_000, 174_000, 366_000] : []);
    expect(authenticator.calls).toEqual([]);
  });

  it("a user write answered with a refusal is not sent straight back by the re-offer that answer queued", async () => {
    const { server, authenticator, a, accountId } = await owner();
    server.postHook = () => json({ error: "ledger_rejected", ledger: server.ledgerOf(accountId) }, 409);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bridge = await testBridge(accountId, "b1");
    const start = fakeTime();
    await expect(a.client.append({ type: "add_bridge", bridge })).rejects.toThrow("ledger_rejected");
    const posts = server.posts.length;
    await advance(29_999);
    expect(postsAt(server, start, start)).toEqual([0]);
    // At the end of the pair window: one re-offer (fresh read, then the POST), refused again, so backing off from here.
    await advance(1);
    expect(postsAt(server, start, start)).toEqual([0, 30_000]);
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
  it("a diverged server chain is never adopted, whatever it holds (more removals, longer, or equal length), and nothing is sent", async () => {
    const { server, authenticator, a, accountId, local, base } = await twoBridges();
    const revoking = await signed(base, authenticator, { type: "revoke_bridge", bridgeId: "b1" });
    const longer = await addDevices(base, authenticator, accountId, 3);
    const twin = await signed(base, authenticator, { type: "add_bridge", bridge: await testBridge(accountId, "fork-1") });
    const posts = server.posts.length;
    fakeTime();
    authenticator.calls = [];
    for (const fork of [revoking, longer, twin]) {
      // A trusted device (a's keys) bound to the revision-3 chain, facing a server that holds a different history.
      const page = await browser(server, authenticator, { storage: memoryReplicaStorage(), identity: a });
      expect((await page.replica.offer(local, { bind: true, expectAccountId: accountId })).decision).toBe("adopt");
      server.ledgers.set(accountId, wire(fork));
      const seen = revisions(page);
      await page.client.refresh({ force: true });
      expect(page.client.snapshot()).toMatchObject({ status: "ready", divergence: { source: "server", other: fork } });
      expect(page.replica.raw()?.ledger).toEqual(local);
      expect(seen.every(revision => revision === 3)).toBe(true);
      expect(server.posts).toHaveLength(posts);
      expect(current(server)).toEqual(wire(fork));
      page.client.dispose();
    }
    expect(authenticator.calls).toEqual([]);
  });

  it("a re-offer answered 409 diverged enters the divergence state and sends nothing more", async () => {
    const { server, authenticator, a, accountId, local, base } = await twoBridges();
    const other = await signed(base, authenticator, { type: "revoke_bridge", bridgeId: "b1" });
    rollBack(server, accountId, 2);
    // The server's row changed after the re-offer's fresh read: another browser with no history wrote to the rolled-back row.
    server.postHook = () => { server.ledgers.set(accountId, wire(other)); return json({ error: "diverged", ledger: other }, 409); };
    const posts = server.posts.length;
    authenticator.calls = [];
    fakeTime();
    await a.client.refresh({ force: true });
    expect(server.posts).toHaveLength(posts + 1);
    expect(a.replica.raw()?.ledger).toEqual(local);
    expect(a.client.snapshot()).toMatchObject({ divergence: { source: "server", other }, retryAt: null });
    expect(a.client.snapshot().discarded).toEqual([]);
    await advance(3_600_000);
    expect(server.posts).toHaveLength(posts + 1);
    expect(authenticator.calls).toEqual([]);
  });

  it("sends nothing when the server holds the local chain", async () => {
    const { server, authenticator, a } = await revokedBridge();
    const posts = server.posts.length;
    fakeTime();
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
    fakeTime();
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

  it("never re-offers for a browser whose own removal is only in its sticky set (older replica): it cannot write", async () => {
    const { server, authenticator, accountId } = await owner();
    const first = await browser(server, authenticator);
    await first.client.signInNewDevice({ deviceLabel: "Phone" });
    const phone = (await first.endpoint(accountId)).endpoint.id;
    await first.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "x") });
    const b = await stickyRevoke(server, authenticator, first, accountId, { deviceIds: [phone] });
    // The server is rolled back: b's chain is ahead of it, but b's own keys are revoked by its sticky set only.
    rollBack(server, accountId, 2);
    fakeTime();
    const posts = server.posts.length;
    expect(await b.client.signInKnownDevice()).toBe(false);
    expect(b.replica.raw()?.checkpoint.revokedDeviceIds).toEqual([]);
    expect(b.client.snapshot()).toMatchObject({ status: "device_revoked", canReoffer: false, retryAt: null, serverState: "behind" });
    await b.client.retryNow();
    await advance(3_600_000);
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
    await advance(3_600_000);
    expect(other.posts).toHaveLength(1);
  });

  it("forget() and rotateDeviceIdentity() cancel a pending retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const leave of ["forget", "rotate"] as const) {
      const { server, a, accountId } = await revokedBridge();
      rollBack(server, accountId, 2);
      server.postHook = () => rateLimited(5);
      fakeTime();
      await a.client.refresh({ force: true });
      const posts = server.posts.length;
      if (leave === "forget") await a.client.forget(); else await a.client.rotateDeviceIdentity();
      await a.client.refresh({ force: true });
      await advance(3_600_000);
      expect(server.posts).toHaveLength(posts);
      vi.useRealTimers();
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
    fakeTime();
    authenticator.calls = [];
    const first = a.client.refresh({ force: true });
    await quiet();
    expect(server.posts).toHaveLength(posts + 1);
    // The trigger's read and the run's fresh read; a third read while that POST is still open sees the server still behind.
    expect(ledgerGets(server)).toBe(gets + 2);
    const second = a.client.signInKnownDevice();
    await quiet();
    expect(ledgerGets(server)).toBe(gets + 3);
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
    await advance(60_000);
    expect(server.requests).toEqual(["GET /api/account/ledger"]);
    await advance(3_600_000);
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
    await advance(3_600_000);
    expect(server.requests).toEqual([]);
    expect(server.ledgers.has(accountId)).toBe(false);
    expect(authenticator.calls).toEqual([]);
  });

  /** A phone whose own write was refused (Retry-After 120 s): its signed add_bridge is pending, its chain still the server's. */
  async function phonePending(): Promise<{ server: FakeServer; authenticator: FakeAuthenticator; a: Browser; b: Browser; accountId: string; phone: string; base: Ledger }> {
    const { server, authenticator, a, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    const phone = (await b.endpoint(accountId)).endpoint.id;
    const base = current(server);
    let refusals = 1;
    server.postHook = () => (refusals-- > 0 ? rateLimited(120) : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(b.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "x") })).rejects.toThrow("rate_limited");
    expect(b.replica.raw()?.ledger).toEqual(base);
    expect(b.client.snapshot().pendingWrite).toMatchObject({ operation: "add_bridge", bridgeId: "x" });
    return { server, authenticator, a, b, accountId, phone, base };
  }

  it("a phone revoked elsewhere while its own write was pending learns it at the fresh read: write_conflict, nothing sent", async () => {
    const { server, authenticator, a, b, phone } = await phonePending();
    await a.client.revokeDevice(phone);
    const revoked = current(server);
    const posts = server.posts.length;
    const signs = authenticator.names().length;
    await advance(150_000);
    expect(b.client.snapshot()).toMatchObject({ status: "device_revoked", pendingWrite: null, lastConflict: { operation: "add_bridge", bridgeId: "x", reason: "write_conflict" } });
    expect(server.posts).toHaveLength(posts);
    expect(current(server)).toEqual(revoked);
    // The phone holds the server's chain (its own revocation included); its record is in no chain, kept only to sign again.
    expect(b.replica.raw()?.ledger).toEqual(revoked);
    expect(b.client.snapshot().discarded.map(item => item.payload.operation.type)).toEqual(["add_bridge"]);
    expect(authenticator.names()).toHaveLength(signs);
  });

  it("a revocation landing between the fresh read and the POST: head_changed, the phone adopts it, drops its record and stops", async () => {
    const { server, authenticator, b, accountId, phone, base } = await phonePending();
    const revoking = await signed(base, authenticator, { type: "revoke_device", endpointId: phone });
    let gets = 0;
    server.afterGet = () => { gets += 1; if (gets === 1) server.ledgers.set(accountId, wire(revoking)); };
    const posts = server.posts.length;
    await advance(150_000);
    expect(b.client.snapshot()).toMatchObject({ status: "device_revoked", pendingWrite: null, lastConflict: { reason: "write_conflict" } });
    // One POST, against the head it read; refused, and not sent again.
    expect(server.posts).toHaveLength(posts + 1);
    expect(server.posts[posts]).toMatchObject({ expectHead: await headOf(base) });
    expect(current(server)).toEqual(wire(revoking));
    expect(b.replica.raw()?.ledger).toEqual(wire(revoking));
    await advance(3_600_000);
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
    await advance(29_000);
    hold = true;
    const late = page.client.refresh({ force: true });
    await quiet();
    expect(waiting).toBe(true);
    await advance(1_000);
    expect(await headOf(current(server))).toBe(await headOf(full));
    await quiet();
    expect(page.client.snapshot().unsaved).toEqual({ deviceIds: [], bridgeIds: [] });
    release();
    await late;
    expect(page.client.snapshot().unsaved).toEqual({ deviceIds: [], bridgeIds: [] });
    const gets = ledgerGets(server);
    const posts = server.posts.length;
    await advance(120_000);
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
    await quiet();
    expect(authenticator.names()).toContain("sign");
    const done = { refresh: false, noteHead: false, signIn: false };
    void a.client.refresh({ force: true }).then(() => { done.refresh = true; });
    void a.client.noteHead("q".repeat(43), 9).then(() => { done.noteHead = true; });
    void a.client.signInKnownDevice().then(() => { done.signIn = true; });
    await advance(2_000);
    expect(done).toEqual({ refresh: true, noteHead: true, signIn: true });
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
    await quiet();
    expect(server.posts).toHaveLength(posts + 1);
    await advance(14_000);
    expect(done).toBe(false);
    await advance(1_000);
    expect(done).toBe(true);
  });

  it("S2: a browser's own refused removal is enforced here at once (removed here, not in the chain) and is delivered without membership (not before Retry-After, retryNow included)", async () => {
    const { server, authenticator, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    const phone = (await b.endpoint(accountId)).endpoint.id;
    let refusals = 1;
    server.postHook = () => (refusals-- > 0 ? rateLimited(60) : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const start = fakeTime();
    await expect(b.client.revokeDevice(phone)).rejects.toThrow("rate_limited");
    // Not in the chain until the server accepts it, but enforced here at once: this browser is removed here (the removed-browser screen
    // says "Removing this browser…" from `unsaved`), and it may still re-offer (its block is local).
    expect(b.client.snapshot()).toMatchObject({
      status: "device_revoked", canReoffer: true, serverState: "current", pendingWrite: { operation: "revoke_device", deviceId: phone }, unsaved: { deviceIds: [phone], bridgeIds: [] },
      blocked: { deviceIds: [phone], bridgeIds: [] },
    });
    expect(b.replica.raw()?.checkpoint.devices.some(item => item.endpoint.id === phone)).toBe(true);
    expect(b.client.snapshot().checkpoint?.devices.some(item => item.endpoint.id === phone)).toBe(false);
    expect(await b.client.signInKnownDevice()).toBe(false);
    const posts = server.posts.length;
    authenticator.calls = [];
    await b.client.retryNow();
    expect(server.posts).toHaveLength(posts);
    // max(Retry-After 60 s, the 30 s floor without jitter).
    await advance(59_999);
    expect(postsAt(server, start, start)).toEqual([0]);
    expect(b.client.snapshot().status).toBe("device_revoked");
    await advance(1);
    expect(postsAt(server, start, start)).toEqual([0, 60_000]);
    // Accepted: removed in the chain now; the block is lifted.
    expect(b.client.snapshot()).toMatchObject({ status: "device_revoked", pendingWrite: null, blocked: { deviceIds: [], bridgeIds: [] } });
    expect((await verifyLedger(current(server))).revokedDeviceIds).toEqual([phone]);
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
    const token = testToken;
    for (let at = 0; at < 600_000 && token === testToken; at += 2_000) {
      void page.client.noteHead("z".repeat(43), 1);
      await advance(2_000);
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
    await advance(10_000);
    serveS2 = true;
    await page.client.refresh({ force: true });
    await advance(25_000);
    // Exactly at the end of the window for that head (the 24 s backoff alone would have sent it at 24 s).
    expect(sent.map(item => item.at - sent[0].at)).toEqual([0, 30_000]);
    expect(sent[1].head).toBe(await headOf(s1));
  });

  it("S4: after a reload with the server down, a removal the server never took is still pending and unsaved, then delivered without a prompt", async () => {
    const { server, authenticator, a, accountId } = await owner();
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "studio") });
    fakeTime();
    server.postHook = () => json({ error: "ledger_unavailable" }, 503);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(a.client.revokeBridge("studio")).rejects.toThrow("server_unavailable");
    expect(a.client.snapshot()).toMatchObject({ serverState: "current", pendingWrite: { operation: "revoke_bridge", bridgeId: "studio" }, unsaved: { deviceIds: [], bridgeIds: ["studio"] } });
    a.client.dispose();
    let up = false;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => (up ? server.fetch(input, init)
      : json({ error: "ledger_unavailable" }, 503))) as typeof fetch;
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { fetchImpl } });
    await page.client.load();
    expect(page.client.snapshot()).toMatchObject({ pendingWrite: { operation: "revoke_bridge", bridgeId: "studio" }, unsaved: { deviceIds: [], bridgeIds: ["studio"] } });
    await expect(page.client.refresh({ force: true })).rejects.toThrow("server_unavailable");
    expect(page.client.snapshot()).toMatchObject({ unsaved: { deviceIds: [], bridgeIds: ["studio"] } });
    expect((await verifyLedger(current(server))).revokedBridgeIds).toEqual([]);
    expect(page.replica.raw()?.checkpoint.revokedBridgeIds).toEqual([]);
    // The server comes back: the signed record (persisted, not re-signed) is delivered by the retry.
    server.postHook = null;
    up = true;
    authenticator.calls = [];
    await advance(600_000);
    expect((await verifyLedger(current(server))).revokedBridgeIds).toEqual(["studio"]);
    expect(page.client.snapshot()).toMatchObject({ pendingWrite: null, unsaved: { deviceIds: [], bridgeIds: [] }, serverState: "current" });
    expect(authenticator.calls).toEqual([]);
  });

  it("a profile with no confirmed server state is 'unknown' while reads fail, and 'current' after the first read, which persists", async () => {
    const { server, authenticator, a, accountId } = await revokedBridge();
    let down = true;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => (down
      ? json({ error: "ledger_unavailable" }, 503) : server.fetch(input, init))) as typeof fetch;
    const page = await browser(server, authenticator, { storage: memoryReplicaStorage(), identity: a, deps: { fetchImpl } });
    expect((await page.replica.offer(a.replica.raw()?.ledger, { bind: true, expectAccountId: accountId })).decision).toBe("adopt");
    fakeTime();
    await page.client.load();
    expect(page.client.snapshot()).toMatchObject({ serverState: "unknown", unsaved: { deviceIds: [], bridgeIds: [] }, retryAt: null });
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
    await advance(10_000);
    // A deadline, compared with the clock: reached now.
    expect(page.client.snapshot().retryNotBefore).toBe(Date.now());
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
      await advance(2_000);
    }
    // At most one running re-offer ahead of it: reads take no time, and it sends at most two POSTs of 10 s each.
    expect(prompted).toBeGreaterThanOrEqual(20_000);
    expect(prompted).toBeLessThanOrEqual(20_000 + 2 * 10_000);
    // The write's own POST: signed at once, answered by this server 10 s later (head_changed, so it is refused).
    expect(settled).toBe(prompted + 10_000);
  });
});

describe("LedgerClient server-sequenced writes", () => {
  it("a write is in the replica only after the server accepted it: the record is persisted (and shown) as pending during the POST", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const base = current(server);
    const seen: { head: string | undefined; pending: boolean; shown: unknown }[] = [];
    server.postHook = () => {
      seen.push({ head: a.replica.raw()?.checkpoint.head, pending: a.replica.pendingWrite() !== null, shown: a.client.snapshot().pendingWrite });
      return null;
    };
    authenticator.calls = [];
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") });
    expect(seen).toEqual([{ head: await headOf(base), pending: true, shown: expect.objectContaining({ operation: "add_bridge", bridgeId: "b1" }) }]);
    expect(a.replica.raw()?.ledger).toEqual(current(server));
    expect(current(server).transitions).toHaveLength(2);
    expect(server.posts.at(-1)).toMatchObject({ expectHead: await headOf(base) });
    expect(a.client.snapshot()).toMatchObject({ pendingWrite: null, unsaved: { deviceIds: [], bridgeIds: [] }, serverState: "current", lastConflict: null });
    expect(a.replica.pendingWrite()).toBeNull();
    expect(authenticator.names()).toEqual(["sign"]);
  });

  it("a write lost on the network: replica unchanged, pending persisted, delivered after a reload without a second passkey", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const base = current(server);
    let offline = true;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline && init?.method === "POST" && new URL(String(input)).pathname === "/api/account/ledger") throw new TypeError("offline");
      return server.fetch(input, init);
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { fetchImpl } });
    authenticator.calls = [];
    await expect(page.client.revokeDevice((await a.endpoint(accountId)).endpoint.id)).rejects.toThrow("network_unavailable");
    expect(page.replica.raw()?.ledger).toEqual(base);
    expect(current(server)).toEqual(base);
    expect(page.client.snapshot()).toMatchObject({ status: "ready", pendingWrite: { operation: "revoke_device" } });
    page.client.dispose();
    // A reload: the persisted record is sent by the first run (it reads the server first), with no prompt.
    offline = false;
    const reloaded = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { fetchImpl } });
    await reloaded.client.load();
    await quiet();
    expect((await verifyLedger(current(server))).revokedDeviceIds).toHaveLength(1);
    expect(reloaded.replica.raw()?.ledger).toEqual(current(server));
    expect(reloaded.client.snapshot().pendingWrite).toBeNull();
    expect(authenticator.names()).toEqual(["sign"]);
  });

  it("a write the server stored but whose answer was lost is found delivered at the next read, and not sent again", async () => {
    const { server, authenticator, a, accountId } = await owner();
    let lose = true;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await server.fetch(input, init);
      if (lose && init?.method === "POST" && new URL(String(input)).pathname === "/api/account/ledger") {
        lose = false;
        throw new TypeError("connection reset");
      }
      return response;
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { fetchImpl } });
    fakeTime();
    await expect(page.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") })).rejects.toThrow("network_unavailable");
    const posts = server.posts.length;
    await page.client.refresh({ force: true });
    expect(page.client.snapshot().pendingWrite).toBeNull();
    expect(page.replica.raw()?.ledger).toEqual(current(server));
    await advance(3_600_000);
    expect(server.posts).toHaveLength(posts);
    expect(authenticator.names().filter(name => name === "sign")).toHaveLength(3);
  });

  it("two browsers sign on the same head: the first is stored, the second gets write_conflict and its record is in no chain", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    await a.client.refresh({ force: true });
    const head = current(server);
    // a's prompt is open while b signs and stores its change.
    authenticator.beforeSign = async () => {
      authenticator.beforeSign = null;
      await b.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "from-b") });
    };
    authenticator.calls = [];
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "from-a") })).rejects.toThrow("write_conflict");
    const served = current(server);
    expect(served.transitions).toHaveLength(head.transitions.length + 1);
    expect(served.transitions.at(-1)?.payload.operation).toMatchObject({ type: "add_bridge", bridge: { bridgeId: "from-b" } });
    // a adopted the server's chain; its own record is in neither chain, only kept to sign again; nothing re-signed by itself.
    expect(a.replica.raw()?.ledger).toEqual(served);
    expect(JSON.stringify(served)).not.toContain("from-a");
    expect(a.client.snapshot()).toMatchObject({ pendingWrite: null, lastConflict: { operation: "add_bridge", bridgeId: "from-a", reason: "write_conflict" } });
    expect(a.client.snapshot().discarded.map(item => item.payload.operation.type)).toEqual(["add_bridge"]);
    expect(authenticator.names()).toEqual(["sign", "sign"]);
    // Confirmed again: one more prompt, on the new head.
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "from-a") });
    expect(current(server).transitions).toHaveLength(head.transitions.length + 2);
    expect(a.client.snapshot()).toMatchObject({ discarded: [], lastConflict: null });
  });

  it("a pending write whose head the server moved past is dropped as write_conflict at the retry; the replica becomes the server's chain", async () => {
    const { server, authenticator, a, accountId } = await owner();
    let refusals = 1;
    server.postHook = () => (refusals-- > 0 ? rateLimited(30) : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "mine") })).rejects.toThrow("rate_limited");
    // Another browser of the owner wrote meanwhile.
    await server.offer(await addDevices(current(server), authenticator, accountId, 1));
    const moved = current(server);
    const posts = server.posts.length;
    const signs = authenticator.names().length;
    await advance(60_000);
    expect(server.posts).toHaveLength(posts);
    expect(a.replica.raw()?.ledger).toEqual(moved);
    expect(a.client.snapshot()).toMatchObject({ pendingWrite: null, lastConflict: { bridgeId: "mine", reason: "write_conflict" }, retryAt: null });
    expect(authenticator.names()).toHaveLength(signs);
  });

  it("refuses a second change while one is pending (write_pending, before any prompt); a definitive refusal drops it to discarded", async () => {
    const { server, authenticator, a, accountId } = await owner();
    server.postHook = () => rateLimited(600);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") })).rejects.toThrow("rate_limited");
    authenticator.calls = [];
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b2") })).rejects.toThrow("write_pending");
    await expect(a.client.revokeDevice((await a.endpoint(accountId)).endpoint.id)).rejects.toThrow("write_pending");
    expect(authenticator.calls).toEqual([]);
    // The server refuses the record for good (too large): dropped, kept to sign again, writes open again.
    server.postHook = () => json({ error: "ledger_limit" }, 413);
    await advance(600_000);
    expect(a.client.snapshot()).toMatchObject({ pendingWrite: null, lastConflict: { bridgeId: "b1", reason: "ledger_limit" } });
    expect(a.client.snapshot().discarded.map(item => item.payload.operation.type)).toEqual(["add_bridge"]);
    server.postHook = null;
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b2") });
    expect((await verifyLedger(current(server))).bridges.map(item => item.bridgeId)).toEqual(["b2"]);
  });

  it("beforeSign runs after the fresh read and before the prompt; a longer chain it learns is built on in the same POST", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const base = current(server);
    // A computer of the account holds a record the server lost (a rollback): the agreement step learns it before signing.
    const peer = await addDevices(base, authenticator, accountId, 1);
    const order: string[] = [];
    let learnt: unknown = null;
    const page = await browser(server, authenticator, {
      storage: a.storage, identity: a,
      deps: {
        beforeSign: async head => {
          order.push(`hook:${head.revision}:${head.head === await headOf(base)}:${authenticator.names().length}`);
          learnt = await page.client.learnChain(peer, "peer");
        },
      },
    });
    const posts = server.posts.length;
    authenticator.calls = [];
    server.requests = [];
    await page.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") });
    expect(order).toEqual(["hook:1:true:0"]);
    expect(learnt).toBe("ahead");
    expect(server.requests[0]).toBe("GET /api/account/ledger");
    // One POST: the learnt record and the new one, on the server head read before.
    expect(server.posts).toHaveLength(posts + 1);
    expect(server.posts[posts]).toMatchObject({ expectHead: await headOf(base) });
    expect(current(server).transitions.slice(0, 2)).toEqual(peer.transitions);
    expect(current(server).transitions).toHaveLength(3);
    expect(page.replica.raw()?.ledger).toEqual(current(server));
    expect(authenticator.names()).toEqual(["sign"]);
  });
});

describe("LedgerClient divergence", () => {
  /** a's chain and the server's diverge after `base`: a holds base + mine, the server base + theirs (a rollback, then a history-less writer). */
  async function split(mine: (accountId: string) => Promise<LedgerOperation[]>, theirs: (accountId: string) => Promise<LedgerOperation[]>, prepare?: (accountId: string) => Promise<LedgerOperation[]>) {
    const { server, authenticator, a, accountId } = await owner();
    for (const operation of prepare === undefined ? [] : await prepare(accountId)) await a.client.append(operation);
    const base = current(server);
    for (const operation of await mine(accountId)) await a.client.append(operation);
    const local = current(server);
    let other = base;
    for (const operation of await theirs(accountId)) other = await signed(other, authenticator, operation);
    server.ledgers.set(accountId, wire(other));
    await a.client.refresh({ force: true });
    expect(a.client.snapshot().divergence?.other).toEqual(other);
    expect(a.replica.raw()?.ledger).toEqual(local);
    return { server, authenticator, a, accountId, base, local, other };
  }
  const signs = (authenticator: FakeAuthenticator): number => authenticator.names().filter(name => name === "sign").length;

  it("resolveDivergence('mine'), nothing to carry: one prompt, one POST; replica == server == mine + resolution", async () => {
    const { server, authenticator, a, local, other } = await split(
      async accountId => [{ type: "add_bridge", bridge: await testBridge(accountId, "mine") }],
      async accountId => [{ type: "add_device", device: await testDevice(accountId) }],
    );
    expect(a.client.snapshot().divergence).toMatchObject({ mine: { carry: [], canKeep: true }, theirs: { carry: [], canKeep: true } });
    const posts = server.posts.length;
    authenticator.calls = [];
    await a.client.resolveDivergence("mine", shown(a));
    expect(signs(authenticator)).toBe(1);
    expect(server.posts).toHaveLength(posts + 1);
    const chain = current(server);
    expect(chain.transitions.slice(0, -1)).toEqual(local.transitions);
    expect(chain.transitions.at(-1)?.payload.operation).toMatchObject({ type: "resolve_fork", discardedHead: await headOf(other) });
    expect(a.replica.raw()?.ledger).toEqual(chain);
    expect(a.client.snapshot()).toMatchObject({ divergence: null, serverState: "current" });
    await a.client.append({ type: "add_bridge", bridge: await testBridge(a.replica.raw()?.checkpoint.accountId ?? "", "after") });
    expect(current(server).transitions).toHaveLength(chain.transitions.length + 1);
  });

  it("resolveDivergence('theirs') carries this branch's removal onto the other one: 2 prompts; nothing adopted before the server took it", async () => {
    const { server, authenticator, a, other } = await split(
      async () => [{ type: "revoke_bridge", bridgeId: "studio" }],
      async accountId => [{ type: "add_device", device: await testDevice(accountId) }, { type: "add_device", device: await testDevice(accountId) }],
      async accountId => [{ type: "add_bridge", bridge: await testBridge(accountId, "studio") }],
    );
    const view = a.client.snapshot().divergence;
    expect(view?.theirs).toEqual({ carry: [{ type: "revoke_bridge", bridgeId: "studio" }], canKeep: true, reason: null });
    expect(view?.mine.carry).toEqual([]);
    const local = a.replica.raw()?.ledger;
    // The server is down at the POST: nothing adopted, the divergence stays; the signed choice is kept in memory (L6).
    server.postHook = () => json({ error: "ledger_unavailable" }, 503);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    authenticator.calls = [];
    await expect(a.client.resolveDivergence("theirs", shown(a))).rejects.toThrow("server_unavailable");
    expect(signs(authenticator)).toBe(2);
    expect(a.replica.raw()?.ledger).toEqual(local);
    expect(a.client.snapshot()).toMatchObject({ divergence: { other }, resolutionPending: "theirs" });
    expect(current(server)).toEqual(other);
    server.postHook = null;
    authenticator.calls = [];
    // Asked again: the same signed bundle is sent, no new prompt.
    await a.client.resolveDivergence("theirs", shown(a));
    expect(signs(authenticator)).toBe(0);
    expect(a.client.snapshot().resolutionPending).toBeNull();
    const chain = current(server);
    expect(chain.transitions.slice(0, other.transitions.length)).toEqual(other.transitions);
    expect(chain.transitions.slice(other.transitions.length).map(item => item.payload.operation.type)).toEqual(["revoke_bridge", "resolve_fork"]);
    expect(a.replica.raw()?.ledger).toEqual(chain);
    // The removal is part of the kept history, not a browser-only one.
    expect(a.client.snapshot()).toMatchObject({ divergence: null, localOnly: { deviceIds: [], bridgeIds: [] } });
    expect(a.replica.raw()?.checkpoint.revokedBridgeIds).toEqual(["studio"]);
  });

  it("carries several records (removals and a passkey with its original consent, no consent prompt); a cancel midway sends nothing", async () => {
    const extra = await createSoftPasskey({ rpId: RP_ID, origin: ORIGIN });
    let phone = "";
    const { server, authenticator, a, other } = await split(
      async accountId => [{ type: "add_bridge", bridge: await testBridge(accountId, "mine") }],
      async accountId => [
        { type: "revoke_device", endpointId: phone }, { type: "revoke_bridge", bridgeId: "studio" },
        {
          type: "add_authority", authority: { credentialId: extra.credentialId, publicKey: extra.publicKey, label: "YubiKey", addedAt: Date.now() - 500 },
          consent: await extra.sign(await authorityConsentChallenge(accountId, { credentialId: extra.credentialId, publicKey: extra.publicKey })),
        },
      ],
      async accountId => {
        const device = await testDevice(accountId);
        phone = device.endpoint.id;
        return [{ type: "add_device", device }, { type: "add_bridge", bridge: await testBridge(accountId, "studio") }];
      },
    );
    const carry = a.client.snapshot().divergence?.mine.carry ?? [];
    expect(carry.map(item => item.type)).toEqual(["revoke_device", "revoke_bridge", "add_authority"]);
    expect(a.client.snapshot().divergence?.mine.canKeep).toBe(true);
    const local = a.replica.raw()?.ledger;
    const posts = server.posts.length;
    // The owner cancels the second prompt: nothing sent or stored; the divergence is unchanged.
    let prompt = 0;
    authenticator.beforeSign = async () => { prompt += 1; if (prompt === 2) throw new Error("passkey_cancelled"); };
    authenticator.calls = [];
    await expect(a.client.resolveDivergence("mine", shown(a))).rejects.toThrow("passkey_cancelled");
    expect(server.posts).toHaveLength(posts);
    expect(a.replica.raw()?.ledger).toEqual(local);
    expect(a.client.snapshot().divergence?.other).toEqual(other);
    // From scratch: 3 carried records + the resolution = 4 prompts, and no consent prompt for the carried passkey.
    authenticator.beforeSign = null;
    authenticator.calls = [];
    await a.client.resolveDivergence("mine", shown(a));
    expect(authenticator.names()).toEqual(["sign", "sign", "sign", "sign"]);
    expect(server.posts).toHaveLength(posts + 1);
    const checkpoint = await verifyLedger(current(server));
    expect(checkpoint.revokedDeviceIds).toEqual([phone]);
    expect(checkpoint.revokedBridgeIds).toEqual(["studio"]);
    expect(checkpoint.authorities.map(item => item.credentialId)).toContain(extra.credentialId);
    expect(checkpoint.bridges.map(item => item.bridgeId)).toEqual(["mine"]);
    expect(a.replica.raw()?.ledger).toEqual(current(server));
    expect(a.client.snapshot().divergence).toBeNull();
  });

  it("a side that cannot carry the other's records says so (canKeep false) and is refused before any prompt", async () => {
    const extras = await Promise.all(Array.from({ length: LEDGER_LIMITS.maxAuthorities }, () => createSoftPasskey({ rpId: RP_ID, origin: ORIGIN })));
    const authority = async (accountId: string, key: SoftPasskey): Promise<LedgerOperation> => ({
      type: "add_authority", authority: { credentialId: key.credentialId, publicKey: key.publicKey, label: "Key", addedAt: Date.now() - 500 },
      consent: await key.sign(await authorityConsentChallenge(accountId, { credentialId: key.credentialId, publicKey: key.publicKey })),
    });
    const half = LEDGER_LIMITS.maxAuthorities / 2;
    const { server, authenticator, a } = await split(
      async accountId => Promise.all(extras.slice(0, half).map(key => authority(accountId, key))),
      async accountId => Promise.all(extras.slice(half).map(key => authority(accountId, key))),
    );
    const view = a.client.snapshot().divergence;
    expect(view?.mine).toMatchObject({ canKeep: false, reason: "ledger_limit" });
    expect(view?.theirs).toMatchObject({ canKeep: false, reason: "ledger_limit" });
    const posts = server.posts.length;
    authenticator.calls = [];
    await expect(a.client.resolveDivergence("mine", shown(a))).rejects.toThrow("ledger_limit");
    expect(authenticator.calls).toEqual([]);
    expect(server.posts).toHaveLength(posts);
  });

  it("the other side moved before the resolution landed: resolution_outdated, the divergence shows the newer chain, nothing adopted", async () => {
    const { server, authenticator, a, accountId, local, other } = await split(
      async accountId => [{ type: "add_bridge", bridge: await testBridge(accountId, "mine") }],
      async accountId => [{ type: "add_device", device: await testDevice(accountId) }],
    );
    const newer = await signed(other, authenticator, { type: "add_bridge", bridge: await testBridge(accountId, "theirs-2") });
    server.postHook = () => { server.ledgers.set(accountId, wire(newer)); return json({ error: "diverged", ledger: newer }, 409); };
    await expect(a.client.resolveDivergence("mine", shown(a))).rejects.toThrow("resolution_outdated");
    expect(a.replica.raw()?.ledger).toEqual(local);
    expect(a.client.snapshot().divergence?.other).toEqual(newer);
    server.postHook = null;
    await a.client.resolveDivergence("mine", shown(a));
    expect(a.client.snapshot().divergence).toBeNull();
    expect(a.replica.raw()?.ledger).toEqual(current(server));
  });

  it("a diverged relay push raises the divergence (relay), sends nothing; an invalid chain from anywhere is ignored with one warning", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const base = current(server);
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "mine") });
    const local = JSON.stringify(a.replica.raw());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const forged = wire(await addDevices(base, authenticator, accountId, 2));
    forged.transitions[1].signature = forged.transitions[0].signature;
    const posts = server.posts.length;
    await a.client.offer({ type: "ledger", ledger: forged });
    await a.client.offer({ type: "ledger", ledger: forged });
    expect(await a.client.learnChain(forged, "peer")).toBe("invalid");
    expect(a.client.snapshot().divergence).toBeNull();
    expect(warn.mock.calls.map(call => call[0])).toEqual(["[ledger] ignored an invalid chain from relay", "[ledger] ignored an invalid chain from peer"]);
    const other = await addDevices(base, authenticator, accountId, 3);
    await a.client.offer({ type: "ledger", ledger: other });
    await quiet();
    expect(JSON.stringify(a.replica.raw())).toBe(local);
    expect(a.client.snapshot()).toMatchObject({ divergence: { source: "relay", other } });
    await expect(a.client.revokeBridge("mine")).rejects.toThrow("ledger_diverged");
    expect(server.posts).toHaveLength(posts);
    // A server rolled back meanwhile is not re-offered to while diverged.
    rollBack(server, accountId, 1);
    await a.client.refresh({ force: true });
    await a.client.retryNow();
    expect(server.posts).toHaveLength(posts);
  });

  it("learnChain: ahead is adopted and brought to the server; behind and same change nothing; diverged raises the divergence (peer)", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const base = current(server);
    const ahead = await addDevices(base, authenticator, accountId, 1);
    const posts = server.posts.length;
    expect(await a.client.learnChain(ahead, "peer")).toBe("ahead");
    await quiet();
    expect(a.replica.raw()?.ledger).toEqual(ahead);
    expect(current(server)).toEqual(ahead);
    expect(server.posts).toHaveLength(posts + 1);
    expect(await a.client.learnChain(base, "peer")).toBe("behind");
    expect(await a.client.learnChain(ahead, "peer")).toBe("same");
    await quiet();
    expect(server.posts).toHaveLength(posts + 1);
    const other = await addDevices(base, authenticator, accountId, 2);
    expect(await a.client.learnChain(other, "peer")).toBe("diverged");
    expect(a.client.snapshot()).toMatchObject({ divergence: { source: "peer", other } });
    expect(a.replica.raw()?.ledger).toEqual(ahead);
    expect(server.posts).toHaveLength(posts + 1);
  });
});

describe("LedgerClient peers view", () => {
  it("setPeers sets snapshot.peers (default: nothing known) and nothing else; learnChain's `from` names the peer in its one warning", async () => {
    const { server, authenticator, a, accountId } = await owner();
    expect(a.client.snapshot().peers).toEqual({ head: "", confirmed: [], online: [], diverged: [] });
    const before = a.client.snapshot();
    const posts = server.posts.length;
    const view = { head: before.checkpoint?.head ?? "", confirmed: [{ kind: "bridge" as const, id: "studio", at: 1 }], online: ["studio"], diverged: [] };
    a.client.setPeers(view);
    expect(a.client.snapshot()).toEqual({ ...before, peers: view });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const forged = wire(await addDevices(current(server), authenticator, accountId, 2));
    forged.transitions[forged.transitions.length - 1].signature = forged.transitions[forged.transitions.length - 2].signature;
    expect(await a.client.learnChain(forged, "peer", "bridge studio-m")).toBe("invalid");
    expect(await a.client.learnChain(forged, "peer", "bridge studio-m")).toBe("invalid");
    expect(warn.mock.calls.map(call => call[0])).toEqual(["[ledger] ignored an invalid chain from bridge studio-m"]);
    await quiet();
    expect(server.posts).toHaveLength(posts);
    expect(a.client.snapshot().peers).toEqual(view);
  });
});

describe("LedgerClient review regressions (T1–T12) and the local block", () => {
  /** a holds base + "mine"; the server base + theirsOps (a rollback, then a history-less writer). */
  async function split(theirsOps: (accountId: string) => Promise<LedgerOperation[]>, prepare?: (accountId: string) => Promise<LedgerOperation[]>) {
    const { server, authenticator, a, accountId } = await owner();
    for (const operation of prepare === undefined ? [] : await prepare(accountId)) await a.client.append(operation);
    const base = current(server);
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "mine") });
    const local = current(server);
    let other = base;
    for (const operation of await theirsOps(accountId)) other = await signed(other, authenticator, operation);
    server.ledgers.set(accountId, wire(other));
    await a.client.refresh({ force: true });
    expect(a.client.snapshot().divergence?.other).toEqual(other);
    return { server, authenticator, a, accountId, base, local, other };
  }

  it("T1: a removal the server keeps refusing is enforced here at once and retried; the owner can withdraw it, and the block stays until dismissed", async () => {
    const { server, authenticator, a, accountId } = await owner();
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "stolen") });
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "other") });
    const stolen = a.replica.raw()?.checkpoint.bridges.find(item => item.bridgeId === "stolen");
    if (stolen === undefined) throw new Error("setup");
    server.postHook = () => json({ error: "ledger_rejected", ledger: current(server) }, 409);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(a.client.revokeBridge("stolen")).rejects.toThrow("ledger_rejected");
    // The computer the owner just removed is no longer trusted here (sealing, assertBridgeAccess), though the account still lists it.
    expect(() => a.client.assertBridgeAccess("stolen", stolen.endpoint.id)).toThrow("account_bridge_revoked");
    expect(a.client.snapshot().checkpoint?.bridges.map(item => item.bridgeId)).toEqual(["other"]);
    expect(a.replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(["stolen", "other"]);
    const posts = server.posts.length;
    await advance(2 * 3_600_000);
    expect(server.posts.length).toBeGreaterThan(posts + 5);
    expect(a.client.snapshot().pendingWrite).toMatchObject({ operation: "revoke_bridge", bridgeId: "stolen" });
    expect(() => a.client.assertBridgeAccess("stolen", stolen.endpoint.id)).toThrow("account_bridge_revoked");
    authenticator.calls = [];
    await expect(a.client.revokeBridge("other")).rejects.toThrow("write_pending");
    expect(authenticator.calls).toEqual([]);
    // The owner withdraws it (no passkey): writes are open again; the removal stays enforced here, listed to sign again or dismiss.
    server.postHook = null;
    expect(await a.client.discardPending()).toBe("discarded");
    expect(authenticator.calls).toEqual([]);
    const after = a.client.snapshot();
    expect(after).toMatchObject({ pendingWrite: null, lastConflict: { bridgeId: "stolen", reason: "discarded" }, blocked: { deviceIds: [], bridgeIds: ["stolen"] }, retryAt: null });
    expect(after.discarded.map(item => item.payload.operation)).toEqual([{ type: "revoke_bridge", bridgeId: "stolen" }]);
    expect(() => a.client.assertBridgeAccess("stolen", stolen.endpoint.id)).toThrow("account_bridge_revoked");
    const sent = server.posts.length;
    await advance(3_600_000);
    expect(server.posts).toHaveLength(sent);
    await a.client.revokeBridge("other");
    expect((await verifyLedger(current(server))).revokedBridgeIds).toEqual(["other"]);
    // Dismissing the entry lifts the block: the computer is trusted again (the account never removed it).
    await a.client.dismissDiscarded(a.client.snapshot().discarded);
    expect(() => a.client.assertBridgeAccess("stolen", stolen.endpoint.id)).not.toThrow();
    await expect(a.client.discardPending()).rejects.toThrow("no_pending_write");
  });

  it("discardPending() says so when the server already holds the change (its answer was lost), and withdraws nothing", async () => {
    const { server, authenticator, a, accountId } = await owner();
    let lose = true;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await server.fetch(input, init);
      if (lose && init?.method === "POST" && new URL(String(input)).pathname === "/api/account/ledger") { lose = false; throw new TypeError("reset"); }
      return response;
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { fetchImpl } });
    fakeTime();
    await expect(page.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") })).rejects.toThrow("network_unavailable");
    expect(page.client.snapshot().pendingWrite).toMatchObject({ operation: "add_bridge", bridgeId: "b1" });
    expect(await page.client.discardPending()).toBe("already_saved");
    expect(page.client.snapshot()).toMatchObject({ pendingWrite: null, discarded: [], lastConflict: null });
    expect(page.replica.raw()?.ledger).toEqual(current(server));
  });

  it("T2: a persisted pending record that does not verify (shape intact) is never sent after a reload: dropped, writes open again", async () => {
    const { server, authenticator, a, accountId } = await owner();
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") });
    let offline = true;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline && init?.method === "POST" && new URL(String(input)).pathname === "/api/account/ledger") throw new TypeError("offline");
      return server.fetch(input, init);
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { fetchImpl } });
    await expect(page.client.revokeBridge("b1")).rejects.toThrow("network_unavailable");
    page.client.dispose();
    a.client.dispose();
    const stored = await a.storage.read(accountId) as ReplicaRecord;
    if (stored.pending === undefined) throw new Error("no pending");
    const bad = { ...stored.pending, record: { ...stored.pending.record, signature: stored.ledger.transitions[stored.ledger.transitions.length - 1].signature } };
    expect(await a.storage.commit({ ...stored, serial: stored.serial + 1, pending: bad }, stored.serial)).toBe(true);
    offline = false;
    const before = server.posts.length;
    fakeTime();
    const reloaded = await browser(server, authenticator, { storage: a.storage, identity: a, deps: { fetchImpl } });
    await reloaded.client.load();
    await advance(3_600_000);
    expect(server.posts).toHaveLength(before);
    expect(reloaded.client.snapshot()).toMatchObject({ pendingWrite: null, lastConflict: { operation: "revoke_bridge", reason: "ledger_rejected" } });
    await reloaded.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b2") });
    expect((await verifyLedger(current(server))).bridges.map(item => item.bridgeId)).toEqual(["b1", "b2"]);
  });

  it("T3/M6: a server replaying this browser's own refused record shows it as abandoned and recommends 'mine'; serving our chain again clears it", async () => {
    const { server, a, accountId } = await owner();
    let captured: Ledger | null = null;
    server.postHook = ledger => {
      if (captured !== null) return null;
      captured = wire(ledger);
      return json({ error: "forbidden" }, 403);
    };
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "evil") })).rejects.toThrow("ledger_rejected");
    expect(a.client.snapshot().discarded).toHaveLength(1);
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "studio") });
    if (captured === null) throw new Error("setup");
    server.ledgers.set(accountId, wire(captured));
    await a.client.refresh({ force: true });
    const view = a.client.snapshot().divergence;
    expect(view?.source).toBe("server");
    expect(view?.other.transitions.at(-1)).toEqual(a.client.snapshot().discarded[0]);
    expect(view).toMatchObject({ abandoned: [true], recommend: "mine", otherHead: await headOf(captured) });
    await expect(a.client.revokeBridge("studio")).rejects.toThrow("ledger_diverged");
    // The server serves the account's chain again: that source agrees, its divergence is gone, writes are open.
    server.ledgers.set(accountId, wire(a.replica.raw()?.ledger as Ledger));
    await a.client.refresh({ force: true });
    expect(a.client.snapshot().divergence).toBeNull();
    await a.client.revokeBridge("studio");
    expect((await verifyLedger(current(server))).revokedBridgeIds).toEqual(["studio"]);
  });

  it("T4/M1: after resolveDivergence('mine'), a replay of the discarded branch (peer, relay, server read) raises nothing; a server serving it gets our resolution", async () => {
    const { server, a, accountId, other } = await split(async accountId => [{ type: "add_device", device: await testDevice(accountId) }]);
    await a.client.resolveDivergence("mine", shown(a));
    expect(a.client.snapshot().divergence).toBeNull();
    const resolvedChain = current(server);
    expect(await a.client.learnChain(other, "peer")).toBe("diverged");
    await a.client.offer({ type: "ledger", ledger: other });
    expect(a.client.snapshot().divergence).toBeNull();
    expect(a.replica.divergence()).toEqual({});
    // A server rolled back to the discarded branch: covered, so the resolved chain is re-offered to it (it adopts the resolution).
    server.ledgers.set(accountId, wire(other));
    const posts = server.posts.length;
    await a.client.refresh({ force: true });
    expect(server.posts).toHaveLength(posts + 1);
    expect(current(server)).toEqual(resolvedChain);
    expect(a.client.snapshot()).toMatchObject({ divergence: null, serverState: "current" });
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "x") });
  });

  it("T4b/M2: resolving against the server's S keeps a peer chain that extends S with a newer removal diverged; that removal is enforced here (seen)", async () => {
    const { a, authenticator, other } = await split(
      async accountId => [{ type: "add_device", device: await testDevice(accountId) }],
      async accountId => [{ type: "add_bridge", bridge: await testBridge(accountId, "studio") }],
    );
    const newer = await signed(other, authenticator, { type: "revoke_bridge", bridgeId: "studio" });
    expect(await a.client.learnChain(newer, "peer")).toBe("diverged");
    expect(Object.keys(a.replica.divergence()).sort()).toEqual(["peer", "server"]);
    // Seen on a valid other history: enforced here at once (sticky), though the local chain lists it.
    expect(a.client.snapshot().checkpoint?.bridges.map(item => item.bridgeId)).not.toContain("studio");
    expect(a.client.snapshot().localOnly.bridgeIds).toEqual(["studio"]);
    await a.client.resolveDivergence("mine", shown(a));
    // The peer's branch carries a record the resolution never saw: still shown, still enforced.
    expect(a.client.snapshot().divergence?.source).toBe("peer");
    expect(a.client.snapshot().checkpoint?.bridges.map(item => item.bridgeId)).not.toContain("studio");
  });

  it("T5/M5/L7: the account is gone while the prompt is open: no POST without expectHead, nothing re-created; shown, and discardable", async () => {
    const { server, authenticator, a, accountId } = await owner();
    authenticator.beforeSign = async () => {
      authenticator.beforeSign = null;
      server.ledgers.delete(accountId);
      await a.client.refresh({ force: true }).catch(() => undefined);
    };
    const posts = server.posts.length;
    const result = await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "b1") }).then(() => "ok", (error: Error) => error.message);
    expect(result).toBe("account_not_found");
    expect(server.posts).toHaveLength(posts);
    expect(server.ledgerOf(accountId)).toBeNull();
    expect(a.client.snapshot()).toMatchObject({ accountMissing: true, pendingWrite: { operation: "add_bridge", bridgeId: "b1" } });
    expect(await a.client.discardPending()).toBe("discarded");
    expect(a.client.snapshot().pendingWrite).toBeNull();
    expect(server.posts).toHaveLength(posts);
  });

  it("T7/L1: a new browser's add_device names the head it re-based on; a concurrent write is a write_conflict, never a creation", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    expect(server.posts.at(-1)).toHaveProperty("expectHead");
    const c = await browser(server, authenticator);
    await c.client.identifyAccount();
    authenticator.beforeSign = async () => {
      authenticator.beforeSign = null;
      await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "concurrent") });
    };
    await expect(c.client.enrollThisDevice({ deviceLabel: "Tablet" })).rejects.toThrow("write_conflict");
    expect(c.replica.raw()).toBeNull();
    // Confirmed again on the new head.
    await c.client.enrollThisDevice({ deviceLabel: "Tablet" });
    expect((await verifyLedger(current(server))).devices.map(item => item.label)).toContain("Tablet");
  });

  it("T8: three histories (server S, peer P, mine): two resolutions in a row converge without looping", async () => {
    const { a, server, authenticator, accountId, base } = await split(async accountId => [{ type: "add_device", device: await testDevice(accountId) }]);
    const peer = await signed(base, authenticator, { type: "add_bridge", bridge: await testBridge(accountId, "peer-only") });
    expect(await a.client.learnChain(peer, "peer")).toBe("diverged");
    await a.client.resolveDivergence("mine", shown(a));
    expect(a.client.snapshot().divergence?.source).toBe("peer");
    await a.client.resolveDivergence("mine", shown(a));
    expect(a.client.snapshot().divergence).toBeNull();
    expect(a.replica.raw()?.ledger).toEqual(current(server));
    expect(current(server).transitions.map(item => item.payload.operation.type).filter(type => type === "resolve_fork")).toHaveLength(2);
  });

  it("T9/L2/L3: another tab forgetting the account stops this tab's pending write; it is sent after the next sign-in of the account", async () => {
    const { server, authenticator, a, accountId } = await owner();
    let refusing = true;
    server.postHook = () => (refusing ? rateLimited(30) : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "regretted") })).rejects.toThrow("rate_limited");
    // Another tab of the profile (its own first attempt is refused too), then "start over" there.
    const other = await browser(server, authenticator, { storage: a.storage, identity: a });
    await other.client.load();
    await quiet();
    await other.client.forget();
    refusing = false;
    const posts = server.posts.length;
    await advance(120_000);
    expect(server.posts).toHaveLength(posts);
    expect((await verifyLedger(current(server))).bridges.map(item => item.bridgeId)).not.toContain("regretted");
    expect(a.replica.raw()).toBeNull();
    // Held while signed out, sent once the same account is signed in again on this profile.
    expect(await other.client.identifyAccount()).toEqual({ enrolled: true });
    await advance(60_000);
    expect((await verifyLedger(current(server))).bridges.map(item => item.bridgeId)).toContain("regretted");
  });

  it("T10/L4: two tabs of one profile: the second tab's write while the first one's is pending is refused before any prompt", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const tab2 = await browser(server, authenticator, { storage: a.storage, identity: a });
    await tab2.client.load();
    server.postHook = () => rateLimited(600);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "one") })).rejects.toThrow("rate_limited");
    server.postHook = null;
    const posts = server.posts.length;
    authenticator.calls = [];
    await expect(tab2.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "two") })).rejects.toThrow("write_pending");
    expect(authenticator.calls).toEqual([]);
    expect(server.posts).toHaveLength(posts);
  });

  it("T11/H1: a valid diverged relay push drops a pending REVOKE (ledger_diverged); its target stays untrusted here", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const base = current(server);
    await a.client.append({ type: "add_bridge", bridge: await testBridge(accountId, "stolen") });
    const stolen = a.replica.raw()?.checkpoint.bridges[0];
    if (stolen === undefined) throw new Error("setup");
    server.postHook = () => json({ error: "ledger_unavailable" }, 503);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(a.client.revokeBridge("stolen")).rejects.toThrow("server_unavailable");
    await a.client.offer({ type: "ledger", ledger: await addDevices(base, authenticator, accountId, 1) });
    expect(a.client.snapshot()).toMatchObject({ pendingWrite: null, lastConflict: { bridgeId: "stolen", reason: "ledger_diverged" }, divergence: { source: "relay" } });
    expect(() => a.client.assertBridgeAccess("stolen", stolen.endpoint.id)).toThrow("account_bridge_revoked");
    expect(a.client.snapshot().blocked).toEqual({ deviceIds: [], bridgeIds: ["stolen"] });
    await expect(a.client.revokeBridge("stolen")).rejects.toThrow("ledger_diverged");
  });

  it("T12/M7: resolveDivergence refuses, before any prompt, a divergence other than the one the owner was shown", async () => {
    const { server, authenticator, a, accountId, other } = await split(async accountId => [{ type: "add_device", device: await testDevice(accountId) }]);
    const decided = shown(a);
    const swapped = await signed(other, authenticator, { type: "add_bridge", bridge: await testBridge(accountId, "never-shown") });
    server.ledgers.set(accountId, wire(swapped));
    authenticator.calls = [];
    const posts = server.posts.length;
    await expect(a.client.resolveDivergence("theirs", decided)).rejects.toThrow("resolution_outdated");
    expect(authenticator.calls).toEqual([]);
    expect(server.posts).toHaveLength(posts);
    expect(current(server)).toEqual(wire(swapped));
    // The screen now shows the newer chain; resolving what it shows works.
    expect(a.client.snapshot().divergence?.other).toEqual(swapped);
    await expect(a.client.resolveDivergence("theirs", { ...decided, source: "peer" })).rejects.toThrow("resolution_outdated");
    await a.client.resolveDivergence("theirs", shown(a));
    expect((await verifyLedger(current(server))).bridges.map(item => item.bridgeId)).toContain("never-shown");
  });

  it("H1: a pending removal of another browser blocks it here at once; delivered, the chain holds it", async () => {
    const { server, authenticator, a, accountId } = await owner();
    const b = await browser(server, authenticator);
    await b.client.signInNewDevice({ deviceLabel: "Phone" });
    const phone = (await b.endpoint(accountId)).endpoint.id;
    await a.client.refresh({ force: true });
    let refusals = 1;
    server.postHook = () => (refusals-- > 0 ? rateLimited(30) : null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeTime();
    await expect(a.client.revokeDevice(phone)).rejects.toThrow("rate_limited");
    expect(a.client.snapshot().checkpoint?.devices.map(item => item.endpoint.id)).not.toContain(phone);
    expect(a.client.snapshot().checkpoint?.revokedDeviceIds).toEqual([phone]);
    expect(a.client.snapshot()).toMatchObject({ status: "ready", unsaved: { deviceIds: [phone], bridgeIds: [] }, blocked: { deviceIds: [phone], bridgeIds: [] } });
    // What is sent is unchanged by the block: the chain, plus the signed record.
    expect(a.replica.raw()?.checkpoint.devices.map(item => item.endpoint.id)).toContain(phone);
    await advance(60_000);
    expect((await verifyLedger(current(server))).revokedDeviceIds).toEqual([phone]);
    expect(a.client.snapshot()).toMatchObject({ pendingWrite: null, blocked: { deviceIds: [], bridgeIds: [] }, unsaved: { deviceIds: [], bridgeIds: [] } });
  });

  it("L6: a resolution the server could not take is retried by itself without new prompts; a change of the other chain cancels it", async () => {
    for (const change of [false, true]) {
      const { server, authenticator, a, accountId, other } = await split(async accountId => [{ type: "add_device", device: await testDevice(accountId) }]);
      let refusals = 1;
      server.postHook = () => (refusals-- > 0 ? json({ error: "ledger_unavailable" }, 503) : null);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      fakeTime();
      authenticator.calls = [];
      await expect(a.client.resolveDivergence("mine", shown(a))).rejects.toThrow("server_unavailable");
      expect(authenticator.names()).toEqual(["sign"]);
      expect(a.client.snapshot().resolutionPending).toBe("mine");
      if (change) server.ledgers.set(accountId, wire(await signed(other, authenticator, { type: "add_bridge", bridge: await testBridge(accountId, "later") })));
      await advance(120_000);
      if (change) {
        // The other history moved: the signed choice no longer applies and is dropped; the owner reviews the newer chain.
        expect(a.client.snapshot()).toMatchObject({ resolutionPending: null, divergence: { source: "server" } });
        expect(current(server).transitions.some(item => item.payload.operation.type === "resolve_fork")).toBe(false);
      } else {
        expect(a.client.snapshot()).toMatchObject({ resolutionPending: null, divergence: null });
        expect(a.replica.raw()?.ledger).toEqual(current(server));
      }
      expect(authenticator.names().filter(name => name === "sign")).toHaveLength(1);
      vi.useRealTimers();
    }
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
