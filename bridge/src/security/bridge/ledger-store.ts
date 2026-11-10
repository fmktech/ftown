/*
 * The bridge's local replica of its account ledger: `<dataDir>/security/ledger.json`,
 * {version:1, ledger, checkpoint, sticky, lastServerReadAt}, file mode 0600, replaced atomically.
 * - Replica rule (CONTRACT "Decision 2026-11-09" and "Amendments after the L2 re-review"): chooseLedger decides; the cache passed to it
 *   is always the RAW checkpoint of the stored chain. Every candidate that is kept or adopted adds its revocations to the sticky set; a
 *   rejected one adds nothing. trusted() = applyRevocations(checkpoint, sticky) is the only checkpoint for trust decisions.
 * - An empty store is bound to an account ONLY by adoptPaired (link secret proof + confirmPairedLedger) or adoptBound (the identity is
 *   already bound to that account and the chain lists this bridge's keys). offer() never binds an empty store.
 * - Once bound (a stored ledger, or the `accountId` option) every other account's ledger is rejected.
 * - The file is written only after a decision that changes it. A corrupted file throws LedgerStoreError and is never reset.
 * - All operations on one file run one at a time within this process; across processes the bridge's single-instance guarantee is
 *   relied on. Stale `ledger.json.<uuid>.tmp` files left by a crash are removed on the first load in a process.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  accountIdOf, applyRevocations, chooseLedger, ledgerLastIssuedAt, ledgerRevocations, parseLedger, verifyLedger,
} from '../ledger/ledger.js';
import { confirmPairedLedger } from '../ledger/pairing.js';
import type { BridgePairLink, PairApproval } from '../ledger/pairing.js';
import type { Ledger, LedgerBridge, LedgerCheckpoint, LedgerTransition, Signed } from '../ledger/protocol.js';
import { BridgeSecurityError } from './errors.js';
import { bindLedgerIdentity, readLedgerIdentity } from './ledger-identity.js';

export type LedgerSource = 'server' | 'relay';
export type OwnBridgeStatus = 'active' | 'revoked' | 'absent';
export type ReconcileResult = 'ok' | 'unpaired' | 'needs_ledger';
export interface StickyRevocations { deviceIds: string[]; bridgeIds: string[] }
export interface BridgeLedgerState {
  ledger: Ledger;
  /** The stored chain's own checkpoint (raw). Never use it for a trust decision. */
  checkpoint: LedgerCheckpoint;
  /** applyRevocations(checkpoint, sticky): the checkpoint for every trust decision. */
  trusted: LedgerCheckpoint;
  /** Union of the revocations of every chain this replica kept or adopted. */
  sticky: StickyRevocations;
  lastServerReadAt: number | null;
}
export interface LedgerOfferResult {
  decision: 'adopt' | 'keep' | 'reject';
  /** The stored state after the decision; null while the store is empty. */
  state: BridgeLedgerState | null;
  /** Local records discarded by a winning fork, for the owner to re-sign; empty otherwise. */
  discarded: Signed<LedgerTransition>[];
}
export interface BridgeLedgerStoreOptions {
  /** The account the bridge identity is bound to: ledgers of any other account are rejected even while the store is empty, and a
   *  stored ledger of another account throws LedgerStoreError('ledger_store_wrong_account'). */
  accountId?: string | null;
  now?: () => number;
}
export type LedgerStoreErrorCode =
  | 'ledger_store_corrupt' | 'ledger_store_wrong_account' | 'ledger_store_pairing_rejected' | 'ledger_store_bound_rejected';

