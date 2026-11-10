/*
 * The bridge's local replica of its account ledger: `<dataDir>/security/ledger.json`,
 * {version:2, ledger, checkpoint, sticky, lastServerReadAt, divergences}, file mode 0600, replaced atomically. A version 1 file (the same
 * without `divergences`) is still read, and is rewritten as version 2 on the next change.
 * - Append-only rule (CONTRACT §2, §5, §12): chooseLedger decides, always with the RAW checkpoint of the stored chain as its cache. What is
 *   written is never rewritten. A candidate is adopted only when it strictly extends the stored chain ('ahead'), or when it diverges and
 *   carries an owner-signed resolve_fork that applies to the stored chain (the single owner-authorized exception). Same and behind change
 *   nothing; behind is reported to the caller, which may re-offer the stored chain to the server.
 * - A VALID diverged chain without an applicable resolve_fork is refused: the stored chain is kept and still decides every trust question,
 *   nothing of the refused chain reaches the sticky set, and the divergence is recorded per source (one entry each for server and relay,
 *   persisted here) and logged once per distinct other head. The entry is cleared when a later chain from that source agrees with ours
 *   again (same, ahead or behind), and every entry is cleared by an owner-chosen adoption.
 * - An invalid candidate (malformed, another account, a bad record) is ignored, logged at most once per 60 s per source.
 * - Sticky set: the revocations of every chain this replica adopted (its own chain included), plus, on an owner-chosen adoption, the
 *   revocations among the records it discarded, so a removal is never silently undone. trusted() = applyRevocations(checkpoint, sticky) is
 *   the only checkpoint for trust decisions.
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
  accountIdOf, applyRevocations, chooseLedger, ledgerHead, ledgerLastIssuedAt, ledgerRevocations, parseLedger, verifyLedger,
} from '../ledger/ledger.js';
import type { LedgerChoice, LedgerRelation } from '../ledger/ledger.js';
import { confirmPairedLedger } from '../ledger/pairing.js';
import type { BridgePairLink, PairApproval } from '../ledger/pairing.js';
import { LEDGER_LIMITS } from '../ledger/protocol.js';
import type { Ledger, LedgerBridge, LedgerCheckpoint, LedgerTransition, Signed } from '../ledger/protocol.js';
import { BridgeSecurityError } from './errors.js';
import { bindLedgerIdentity, readLedgerIdentity } from './ledger-identity.js';

export type LedgerSource = 'server' | 'relay';
export type OwnBridgeStatus = 'active' | 'revoked' | 'absent';
export type ReconcileResult = 'ok' | 'unpaired' | 'needs_ledger';
export interface StickyRevocations { deviceIds: string[]; bridgeIds: string[] }
/** A valid history of this account from `source` that diverges from the stored chain and was refused. Times are wall-clock ms. */
export interface LedgerDivergence {
  source: LedgerSource;
  /** The refused chain's last head and revision. */
  otherHead: string;
  otherRevision: number;
  /** When this source was first seen diverging (kept while it keeps diverging, also when its head moves). */
  firstSeen: number;
  /** When it was last seen; persisted at most every DIVERGENCE_LAST_SEEN_RESOLUTION_MS. */
  lastSeen: number;
}
export interface BridgeLedgerState {
  ledger: Ledger;
  /** The stored chain's own checkpoint (raw). Never use it for a trust decision. */
  checkpoint: LedgerCheckpoint;
  /** applyRevocations(checkpoint, sticky): the checkpoint for every trust decision. */
  trusted: LedgerCheckpoint;
  /** The revocations of every chain this replica adopted, plus those of records an owner-chosen history discarded. */
  sticky: StickyRevocations;
  lastServerReadAt: number | null;
  /** At most one entry per source, ordered server first. */
  divergences: LedgerDivergence[];
}
/** The last record of a chain: its revision (0 = genesis) and head (the genesis head is the accountId). */
export interface LedgerTip { revision: number; head: string }
export interface LedgerOfferResult {
  decision: 'adopt' | 'keep' | 'reject';
  /** How the candidate relates to the chain stored before the decision; null when it has none (empty store, malformed, another account). */
  relation: LedgerRelation | null;
  /** The candidate's tip; null when it does not parse. */
  candidate: LedgerTip | null;
  /** The stored state after the decision; null while the store is empty. */
  state: BridgeLedgerState | null;
  /** Local records an owner-chosen history (adopt + diverged) discarded; empty otherwise. */
  discarded: Signed<LedgerTransition>[];
}
export interface BridgeLedgerStoreOptions {
  /** The account the bridge identity is bound to: ledgers of any other account are rejected even while the store is empty, and a
   *  stored ledger of another account throws LedgerStoreError('ledger_store_wrong_account'). */
  accountId?: string | null;
  now?: () => number;
  /** The `[ledger]` lines (refused history, owner-chosen adoption, ignored chain). Defaults to console.warn. */
  log?: (line: string) => void;
}
/** Divergence lastSeen is rewritten at most this often while the same other head keeps arriving. */
export const DIVERGENCE_LAST_SEEN_RESOLUTION_MS = 10 * 60_000;
/** "ignored an invalid chain" is logged at most once per this interval per source. */
export const INVALID_CHAIN_LOG_SPACING_MS = 60_000;
/** The first 8 characters of a head, as the log lines and the status show it. */
export const shortHead = (head: string): string => head.slice(0, 8);
export type LedgerStoreErrorCode =
  | 'ledger_store_corrupt' | 'ledger_store_wrong_account' | 'ledger_store_pairing_rejected' | 'ledger_store_pairing_revoked'
  | 'ledger_store_bound_rejected';

