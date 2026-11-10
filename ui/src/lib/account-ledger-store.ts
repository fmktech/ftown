import { maxAccounts } from '@/lib/account-limits';
import { checkpointMac, checkpointMacValid, requireCheckpointKey } from '@/lib/checkpoint-mac';
import { getDb } from '@/lib/db';
import { CREATION_MAX_BYTES, CREATION_MAX_RECORDS } from '@/lib/ledger-limits';
import { expectedRpId, publicOrigin } from '@/lib/public-origin';
import { isRegistrationEnabled } from '@/lib/registration';
import { accountIdOf, applyRevocations, chooseLedger, ledgerHead, ledgerRevocations, parseLedger, verifyLedger } from '@security/ledger/ledger';
import type { Ledger, LedgerCheckpoint, LedgerGenesis, LedgerTransition } from '@security/ledger/protocol';

/*
 * Trust. Bridges and browsers verify every chain they receive themselves; for them the database is not a trust anchor. The server's
 * own decisions must not trust the database blindly either: sessions are stateless JWTs signed with AUTH_SECRET, so a writer of the
 * database alone must not be able to make the server authorize a key. A chain is verified from its passkey-signed genesis before it is
 * written, and every write stores, in the same statement as the chain, its head, revision and sticky set, the chain's RAW checkpoint
 * (canonical JSON, no sticky applied) and an HMAC over all of them keyed from AUTH_SECRET (checkpoint-mac.ts), a key the database does
 * not hold. Reads trust that checkpoint only when the MAC verifies, it names the row's head and revision, and the chain column's tip
 * (length and last head) is that same head and revision. Anything else (a row from before the columns, a rotated AUTH_SECRET, an
 * older instance that advanced the chain without it, tampering) is healed: the stored chain is verified from genesis again and the
 * row is re-sealed from the CHAIN, with one console.warn per heal. The trusted checkpoint is applyRevocations(raw, sticky), computed
 * on every read.
 * Append-only. The server is the sequencer, not an authority: what it stored is never rewritten. An offer for an existing account is
 * written only when the shared chooseLedger adopts it: a valid chain that strictly extends the stored one ('ahead'), or a valid other
 * history carrying an applicable owner-signed resolve_fork, the one owner-authorized replacement (it must already carry every removal
 * and passkey of the discarded branch). What is written is choice.ledger: the stored prefix byte-for-byte plus the candidate's verified
 * suffix, never the candidate's own copy of the prefix. The same chain or a prefix of it is kept and nothing is written. A VALID chain
 * that diverges without such a resolve_fork is refused as 'diverged' whatever its length or content, and nothing from it is recorded,
 * its revocations included. An invalid chain is rejected. Sticky ids are revocations kept enforced although the stored chain does not
 * carry them: rows written by older code may hold some, and any id chooseLedger reports as discarded is added (it reports none since
 * resolutions must carry removals). Every write also merges the stored chain's own revocations, which its raw checkpoint enforces anyway.
 * Residual risk, accepted: a database-only writer can roll an account back to ANY signed prefix of its chain (no old snapshot needed),
 * with the sticky set edited to match, and the heal re-seals that state, reviving keys revoked later. It can never make the server
 * authorize a key that no passkey-signed chain of the account lists. This was equally possible before the checkpoint existed (reads
 * re-verified whatever chain the column held; sticky was never authenticated). Clients verify chains themselves and never follow a chain
 * that does not extend their own, and the server moves forward again as soon as a client offers a chain that extends the rolled-back
 * one (its next write, or a re-offer).
 */

export interface Sticky { deviceIds: string[]; bridgeIds: string[] }
export interface StoredLedger {
  /** The stored chain, served as-is (it was verified before it was written; clients verify it again). */
  ledger: Ledger;
  /** applyRevocations(raw checkpoint, sticky): the only checkpoint a trust decision may use. */
  trusted: LedgerCheckpoint;
  sticky: Sticky;
}
export type LedgerKey = { accountId: string } | { handle: string };
export type OfferDecision = 'created' | 'adopt' | 'keep' | 'reject';
/** Why a chain was refused when the server holds no account for it (or it does not even parse). */
export type CreationRejection = 'invalid_ledger' | 'registration_closed' | 'creation_too_large' | 'origin_mismatch' | 'server_misconfigured'
  | 'server_full' | 'handle_taken' | 'rate_limited';
