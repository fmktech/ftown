import {
  accountIdOf, applyRevocations, chooseLedger, forkPoint, ledgerHead, ledgerHeads, ledgerLastIssuedAt, ledgerRevocations, parseLedger, relate, verifyLedger,
} from "@security/ledger/ledger";
import type { LedgerChoice, LedgerRelation } from "@security/ledger/ledger";
import type { Ledger, LedgerCheckpoint, LedgerTransition, Signed } from "@security/ledger/protocol";

/*
 * The browser's replica of the account ledger. The one acceptance rule is chooseLedger (shared with the server and the bridges): what is
 * written is never rewritten. A candidate that strictly extends the local chain ('ahead') and verifies is adopted; one that is the same or
 * behind is kept; a VALID different history ('diverged') is never adopted, whatever its length, unless it carries the owner's resolve_fork
 * for exactly this fork (then the local branch is discarded and its removals stay enforced); an invalid candidate changes nothing.
 * - Sticky revocations: every id the adopted chains revoked, plus the removals a resolve_fork discarded (choice.discarded ids). Kept and
 *   rejected candidates add nothing. It never shrinks, not even across clear() (kept per accountId), and trusted() (applyRevocations
 *   output) is the only checkpoint trust decisions use.
 * - Discarded records (local records a resolve_fork dropped, or own signed records the server never took) persist with the account until
 *   dismissed or until their effect is present in the RAW checkpoint, so the owner can sign them again after a reload.
 * - Divergent chains: a valid other history offered with a `source` ('server' | 'relay' | 'peer') is kept, one per source (the newest), so
 *   the owner can be shown both and choose; an entry goes away once the local chain no longer diverges from it or resolved it.
 * - The pending write: one passkey-signed record the server has not accepted yet, persisted with the account but never part of the chain.
 * - An unbound replica binds ONLY on an explicit `bind: true` offer (the caller's own verified chain); never from a server or relay.
 *   Once bound, every other account is rejected until clear().
 * Records are re-verified from genesis on load; writes are compare-and-set on a serial, so concurrent tabs never roll back.
 * Format: version 2. A version-1 record (previous code) loads unchanged: chain, checkpoint, sticky set, discarded records and confirmed
 * server state; it has no pending write and no divergent chain, and the next write stores it as version 2.
 */

export type LedgerSource = "server" | "relay" | "peer";
export const LEDGER_SOURCES: readonly LedgerSource[] = ["server", "relay", "peer"];
export interface StickyRevocations { deviceIds: string[]; bridgeIds: string[] }
/** A passkey-signed record the server has not accepted: its `previousHead`/`revision - 1` name the head it was built on. */
export interface PendingWriteRecord { version: 1; record: Signed<LedgerTransition>; since: number }
/** A valid history of the account that diverges from the local chain; `firstSeen`: when this source first showed this branch. */
export interface DivergentChain { version: 1; ledger: Ledger; firstSeen: number }
export type DivergentChains = Partial<Record<LedgerSource, DivergentChain>>;
/** The bound account's record. `checkpoint` is the RAW chain checkpoint (the chooseLedger cache), never trusted(). */
export interface ReplicaRecord {
  version: 2;
  accountId: string;
  /** Incremented by every write, clear() included; the compare-and-set token. */
  serial: number;
  ledger: Ledger;
  checkpoint: LedgerCheckpoint;
  sticky: StickyRevocations;
  /** Records to show the owner for re-signing; pruned once their effect is in `checkpoint`. */
  discarded: Signed<LedgerTransition>[];
  /** The last server state the client confirmed for this account (see ConfirmedServer). Absent: none known. */
  confirmed?: ConfirmedServer;
  /** The one signed change waiting for the server. Absent: none. */
  pending?: PendingWriteRecord;
  /** Valid other histories, at most one per source. Absent or empty: none. */
  divergence?: DivergentChains;
}
/**
 * What the server held at the last answer the client recorded (a read or a POST answer, after fork choice): its chain's head (and
 * revision) and every id that chain revokes. Kept with the chain so a reload still knows which local removals the server lacks.
 * Versioned; a missing or unreadable value is simply "unknown", never corruption. `revision` is absent in records of the previous code.
 */