const messages: { readonly [code in LedgerStoreErrorCode]: string } = {
  ledger_store_corrupt: 'Local account ledger is corrupted.',
  ledger_store_wrong_account: 'Local account ledger belongs to a different account.',
  ledger_store_pairing_rejected: 'Paired account ledger was rejected.',
  ledger_store_pairing_revoked: "This computer's id was removed from the account before pairing completed.",
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
  log: (line: string) => void;
  /** When "ignored an invalid chain" was last logged, per source. */
  ignoredAt: Map<LedgerSource, number>;
  /** The last file text this replica verified or wrote, and its decoded state. Re-verified whenever the text differs. */
  memo: { text: string; state: BridgeLedgerState } | null;
}
type Decided = Omit<BridgeLedgerState, 'trusted'>;

const FILE_NAME = 'ledger.json';
const FILE_VERSION = 2;
const FILE_KEYS_V1 = ['version', 'ledger', 'checkpoint', 'sticky', 'lastServerReadAt'];
const FILE_KEYS = [...FILE_KEYS_V1, 'divergences'];
const DIVERGENCE_KEYS = ['source', 'otherHead', 'otherRevision', 'firstSeen', 'lastSeen'];
const SOURCES: readonly LedgerSource[] = ['server', 'relay'];
const NO_REVOCATIONS: StickyRevocations = { deviceIds: [], bridgeIds: [] };
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
/**
 * Proof in `ledger` that THIS bridge was removed: an add_bridge of `bridgeId` with exactly this auth key, followed by a revoke_bridge of
 * `bridgeId`. A revoke_bridge of an id the chain never added with these keys is only a tombstone (C1b: revoking a non-member is valid) and
 * proves nothing about this bridge.
 */
export function ledgerRemovesBridge(ledger: Ledger, bridgeId: string, authPublicKey: string): boolean {
  let member = false;
  for (const record of ledger.transitions) {
    const operation = record.payload.operation;
    if (operation.type === 'add_bridge' && operation.bridge.bridgeId === bridgeId && operation.bridge.authPublicKey === authPublicKey) member = true;
    if (operation.type === 'revoke_bridge' && operation.bridgeId === bridgeId && member) return true;
  }
  return false;
}
/** 'active': trusted() lists bridgeId with this auth key. 'revoked': the stored chain itself proves this bridge's removal
 *  (ledgerRemovesBridge). Anything else, a tombstone or a sticky-only id included, is 'absent': fail closed, never a reset. */
