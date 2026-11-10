/*
 * Bridge re-offer (CONTRACT §5, pacing as in "Browsers re-offer their chain"): when a server read shows the server holding a strict prefix
 * of this bridge's chain ('behind', e.g. after a database rollback), the bridge sends its own chain back with expectHead = the server head it
 * just read, so an account with no browser open is repaired too.
 * - Never blind. Every attempt starts with a fresh read of the server's chain and POSTs only when that read says 'behind'. Relay input never
 *   reaches here: it only causes the paced reads of ledger-relay.ts, whose results may call noteServerBehind().
 * - Never creates. expectHead turns an unknown account into a 404; after a 404 (to the read or the POST) this process never posts again.
 * - Pacing: one attempt at a time; the same (our head, server head) pair at most once per 30 s, checked after the fresh read. A failed
 *   attempt (any non-2xx, a network error, a failed read) waits 30 s doubling to 10 min, each wait times 0.8..1.2 (jitter), and a later
 *   Retry-After (at most 1 h) wins; then it retries on its own (fresh read first). Success or a server that is no longer behind resets it.
 * - Answers: 2xx -> done (the answered chain is offered to the replica); 404 account_unknown -> stop; 409 head_changed -> offer the server's
 *   chain and, if the server is still behind, send once more in the same attempt; 409 diverged -> offer it (the replica records the
 *   divergence); 409 ledger_rejected -> logged once per local head; 429 -> Retry-After.
 * Nothing here decides trust: every chain the server answers with goes through the replica's append-only rule.
 */
import type { LedgerOfferOutcome, ServerLedgerRead } from './security/bridge/security.js';

export const REOFFER_PAIR_WINDOW_MS = 30_000;
export const REOFFER_FIRST_BACKOFF_MS = 30_000;
export const REOFFER_MAX_BACKOFF_MS = 600_000;
export const REOFFER_MAX_RETRY_AFTER_MS = 3_600_000;
/** Each backoff wait is multiplied by 1 - REOFFER_JITTER + 2 * REOFFER_JITTER * random(). */
export const REOFFER_JITTER = 0.2;

/** The server's answer to POST /api/account/ledger { ledger, expectHead }. */
export interface LedgerPostAnswer {
  status: number;
  /** The parsed JSON body, or null when it is absent, oversized or not JSON. */
  body: unknown;
  /** Retry-After in ms (seconds or an HTTP date), or null. */
  retryAfterMs: number | null;
}

export interface LedgerReofferDeps {
  /** A fresh read of the server's chain, offered to the replica as 'server' (BridgeSecurityService.readServerLedger). */
  read(): Promise<ServerLedgerRead>;
  /** The stored chain and its head; null when there is nothing this bridge may send (no chain, or this bridge is not active in it). */
  local(): Promise<{ ledger: unknown; head: string } | null>;
  /** POST /api/account/ledger { ledger, expectHead }. Throws on a network failure. */
  post(ledger: unknown, expectHead: string): Promise<LedgerPostAnswer>;
  /** Offers a chain the server answered with to the replica as 'server'. */
  offer(ledger: unknown): Promise<LedgerOfferOutcome>;
  /** Monotonic clock (ms). */
  now(): number;
  /** [0, 1), for the jitter. */
  random(): number;
  /** Timer; returns a cancel function. */
  schedule(run: () => void, ms: number): () => void;
  log(line: string): void;
}

/** posted: the server took our chain. not_behind: nothing to send. skipped: the pair was sent less than 30 s ago. failed: backing off.
 *  deferred: an earlier failure's wait has not passed (a retry is scheduled). stopped: shut down, or the server does not know the account. */
export type ReofferOutcome = 'posted' | 'not_behind' | 'skipped' | 'failed' | 'deferred' | 'stopped';

export interface LedgerReoffer {
  /** A server read showed the server holding a strict prefix of our chain: start one paced attempt (it reads again before it posts). */
  noteServerBehind(): void;
  /** Runs an attempt now unless one is running (joined) or a backoff wait is pending ('deferred'); for a relay token refused with a plain
   *  401, which may mean the server lacks our records. It posts only when its own fresh read says 'behind'. */
  check(): Promise<ReofferOutcome>;
  /** Cancels the retry timer; nothing runs afterwards. */
  stop(): void;
}

/** The backoff wait after `failures` failed attempts in a row (>= 1), for a given random() draw. */
export function reofferBackoffMs(failures: number, random: number): number {
  const base = Math.min(REOFFER_FIRST_BACKOFF_MS * 2 ** Math.max(0, failures - 1), REOFFER_MAX_BACKOFF_MS);
  return Math.round(base * (1 - REOFFER_JITTER + 2 * REOFFER_JITTER * random));
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const field = (body: unknown, key: string): unknown =>
  typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)[key] : undefined;

