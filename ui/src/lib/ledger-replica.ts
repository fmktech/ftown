import { accountIdOf, applyRevocations, chooseLedger, ledgerHead, ledgerLastIssuedAt, ledgerRevocations, parseLedger, verifyLedger } from "@security/ledger/ledger";
import type { LedgerChoice } from "@security/ledger/ledger";
import type { Ledger, LedgerCheckpoint, LedgerTransition, Signed } from "@security/ledger/protocol";

/*
 * The browser's replica of the account ledger (CONTRACT "Decision 2026-11-09", "Amendments after the L2 re-review", U2 reviews).
 * - Only chains that chooseLedger accepts are stored; a shorter chain never replaces a longer one.
 * - Sticky revocations: the union of ledgerRevocations over every candidate that chooseLedger kept or adopted. It never shrinks, not
 *   even across clear() (kept per accountId), and trusted() (applyRevocations output) is the only checkpoint trust decisions use.
 * - Discarded records (local records a fork dropped, or own records that never made it) persist with the account until dismissed or
 *   until their effect is present in the RAW checkpoint, so the owner can sign them again after a reload.
 * - An unbound replica binds ONLY on an explicit `bind: true` offer (the caller's own verified chain); never from a server or relay.
 *   Once bound, every other account is rejected until clear().
 * Records are re-verified from genesis on load; writes are compare-and-set on a serial, so concurrent tabs never roll back.
 */

export interface StickyRevocations { deviceIds: string[]; bridgeIds: string[] }
/** The bound account's record. `checkpoint` is the RAW chain checkpoint (the chooseLedger cache), never trusted(). */
export interface ReplicaRecord {
  version: 1;
  accountId: string;
  /** Incremented by every write, clear() included; the compare-and-set token. */
  serial: number;
  ledger: Ledger;
  checkpoint: LedgerCheckpoint;
  sticky: StickyRevocations;
  /** Records to show the owner for re-signing; pruned once their effect is in `checkpoint`. */
  discarded: Signed<LedgerTransition>[];
}
/** What an account keeps after clear(): its sticky set (and serial), never its chain. */
export interface RetainedRecord { version: 1; accountId: string; serial: number; ledger: null; checkpoint: null; sticky: StickyRevocations }
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
  /** Atomically unbinds; the bound record becomes a RetainedRecord with serial + 1 (chain and discarded dropped, sticky set kept). */
  clear(): Promise<void>;
}
export interface ReplicaOffer { decision: "adopt" | "keep" | "reject"; discarded: Signed<LedgerTransition>[] }
export interface ReplicaOfferOptions {
  /** Only `true` lets an unbound replica bind, to the caller's own verified chain. Default false. */
  bind?: boolean;
  /** Reject unless the candidate belongs to this account. */
  expectAccountId?: string;
}

