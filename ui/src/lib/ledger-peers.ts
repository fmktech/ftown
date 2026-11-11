import { relateHead } from "@security/ledger/ledger";
import type { LedgerHeadRelation, LedgerRelation } from "@security/ledger/ledger";
import { HEAD_ANNOUNCE_MAX_AGE_MS, parseHeadAnnouncement, signHeadAnnouncement, verifyHeadAnnouncement } from "@security/ledger/announce";
import type { HeadAnnouncement } from "@security/ledger/announce";
import { LEDGER_LIMITS } from "@security/ledger/protocol";
import type { Ledger, LedgerCheckpoint } from "@security/ledger/protocol";
import type { EndpointPublic } from "@security/protocol";
import type { LedgerPeersView } from "./ledger-client";

export type { LedgerPeersView };

/*
 * Best-effort agreement between this browser's ledger replica and the account's other online replicas (contract §9-§13, §11 decides):
 * computers are asked over the end-to-end encrypted command RPC (`ledger_head`, paged `ledger_chain`), browsers are heard through their
 * signed head announcements on the account's ledger channel. Silence, timeouts, errors and invalid chains never block and never ask the
 * owner anything. Only a replica that PROVES a longer valid chain (the full chain, through the client's fork choice) changes the local
 * chain; only a proven valid different history blocks signing (ledger_diverged). An announcement is never proof: it only decides whether
 * to fetch a chain (from a computer) or to re-read the server (for a browser).
 * - prepare(): the client's beforeSign hook. Asks every online computer of the trusted checkpoint for its head and considers the
 *   announcements of the last 10 s, for at most 2 s in total.
 * - onBridgeConnected()/checkAll(): the same comparison without a pending write (at most once per computer per minute, unless the head
 *   it announces changed): a browser with no history notices a rolled-back server as soon as one computer is online.
 * - Announcements: this browser's own head (signed with its device auth key) after the channel is subscribed and after every change of
 *   the local head, at most one per 5 s. Received ones: strict parse, own dropped, at most 20 queued, verified one at a time against the
 *   local TRUSTED checkpoint (one signature check each, an already verified signature is not checked again).
 * - snapshot.peers (LedgerPeersView): who reported the current head, which computers are online, which members hold another history.
 * Nothing runs before a transport is attached (the signed-in dashboard's relay connection) or while the browser is not a member of its
 * own bound chain. Nothing is ever POSTed from here: a learnt chain reaches the server only through the client's own re-offer.
 */

/** Total wait of prepare(), whatever the number of replicas. */
export const PREPARE_BUDGET_MS = 2_000;
/** prepare() takes into account announcements received this recently. */
export const RECENT_ANNOUNCEMENT_MS = 10_000;
/** Paged ledger_chain fetch: give up on that computer after this many pages, bytes of record JSON, or milliseconds. */
export const CHAIN_MAX_PAGES = 12;
export const CHAIN_MAX_BYTES = 2.5 * 1024 * 1024;
export const CHAIN_MAX_MS = 3_000;
/** One RPC is given up after this long (the answer may still arrive later; it is then only recorded as a report). */
export const RPC_TIMEOUT_MS = 5_000;
/** onBridgeConnected: one comparison per computer per window, unless the head it announces changed. */
export const CHECK_SPACING_MS = 60_000;
/** At most one chain fetch per computer per window (and one in flight). */
export const FETCH_SPACING_MS = 10_000;
/** This browser announces at most once per window (coalesced to the latest head). */
export const ANNOUNCE_SPACING_MS = 5_000;
/** Received announcements waiting for verification beyond this are dropped. */
export const MAX_QUEUED = 20;
/** A fresh presence read not answered within this (or failed) is replaced by asking every member computer. */
export const PRESENCE_WAIT_MS = 500;
/** Remembered verified signatures (a replay is not verified again). */
const MAX_VERIFIED = 256;
/** At most this many present computers are considered (presence is an unauthenticated hint). */
const MAX_ONLINE = 256;
const MAX_WARNED = 64;
const HEAD = /^[A-Za-z0-9_-]{43}$/;
const BRIDGE_ID = /^[A-Za-z0-9_-]{1,200}$/;

type MemberKind = "device" | "bridge";
/** How a fetch-and-learn ended: the client's relation, an invalid chain, no usable answer (silence, error, cap), or not run (pacing). */
export type PeerOutcome = LedgerRelation | "invalid" | "failed" | "skipped";

/** What LedgerPeers needs of the page's LedgerClient (it satisfies this). */
export interface LedgerPeersClient {
  learnChain(chain: Ledger, source: "peer", from?: string): Promise<LedgerRelation | "invalid">;
  refresh(): Promise<void>;
  snapshot(): { status: string; divergence?: unknown };
  subscribe(listener: () => void): () => void;
  setPeers(view: LedgerPeersView): void;
}

