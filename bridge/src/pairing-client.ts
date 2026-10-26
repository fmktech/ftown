/**
 * Device-pairing onboarding client (contract docs/plans/device-pairing-contract.md).
 *
 * OAuth-device-authorization-style flow: the bridge asks the server to start a
 * pairing request, prints a short user code + verification URL, and polls until
 * the logged-in user approves the named machine in the browser. On approval the
 * server returns the SAME token bundle shape as `/api/auth/bridge`.
 *
 * P8: no secret is ever logged. `deviceCode` (the poll credential) and every
 * returned token/refreshToken stay out of the `log` sink; only the low-value,
 * single-use `userCode` and the verification URL are printed.
 */
import { encodeAccountEnrollmentLink, parseAccountEnrollmentLink } from './security/account-crypto.js';
import type { AccountEnrollmentBundle, AccountEnrollmentLink, AccountHistory } from './security/account-protocol.js';
import { accountReadUrl } from './security/bridge/account-client.js';
import { readAccountHistory } from './security/bridge/account-client.js';
import { AccountTrustError } from './security/account-crypto.js';
import { createPendingConfirmation, createPendingHello, normalizePendingAccountHint, openPendingResult,
  parsePendingOffer, parsePendingState, pendingComparisonCode, pendingHelloHash, pendingOfferHash, PENDING_APPROVAL_LIMITS } from './security/pending-approval-crypto.js';
import type { PendingApprovalState, PendingBridgeDecision, PendingBridgePairingContext, PendingBridgeStatus,
  PendingHelloLocal, PendingOffer, PendingPairingApproved, PendingPairingVerified } from './security/pending-approval-protocol.js';
import { isDeepStrictEqual } from 'node:util';
import { matchesPendingBridgeDecision } from './security/bridge/pending-approval.js';

export interface RunPairingOptions {
  apiUrl: string;
  bridgeId: string;
  hostname: string;
  platform: string;
  /**
   * Loopback WS rung advert embedded so the owning user's clients discover the
   * loopback rung via presence (matches the auth/refresh path).
   */
  localPort: number;
  /**
   * Loopback WS rung advert embedded so the owning user's clients discover the
   * loopback rung via presence (matches the auth/refresh path).
   */
  localNonce: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Where user-facing lines go; defaults to console.log. NEVER receives secrets. */
  log?: (msg: string) => void;
  /** The secret remains local; only request is uploaded. */
  enrollment?: AccountEnrollmentLink;
  /** Persist public verification metadata in the private pending record. */
  onPairingCode?: (code: string) => Promise<void>;
  /** Human-facing TTY ONLY; must never be an operational logger. */
  displayEnrollmentUrl?: (url: string) => void;
  /** Explicit pending-v1 mode; never falls back to fragment or auth-only approval. */
  pending?: PendingBridgePairingContext;
  accountHint?: string;
}

export interface PairingResult {
  ownerId: string;
  token: string;
  refreshToken: string;
  centrifugoUrl: string;
  userId: string;
  accountApproval?: AccountEnrollmentBundle;
  accountHistory?: AccountHistory;
  approvalMethod?: 'pending-v1';
  verifiedAccountTrust?: PendingPairingVerified['verifiedAccountTrust'];
  lastServerReadAt?: number;
}

interface PairStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresInMs: number;
}

type PairPollStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'consumed'
  | 'unknown'
  | 'slow_down';