/** discarded: the number of stored records an adopted owner-chosen history replaced (0 unless a diverged chain was adopted). */
export type OfferResult =
  | { decision: 'created' | 'adopt' | 'keep'; stored: StoredLedger; discarded: number }
  /** Existing account: nothing was written and the stored chain is returned. No reason: the candidate is invalid (or would push the
   *  sticky set over its limit). reason diverged: a VALID other history with no applicable resolve_fork; never adopted, and nothing
   *  from it is recorded. reason rate_limited: the write was refused by admitAccountWrite. reason head_changed: the stored head is not
   *  options.expectHead; nothing was chosen or written. */
  | { decision: 'reject'; stored: StoredLedger; discarded: number; reason?: 'rate_limited' | 'head_changed' | 'diverged' }
  /** No account was created or touched. reason account_unknown: options.expectHead was given and no account exists. */
  | { decision: 'reject'; stored: null; discarded: number; reason: CreationRejection | 'account_unknown' };
/** expectHead: a re-offer of a chain the client holds, made against the stored head it just read (a 43-character head). */
export interface OfferOptions { expectHead?: string }
/** Required: no chain can be created or written unthrottled by omission. Each hook is awaited at most once per offer. */
export interface OfferLimits {
  /** Only when the candidate would create an account, after it fully verified and before the soft cap and the insert. */
  admitCreation: () => Promise<boolean>;
  /** Only for an existing account, when the verified candidate is adopted (the only real row write), before the write. */
  admitAccountWrite: (accountId: string) => Promise<boolean>;
}
export type LedgerQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

const query: LedgerQuery = (text, params) => getDb().query(text, params) as Promise<Record<string, unknown>[]>;
const corrupt = (): never => { throw new Error('account_ledger_corrupt'); };
const union = (a: string[], b: string[]): string[] => a.concat(b.filter(id => a.indexOf(id) === -1));
const unionSticky = (a: Sticky, b: Sticky): Sticky => ({ deviceIds: union(a.deviceIds, b.deviceIds), bridgeIds: union(a.bridgeIds, b.bridgeIds) });
const EMPTY: Sticky = { deviceIds: [], bridgeIds: [] };
/** Heal rounds before a row that keeps changing under us is reported as a conflict. */
const HEAL_ATTEMPTS = 3;

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

/** The shared trust rule, never a local copy of it. Throws on an over-limit sticky set. */
const trustedOf = (raw: LedgerCheckpoint, sticky: Sticky): LedgerCheckpoint => applyRevocations(raw, sticky);
function build(ledger: Ledger, raw: LedgerCheckpoint, sticky: Sticky): StoredLedger {
  return { ledger, trusted: trustedOf(raw, sticky), sticky };
}

/** The checkpoint columns for a row: canonical JSON of the raw checkpoint and its MAC over the row's other trust inputs. */
function sealed(accountId: string, raw: LedgerCheckpoint, sticky: Sticky): { text: string; mac: string } {
  const text = JSON.stringify(raw);
  return { text, mac: checkpointMac({ accountId, revision: raw.revision, head: raw.head, sticky, checkpoint: text }) };
}

/** Why a row's checkpoint is not trusted (logged, never more): no seal at all; a seal that does not verify (rotated AUTH_SECRET,
 *  tampering, a non-text column); a seal of another head or revision than the row (an older instance advanced the chain without it);
 *  a chain column whose tip is not the row's head and revision. */
type HealReason = 'absent' | 'mac_mismatch' | 'stale_head' | 'chain_mismatch';
type Seal = { raw: LedgerCheckpoint } | { reason: HealReason };

/** The row's raw checkpoint if its seal holds. Parsed by the shared strict checkpoint parser (applyRevocations with no sticky ids is
 *  its exported entry: parseCheckpoint itself is not exported). A checkpoint value that is not a string is never trusted. */
function unseal(row: Record<string, unknown>, sticky: Sticky): Seal {
  const text = row.checkpoint;
  if (text === null || text === undefined || row.checkpoint_mac === null || row.checkpoint_mac === undefined) return { reason: 'absent' };
  if (typeof text !== 'string' || typeof row.account_id !== 'string' || typeof row.head !== 'string' || !safeInteger(row.revision)) return { reason: 'mac_mismatch' };
  const macValid = checkpointMacValid({ accountId: row.account_id, revision: row.revision, head: row.head, sticky, checkpoint: text }, row.checkpoint_mac);
  let raw: LedgerCheckpoint | null;
  try { raw = applyRevocations(JSON.parse(text) as LedgerCheckpoint, EMPTY); } catch { raw = null; }
  if (raw && (raw.accountId !== row.account_id || raw.head !== row.head || raw.revision !== row.revision)) return { reason: 'stale_head' };
  return raw && macValid ? { raw } : { reason: 'mac_mismatch' };
}