export interface LedgerPeersDeps {
  client: LedgerPeersClient;
  /** ledgerHeads of the local RAW chain (replica.heads()); null while unbound. */
  heads(): readonly string[] | null;
  /** The TRUSTED checkpoint (replica.trusted(): sticky revocations applied); null while unbound. Every membership check uses it. */
  trusted(): LedgerCheckpoint | null;
  /** This browser's device auth key (loadDeviceAuthKey): signs its announcements. */
  deviceKey(): Promise<{ publicKey: string; privateKey: CryptoKey }>;
  sign?: typeof signHeadAnnouncement;
  verify?: typeof verifyHeadAnnouncement;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  warn?: (message: string) => void;
}

/** The signed-in relay connection (useCentrifugo): while one is attached, and only then, LedgerPeers talks to other replicas. */
export interface LedgerPeersTransport {
  /** This browser's endpoint for the account: the announcement keyId; it must be a trusted device for anything to run. */
  self: Pick<EndpointPublic, "id" | "ownerId" | "publicKey">;
  /** One encrypted command to `bridgeId` (payload gets bridgeId); resolves with its command response `{ success, data, error }`. */
  request(bridgeId: string, type: "ledger_head" | "ledger_chain", payload: Record<string, unknown>): Promise<unknown>;
  /** Publishes on the account's ledger channel. */
  publish(announcement: HeadAnnouncement): Promise<unknown>;
  /** Resolves once this connection can carry a request and its answer: connected, commands and ledger channels subscribed. */
  ready(): Promise<void>;
  /** A fresh read of the computers present on the relay (their bridgeIds); rejects when presence cannot be read. */
  presence(): Promise<string[]>;
}

/** The entry points the relay connection feeds (LedgerPeers satisfies it). */
export interface LedgerPeersFeed {
  attach(transport: LedgerPeersTransport): () => void;
  setOnline(bridgeIds: readonly string[]): void;
  receive(value: unknown): void;
  channelSubscribed(): void;
}

/** The bridgeIds a presence result lists (connInfo.bridgeId), unique, in order; anything else is ignored. */
export function presentBridgeIds(presence: unknown): string[] {
  const ids: string[] = [];
  const clients = isPlain(presence) && isPlain(presence.clients) ? presence.clients : {};
  for (const key of Object.keys(clients)) {
    const info = clients[key];
    const connInfo = isPlain(info) ? info.connInfo : undefined;
    const bridgeId = isPlain(connInfo) ? connInfo.bridgeId : undefined;
    if (typeof bridgeId === "string" && BRIDGE_ID.test(bridgeId) && ids.indexOf(bridgeId) === -1) ids.push(bridgeId);
  }
  return ids;
}

interface Report { kind: MemberKind; id: string; head: string; revision: number; at: number; source: "announcement" | "rpc" }
interface Diverged { kind: MemberKind; id: string; head: string; revision: number }
interface ChainPage { head: string; revision: number; fromRevision: number; records: unknown[]; more: boolean }
interface Fetched { ledger: Ledger; head: string; revision: number }
/** The fetch of one computer's chain: in flight (`running`), its chain once fetched (`fetched`, until learnt), when it started. */
interface FetchEntry { running: Promise<PeerOutcome> | null; startedAt: number; fetched: Fetched | null }
interface Context { transport: LedgerPeersTransport; trusted: LedgerCheckpoint; heads: readonly string[] }

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keyOf(kind: MemberKind, id: string): string {
  return `${kind}:${id}`;
}
function isMember(trusted: LedgerCheckpoint, kind: MemberKind, id: string): boolean {
  return kind === "device"
    ? trusted.revokedDeviceIds.indexOf(id) === -1 && trusted.devices.some(item => item.endpoint.id === id)
    : trusted.revokedBridgeIds.indexOf(id) === -1 && trusted.bridges.some(item => item.bridgeId === id);
}
function tipOf(heads: readonly string[] | null): string | null {
  return heads === null || heads.length === 0 ? null : heads[heads.length - 1];
}
function revisionOk(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= LEDGER_LIMITS.maxTransitions;
}
/** The data of a successful command response, else null. */
function successData(response: unknown): Record<string, unknown> | null {
  return isPlain(response) && response.success === true && isPlain(response.data) ? response.data : null;
}
function byteLength(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return Infinity; }
}