const messages: { readonly [code in LedgerStoreErrorCode]: string } = {
  ledger_store_corrupt: 'Local account ledger is corrupted.',
  ledger_store_wrong_account: 'Local account ledger belongs to a different account.',
  ledger_store_pairing_rejected: 'Paired account ledger was rejected.',
  ledger_store_bound_rejected: 'Account ledger does not match this bridge identity.',
};
/** Not retryable; file contents and crypto errors never enter it. Read/write failures throw BridgeSecurityError('storage_unavailable'). */
export class LedgerStoreError extends Error {
  readonly retryable = false;
  constructor(readonly code: LedgerStoreErrorCode) {
    super(messages[code]);
    this.name = 'LedgerStoreError';
  }
}

interface Replica {
  dataDir: string;
  file: string;
  accountId: string | null;
  clock: () => number;
  /** The last file text this replica verified or wrote, and its decoded state. Re-verified whenever the text differs. */
  memo: { text: string; state: BridgeLedgerState } | null;
}
type Decided = Omit<BridgeLedgerState, 'trusted'>;

const FILE_NAME = 'ledger.json';
const FILE_KEYS = ['version', 'ledger', 'checkpoint', 'sticky', 'lastServerReadAt'];
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TIME = 253402300799999;
const TEMPORARY = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const queues = new Map<string, Promise<void>>();
const swept = new Set<string>();

function corrupt(): never {
  throw new LedgerStoreError('ledger_store_corrupt');
}
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isAccountId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const raw = Buffer.from(value, 'base64url');
  return raw.length === 32 && raw.toString('base64url') === value;
}
function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
}
/** Sorted-key JSON, to compare a stored checkpoint with a recomputed one. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return `[${items.map(canonical).join(',')}]`;
  }
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return corrupt();
  const items: readonly unknown[] = value;
  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' || result.indexOf(item) !== -1) return corrupt();
    result.push(item);
  }
  return result;
}
function union(left: StickyRevocations, right: StickyRevocations): StickyRevocations {
  const merge = (base: string[], extra: string[]): string[] => base.concat(extra.filter((id, index) => base.indexOf(id) === -1 && extra.indexOf(id) === index));
  return { deviceIds: merge(left.deviceIds, right.deviceIds), bridgeIds: merge(left.bridgeIds, right.bridgeIds) };
}
function covers(sticky: StickyRevocations, ids: StickyRevocations): boolean {
  return ids.deviceIds.every(id => sticky.deviceIds.indexOf(id) !== -1) && ids.bridgeIds.every(id => sticky.bridgeIds.indexOf(id) !== -1);
}
function sameSticky(left: StickyRevocations, right: StickyRevocations): boolean {
  return left.deviceIds.length === right.deviceIds.length && left.bridgeIds.length === right.bridgeIds.length && covers(left, right);
}
function statusOf(trusted: LedgerCheckpoint | null, bridgeId: string, authPublicKey: string): OwnBridgeStatus {
  if (trusted === null) return 'absent';
  if (trusted.revokedBridgeIds.indexOf(bridgeId) !== -1) return 'revoked';
  return trusted.bridges.some(bridge => bridge.bridgeId === bridgeId && bridge.authPublicKey === authPublicKey) ? 'active' : 'absent';
}
/** Is a bridge with exactly these keys a member of the trusted roster (any bridgeId when `bridgeId` is null)? */
function lists(trusted: LedgerCheckpoint, bridgeId: string | null, endpointId: string, authPublicKey: string): boolean {
  return trusted.bridges.some((bridge: LedgerBridge) => (bridgeId === null || bridge.bridgeId === bridgeId)
    && bridge.endpoint.id === endpointId && bridge.authPublicKey === authPublicKey);
}
function cacheOf(stored: BridgeLedgerState): { head: string; checkpoint: LedgerCheckpoint } {
  // The cache is the stored chain's raw checkpoint, never the trusted one.
  return { head: stored.checkpoint.head, checkpoint: stored.checkpoint };
}
/** Operations on one file run one at a time within this process, whichever store instance or helper issues them. */
function serialized<T>(file: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(run);
  const settled = next.then(() => undefined, () => undefined);
  queues.set(file, settled);
  void settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
  return next;
}
async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try { handle = await open(directory, 'r'); } catch { return; }
  try { await handle.sync(); } catch { /* directory fsync is unsupported on some platforms */ } finally { await handle.close(); }
}
/** Once per process: removes `ledger.json.<uuid>.tmp` left by a crash mid-write. Runs inside the queue, so no own write is in flight. */
async function sweepTemporaries(file: string): Promise<void> {
  if (swept.has(file)) return;
  swept.add(file);
  const prefix = basename(file);
  let names: string[];
  try { names = await readdir(dirname(file)); } catch { return; }
  for (const name of names) {
    if (name.indexOf(prefix) === 0 && TEMPORARY.test(name.slice(prefix.length))) await rm(join(dirname(file), name), { force: true }).catch(() => undefined);
  }
}

