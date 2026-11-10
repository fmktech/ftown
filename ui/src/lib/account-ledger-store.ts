import { createHash } from 'node:crypto';
import { maxAccounts } from '@/lib/account-limits';
import { getDb } from '@/lib/db';
import { CREATION_MAX_BYTES, CREATION_MAX_RECORDS } from '@/lib/ledger-limits';
import { expectedRpId, publicOrigin } from '@/lib/public-origin';
import { isRegistrationEnabled } from '@/lib/registration';
import { accountIdOf, applyRevocations, chooseLedger, ledgerHead, ledgerRevocations, parseLedger, verifyLedger } from '@security/ledger/ledger';
import type { LedgerCache } from '@security/ledger/ledger';
import type { Ledger, LedgerCheckpoint } from '@security/ledger/protocol';

/*
 * Trust. The database row is not a trust anchor for clients: bridges and browsers verify every chain they receive themselves. For the
 * server's own decisions a database writer is already inside the trust boundary (it could rewrite any table, sessions included), so
 * re-verifying a stored chain on every read bought nothing and cost a full signature check per request. A chain is verified once,
 * before it is written, and every write persists, in the same statement, the trusted checkpoint the auth paths read. Reads check
 * structure and that the row's columns agree with each other; any disagreement is corruption, never "absent".
 */

export interface Sticky { deviceIds: string[]; bridgeIds: string[] }
export interface StoredLedger {
  /** The stored chain, served as-is. */
  ledger: Ledger;
  /** The chain's checkpoint with the sticky revocations applied: the only checkpoint a trust decision may use. */
  trusted: LedgerCheckpoint;
  sticky: Sticky;
}
export type LedgerKey = { accountId: string } | { handle: string };
export type OfferDecision = 'created' | 'adopt' | 'keep' | 'reject';
/** Why a chain was refused when the server holds no account for it (or it does not even parse). */
export type CreationRejection = 'invalid_ledger' | 'registration_closed' | 'creation_too_large' | 'origin_mismatch' | 'server_misconfigured'
  | 'server_full' | 'handle_taken' | 'rate_limited';
export type OfferResult =
  | { decision: 'created' | 'adopt' | 'keep'; stored: StoredLedger; discarded: number }
  /** Existing account: the stored chain stays (and is returned). reason rate_limited: the write was refused by admitAccountWrite. */
  | { decision: 'reject'; stored: StoredLedger; discarded: number; reason?: 'rate_limited' }
  /** No account was created or touched. */
  | { decision: 'reject'; stored: null; discarded: number; reason: CreationRejection };
/** Required: no chain can be created or written unthrottled by omission. Each hook is awaited at most once per offer. */
export interface OfferLimits {
  /** Only when the candidate would create an account, after it fully verified and before the soft cap and the insert. */
  admitCreation: () => Promise<boolean>;
  /** Only for an existing account, when the verified candidate leads to a real row write (adopt, or keep with new sticky ids). */
  admitAccountWrite: (accountId: string) => Promise<boolean>;
}
export type LedgerQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

const query: LedgerQuery = (text, params) => getDb().query(text, params) as Promise<Record<string, unknown>[]>;
const corrupt = (): never => { throw new Error('account_ledger_corrupt'); };
const union = (a: string[], b: string[]): string[] => a.concat(b.filter(id => a.indexOf(id) === -1));
const unionSticky = (a: Sticky, b: Sticky): Sticky => ({ deviceIds: union(a.deviceIds, b.deviceIds), bridgeIds: union(a.bridgeIds, b.bridgeIds) });
const sameSticky = (a: Sticky, b: Sticky): boolean => a.deviceIds.length === b.deviceIds.length && a.bridgeIds.length === b.bridgeIds.length;
const EMPTY: Sticky = { deviceIds: [], bridgeIds: [] };

