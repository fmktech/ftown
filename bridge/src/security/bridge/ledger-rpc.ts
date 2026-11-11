/*
 * The two read-only ledger RPCs a trusted browser sends over the encrypted command channel (CONTRACT §9, §11): `ledger_head` (this bridge's
 * account, head and revision) and `ledger_chain` (its stored chain, in pages that fit one encrypted relay frame). Pure: request parsing and
 * paging only. command-rpc.ts authorizes the caller (BridgeSecurityService.memberLedger) and answers.
 *
 * Wire (the usual command envelope; route { kind: 'command', command: <type>, requestId, sessionId: null }):
 *   ledger_head   payload { bridgeId }                                   -> data { accountId, head, revision }
 *   ledger_chain  payload { bridgeId, fromRevision?: 0, limit?: 1025 }   -> data { accountId, head, revision, fromRevision, records, more }
 * records[i] is the record at revision fromRevision + i (revision 0 is the signed genesis, revision n is transitions[n - 1]), each exactly as
 * stored ({ payload, signature }). A page holds at most `limit` records and, past its first record, at most LEDGER_CHAIN_PAGE_BYTES of
 * record JSON; `more` says records after the page exist. head/revision are the stored tip when the page was cut.
 */
import { LEDGER_LIMITS } from '../ledger/protocol.js';
import type { Ledger, LedgerGenesis, LedgerTransition, Signed } from '../ledger/protocol.js';

/** Record JSON per ledger_chain page (as the review and preview chunks): with the envelope it stays far below one relay frame. */
export const LEDGER_CHAIN_PAGE_BYTES = 98_304;
/** The largest `limit`, and its default: every record of the largest chain. */
export const LEDGER_CHAIN_MAX_LIMIT = LEDGER_LIMITS.maxTransitions + 1;

export interface LedgerHeadAnswer { accountId: string; head: string; revision: number }
export interface LedgerChainQuery { fromRevision: number; limit: number }
export interface LedgerChainPage extends LedgerHeadAnswer {
  fromRevision: number;
  records: Array<Signed<LedgerGenesis> | Signed<LedgerTransition>>;
  more: boolean;
}
/** The stored chain and its tip (BridgeSecurityService.memberLedger). */
export interface HeldLedger { ledger: Ledger; accountId: string; head: string; revision: number }

function isPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isCount(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** ledger_head: exactly { bridgeId } naming this bridge. */
export function parseLedgerHeadQuery(payload: unknown, bridgeId: string): boolean {
  return isPayload(payload) && Object.keys(payload).length === 1 && payload.bridgeId === bridgeId;
}

/** ledger_chain: { bridgeId, fromRevision?, limit? } naming this bridge, nothing else; null when malformed. */
export function parseLedgerChainQuery(payload: unknown, bridgeId: string): LedgerChainQuery | null {
  if (!isPayload(payload) || payload.bridgeId !== bridgeId) return null;
  if (Object.keys(payload).some(key => key !== 'bridgeId' && key !== 'fromRevision' && key !== 'limit')) return null;
  const fromRevision = payload.fromRevision === undefined ? 0 : payload.fromRevision;
  const limit = payload.limit === undefined ? LEDGER_CHAIN_MAX_LIMIT : payload.limit;
  if (!isCount(fromRevision, 0, LEDGER_LIMITS.maxTransitions) || !isCount(limit, 1, LEDGER_CHAIN_MAX_LIMIT)) return null;
  return { fromRevision, limit };
}

export function ledgerHeadAnswer(held: LedgerHeadAnswer): LedgerHeadAnswer {
  return { accountId: held.accountId, head: held.head, revision: held.revision };
}

/** The page of `held` that starts at query.fromRevision (empty, more false, past the tip). Never splits a record; always makes progress.
 *  `held` is only read; the page carries copies of its records. */
export function ledgerChainPage(held: HeldLedger, query: LedgerChainQuery, maxBytes: number = LEDGER_CHAIN_PAGE_BYTES): LedgerChainPage {
  const all: Array<Signed<LedgerGenesis> | Signed<LedgerTransition>> = [held.ledger.genesis, ...held.ledger.transitions];
  const records: Array<Signed<LedgerGenesis> | Signed<LedgerTransition>> = [];
  let bytes = 0;
  for (let revision = query.fromRevision; revision < all.length && records.length < query.limit; revision++) {
    const size = Buffer.byteLength(JSON.stringify(all[revision]), 'utf8');
    if (records.length > 0 && bytes + size > maxBytes) break;
    records.push(structuredClone(all[revision]));
    bytes += size;
  }
  return { ...ledgerHeadAnswer(held), fromRevision: query.fromRevision, records, more: query.fromRevision + records.length < all.length };
}