function replicaOf(dataDir: string, options: BridgeLedgerStoreOptions): Replica {
  const accountId = options.accountId ?? null;
  if (accountId !== null && !isAccountId(accountId)) throw new BridgeSecurityError('wrong_context');
  return { dataDir, file: resolve(join(dataDir, 'security', FILE_NAME)), accountId, clock: options.now ?? Date.now, memo: null };
}
async function readText(replica: Replica): Promise<string | null> {
  let handle;
  try { handle = await open(replica.file, 'r'); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new BridgeSecurityError('storage_unavailable');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return corrupt();
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof LedgerStoreError) throw error;
    throw new BridgeSecurityError('storage_unavailable');
  } finally {
    await handle.close();
  }
}
/** Full check of a stored file: shape, the chain from genesis, the checkpoint it yields, and sticky covering its own revocations. */
async function decode(replica: Replica, text: string): Promise<BridgeLedgerState> {
  try {
    const record: unknown = JSON.parse(text);
    if (!isRecord(record)) return corrupt();
    const keys = Object.keys(record);
    if (keys.length !== FILE_KEYS.length || keys.some(key => FILE_KEYS.indexOf(key) === -1) || record.version !== 1) return corrupt();
    const lastServerReadAt = record.lastServerReadAt === null ? null : isTime(record.lastServerReadAt) ? record.lastServerReadAt : corrupt();
    if (!isRecord(record.sticky)) return corrupt();
    const stickyKeys = Object.keys(record.sticky);
    if (stickyKeys.length !== 2 || stickyKeys.indexOf('deviceIds') === -1 || stickyKeys.indexOf('bridgeIds') === -1) return corrupt();
    const sticky: StickyRevocations = { deviceIds: uniqueStrings(record.sticky.deviceIds), bridgeIds: uniqueStrings(record.sticky.bridgeIds) };
    const ledger = parseLedger(record.ledger);
    // An accepted chain stays valid when the clock later moves back: verify at no earlier than its last record.
    const checkpoint = await verifyLedger(ledger, Math.max(replica.clock(), ledgerLastIssuedAt(ledger)));
    if (canonical(record.checkpoint) !== canonical(checkpoint)) return corrupt();
    if (!covers(sticky, ledgerRevocations(ledger))) return corrupt();
    return { ledger, checkpoint, trusted: applyRevocations(checkpoint, sticky), sticky, lastServerReadAt };
  } catch {
    return corrupt();
  }
}
/** null when absent. Re-reads the file on every call and re-verifies it whenever its text changed. */
async function load(replica: Replica): Promise<BridgeLedgerState | null> {
  await sweepTemporaries(replica.file);
  const text = await readText(replica);
  if (text === null) {
    replica.memo = null;
    return null;
  }
  const state = replica.memo !== null && replica.memo.text === text ? replica.memo.state : await decode(replica, text);
  if (replica.accountId !== null && state.checkpoint.accountId !== replica.accountId) throw new LedgerStoreError('ledger_store_wrong_account');
  replica.memo = { text, state };
  return state;
}
async function save(replica: Replica, state: BridgeLedgerState): Promise<void> {
  const text = JSON.stringify({
    version: 1, ledger: state.ledger, checkpoint: state.checkpoint, sticky: state.sticky, lastServerReadAt: state.lastServerReadAt,
  });
  const directory = dirname(replica.file);
  const temporary = `${replica.file}.${randomUUID()}.tmp`;
  replica.memo = null;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, replica.file);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new BridgeSecurityError('storage_unavailable');
  }
  await syncDirectory(directory);
  replica.memo = { text, state };
}
async function erase(replica: Replica): Promise<void> {
  replica.memo = null;
  try { await unlink(replica.file); }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw new BridgeSecurityError('storage_unavailable'); }
  await syncDirectory(dirname(replica.file));
}

