import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import { HEAD_ANNOUNCE_MAX_AGE_MS, signHeadAnnouncement, verifyHeadAnnouncement } from "@security/ledger/announce";
import type { HeadAnnouncement } from "@security/ledger/announce";
import {
  accountIdOf, applyRevocations, authorityConsentChallenge, chooseLedger, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, ledgerRevocations, nextTransition,
  verifyLedger,
} from "@security/ledger/ledger";
import type { LedgerRelation } from "@security/ledger/ledger";
import { generateAuthKey, parseAuthProof, verifyAuthProof } from "@security/ledger/proof";
import type { Ledger, LedgerBridge, LedgerCheckpoint, LedgerGenesis, LedgerOperation, LedgerTransition, PasskeySignature, Signed } from "@security/ledger/protocol";
import { createSoftPasskey } from "@security/ledger/testing";
import type { SoftPasskey } from "@security/ledger/testing";
import type { EndpointIdentity, EndpointPublic } from "@security/protocol";
import { LedgerClient } from "./ledger-client";
import type { LedgerClientDeps, LedgerPeersView } from "./ledger-client";
import { CHAIN_MAX_PAGES, LedgerPeers, MAX_QUEUED, PREPARE_BUDGET_MS, PRESENCE_WAIT_MS, presentBridgeIds } from "./ledger-peers";
import type { LedgerPeersClient, LedgerPeersTransport } from "./ledger-peers";
import { LedgerReplica, memoryReplicaStorage } from "./ledger-replica";
import type { LedgerReplicaStorage } from "./ledger-replica";
import type * as PasskeyModule from "./passkey";

/*
 * Deterministic time, as in ledger-client.test.ts: setTimeout/clearTimeout/Date are fake (fakeTime()), WebCrypto is real and tracked;
 * quiet() returns once no tracked work is pending and the microtask queue is drained, advance(ms) fires due timers one at a time.
 */
const realSetImmediate = globalThis.setImmediate;
const pending = new Set<Promise<unknown>>();
function track<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  const done = (): void => { pending.delete(work); };
  work.then(done, done);
  return work;
}
const SUBTLE = ["decrypt", "deriveBits", "deriveKey", "digest", "encrypt", "exportKey", "generateKey", "importKey", "sign", "unwrapKey", "verify", "wrapKey"] as const;
function instrumentCrypto(): void {
  const subtle = globalThis.crypto.subtle;
  for (const name of SUBTLE) {
    const original = (subtle[name] as unknown as (...args: unknown[]) => Promise<unknown>).bind(subtle);
    vi.spyOn(subtle, name).mockImplementation(((...args: unknown[]) => track(original(...args))) as never);
  }
}
async function quiet(): Promise<void> {
  for (let idle = 0; idle < 2;) {
    await new Promise(resolve => { realSetImmediate(resolve); });
    if (pending.size > 0) {
      idle = 0;
      await Promise.allSettled([...pending]);
    } else {
      idle += 1;
    }
  }
}
async function advance(ms: number): Promise<void> {
  await quiet();
  let reached = false;
  setTimeout(() => { reached = true; }, ms);
  while (!reached) {
    vi.advanceTimersToNextTimer();
    await quiet();
  }
}
function fakeTime(): number {
  const start = (Math.floor(Date.now() / 1000) + 1) * 1000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: start });
  return start;
}

