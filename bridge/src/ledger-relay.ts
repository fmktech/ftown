/*
 * Account-mode wiring between the bridge's ledger replica (via BridgeSecurityService), the ftown server and the relay:
 * - the server's public ledger endpoints, bounded (createLedgerServer);
 * - the relay token by proof (createRelayTokenFetcher) behind the cooldown/caching provider, with the ledger hooks (createAccountRelay);
 * - the relay's ledger messages and (re)subscriptions, spaced so a relay publisher cannot force back-to-back reads and verifies;
 * - the re-offer of this bridge's chain when a server read shows the server behind it (ledger-reoffer.ts): relay input only ever leads to
 *   a paced read, never to a POST, and a refused relay token (plain 401) only to a read that may then re-offer;
 * - signed head announcements (security/ledger/announce.ts, CONTRACT §10/§13): this bridge announces its head after the ledger channel
 *   subscribes and after every adopt (at most one per HEAD_ANNOUNCE_SPACING_MS, latest head, best effort); a received one is verified against
 *   the trusted checkpoint and, when its head is unknown here, only queues the same paced server read as a ledger notice;
 * - the last relay URL the server named (security/relay-url.json), for an offline start.
 * Nothing here decides trust: every ledger goes to security.offerLedgerResult / refreshLedger / readServerLedger, which verify it.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnauthorizedError } from 'centrifuge';
import type { LedgerMessage } from './centrifugo-client.js';
import type { LedgerHeadRelation } from './security/ledger/ledger.js';
import { signHeadAnnouncement, type HeadAnnouncement } from './security/ledger/announce.js';
import type { LedgerOfferOutcome, ServerLedgerRead } from './security/bridge/security.js';
import type { EndpointPublic } from './security/protocol.js';
import { createLedgerReoffer, type LedgerPostAnswer } from './ledger-reoffer.js';
import { createRelayTokenFetcher } from './relay-token.js';
import { createTokenProvider, type TokenProvider } from './token-provider.js';

export const LEDGER_REQUEST_TIMEOUT_MS = 15_000;
/** A ledger is at most 2 MiB (LEDGER_LIMITS.maxBytes); its JSON envelope stays well under this. */
const MAX_LEDGER_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_RELAY_URL_LENGTH = 2048;
/** Relay-triggered ledger work (offers and refreshes) runs at least this far apart... */
export const RELAY_LEDGER_MIN_SPACING_MS = 1_000;
/** ...doubling up to this while it keeps changing nothing; an adopted ledger resets it. */
export const RELAY_LEDGER_MAX_SPACING_MS = 60_000;
/** Refreshes pulled by requests from endpoints the replica does not list run at most this often (single-flight, trailing). */
export const UNKNOWN_ENDPOINT_REFRESH_SPACING_MS = 2_000;
/** This bridge announces its head at most this often; a pending announcement is replaced by the latest head, never queued. */
export const HEAD_ANNOUNCE_SPACING_MS = 5_000;
/** A failed announcement (best effort) is logged at most this often. */
export const HEAD_ANNOUNCE_WARN_SPACING_MS = 60_000;

export interface LedgerServer {
  /** GET /api/account/ledger?accountId=… (public read): the `ledger` field, unverified. Throws on any failure (HttpStatusError for a
   *  non-200 answer). */
  fetchLedger(accountId: string): Promise<unknown>;
  /** POST /api/account/ledger { ledger, expectHead } (a re-offer: the server never creates an account for it, and answers 409
   *  head_changed when its head is no longer expectHead). The status, the bounded JSON body and Retry-After. Throws on a network failure. */
  postLedger(ledger: unknown, expectHead: string): Promise<LedgerPostAnswer>;
}

/** Retry-After as ms from `now`: delta-seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  // An HTTP date starts with the day name ("Sun, 06 Nov 1994 08:49:37 GMT"); anything else is not a date here.
  if (!/^[A-Za-z]{3}/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** An HTTP answer that is not a success, with its status. */
export class HttpStatusError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const apiBase = (apiUrl: string): string => apiUrl.replace(/\/+$/, '');