const MAX_ATTEMPTS = 4;
const MAX_DISCARDED = 256;
const DATABASE = "ftown-ledger";
const VERSION = 1;
const RECORDS = "replicas";
const META = "meta";
const CURRENT = "current";
const REJECT: ReplicaOffer = { decision: "reject", discarded: [] };

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
function header(value: unknown, accountId: string): { serial: number; sticky: StickyRevocations } {
  if (!isPlain(value) || value.version !== 1 || value.accountId !== accountId
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
function sameRecords(left: readonly Signed<LedgerTransition>[], right: readonly Signed<LedgerTransition>[]): boolean {
  return left.length === right.length && JSON.stringify(left) === JSON.stringify(right);
}

/** Rebuilds the bound record from scratch: the chain is re-verified from genesis and must match the stored checkpoint. */
async function verifiedRecord(value: unknown, accountId: string, now: number): Promise<{ record: ReplicaRecord; trusted: LedgerCheckpoint }> {
  const { serial, sticky } = header(value, accountId);
  const stored = value as Record<string, unknown>;
  if (!isPlain(stored.checkpoint)) throw corrupt();
  const storedCheckpoint = stored.checkpoint;
  try {
    const ledger = parseLedger(stored.ledger);
    // A record this replica already verified must not turn invalid because the wall clock moved backwards.
    const checkpoint = await verifyLedger(ledger, Math.max(now, ledgerLastIssuedAt(ledger)));
    if (checkpoint.accountId !== accountId || checkpoint.accountId !== storedCheckpoint.accountId
      || checkpoint.head !== storedCheckpoint.head || checkpoint.revision !== storedCheckpoint.revision) throw corrupt();
    // Shape only (no linkage): discarded records come from abandoned forks.
    const discarded = stored.discarded === undefined ? [] : parseLedger({ genesis: ledger.genesis, transitions: stored.discarded }).transitions;
    const trusted = applyRevocations(checkpoint, sticky);
    return { record: { version: 1, accountId, serial, ledger, checkpoint, sticky, discarded }, trusted };
  } catch {
    throw corrupt();
  }
}

export class LedgerReplica {
  private state: ReplicaRecord | null = null;
  private trustedCheckpoint: LedgerCheckpoint | null = null;
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
   * Replica rule: chooseLedger(local, candidate, now, cache of the RAW local checkpoint). On keep/adopt the candidate's revocations join
   * the sticky set; adopt stores the candidate, and local records a fork dropped join discarded(). Another account, any invalid
   * candidate, or an unbound replica without `bind: true` is 'reject' and changes nothing.
   */
  offer(candidate: unknown, options: ReplicaOfferOptions = {}): Promise<ReplicaOffer> {
    return this.serialized(async () => {
      requireSecureContext();
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const current = this.state;
        const next = current === null ? await this.binding(candidate, options) : await this.choosing(current, candidate, options);
        if (next === null) return REJECT;
        if (next.record === null) return { decision: "keep", discarded: [] };
        if (await this.store(next.record, next.expectedSerial)) return { decision: next.choice.decision, discarded: next.choice.discarded };
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

  /** Every revocation seen in any kept or adopted chain of the bound account. */
  sticky(): StickyRevocations | null {
    return this.state === null ? null : { deviceIds: this.state.sticky.deviceIds.slice(), bridgeIds: this.state.sticky.bridgeIds.slice() };
  }

  /** Records to show for re-signing (persisted). Empty when unbound. */
  discarded(): Signed<LedgerTransition>[] {
    return this.state === null ? [] : this.state.discarded.slice();
  }

  /** Adds own records that never became part of the chain (for example an append the server's longer chain displaced). */
  noteDiscarded(records: Signed<LedgerTransition>[]): Promise<void> {
    return this.rewrite(async current => mergeDiscarded(current.checkpoint, current.discarded, records));
  }

  /** The owner saw the discarded records: forget them. */
  dismissDiscarded(): Promise<void> {
    return this.rewrite(async () => []);
  }

  /** Unbinds and drops the chain. The account's sticky set is kept: binding to it again still distrusts every id it ever revoked. */
  clear(): Promise<void> {
    return this.serialized(async () => {
      await this.storage.clear();
      this.state = null;
      this.trustedCheckpoint = null;
    });
  }

  /** Unbound: only an explicit bind of a fully verified chain (of the expected account), merged with the account's retained sticky set. */
  private async binding(candidate: unknown, options: ReplicaOfferOptions): Promise<Decided | null> {
    if (options.bind !== true) return null;
    let ledger: Ledger;
    let accountId: string;
    let choice: LedgerChoice;
    try {
      ledger = parseLedger(candidate);
      accountId = await accountIdOf(ledger.genesis.payload);
      if (options.expectAccountId !== undefined && accountId !== options.expectAccountId) return null;
      choice = await chooseLedger(null, ledger, this.now());
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
      record: { version: 1, accountId, serial: (serial ?? 0) + 1, ledger, checkpoint: choice.checkpoint, sticky, discarded: [] },
    };
  }

  /** Bound: the fork choice against the verified local chain. `record: null` means keep with nothing new to store. */
  private async choosing(current: ReplicaRecord, candidate: unknown, options: ReplicaOfferOptions): Promise<Decided | null> {
    if (options.expectAccountId !== undefined && options.expectAccountId !== current.accountId) return null;
    let choice: LedgerChoice;
    try {
      choice = await chooseLedger(current.ledger, candidate as Ledger, this.now(), { head: current.checkpoint.head, checkpoint: current.checkpoint });
    } catch {
      // With a cache that vouches for the local chain this only throws when local state is corrupt.
      throw corrupt();
    }
    if (choice.decision === "reject") return null;
    const ledger = parseLedger(candidate);
    const revoked = ledgerRevocations(ledger);
    const previous = current.sticky;
    const sticky = { deviceIds: union(previous.deviceIds, revoked.deviceIds), bridgeIds: union(previous.bridgeIds, revoked.bridgeIds) };
    const grew = sticky.deviceIds.length !== previous.deviceIds.length || sticky.bridgeIds.length !== previous.bridgeIds.length;
    if (choice.decision === "keep" && !grew) return { choice, expectedSerial: current.serial, record: null };
    const record: ReplicaRecord = choice.decision === "adopt"
      ? {
        version: 1, accountId: current.accountId, serial: current.serial + 1, ledger, checkpoint: choice.checkpoint, sticky,
        discarded: await mergeDiscarded(choice.checkpoint, current.discarded, choice.discarded),
      }
      : { ...current, serial: current.serial + 1, sticky };
    return { choice, expectedSerial: current.serial, record };
  }

  /** Compare-and-set rewrite of the bound record's discarded list. */
  private rewrite(next: (current: ReplicaRecord) => Promise<Signed<LedgerTransition>[]>): Promise<void> {
    return this.serialized(async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const current = this.state;
        if (current === null) return;
        const discarded = await next(current);
        if (sameRecords(discarded, current.discarded)) return;
        if (await this.store({ ...current, serial: current.serial + 1, discarded }, current.serial)) return;
        await this.reload();
      }
      throw new Error("ledger_replica_conflict");
    });
  }

  private async store(record: ReplicaRecord, expectedSerial: number | null): Promise<boolean> {
    const trusted = applyRevocations(record.checkpoint, record.sticky);
    if (!await this.storage.commit(record, expectedSerial)) return false;
    this.state = record;
    this.trustedCheckpoint = trusted;
    return true;
  }

  private async reload(): Promise<void> {
    const accountId = await this.storage.bound();
    if (accountId === null) {
      this.state = null;
      this.trustedCheckpoint = null;
      return;
    }
    const { record, trusted } = await verifiedRecord(await this.storage.read(accountId), accountId, this.now());
    this.state = record;
    this.trustedCheckpoint = trusted;
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
interface Decided { choice: LedgerChoice; expectedSerial: number | null; record: ReplicaRecord | null }

function retainedOf(record: { accountId: string; serial: number; sticky: StickyRevocations }): RetainedRecord {
  return { version: 1, accountId: record.accountId, serial: record.serial + 1, ledger: null, checkpoint: null, sticky: record.sticky };
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