export function createLedgerReoffer(deps: LedgerReofferDeps): LedgerReoffer {
  let running: Promise<ReofferOutcome> | null = null;
  let failures = 0;
  /** Monotonic time before which no attempt starts (after a failure). */
  let readyAt = Number.NEGATIVE_INFINITY;
  let cancelTimer: (() => void) | null = null;
  let stopped = false;
  /** The server does not know this account: never post again in this process. */
  let gone = false;
  /** (our head, server head) -> when it was last posted. */
  const sent = new Map<string, number>();
  /** Local heads whose ledger_rejected answer was logged. */
  const rejectedLogged = new Set<string>();

  const cancel = (): void => { cancelTimer?.(); cancelTimer = null; };
  /** (Re)arms the one retry timer: an attempt `ms` from now, unless one is running then. */
  const arm = (ms: number): void => {
    cancel();
    if (stopped || gone) return;
    cancelTimer = deps.schedule(() => { cancelTimer = null; if (running === null) void start(); }, Math.max(0, ms));
  };
  const settled = (outcome: ReofferOutcome): ReofferOutcome => {
    failures = 0;
    readyAt = Number.NEGATIVE_INFINITY;
    cancel();
    return outcome;
  };
  const failed = (reason: string, retryAfterMs: number | null = null, quiet = false): ReofferOutcome => {
    failures += 1;
    let wait = reofferBackoffMs(failures, deps.random());
    if (retryAfterMs !== null && retryAfterMs > wait) wait = Math.min(retryAfterMs, REOFFER_MAX_RETRY_AFTER_MS);
    readyAt = deps.now() + wait;
    // The first failure at each larger step is logged; once the wait stops growing, the bridge stays quiet.
    const grew = failures === 1 || reofferBackoffMs(failures, 0.5) > reofferBackoffMs(failures - 1, 0.5);
    if (!quiet && grew) deps.log(`[ledger] could not send our account history to the server (${reason}); retrying in ${Math.round(wait / 1000)} s`);
    arm(wait);
    return 'failed';
  };
  const unknownAccount = (): ReofferOutcome => {
    if (!gone) deps.log('[ledger] the server does not know this account (404); this computer will not send its account history to it');
    gone = true;
    cancel();
    return 'stopped';
  };
  const offerQuietly = async (ledger: unknown): Promise<LedgerOfferOutcome | null> => {
    try { return await deps.offer(ledger); } catch { return null; }
  };

  const send = async (serverHead: string, mayRepeat: boolean): Promise<ReofferOutcome> => {
    const local = await deps.local();
    if (local === null) return settled('not_behind');
    const now = deps.now();
    for (const [key, at] of sent) if (now < at || now - at >= REOFFER_PAIR_WINDOW_MS) sent.delete(key);
    const pair = `${local.head}\n${serverHead}`;
    const sentAt = sent.get(pair);
    if (sentAt !== undefined) {
      // A retry after a failure can come back before the pair window closes (the first wait may be 24 s): try again when it does.
      if (failures > 0) arm(sentAt + REOFFER_PAIR_WINDOW_MS - now);
      return 'skipped';
    }
    sent.set(pair, now);
    let answer: LedgerPostAnswer;
    try { answer = await deps.post(local.ledger, serverHead); }
    catch (error) { return failed(messageOf(error)); }
    if (stopped) return 'stopped';
    const { status, body } = answer;
    const error = field(body, 'error');
    const chain = field(body, 'ledger');
    const answered = typeof chain === 'object' && chain !== null;
    if (status >= 200 && status < 300) {
      if (answered) await offerQuietly(chain);
      return settled('posted');
    }
    if (status === 404) return unknownAccount();
    if (status === 409 && error === 'head_changed') {
      // Another write landed since our read: judge the server's chain, and if it is still a prefix of ours send once more.
      const outcome = answered ? await offerQuietly(chain) : null;
      if (outcome === null || outcome.decision === 'reject') return failed('head_changed');
      if (outcome.relation !== 'behind' || outcome.head === null) return settled('not_behind');
      return mayRepeat ? send(outcome.head, false) : failed('head_changed');
    }
    if (status === 409 && error === 'diverged') {
      if (answered) await offerQuietly(chain);
      return failed('the server holds a different history');
    }
    if (status === 409 && error === 'ledger_rejected') {
      const first = !rejectedLogged.has(local.head);
      rejectedLogged.add(local.head);
      if (first) deps.log('[ledger] the server rejected our account history; retrying later');
      return failed('ledger_rejected', null, true);
    }
    if (status === 429) return failed('rate limited', answer.retryAfterMs);
    return failed(`HTTP ${status}`);
  };

  const attempt = async (): Promise<ReofferOutcome> => {
    if (stopped || gone) return 'stopped';
    const read = await deps.read();
    if (stopped) return 'stopped';
    if (read.kind === 'unknown_account') return unknownAccount();
    if (read.kind === 'failed') return failed(`read failed: ${read.reason}`);
    const { relation, head } = read.outcome;
    if (relation !== 'behind' || head === null) return settled('not_behind');
    return send(head, true);
  };

  const start = (): Promise<ReofferOutcome> => {
    const run = attempt().catch((error: unknown) => failed(messageOf(error)));
    running = run.finally(() => { running = null; });
    return running;
  };

  return {
    noteServerBehind() {
      if (stopped || gone || running !== null || cancelTimer !== null) return;
      const wait = readyAt - deps.now();
      if (wait > 0) arm(wait);
      else void start();
    },
    check() {
      if (stopped || gone) return Promise.resolve<ReofferOutcome>('stopped');
      if (running !== null) return running;
      if (readyAt - deps.now() > 0) {
        if (cancelTimer === null) arm(readyAt - deps.now());
        return Promise.resolve<ReofferOutcome>('deferred');
      }
      cancel();
      return start();
    },
    stop() {
      stopped = true;
      cancel();
    },
  };
}