/** The head of a chain's last record (the genesis when there are no transitions; ledgerHead(genesis) is the accountId), or null. */
async function tipHead(payload: unknown): Promise<string | null> {
  try { return await ledgerHead(payload as LedgerGenesis | LedgerTransition); } catch { return null; }
}

const ACCOUNT_ID = /^[A-Za-z0-9_-]{43}$/;
/** Heal: verify the stored chain from genesis and re-seal the row FROM THE CHAIN (its revision and head follow the verified chain),
 *  guarded by the row's version, revision and head as read; the version is not bumped (chain and sticky set are unchanged). null when
 *  the row moved meanwhile: the caller re-reads. A chain that does not verify, or belongs to another account, is corruption. */
async function heal(row: Record<string, unknown>, ledger: Ledger, sticky: Sticky, reason: HealReason): Promise<LedgerCheckpoint | null> {
  let raw: LedgerCheckpoint;
  try {
    raw = await verifyLedger(ledger);
    trustedOf(raw, sticky);
  } catch { return corrupt(); }
  if (raw.accountId !== row.account_id) return corrupt();
  const { text, mac } = sealed(raw.accountId, raw, sticky);
  const rows = await query('UPDATE account_ledger SET checkpoint=$2, checkpoint_mac=$3, revision=$7, head=$8 WHERE account_id=$1 AND version=$4 AND revision=$5 AND head=$6 RETURNING account_id',
    [raw.accountId, text, mac, row.version, row.revision, row.head, raw.revision, raw.head]);
  if (rows.length !== 1) return null;
  const account = typeof row.account_id === 'string' && ACCOUNT_ID.test(row.account_id) ? row.account_id.slice(0, 8) : '?';
  const before = safeInteger(row.revision) ? row.revision : '?';
  console.warn(`[ledger] checkpoint healed: account ${account} reason ${reason} revision ${before}->${raw.revision}`);
  return raw;
}

export async function accountCount(): Promise<number> {
  const rows = await query('SELECT COUNT(*)::int AS count FROM accounts', []);
  const count = rows[0]?.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return corrupt();
  return count;
}

/** The trusted checkpoint for an auth decision. With a valid seal and a chain column whose tip is the sealed head: one small SELECT,
 *  one hash, no signature check. Otherwise the row is healed through the full read (the only heal path). */
export async function readTrustedCheckpoint(accountId: string): Promise<LedgerCheckpoint | null> {
  requireCheckpointKey();
  // The chain column's length and last payload (the genesis payload when there are no transitions) tie it to the sealed state.
  const rows = await query(`SELECT account_id, revision, head, sticky, version, checkpoint, checkpoint_mac,
    CASE WHEN jsonb_typeof(ledger->'transitions')='array' THEN jsonb_array_length(ledger->'transitions') END AS transition_count,
    COALESCE(ledger->'transitions'->-1->'payload', ledger->'genesis'->'payload') AS last_payload
    FROM account_ledger WHERE account_id=$1`, [accountId]);
  if (!rows.length) return null;
  if (rows.length !== 1) return corrupt();
  const row = rows[0];
  if (row.account_id !== accountId || !safeInteger(row.version)) return corrupt();
  let sticky: Sticky;
  try { sticky = parseSticky(row.sticky); } catch { return corrupt(); }
  const chainMatches = row.transition_count === row.revision && await tipHead(row.last_payload) === row.head;
  const seal = chainMatches ? unseal(row, sticky) : null;
  if (!seal || !('raw' in seal)) return (await readRow({ accountId }))?.stored.trusted ?? null;
  try { return trustedOf(seal.raw, sticky); } catch { return corrupt(); }
}

/** The stored chain, served as-is after the key consistency checks (healing the checkpoint first if needed). */
export async function readLedger(key: LedgerKey): Promise<StoredLedger | null> {
  return (await readRow(key))?.stored ?? null;
}

/** raw: the authenticated (or just healed) raw checkpoint of exactly this row's head and revision. */
type Row = { stored: StoredLedger; version: number; raw: LedgerCheckpoint };