interface PairPollResponse {
  ownerId?: string;
  status: PairPollStatus;
  token?: string;
  refreshToken?: string;
  centrifugoUrl?: string;
  userId?: string;
  accountApproval?: AccountEnrollmentBundle;
  accountHistory?: AccountHistory;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Drive the pairing flow to completion.
 *
 * Resolves with the token bundle on approval; rejects (with a clear, secret-free
 * message) on denial, expiry/consumption/unknown, or overall timeout.
 */
export function runPairing(opts: RunPairingOptions & { pending: PendingBridgePairingContext }): Promise<PendingPairingVerified>;
export function runPairing(opts: RunPairingOptions): Promise<PairingResult>;
export async function runPairing(opts: RunPairingOptions): Promise<PairingResult> {
  if (opts.pending) return runPendingPairing(opts, opts.pending);
  const {
    apiUrl,
    bridgeId,
    hostname,
    platform,
    localPort,
    localNonce,
    fetchImpl = fetch,
    sleepImpl = realSleep,
    log = (msg: string): void => console.log(msg),
  } = opts;
  const enrollment = opts.enrollment ? await parseAccountEnrollmentLink(opts.enrollment) : undefined;
  if (enrollment && (enrollment.request.kind !== 'bridge' || enrollment.request.bridgeId !== bridgeId)) throw new Error('Invalid encrypted bridge enrollment');

  const start = await postJson<PairStartResponse>(fetchImpl, `${apiUrl}/api/auth/bridge/pair/start`, {
    bridgeId,
    hostname,
    platform,
    ...(enrollment ? { enrollment: enrollment.request } : {}),
  });

  // P8: userCode + URL are printed; deviceCode is NEVER logged.
  if (enrollment) {
    accountReadUrl(apiUrl);
    if (typeof start.userCode !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(start.userCode)
      || typeof start.deviceCode !== 'string' || start.deviceCode.length < 1 || start.deviceCode.length > 200
      || !Number.isInteger(start.intervalMs) || start.intervalMs < 100 || start.intervalMs > 60000
      || !Number.isInteger(start.expiresInMs) || start.expiresInMs < 1 || start.expiresInMs > 300000) throw new Error('Invalid encrypted bridge approval response');
    await opts.onPairingCode?.(start.userCode);
    const url = new URL('/pair', apiUrl); url.searchParams.set('code', start.userCode);
    url.hash = `account=${encodeAccountEnrollmentLink(enrollment)}`;
    // An interactive CLI may display this directly; redirected logs only receive instructions.
    if (opts.displayEnrollmentUrl) opts.displayEnrollmentUrl(url.href);
    else if (process.stderr.isTTY) process.stderr.write(`Approve this computer: ${url.href}\n`);
    log('Waiting for encrypted computer approval. Run ftown security pair-link to display the current private approval link.');
  } else log(
    'Approve this machine to connect it to ftown:\n' +
      `    ${start.verificationUri}\n` +
      `    code: ${start.userCode}\n` +
      'Waiting for approval…',
  );

  const deviceCode = start.deviceCode;
  const intervalMs = start.intervalMs;
  const deadline = Math.min(Date.now() + start.expiresInMs, enrollment ? Date.parse(enrollment.request.expiresAt) : Infinity);

  // Wait one interval before the first poll (the user needs time to approve).
  await sleepImpl(intervalMs);

  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error('Pairing timed out');
    }

    const poll = await postJson<PairPollResponse>(fetchImpl, `${apiUrl}/api/auth/bridge/pair/poll`, {
      deviceCode,
      localPort,
    });

    switch (poll.status) {
      case 'approved': {
        if (!poll.ownerId || !poll.token || !poll.refreshToken || !poll.centrifugoUrl || !poll.userId) {
          throw new Error('Pairing approved but token bundle was incomplete');
        }
        if (enrollment && (!poll.accountApproval || !poll.accountHistory)) throw new Error('Encrypted bridge approval is required; no legacy fallback');
        return {
          ownerId: poll.ownerId,
          token: poll.token,
          refreshToken: poll.refreshToken,
          centrifugoUrl: poll.centrifugoUrl,
          userId: poll.userId,
          ...(enrollment ? { accountApproval: poll.accountApproval!, accountHistory: poll.accountHistory! } : {}),
        };
      }
      case 'pending':
        await sleepImpl(intervalMs);
        break;
      case 'slow_down':
        // Advisory back-off: wait an extra interval on top of the normal one.
        await sleepImpl(intervalMs * 2);
        break;
      case 'denied':
        throw new Error('Pairing denied');
      case 'expired':
        throw new Error('Pairing request expired before approval');
      case 'consumed':
        throw new Error('Pairing code was already consumed');
      case 'unknown':
        throw new Error('Pairing request not found (unknown device code)');
      default:
        throw new Error(`Unexpected pairing status: ${String((poll as { status: string }).status)}`);
    }
  }
}