function parseSticky(value: unknown): Sticky {
  const record = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return corrupt();
  const { deviceIds, bridgeIds, ...rest } = record as Record<string, unknown>;
  const strings = (list: unknown): string[] => {
    if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) return corrupt();
    return list as string[];
  };
  if (Object.keys(rest).length) return corrupt();
  return { deviceIds: strings(deviceIds), bridgeIds: strings(bridgeIds) };
}
const jsonb = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value);
const safeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function build(ledger: Ledger, checkpoint: LedgerCheckpoint, sticky: Sticky): StoredLedger {
  return { ledger, trusted: applyRevocations(checkpoint, sticky), sticky };
}

export async function accountCount(): Promise<number> {
  const rows = await query('SELECT COUNT(*)::int AS count FROM accounts', []);
  const count = rows[0]?.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return corrupt();
  return count;
}

/** Checkpoints of chains this process verified (rows without a persisted checkpoint, and fork choice against sticky rows), LRU. */
const MEMO_SIZE = 32;
const memo = new Map<string, LedgerCheckpoint>();
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
async function verified(ledger: Ledger): Promise<LedgerCheckpoint> {
  const key = digest(JSON.stringify(ledger));
  const known = memo.get(key);
  if (known) {
    memo.delete(key);
    memo.set(key, known);
    return known;
  }
  const checkpoint = await verifyLedger(ledger);
  memo.set(key, checkpoint);
  while (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value as string);
  return checkpoint;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
/** a, then the ids of b not already present, in order (applyRevocations' order). */
function mergeIds(a: string[], b: string[]): string[] {
  const seen = new Set(a);
  const out = a.slice();
  for (const id of b) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

/** The persisted trusted checkpoint, structurally checked, with the row's sticky set applied again. Not the strict checkpoint parser:
 *  a trusted checkpoint may list more revoked ids (chain + sticky) than a chain's own checkpoint can. Re-applying sticky is idempotent
 *  for a checkpoint written with that set (applyRevocations' exact result), and keeps a revocation in force even if the column lagged. */
function persistedTrust(row: Record<string, unknown>, sticky: Sticky): LedgerCheckpoint {
  let value: unknown;
  try { value = jsonb(row.checkpoint); } catch { return corrupt(); }
  if (!isRecord(value) || value.version !== 2 || value.accountId !== row.account_id || value.head !== row.head || value.revision !== row.revision
    || !Array.isArray(value.authorities) || !value.authorities.length || !value.authorities.every(isRecord)
    || !Array.isArray(value.devices) || !value.devices.every(item => isRecord(item) && isRecord(item.endpoint) && typeof item.endpoint.id === 'string')
    || !Array.isArray(value.bridges) || !value.bridges.every(item => isRecord(item) && typeof item.bridgeId === 'string')
    || !strings(value.revokedDeviceIds) || !strings(value.revokedBridgeIds)) return corrupt();
  const checkpoint = value as unknown as LedgerCheckpoint;
  const deviceIds = new Set(sticky.deviceIds);
  const bridgeIds = new Set(sticky.bridgeIds);
  return {
    ...checkpoint,
    devices: checkpoint.devices.filter(item => !deviceIds.has(item.endpoint.id)),
    bridges: checkpoint.bridges.filter(item => !bridgeIds.has(item.bridgeId)),
    revokedDeviceIds: mergeIds(checkpoint.revokedDeviceIds, sticky.deviceIds),
    revokedBridgeIds: mergeIds(checkpoint.revokedBridgeIds, sticky.bridgeIds),
  };
}

/** Rows written before checkpoints were persisted: one verification, then the column is filled in. The version guard keeps a
 *  concurrent writer's newer checkpoint; the version is not bumped, since neither the chain nor the sticky set changed. */
async function backfill(row: Record<string, unknown>, ledger: Ledger, sticky: Sticky): Promise<{ trusted: LedgerCheckpoint; raw: LedgerCheckpoint }> {
  let raw: LedgerCheckpoint;
  let trusted: LedgerCheckpoint;
  try {
    raw = await verified(ledger);
    trusted = applyRevocations(raw, sticky);
  } catch { return corrupt(); }
  if (raw.accountId !== row.account_id || raw.head !== row.head || raw.revision !== row.revision) return corrupt();
  await query('UPDATE account_ledger SET checkpoint=$2::jsonb WHERE account_id=$1 AND version=$3 AND checkpoint IS NULL',
    [row.account_id, JSON.stringify(trusted), row.version]);
  return { trusted, raw };
}

/** The trusted checkpoint for an auth decision: one small SELECT, no chain parse and no signature verification (see "Trust"). */
export async function readTrustedCheckpoint(accountId: string): Promise<LedgerCheckpoint | null> {
  const rows = await query('SELECT account_id, revision, head, sticky, version, checkpoint FROM account_ledger WHERE account_id=$1', [accountId]);
  if (!rows.length) return null;
  if (rows.length !== 1) return corrupt();
  const row = rows[0];
  if (row.account_id !== accountId || !safeInteger(row.version)) return corrupt();
  if (row.checkpoint === null || row.checkpoint === undefined) return (await readRow({ accountId }))?.stored.trusted ?? null;
  let sticky: Sticky;
  try { sticky = parseSticky(row.sticky); } catch { return corrupt(); }
  return persistedTrust(row, sticky);
}

/** The stored chain, served as-is after the key consistency checks; it is not re-verified (see "Trust"). */
export async function readLedger(key: LedgerKey): Promise<StoredLedger | null> {
  return (await readRow(key))?.stored ?? null;
}

type Row = { stored: StoredLedger; version: number; raw: LedgerCheckpoint | null };

async function readRow(key: LedgerKey): Promise<Row | null> {
  const byHandle = 'handle' in key;
  const rows = await query(`SELECT l.account_id, a.handle, l.revision, l.head, l.ledger, l.sticky, l.version, l.checkpoint FROM account_ledger l
    JOIN accounts a ON a.account_id=l.account_id WHERE ${byHandle ? 'a.handle' : 'l.account_id'}=$1`, [byHandle ? key.handle : key.accountId]);
  if (!rows.length) return null;
  if (rows.length !== 1) return corrupt();
  const row = rows[0];
  let ledger: Ledger;
  let sticky: Sticky;
  try {
    ledger = parseLedger(jsonb(row.ledger));
    sticky = parseSticky(row.sticky);
  } catch { return corrupt(); }
  if (ledger.genesis.payload.handle !== row.handle || ledger.transitions.length !== row.revision || !safeInteger(row.version)
    || (byHandle ? row.handle !== key.handle : row.account_id !== key.accountId)) return corrupt();
  // Two hashes, no signature: the chain in the row is the one its columns (and so its checkpoint) name.
  const last = ledger.transitions[ledger.transitions.length - 1];
  try {
    if (await accountIdOf(ledger.genesis.payload) !== row.account_id || (last ? await ledgerHead(last.payload) : row.account_id) !== row.head) return corrupt();
  } catch { return corrupt(); }
  if (row.checkpoint === null || row.checkpoint === undefined) {
    const { trusted, raw } = await backfill(row, ledger, sticky);
    return { stored: { ledger, trusted, sticky }, version: row.version, raw };
  }
  return { stored: { ledger, trusted: persistedTrust(row, sticky), sticky }, version: row.version, raw: null };
}

/** chooseLedger's cache for the stored side. With no sticky ids the trusted checkpoint IS the chain's checkpoint (applyRevocations
 *  removes nothing), so it vouches for the chain without a signature check. With sticky ids it no longer describes the chain and must
 *  never be the cache: the chain's own checkpoint is verified once and memoised. */
async function cacheFor(row: Row): Promise<LedgerCache> {
  const { stored, raw } = row;
  if (raw) return { head: raw.head, checkpoint: raw };
  if (!stored.sticky.deviceIds.length && !stored.sticky.bridgeIds.length) return { head: stored.trusted.head, checkpoint: stored.trusted };
  let checkpoint: LedgerCheckpoint;
  try { checkpoint = await verified(stored.ledger); } catch { return corrupt(); }
  return { head: checkpoint.head, checkpoint };
}

type Attempt = { done: true; result: OfferResult } | { done: false };
type Gate = () => Promise<boolean>;
const refuse = (reason: CreationRejection): Attempt => ({ done: true, result: { decision: 'reject', stored: null, discarded: 0, reason } });
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === '23505';

/** Genesis admission for an accountId the server holds no row for. Checks run in a fixed order and the first failure wins. */
async function create(candidate: Ledger, accountId: string, admitCreation: Gate): Promise<Attempt> {
  if (!isRegistrationEnabled()) return refuse('registration_closed');
  // Bounded before any signature work, so the verification below is cheap.
  if (1 + candidate.transitions.length > CREATION_MAX_RECORDS || Buffer.byteLength(JSON.stringify(candidate), 'utf8') > CREATION_MAX_BYTES) return refuse('creation_too_large');
  if (!candidate.transitions.some(item => item.payload.operation.type === 'add_device')) return refuse('invalid_ledger');
  // The account is bound permanently to its genesis origins/rpId, so only this server's own are accepted.
  let expected: { origin: string; rpId: string };
  try { expected = { origin: publicOrigin(), rpId: expectedRpId() }; } catch (error) {
    console.error(`[ledger] account creation refused, server misconfigured: ${error instanceof Error ? error.message : 'public origin unavailable'}`);
    return refuse('server_misconfigured');
  }
  const { origins, rpId } = candidate.genesis.payload;
  if (origins.length !== 1 || origins[0] !== expected.origin || rpId !== expected.rpId) return refuse('origin_mismatch');
  let checkpoint: LedgerCheckpoint;
  let sticky: Sticky;
  let built: StoredLedger;
  try {
    checkpoint = await verifyLedger(candidate);
    sticky = unionSticky(EMPTY, ledgerRevocations(candidate));
    built = build(candidate, checkpoint, sticky);
  } catch { return refuse('invalid_ledger'); }
  // After verification: unsigned junk cannot spend the creation budget.
  if (!await admitCreation()) return refuse('rate_limited');
  // Soft cap: the count and the insert are separate statements, so concurrent creations can overshoot it by a few.
  if (await accountCount() >= maxAccounts()) return refuse('server_full');
  // One statement: the account row, its ledger and its trusted checkpoint appear together. account_id is the only arbiter, so a handle
  // held by another account raises a unique violation instead of being silently skipped.
  let rows: Record<string, unknown>[];
  try {
    rows = await query(`WITH a AS (INSERT INTO accounts(account_id,handle) VALUES ($1,$2) ON CONFLICT (account_id) DO NOTHING RETURNING account_id)
      INSERT INTO account_ledger(account_id,revision,head,ledger,sticky,checkpoint) SELECT account_id,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb FROM a RETURNING account_id`,
    [accountId, candidate.genesis.payload.handle, checkpoint.revision, checkpoint.head, JSON.stringify(candidate), JSON.stringify(sticky), JSON.stringify(built.trusted)]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // The handle index can also fire for an identical creation that committed between the arbiter check and our index insert;
    // only that case leaves a row under this accountId (the handle is part of the genesis, so a same-handle account is another id).
    return await readRow({ accountId }) ? { done: false } : refuse('handle_taken');
  }
  if (rows.length === 1) return { done: true, result: { decision: 'created', stored: built, discarded: 0 } };
  // account_id conflict: an identical creation won; the caller re-reads and treats this chain as a replica offer.
  return { done: false };
}

/** Replica rule for an existing account. */
async function replicate(candidate: Ledger, accountId: string, row: Row, admitAccountWrite: Gate): Promise<Attempt> {
  const { stored, version } = row;
  const choice = await chooseLedger(stored.ledger, candidate, Date.now(), await cacheFor(row));
  if (choice.decision === 'reject') return { done: true, result: { decision: 'reject', stored, discarded: 0 } };
  const sticky = unionSticky(stored.sticky, ledgerRevocations(candidate));
  const adopt = choice.decision === 'adopt';
  if (!adopt && sameSticky(sticky, stored.sticky)) return { done: true, result: { decision: 'keep', stored, discarded: 0 } };
  // choice.checkpoint is the candidate's on adopt and the stored chain's own on keep.
  const nextLedger = adopt ? candidate : stored.ledger;
  // Built BEFORE writing: an over-limit sticky set is rejected here and can never be persisted.
  let built: StoredLedger;
  try { built = build(nextLedger, choice.checkpoint, sticky); } catch { return { done: true, result: { decision: 'reject', stored, discarded: 0 } }; }
  // Only a verified candidate that really changes the row spends the account's write budget: a third party replaying public or
  // junk chains cannot exhaust it and block the owner's revocations.
  if (!await admitAccountWrite()) return { done: true, result: { decision: 'reject', stored, discarded: 0, reason: 'rate_limited' } };
  // version makes the check cover sticky too: two concurrent keeps that add different ids cannot overwrite each other.
  const rows = await query(`UPDATE account_ledger SET revision=$2,head=$3,ledger=$4::jsonb,sticky=$5::jsonb,checkpoint=$9::jsonb,version=version+1,updated_at=NOW()
    WHERE account_id=$1 AND version=$6 AND revision=$7 AND head=$8 RETURNING account_id`,
  [accountId, choice.checkpoint.revision, choice.checkpoint.head, JSON.stringify(nextLedger), JSON.stringify(sticky), version,
    stored.trusted.revision, stored.trusted.head, JSON.stringify(built.trusted)]);
  if (rows.length !== 1) return { done: false };
  return { done: true, result: { decision: adopt ? 'adopt' : 'keep', stored: built, discarded: adopt ? choice.discarded.length : 0 } };
}

const once = (gate: Gate): Gate => {
  let admission: Promise<boolean> | null = null;
  return () => (admission ??= gate());
};

/** Replica rule. A chain that does not parse: reject, reason invalid_ledger.
 *  No account for its genesis yet (creation): registration_closed, creation_too_large (CREATION_MAX_BYTES / CREATION_MAX_RECORDS),
 *  invalid_ledger (no add_device), server_misconfigured (no usable public origin), origin_mismatch (origins must be exactly
 *  [publicOrigin()], rpId expectedRpId()), full verification (invalid_ledger), limits.admitCreation (rate_limited), the maxAccounts()
 *  soft cap (server_full) and the insert (handle_taken when another account holds the handle). Losing the insert to an identical
 *  creation is not an error: it is re-read and answered as a replica offer.
 *  Existing account: chooseLedger (the longest chain wins), with no creation limit; keep and adopt add the candidate's revocations to the
 *  sticky set, a real write first passes limits.admitAccountWrite (else reject, reason rate_limited, nothing written), reject changes
 *  nothing and returns the stored chain. Optimistic concurrency on (version, revision, head); a lost race is re-read and re-run once,
 *  then throws. */
export async function offerLedger(candidate: unknown, limits: OfferLimits): Promise<OfferResult> {
  if (typeof limits?.admitCreation !== 'function' || typeof limits.admitAccountWrite !== 'function') throw new TypeError('offerLedger: limits are required');
  let parsed: Ledger;
  let accountId: string;
  try {
    parsed = parseLedger(candidate);
    accountId = await accountIdOf(parsed.genesis.payload);
  } catch { return { decision: 'reject', stored: null, discarded: 0, reason: 'invalid_ledger' }; }
  const admitCreation = once(limits.admitCreation);
  const admitAccountWrite = once(() => limits.admitAccountWrite(accountId));
  for (let round = 0; round < 2; round += 1) {
    const row = await readRow({ accountId });
    const result = row ? await replicate(parsed, accountId, row, admitAccountWrite) : await create(parsed, accountId, admitCreation);
    if (result.done) return result.result;
  }
  throw new Error('account_ledger_conflict');
}