async function readRow(key: LedgerKey): Promise<Row | null> {
  requireCheckpointKey();
  const byHandle = 'handle' in key;
  for (let attempt = 0; attempt < HEAL_ATTEMPTS; attempt += 1) {
    const rows = await query(`SELECT l.account_id, a.handle, l.revision, l.head, l.ledger, l.sticky, l.version, l.checkpoint, l.checkpoint_mac FROM account_ledger l
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
    if (ledger.genesis.payload.handle !== row.handle || !safeInteger(row.version)
      || (byHandle ? row.handle !== key.handle : row.account_id !== key.accountId)) return corrupt();
    // Two hashes, no signature: the chain belongs to this account, and its tip is (or is not) the row's head and revision.
    const last = ledger.transitions[ledger.transitions.length - 1];
    let tip: string;
    try {
      if (await accountIdOf(ledger.genesis.payload) !== row.account_id) return corrupt();
      tip = last ? await ledgerHead(last.payload) : row.account_id;
    } catch { return corrupt(); }
    const seal: Seal = ledger.transitions.length === row.revision && tip === row.head ? unseal(row, sticky) : { reason: 'chain_mismatch' };
    const raw = 'raw' in seal ? seal.raw : await heal(row, ledger, sticky, seal.reason);
    if (!raw) continue;
    let trusted: LedgerCheckpoint;
    try { trusted = trustedOf(raw, sticky); } catch { return corrupt(); }
    return { stored: { ledger, trusted, sticky }, version: row.version, raw };
  }
  throw new Error('account_ledger_conflict');
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
  // One statement: the account row, its chain, sticky set and sealed checkpoint appear together. account_id is the only arbiter, so a
  // handle held by another account raises a unique violation instead of being silently skipped.
  const seal = sealed(accountId, checkpoint, sticky);
  let rows: Record<string, unknown>[];
  try {
    rows = await query(`WITH a AS (INSERT INTO accounts(account_id,handle) VALUES ($1,$2) ON CONFLICT (account_id) DO NOTHING RETURNING account_id)
      INSERT INTO account_ledger(account_id,revision,head,ledger,sticky,checkpoint,checkpoint_mac) SELECT account_id,$3,$4,$5::jsonb,$6::jsonb,$7,$8 FROM a RETURNING account_id`,
    [accountId, candidate.genesis.payload.handle, checkpoint.revision, checkpoint.head, JSON.stringify(candidate), JSON.stringify(sticky), seal.text, seal.mac]);
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

/** Replica rule for an existing account: the shared chooseLedger against the stored chain. Only an adopt writes (and spends). */
async function replicate(candidate: Ledger, accountId: string, row: Row, admitAccountWrite: Gate): Promise<Attempt> {
  const { stored, version, raw } = row;
  const answer = (result: OfferResult): Attempt => ({ done: true, result });
  // The authenticated RAW checkpoint of exactly this head/revision vouches for the stored chain: it is never re-verified here. Only the
  // candidate's records after the shared prefix are (the new ones when ahead, those after the fork point when diverged).
  const choice = await chooseLedger(stored.ledger, candidate, Date.now(), { head: raw.head, checkpoint: raw });
  // Invalid (a bad record after the shared prefix, or malformed): refused with the stored chain; nothing written or spent.
  if (choice.decision === 'reject') return answer({ decision: 'reject', stored, discarded: 0 });
  if (choice.decision === 'keep') {
    // A VALID other history without an applicable resolve_fork: never adopted, whatever its length or content, and nothing from it is
    // recorded (not its revocations either). The client shows the owner both histories.
    if (choice.relation === 'diverged') return answer({ decision: 'reject', stored, discarded: 0, reason: 'diverged' });
    // same / behind: the stored chain already holds every record of the candidate.
    return answer({ decision: 'keep', stored, discarded: 0 });
  }
  // adopt: the candidate strictly extends the stored chain ('ahead'), or it is a valid other history ('diverged') carrying an
  // applicable owner-signed resolve_fork (and already every removal and passkey of the discarded branch), the only case in which the
  // stored chain is replaced by a chain that does not extend it. Any revocation chooseLedger still reports as discarded joins the sticky set.
  // What is written, answered and published is choice.ledger, never the offered candidate: the stored prefix byte-for-byte plus the
  // candidate's verified suffix (the candidate's copy of the prefix, possibly with re-encoded signature bytes, was never verified).
  const next = choice.ledger;
  const divergent = choice.relation === 'diverged';
  let sticky = unionSticky(stored.sticky, ledgerRevocations(next));
  if (divergent) sticky = unionSticky(sticky, { deviceIds: choice.discarded.deviceIds, bridgeIds: choice.discarded.bridgeIds });
  // Built BEFORE writing: an over-limit sticky set is rejected here and can never be persisted.
  let built: StoredLedger;
  try { built = build(next, choice.checkpoint, sticky); } catch { return answer({ decision: 'reject', stored, discarded: 0 }); }
  // Only an adopted (verified, passkey-signed) candidate spends the account's write budget: a third party replaying public, older,
  // diverged or junk chains cannot exhaust it and block the owner's revocations.
  if (!await admitAccountWrite()) return answer({ decision: 'reject', stored, discarded: 0, reason: 'rate_limited' });
  const seal = sealed(accountId, choice.checkpoint, sticky);
  // Guarded by the row as read: a concurrent write (any column, sticky included, bumps version) makes this match nothing.
  const rows = await query(`UPDATE account_ledger SET revision=$2,head=$3,ledger=$4::jsonb,sticky=$5::jsonb,checkpoint=$9,checkpoint_mac=$10,version=version+1,updated_at=NOW()
    WHERE account_id=$1 AND version=$6 AND revision=$7 AND head=$8 RETURNING account_id`,
  [accountId, choice.checkpoint.revision, choice.checkpoint.head, JSON.stringify(next), JSON.stringify(sticky), version,
    raw.revision, raw.head, seal.text, seal.mac]);
  if (rows.length !== 1) return { done: false };
  // discarded.records are the stored records after the fork point, so the fork is at the stored revision minus their count.
  const discarded = choice.discarded.records.length;
  if (divergent) console.warn(`[ledger] account ${accountId.slice(0, 8)} adopted an owner-chosen history: fork at revision ${raw.revision - discarded}, discarded ${discarded} records`);
  return answer({ decision: 'adopt', stored: built, discarded });
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
 *  Existing account (its checkpoint healed first if it cannot be trusted), no creation limit, the append-only rule of chooseLedger:
 *  - same or behind: keep, nothing written or spent;
 *  - ahead and valid: adopt choice.ledger (stored prefix + verified new records); the sticky set gains its revocations;
 *  - diverged and valid with an applicable owner-signed resolve_fork that carries the discarded branch's removals and passkeys: adopt
 *    choice.ledger (the one replacement of the stored chain); the sticky set also gains any revocation reported discarded; logged once;
 *  - diverged and valid otherwise: reject, reason diverged, nothing written, spent or recorded (sticky included);
 *  - invalid: reject (no reason), nothing written or spent.
 *  Every refusal returns the stored chain. An adopt first passes limits.admitAccountWrite (else reject, reason rate_limited, nothing
 *  written). Optimistic concurrency on (version, revision, head): a lost race is re-read and chooseLedger re-run once against the new
 *  row (a different extension of the same head is then diverged by one record), then throws.
 *  options.expectHead (a client re-offering its chain): never creates (no row: reject, reason account_unknown, no creation budget),
 *  and a row whose head is not expectHead is reject, reason head_changed, before chooseLedger and any budget. The comparison is made
 *  on the row read in the same round as the write, whose UPDATE is guarded by that row's (version, revision, head): if the head moves
 *  in between, the write matches nothing, the round is re-run, and the re-read row then answers head_changed. */
export async function offerLedger(candidate: unknown, limits: OfferLimits, options: OfferOptions = {}): Promise<OfferResult> {
  if (typeof limits?.admitCreation !== 'function' || typeof limits.admitAccountWrite !== 'function') throw new TypeError('offerLedger: limits are required');
  const expectHead = options.expectHead;
  if (expectHead !== undefined && typeof expectHead !== 'string') throw new TypeError('offerLedger: expectHead must be a string');
  // Before any work: a creation or write could not be sealed anyway, and must not spend a budget first.
  requireCheckpointKey();
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
    if (expectHead !== undefined) {
      if (!row) return { decision: 'reject', stored: null, discarded: 0, reason: 'account_unknown' };
      // row.raw is the checkpoint of exactly the row's head; replicate's UPDATE is guarded by this same (version, revision, head).
      if (row.raw.head !== expectHead) return { decision: 'reject', stored: row.stored, discarded: 0, reason: 'head_changed' };
    }
    const result = row ? await replicate(parsed, accountId, row, admitAccountWrite) : await create(parsed, accountId, admitCreation);
    if (result.done) return result.result;
  }
  throw new Error('account_ledger_conflict');
}