export interface ConfirmedServer { version: 1; head: string; revision?: number; revokedDeviceIds: string[]; revokedBridgeIds: string[] }
/** What an account keeps after clear(): its sticky set (and serial), never its chain. */
export interface RetainedRecord { version: 1 | 2; accountId: string; serial: number; ledger: null; checkpoint: null; sticky: StickyRevocations }
export interface LedgerReplicaStorage {
  /** The bound accountId, or null. */
  bound(): Promise<string | null>;
  /** The stored record of `accountId` (bound: ReplicaRecord; after clear(): RetainedRecord), or null. Unvalidated. */
  read(accountId: string): Promise<unknown>;
  /**
   * Atomically stores `record` and binds its account, iff no other account is bound and the stored serial of record.accountId equals
   * `expectedSerial` (null: no record). Returns false when the condition fails (another tab won the race).
   */
  commit(record: ReplicaRecord, expectedSerial: number | null): Promise<boolean>;
  /** Atomically unbinds; the bound record becomes a RetainedRecord with serial + 1 (chain, discarded, pending, divergence dropped; sticky kept). */
  clear(): Promise<void>;
}
/**
 * chooseLedger's verdict as the replica applied it. `relation`: the candidate relative to the local chain (null: no relation, i.e. a
 * first bind, a candidate that is malformed or of another account, or an unbound replica that refused). `discarded`: the local records a
 * divergent adoption (resolve_fork) dropped; empty otherwise.
 */
export interface ReplicaOffer { decision: "adopt" | "keep" | "reject"; relation: LedgerRelation | null; discarded: Signed<LedgerTransition>[] }
export interface ReplicaOfferOptions {
  /** Only `true` lets an unbound replica bind, to the caller's own verified chain. Default false. */
  bind?: boolean;
  /** Reject unless the candidate belongs to this account. */
  expectAccountId?: string;
  /** Where the candidate came from: a valid diverged candidate is then kept as that source's divergent chain. */
  source?: LedgerSource;
}

