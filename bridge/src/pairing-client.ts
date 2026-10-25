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
}

export interface PairingResult {
  ownerId: string;
  token: string;
  refreshToken: string;
  centrifugoUrl: string;
  userId: string;
  accountApproval?: AccountEnrollmentBundle;
  accountHistory?: AccountHistory;
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
export async function runPairing(opts: RunPairingOptions): Promise<PairingResult> {
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