class PendingNetworkError extends Error {
  constructor() { super('Computer approval service is temporarily unavailable.'); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccountTrustError('account_enrollment_invalid');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 16384): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > limit) throw new AccountTrustError('account_enrollment_invalid');
  return value;
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    })]);
  } finally { if (listener) signal.removeEventListener('abort', listener); }
}
/** Bound the entire fetch AND body read, and never send a credential through a redirect. */
async function pendingJson(opts: Pick<RunPairingOptions, 'apiUrl' | 'fetchImpl'>, path: string, body: unknown, lifetime: AbortSignal): Promise<unknown> {
  const base = accountReadUrl(opts.apiUrl);
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin || !path.startsWith('/api/')) throw new AccountTrustError('account_enrollment_invalid');
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > PENDING_APPROVAL_LIMITS.maxWireBytes) throw new AccountTrustError('account_capacity_exceeded');
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new PendingNetworkError()), PENDING_APPROVAL_LIMITS.requestTimeoutMs);
  const signal = AbortSignal.any([lifetime, timeout.signal]);
  try {
    const result = await abortable((async () => {
      let response: Response;
      try { response = await (opts.fetchImpl ?? fetch)(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: encoded, redirect: 'manual', cache: 'no-store', signal }); }
      catch { if (lifetime.aborted) lifetime.throwIfAborted(); throw new PendingNetworkError(); }
      if (response.status >= 300 && response.status < 400) throw new AccountTrustError('account_enrollment_invalid');
      if (response.status === 429 || response.status >= 500) throw new PendingNetworkError();
      if (!response.ok) throw new AccountTrustError(response.status === 409 ? 'account_trust_conflict'
        : response.status === 410 ? 'account_enrollment_expired' : 'account_enrollment_invalid');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > PENDING_APPROVAL_LIMITS.maxWireBytes)) throw new AccountTrustError('account_capacity_exceeded');
      const reader = response.body?.getReader();
      if (!reader) throw new AccountTrustError('account_enrollment_invalid');
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          let next: ReadableStreamReadResult<Uint8Array>;
          try { next = await reader.read(); }
          catch { signal.throwIfAborted(); throw new PendingNetworkError(); }
          const { done, value } = next; if (done) break;
          size += value.byteLength;
          if (size > PENDING_APPROVAL_LIMITS.maxWireBytes) throw new AccountTrustError('account_capacity_exceeded');
          chunks.push(value);
        }
        const bytes = Buffer.concat(chunks);
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
        catch { throw new AccountTrustError('account_enrollment_invalid'); }
      } finally { signal.removeEventListener('abort', cancel); if (signal.aborted || size > PENDING_APPROVAL_LIMITS.maxWireBytes) cancel(); reader.releaseLock(); }
    })(), signal);
    lifetime.throwIfAborted();
    return result;
  } finally { clearTimeout(timer); }
}