export class LedgerPeers implements LedgerPeersFeed {
  private readonly now: () => number;
  private readonly sign: typeof signHeadAnnouncement;
  private readonly verify: typeof verifyHeadAnnouncement;
  private readonly warn: (message: string) => void;
  private transport: LedgerPeersTransport | null = null;
  /** Bumped by every attach/detach: answers of an older connection are dropped. */
  private generation = 0;
  private online: string[] = [];
  /** The latest head each member reported (verified announcement or ledger_head answer), by kind:id. */
  private readonly reports = new Map<string, Report>();
  /** The latest head each computer ANNOUNCED (drives the onBridgeConnected spacing). */
  private readonly announced = new Map<string, string>();
  private readonly divergedMembers = new Map<string, Diverged>();
  private readonly fetches = new Map<string, FetchEntry>();
  /** >0 while prepare() waits (the client's beforeSign hook is running). */
  private preparing = 0;
  /** The connection generation whose checkAll() is running, else null. */
  private checking: number | null = null;
  private readonly checks = new Map<string, { at: number; announced: string | null }>();
  private queue: HeadAnnouncement[] = [];
  private draining = false;
  /** The signature of the announcement being verified/handled now. */
  private handling: string | null = null;
  private readonly verified: string[] = [];
  private refreshing: Promise<boolean> | null = null;
  private lastHead: string | null = null;
  private wasReady = false;
  private announceTimer: unknown = null;
  private lastAnnounceAt = -Infinity;
  private viewScheduled = false;
  private viewKey = "";
  private readonly warned = new Set<string>();
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: LedgerPeersDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sign = deps.sign ?? signHeadAnnouncement;
    this.verify = deps.verify ?? verifyHeadAnnouncement;
    this.warn = deps.warn ?? (message => console.warn(message));
    this.unsubscribe = deps.client.subscribe(this.onClientChange);
  }

  // ---- The agreement step before signing. ----

  /**
   * The client's beforeSign hook; everything below shares ONE budget of PREPARE_BUDGET_MS, then it returns (late answers are still used
   * afterwards). Nothing attached (no signed-in relay connection, e.g. the pairing page): returns at once. A connection still opening is
   * waited for. Then, in parallel: `ledger_head` to every computer of the trusted checkpoint already known online, a FRESH presence read
   * (each member computer it newly lists is asked at once; when it fails or does not answer within PRESENCE_WAIT_MS, every member
   * computer is asked: one that is offline simply does not answer), and the announcements of the last 10 s. At most one `ledger_head`
   * per member computer per call. A computer whose head is unknown here gives its chain (paged ledger_chain) to learnChain: 'ahead' is
   * adopted (the client then builds on the new head), 'invalid' is ignored. A browser announcing an unknown head causes a paced server
   * read. Throws Error('ledger_diverged') only when a computer proved a valid different history (the client is then in its divergence
   * state), never for silence, timeouts or errors; never while the client already holds a divergence (the owner's resolution then needs
   * this step to pass).
   */
  prepare = async (_head: { revision: number; head: string }): Promise<void> => {
    const transport = this.transport;
    if (transport === null || this.ready() === null) return;
    const started = this.now();
    const deadline = started + PREPARE_BUDGET_MS;
    const resolving = this.deps.client.snapshot().divergence != null;
    this.preparing += 1;
    try {
      // A connection still opening (relay, commands or ledger channel): wait for it within the budget rather than ask nobody.
      if (await this.within(this.usable(transport), deadline) === null) return;
      const context = this.ready();
      if (context === null || context.transport !== transport) return;
      const batch = this.batch(deadline, !resolving);
      const asked = new Set<string>();
      const ask = (bridgeId: string): void => {
        const trusted = this.deps.trusted();
        if (asked.has(bridgeId) || trusted === null || !isMember(trusted, "bridge", bridgeId)) return;
        asked.add(bridgeId);
        // This counts as the computer's comparison for the onBridgeConnected spacing.
        this.checks.set(bridgeId, { at: this.now(), announced: this.announced.get(bridgeId) ?? null });
        batch.add(this.compareBridge(bridgeId));
      };
      for (const bridgeId of this.onlineMembers(context.trusted)) ask(bridgeId);
      batch.add(this.discover(transport, ask, deadline));
      for (const report of Array.from(this.reports.values())) {
        if (report.source !== "announcement" || started - report.at > RECENT_ANNOUNCEMENT_MS || this.relation(report) !== "unknown") continue;
        if (report.kind === "bridge") {
          if (asked.has(report.id) || !isMember(context.trusted, "bridge", report.id)) continue;
          asked.add(report.id);
          batch.add(this.learnFrom(report.id));
        } else {
          batch.add(this.refreshFor(report).then(() => "skipped" as const));
        }
      }
      await batch.close();
    } finally {
      this.preparing -= 1;
    }
  };

  /**
   * A set of tasks that may grow until close(): close() resolves when every task added settled, or at `deadline`, and rejects with
   * ledger_diverged on the first proven divergence when `strict`.
   */
  private batch(deadline: number, strict: boolean): { add(task: Promise<PeerOutcome>): void; close(): Promise<void> } {
    let left = 0;
    let closed = false;
    let done = false;
    let settle: (error?: Error) => void = () => undefined;
    const finished = new Promise<void>((resolve, reject) => {
      settle = error => { if (error === undefined) resolve(); else reject(error); };
    });
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      this.clearTimer(timer);
      settle(error);
    };
    const timer = this.setTimer(() => finish(), Math.max(0, deadline - this.now()));
    const one = (): void => {
      left -= 1;
      if (closed && left === 0) finish();
    };
    return {
      add: task => {
        left += 1;
        task.then(outcome => {
          if (strict && outcome === "diverged") finish(new Error("ledger_diverged"));
          one();
        }, one);
      },
      close: () => {
        closed = true;
        if (left === 0) finish();
        return finished;
      },
    };
  }

  /**
   * prepare()'s fresh presence read: every member computer it lists is asked (`ask` skips those already asked and non-members); when it
   * fails or does not answer within PRESENCE_WAIT_MS, every member computer of the trusted checkpoint is asked.
   */
  private async discover(transport: LedgerPeersTransport, ask: (bridgeId: string) => void, deadline: number): Promise<PeerOutcome> {
    const present = await this.readPresence(transport, Math.min(deadline, this.now() + PRESENCE_WAIT_MS));
    const trusted = this.deps.trusted();
    if (this.transport !== transport || trusted === null) return "failed";
    if (present === null) {
      for (const bridge of trusted.bridges) ask(bridge.bridgeId);
      return "skipped";
    }
    for (const bridgeId of present) ask(bridgeId);
    this.setOnline(present);
    return "skipped";
  }

  /** The relay's present computers, read now; null when the read fails, answers garbage, or `until` passes first. */
  private async readPresence(transport: LedgerPeersTransport, until: number): Promise<string[] | null> {
    const found = await this.within(Promise.resolve().then(() => transport.presence()), until);
    if (found === null || !Array.isArray(found.value)) return null;
    return found.value.filter((id): id is string => typeof id === "string" && BRIDGE_ID.test(id)).slice(0, MAX_ONLINE);
  }

  /** The connection's readiness (a transport that throws rejects). */
  private usable(transport: LedgerPeersTransport): Promise<void> {
    return Promise.resolve().then(() => transport.ready());
  }

  /** `work`'s value, or null when it rejects or `until` passes first. */
  private within<T>(work: Promise<T>, until: number): Promise<{ value: T } | null> {
    return new Promise(resolve => {
      let done = false;
      const finish = (result: { value: T } | null): void => {
        if (done) return;
        done = true;
        this.clearTimer(timer);
        resolve(result);
      };
      const timer = this.setTimer(() => finish(null), Math.max(0, until - this.now()));
      work.then(value => finish({ value }), () => finish(null));
    });
  }

  // ---- Comparison without a pending write. ----

  /**
   * A computer came online (presence): compare once with it, at most once per CHECK_SPACING_MS unless the head it announces changed.
   * Non-members are never asked. Never throws.
   */
  onBridgeConnected(bridgeId: string): void {
    const context = this.ready();
    if (context === null || !isMember(context.trusted, "bridge", bridgeId)) return;
    const now = this.now();
    const announced = this.announced.get(bridgeId) ?? null;
    const last = this.checks.get(bridgeId);
    if (last !== undefined && now - last.at < CHECK_SPACING_MS && last.announced === announced) return;
    this.checks.set(bridgeId, { at: now, announced });
    void this.compareBridge(bridgeId);
  }

  /**
   * The comparison without a pending write (after attach, sign-in, each subscribe): once the connection is usable, a fresh presence
   * read, then onBridgeConnected for every member computer present, or for every member computer when presence cannot be read. One run
   * at a time per connection; the per-computer spacing applies.
   */
  checkAll(): void {
    const transport = this.transport;
    if (transport === null || this.ready() === null || this.checking === this.generation) return;
    const generation = this.generation;
    this.checking = generation;
    void (async () => {
      try {
        await this.usable(transport);
        if (generation !== this.generation) return;
        const present = await this.readPresence(transport, this.now() + PRESENCE_WAIT_MS);
        const context = this.ready();
        if (generation !== this.generation || context === null) return;
        if (present === null) {
          for (const bridge of context.trusted.bridges) this.onBridgeConnected(bridge.bridgeId);
          return;
        }
        this.setOnline(present);
        for (const bridgeId of this.onlineMembers(context.trusted)) this.onBridgeConnected(bridgeId);
      } finally {
        if (this.checking === generation) this.checking = null;
      }
    })();
  }

  /** `ledger_head`, then (unknown head) the chain through learnChain. Never rejects. */
  private async compareBridge(bridgeId: string): Promise<PeerOutcome> {
    try {
      const answer = await this.askHead(bridgeId);
      if (answer === null) return "failed";
      const relation = this.relation(answer);
      if (relation === null) return "failed";
      if (relation !== "unknown") {
        this.clearDiverged("bridge", bridgeId);
        return relation;
      }
      return await this.learnFrom(bridgeId);
    } catch {
      return "failed";
    }
  }

  /** The computer's `{ head, revision }` (recorded as its report), or null for silence, an error, a refusal or a malformed answer. */
  private async askHead(bridgeId: string): Promise<{ head: string; revision: number } | null> {
    const data = successData(await this.call(bridgeId, "ledger_head", {}));
    const trusted = this.deps.trusted();
    if (data === null || trusted === null || data.accountId !== trusted.accountId) return null;
    const { head, revision } = data;
    if (typeof head !== "string" || !HEAD.test(head) || !revisionOk(revision)) return null;
    this.record({ kind: "bridge", id: bridgeId, head, revision, at: this.now(), source: "rpc" });
    return { head, revision };
  }

  /**
   * One fetch-and-learn per computer at a time (callers join it) and at most one per FETCH_SPACING_MS ('skipped'). Inside prepare(), a
   * chain already fetched whose learnChain waits on the client's queue (held by the very write being prepared) is learnt again at once
   * (learnChain runs immediately during the hook); the queued call later finds the local chain the same or ahead of it.
   */
  private learnFrom(bridgeId: string): Promise<PeerOutcome> {
    const entry = this.fetches.get(bridgeId);
    if (entry !== undefined && entry.running !== null) {
      return this.preparing > 0 && entry.fetched !== null ? this.learn(bridgeId, entry.fetched).catch(() => "failed" as const) : entry.running;
    }
    const now = this.now();
    if (entry !== undefined && now - entry.startedAt < FETCH_SPACING_MS) return Promise.resolve("skipped");
    const fetch: FetchEntry = { running: null, startedAt: now, fetched: null };
    const running: Promise<PeerOutcome> = this.fetchAndLearn(bridgeId, fetch).catch(() => "failed" as const).then(outcome => {
      fetch.running = null;
      fetch.fetched = null;
      return outcome;
    });
    fetch.running = running;
    this.fetches.set(bridgeId, fetch);
    return running;
  }

  private async fetchAndLearn(bridgeId: string, fetch: FetchEntry): Promise<PeerOutcome> {
    const fetched = await this.fetchChain(bridgeId);
    if (fetched === null) return "failed";
    if (fetched === "invalid") {
      this.warnInvalid(bridgeId);
      return "invalid";
    }
    if (this.disposed) return "failed";
    fetch.fetched = fetched;
    return this.learn(bridgeId, fetched);
  }

  /** The fetched chain through the client's fork choice; records what it proved about the computer. */
  private async learn(bridgeId: string, fetched: Fetched): Promise<PeerOutcome> {
    const before = tipOf(this.deps.heads());
    // The client warns (once) about an invalid chain under this name.
    const result = await this.deps.client.learnChain(fetched.ledger, "peer", `bridge ${bridgeId.slice(0, 8)}`);
    if (result === "invalid") return "invalid";
    const after = tipOf(this.deps.heads());
    // 'diverged' with the local chain unchanged (or a divergence held): the divergence state. Else the owner's resolution was adopted.
    if (result === "diverged" && (after === before || this.deps.client.snapshot().divergence != null)) {
      this.record({ kind: "bridge", id: bridgeId, head: fetched.head, revision: fetched.revision, at: this.now(), source: "rpc" });
      this.markDiverged({ kind: "bridge", id: bridgeId, head: fetched.head, revision: fetched.revision });
      return "diverged";
    }
    // Adopted (an extension, or the owner's resolution), the same, or behind: the computer holds no other history.
    this.clearDiverged("bridge", bridgeId);
    const heads = this.deps.heads();
    if (after !== null && heads !== null && (result === "ahead" || result === "same" || result === "diverged")) {
      this.record({ kind: "bridge", id: bridgeId, head: after, revision: heads.length - 1, at: this.now(), source: "rpc" });
    }
    return result === "diverged" ? "ahead" : result;
  }

  /**
   * The computer's whole chain by paged ledger_chain (restarted from 0 when its tip moves between pages), rebuilt as
   * `{ genesis, transitions }`. Null: given up (silence, error, refusal, CHAIN_MAX_PAGES / CHAIN_MAX_BYTES / CHAIN_MAX_MS); 'invalid': a
   * page that contradicts the wire contract.
   */
  private async fetchChain(bridgeId: string): Promise<Fetched | "invalid" | null> {
    const trusted = this.deps.trusted();
    if (trusted === null) return null;
    const capAt = this.now() + CHAIN_MAX_MS;
    let records: unknown[] = [];
    let tip: { head: string; revision: number } | null = null;
    let bytes = 0;
    for (let pages = 0; ; pages += 1) {
      if (pages >= CHAIN_MAX_PAGES || this.now() >= capAt) return null;
      const response = await this.call(bridgeId, "ledger_chain", { fromRevision: records.length }, capAt);
      if (response === undefined || this.now() > capAt) return null;
      if (!isPlain(response) || response.success !== true) return null;
      const page = this.parsePage(response.data, trusted.accountId);
      if (page === null || page.fromRevision !== records.length) return "invalid";
      if (tip !== null && (page.head !== tip.head || page.revision !== tip.revision)) {
        records = [];
        bytes = 0;
        tip = null;
        continue;
      }
      tip = { head: page.head, revision: page.revision };
      bytes += byteLength(page.records);
      if (bytes > CHAIN_MAX_BYTES) return null;
      records = records.concat(page.records);
      if (records.length > tip.revision + 1) return "invalid";
      if (!page.more) break;
      if (page.records.length === 0) return "invalid";
    }
    if (tip === null || records.length !== tip.revision + 1) return "invalid";
    return { ledger: { genesis: records[0], transitions: records.slice(1) } as Ledger, head: tip.head, revision: tip.revision };
  }

  private parsePage(data: unknown, accountId: string): ChainPage | null {
    if (!isPlain(data) || data.accountId !== accountId) return null;
    const { head, revision, fromRevision, records, more } = data;
    if (typeof head !== "string" || !HEAD.test(head) || !revisionOk(revision) || typeof more !== "boolean") return null;
    if (typeof fromRevision !== "number" || !Number.isSafeInteger(fromRevision) || fromRevision < 0) return null;
    if (!Array.isArray(records) || records.length > LEDGER_LIMITS.maxTransitions + 1 || !records.every(isPlain)) return null;
    return { head, revision, fromRevision, records, more };
  }

  /** One RPC, given up after RPC_TIMEOUT_MS (or at `until`): undefined then, on an error, or when the connection changed meanwhile. */
  private call(bridgeId: string, type: "ledger_head" | "ledger_chain", payload: Record<string, unknown>, until = Infinity): Promise<unknown> {
    const transport = this.transport;
    if (transport === null) return Promise.resolve(undefined);
    const generation = this.generation;
    return new Promise(resolve => {
      let done = false;
      const finish = (value: unknown): void => {
        if (done) return;
        done = true;
        this.clearTimer(timer);
        resolve(generation === this.generation && !this.disposed ? value : undefined);
      };
      const timer = this.setTimer(() => finish(undefined), Math.max(0, Math.min(RPC_TIMEOUT_MS, until - this.now())));
      let sent: Promise<unknown>;
      try {
        sent = Promise.resolve(transport.request(bridgeId, type, { ...payload, bridgeId }));
      } catch {
        sent = Promise.resolve(undefined);
      }
      sent.then(finish, () => finish(undefined));
    });
  }

  // ---- Announcements. ----

  /**
   * A publication of the ledger channel (after the relay's own-account filter). Strict parse; own, other-account, stale and non-member
   * announcements are dropped without signature work; an already verified signature is dropped (a replay); beyond MAX_QUEUED waiting
   * ones it is dropped. Each queued one is verified (one signature check) against the local trusted checkpoint, then: the computer's
   * unknown head → its chain is fetched (paced) and learnt; a browser's unknown head → a paced server read; same/behind → recorded only.
   */
  receive(value: unknown): void {
    if (this.disposed || this.transport === null) return;
    const announcement = parseHeadAnnouncement(value);
    const trusted = this.deps.trusted();
    if (announcement === null || trusted === null || announcement.accountId !== trusted.accountId) return;
    if (announcement.kind === "device" && announcement.keyId === this.transport.self.id) return;
    if (Math.abs(this.now() - announcement.at) > HEAD_ANNOUNCE_MAX_AGE_MS || !isMember(trusted, announcement.kind, announcement.keyId)) return;
    const signature = announcement.signature;
    if (signature === this.handling || this.verified.indexOf(signature) !== -1 || this.queue.some(item => item.signature === signature)) return;
    if (this.queue.length >= MAX_QUEUED) return;
    this.queue.push(announcement);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const next = this.queue.shift() as HeadAnnouncement;
        this.handling = next.signature;
        try { await this.handle(next); } catch { /* one announcement never stops the queue */ }
        this.handling = null;
      }
    } finally {
      this.draining = false;
      this.handling = null;
    }
  }

  private async handle(announcement: HeadAnnouncement): Promise<void> {
    const trusted = this.deps.trusted();
    if (trusted === null || this.transport === null) return;
    if (!await this.verify(trusted, announcement, this.now())) return;
    this.verified.push(announcement.signature);
    if (this.verified.length > MAX_VERIFIED) this.verified.shift();
    const { kind, keyId: id, head, revision } = announcement;
    if (this.transport === null || !isMember(this.deps.trusted() ?? trusted, kind, id)) return;
    if (kind === "bridge") this.announced.set(id, head);
    const report: Report = { kind, id, head, revision, at: this.now(), source: "announcement" };
    this.record(report);
    const relation = this.relation(report);
    if (relation === null) return;
    if (relation !== "unknown") {
      this.clearDiverged(kind, id);
      return;
    }
    if (kind === "bridge") void this.learnFrom(id);
    else void this.refreshFor(report);
  }

  /** A paced server read for a browser's unknown head (one at a time); a head still unknown after a read that succeeded is another history. */
  private async refreshFor(report: Report): Promise<void> {
    if (this.refreshing === null) {
      const run: Promise<boolean> = this.deps.client.refresh().then(() => true, () => false).then(ok => {
        if (this.refreshing === run) this.refreshing = null;
        return ok;
      });
      this.refreshing = run;
    }
    const ok = await this.refreshing;
    if (!ok || this.disposed) return;
    const latest = this.reports.get(keyOf(report.kind, report.id));
    if (latest === undefined || latest.head !== report.head) return;
    if (this.relation(report) === "unknown") this.markDiverged({ kind: report.kind, id: report.id, head: report.head, revision: report.revision });
    else this.clearDiverged(report.kind, report.id);
  }

  /** After the channel is (re)subscribed: announce this browser's head and compare with every online computer. */
  channelSubscribed(): void {
    if (this.disposed || this.transport === null) return;
    this.announceSoon();
    this.checkAll();
  }

  /** At most one announcement per ANNOUNCE_SPACING_MS; a request inside the window is coalesced into one at its end (latest head). */
  private announceSoon(): void {
    if (this.disposed || this.transport === null || this.announceTimer !== null) return;
    const wait = this.lastAnnounceAt + ANNOUNCE_SPACING_MS - this.now();
    if (wait <= 0) {
      void this.announceNow();
      return;
    }
    this.announceTimer = this.setTimer(() => {
      this.announceTimer = null;
      void this.announceNow();
    }, wait);
  }

  /** Signs and publishes this browser's head: only while attached, bound, ready, and a trusted device with exactly these keys. */
  private async announceNow(): Promise<void> {
    if (this.ready() === null) return;
    this.lastAnnounceAt = this.now();
    const generation = this.generation;
    try {
      const key = await this.deps.deviceKey();
      const context = this.ready();
      if (context === null || generation !== this.generation) return;
      const self = context.transport.self;
      const entry = context.trusted.devices.filter(item => item.endpoint.id === self.id)[0];
      if (entry === undefined || entry.authPublicKey !== key.publicKey || entry.endpoint.publicKey !== self.publicKey) return;
      const head = tipOf(context.heads);
      if (head === null) return;
      const announcement = await this.sign(key.privateKey, {
        accountId: context.trusted.accountId, kind: "device", keyId: self.id, head, revision: context.heads.length - 1, at: this.now(),
      });
      if (generation !== this.generation || this.transport !== context.transport) return;
      await context.transport.publish(announcement);
    } catch {
      // Best effort: the next head change or subscribe announces again.
    }
  }

  // ---- Connection. ----

  /** The signed-in relay connection; returns its detach. A new attach replaces the previous one. */
  attach(transport: LedgerPeersTransport): () => void {
    if (this.disposed) return () => {};
    this.generation += 1;
    this.transport = transport;
    this.online = [];
    this.queue = [];
    this.lastHead = tipOf(this.deps.heads());
    // channelSubscribed() announces (and compares again) for a connection that is ready now; onClientChange for one that becomes ready.
    this.wasReady = this.ready() !== null;
    const generation = this.generation;
    this.scheduleView();
    // Compare as soon as the connection can carry requests, not only once presence was first polled.
    this.checkAll();
    return () => {
      if (this.generation === generation) this.detach();
    };
  }

  private detach(): void {
    this.generation += 1;
    this.transport = null;
    this.online = [];
    this.queue = [];
    this.wasReady = false;
    if (this.announceTimer !== null) this.clearTimer(this.announceTimer);
    this.announceTimer = null;
    this.scheduleView();
  }

  /** The computers present on the relay (presence): each one newly present is compared once (onBridgeConnected). */
  setOnline(bridgeIds: readonly string[]): void {
    if (this.disposed || this.transport === null) return;
    const next: string[] = [];
    for (const id of bridgeIds) {
      if (typeof id === "string" && BRIDGE_ID.test(id) && next.indexOf(id) === -1 && next.length < MAX_ONLINE) next.push(id);
    }
    next.sort();
    const before = this.online;
    this.online = next;
    for (const id of next) if (before.indexOf(id) === -1) this.onBridgeConnected(id);
    this.scheduleView();
  }

  /** The current peers view (what snapshot.peers shows once published). */
  view(): LedgerPeersView {
    const heads = this.deps.heads();
    const trusted = this.deps.trusted();
    const head = tipOf(heads);
    if (head === null || trusted === null) return { head: "", confirmed: [], online: [], diverged: [] };
    const order = (a: { kind: string; id: string }, b: { kind: string; id: string }): number => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    const confirmed = Array.from(this.reports.values())
      .filter(report => report.head === head && isMember(trusted, report.kind, report.id))
      .map(report => ({ kind: report.kind, id: report.id, at: report.at })).sort(order);
    const diverged = Array.from(this.divergedMembers.values())
      .filter(entry => isMember(trusted, entry.kind, entry.id))
      .map(entry => ({ kind: entry.kind, id: entry.id, head: entry.head.slice(0, 8), revision: entry.revision })).sort(order);
    return { head, confirmed, online: this.onlineMembers(trusted), diverged };
  }

  /** Stops everything for good (with the client): no timer, no request, no announcement afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    this.unsubscribe();
  }

  // ---- Internals. ----

  /** Everything needs: an attached connection, a bound replica, a ready client, and this browser a trusted device of that account. */
  private ready(): Context | null {
    const transport = this.transport;
    if (this.disposed || transport === null) return null;
    const trusted = this.deps.trusted();
    const heads = this.deps.heads();
    if (trusted === null || heads === null || this.deps.client.snapshot().status !== "ready") return null;
    const self = transport.self;
    if (self.ownerId !== trusted.accountId || trusted.revokedDeviceIds.indexOf(self.id) !== -1) return null;
    if (!trusted.devices.some(item => item.endpoint.id === self.id && item.endpoint.publicKey === self.publicKey)) return null;
    return { transport, trusted, heads };
  }

  private onlineMembers(trusted: LedgerCheckpoint): string[] {
    return this.transport === null ? [] : this.online.filter(id => isMember(trusted, "bridge", id));
  }

  /** relateHead against the local chain; null when unbound or the head is malformed. */
  private relation(other: { revision: number; head: string }): LedgerHeadRelation | null {
    const heads = this.deps.heads();
    if (heads === null) return null;
    try { return relateHead(heads, { revision: other.revision, head: other.head }); } catch { return null; }
  }

  private record(report: Report): void {
    this.reports.set(keyOf(report.kind, report.id), report);
    this.scheduleView();
  }

  private markDiverged(entry: Diverged): void {
    this.divergedMembers.set(keyOf(entry.kind, entry.id), entry);
    this.scheduleView();
  }

  private clearDiverged(kind: MemberKind, id: string): void {
    if (this.divergedMembers.delete(keyOf(kind, id))) this.scheduleView();
  }

  /** Every client publication: a new local head (any adopt, own write included) is announced; members that left are forgotten. */
  private onClientChange = (): void => {
    if (this.disposed) return;
    const tip = tipOf(this.deps.heads());
    const headChanged = tip !== this.lastHead;
    const ready = this.ready() !== null;
    // Became able to talk (the replica finished loading, or this browser became a member) while connected: as after a subscribe.
    const becameReady = ready && !this.wasReady;
    this.wasReady = ready;
    if ((headChanged && tip !== null) || becameReady) this.announceSoon();
    if (becameReady) this.checkAll();
    if (headChanged) {
      this.lastHead = tip;
      const trusted = this.deps.trusted();
      for (const [key, entry] of Array.from(this.divergedMembers.entries())) {
        const relation = this.relation(entry);
        if (trusted === null || relation === "same" || relation === "behind" || !isMember(trusted, entry.kind, entry.id)) this.divergedMembers.delete(key);
      }
      if (trusted !== null) {
        for (const [key, report] of Array.from(this.reports.entries())) if (!isMember(trusted, report.kind, report.id)) this.reports.delete(key);
      }
    }
    this.scheduleView();
  };

  /** Publishes the view to the client (snapshot.peers) in a microtask, only when it changed. */
  private scheduleView(): void {
    if (this.viewScheduled || this.disposed) return;
    this.viewScheduled = true;
    void Promise.resolve().then(() => {
      this.viewScheduled = false;
      if (this.disposed) return;
      const view = this.view();
      const key = JSON.stringify(view);
      if (key === this.viewKey) return;
      this.viewKey = key;
      this.deps.client.setPeers(view);
    });
  }

  private warnInvalid(bridgeId: string): void {
    if (this.warned.has(bridgeId)) return;
    if (this.warned.size >= MAX_WARNED) this.warned.clear();
    this.warned.add(bridgeId);
    this.warn(`[ledger] ignored an invalid chain from bridge ${bridgeId.slice(0, 8)}`);
  }

  private setTimer(run: () => void, ms: number): unknown {
    return this.deps.setTimer !== undefined ? this.deps.setTimer(run, ms) : setTimeout(run, ms);
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimer !== undefined) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