const made: LedgerPeers[] = [];
const clients: LedgerClient[] = [];
beforeEach(() => { instrumentCrypto(); });
afterEach(() => {
  for (const peers of made.splice(0)) peers.dispose();
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---- Pure fakes: a fake client and replica, fake computers, real announcement signatures. ----

/** A canonical 32-byte base64url token (head, id). */
const tok = (n: number): string => `${n.toString(36).padStart(6, "0")}${"x".repeat(36)}A`;
const ACCOUNT = tok(0);
const HEADS = Array.from({ length: 16 }, (_, n) => (n === 0 ? ACCOUNT : tok(n)));
const chainHeads = (revision: number): string[] => HEADS.slice(0, revision + 1);
const SELF_ID = tok(100);
const OTHER_ID = tok(101);
const STUDIO = "studio-mac-1";
const AIR = "air-laptop-2";
type AuthKey = { publicKey: string; privateKey: CryptoKey };
const keys = {} as Record<"self" | "other" | "studio" | "air" | "outsider", AuthKey>;
beforeAll(async () => {
  for (const name of ["self", "other", "studio", "air", "outsider"] as const) keys[name] = await generateAuthKey(false);
});
const endpoint = (id: string, kind: "browser" | "bridge"): EndpointPublic => ({ version: 1, id, ownerId: ACCOUNT, kind, publicKey: `p${id}` });
const SELF = endpoint(SELF_ID, "browser");
function checkpoint(over: Partial<LedgerCheckpoint> = {}): LedgerCheckpoint {
  return {
    version: 2, accountId: ACCOUNT, revision: 2, head: HEADS[2], authorities: [],
    devices: [
      { endpoint: SELF, authPublicKey: keys.self.publicKey, label: "This", approvedAt: 0 },
      { endpoint: endpoint(OTHER_ID, "browser"), authPublicKey: keys.other.publicKey, label: "Phone", approvedAt: 0 },
    ],
    bridges: [
      { bridgeId: STUDIO, endpoint: endpoint(tok(200), "bridge"), authPublicKey: keys.studio.publicKey, label: "Studio", approvedAt: 0 },
      { bridgeId: AIR, endpoint: endpoint(tok(201), "bridge"), authPublicKey: keys.air.publicKey, label: "Air", approvedAt: 0 },
    ],
    revokedDeviceIds: [], revokedBridgeIds: [], ...over,
  };
}

class FakeClient implements LedgerPeersClient {
  heads: string[] | null = chainHeads(2);
  trusted: LedgerCheckpoint | null = checkpoint();
  status = "ready";
  divergence: unknown = null;
  readonly views: LedgerPeersView[] = [];
  private readonly listeners = new Set<() => void>();
  learnChain = vi.fn(async (_chain: Ledger, _source: "peer", _from?: string): Promise<LedgerRelation | "invalid"> => "same");
  refresh = vi.fn(async (): Promise<void> => undefined);
  snapshot = (): { status: string; divergence: unknown } => ({ status: this.status, divergence: this.divergence });
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  setPeers = (view: LedgerPeersView): void => { this.views.push(view); };
  get peers(): LedgerPeersView | undefined { return this.views[this.views.length - 1]; }
  /** The replica adopted a longer chain of the same history. */
  move(revision: number): void {
    this.heads = chainHeads(revision);
    this.emit();
  }
  emit(): void { for (const listener of Array.from(this.listeners)) listener(); }
}

/** Fake records of a chain at `revision` (genesis first): learnChain is a fake here, so only the paging is checked. */
const fakeRecords = (revision: number, salt = ""): Record<string, unknown>[] => Array.from({ length: revision + 1 }, (_, n) => ({ payload: { n, salt }, signature: {} }));
interface Hold { records: unknown[]; head: string; revision: number }
const holding = (revision: number, head = HEADS[revision], salt = ""): Hold => ({ records: fakeRecords(revision, salt), head, revision });

/** Computers answering ledger_head / paged ledger_chain from what they hold (C4-RPC wire). */
class FakeBridges {
  readonly hold = new Map<string, Hold>();
  readonly silent = new Set<string>();
  pageSize = 1025;
  pageDelayMs = 0;
  onPage: ((bridgeId: string, fromRevision: number) => void) | null = null;
  readonly log: string[] = [];
  readonly payloads: Record<string, unknown>[] = [];
  /** What a presence read reports: when null, the computers the test last put online (setOnline). */
  present: string[] | null = null;
  lastOnline: string[] = [];
  /** A presence read rejects with this, or never answers when "hang". */
  presenceFails: Error | "hang" | null = null;
  constructor(private readonly accountId = ACCOUNT) {}
  presence = async (): Promise<string[]> => {
    if (this.presenceFails === "hang") return new Promise(() => undefined);
    if (this.presenceFails !== null) throw this.presenceFails;
    return (this.present ?? this.lastOnline).slice();
  };
  /** The transport of a usable connection to these computers (overrides replace its parts). */
  transport(published: HeadAnnouncement[], overrides: Partial<LedgerPeersTransport> = {}): LedgerPeersTransport {
    return {
      self: SELF,
      request: vi.fn(this.request),
      publish: vi.fn(async (item: HeadAnnouncement): Promise<void> => { published.push(item); }),
      ready: vi.fn(async (): Promise<void> => undefined),
      presence: vi.fn(this.presence),
      ...overrides,
    };
  }
  /** Presence reports what the test puts online, unless `present` says otherwise. */
  mirror(peers: LedgerPeers): void {
    const setOnline = peers.setOnline.bind(peers);
    peers.setOnline = (bridgeIds: readonly string[]): void => {
      this.lastOnline = bridgeIds.slice();
      setOnline(bridgeIds);
    };
  }
  /** A real chain held by a computer. */
  async setChain(bridgeId: string, ledger: Ledger): Promise<void> {
    const last = ledger.transitions[ledger.transitions.length - 1];
    this.hold.set(bridgeId, { records: [ledger.genesis, ...ledger.transitions], head: await ledgerHead(last === undefined ? ledger.genesis.payload : last.payload), revision: ledger.transitions.length });
  }
  request = async (bridgeId: string, type: "ledger_head" | "ledger_chain", payload: Record<string, unknown>): Promise<unknown> => {
    this.log.push(type === "ledger_head" ? `${bridgeId} head` : `${bridgeId} chain ${String(payload.fromRevision)}`);
    this.payloads.push(payload);
    if (this.silent.has(bridgeId)) return new Promise(() => undefined);
    if (type === "ledger_chain" && this.pageDelayMs > 0) await new Promise(resolve => { setTimeout(resolve, this.pageDelayMs); });
    const hold = this.hold.get(bridgeId);
    if (hold === undefined) return { requestId: "r", success: false, error: "Invalid ledger request", data: { code: "permission_denied" } };
    if (type === "ledger_head") return { requestId: "r", success: true, data: { accountId: this.accountId, head: hold.head, revision: hold.revision } };
    const from = Number(payload.fromRevision);
    this.onPage?.(bridgeId, from);
    const now = this.hold.get(bridgeId) as Hold;
    const records = now.records.slice(from, from + this.pageSize);
    return {
      requestId: "r", success: true,
      data: { accountId: this.accountId, head: now.head, revision: now.revision, fromRevision: from, records, more: from + records.length < now.records.length },
    };
  };
}

function setup(options: { client?: FakeClient; deviceKey?: AuthKey; attach?: boolean } = {}) {
  const client = options.client ?? new FakeClient();
  const bridges = new FakeBridges();
  const published: HeadAnnouncement[] = [];
  const verify = vi.fn(verifyHeadAnnouncement);
  const warn = vi.fn((_message: string): void => undefined);
  const peers = new LedgerPeers({
    client, heads: () => client.heads, trusted: () => client.trusted, deviceKey: async () => options.deviceKey ?? keys.self, verify, warn,
  });
  made.push(peers);
  bridges.mirror(peers);
  const transport = bridges.transport(published);
  if (options.attach !== false) peers.attach(transport);
  return { client, bridges, peers, transport, published, verify, warn };
}
function announcement(kind: "device" | "bridge", keyId: string, key: AuthKey, revision: number, options: { head?: string; at?: number; accountId?: string } = {}): Promise<HeadAnnouncement> {
  return signHeadAnnouncement(key.privateKey, { accountId: options.accountId ?? ACCOUNT, kind, keyId, head: options.head ?? HEADS[revision], revision, at: options.at ?? Date.now() });
}
const HEAD2 = { revision: 2, head: HEADS[2] };
const chainOf = (records: unknown[]): unknown => ({ genesis: records[0], transitions: records.slice(1) });

describe("LedgerPeers prepare (before signing)", () => {
  it("with no computer online and no recent announcement it returns at once and asks nothing", async () => {
    fakeTime();
    const { peers, bridges } = setup();
    const done = vi.fn();
    void peers.prepare(HEAD2).then(done);
    await quiet();
    expect(done).toHaveBeenCalledOnce();
    expect(bridges.log).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("every online computer agrees: one ledger_head each (payload exactly { bridgeId }), done as soon as they answered", async () => {
    fakeTime();
    const { peers, bridges, client } = setup();
    bridges.hold.set(STUDIO, holding(2));
    bridges.hold.set(AIR, holding(2));
    peers.setOnline([STUDIO, AIR]);
    await quiet();
    bridges.log.length = 0;
    bridges.payloads.length = 0;
    const t0 = Date.now();
    const done = vi.fn();
    void peers.prepare(HEAD2).then(done);
    await quiet();
    expect(done).toHaveBeenCalledOnce();
    expect(Date.now()).toBe(t0);
    expect(bridges.log).toEqual([`${AIR} head`, `${STUDIO} head`]);
    expect(bridges.payloads).toEqual([{ bridgeId: AIR }, { bridgeId: STUDIO }]);
    expect(client.learnChain).not.toHaveBeenCalled();
    expect(client.peers).toEqual({
      head: HEADS[2], confirmed: [{ kind: "bridge", id: AIR, at: t0 }, { kind: "bridge", id: STUDIO, at: t0 }], online: [AIR, STUDIO], diverged: [],
    });
  });

  it("a silent computer: returns after exactly 2 s in total, without an error", async () => {
    fakeTime();
    const { peers, bridges, client } = setup();
    bridges.silent.add(STUDIO);
    bridges.hold.set(AIR, holding(2));
    peers.setOnline([STUDIO, AIR]);
    await quiet();
    const done = vi.fn();
    const failed = vi.fn();
    void peers.prepare(HEAD2).then(done, failed);
    await advance(PREPARE_BUDGET_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await advance(1);
    expect(done).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    expect(client.learnChain).not.toHaveBeenCalled();
  });

  it("refusals, errors and malformed answers are silence: nothing learnt, nothing warned, never an error", async () => {
    fakeTime();
    const { peers, client, transport, warn } = setup();
    peers.setOnline([STUDIO]);
    const answers: (() => Promise<unknown>)[] = [
      async () => { throw new Error("bridge_offline"); },
      async () => ({ success: false, error: "Invalid ledger request", data: { code: "permission_denied" } }),
      async () => ({ success: true, data: { accountId: tok(70), head: HEADS[4], revision: 4 } }),
      async () => ({ success: true, data: { accountId: ACCOUNT, head: "short", revision: 4 } }),
      async () => ({ success: true, data: { accountId: ACCOUNT, head: HEADS[4], revision: -1 } }),
      async () => null,
      () => { throw new Error("sync"); },
    ];
    for (const answer of answers) {
      transport.request = vi.fn(answer);
      await expect(peers.prepare(HEAD2)).resolves.toBeUndefined();
      expect(transport.request).toHaveBeenCalledOnce();
    }
    expect(client.learnChain).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a computer that is ahead: its chain is fetched and learnt, prepare resolves once the client adopted it", async () => {
    fakeTime();
    const { peers, bridges, client, warn } = setup();
    bridges.hold.set(STUDIO, holding(2));
    peers.setOnline([STUDIO]);
    await quiet();
    bridges.hold.set(STUDIO, holding(4));
    bridges.log.length = 0;
    client.learnChain.mockImplementation(async () => { client.move(4); return "ahead"; });
    await peers.prepare(HEAD2);
    expect(bridges.log).toEqual([`${STUDIO} head`, `${STUDIO} chain 0`]);
    expect(client.learnChain).toHaveBeenCalledExactlyOnceWith(chainOf(fakeRecords(4)), "peer", "bridge studio-m");
    await quiet();
    expect(client.peers).toMatchObject({ head: HEADS[4], confirmed: [{ kind: "bridge", id: STUDIO }], diverged: [] });
    expect(warn).not.toHaveBeenCalled();
  });

  it("a computer that proves a valid different history blocks signing with ledger_diverged and is listed", async () => {
    fakeTime();
    const { peers, bridges, client } = setup();
    bridges.hold.set(STUDIO, holding(2));
    peers.setOnline([STUDIO]);
    await quiet();
    bridges.hold.set(STUDIO, holding(3, tok(50), "theirs"));
    client.learnChain.mockImplementation(async () => { client.divergence = { source: "peer" }; client.emit(); return "diverged"; });
    await expect(peers.prepare(HEAD2)).rejects.toThrow("ledger_diverged");
    expect(client.learnChain).toHaveBeenCalledOnce();
    await quiet();
    expect(client.peers?.diverged).toEqual([{ kind: "bridge", id: STUDIO, head: tok(50).slice(0, 8), revision: 3 }]);
  });

  it("while the client already holds a divergence (the owner resolving it) a diverged computer does not block", async () => {
    fakeTime();
    const client = new FakeClient();
    client.divergence = { source: "server" };
    const { peers, bridges } = setup({ client });
    bridges.hold.set(STUDIO, holding(3, tok(50), "theirs"));
    client.learnChain.mockResolvedValue("diverged");
    peers.setOnline([STUDIO]);
    await quiet();
    await advance(10_000);
    await expect(peers.prepare(HEAD2)).resolves.toBeUndefined();
    expect(client.learnChain).toHaveBeenCalledTimes(2);
  });

  it("garbage chain pages are ignored with one warning and never block; the client warns about an invalid chain itself", async () => {
    fakeTime();
    const { peers, client, transport, warn } = setup();
    transport.request = vi.fn(async (_bridgeId: string, type: string, payload: Record<string, unknown>) => (type === "ledger_head"
      ? { success: true, data: { accountId: ACCOUNT, head: HEADS[4], revision: 4 } }
      : { success: true, data: { accountId: ACCOUNT, head: HEADS[4], revision: 4, fromRevision: payload.fromRevision, records: "junk", more: false } }));
    peers.setOnline([STUDIO]);
    await quiet();
    expect(warn.mock.calls).toEqual([["[ledger] ignored an invalid chain from bridge studio-m"]]);
    const done = vi.fn();
    void peers.prepare(HEAD2).then(done);
    await quiet();
    expect(done).toHaveBeenCalledOnce();
    await advance(10_000);
    await peers.prepare(HEAD2);
    // A chain shorter than its claimed tip is invalid too; still one warning per computer.
    transport.request = vi.fn(async (_bridgeId: string, type: string) => (type === "ledger_head"
      ? { success: true, data: { accountId: ACCOUNT, head: HEADS[4], revision: 4 } }
      : { success: true, data: { accountId: ACCOUNT, head: HEADS[4], revision: 4, fromRevision: 0, records: fakeRecords(2), more: false } }));
    await advance(10_000);
    await peers.prepare(HEAD2);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(client.learnChain).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    // An invalid chain that parses goes to the client, which warns under this computer's name: no second warning here.
    client.learnChain.mockResolvedValue("invalid");
    transport.request = vi.fn(async (bridgeId: string, type: "ledger_head" | "ledger_chain", payload: Record<string, unknown>) => {
      const bridges = new FakeBridges();
      bridges.hold.set(STUDIO, holding(4));
      return bridges.request(bridgeId, type, payload);
    });
    await advance(10_000);
    await peers.prepare(HEAD2);
    expect(client.learnChain).toHaveBeenCalledExactlyOnceWith(chainOf(fakeRecords(4)), "peer", "bridge studio-m");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("pages: three pages in order, rebuilt as { genesis, transitions }", async () => {
    fakeTime();
    const { peers, bridges, client } = setup();
    bridges.hold.set(STUDIO, holding(2));
    peers.setOnline([STUDIO]);
    await quiet();
    bridges.log.length = 0;
    bridges.pageSize = 2;
    bridges.hold.set(STUDIO, holding(5));
    client.learnChain.mockImplementation(async () => { client.move(5); return "ahead"; });
    await peers.prepare(HEAD2);
    expect(bridges.log).toEqual([`${STUDIO} head`, `${STUDIO} chain 0`, `${STUDIO} chain 2`, `${STUDIO} chain 4`]);
    expect(client.learnChain).toHaveBeenCalledExactlyOnceWith(chainOf(fakeRecords(5)), "peer", "bridge studio-m");
  });

  it("a tip that moves between pages restarts the fetch from 0 once", async () => {
    fakeTime();
    const { peers, bridges, client } = setup();
    bridges.pageSize = 2;
    bridges.hold.set(STUDIO, holding(5));
    let moved = false;
    bridges.onPage = (bridgeId, from) => {
      if (from === 2 && !moved) {
        moved = true;
        bridges.hold.set(bridgeId, holding(6));
      }
    };
    client.learnChain.mockImplementation(async () => { client.move(6); return "ahead"; });
    peers.setOnline([STUDIO]);
    await quiet();
    expect(bridges.log).toEqual([
      `${STUDIO} head`, `${STUDIO} chain 0`, `${STUDIO} chain 2`, `${STUDIO} chain 0`, `${STUDIO} chain 2`, `${STUDIO} chain 4`, `${STUDIO} chain 6`,
    ]);
    expect(client.learnChain).toHaveBeenCalledExactlyOnceWith(chainOf(fakeRecords(6)), "peer", "bridge studio-m");
  });

  it("caps: more than 12 pages, more than 2.5 MB, or more than 3 s give up on that computer silently", async () => {
    fakeTime();
    // Pages.
    const first = setup();
    first.bridges.pageSize = 1;
    first.bridges.hold.set(STUDIO, holding(12));
    first.peers.setOnline([STUDIO]);
    await quiet();
    expect(first.bridges.log.filter(line => line.includes("chain"))).toHaveLength(CHAIN_MAX_PAGES);
    expect(first.client.learnChain).not.toHaveBeenCalled();
    // Bytes.
    const second = setup();
    const big = (n: number): Record<string, unknown> => ({ payload: { n, x: "a".repeat(1_000_000) }, signature: {} });
    second.bridges.hold.set(STUDIO, { records: [big(0), big(1), big(2)], head: tok(60), revision: 2 });
    second.peers.setOnline([STUDIO]);
    await quiet();
    expect(second.bridges.log).toEqual([`${STUDIO} head`, `${STUDIO} chain 0`]);
    expect(second.client.learnChain).not.toHaveBeenCalled();
    // Time: pages of 1.1 s each, the third is still unanswered at 3 s.
    const third = setup();
    third.bridges.pageSize = 1;
    third.bridges.pageDelayMs = 1_100;
    third.bridges.hold.set(STUDIO, holding(5));
    third.peers.setOnline([STUDIO]);
    await advance(10_000);
    expect(third.bridges.log).toEqual([`${STUDIO} head`, `${STUDIO} chain 0`, `${STUDIO} chain 1`, `${STUDIO} chain 2`]);
    expect(third.client.learnChain).not.toHaveBeenCalled();
    for (const item of [first, second, third]) expect(item.warn).not.toHaveBeenCalled();
  });

  it("a computer that is not a trusted member is never asked, whatever presence says", async () => {
    fakeTime();
    const client = new FakeClient();
    client.trusted = checkpoint({ bridges: checkpoint().bridges.filter(item => item.bridgeId === STUDIO), revokedBridgeIds: [AIR] });
    const { peers, bridges } = setup({ client });
    bridges.hold.set(STUDIO, holding(2));
    bridges.hold.set(AIR, holding(4));
    bridges.hold.set("stranger-9", holding(4));
    peers.setOnline([STUDIO, AIR, "stranger-9"]);
    await quiet();
    await peers.prepare(HEAD2);
    expect(bridges.log).toEqual([`${STUDIO} head`, `${STUDIO} head`]);
    expect(client.peers?.online).toEqual([STUDIO]);
  });

  it("joins the chain fetch a computer's recent announcement started, and resolves only after the chain was learnt", async () => {
    fakeTime();
    const { peers, bridges, client } = setup();
    bridges.hold.set(STUDIO, holding(4));
    bridges.pageDelayMs = 1_000;
    let learntAt = -1;
    client.learnChain.mockImplementation(async () => { learntAt = Date.now(); client.move(4); return "ahead"; });
    const t0 = Date.now();
    peers.receive(await announcement("bridge", STUDIO, keys.studio, 4));
    await quiet();
    let resolvedAt = -1;
    // Not present on the relay: only the announcement says it is online.
    void peers.prepare(HEAD2).then(() => { resolvedAt = Date.now(); });
    await advance(PREPARE_BUDGET_MS);
    expect(bridges.log).toEqual([`${STUDIO} chain 0`]);
    expect(learntAt).toBe(t0 + 1_000);
    expect(resolvedAt).toBe(t0 + 1_000);
  });
});

describe("LedgerPeers prepare never relies on a stale or empty online list", () => {
  it("online list empty while a member computer is present: a fresh presence read asks it and its longer chain is learnt before prepare resolves", async () => {
    fakeTime();
    const { peers, bridges, client, transport } = setup();
    await quiet();
    expect(client.peers?.online).toEqual([]);
    bridges.present = [STUDIO];
    bridges.hold.set(STUDIO, holding(4));
    client.learnChain.mockImplementation(async () => { client.move(4); return "ahead"; });
    const t0 = Date.now();
    await peers.prepare(HEAD2);
    expect(Date.now()).toBe(t0);
    expect(transport.presence).toHaveBeenCalledTimes(2);
    expect(bridges.log).toEqual([`${STUDIO} head`, `${STUDIO} chain 0`]);
    expect(client.learnChain).toHaveBeenCalledExactlyOnceWith(chainOf(fakeRecords(4)), "peer", "bridge studio-m");
    expect(client.heads).toEqual(chainHeads(4));
    await quiet();
    expect(client.peers?.online).toEqual([STUDIO]);
  });

  it("presence cannot be read (refused, or no answer within 500 ms): every member computer is asked, at most once each", async () => {
    fakeTime();
    const client = new FakeClient();
    client.trusted = checkpoint({ bridges: checkpoint().bridges.filter(item => item.bridgeId === STUDIO), revokedBridgeIds: [AIR] });
    const { peers, bridges } = setup({ client });
    bridges.presenceFails = new Error("permission denied");
    bridges.hold.set(STUDIO, holding(2));
    await quiet();
    // On connect the comparison already fell back to every member computer.
    expect(bridges.log).toEqual([`${STUDIO} head`]);
    bridges.log.length = 0;
    await peers.prepare(HEAD2);
    expect(bridges.log).toEqual([`${STUDIO} head`]);
    // A read that never answers: asked once PRESENCE_WAIT_MS passed, all within the budget.
    bridges.presenceFails = "hang";
    bridges.log.length = 0;
    const t0 = Date.now();
    let resolvedAt = -1;
    void peers.prepare(HEAD2).then(() => { resolvedAt = Date.now(); });
    await advance(499);
    expect(bridges.log).toEqual([]);
    await advance(1);
    expect(bridges.log).toEqual([`${STUDIO} head`]);
    expect(resolvedAt).toBe(t0 + PRESENCE_WAIT_MS);
  });

  it("a connection still opening is waited for (connected after 300 ms): the computer is still asked within the budget", async () => {
    fakeTime();
    const { peers, bridges, client, transport } = setup({ attach: false });
    let connect: () => void = () => undefined;
    const connected = new Promise<void>(resolve => { connect = resolve; });
    transport.ready = vi.fn(() => connected);
    setTimeout(() => connect(), 300);
    peers.attach(transport);
    bridges.present = [STUDIO];
    bridges.hold.set(STUDIO, holding(4));
    client.learnChain.mockImplementation(async () => { client.move(4); return "ahead"; });
    const t0 = Date.now();
    let resolvedAt = -1;
    void peers.prepare(HEAD2).then(() => { resolvedAt = Date.now(); });
    await quiet();
    expect(bridges.log).toEqual([]);
    expect(resolvedAt).toBe(-1);
    await advance(300);
    expect(resolvedAt).toBe(t0 + 300);
    expect(bridges.log.filter(line => line.includes("chain"))).toEqual([`${STUDIO} chain 0`]);
    expect(client.learnChain).toHaveBeenCalledOnce();
    expect(client.heads).toEqual(chainHeads(4));
  });

  it("a connection that never becomes usable: exactly 2 s, nobody asked, no error", async () => {
    fakeTime();
    const { peers, bridges, transport } = setup({ attach: false });
    transport.ready = vi.fn(() => new Promise<void>(() => undefined));
    peers.attach(transport);
    bridges.present = [STUDIO];
    bridges.hold.set(STUDIO, holding(4));
    const done = vi.fn();
    const failed = vi.fn();
    void peers.prepare(HEAD2).then(done, failed);
    await advance(PREPARE_BUDGET_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await advance(1);
    expect(done).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    expect(bridges.log).toEqual([]);
    expect(transport.presence).not.toHaveBeenCalled();
  });

  it("nothing attached (e.g. the pairing page): prepare resolves at once, reads nothing, sets no timer", async () => {
    fakeTime();
    const { peers, transport } = setup({ attach: false });
    const done = vi.fn();
    void peers.prepare(HEAD2).then(done);
    await quiet();
    expect(done).toHaveBeenCalledOnce();
    expect(transport.ready).not.toHaveBeenCalled();
    expect(transport.presence).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("on connect, compares as soon as the connection is usable, without waiting for a presence poll", async () => {
    fakeTime();
    const { peers, bridges, transport } = setup({ attach: false });
    let connect: () => void = () => undefined;
    const connected = new Promise<void>(resolve => { connect = resolve; });
    transport.ready = vi.fn(() => connected);
    bridges.present = [STUDIO, "stranger-9"];
    bridges.hold.set(STUDIO, holding(2));
    peers.attach(transport);
    await quiet();
    expect(bridges.log).toEqual([]);
    connect();
    await quiet();
    expect(bridges.log).toEqual([`${STUDIO} head`]);
    // Repeats keep the per-computer spacing.
    peers.checkAll();
    await quiet();
    expect(transport.presence).toHaveBeenCalledTimes(2);
    expect(bridges.log).toEqual([`${STUDIO} head`]);
  });
});

describe("LedgerPeers announcements", () => {
  it("forged, stale, revoked, own, foreign, unknown and malformed announcements are dropped; a valid unknown head of a computer fetches its chain once", async () => {
    fakeTime();
    const client = new FakeClient();
    client.trusted = checkpoint({ bridges: checkpoint().bridges.filter(item => item.bridgeId === STUDIO), revokedBridgeIds: [AIR] });
    const { peers, bridges, verify } = setup({ client });
    bridges.hold.set(STUDIO, holding(4));
    const now = Date.now();
    const forged = await announcement("bridge", STUDIO, keys.outsider, 4);
    const dropped: unknown[] = [
      forged,
      await announcement("bridge", STUDIO, keys.studio, 4, { at: now - HEAD_ANNOUNCE_MAX_AGE_MS - 1 }),
      await announcement("bridge", STUDIO, keys.studio, 4, { at: now + HEAD_ANNOUNCE_MAX_AGE_MS + 1 }),
      await announcement("bridge", AIR, keys.air, 4),
      await announcement("device", SELF_ID, keys.self, 4),
      await announcement("bridge", STUDIO, keys.studio, 4, { accountId: tok(70) }),
      await announcement("device", tok(77), keys.outsider, 4),
      { type: "ledger_head", head: HEADS[4], revision: 4 },
      { ...forged, extra: 1 },
      { ...forged, version: 2 },
      null, "ledger_head", [],
    ];
    for (const value of dropped) peers.receive(value);
    await advance(1_000);
    // Only the forged one passed the cheap checks; its signature failed.
    expect(verify).toHaveBeenCalledOnce();
    expect(bridges.log).toEqual([]);
    expect(client.learnChain).not.toHaveBeenCalled();
    expect(client.peers?.confirmed).toEqual([]);
    peers.receive(await announcement("bridge", STUDIO, keys.studio, 4));
    await quiet();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(bridges.log).toEqual([`${STUDIO} chain 0`]);
    expect(client.learnChain).toHaveBeenCalledExactlyOnceWith(chainOf(fakeRecords(4)), "peer", "bridge studio-m");
  });

  it("a burst of 100: at most one fetch per computer and one signature check each (excess dropped, replays not re-checked)", async () => {
    fakeTime();
    const { peers, bridges, client, verify } = setup();
    bridges.hold.set(STUDIO, holding(4));
    const now = Date.now();
    const burst = await Promise.all(Array.from({ length: 100 }, (_, index) => announcement("bridge", STUDIO, keys.studio, 4, { at: now - index })));
    for (const item of burst) peers.receive(item);
    await quiet();
    expect(verify.mock.calls.length).toBeLessThanOrEqual(MAX_QUEUED + 1);
    expect(bridges.log).toEqual([`${STUDIO} chain 0`]);
    expect(client.learnChain).toHaveBeenCalledOnce();
    const checked = verify.mock.calls.length;
    const replayed = await announcement("bridge", STUDIO, keys.studio, 4, { at: now - 500 });
    for (let index = 0; index < 100; index += 1) peers.receive(replayed);
    await quiet();
    for (let index = 0; index < 100; index += 1) peers.receive(replayed);
    await quiet();
    expect(verify).toHaveBeenCalledTimes(checked + 1);
    await advance(10_000);
    expect(bridges.log).toEqual([`${STUDIO} chain 0`]);
  });

  it("an announcement is never proof: a computer that cannot back its head with a chain changes nothing", async () => {
    fakeTime();
    const { peers, bridges, client } = setup();
    bridges.silent.add(STUDIO);
    peers.receive(await announcement("bridge", STUDIO, keys.studio, 4));
    await advance(10_000);
    expect(bridges.log).toEqual([`${STUDIO} chain 0`]);
    expect(client.learnChain).not.toHaveBeenCalled();
    expect(client.heads).toEqual(chainHeads(2));
    expect(client.peers).toMatchObject({ head: HEADS[2], confirmed: [], diverged: [] });
  });

  it("a browser announcing an unknown head causes one paced server read; still unknown afterwards it is listed as diverged", async () => {
    fakeTime();
    const { peers, client } = setup();
    let release: () => void = () => undefined;
    client.refresh.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) peers.receive(await announcement("device", OTHER_ID, keys.other, 3, { head: tok(90), at: now - index }));
    await quiet();
    expect(client.refresh).toHaveBeenCalledOnce();
    release();
    await quiet();
    expect(client.peers?.diverged).toEqual([{ kind: "device", id: OTHER_ID, head: tok(90).slice(0, 8), revision: 3 }]);
    // It reports this browser's head later: confirmed, no longer listed.
    peers.receive(await announcement("device", OTHER_ID, keys.other, 2));
    await quiet();
    expect(client.peers).toMatchObject({ confirmed: [{ kind: "device", id: OTHER_ID }], diverged: [] });
    expect(client.refresh).toHaveBeenCalledOnce();
  });

  it("announces this browser's head after subscribe and after every change, at most once per 5 s, coalesced to the latest head", async () => {
    const t0 = fakeTime();
    const { peers, client, published } = setup();
    peers.channelSubscribed();
    await quiet();
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({ type: "ledger_head", version: 1, accountId: ACCOUNT, kind: "device", keyId: SELF_ID, head: HEADS[2], revision: 2, at: t0, signature: expect.any(String) });
    expect(await verifyHeadAnnouncement(checkpoint(), published[0], Date.now())).toBe(true);
    await advance(1_000);
    client.move(3);
    await advance(1_000);
    client.move(4);
    await quiet();
    expect(published).toHaveLength(1);
    await advance(3_000);
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ head: HEADS[4], revision: 4, at: t0 + 5_000 });
    peers.channelSubscribed();
    await advance(4_999);
    expect(published).toHaveLength(2);
    await advance(1);
    expect(published).toHaveLength(3);
    expect(published[2]).toMatchObject({ head: HEADS[4], at: t0 + 10_000 });
  });

  it("announces nothing unless this browser is a trusted device with exactly its keys", async () => {
    fakeTime();
    const wrongKey = setup({ deviceKey: keys.other });
    const notMember = setup();
    notMember.client.trusted = checkpoint({ devices: checkpoint().devices.filter(item => item.endpoint.id !== SELF_ID) });
    const revoked = setup();
    revoked.client.trusted = checkpoint({ revokedDeviceIds: [SELF_ID] });
    for (const item of [wrongKey, notMember, revoked]) {
      item.peers.channelSubscribed();
      item.client.move(3);
    }
    await advance(10_000);
    for (const item of [wrongKey, notMember, revoked]) expect(item.published).toEqual([]);
  });
});

describe("LedgerPeers without a pending write", () => {
  it("a computer coming online is compared once per minute, unless the head it announces changed", async () => {
    fakeTime();
    const { peers, bridges } = setup();
    bridges.hold.set(STUDIO, holding(2));
    peers.setOnline([STUDIO]);
    await quiet();
    expect(bridges.log).toEqual([`${STUDIO} head`]);
    peers.setOnline([]);
    await advance(10_000);
    peers.setOnline([STUDIO]);
    await quiet();
    expect(bridges.log).toHaveLength(1);
    peers.setOnline([]);
    await advance(51_000);
    peers.setOnline([STUDIO]);
    await quiet();
    expect(bridges.log).toHaveLength(2);
    peers.receive(await announcement("bridge", STUDIO, keys.studio, 2));
    await quiet();
    peers.setOnline([]);
    peers.setOnline([STUDIO]);
    await quiet();
    expect(bridges.log).toEqual([`${STUDIO} head`, `${STUDIO} head`, `${STUDIO} head`]);
  });

  it("nothing runs while signed out or before a connection is attached; signing in compares once and announces", async () => {
    fakeTime();
    const detached = setup({ attach: false });
    detached.bridges.hold.set(STUDIO, holding(4));
    detached.peers.setOnline([STUDIO]);
    detached.peers.channelSubscribed();
    detached.peers.receive(await announcement("bridge", STUDIO, keys.studio, 4));
    await expect(detached.peers.prepare(HEAD2)).resolves.toBeUndefined();
    const client = new FakeClient();
    client.heads = null;
    client.trusted = null;
    client.status = "signed_out";
    const signedOut = setup({ client });
    signedOut.bridges.hold.set(STUDIO, holding(2));
    signedOut.peers.setOnline([STUDIO]);
    signedOut.peers.channelSubscribed();
    signedOut.peers.receive(await announcement("bridge", STUDIO, keys.studio, 4));
    const done = vi.fn();
    void signedOut.peers.prepare({ revision: 0, head: ACCOUNT }).then(done);
    await advance(5_000);
    expect(done).toHaveBeenCalledOnce();
    for (const item of [detached, signedOut]) {
      expect(item.bridges.log).toEqual([]);
      expect(item.published).toEqual([]);
      expect(item.verify).not.toHaveBeenCalled();
      expect(item.client.learnChain).not.toHaveBeenCalled();
    }
    expect(detached.transport.request).not.toHaveBeenCalled();
    client.heads = chainHeads(2);
    client.trusted = checkpoint();
    client.status = "ready";
    client.emit();
    await quiet();
    expect(signedOut.bridges.log).toEqual([`${STUDIO} head`]);
    expect(signedOut.published).toHaveLength(1);
  });

  it("a detached connection's late answers are ignored and nothing is sent afterwards", async () => {
    fakeTime();
    const { peers, transport, published, client } = setup({ attach: false });
    let answer: (value: unknown) => void = () => undefined;
    transport.request = vi.fn(() => new Promise(resolve => { answer = resolve; }));
    const detach = peers.attach(transport);
    peers.setOnline([STUDIO]);
    await quiet();
    expect(transport.request).toHaveBeenCalledOnce();
    detach();
    answer({ success: true, data: { accountId: ACCOUNT, head: HEADS[4], revision: 4 } });
    await quiet();
    await expect(peers.prepare(HEAD2)).resolves.toBeUndefined();
    peers.channelSubscribed();
    await advance(10_000);
    expect(transport.request).toHaveBeenCalledOnce();
    expect(client.learnChain).not.toHaveBeenCalled();
    expect(published).toEqual([]);
    expect(client.peers?.online).toEqual([]);
  });

  it("presentBridgeIds lists each present computer once", () => {
    expect(presentBridgeIds({ clients: {
      c1: { connInfo: { bridgeId: STUDIO, hostname: "studio" } }, c2: { connInfo: { bridgeId: STUDIO } }, c3: { connInfo: { user: "browser" } },
      c4: {}, c5: { connInfo: { bridgeId: "not an id" } }, c6: { connInfo: { bridgeId: AIR } }, c7: { connInfo: { bridgeId: 7 } },
    } })).toEqual([STUDIO, AIR]);
    for (const value of [null, undefined, "x", { clients: [] }, { clients: null }]) expect(presentBridgeIds(value)).toEqual([]);
  });
});

// ---- Through the real LedgerClient (real fork choice and passkey signatures; fake server and computers). ----

const ORIGIN = "https://ftown.example";
const RP_ID = "ftown.example";
const b64url = (data: Uint8Array): string => Buffer.from(data).toString("base64url");
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The server's rules (the one acceptance rule, nothing rewritten), one account. */
class FakeServer {
  ledgers = new Map<string, Ledger>();
  nonces = new Set<string>();
  posts: { ledger: unknown; expectHead?: unknown }[] = [];
  /** While set, every GET of a ledger waits for it. */
  gate: Promise<void> | null = null;
  get ledger(): Ledger | null { return this.ledgers.values().next().value ?? null; }
  fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (method === "POST" && url.pathname === "/api/auth/nonce") {
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
      this.nonces.add(nonce);
      return json({ nonce, expiresAt: Date.now() + 60_000 });
    }
    if (url.pathname === "/api/account/ledger" && method === "GET") {
      if (this.gate !== null) await this.gate;
      const accountId = url.searchParams.get("accountId");
      const handle = url.searchParams.get("handle");
      const found = accountId !== null ? this.ledgers.get(accountId) ?? null
        : [...this.ledgers.values()].find(item => item.genesis.payload.handle === handle) ?? null;
      return found !== null ? json({ ledger: found }) : json({ error: "not_found" }, 404);
    }
    if (url.pathname === "/api/account/ledger" && method === "POST") {
      const post = body as { ledger: Ledger; expectHead?: unknown };
      this.posts.push(post);
      return this.offer(post.ledger, typeof post.expectHead === "string" ? post.expectHead : undefined);
    }
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;
  offer = async (candidate: Ledger, expectHead?: string): Promise<Response> => {
    const accountId = await accountIdOf(candidate.genesis.payload);
    const stored = this.ledgers.get(accountId) ?? null;
    if (expectHead !== undefined) {
      if (stored === null) return json({ error: "account_unknown" }, 404);
      const last = stored.transitions[stored.transitions.length - 1];
      if (await ledgerHead(last === undefined ? stored.genesis.payload : last.payload) !== expectHead) return json({ error: "head_changed", ledger: stored }, 409);
    }
    if (stored === null) {
      await verifyLedger(candidate);
      this.ledgers.set(accountId, wire(candidate));
      return json({ decision: "created", ledger: this.ledgers.get(accountId), discarded: 0 }, 201);
    }
    const choice = await chooseLedger(stored, candidate);
    if (choice.decision === "reject") return json({ error: "ledger_rejected", ledger: stored }, 409);
    if (choice.decision === "keep" && choice.relation === "diverged") return json({ error: "diverged", ledger: stored }, 409);
    if (choice.decision === "adopt") this.ledgers.set(accountId, wire(candidate));
    return json({ decision: choice.decision, ledger: this.ledgers.get(accountId), discarded: choice.discarded.records.length });
  };
  signIn = async (proofJson: string): Promise<boolean> => {
    const proof = parseAuthProof(JSON.parse(proofJson));
    if (proof === null || !this.nonces.delete(proof.nonce)) return false;
    const stored = this.ledgers.get(proof.accountId);
    if (stored === undefined) return false;
    const trusted = applyRevocations(await verifyLedger(stored), { deviceIds: [], bridgeIds: [] });
    return verifyAuthProof(trusted, proof, { audience: ORIGIN, purpose: "session" });
  };
}

interface SignOptions { rpId: string; credentialId?: string; allowCredentialIds?: string[] }
/** The owner's passkeys behind the `passkey` dep (real soft authenticator); `calls` counts the prompts. */
class FakeAuthenticator {
  keys: { soft: SoftPasskey; handle: string }[] = [];
  calls: string[] = [];
  readonly module: typeof PasskeyModule = {
    passkeySupported: () => true,
    createPasskey: async (input: { rpId: string; handle: Uint8Array }) => {
      this.calls.push("create");
      const soft = await createSoftPasskey({ rpId: input.rpId, origin: ORIGIN });
      this.keys.push({ soft, handle: b64url(input.handle) });
      return { credentialId: soft.credentialId, publicKey: soft.publicKey };
    },
    signLedgerRecord: async <T extends LedgerGenesis | LedgerTransition>(payload: T, options: SignOptions): Promise<Signed<T>> => {
      this.calls.push("sign");
      const expected = payload.type === "ftown_account_genesis" ? payload.authority.credentialId : payload.credentialId;
      return { payload, signature: await this.key(expected).sign(await ledgerChallenge(payload), { rpId: options.rpId }) };
    },
    identifyPasskey: async () => {
      this.calls.push("identify");
      return { credentialId: this.keys[0].soft.credentialId, handle: this.keys[0].handle };
    },
    signAuthorityConsent: async (input: { accountId: string; authority: { credentialId: string; publicKey: string }; rpId: string }): Promise<PasskeySignature> => {
      this.calls.push("consent");
      return this.key(input.authority.credentialId).sign(await authorityConsentChallenge(input.accountId, input.authority), { rpId: input.rpId });
    },
  } as unknown as typeof PasskeyModule;
  key(credentialId: string): SoftPasskey {
    const found = this.keys.filter(item => item.soft.credentialId === credentialId)[0];
    if (found === undefined) throw new Error("passkey_cancelled");
    return found.soft;
  }
}

interface Browser { client: LedgerClient; replica: LedgerReplica; storage: LedgerReplicaStorage; key: () => AuthKey; endpoint: (accountId: string) => Promise<EndpointIdentity> }
async function browser(server: FakeServer, authenticator: FakeAuthenticator, options: { identity?: Browser; deps?: Partial<LedgerClientDeps> } = {}): Promise<Browser> {
  const storage = options.identity?.storage ?? memoryReplicaStorage();
  const key = options.identity?.key() ?? await generateAuthKey(false);
  const endpoints = new Map<string, Promise<EndpointIdentity>>();
  const endpointOf = options.identity?.endpoint ?? ((accountId: string): Promise<EndpointIdentity> => {
    const found = endpoints.get(accountId) ?? generateEndpoint(accountId, "browser", false);
    endpoints.set(accountId, found);
    return found;
  });
  const replica = new LedgerReplica(storage, () => Date.now());
  const client = new LedgerClient({
    origin: ORIGIN, pageOrigin: ORIGIN, publicOrigin: `${ORIGIN}/`, rpId: RP_ID, fetchImpl: server.fetch, replica, passkey: authenticator.module,
    deviceKey: async () => key, endpoint: endpointOf, signIn: proof => server.signIn(proof), resetDeviceIdentity: async () => undefined,
    now: () => Date.now(), random: () => 0.5, ...options.deps,
  });
  clients.push(client);
  return { client, replica, storage, key: () => key, endpoint: endpointOf };
}
function current(server: FakeServer): Ledger {
  if (server.ledger === null) throw new Error("no ledger");
  return server.ledger;
}
async function signed(ledger: Ledger, authenticator: FakeAuthenticator, operation: LedgerOperation): Promise<Ledger> {
  const key = authenticator.keys[0].soft;
  const payload = nextTransition(await verifyLedger(ledger), key.credentialId, operation, Date.now(), ledgerLastIssuedAt(ledger));
  return { genesis: ledger.genesis, transitions: [...ledger.transitions, { payload, signature: await key.sign(await ledgerChallenge(payload)) }] };
}
async function addDevices(ledger: Ledger, authenticator: FakeAuthenticator, accountId: string, count: number): Promise<Ledger> {
  let result = ledger;
  for (let index = 0; index < count; index += 1) {
    const device = await generateEndpoint(accountId, "browser", false);
    result = await signed(result, authenticator, { type: "add_device", device: { endpoint: device.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label: "Other", approvedAt: Date.now() - 1000 } });
  }
  return result;
}
async function bridgeMember(accountId: string, bridgeId: string): Promise<{ bridge: LedgerBridge; key: AuthKey }> {
  const key = await generateAuthKey(false);
  const identity = await generateEndpoint(accountId, "bridge", false);
  return { bridge: { bridgeId, endpoint: identity.endpoint, authPublicKey: key.publicKey, label: bridgeId, approvedAt: Date.now() - 1000 }, key };
}
/** An account (one browser `a`) with the computer STUDIO as a member, then a second page of the same browser whose beforeSign is LedgerPeers. */
async function account() {
  const server = new FakeServer();
  const authenticator = new FakeAuthenticator();
  const a = await browser(server, authenticator);
  await a.client.createAccount({ passkeyLabel: "Mac", deviceLabel: "Laptop", userName: "owner" });
  const accountId = a.client.snapshot().checkpoint?.accountId as string;
  const studio = await bridgeMember(accountId, STUDIO);
  await a.client.append({ type: "add_bridge", bridge: studio.bridge });
  return { server, authenticator, a, accountId, studio };
}
async function agreement(server: FakeServer, authenticator: FakeAuthenticator, a: Browser, accountId: string, options: { attach?: boolean; transport?: Partial<LedgerPeersTransport> } = {}) {
  let peers: LedgerPeers | null = null;
  const page = await browser(server, authenticator, { identity: a, deps: { beforeSign: head => (peers === null ? Promise.resolve() : peers.prepare(head)) } });
  await page.client.load();
  const created = new LedgerPeers({ client: page.client, heads: () => page.replica.heads(), trusted: () => page.replica.trusted(), deviceKey: async () => a.key() });
  made.push(created);
  peers = created;
  const bridges = new FakeBridges(accountId);
  bridges.mirror(created);
  const published: HeadAnnouncement[] = [];
  const transport = bridges.transport(published, { self: (await a.endpoint(accountId)).endpoint, ...options.transport });
  if (options.attach !== false) created.attach(transport);
  return { page, peers: created, bridges, published, transport };
}
const signs = (authenticator: FakeAuthenticator): number => authenticator.calls.filter(name => name === "sign").length;
const tipHead = async (ledger: Ledger): Promise<string> => (await verifyLedger(ledger)).head;

describe("LedgerPeers with the real ledger client", () => {
  it("a computer holding records the server lost: learnt inside prepare, the change is built on its head with one prompt and one POST", async () => {
    const { server, authenticator, a, accountId } = await account();
    const base = current(server);
    fakeTime();
    const { page, peers, bridges } = await agreement(server, authenticator, a, accountId);
    await bridges.setChain(STUDIO, base);
    peers.setOnline([STUDIO]);
    await quiet();
    expect(bridges.log).toEqual([`${STUDIO} head`]);
    const ahead = await addDevices(base, authenticator, accountId, 1);
    await bridges.setChain(STUDIO, ahead);
    const learn = vi.spyOn(page.client, "learnChain");
    authenticator.calls = [];
    const posts = server.posts.length;
    await page.client.append({ type: "add_bridge", bridge: (await bridgeMember(accountId, "b1")).bridge });
    await quiet();
    expect(learn).toHaveBeenCalledOnce();
    expect(learn.mock.calls[0][0]).toEqual(wire(ahead));
    expect(signs(authenticator)).toBe(1);
    expect(server.posts).toHaveLength(posts + 1);
    expect(server.posts[posts]).toMatchObject({ expectHead: await tipHead(base) });
    expect(current(server).transitions.slice(0, ahead.transitions.length)).toEqual(wire(ahead).transitions);
    expect(current(server).transitions).toHaveLength(ahead.transitions.length + 1);
    expect(page.replica.raw()?.ledger).toEqual(current(server));
  });

  it("H, repair before signing: server rolled back, a computer ahead, the change confirmed right after the dashboard opened -> built on the computer's head, one prompt", async () => {
    const { server, authenticator, a, accountId } = await account();
    // The server lost H2 (rolled back to H1); the computer still holds it; this browser only ever saw H1.
    const h1 = current(server);
    const h2 = await addDevices(h1, authenticator, accountId, 1);
    fakeTime();
    let connect: () => void = () => undefined;
    const connected = new Promise<void>(resolve => { connect = resolve; });
    // The relay connects 300 ms after the dashboard opened, and presence is not readable yet (useBridges has not subscribed).
    const { page, peers, bridges, transport } = await agreement(server, authenticator, a, accountId, {
      attach: false, transport: { ready: () => connected, presence: () => Promise.reject(new Error("permission denied")) },
    });
    await bridges.setChain(STUDIO, h2);
    setTimeout(() => connect(), 300);
    peers.attach(transport);
    authenticator.calls = [];
    const posts = server.posts.length;
    const write = page.client.append({ type: "add_bridge", bridge: (await bridgeMember(accountId, "b1")).bridge });
    await advance(300);
    await write;
    expect(bridges.log.filter(line => line.includes("chain"))).toEqual([`${STUDIO} chain 0`]);
    expect(signs(authenticator)).toBe(1);
    expect(server.posts).toHaveLength(posts + 1);
    expect(server.posts[posts]).toMatchObject({ expectHead: await tipHead(h1) });
    expect(current(server).transitions.slice(0, h2.transitions.length)).toEqual(wire(h2).transitions);
    expect(current(server).transitions).toHaveLength(h2.transitions.length + 1);
    expect(page.replica.raw()?.ledger).toEqual(current(server));
    expect(page.client.snapshot().divergence).toBeNull();
  });

  it("a chain fetched just before a write started (its learnChain queued behind that write) is learnt inside prepare at once", async () => {
    const { server, authenticator, a, accountId, studio } = await account();
    const base = current(server);
    fakeTime();
    const { page, peers, bridges } = await agreement(server, authenticator, a, accountId);
    const ahead = await addDevices(base, authenticator, accountId, 1);
    await bridges.setChain(STUDIO, ahead);
    const learn = vi.spyOn(page.client, "learnChain");
    authenticator.calls = [];
    const posts = server.posts.length;
    let open: () => void = () => undefined;
    server.gate = new Promise<void>(resolve => { open = resolve; });
    // The write holds the client's queue while its fresh read waits; the computer's announcement is fetched meanwhile.
    const done = vi.fn();
    const write = page.client.append({ type: "add_bridge", bridge: (await bridgeMember(accountId, "b1")).bridge }).then(done);
    await quiet();
    const tip = ahead.transitions[ahead.transitions.length - 1].payload;
    peers.receive(await signHeadAnnouncement(studio.key.privateKey, { accountId, kind: "bridge", keyId: STUDIO, head: await ledgerHead(tip), revision: ahead.transitions.length, at: Date.now() }));
    await quiet();
    expect(bridges.log).toEqual([`${STUDIO} chain 0`]);
    expect(learn).toHaveBeenCalledOnce();
    server.gate = null;
    open();
    // No fake timer is advanced: were prepare waiting out its 2 s budget, this would never resolve.
    await write;
    expect(done).toHaveBeenCalledOnce();
    await quiet();
    expect(learn).toHaveBeenCalledTimes(2);
    // The queued call runs after the write: the local chain then extends that chain.
    expect(await learn.mock.results[0].value).toBe("behind");
    expect(await learn.mock.results[1].value).toBe("ahead");
    expect(signs(authenticator)).toBe(1);
    expect(server.posts).toHaveLength(posts + 1);
    expect(current(server).transitions.slice(0, ahead.transitions.length)).toEqual(wire(ahead).transitions);
    expect(current(server).transitions).toHaveLength(ahead.transitions.length + 1);
  });

  it("a computer holding a valid different history: ledger_diverged before any prompt, nothing sent, the computer listed", async () => {
    const { server, authenticator, a, accountId } = await account();
    const base = current(server);
    await a.client.append({ type: "add_bridge", bridge: (await bridgeMember(accountId, "mine")).bridge });
    const other = await addDevices(base, authenticator, accountId, 1);
    fakeTime();
    const { page, peers, bridges } = await agreement(server, authenticator, a, accountId);
    await bridges.setChain(STUDIO, base);
    peers.setOnline([STUDIO]);
    await quiet();
    await bridges.setChain(STUDIO, other);
    authenticator.calls = [];
    const posts = server.posts.length;
    await expect(page.client.append({ type: "add_bridge", bridge: (await bridgeMember(accountId, "b1")).bridge })).rejects.toThrow("ledger_diverged");
    await quiet();
    expect(signs(authenticator)).toBe(0);
    expect(server.posts).toHaveLength(posts);
    expect(page.client.snapshot()).toMatchObject({ divergence: { source: "peer", other: wire(other) } });
    expect(page.client.snapshot().peers?.diverged).toEqual([{ kind: "bridge", id: STUDIO, head: (await tipHead(other)).slice(0, 8), revision: other.transitions.length }]);
  });

  it("a computer offering an invalid chain is ignored with one warning naming it; the change is signed once on the server's head", async () => {
    const { server, authenticator, a, accountId } = await account();
    const base = current(server);
    fakeTime();
    const { page, peers, bridges } = await agreement(server, authenticator, a, accountId);
    await bridges.setChain(STUDIO, base);
    peers.setOnline([STUDIO]);
    await quiet();
    const forged = wire(await addDevices(base, authenticator, accountId, 2));
    forged.transitions[forged.transitions.length - 1].signature = forged.transitions[forged.transitions.length - 2].signature;
    await bridges.setChain(STUDIO, forged);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    authenticator.calls = [];
    await page.client.append({ type: "add_bridge", bridge: (await bridgeMember(accountId, "b1")).bridge });
    await quiet();
    expect(warn.mock.calls.map(call => call[0])).toEqual(["[ledger] ignored an invalid chain from bridge studio-m"]);
    expect(signs(authenticator)).toBe(1);
    expect(current(server).transitions).toHaveLength(base.transitions.length + 1);
    expect(current(server).transitions.slice(0, base.transitions.length)).toEqual(wire(base).transitions);
  });

  it("snapshot.peers through write -> adopt -> confirmations: cleared on every new head, filled by announcements and answers", async () => {
    const { server, authenticator, a, accountId, studio } = await account();
    const phoneKey = await generateAuthKey(false);
    const phone = await generateEndpoint(accountId, "browser", false);
    await a.client.append({ type: "add_device", device: { endpoint: phone.endpoint, authPublicKey: phoneKey.publicKey, label: "Phone", approvedAt: Date.now() - 1000 } });
    const t0 = fakeTime();
    const { page, peers, bridges, published } = await agreement(server, authenticator, a, accountId);
    const h1 = page.replica.raw()?.checkpoint.head as string;
    const r1 = page.replica.raw()?.checkpoint.revision as number;
    peers.channelSubscribed();
    await quiet();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: "device", keyId: (await a.endpoint(accountId)).endpoint.id, head: h1, revision: r1 });
    expect(await verifyHeadAnnouncement(page.replica.trusted() as LedgerCheckpoint, published[0], Date.now())).toBe(true);
    expect(page.client.snapshot().peers).toEqual({ head: h1, confirmed: [], online: [], diverged: [] });
    const say = (key: AuthKey, kind: "device" | "bridge", keyId: string, head: string, revision: number): Promise<HeadAnnouncement> =>
      signHeadAnnouncement(key.privateKey, { accountId, kind, keyId, head, revision, at: Date.now() });
    peers.receive(await say(studio.key, "bridge", STUDIO, h1, r1));
    await quiet();
    expect(page.client.snapshot().peers?.confirmed).toEqual([{ kind: "bridge", id: STUDIO, at: t0 }]);
    // This browser's own write: once the server accepted it, the new head has no confirmation yet.
    await advance(1_000);
    await page.client.append({ type: "add_bridge", bridge: (await bridgeMember(accountId, "b2")).bridge });
    await quiet();
    const h2 = page.replica.raw()?.checkpoint.head as string;
    expect(h2).not.toBe(h1);
    expect(page.client.snapshot().peers).toEqual({ head: h2, confirmed: [], online: [], diverged: [] });
    await advance(4_000);
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ head: h2, revision: r1 + 1 });
    // The computer answers ledger_head with the new head, the phone announces it.
    await bridges.setChain(STUDIO, current(server));
    peers.setOnline([STUDIO]);
    peers.receive(await say(phoneKey, "device", phone.endpoint.id, h2, r1 + 1));
    await quiet();
    expect(page.client.snapshot().peers).toEqual({
      head: h2, online: [STUDIO], diverged: [],
      confirmed: [{ kind: "bridge", id: STUDIO, at: t0 + 5_000 }, { kind: "device", id: phone.endpoint.id, at: t0 + 5_000 }],
    });
  });
});