function statusOf(state: BridgeLedgerState | null, bridgeId: string, authPublicKey: string): OwnBridgeStatus {
  if (state === null) return 'absent';
  if (state.trusted.bridges.some(bridge => bridge.bridgeId === bridgeId && bridge.authPublicKey === authPublicKey)) return 'active';
  return ledgerRemovesBridge(state.ledger, bridgeId, authPublicKey) ? 'revoked' : 'absent';
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
async function tipOf(ledger: Ledger): Promise<LedgerTip> {
  const last = ledger.transitions[ledger.transitions.length - 1];
  return { revision: ledger.transitions.length, head: last === undefined ? await accountIdOf(ledger.genesis.payload) : await ledgerHead(last.payload) };
}
/** The sticky set after an adoption: the adopted chain's own revocations, plus, for an owner-chosen history, those of the local records it
 *  discarded (C1 adopts a resolution only when it carries them, so those are normally already in the chain; merged regardless). */
function adoptedSticky(stored: StickyRevocations, choice: LedgerChoice): StickyRevocations {
  const discarded = choice.relation === 'diverged' ? { deviceIds: choice.discarded.deviceIds, bridgeIds: choice.discarded.bridgeIds } : NO_REVOCATIONS;
  return union(union(stored, ledgerRevocations(choice.ledger)), discarded);
}
function withoutSource(divergences: readonly LedgerDivergence[], source: LedgerSource): LedgerDivergence[] {
  return divergences.filter(entry => entry.source !== source);
}
function ordered(divergences: LedgerDivergence[]): LedgerDivergence[] {
  return divergences.sort((left, right) => SOURCES.indexOf(left.source) - SOURCES.indexOf(right.source));
}
function adoptionLine(stored: BridgeLedgerState, choice: LedgerChoice): string {
  const discarded = choice.discarded.records.length;
  return `[ledger] adopted an owner-chosen history: fork at revision ${stored.checkpoint.revision - discarded}, discarded ${discarded} of our records`;
}
/** "ignored an invalid chain from <source>", at most once per INVALID_CHAIN_LOG_SPACING_MS per source. */
function ignored(replica: Replica, source: LedgerSource, now: number): void {
  const last = replica.ignoredAt.get(source);
  if (last !== undefined && now >= last && now - last < INVALID_CHAIN_LOG_SPACING_MS) return;
  replica.ignoredAt.set(source, now);
  replica.log(`[ledger] ignored an invalid chain from ${source}`);
}
function parseDivergences(value: unknown): LedgerDivergence[] {
  if (!Array.isArray(value) || value.length > SOURCES.length) return corrupt();
  const items: readonly unknown[] = value;
  const result: LedgerDivergence[] = [];
  for (const item of items) {
    if (!isRecord(item)) return corrupt();
    const keys = Object.keys(item);
    if (keys.length !== DIVERGENCE_KEYS.length || keys.some(key => DIVERGENCE_KEYS.indexOf(key) === -1)) return corrupt();
    const { source, otherHead, otherRevision, firstSeen, lastSeen } = item;
    if ((source !== 'server' && source !== 'relay') || result.some(entry => entry.source === source)) return corrupt();
    if (!isAccountId(otherHead) || typeof otherRevision !== 'number' || !Number.isSafeInteger(otherRevision) || otherRevision < 0
      || otherRevision > LEDGER_LIMITS.maxTransitions || !isTime(firstSeen) || !isTime(lastSeen) || firstSeen > lastSeen) return corrupt();
    result.push({ source, otherHead, otherRevision, firstSeen, lastSeen });
  }
  return ordered(result);
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
  return {
    dataDir, file: resolve(join(dataDir, 'security', FILE_NAME)), accountId, clock: options.now ?? Date.now,
    log: options.log ?? (line => console.warn(line)), ignoredAt: new Map(), memo: null,
  };
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
    const expected = record.version === 1 ? FILE_KEYS_V1 : record.version === FILE_VERSION ? FILE_KEYS : corrupt();
    if (keys.length !== expected.length || keys.some(key => expected.indexOf(key) === -1)) return corrupt();
    const divergences = record.version === 1 ? [] : parseDivergences(record.divergences);
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
    return { ledger, checkpoint, trusted: applyRevocations(checkpoint, sticky), sticky, lastServerReadAt, divergences };
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
    version: FILE_VERSION, ledger: state.ledger, checkpoint: state.checkpoint, sticky: state.sticky, lastServerReadAt: state.lastServerReadAt,
    divergences: state.divergences,
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

/**
 * The append-only rule for an untrusted candidate on a bound store (C1's chooseLedger table). Never binds an empty store.
 * - adopt (ahead, or diverged with an applicable owner-signed resolve_fork): store it; sticky += its revocations (+ the discarded ones).
 * - keep / same, behind: nothing changes, except that a divergence recorded for this source is cleared (the histories agree again).
 * - keep / diverged: ours is kept, the divergence is recorded (refuse); nothing reaches the sticky set.
 * - reject: ignored (logged, spaced).
 */
async function decide(replica: Replica, candidate: unknown, source: LedgerSource): Promise<LedgerOfferResult> {
  const now = replica.clock();
  const stored = await load(replica);
  const answer = (decision: LedgerOfferResult['decision'], relation: LedgerRelation | null, tip: LedgerTip | null, state = stored,
    discarded: Signed<LedgerTransition>[] = []): LedgerOfferResult => ({ decision, relation, candidate: tip, state, discarded });
  if (source !== 'server' && source !== 'relay') return answer('reject', null, null);
  if (stored === null) return answer('reject', null, null);
  let ledger: Ledger;
  try { ledger = parseLedger(candidate); } catch { ignored(replica, source, now); return answer('reject', null, null); }
  const tip = await tipOf(ledger);
  if (await accountIdOf(ledger.genesis.payload) !== stored.checkpoint.accountId) { ignored(replica, source, now); return answer('reject', null, tip); }
  const choice = await chooseLedger(stored.ledger, ledger, now, cacheOf(stored));
  if (choice.decision === 'reject') { ignored(replica, source, now); return answer('reject', choice.relation, tip); }
  if (choice.decision === 'adopt') {
    const divergent = choice.relation === 'diverged';
    // choice.ledger, never the candidate as passed in: our own prefix byte-for-byte, then the candidate's verified records.
    const adopted = await commit(replica, {
      ledger: choice.ledger, checkpoint: choice.checkpoint, sticky: adoptedSticky(stored.sticky, choice), lastServerReadAt: stored.lastServerReadAt,
      // An owner-chosen history replaces ours: every recorded divergence was measured against the chain it discarded.
      divergences: divergent ? [] : withoutSource(stored.divergences, source),
    });
    if (adopted === null) return answer('reject', choice.relation, tip);
    if (divergent) replica.log(adoptionLine(stored, choice));
    return answer('adopt', choice.relation, tip, adopted, choice.discarded.records);
  }
  if (choice.relation === 'diverged') return answer('keep', 'diverged', tip, await refuse(replica, stored, source, tip, now));
  // same / behind: the histories agree; a divergence recorded for this source is over.
  if (!stored.divergences.some(entry => entry.source === source)) return answer('keep', choice.relation, tip);
  return answer('keep', choice.relation, tip, await persist(replica, { ...stored, divergences: withoutSource(stored.divergences, source) }));
}
/**
 * keep / diverged: records (or refreshes) this source's divergence and logs ONE line per distinct other head (across sources and restarts:
 * the persisted entries are the memory). The stored chain, checkpoint and sticky set are untouched.
 */
async function refuse(replica: Replica, stored: BridgeLedgerState, source: LedgerSource, tip: LedgerTip, now: number): Promise<BridgeLedgerState> {
  if (!stored.divergences.some(entry => entry.otherHead === tip.head)) {
    replica.log(`[ledger] REFUSED a different account history from ${source} (head ${shortHead(tip.head)}, revision ${tip.revision}); `
      + `keeping ours (head ${shortHead(stored.checkpoint.head)}, revision ${stored.checkpoint.revision})`);
  }
  const known = stored.divergences.find(entry => entry.source === source);
  if (known !== undefined && known.otherHead === tip.head && known.otherRevision === tip.revision
    && now >= known.lastSeen && now - known.lastSeen < DIVERGENCE_LAST_SEEN_RESOLUTION_MS) return stored;
  const firstSeen = known?.firstSeen ?? now;
  const entry: LedgerDivergence = { source, otherHead: tip.head, otherRevision: tip.revision, firstSeen, lastSeen: Math.max(now, firstSeen) };
  return persist(replica, { ...stored, divergences: ordered([...withoutSource(stored.divergences, source), entry]) });
}
/** Writes a state whose chain and sticky set are unchanged (only divergences or lastServerReadAt differ). */
async function persist(replica: Replica, state: BridgeLedgerState): Promise<BridgeLedgerState> {
  await save(replica, state);
  return state;
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
 * Binds an empty store, or applies the append-only rule to a bound one, for a chain the caller has authenticated (a refused or behind
 * chain leaves the stored one deciding). The resulting trusted roster must list this bridge (`isMember`); on any failure throws
 * LedgerStoreError(code) and writes nothing. Returns trusted().
 */
async function admit(
  replica: Replica, stored: BridgeLedgerState | null, ledger: Ledger, now: number,
  isMember: (trusted: LedgerCheckpoint) => boolean, code: LedgerStoreErrorCode,
): Promise<LedgerCheckpoint> {
  let next: Decided;
  let adoption: string | null = null;
  if (stored === null) {
    let first: LedgerChoice;
    try { first = await chooseLedger(null, ledger, now); } catch { throw new LedgerStoreError(code); }
    next = { ledger: first.ledger, checkpoint: first.checkpoint, sticky: union(NO_REVOCATIONS, ledgerRevocations(first.ledger)), lastServerReadAt: null, divergences: [] };
  } else {
    const choice = await chooseLedger(stored.ledger, ledger, now, cacheOf(stored));
    if (choice.decision === 'reject') throw new LedgerStoreError(code);
    if (choice.decision === 'adopt') {
      const divergent = choice.relation === 'diverged';
      next = { ledger: choice.ledger, checkpoint: choice.checkpoint, sticky: adoptedSticky(stored.sticky, choice), lastServerReadAt: stored.lastServerReadAt,
        divergences: divergent ? [] : stored.divergences };
      if (divergent) adoption = adoptionLine(stored, choice);
    } else {
      // keep (same, behind or a refused divergence): ours decides, and nothing of the candidate is merged.
      next = { ledger: stored.ledger, checkpoint: stored.checkpoint, sticky: stored.sticky, lastServerReadAt: stored.lastServerReadAt, divergences: stored.divergences };
    }
  }
  let trusted: LedgerCheckpoint;
  try { trusted = applyRevocations(next.checkpoint, next.sticky); } catch { throw new LedgerStoreError(code); }
  if (!isMember(trusted)) throw new LedgerStoreError(code);
  if (stored === null || next.ledger !== stored.ledger || !sameSticky(next.sticky, stored.sticky)) await save(replica, { ...next, trusted });
  if (adoption !== null) replica.log(adoption);
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

  /** The startup decision (ledger-startup ownStatusAction): 'active' iff trusted() lists bridgeId with this auth key; 'revoked' iff the stored
   *  chain proves this bridge's removal (it added bridgeId with this key, then revoked it); else 'absent' (a tombstone is not a removal). */
  async ownBridgeStatus(bridgeId: string, authPublicKey: string): Promise<OwnBridgeStatus> {
    return serialized(this.replica.file, async () => statusOf(await load(this.replica), bridgeId, authPublicKey));
  }

  /**
   * Offers an untrusted candidate chain from the server or the relay (see decide for the rule). Never binds an empty store, and never
   * throws for a bad candidate: it is rejected. Throws LedgerStoreError for a corrupted or wrong-account local file, and
   * BridgeSecurityError('storage_unavailable') when the file cannot be read or written.
   */
  offer(candidate: unknown, source: LedgerSource): Promise<LedgerOfferResult> {
    return serialized(this.replica.file, async () => structuredClone(await decide(this.replica, candidate, source)));
  }

  /**
   * The pairing path, after openPairApproval. Runs confirmPairedLedger(link, approval, ledger, now, sticky) with this replica's sticky
   * set, then binds the empty store (or applies the append-only rule to a bound store of the same account); the request's bridge must be in
   * the resulting trusted roster. Returns trusted(). Throws LedgerStoreError('ledger_store_pairing_revoked') when the chain (or this
   * replica's sticky set) revokes the request's bridge id, LedgerStoreError('ledger_store_pairing_rejected') on any other pairing failure;
   * writes nothing in either case.
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
      try { await confirmPairedLedger(link, approval, parsed, at, sticky); }
      catch {
        // A VALID chain of the approved account that revokes this request's bridge id (a tombstone, or a removal right after the approval):
        // the id can never be a member, so retrying the same pairing would loop. It is not the removal of a paired bridge: nothing is reset.
        if (sticky.bridgeIds.indexOf(link.request.bridgeId) !== -1 && await accountIdOf(parsed.genesis.payload) === approval.accountId) {
          let valid = true;
          try { await verifyLedger(parsed, at); } catch { valid = false; }
          if (valid) throw new LedgerStoreError('ledger_store_pairing_revoked');
        }
        throw rejected();
      }
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