/** The replica rule for an untrusted candidate on a bound store. Never binds an empty store. */
async function decide(replica: Replica, candidate: unknown, source: LedgerSource): Promise<LedgerOfferResult> {
  const now = replica.clock();
  const stored = await load(replica);
  const unchanged = (decision: 'keep' | 'reject'): LedgerOfferResult => ({ decision, state: stored, discarded: [] });
  if (source !== 'server' && source !== 'relay') return unchanged('reject');
  if (stored === null) return unchanged('reject');
  let ledger: Ledger;
  try { ledger = parseLedger(candidate); } catch { return unchanged('reject'); }
  if (await accountIdOf(ledger.genesis.payload) !== stored.checkpoint.accountId) return unchanged('reject');
  const choice = await chooseLedger(stored.ledger, ledger, now, cacheOf(stored));
  if (choice.decision === 'reject') return unchanged('reject');
  const sticky = union(stored.sticky, ledgerRevocations(ledger));
  if (choice.decision === 'adopt') {
    const adopted = await commit(replica, { ledger, checkpoint: choice.checkpoint, sticky, lastServerReadAt: stored.lastServerReadAt });
    return adopted === null ? unchanged('reject') : { decision: 'adopt', state: adopted, discarded: choice.discarded };
  }
  if (sameSticky(sticky, stored.sticky)) return unchanged('keep');
  const kept = await commit(replica, { ledger: stored.ledger, checkpoint: stored.checkpoint, sticky, lastServerReadAt: stored.lastServerReadAt });
  return kept === null ? unchanged('reject') : { decision: 'keep', state: kept, discarded: [] };
}
/** Persists a decided state; null (nothing written) when its sticky set exceeds applyRevocations' limits. */
async function commit(replica: Replica, next: Decided): Promise<BridgeLedgerState | null> {
  let trusted: LedgerCheckpoint;
  try { trusted = applyRevocations(next.checkpoint, next.sticky); } catch { return null; }
  const state: BridgeLedgerState = { ...next, trusted };
  await save(replica, state);
  return state;
}
/**
 * Binds an empty store, or applies the replica rule to a bound one, for a chain the caller has authenticated. The resulting trusted
 * roster must list this bridge (`isMember`); on any failure throws LedgerStoreError(code) and writes nothing. Returns trusted().
 */
async function admit(
  replica: Replica, stored: BridgeLedgerState | null, ledger: Ledger, now: number,
  isMember: (trusted: LedgerCheckpoint) => boolean, code: LedgerStoreErrorCode,
): Promise<LedgerCheckpoint> {
  let next: Decided;
  if (stored === null) {
    let checkpoint: LedgerCheckpoint;
    try { checkpoint = (await chooseLedger(null, ledger, now)).checkpoint; } catch { throw new LedgerStoreError(code); }
    next = { ledger, checkpoint, sticky: union({ deviceIds: [], bridgeIds: [] }, ledgerRevocations(ledger)), lastServerReadAt: null };
  } else {
    const choice = await chooseLedger(stored.ledger, ledger, now, cacheOf(stored));
    if (choice.decision === 'reject') throw new LedgerStoreError(code);
    const sticky = union(stored.sticky, ledgerRevocations(ledger));
    next = choice.decision === 'adopt'
      ? { ledger, checkpoint: choice.checkpoint, sticky, lastServerReadAt: stored.lastServerReadAt }
      : { ledger: stored.ledger, checkpoint: stored.checkpoint, sticky, lastServerReadAt: stored.lastServerReadAt };
  }
  let trusted: LedgerCheckpoint;
  try { trusted = applyRevocations(next.checkpoint, next.sticky); } catch { throw new LedgerStoreError(code); }
  if (!isMember(trusted)) throw new LedgerStoreError(code);
  if (stored === null || next.ledger !== stored.ledger || !sameSticky(next.sticky, stored.sticky)) await save(replica, { ...next, trusted });
  return structuredClone(trusted);
}

