import { createHash } from 'node:crypto';
import { maxAccounts } from '@/lib/account-limits';
import { getDb } from '@/lib/db';
import { CREATION_MAX_BYTES, CREATION_MAX_RECORDS } from '@/lib/ledger-limits';
import { expectedRpId, publicOrigin } from '@/lib/public-origin';
import { isRegistrationEnabled } from '@/lib/registration';
import { accountIdOf, applyRevocations, chooseLedger, ledgerRevocations, parseLedger, verifyLedger } from '@security/ledger/ledger';
import type { Ledger, LedgerCheckpoint } from '@security/ledger/protocol';

export interface Sticky { deviceIds: string[]; bridgeIds: string[] }
export interface StoredLedger {
  ledger: Ledger;
  /** Raw checkpoint of the stored chain. Never use it for a trust decision. */
  checkpoint: LedgerCheckpoint;
  /** applyRevocations(checkpoint, sticky): the only checkpoint a trust decision may use. */
  trusted: LedgerCheckpoint;
  sticky: Sticky;
}
export type LedgerKey = { accountId: string } | { handle: string };
export type OfferDecision = 'created' | 'adopt' | 'keep' | 'reject';
/** Why a chain was refused when the server holds no account for it (or it does not even parse). */
export type CreationRejection = 'invalid_ledger' | 'registration_closed' | 'creation_too_large' | 'origin_mismatch' | 'server_full' | 'handle_taken' | 'rate_limited';
export type OfferResult =
  | { decision: 'created' | 'adopt' | 'keep'; stored: StoredLedger; discarded: number }
  /** Existing account: the candidate does not replace the stored chain, which is returned. */
  | { decision: 'reject'; stored: StoredLedger; discarded: number }
  /** No account was created or touched. */
  | { decision: 'reject'; stored: null; discarded: number; reason: CreationRejection };