const MAX_ATTEMPTS = 4;
const MAX_DISCARDED = 256;
const DATABASE = "ftown-ledger";
const VERSION = 1;
const RECORD_VERSION = 2;
const RECORDS = "replicas";
const META = "meta";
const CURRENT = "current";
const HEAD = /^[A-Za-z0-9_-]{43}$/;
const REJECT: ReplicaOffer = { decision: "reject", relation: null, discarded: [] };

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** WebCrypto exists only in secure contexts; an http LAN page must say so instead of reporting an invalid ledger. */
function requireSecureContext(): void {
  if (typeof crypto === "undefined" || !crypto || !crypto.subtle) throw new Error("secure_context_required");
}
function corrupt(): Error {
  return new Error("ledger_replica_corrupt");
}
function union(left: readonly string[], right: readonly string[]): string[] {
  const result = left.slice();
  for (const id of right) if (result.indexOf(id) === -1) result.push(id);
  return result;
}
function stickyOf(value: unknown): StickyRevocations {
  if (!isPlain(value) || Object.keys(value).length !== 2) throw corrupt();
  const { deviceIds, bridgeIds } = value;
  if (!Array.isArray(deviceIds) || !Array.isArray(bridgeIds)) throw corrupt();
  const devices: unknown[] = deviceIds;
  const bridges: unknown[] = bridgeIds;
  if (!devices.every(id => typeof id === "string") || !bridges.every(id => typeof id === "string")) throw corrupt();
  return { deviceIds: devices.map(String), bridgeIds: bridges.map(String) };
}
/** Version 1 (previous code) and 2 (this code) are read; anything else is corrupt. */
function header(value: unknown, accountId: string): { serial: number; sticky: StickyRevocations } {
  if (!isPlain(value) || (value.version !== 1 && value.version !== RECORD_VERSION) || value.accountId !== accountId
    || typeof value.serial !== "number" || !Number.isSafeInteger(value.serial) || value.serial < 1) throw corrupt();
  return { serial: value.serial, sticky: stickyOf(value.sticky) };
}
/** True iff what `record` did is already part of `checkpoint` (the record itself, or a later record that superseded it). */
function effective(checkpoint: LedgerCheckpoint, record: Signed<LedgerTransition>): boolean {
  const operation = record.payload.operation;
  switch (operation.type) {
    case "revoke_device": return checkpoint.revokedDeviceIds.indexOf(operation.endpointId) !== -1;
    case "revoke_bridge": return checkpoint.revokedBridgeIds.indexOf(operation.bridgeId) !== -1;
    case "add_device": {
      const id = operation.device.endpoint.id;
      return checkpoint.devices.some(item => item.endpoint.id === id) || checkpoint.revokedDeviceIds.indexOf(id) !== -1;
    }
    case "add_bridge": {
      const id = operation.bridge.bridgeId;
      return checkpoint.bridges.some(item => item.bridgeId === id) || checkpoint.revokedBridgeIds.indexOf(id) !== -1;
    }
    case "add_authority": return checkpoint.authorities.some(item => item.credentialId === operation.authority.credentialId);
    default: return false;
  }
}
/** `previous` + `added`, de-duplicated by record head, minus every record whose effect `checkpoint` already has; newest last, capped. */
async function mergeDiscarded(checkpoint: LedgerCheckpoint, previous: readonly Signed<LedgerTransition>[], added: readonly Signed<LedgerTransition>[]): Promise<Signed<LedgerTransition>[]> {
  const heads: string[] = [];
  const result: Signed<LedgerTransition>[] = [];
  for (const record of previous.concat(added)) {
    const head = await ledgerHead(record.payload);
    if (heads.indexOf(head) !== -1 || effective(checkpoint, record)) continue;
    heads.push(head);
    result.push(record);
  }
  return result.slice(-MAX_DISCARDED);
}
/** A stored ConfirmedServer, or undefined when absent or not readable (tolerated: it only feeds a display and a hint). */
function confirmedOf(value: unknown): ConfirmedServer | undefined {
  if (!isPlain(value) || value.version !== 1 || typeof value.head !== "string" || !HEAD.test(value.head)) return undefined;
  const ids = (list: unknown): string[] | null => Array.isArray(list) && list.every(id => typeof id === "string") ? (list as string[]).slice() : null;
  const deviceIds = ids(value.revokedDeviceIds);
  const bridgeIds = ids(value.revokedBridgeIds);
  if (deviceIds === null || bridgeIds === null) return undefined;
  const revision = typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : undefined;
  return revision === undefined
    ? { version: 1, head: value.head, revokedDeviceIds: deviceIds, revokedBridgeIds: bridgeIds }
    : { version: 1, head: value.head, revision, revokedDeviceIds: deviceIds, revokedBridgeIds: bridgeIds };
}
function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
/** A stored pending write, or undefined when absent or unreadable (shape only; the client verifies the record before sending it). */
function pendingOf(value: unknown, ledger: Ledger): PendingWriteRecord | undefined {
  if (!isPlain(value) || value.version !== 1 || typeof value.since !== "number" || !Number.isFinite(value.since)) return undefined;
  try {
    const record = parseLedger({ genesis: ledger.genesis, transitions: [value.record] }).transitions[0];
    return record === undefined ? undefined : { version: 1, record, since: value.since };
  } catch {
    return undefined;
  }
}
/** `record` with each optional member set, or without it when undefined (absent members keep stored records minimal). */
function withOptional(record: ReplicaRecord, members: Pick<ReplicaRecord, "confirmed" | "pending" | "divergence">): ReplicaRecord {
  const { confirmed: _confirmed, pending: _pending, divergence: _divergence, ...rest } = record;
  const result: ReplicaRecord = { ...rest };
  if (members.confirmed !== undefined) result.confirmed = members.confirmed;
  if (members.pending !== undefined) result.pending = members.pending;
  if (members.divergence !== undefined && Object.keys(members.divergence).length > 0) result.divergence = members.divergence;
  return result;
}
function sameRecords(left: readonly Signed<LedgerTransition>[], right: readonly Signed<LedgerTransition>[]): boolean {
  return left.length === right.length && JSON.stringify(left) === JSON.stringify(right);
}
/** True iff `ledger` carries a resolve_fork that discarded the branch of the chain whose heads are `other` (its first record after the fork). */
function resolvedBy(ledger: Ledger, other: readonly string[]): boolean {
  return ledger.transitions.some(item => item.payload.operation.type === "resolve_fork" && other.indexOf(item.payload.operation.discardedFirst) !== -1);
}