export class BridgeLedgerStore {
  private readonly replica: Replica;

  constructor(dataDir: string, options: BridgeLedgerStoreOptions = {}) {
    this.replica = replicaOf(dataDir, options);
  }

  /** The stored state, or null while no ledger is stored. Throws LedgerStoreError for a corrupted or wrong-account file. */
  read(): Promise<BridgeLedgerState | null> {
    return serialized(this.replica.file, async () => structuredClone(await load(this.replica)));
  }

  /** applyRevocations(checkpoint, sticky) of the stored chain, or null while no ledger is stored. */
  trusted(): Promise<LedgerCheckpoint | null> {
    return serialized(this.replica.file, async () => {
      const state = await load(this.replica);
      return state === null ? null : structuredClone(state.trusted);
    });
  }

  /** 'revoked' iff bridgeId is revoked in trusted(); 'active' iff trusted() lists bridgeId with this auth key; else 'absent'. */
  async ownBridgeStatus(bridgeId: string, authPublicKey: string): Promise<OwnBridgeStatus> {
    return statusOf(await this.trusted(), bridgeId, authPublicKey);
  }

  /** ownBridgeStatus(bridgeId, …) === 'revoked': by the stored chain or by any chain this replica ever kept or adopted. */
  async ownBridgeRevoked(bridgeId: string): Promise<boolean> {
    return statusOf(await this.trusted(), bridgeId, '') === 'revoked';
  }

  /**
   * Offers an untrusted candidate chain from the server or the relay. Never binds an empty store, and never throws for a bad candidate:
   * it is rejected. Throws LedgerStoreError for a corrupted or wrong-account local file, and BridgeSecurityError('storage_unavailable')
   * when the file cannot be read or written.
   */
  offer(candidate: unknown, source: LedgerSource): Promise<LedgerOfferResult> {
    return serialized(this.replica.file, async () => structuredClone(await decide(this.replica, candidate, source)));
  }

  /**
   * The pairing path, after openPairApproval. Runs confirmPairedLedger(link, approval, ledger, now, sticky) with this replica's sticky
   * set, then binds the empty store (or applies the replica rule to a bound store of the same account); the request's bridge must be in
   * the resulting trusted roster. Returns trusted(). Throws LedgerStoreError('ledger_store_pairing_rejected') and writes nothing on any
   * pairing failure.
   */
  adoptPaired(link: BridgePairLink, approval: PairApproval, ledger: unknown, now?: number): Promise<LedgerCheckpoint> {
    const replica = this.replica;
    return serialized(replica.file, async () => {
      const at = now === undefined ? replica.clock() : now;
      const stored = await load(replica);
      const rejected = (): LedgerStoreError => new LedgerStoreError('ledger_store_pairing_rejected');
      let parsed: Ledger;
      try { parsed = parseLedger(ledger); } catch { throw rejected(); }
      const bound = stored === null ? replica.accountId : stored.checkpoint.accountId;
      if (bound !== null && await accountIdOf(parsed.genesis.payload) !== bound) throw rejected();
      const sticky = union(stored === null ? { deviceIds: [], bridgeIds: [] } : stored.sticky, ledgerRevocations(parsed));
      try { await confirmPairedLedger(link, approval, parsed, at, sticky); } catch { throw rejected(); }
      const request = link.request;
      const endpointId = createHash('sha256').update(Buffer.from(request.endpointPublicKey, 'base64url')).digest('base64url');
      return admit(replica, stored, parsed, at, trusted => lists(trusted, request.bridgeId, endpointId, request.authPublicKey), 'ledger_store_pairing_rejected');
    });
  }

