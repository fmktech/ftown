import { createHash, timingSafeEqual } from 'node:crypto';
import { getDb } from '@/lib/db';
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

const MEMO_SIZE = 4;
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

function bootstrapOk(given: string | undefined): boolean {
  const secret = process.env.FTOWN_BOOTSTRAP_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || typeof given !== 'string') return false;
  const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(given), hash(secret));
}

type Attempt = { done: true; decision: OfferDecision; stored: StoredLedger | null; discarded: number } | { done: false };

async function attempt(candidate: Ledger, accountId: string, bootstrap: string | undefined): Promise<Attempt> {
  const row = await readRow({ accountId });
  const stored = row?.stored ?? null;
  if (!stored) {
    // Cheap gates first: nothing is signature-verified unless registration is open, the bootstrap secret matches and no account exists.
    const open = isRegistrationEnabled() && bootstrapOk(bootstrap) && await accountCount() === 0;
    if (!open || !candidate.transitions.some(item => item.payload.operation.type === 'add_device')) return { done: true, decision: 'reject', stored: null, discarded: 0 };
    // The account is bound permanently to its genesis origins/rpId, so only this server's own are accepted.
    const genesisPayload = candidate.genesis.payload;
    try {
      if (genesisPayload.origins.length !== 1 || genesisPayload.origins[0] !== publicOrigin() || genesisPayload.rpId !== expectedRpId()) return { done: true, decision: 'reject', stored: null, discarded: 0 };
    } catch { return { done: true, decision: 'reject', stored: null, discarded: 0 }; }
    let checkpoint: LedgerCheckpoint;
    try { checkpoint = await verifyLedger(candidate); } catch { return { done: true, decision: 'reject', stored: null, discarded: 0 }; }
    const sticky = unionSticky(EMPTY, ledgerRevocations(candidate));
    let built: StoredLedger;
    try { built = build(candidate, checkpoint, sticky); } catch { return { done: true, decision: 'reject', stored: null, discarded: 0 }; }
    // One statement: the account row and its ledger appear together, and only while no account exists at all.
    let rows: Record<string, unknown>[];
    try {
      rows = await query(`WITH a AS (INSERT INTO accounts(account_id,handle) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM accounts)
        ON CONFLICT DO NOTHING RETURNING account_id)
      INSERT INTO account_ledger(account_id,revision,head,ledger,sticky) SELECT account_id,$3,$4,$5::jsonb,$6::jsonb FROM a RETURNING account_id`,
      [accountId, candidate.genesis.payload.handle, checkpoint.revision, checkpoint.head, JSON.stringify(candidate), JSON.stringify(sticky)]);
    } catch (error) {
      // accounts_singleton: a concurrent genesis already created the one account this server hosts.
      if ((error as { code?: unknown } | null)?.code === '23505') return { done: true, decision: 'reject', stored: null, discarded: 0 };
      throw error;
    }
    if (rows.length === 1) return { done: true, decision: 'created', stored: built, discarded: 0 };
    return { done: false };
  }
  const choice = await chooseLedger(stored.ledger, candidate, Date.now(), { head: stored.checkpoint.head, checkpoint: stored.checkpoint });
  if (choice.decision === 'reject') return { done: true, decision: 'reject', stored, discarded: 0 };
  const sticky = unionSticky(stored.sticky, ledgerRevocations(candidate));
  const adopt = choice.decision === 'adopt';
  if (!adopt && sameSticky(sticky, stored.sticky)) return { done: true, decision: 'keep', stored, discarded: 0 };
  const next = adopt ? { ledger: candidate, checkpoint: choice.checkpoint } : { ledger: stored.ledger, checkpoint: stored.checkpoint };
  // Built BEFORE writing: an over-limit sticky set is rejected here and can never be persisted.
  let built: StoredLedger;
  try { built = build(next.ledger, next.checkpoint, sticky); } catch { return { done: true, decision: 'reject', stored, discarded: 0 }; }
  // version makes the check cover sticky too: two concurrent keeps that add different ids cannot overwrite each other.
  const rows = await query(`UPDATE account_ledger SET revision=$2,head=$3,ledger=$4::jsonb,sticky=$5::jsonb,version=version+1,updated_at=NOW()
    WHERE account_id=$1 AND version=$6 AND revision=$7 AND head=$8 RETURNING account_id`,
  [accountId, next.checkpoint.revision, next.checkpoint.head, JSON.stringify(next.ledger), JSON.stringify(sticky), (row as { version: number }).version, stored.checkpoint.revision, stored.checkpoint.head]);
  if (rows.length !== 1) return { done: false };
  return { done: true, decision: adopt ? 'adopt' : 'keep', stored: built, discarded: adopt ? choice.discarded.length : 0 };
}

/** Replica rule. No account yet: only a chain whose genesis is new AND registration is open (isRegistrationEnabled() && accountCount()===0)
 *  creates it, and it must contain at least one add_device, and options.bootstrap must equal FTOWN_BOOTSTRAP_SECRET (>=32 chars; checked before any signature work). Existing account: chooseLedger (the longest chain wins); keep and adopt add the
 *  candidate's revocations to the sticky set, reject changes nothing. Optimistic concurrency on (revision, head); a lost race is re-read and
 *  re-run once, then throws. */
export async function offerLedger(candidate: unknown, options: { bootstrap?: string } = {}): Promise<{ decision: OfferDecision; stored: StoredLedger | null; discarded: number }> {
  let parsed: Ledger;
  let accountId: string;
  try {
    parsed = parseLedger(candidate);
    accountId = await accountIdOf(parsed.genesis.payload);
  } catch { return { decision: 'reject', stored: null, discarded: 0, }; }
  for (let round = 0; round < 2; round += 1) {
    const result = await attempt(parsed, accountId, options.bootstrap);
    if (result.done) return { decision: result.decision, stored: result.stored, discarded: result.discarded };
  }
  throw new Error('account_ledger_conflict');
}