/** The HTTP status an error reports: its `status`, else a `(NNN)` in its message (relay-token errors), else null. */
export function httpStatusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') return error.status;
  const match = /\((\d{3})\)/.exec(messageOf(error));
  return match ? Number(match[1]) : null;
}

/** A refusal (401/403, or an UnauthorizedError) rather than a temporary failure. */
export function isRefusal(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true;
  const status = httpStatusOf(error);
  return status === 401 || status === 403;
}

function timeoutError(error: unknown, timeoutMs: number): unknown {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    ? new Error(`Ledger request timed out after ${timeoutMs}ms`) : error;
}

export function createLedgerServer(input: { apiUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number }): LedgerServer {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? LEDGER_REQUEST_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? MAX_LEDGER_RESPONSE_BYTES;
  const base = apiBase(input.apiUrl);
  return {
    async fetchLedger(accountId) {
      let text: string;
      let status: number;
      try {
        const response = await fetchImpl(`${base}/api/account/ledger?accountId=${encodeURIComponent(accountId)}`, {
          method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        if (Number(response.headers.get('content-length')) > maxBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error('ledger_response_too_large');
        }
        text = await response.text();
      } catch (error) { throw timeoutError(error, timeoutMs); }
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('ledger_response_too_large');
      if (status !== 200) throw new HttpStatusError(`Ledger read failed (${status})`, status);
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new Error('Ledger response malformed'); }
      const ledger = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { ledger?: unknown }).ledger : undefined;
      if (typeof ledger !== 'object' || ledger === null) throw new Error('Ledger response malformed');
      return ledger;
    },
    async postLedger(ledger, expectHead) {
      let status: number;
      let retryAfterMs: number | null;
      let text: string | null = null;
      try {
        const response = await fetchImpl(`${base}/api/account/ledger`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', accept: 'application/json' }, cache: 'no-store',
          body: JSON.stringify({ ledger, expectHead }), signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        if (Number(response.headers.get('content-length')) > maxBytes) await response.body?.cancel().catch(() => undefined);
        else text = await response.text();
      } catch (error) { throw timeoutError(error, timeoutMs); }
      let body: unknown = null;
      if (text !== null && Buffer.byteLength(text, 'utf8') <= maxBytes) {
        try { body = JSON.parse(text); } catch { body = null; }
      }
      return { status, body, retryAfterMs };
    },
  };
}

/**
 * Publishes ONLY this bridge's own ledger endpoint in the account's endpoint directory (PUT /api/security/endpoints), authenticated
 * with its relay token. Throws HttpStatusError when the server does not accept it.
 */
export async function registerBridgeEndpoint(input: {
  apiUrl: string; token: string; endpoint: EndpointPublic; bridgeId: string; label: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? LEDGER_REQUEST_TIMEOUT_MS;
  let status: number;
  try {
    const response = await fetchImpl(`${apiBase(input.apiUrl)}/api/security/endpoints`, {
      method: 'PUT', headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: input.endpoint, bridgeId: input.bridgeId, label: input.label, protocolVersion: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    status = response.status;
  } catch (error) { throw timeoutError(error, timeoutMs); }
  if (status < 200 || status >= 300) throw new HttpStatusError(`Endpoint directory registration failed (${status})`, status);
}

/** The line printed when the startup relay token is refused (exit 1). */
export function relayTokenFailureMessage(error: unknown, apiUrl: string): string {
  if (error instanceof UnauthorizedError) {
    return "[Bridge] The ftown server did not accept this computer's key. If it was removed from your account, run `ftown start --new-identity` to pair it again.";
  }
  if (isRefusal(error)) return `[Bridge] The ftown server at ${apiBase(apiUrl)} refused this computer (${messageOf(error)}).`;
  return `[Bridge] Could not get a relay token from ${apiBase(apiUrl)} (${messageOf(error)}). Check the connection and run \`ftown start\` again.`;
}

export const MISSING_RELAY_URL_MESSAGE = '[Bridge] The ftown server did not name its relay (centrifugoUrl) in the relay-token response. '
  + 'Update the server, or set FTOWN_CENTRIFUGO_URL to its wss:// URL.';

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

/**
 * A Centrifugo URL the bridge may connect to, or null: wss://, or ws:// only to a loopback host or when the API itself is plain
 * http (the operator already chose an insecure transport). The token rides this connection.
 */
export function parseRelayUrl(value: unknown, apiUrl: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RELAY_URL_LENGTH) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'wss:') return url.href;
  if (url.protocol !== 'ws:') return null;
  let insecureApi = false;
  try { insecureApi = new URL(apiUrl).protocol === 'http:'; } catch { /* treated as secure */ }
  return insecureApi || isLoopbackHost(url.hostname) ? url.href : null;
}

const relayUrlFile = (dataDir: string): string => join(dataDir, 'security', 'relay-url.json');

/** The last relay URL the server named (`security/relay-url.json`), if it is still acceptable for this API; else null. */
export function readSavedRelayUrl(dataDir: string, apiUrl: string): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(relayUrlFile(dataDir), 'utf8'));
    if (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== 1) return null;
    return parseRelayUrl((value as { url?: unknown }).url, apiUrl);
  } catch { return null; }
}