async function runPendingPairing(opts: RunPairingOptions, ctx: PendingBridgePairingContext): Promise<PendingPairingVerified> {
  if (opts.enrollment || ctx.request.kind !== 'bridge' || ctx.request.bridgeId !== opts.bridgeId
    || !isDeepStrictEqual(ctx.request.candidate, ctx.identity.endpoint) || !/^[A-Za-z0-9_-]{43}$/.test(ctx.candidateToken)) throw new AccountTrustError('account_enrollment_invalid');
  const hint = normalizePendingAccountHint(opts.accountHint);
  const expires = Date.parse(ctx.request.expiresAt);
  const expiry = new AbortController();
  const timer = setTimeout(() => expiry.abort(new AccountTrustError('account_enrollment_expired')), Math.max(0, expires - Date.now()));
  const signal = AbortSignal.any([ctx.signal, expiry.signal]);
  const processNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  let offer: PendingOffer | undefined; let packet: PendingHelloLocal | undefined;
  let confirmedOfferHash: string | undefined; let credentials: PendingPairingApproved | undefined;
  let localStatus: PendingBridgeStatus = { version: 1, requestId: ctx.request.requestId, processNonce,
    expiresAt: ctx.request.expiresAt, phase: 'waiting', offerHash: null, comparisonCode: null };
  let decision: PendingBridgeDecision | undefined;
  let decisionController = new AbortController();
  let statusKey = '';
  const assertLive = () => { signal.throwIfAborted(); if (Date.now() >= expires) throw new AccountTrustError('account_enrollment_expired'); };
  const updateStatus = async (next: PendingBridgeStatus) => {
    const key = JSON.stringify(next);
    if (key === statusKey) return;
    assertLive(); await ctx.onLocalStatus(next); assertLive();
    statusKey = key; localStatus = next; decision = undefined;
    decisionController.abort(); decisionController = new AbortController();
    if (next.phase === 'waiting' || next.phase === 'comparing' || next.phase === 'confirming') {
      const current = decisionController;
      void ctx.waitForLocalDecision(next, AbortSignal.any([signal, current.signal])).then(value => {
        if (!current.signal.aborted && !signal.aborted && matchesPendingBridgeDecision(next, value)) decision = value;
      }).catch(error => { if (!current.signal.aborted && !signal.aborted) expiry.abort(error); });
    }
  };
  const wait = () => abortable((opts.sleepImpl ?? realSleep)(PENDING_APPROVAL_LIMITS.pollIntervalMs), signal);
  const rpc = (action: unknown) => pendingJson(opts, `/api/security/approvals/${ctx.request.requestId}/candidate`, { candidateToken: ctx.candidateToken, action }, signal);
  let deviceCode: string | undefined; let latest: PendingApprovalState | undefined;
  const checkRejection = async () => {
    if (decision?.decision !== 'reject' || !matchesPendingBridgeDecision(localStatus, decision)) return;
    await updateStatus({ ...localStatus, phase: 'cancelled', comparisonCode: null });
    await rpc({ type: 'cancel', expectedRevision: latest?.revision ?? 0 }).catch(() => undefined);
    throw new Error('Computer approval cancelled locally.');
  };
  try {
    await updateStatus(localStatus);
    (opts.log ?? console.log)('Waiting for approval in your trusted browser. Run ftown security pair-status to compare, then pair-confirm CODE or pair-reject.');
    // Retry EXACT create payload: token and request were durable before this first HTTP call.
    const startBody = { bridgeId: opts.bridgeId, hostname: opts.hostname, platform: opts.platform,
      approvalMethod: 'pending-v1', accountHint: hint, candidateToken: ctx.candidateToken, enrollment: ctx.request };
    for (;;) {
      assertLive();
      await checkRejection();
      try {
        const start = record(await pendingJson(opts, '/api/auth/bridge/pair/start', startBody, signal));
        deviceCode = text(start.deviceCode, 200); text(start.userCode, 100); text(start.verificationUri, 4096);
        if (!Number.isInteger(start.intervalMs) || Number(start.intervalMs) < 100 || Number(start.intervalMs) > 60000
          || !Number.isInteger(start.expiresInMs) || Number(start.expiresInMs) < 1 || Number(start.expiresInMs) > PENDING_APPROVAL_LIMITS.lifetimeMs) throw new AccountTrustError('account_enrollment_invalid');
        break;
      } catch (error) { if (!(error instanceof PendingNetworkError)) throw error; await wait(); }
    }
    for (;;) {
      assertLive();
      await checkRejection();
      try {
        const state = await parsePendingState(await rpc({ type: 'read' }));
        if (!isDeepStrictEqual(state.request, ctx.request)) throw new AccountTrustError('account_enrollment_invalid');
        if (latest && state.revision < latest.revision) throw new AccountTrustError('account_trust_conflict');
        if (latest && state.revision === latest.revision && !isDeepStrictEqual(state, latest)) throw new AccountTrustError('account_trust_conflict');
        latest = state;
        if (['rejected', 'cancelled', 'expired', 'conflict'].includes(state.status)) {
          await updateStatus({ ...localStatus, phase: state.status as 'rejected' | 'cancelled' | 'expired' | 'conflict', comparisonCode: null });
          throw new Error(`Computer approval ${state.status}. Start a new explicit request.`);
        }
        const selectedDecision = decision;
        if (selectedDecision?.decision === 'reject') await checkRejection();
        if (state.status === 'pending') { await wait(); continue; }
        if (!('offer' in state)) throw new AccountTrustError('account_enrollment_invalid');
        const receivedOffer = await parsePendingOffer(state.offer, ctx.request);
        if (!offer) {
          await ctx.pinOffer(receivedOffer); assertLive(); offer = receivedOffer;
          await updateStatus({ ...localStatus, phase: 'waiting', offerHash: await pendingOfferHash(offer), comparisonCode: null });
          packet = await createPendingHello(ctx.identity, offer); assertLive();
          await ctx.pinHello(packet.hello); assertLive();
        } else if (await pendingOfferHash(receivedOffer) !== await pendingOfferHash(offer)) throw new AccountTrustError('account_trust_conflict');
        if (!packet) throw new AccountTrustError('account_enrollment_invalid');
        if (state.status === 'offered') {
          await rpc({ type: 'hello', expectedRevision: state.revision, hello: packet.hello });
          continue;
        }
        if (!('hello' in state) || await pendingHelloHash(state.hello) !== await pendingHelloHash(packet.hello)) throw new AccountTrustError('account_trust_conflict');
        if (state.status === 'submitted') { await wait(); continue; }
        if (!('reveal' in state)) throw new AccountTrustError('account_enrollment_invalid');
        const comparisonCode = await pendingComparisonCode(offer, packet.secret, state.reveal);
        const offerHash = await pendingOfferHash(offer);
        if (!confirmedOfferHash) {
          if (selectedDecision?.decision !== 'confirm' || !matchesPendingBridgeDecision(localStatus, selectedDecision)) {
            await updateStatus({ ...localStatus, phase: 'comparing', offerHash, comparisonCode });
            await wait(); continue;
          }
          await updateStatus({ ...localStatus, phase: 'confirming', offerHash, comparisonCode });
          confirmedOfferHash = offerHash;
        }
        const proof = await createPendingConfirmation(offer, packet.secret, state.reveal, confirmedOfferHash);
        assertLive();
        await checkRejection();
        if (state.status === 'comparing') { await rpc({ type: 'confirm', expectedRevision: state.revision, confirmation: proof }); continue; }
        if (!('confirmation' in state) || !isDeepStrictEqual(state.confirmation, proof)) throw new AccountTrustError('account_enrollment_invalid');
        if (state.status === 'confirmed') { await wait(); continue; }
        if (state.status !== 'approved') throw new AccountTrustError('account_enrollment_invalid');
        if (!credentials) {
          const polled = record(await pendingJson(opts, '/api/auth/bridge/pair/poll', { deviceCode, localPort: opts.localPort }, signal));
          if (polled.status === 'pending' || polled.status === 'slow_down') { await wait(); continue; }
          if (polled.status !== 'approved' || !polled.pendingApproval) throw new AccountTrustError('account_enrollment_invalid');
          credentials = { status: 'approved', ownerId: text(polled.ownerId, 100), token: text(polled.token), refreshToken: text(polled.refreshToken),
            centrifugoUrl: text(polled.centrifugoUrl, 4096), userId: text(polled.userId, 254), pendingApproval: state.result };
        }
        // The candidate RPC result may be renewed after credentials/pair bundle were consumed.
        const readTimeout = new AbortController();
        const readTimer = setTimeout(() => readTimeout.abort(new PendingNetworkError()), PENDING_APPROVAL_LIMITS.requestTimeoutMs);
        let history: AccountHistory | null;
        try {
          const readSignal = AbortSignal.any([signal, readTimeout.signal]);
          history = await abortable(readAccountHistory(opts.apiUrl, credentials.token, readSignal, opts.fetchImpl ?? fetch), readSignal);
        } finally { clearTimeout(readTimer); }
        if (!history) throw new AccountTrustError('account_approval_required');
        const readAt = Date.now(); assertLive();
        await checkRejection();
        const opened = await openPendingResult(ctx.identity, offer, packet.secret, state.reveal, confirmedOfferHash, state.result, history);
        assertLive();
        await checkRejection();
        if (opened.status === 'awaiting-delivery-renewal') { await wait(); continue; }
        if (opened.trust.checkpoint.ownerId !== credentials.ownerId) throw new AccountTrustError('account_enrollment_invalid');
        await updateStatus({ ...localStatus, phase: 'approved', offerHash, comparisonCode: null });
        return { ...credentials, pendingApproval: state.result, approvalMethod: 'pending-v1', verifiedAccountTrust: opened.trust, lastServerReadAt: readAt };
      } catch (error) {
        // Availability only: malformed proof/history or conflicts never turn into retries.
        if (!(error instanceof PendingNetworkError) && !(error instanceof Error && error.name === 'AccountReadUnavailable')) throw error;
        await wait();
      }
    }
  } catch (error) {
    if (!['approved', 'rejected', 'cancelled', 'expired', 'conflict'].includes(localStatus.phase)) {
      const phase = error instanceof AccountTrustError && error.code === 'account_enrollment_expired' ? 'expired'
        : error instanceof AccountTrustError && error.code === 'account_trust_conflict' ? 'conflict' : 'cancelled';
      await ctx.onLocalStatus({ ...localStatus, phase, comparisonCode: null }).catch(() => undefined);
    }
    throw error;
  } finally { clearTimeout(timer); decisionController.abort(); expiry.abort(); packet = undefined; }
}

/** Best effort only; the new process always uses a different request and keeps its own key. */
export async function cancelPreviousPendingPairing(apiUrl: string, previous: { requestId: string; candidateToken: string }, signal: AbortSignal): Promise<void> {
  const options = { apiUrl };
  try {
    const path = `/api/security/approvals/${previous.requestId}/candidate`;
    const state = await parsePendingState(await pendingJson(options, path, { candidateToken: previous.candidateToken, action: { type: 'read' } }, signal));
    if (['approved', 'rejected', 'cancelled', 'expired', 'conflict'].includes(state.status)) return;
    await pendingJson(options, path, { candidateToken: previous.candidateToken, action: { type: 'cancel', expectedRevision: state.revision } }, signal);
  } catch { /* Cancellation cannot grant trust and never causes an automatic fallback. */ }
}

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Pairing request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}