  /**
   * Recovery when the identity is bound but the store is empty (reconcileIdentityAndStore returned 'needs_ledger'): accepts a server
   * ledger only if its account is the identity's bound account and its trusted roster lists this identity's bridge keys (endpoint id and
   * authPublicKey). Returns trusted(). Throws LedgerStoreError('ledger_store_bound_rejected') and writes nothing otherwise.
   */
  adoptBound(ledger: unknown, now?: number): Promise<LedgerCheckpoint> {
    const replica = this.replica;
    return serialized(replica.file, async () => {
      const at = now === undefined ? replica.clock() : now;
      const rejected = (): LedgerStoreError => new LedgerStoreError('ledger_store_bound_rejected');
      const identity = await readLedgerIdentity(replica.dataDir);
      if (identity === null || identity.accountId === null) throw rejected();
      const stored = await load(replica);
      let parsed: Ledger;
      try { parsed = parseLedger(ledger); } catch { throw rejected(); }
      const accountId = await accountIdOf(parsed.genesis.payload);
      if (accountId !== identity.accountId) throw rejected();
      if ((replica.accountId !== null && accountId !== replica.accountId) || (stored !== null && accountId !== stored.checkpoint.accountId)) throw rejected();
      return admit(replica, stored, parsed, at, trusted => lists(trusted, null, identity.endpointId, identity.authPublicKey), 'ledger_store_bound_rejected');
    });
  }

  /** Records the time of the last successful server ledger read. No-op while no ledger is stored. */
  markServerRead(now: number): Promise<void> {
    if (!isTime(now)) return Promise.reject(new TypeError('Invalid server read time'));
    return serialized(this.replica.file, async () => {
      const state = await load(this.replica);
      if (state === null || state.lastServerReadAt === now) return;
      await save(this.replica, { ...state, lastServerReadAt: now });
    });
  }
}

/**
 * Startup recovery between the identity file and the ledger store, under the store's queue:
 * - identity bound, store holds its account's ledger -> 'ok'; store holds another account's -> throws ledger_store_wrong_account;
 * - identity bound, store empty -> 'needs_ledger' (fetch the server ledger, then adoptBound); a bound identity is never unbound;
 * - identity unbound (or absent), store empty -> 'unpaired';
 * - identity unbound, store's trusted roster lists this identity's bridge keys -> binds the identity to that account -> 'ok';
 * - otherwise (absent identity, or keys not listed) the stale ledger.json is deleted -> 'unpaired'.
 * Corrupted files throw (LedgerStoreError / BridgeSecurityError('key_unavailable')) and are never reset.
 */
export function reconcileIdentityAndStore(dataDir: string, options: { now?: () => number } = {}): Promise<ReconcileResult> {
  const replica = replicaOf(dataDir, { now: options.now });
  return serialized(replica.file, async (): Promise<ReconcileResult> => {
    const identity = await readLedgerIdentity(dataDir);
    const stored = await load(replica);
    if (identity !== null && identity.accountId !== null) {
      if (stored === null) return 'needs_ledger';
      if (stored.checkpoint.accountId !== identity.accountId) throw new LedgerStoreError('ledger_store_wrong_account');
      return 'ok';
    }
    if (stored === null) return 'unpaired';
    if (identity !== null && lists(stored.trusted, null, identity.endpointId, identity.authPublicKey)) {
      await bindLedgerIdentity(dataDir, stored.checkpoint.accountId);
      return 'ok';
    }
    await erase(replica);
    return 'unpaired';
  });
}