export interface OfferOptions {
  /** Creation budget. Awaited at most once per offer, and only when the candidate would create an account: after the cheap gates
   *  (registration, creation size, add_device, origin binding) and before any signature verification. false → reason rate_limited.
   *  Omitted: creation is not throttled. */
  admitCreation?: () => Promise<boolean>;
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

function build(ledger: Ledger, checkpoint: LedgerCheckpoint, sticky: Sticky): StoredLedger {
  return { ledger, checkpoint, trusted: applyRevocations(checkpoint, sticky), sticky };
}

export async function accountCount(): Promise<number> {
  const rows = await query('SELECT COUNT(*)::int AS count FROM accounts', []);
  const count = rows[0]?.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return corrupt();
  return count;
}

const MEMO_SIZE = 32;
const memo = new Map<string, { ledger: Ledger; checkpoint: LedgerCheckpoint }>();
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const remember = (key: string, value: { ledger: Ledger; checkpoint: LedgerCheckpoint }): void => {
  memo.delete(key);
  memo.set(key, value);
  while (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value as string);
};

/** Verifies on read and cross-checks the denormalised columns; a row that does not verify is corruption, never "absent". */
export async function readLedger(key: LedgerKey): Promise<StoredLedger | null> {
  return (await readRow(key))?.stored ?? null;
}

async function readRow(key: LedgerKey): Promise<{ stored: StoredLedger; version: number } | null> {
  const byHandle = 'handle' in key;
  const rows = await query(`SELECT l.account_id, a.handle, l.revision, l.head, l.ledger, l.sticky, l.version FROM account_ledger l
    JOIN accounts a ON a.account_id=l.account_id WHERE ${byHandle ? 'a.handle' : 'l.account_id'}=$1`, [byHandle ? key.handle : key.accountId]);
  if (!rows.length) return null;
  if (rows.length !== 1) return corrupt();
  const row = rows[0];
  let ledger: Ledger;
  let checkpoint: LedgerCheckpoint;
  let sticky: Sticky;
  try {
    const text = JSON.stringify(jsonb(row.ledger));
    const hash = digest(text);
    const known = memo.get(hash);
    if (known) { ledger = known.ledger; checkpoint = known.checkpoint; } else {
      ledger = parseLedger(jsonb(row.ledger));
      checkpoint = await verifyLedger(ledger);
      remember(hash, { ledger, checkpoint });
    }
    sticky = parseSticky(row.sticky);
  } catch { return corrupt(); }
  if (checkpoint.accountId !== row.account_id || checkpoint.revision !== row.revision || checkpoint.head !== row.head
    || ledger.genesis.payload.handle !== row.handle || (byHandle ? row.handle !== key.handle : row.account_id !== key.accountId)) return corrupt();
  if (typeof row.version !== 'number' || !Number.isSafeInteger(row.version)) return corrupt();
  try { return { stored: build(ledger, checkpoint, sticky), version: row.version }; } catch { return corrupt(); }
}

type Attempt = { done: true; result: OfferResult } | { done: false };
const refuse = (reason: CreationRejection): Attempt => ({ done: true, result: { decision: 'reject', stored: null, discarded: 0, reason } });
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === '23505';

/** Genesis admission for an accountId the server holds no row for. Checks run in a fixed order and the first failure wins. */
async function create(candidate: Ledger, accountId: string, admit: () => Promise<boolean>): Promise<Attempt> {
  // Cheap gates first: no creation budget is spent and nothing is signature-verified unless they all pass.
  if (!isRegistrationEnabled()) return refuse('registration_closed');
  if (1 + candidate.transitions.length > CREATION_MAX_RECORDS || Buffer.byteLength(JSON.stringify(candidate), 'utf8') > CREATION_MAX_BYTES) return refuse('creation_too_large');
  if (!candidate.transitions.some(item => item.payload.operation.type === 'add_device')) return refuse('invalid_ledger');
  // The account is bound permanently to its genesis origins/rpId, so only this server's own are accepted.
  const { origins, rpId } = candidate.genesis.payload;
  try {
    if (origins.length !== 1 || origins[0] !== publicOrigin() || rpId !== expectedRpId()) return refuse('origin_mismatch');
  } catch { return refuse('origin_mismatch'); }
  if (!await admit()) return refuse('rate_limited');
  let checkpoint: LedgerCheckpoint;
  let sticky: Sticky;
  let built: StoredLedger;
  try {
    checkpoint = await verifyLedger(candidate);
    sticky = unionSticky(EMPTY, ledgerRevocations(candidate));
    built = build(candidate, checkpoint, sticky);
  } catch { return refuse('invalid_ledger'); }
  // Soft cap: the count and the insert are separate statements, so concurrent creations can overshoot it by a few.
  if (await accountCount() >= maxAccounts()) return refuse('server_full');
  // One statement: the account row and its ledger appear together. account_id is the only arbiter, so a handle held by another
  // account raises a unique violation instead of being silently skipped.
  let rows: Record<string, unknown>[];
  try {
    rows = await query(`WITH a AS (INSERT INTO accounts(account_id,handle) VALUES ($1,$2) ON CONFLICT (account_id) DO NOTHING RETURNING account_id)
      INSERT INTO account_ledger(account_id,revision,head,ledger,sticky) SELECT account_id,$3,$4,$5::jsonb,$6::jsonb FROM a RETURNING account_id`,
    [accountId, candidate.genesis.payload.handle, checkpoint.revision, checkpoint.head, JSON.stringify(candidate), JSON.stringify(sticky)]);
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

async function attempt(candidate: Ledger, accountId: string, admit: () => Promise<boolean>): Promise<Attempt> {
  const row = await readRow({ accountId });
  if (!row) return create(candidate, accountId, admit);
  const { stored, version } = row;
  const choice = await chooseLedger(stored.ledger, candidate, Date.now(), { head: stored.checkpoint.head, checkpoint: stored.checkpoint });
  if (choice.decision === 'reject') return { done: true, result: { decision: 'reject', stored, discarded: 0 } };
  const sticky = unionSticky(stored.sticky, ledgerRevocations(candidate));
  const adopt = choice.decision === 'adopt';
  if (!adopt && sameSticky(sticky, stored.sticky)) return { done: true, result: { decision: 'keep', stored, discarded: 0 } };
  const next = adopt ? { ledger: candidate, checkpoint: choice.checkpoint } : { ledger: stored.ledger, checkpoint: stored.checkpoint };
  // Built BEFORE writing: an over-limit sticky set is rejected here and can never be persisted.
  let built: StoredLedger;
  try { built = build(next.ledger, next.checkpoint, sticky); } catch { return { done: true, result: { decision: 'reject', stored, discarded: 0 } }; }
  // version makes the check cover sticky too: two concurrent keeps that add different ids cannot overwrite each other.
  const rows = await query(`UPDATE account_ledger SET revision=$2,head=$3,ledger=$4::jsonb,sticky=$5::jsonb,version=version+1,updated_at=NOW()
    WHERE account_id=$1 AND version=$6 AND revision=$7 AND head=$8 RETURNING account_id`,
  [accountId, next.checkpoint.revision, next.checkpoint.head, JSON.stringify(next.ledger), JSON.stringify(sticky), version, stored.checkpoint.revision, stored.checkpoint.head]);
  if (rows.length !== 1) return { done: false };
  return { done: true, result: { decision: adopt ? 'adopt' : 'keep', stored: built, discarded: adopt ? choice.discarded.length : 0 } };
}

/** Replica rule. A chain that does not parse: reject, reason invalid_ledger.
 *  No account for its genesis yet (creation): registration_closed, creation_too_large (CREATION_MAX_BYTES / CREATION_MAX_RECORDS),
 *  invalid_ledger (no add_device), origin_mismatch (origins must be exactly [publicOrigin()], rpId expectedRpId()), then
 *  options.admitCreation (rate_limited), then full verification (invalid_ledger), the maxAccounts() soft cap (server_full) and the insert
 *  (handle_taken when another account holds the handle). Losing the insert to an identical creation is not an error: it is re-read and
 *  answered as a replica offer.
 *  Existing account: chooseLedger (the longest chain wins), with no creation limit; keep and adopt add the candidate's revocations to the
 *  sticky set, reject changes nothing and returns the stored chain. Optimistic concurrency on (version, revision, head); a lost race is
 *  re-read and re-run once, then throws. */
export async function offerLedger(candidate: unknown, options: OfferOptions = {}): Promise<OfferResult> {
  let parsed: Ledger;
  let accountId: string;
  try {
    parsed = parseLedger(candidate);
    accountId = await accountIdOf(parsed.genesis.payload);
  } catch { return { decision: 'reject', stored: null, discarded: 0, reason: 'invalid_ledger' }; }
  let admission: Promise<boolean> | null = null;
  const admit = (): Promise<boolean> => (admission ??= options.admitCreation ? options.admitCreation() : Promise.resolve(true));
  for (let round = 0; round < 2; round += 1) {
    const result = await attempt(parsed, accountId, admit);
    if (result.done) return result.result;
  }
  throw new Error('account_ledger_conflict');
}