/** Heads per chain object, computed once (ledgerHeads hashes every record). */
const headCache = new WeakMap<Ledger, string[]>();
async function headsOf(ledger: Ledger): Promise<string[]> {
  const known = headCache.get(ledger);
  if (known !== undefined) return known;
  const heads = await ledgerHeads(ledger);
  headCache.set(ledger, heads);
  return heads;
}
/**
 * A valid other history as it is kept: the local chain's own (verified) records up to the fork point, then the other's records after it
 * (the ones chooseLedger verified). The other's copy of the shared prefix may carry other, unverified signature bytes.
 */
async function spliced(local: Ledger, other: Ledger): Promise<Ledger> {
  const point = forkPoint(await headsOf(local), await headsOf(other));
  if (point === null) return other;
  return { genesis: local.genesis, transitions: local.transitions.slice(0, point.revision).concat(other.transitions.slice(point.revision)) };
}
/** The divergent chains still to show after the local chain became `ledger`: those it diverges from and did not resolve. */
async function stillDivergent(chains: DivergentChains | undefined, ledger: Ledger): Promise<DivergentChains | undefined> {
  if (chains === undefined) return undefined;
  const local = await headsOf(ledger);
  const result: DivergentChains = {};
  for (const source of LEDGER_SOURCES) {
    const entry = chains[source];
    if (entry === undefined) continue;
    try {
      const other = await headsOf(entry.ledger);
      if (relate(local, other) === "diverged" && !resolvedBy(ledger, other)) result[source] = entry;
    } catch {
      // Unreadable: nothing to show.
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
/** Stored divergent chains that still verify as a valid other history of the bound chain; anything else is dropped (tolerated). */
async function divergenceOf(value: unknown, ledger: Ledger, checkpoint: LedgerCheckpoint, now: number): Promise<DivergentChains | undefined> {
  if (!isPlain(value)) return undefined;
  const result: DivergentChains = {};
  for (const source of LEDGER_SOURCES) {
    const entry = value[source];
    if (!isPlain(entry) || entry.version !== 1 || typeof entry.firstSeen !== "number" || !Number.isFinite(entry.firstSeen)) continue;
    try {
      const other = parseLedger(entry.ledger);
      const choice = await chooseLedger(ledger, other, Math.max(now, ledgerLastIssuedAt(other)), { head: checkpoint.head, checkpoint });
      if (choice.decision === "keep" && choice.relation === "diverged") result[source] = { version: 1, ledger: other, firstSeen: entry.firstSeen };
    } catch {
      // Not a valid other history any more: dropped.
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Rebuilds the bound record from scratch: the chain is re-verified from genesis and must match the stored checkpoint. */
async function verifiedRecord(value: unknown, accountId: string, now: number): Promise<{ record: ReplicaRecord; trusted: LedgerCheckpoint; heads: string[] }> {
  const { serial, sticky } = header(value, accountId);
  const stored = value as Record<string, unknown>;
  if (!isPlain(stored.checkpoint)) throw corrupt();
  const storedCheckpoint = stored.checkpoint;
  let ledger: Ledger;
  let checkpoint: LedgerCheckpoint;
  let discarded: Signed<LedgerTransition>[];
  let heads: string[];
  try {
    ledger = parseLedger(stored.ledger);
    // A record this replica already verified must not turn invalid because the wall clock moved backwards.
    checkpoint = await verifyLedger(ledger, Math.max(now, ledgerLastIssuedAt(ledger)));
    if (checkpoint.accountId !== accountId || checkpoint.accountId !== storedCheckpoint.accountId
      || checkpoint.head !== storedCheckpoint.head || checkpoint.revision !== storedCheckpoint.revision) throw corrupt();
    // Shape only (no linkage): discarded records come from abandoned branches.
    discarded = stored.discarded === undefined ? [] : parseLedger({ genesis: ledger.genesis, transitions: stored.discarded }).transitions;
    heads = await headsOf(ledger);
  } catch {
    throw corrupt();
  }
  const trusted = applyRevocations(checkpoint, sticky);
  const divergence = await divergenceOf(stored.divergence, ledger, checkpoint, now);
  const record = withOptional({ version: RECORD_VERSION, accountId, serial, ledger, checkpoint, sticky, discarded }, {
    confirmed: confirmedOf(stored.confirmed), pending: pendingOf(stored.pending, ledger), divergence,
  });
  return { record, trusted, heads };
}

export class LedgerReplica {
  private state: ReplicaRecord | null = null;
  private trustedCheckpoint: LedgerCheckpoint | null = null;
  private localHeads: string[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: LedgerReplicaStorage = indexedDbReplicaStorage(), private readonly now: () => number = Date.now) {}

  /** (Re)reads and re-verifies the bound record. Returns trusted(), or null when unbound. Throws Error('ledger_replica_corrupt') on a bad record. */
  load(): Promise<LedgerCheckpoint | null> {
    return this.serialized(async () => {
      requireSecureContext();
      await this.reload();
      return this.trustedCheckpoint;
    });
  }

  /**
   * The acceptance rule: chooseLedger(local, candidate, now, cache of the RAW local checkpoint), applied as the decision says.
   * - adopt ('ahead', or 'diverged' with an applicable resolve_fork): the candidate is stored; its revocations and the removals the
   *   resolve_fork discarded (choice.discarded ids) join the sticky set; the dropped local records join discarded(); divergent chains
   *   the new chain no longer diverges from (or resolved) are forgotten.
   * - keep ('same' / 'behind' / 'diverged'): the local chain is untouched and nothing is merged. A 'diverged' candidate offered with a
   *   `source` is kept as that source's divergent chain (the newest per source).
   * - reject (invalid, malformed, another account, or an unbound replica without `bind: true`): nothing changes.
   */
  offer(candidate: unknown, options: ReplicaOfferOptions = {}): Promise<ReplicaOffer> {
    return this.serialized(async () => {
      requireSecureContext();
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const current = this.state;
        const next = current === null ? await this.binding(candidate, options) : await this.choosing(current, candidate, options);
        if (next === null) return REJECT;
        const { choice } = next;
        const result: ReplicaOffer = { decision: choice.decision, relation: choice.relation, discarded: choice.decision === "adopt" ? choice.discarded.records : [] };
        if (next.record === null || await this.store(next.record, next.expectedSerial)) return result;
        // Another tab wrote (or cleared) first: decide again against what it stored.
        await this.reload();
      }
      throw new Error("ledger_replica_conflict");
    });
  }

  /** The checkpoint every trust decision uses: the raw checkpoint minus every sticky revocation. Null when unbound. */
  trusted(): LedgerCheckpoint | null {
    return this.trustedCheckpoint;
  }

  /** The stored chain and its RAW checkpoint (the base for the next transition). Never use it for trust decisions. */
  raw(): { ledger: Ledger; checkpoint: LedgerCheckpoint } | null {
    return this.state === null ? null : { ledger: this.state.ledger, checkpoint: this.state.checkpoint };
  }

  /** ledgerHeads of the local chain (index = revision), computed once per adopted chain: the input of relate/relateHead. Null when unbound. */
  heads(): readonly string[] | null {
    return this.localHeads;
  }

  /** Every revocation of an adopted chain of the bound account, and every removal a resolve_fork discarded. */
  sticky(): StickyRevocations | null {
    return this.state === null ? null : { deviceIds: this.state.sticky.deviceIds.slice(), bridgeIds: this.state.sticky.bridgeIds.slice() };
  }

  /** Records to show for re-signing (persisted). Empty when unbound. */
  discarded(): Signed<LedgerTransition>[] {
    return this.state === null ? [] : this.state.discarded.slice();
  }

  /** Adds own records that never became part of the chain (a signed change the server did not take). */
  noteDiscarded(records: Signed<LedgerTransition>[]): Promise<void> {
    return this.rewrite(async current => {
      const discarded = await mergeDiscarded(current.checkpoint, current.discarded, records);
      return sameRecords(discarded, current.discarded) ? null : { ...current, discarded };
    });
  }

  /** The owner saw the discarded records: forget them. */
  dismissDiscarded(): Promise<void> {
    return this.rewrite(async current => current.discarded.length === 0 ? null : { ...current, discarded: [] });
  }

  /** The persisted pending write of the bound account, or null. */
  pendingWrite(): PendingWriteRecord | null {
    const pending = this.state?.pending;
    return pending === undefined ? null : { ...pending };
  }

  /**
   * Compare-and-set of the pending write: stores `value` (null: none) iff the pending record stored now is `expected` (null: none).
   * Returns false when another record is pending (another tab signed one), true once stored (or already in that state). Unbound: false.
   */
  setPendingWrite(value: PendingWriteRecord | null, expected: Signed<LedgerTransition> | null): Promise<boolean> {
    return this.serialized(async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const current = this.state;
        if (current === null) return false;
        const stored = current.pending?.record ?? null;
        if (sameValue(stored, value?.record ?? null)) return true;
        if (!sameValue(stored, expected)) return false;
        const next = withOptional({ ...current, serial: current.serial + 1 }, {
          confirmed: current.confirmed, pending: value === null ? undefined : { version: 1, record: value.record, since: value.since }, divergence: current.divergence,
        });
        if (await this.store(next, current.serial)) return true;
        await this.reload();
      }
      throw new Error("ledger_replica_conflict");
    });
  }

  /** The valid other histories of the bound account, at most one per source (copies of the record; empty when none or unbound). */
  divergence(): DivergentChains {
    const chains = this.state?.divergence;
    if (chains === undefined) return {};
    const result: DivergentChains = {};
    for (const source of LEDGER_SOURCES) {
      const entry = chains[source];
      if (entry !== undefined) result[source] = { ...entry };
    }
    return result;
  }

  /** The last server state the client confirmed for the bound account (persisted with it), or null when none is known or unbound. */
  confirmed(): ConfirmedServer | null {
    const confirmed = this.state?.confirmed;
    return confirmed === undefined ? null : { ...confirmed, revokedDeviceIds: confirmed.revokedDeviceIds.slice(), revokedBridgeIds: confirmed.revokedBridgeIds.slice() };
  }

  /** Records (compare-and-set, no write when unchanged) the server state the client just confirmed; null forgets it. No-op unbound. */
  noteConfirmed(value: ConfirmedServer | null): Promise<void> {
    const next = value === null ? undefined : confirmedOf(value);
    return this.rewrite(async current => sameValue(current.confirmed, next) ? null
      : withOptional(current, { confirmed: next, pending: current.pending, divergence: current.divergence }));
  }

  /** Unbinds and drops the chain (and the pending write and divergent chains). The account's sticky set is kept: binding to it again still distrusts every id it ever revoked. */
  clear(): Promise<void> {
    return this.serialized(async () => {
      await this.storage.clear();
      this.state = null;
      this.trustedCheckpoint = null;
      this.localHeads = null;
    });
  }

  /** Unbound: only an explicit bind of a fully verified chain (of the expected account), merged with the account's retained sticky set. */
  private async binding(candidate: unknown, options: ReplicaOfferOptions): Promise<Decided | null> {
    if (options.bind !== true) return null;
    let ledger: Ledger;
    let accountId: string;
    let choice: LedgerChoice;
    try {
      const parsed = parseLedger(candidate);
      accountId = await accountIdOf(parsed.genesis.payload);
      if (options.expectAccountId !== undefined && accountId !== options.expectAccountId) return null;
      choice = await chooseLedger(null, parsed, this.now());
      ledger = choice.ledger;
    } catch {
      return null;
    }
    const kept = await this.storage.read(accountId);
    const retained = kept === null || kept === undefined ? null : header(kept, accountId);
    const previous = retained === null ? { deviceIds: [], bridgeIds: [] } : retained.sticky;
    const revoked = ledgerRevocations(ledger);
    const sticky = { deviceIds: union(previous.deviceIds, revoked.deviceIds), bridgeIds: union(previous.bridgeIds, revoked.bridgeIds) };
    const serial = retained === null ? null : retained.serial;
    return {
      choice, expectedSerial: serial,
      record: { version: RECORD_VERSION, accountId, serial: (serial ?? 0) + 1, ledger, checkpoint: choice.checkpoint, sticky, discarded: [] },
    };
  }

  /** Bound: chooseLedger against the verified local chain. `record: null` means nothing to store. */
  private async choosing(current: ReplicaRecord, candidate: unknown, options: ReplicaOfferOptions): Promise<Decided | null> {
    if (options.expectAccountId !== undefined && options.expectAccountId !== current.accountId) return null;
    let choice: LedgerChoice;
    try {
      choice = await chooseLedger(current.ledger, candidate as Ledger, this.now(), { head: current.checkpoint.head, checkpoint: current.checkpoint });
    } catch {
      // With a cache that vouches for the local chain this only throws when local state is corrupt.
      throw corrupt();
    }
    if (choice.decision === "reject") return { choice, expectedSerial: current.serial, record: null };
    if (choice.decision === "keep") {
      if (choice.relation !== "diverged" || options.source === undefined) return { choice, expectedSerial: current.serial, record: null };
      return { choice, expectedSerial: current.serial, record: await this.withDivergent(current, options.source, await spliced(current.ledger, parseLedger(candidate))) };
    }
    // The chain chooseLedger verified: local's own prefix records byte-for-byte, then the candidate's records after the fork point.
    const ledger = choice.ledger;
    const revoked = ledgerRevocations(ledger);
    const previous = current.sticky;
    const sticky = {
      deviceIds: union(union(previous.deviceIds, revoked.deviceIds), choice.discarded.deviceIds),
      bridgeIds: union(union(previous.bridgeIds, revoked.bridgeIds), choice.discarded.bridgeIds),
    };
    const record = withOptional({
      version: RECORD_VERSION, accountId: current.accountId, serial: current.serial + 1, ledger, checkpoint: choice.checkpoint, sticky,
      discarded: await mergeDiscarded(choice.checkpoint, current.discarded, choice.discarded.records),
    }, { confirmed: current.confirmed, pending: current.pending, divergence: await stillDivergent(current.divergence, ledger) });
    return { choice, expectedSerial: current.serial, record };
  }

  /** `current` with `ledger` as the divergent chain of `source` (null when that exact chain is already kept). */
  private async withDivergent(current: ReplicaRecord, source: LedgerSource, ledger: Ledger): Promise<ReplicaRecord | null> {
    const previous = current.divergence?.[source];
    const heads = await headsOf(ledger);
    let firstSeen = this.now();
    if (previous !== undefined) {
      const known = await headsOf(previous.ledger);
      const relation = relate(known, heads);
      if (relation === "same") return null;
      // The same branch, grown: still the divergence first seen then.
      if (relation === "ahead") firstSeen = previous.firstSeen;
    }
    const divergence: DivergentChains = { ...(current.divergence ?? {}), [source]: { version: 1, ledger, firstSeen } };
    return withOptional({ ...current, serial: current.serial + 1 }, { confirmed: current.confirmed, pending: current.pending, divergence });
  }

  /** Compare-and-set rewrite of the bound record; `next` returns null for "nothing to change". No-op unbound. */
  private rewrite(next: (current: ReplicaRecord) => Promise<ReplicaRecord | null>): Promise<void> {
    return this.serialized(async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const current = this.state;
        if (current === null) return;
        const changed = await next(current);
        if (changed === null) return;
        if (await this.store({ ...changed, serial: current.serial + 1 }, current.serial)) return;
        await this.reload();
      }
      throw new Error("ledger_replica_conflict");
    });
  }

  private async store(record: ReplicaRecord, expectedSerial: number | null): Promise<boolean> {
    const trusted = applyRevocations(record.checkpoint, record.sticky);
    const heads = this.state !== null && this.localHeads !== null && this.state.checkpoint.head === record.checkpoint.head
      && this.state.accountId === record.accountId ? this.localHeads : await headsOf(record.ledger);
    if (!await this.storage.commit(record, expectedSerial)) return false;
    this.state = record;
    this.trustedCheckpoint = trusted;
    this.localHeads = heads;
    return true;
  }

  private async reload(): Promise<void> {
    const accountId = await this.storage.bound();
    if (accountId === null) {
      this.state = null;
      this.trustedCheckpoint = null;
      this.localHeads = null;
      return;
    }
    const { record, trusted, heads } = await verifiedRecord(await this.storage.read(accountId), accountId, this.now());
    this.state = record;
    this.trustedCheckpoint = trusted;
    this.localHeads = heads;
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
interface Decided { choice: LedgerChoice; expectedSerial: number | null; record: ReplicaRecord | null }

function retainedOf(record: { accountId: string; serial: number; sticky: StickyRevocations }): RetainedRecord {
  return { version: RECORD_VERSION, accountId: record.accountId, serial: record.serial + 1, ledger: null, checkpoint: null, sticky: record.sticky };
}

/** Test and non-browser storage: records per accountId plus the bound pointer, structured-cloned like IndexedDB. */
export function memoryReplicaStorage(): LedgerReplicaStorage {
  const records = new Map<string, ReplicaRecord | RetainedRecord>();
  let pointer: string | null = null;
  return {
    bound: async () => pointer,
    read: async accountId => {
      const record = records.get(accountId);
      return record === undefined ? null : structuredClone(record);
    },
    commit: async (record, expectedSerial) => {
      if (pointer !== null && pointer !== record.accountId) return false;
      const existing = records.get(record.accountId);
      if ((existing === undefined ? null : existing.serial) !== expectedSerial) return false;
      records.set(record.accountId, structuredClone(record));
      pointer = record.accountId;
      return true;
    },
    clear: async () => {
      const record = pointer === null ? undefined : records.get(pointer);
      if (record !== undefined) records.set(record.accountId, retainedOf(record));
      pointer = null;
    },
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined" || !indexedDB) return Promise.reject(new Error("storage_unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RECORDS)) request.result.createObjectStore(RECORDS, { keyPath: "accountId" });
      if (!request.result.objectStoreNames.contains(META)) request.result.createObjectStore(META, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("storage_unavailable"));
    request.onblocked = () => reject(new Error("storage_unavailable"));
  });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
/** The pointer's accountId; a present but malformed pointer reads as '' (no record has that key, so the replica reports corruption). */
function pointerOf(value: unknown): string | null {
  if (value === undefined) return null;
  return isPlain(value) && typeof value.accountId === "string" ? value.accountId : "";
}

/** IndexedDB database `ftown-ledger`: store `replicas` (one record per accountId) and store `meta` (key `current`: the bound accountId). */
export function indexedDbReplicaStorage(): LedgerReplicaStorage {
  async function within<T>(mode: IDBTransactionMode, run: (meta: IDBObjectStore, records: IDBObjectStore, abort: () => void) => Promise<T>): Promise<T> {
    const db = await openDatabase();
    try {
      const transaction = db.transaction([META, RECORDS], mode);
      const done = completed(transaction);
      let aborted = false;
      const value = await run(transaction.objectStore(META), transaction.objectStore(RECORDS), () => { aborted = true; transaction.abort(); });
      try {
        await done;
      } catch {
        if (!aborted) throw new Error("storage_unavailable");
      }
      return value;
    } finally {
      db.close();
    }
  }
  return {
    bound: () => within("readonly", async meta => pointerOf(await result(meta.get(CURRENT)))),
    read: accountId => within("readonly", async (_meta, records) => {
      const record: unknown = await result(records.get(accountId));
      return record === undefined ? null : record;
    }),
    commit: (record, expectedSerial) => within("readwrite", async (meta, records, abort) => {
      const bound = pointerOf(await result(meta.get(CURRENT)));
      const existing: unknown = await result(records.get(record.accountId));
      const serial = isPlain(existing) && typeof existing.serial === "number" ? existing.serial : null;
      if ((bound !== null && bound !== record.accountId) || serial !== expectedSerial) {
        abort();
        return false;
      }
      records.put(record);
      meta.put({ key: CURRENT, accountId: record.accountId });
      return true;
    }),
    clear: () => within("readwrite", async (meta, records) => {
      const bound = pointerOf(await result(meta.get(CURRENT)));
      const existing: unknown = bound === null ? undefined : await result(records.get(bound));
      let sticky: StickyRevocations | null = null;
      try { sticky = isPlain(existing) ? stickyOf(existing.sticky) : null; } catch { sticky = null; }
      if (bound !== null && isPlain(existing) && typeof existing.serial === "number" && Number.isSafeInteger(existing.serial) && sticky !== null) {
        records.put(retainedOf({ accountId: bound, serial: existing.serial, sticky }));
      } else if (bound !== null) {
        // A corrupt record cannot keep a trustworthy sticky set; forgetting must still work.
        records.delete(bound);
      }
      meta.delete(CURRENT);
    }),
  };
}