/** Atomically saves the relay URL (mode 0600). The identity reset deletes it. */
export function saveRelayUrl(dataDir: string, url: string): void {
  const file = relayUrlFile(dataDir);
  const temporary = `${file}.${randomUUID()}.tmp`;
  mkdirSync(join(dataDir, 'security'), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, url }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The parts of BridgeSecurityService this wiring drives. */
export interface AccountRelaySecurity {
  offerLedgerResult(candidate: unknown, source: 'server' | 'relay'): Promise<LedgerOfferOutcome>;
  /** One uncoalesced GET of the server ledger, offered as 'server' (the re-offer's fresh read). */
  readServerLedger(): Promise<ServerLedgerRead>;
  /** A relay-token answer without a chain: what the server's head says about it. */
  noteServerHead(server: { head: string | null; revision: number | null }): LedgerHeadRelation | null;
  noteServerContact(now?: number): void;
  /** Coalesced GET of the server ledger, offered as 'server'. */
  refreshLedger(): Promise<void>;
  ledgerStatus(): { head: string | null; revision: number | null; own: string; serverBehind: boolean };
  /** A parsed head announcement (owner publication): its relation to the stored chain when it verifies against the trusted checkpoint,
   *  else null (own, invalid, unknown or revoked member, stale). At most one signature check. */
  judgeHeadAnnouncement(announcement: HeadAnnouncement): Promise<LedgerHeadRelation | null>;
  /** Fires after the stored head or this bridge's own status changes (every adopt). Returns the unsubscribe. */
  onLedgerHead(listener: () => void): () => void;
}

export interface AccountRelayDeps {
  apiUrl: string;
  accountId: string;
  bridgeId: string;
  authPrivateKey: CryptoKey;
  security: AccountRelaySecurity;
  /** The local replica: its chain is re-offered (with expectHead) when a server read shows the server behind it. */
  store: { read(): Promise<{ ledger: unknown; checkpoint: { head: string } } | null> };
  server: LedgerServer;
  hostname: () => string;
  localPort: () => number | undefined;
  /** FTOWN_CENTRIFUGO_URL: wins over the URL the server names in its relay-token response. */
  relayUrlOverride?: string;
  /** The URL saved by an earlier run (readSavedRelayUrl), used until the server names one. */
  savedRelayUrl?: string | null;
  /** Called when the server names a relay URL that differs from the last known one (index saves it). */
  onRelayUrl?: (url: string) => void;
  /** Reconnects the relay after it was refused (centrifugo.connect()). */
  reconnect?: () => void;
  fetchImpl?: typeof fetch;
  /** Monotonic clock (token reuse, cooldown, relay spacing, re-offer and announcement pacing); injectable for tests. */
  now?: () => number;
  /** Wall clock (ms since the epoch) for the `at` of this bridge's head announcements; defaults to Date.now. */
  wallClock?: () => number;
  /** [0, 1): token cooldown and re-offer jitter. */
  random?: () => number;
  /** Timer for relay spacing; returns a cancel function. Defaults to an unref'd setTimeout. */
  schedule?: (run: () => void, ms: number) => () => void;
  log?: (line: string) => void;
}

export interface AccountRelay {
  /** Relay tokens by proof: single-flight, reused until a minute before expiry, cooldown on transient failures, 401 remembered. */
  tokens: TokenProvider;
  /** centrifuge-js getToken: like tokens.getToken, and a refusal marks the relay connection as terminally refused. */
  connectionToken(): Promise<string>;
  /** The override, else the URL from the last relay-token response that named a valid one, else the saved one, else null. */
  relayUrl(): string | null;
  /** CentrifugoClient onLedgerMessage. */
  onLedgerMessage(message: LedgerMessage): void;
  /** CentrifugoClient onLedgerSubscribed: every (re)subscribe may have missed records; it also announces this bridge's head. */
  onLedgerSubscribed(): void;
  /** How head announcements reach the ledger channel (CentrifugoClient.publishLedgerAnnouncement); until set, announcing is a no-op. */
  setLedgerPublisher(publish: ((announcement: HeadAnnouncement) => Promise<void>) | null): void;
  /**
   * A request from an endpoint the trusted replica does not list (approval_required, not a revoked one): a browser may have enrolled
   * moments ago. Pulls the server ledger outside the relay spacing, at most once per UNKNOWN_ENDPOINT_REFRESH_SPACING_MS, single-flight,
   * with one trailing refresh for requests that arrive meanwhile.
   */
  onUnknownEndpoint(): void;
  /** Cancels pending relay work (shutdown). */
  stop(): void;
}

/** The security service's signal for an account request refused with approval_required for an endpoint it does not know. */
export interface ApprovalRequiredSignal {
  onApprovalRequired?(listener: (endpointId: string) => void): () => void;
}

/** Subscribes `listener` when the security service offers onApprovalRequired; false when it does not (nothing subscribed). */
export function subscribeApprovalRequired(security: object, listener: (endpointId: string) => void): boolean {
  const signal = (security as ApprovalRequiredSignal).onApprovalRequired;
  if (typeof signal !== 'function') return false;
  signal.call(security, listener);
  return true;
}

type RelayWork = { kind: 'offer'; ledger: unknown } | { kind: 'refresh'; head: string | null };

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export function createAccountRelay(deps: AccountRelayDeps): AccountRelay {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const monotonic = deps.now ?? (() => performance.now());
  const schedule = deps.schedule ?? defaultSchedule;
  const baseFetch = deps.fetchImpl ?? fetch;
  const relayTokenUrl = `${apiBase(deps.apiUrl)}/api/auth/relay-token`;
  const override = deps.relayUrlOverride === undefined || deps.relayUrlOverride === '' ? null : parseRelayUrl(deps.relayUrlOverride, deps.apiUrl);
  if (deps.relayUrlOverride && override === null) log('[Bridge] Ignoring FTOWN_CENTRIFUGO_URL: it must be a wss:// URL (ws:// only for a local relay).');
  let learnedRelayUrl: string | null = null;
  const savedRelayUrl = deps.savedRelayUrl ?? null;
  const head = (): string | null => deps.security.ledgerStatus().head;
  /** The relay connection was refused (terminal for centrifuge-js) and has not been reconnected since. */
  let relayRefused = false;
  let stopped = false;

  // Our chain goes back to the server only after a fresh read shows the server holding a strict prefix of it, with that head as expectHead.
  const reoffer = createLedgerReoffer({
    read: () => deps.security.readServerLedger(),
    local: async () => {
      // Like a browser, a bridge that is not an active member of its own chain sends nothing.
      if (deps.security.ledgerStatus().own !== 'active') return null;
      const state = await deps.store.read();
      return state === null ? null : { ledger: state.ledger, head: state.checkpoint.head };
    },
    post: (ledger, expectHead) => deps.server.postLedger(ledger, expectHead),
    offer: ledger => deps.security.offerLedgerResult(ledger, 'server'),
    now: monotonic, random: deps.random ?? Math.random, schedule, log,
  });
  /** After any server read: the server is behind us, so re-offer (paced; it reads again first). */
  const afterServerRead = (): void => {
    if (!stopped && deps.security.ledgerStatus().serverBehind) reoffer.noteServerBehind();
  };

  const reconnectIfRefused = (): void => {
    if (!relayRefused || stopped) return;
    relayRefused = false;
    try { deps.reconnect?.(); } catch (error) { log(`[Bridge] Relay reconnect failed: ${messageOf(error)}`); }
  };

  // Reads `centrifugoUrl` from a successful relay-token response without consuming the body the fetcher reads.
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.ok && String(input) === relayTokenUrl) {
      try {
        const body: unknown = JSON.parse(await response.clone().text());
        const named = typeof body === 'object' && body !== null ? parseRelayUrl((body as { centrifugoUrl?: unknown }).centrifugoUrl, deps.apiUrl) : null;
        if (named !== null) {
          const previous = learnedRelayUrl ?? savedRelayUrl;
          learnedRelayUrl = named;
          if (named !== previous) {
            try { deps.onRelayUrl?.(named); } catch (error) { log(`[Bridge] Could not save the relay URL: ${messageOf(error)}`); }
          }
        }
      } catch { /* the fetcher reports a malformed response */ }
    }
    return response;
  };

  const fetcher = createRelayTokenFetcher({
    apiUrl: deps.apiUrl,
    accountId: () => deps.accountId,
    bridgeId: deps.bridgeId,
    authPrivateKey: deps.authPrivateKey,
    head,
    // A newer server ledger rides the token response. An invalid one is only logged: the token is still returned. One the server holds
    // as a strict prefix of ours (a rolled-back server) starts the re-offer.
    onLedger: async ledger => {
      try {
        const outcome = await deps.security.offerLedgerResult(ledger, 'server');
        if (outcome.decision === 'reject') log('[Bridge] Ignored an account ledger from the relay-token response.');
        if (outcome.relation === 'behind') reoffer.noteServerBehind();
      } catch (error) { log(`[Bridge] Account ledger from the relay-token response failed: ${messageOf(error)}`); }
    },
    // No chain in the answer: the server's head is the one we sent (or the one it names). Behind -> re-offer; unknown -> read it.
    onServerHead: server => {
      const relation = deps.security.noteServerHead(server);
      if (relation === 'behind') reoffer.noteServerBehind();
      else if (relation === 'unknown') submit({ kind: 'refresh', head: null });
    },
    // Evidence of a revoked key: the replica's append-only rule decides. Only a chain that is AHEAD of ours (or an owner-chosen history)
    // and revokes this bridge triggers the reset (security's onBridgeRevoked); a diverged one is refused and recorded, never evidence.
    onRevoked: async ledger => {
      try { await deps.security.offerLedgerResult(ledger, 'server'); }
      catch (error) { log(`[Bridge] Revocation evidence failed: ${messageOf(error)}`); }
    },
    // A plain 401: the server may lack our records (a rolled-back server missing our add_bridge). Nothing is posted blindly: the
    // re-offer reads the server first and posts our chain (expectHead, never creating an account) only if the server is behind it.
    // The token is retried once only when the server took our chain.
    onUnauthorized: async () => (await reoffer.check()) === 'posted',
    hostname: deps.hostname,
    localPort: deps.localPort,
    fetchImpl,
    timeoutMs: LEDGER_REQUEST_TIMEOUT_MS,
  });

  const tokens = createTokenProvider({
    fetchToken: async () => {
      const token = await fetcher();
      // Every relay-token answer is a server contact: it renews the offline grace of the account devices.
      deps.security.noteServerContact();
      // The key is accepted again (e.g. the server learned our add_bridge): a refused relay connection may come back.
      reconnectIfRefused();
      return token;
    },
    now: monotonic,
    random: deps.random,
    head,
  });

  // Relay-triggered ledger work: at most one at a time, at least RELAY_LEDGER_MIN_SPACING_MS apart, only the latest kept.
  let pending: RelayWork | null = null;
  let running = false;
  let cancelTimer: (() => void) | null = null;
  let readyAt = 0;
  let idleRuns = 0;
  let lastRunEndedAt = Number.NEGATIVE_INFINITY;

  const run = async (work: RelayWork): Promise<'adopt' | 'idle' | 'skipped'> => {
    const before = head();
    try {
      if (work.kind === 'offer') {
        const outcome = await deps.security.offerLedgerResult(work.ledger, 'relay');
        // A relayed chain that is a prefix of ours hints that the server may be behind: read the server (paced). A relay message is never
        // proof of the server's state, so it never leads to a POST by itself.
        if (outcome.relation === 'behind' && pending === null) pending = { kind: 'refresh', head: null };
        if (outcome.decision !== 'adopt') return 'idle';
      } else {
        if (work.head !== null && work.head === before) return 'skipped';
        await deps.security.refreshLedger();
        afterServerRead();
        if (head() === before) return 'idle';
      }
    } catch (error) {
      log(`[Bridge] Relay ledger update failed: ${messageOf(error)}`);
      return 'idle';
    }
    reconnectIfRefused();
    return 'adopt';
  };

  const pump = (): void => {
    if (stopped || running || cancelTimer !== null || pending === null) return;
    const wait = readyAt - monotonic();
    if (wait > 0) {
      cancelTimer = schedule(() => { cancelTimer = null; pump(); }, wait);
      return;
    }
    const work = pending;
    pending = null;
    running = true;
    void run(work).then(outcome => {
      if (outcome === 'skipped') return;
      lastRunEndedAt = monotonic();
      if (outcome === 'adopt') idleRuns = 0;
      const spacing = outcome === 'adopt' ? RELAY_LEDGER_MIN_SPACING_MS
        : Math.min(RELAY_LEDGER_MIN_SPACING_MS * 2 ** idleRuns++, RELAY_LEDGER_MAX_SPACING_MS);
      readyAt = monotonic() + spacing;
    }).finally(() => { running = false; pump(); });
  };

  const submit = (work: RelayWork): void => {
    if (stopped) return;
    // Leading edge: the first work after a quiet second runs at once with a fresh backoff; only a burst is spaced and backed off.
    if (!running && pending === null && cancelTimer === null && monotonic() - lastRunEndedAt >= RELAY_LEDGER_MIN_SPACING_MS) {
      idleRuns = 0;
      readyAt = 0;
    }
    pending = work;
    pump();
  };

  // Refreshes pulled by unknown endpoints: their own limit, independent of the relay spacing.
  let unknownInFlight = false;
  let unknownQueued = false;
  let unknownCancel: (() => void) | null = null;
  let unknownReadyAt = Number.NEGATIVE_INFINITY;
  const refreshForUnknown = (): void => {
    if (stopped) return;
    if (unknownInFlight) { unknownQueued = true; return; }
    if (unknownCancel !== null) return;
    const wait = unknownReadyAt - monotonic();
    if (wait > 0) {
      unknownCancel = schedule(() => { unknownCancel = null; refreshForUnknown(); }, wait);
      return;
    }
    unknownInFlight = true;
    unknownReadyAt = monotonic() + UNKNOWN_ENDPOINT_REFRESH_SPACING_MS;
    const before = head();
    deps.security.refreshLedger()
      .then(() => { afterServerRead(); if (head() !== before) reconnectIfRefused(); })
      .catch((error: unknown) => log(`[Bridge] Account ledger refresh failed: ${messageOf(error)}`))
      .finally(() => {
        unknownInFlight = false;
        if (unknownQueued) { unknownQueued = false; refreshForUnknown(); }
      });
  };

  // This bridge's head announcements: best effort, never awaited by a caller, at most one per HEAD_ANNOUNCE_SPACING_MS. A request while one
  // is pending only marks it wanted; the head is read when it is signed, so the latest head is the one announced.
  const wallClock = deps.wallClock ?? Date.now;
  let publisher: ((announcement: HeadAnnouncement) => Promise<void>) | null = null;
  let announceWanted = false;
  let announcing = false;
  let announceCancel: (() => void) | null = null;
  let lastAnnounceAt = Number.NEGATIVE_INFINITY;
  let lastAnnounceWarnAt = Number.NEGATIVE_INFINITY;

  const sendAnnouncement = async (): Promise<void> => {
    const publish = publisher;
    const status = deps.security.ledgerStatus();
    // Only an active member of its own chain speaks for it (not unpaired, absent or revoked).
    if (publish === null || status.own !== 'active' || status.head === null || status.revision === null) return;
    try {
      const announcement = await signHeadAnnouncement(deps.authPrivateKey, {
        accountId: deps.accountId, kind: 'bridge', keyId: deps.bridgeId, head: status.head, revision: status.revision, at: Math.floor(wallClock()),
      });
      if (!stopped) await publish(announcement);
    } catch (error) {
      const at = monotonic();
      if (at - lastAnnounceWarnAt >= HEAD_ANNOUNCE_WARN_SPACING_MS) {
        lastAnnounceWarnAt = at;
        log(`[Bridge] Could not announce the ledger head: ${messageOf(error)}`);
      }
    }
  };
  const pumpAnnounce = (): void => {
    if (stopped || !announceWanted || announcing || announceCancel !== null) return;
    const wait = lastAnnounceAt + HEAD_ANNOUNCE_SPACING_MS - monotonic();
    if (wait > 0) {
      announceCancel = schedule(() => { announceCancel = null; pumpAnnounce(); }, wait);
      return;
    }
    announceWanted = false;
    announcing = true;
    lastAnnounceAt = monotonic();
    void sendAnnouncement().finally(() => { announcing = false; pumpAnnounce(); });
  };
  const announce = (): void => {
    // Not wired to a relay client (yet): nothing to announce on, nothing scheduled.
    if (stopped || publisher === null) return;
    announceWanted = true;
    pumpAnnounce();
  };
  // Every adopt (and an own-status change, e.g. paired again) is announced.
  const stopHeadListener = deps.security.onLedgerHead(announce);

  // A received announcement: the owner filter and the strict shape ran in the client. Verified against the trusted checkpoint (one signature
  // check); an unknown head only queues the paced server read. An announcement is never proof: no POST, nothing fetched from its sender.
  const judge = async (announcement: HeadAnnouncement): Promise<void> => {
    if (stopped || (announcement.kind === 'bridge' && announcement.keyId === deps.bridgeId)) return;
    let relation: LedgerHeadRelation | null;
    try { relation = await deps.security.judgeHeadAnnouncement(announcement); } catch { return; }
    if (relation === 'unknown') submit({ kind: 'refresh', head: announcement.head });
  };

  // The startup read (security.startLedger) may already have shown the server behind.
  afterServerRead();

  return {
    tokens,
    async connectionToken() {
      try { return await tokens.getToken(); }
      catch (error) {
        if (error instanceof UnauthorizedError) relayRefused = true;
        throw error;
      }
    },
    relayUrl: () => override ?? learnedRelayUrl ?? savedRelayUrl,
    onLedgerMessage(message) {
      if (message.type === 'ledger') submit({ kind: 'offer', ledger: message.ledger });
      else if (message.type === 'head_announcement') void judge(message.announcement);
      else if (message.head !== head()) submit({ kind: 'refresh', head: message.head });
    },
    onLedgerSubscribed: () => {
      submit({ kind: 'refresh', head: null });
      announce();
    },
    setLedgerPublisher(publish) { publisher = publish; },
    onUnknownEndpoint: refreshForUnknown,
    stop() {
      stopped = true;
      reoffer.stop();
      pending = null;
      cancelTimer?.();
      cancelTimer = null;
      unknownCancel?.();
      unknownCancel = null;
      announceWanted = false;
      announceCancel?.();
      announceCancel = null;
      stopHeadListener();
    },
  };
}
