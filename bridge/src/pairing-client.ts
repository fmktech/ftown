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

export interface RunPairingOptions {
  apiUrl: string;
  bridgeId: string;
  hostname: string;
  platform: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Where user-facing lines go; defaults to console.log. NEVER receives secrets. */
  log?: (msg: string) => void;
}

export interface PairingResult {
  token: string;
  refreshToken: string;
  centrifugoUrl: string;
  userId: string;
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
  status: PairPollStatus;
  token?: string;
  refreshToken?: string;
  centrifugoUrl?: string;
  userId?: string;
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
    fetchImpl = fetch,
    sleepImpl = realSleep,
    log = (msg: string): void => console.log(msg),
  } = opts;

  const start = await postJson<PairStartResponse>(fetchImpl, `${apiUrl}/api/auth/bridge/pair/start`, {
    bridgeId,
    hostname,
    platform,
  });

  // P8: userCode + URL are printed; deviceCode is NEVER logged.
  log(
    'Approve this machine to connect it to ftown:\n' +
      `    ${start.verificationUri}\n` +
      `    code: ${start.userCode}\n` +
      'Waiting for approval…',
  );

  const deviceCode = start.deviceCode;
  const intervalMs = start.intervalMs;
  const deadline = Date.now() + start.expiresInMs;

  // Wait one interval before the first poll (the user needs time to approve).
  await sleepImpl(intervalMs);

  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error('Pairing timed out');
    }

    const poll = await postJson<PairPollResponse>(fetchImpl, `${apiUrl}/api/auth/bridge/pair/poll`, {
      deviceCode,
    });

    switch (poll.status) {
      case 'approved': {
        if (!poll.token || !poll.refreshToken || !poll.centrifugoUrl || !poll.userId) {
          throw new Error('Pairing approved but token bundle was incomplete');
        }
        return {
          token: poll.token,
          refreshToken: poll.refreshToken,
          centrifugoUrl: poll.centrifugoUrl,
          userId: poll.userId,
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
    const text = await res.text();
    throw new Error(`Pairing request to ${url} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}
