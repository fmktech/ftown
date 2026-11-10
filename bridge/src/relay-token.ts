import { UnauthorizedError } from 'centrifuge';
import { signAuthProof } from './security/ledger/proof.js';

export interface RelayTokenFetcherDeps {
  apiUrl: string;
  accountId: () => string;
  bridgeId: string;
  authPrivateKey: CryptoKey;
  /** Head of the locally trusted ledger, or null when there is none. */
  head: () => string | null;
  /** Called with a ledger returned by the server, BEFORE the token is handed back. */
  onLedger: (ledger: unknown) => Promise<void>;
  /** A successful answer WITHOUT a ledger (the server sends one only when its head differs from the one sent): the server's head, as the
   *  answer names it ({ head, revision }), else the head this request sent (revision null). Called before the token is handed back. */
  onServerHead?: (server: { head: string | null; revision: number | null }) => void;
  /** Called with the evidence ledger of a 401 key_revoked, BEFORE UnauthorizedError is thrown. */
  onRevoked: (ledger: unknown) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
  /** Presence info claim, as refreshBridgeToken sends today (os.hostname()). Omitted when undefined. */
  hostname?: () => string;
  /** Loopback port advert (discovery only). Omitted when undefined. */
  localPort?: () => number | undefined;
  /** On a plain 401 (not key_revoked): resolve true to retry the whole sequence exactly once. */
  onUnauthorized?: () => Promise<boolean>;
}

/** A 401 key_revoked; still terminal for centrifuge-js. `ledger` is the (unverified) evidence. */
export class RelayKeyRevokedError extends UnauthorizedError {
  readonly ledger: unknown;

  constructor(ledger: unknown) {
    super('Bridge revoked');
    this.name = 'RelayKeyRevokedError';
    this.ledger = ledger;
  }
}

export interface RelayToken {
  token: string;
  expiresAt: number;
}

const BODY_CAP = 200;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function post(fetchImpl: typeof fetch, url: string, body: unknown, timeoutMs: number): Promise<{ status: number; ok: boolean; text: string }> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_RESPONSE_BYTES) throw new Error('relay_token_response_too_large');
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('relay_token_response_too_large');
    return { status: res.status, ok: res.ok, text };
  } catch (error) {
    if (error instanceof Error && error.message === 'relay_token_response_too_large') throw error;
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`Relay request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

class PlainUnauthorized extends UnauthorizedError {}

function toUnauthorized(error: unknown): unknown {
  return error instanceof PlainUnauthorized ? new UnauthorizedError(error.message) : error;
}

/**
 * Proves possession of the bridge auth key to the server and returns a relay (Centrifugo) token.
 * Replaces the rotating refresh token: there is no credential to persist.
 *
 * A 401 is terminal (UnauthorizedError stops centrifuge-js retrying); everything else is a plain
 * Error so the caller's backoff and cooldown apply.
 */
export function createRelayTokenFetcher(deps: RelayTokenFetcherDeps): () => Promise<RelayToken> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiUrl = deps.apiUrl.replace(/\/+$/, '');
  const audience = new URL(apiUrl).origin;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const presence = (): { hostname?: string; localPort?: number } => {
    const out: { hostname?: string; localPort?: number } = {};
    const hostname = deps.hostname?.();
    if (hostname !== undefined) out.hostname = hostname;
    const localPort = deps.localPort?.();
    if (localPort !== undefined) out.localPort = localPort;
    return out;
  };

  const attempt = async (): Promise<RelayToken> => {
    const nonceRes = await post(fetchImpl, `${apiUrl}/api/auth/nonce`, { purpose: 'relay' }, timeoutMs);
    const nonceText = nonceRes.text;
    if (!nonceRes.ok) throw new Error(`Relay nonce failed (${nonceRes.status}): ${nonceText.slice(0, BODY_CAP)}`);
    const nonce = parseJson(nonceText)?.nonce;
    if (typeof nonce !== 'string' || nonce.length === 0) throw new Error('Relay nonce response malformed');

    const proof = await signAuthProof(deps.authPrivateKey, {
      accountId: deps.accountId(),
      kind: 'bridge',
      keyId: deps.bridgeId,
      nonce,
      purpose: 'relay',
      audience,
    });

    const sentHead = deps.head();
    const res = await post(fetchImpl, `${apiUrl}/api/auth/relay-token`, { proof, head: sentHead, ...presence() }, timeoutMs);
    const text = res.text;

    if (res.status === 401) {
      const body = parseJson(text);
      if (body && body.error === 'key_revoked' && body.ledger !== undefined) {
        await deps.onRevoked(body.ledger);
        throw new RelayKeyRevokedError(body.ledger);
      }
      throw new PlainUnauthorized(`Relay token rejected (401): ${text.slice(0, BODY_CAP)}`);
    }
    if (!res.ok) throw new Error(`Relay token failed (${res.status}): ${text.slice(0, BODY_CAP)}`);

    const body = parseJson(text);
    if (!body || typeof body.token !== 'string' || !body.token || typeof body.expiresAt !== 'number') {
      throw new Error('Relay token response malformed');
    }
    if (body.ledger !== undefined && body.ledger !== null) await deps.onLedger(body.ledger);
    else if (deps.onServerHead) {
      const named = typeof body.head === 'string' && typeof body.revision === 'number' && Number.isSafeInteger(body.revision) && body.revision >= 0;
      try { deps.onServerHead(named ? { head: body.head as string, revision: body.revision as number } : { head: sentHead, revision: null }); }
      catch { /* a hint only: the token is still returned */ }
    }
    return { token: body.token, expiresAt: body.expiresAt };
  };

  return async () => {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof PlainUnauthorized) || !deps.onUnauthorized) throw toUnauthorized(error);
      if (!(await deps.onUnauthorized())) throw toUnauthorized(error);
      try {
        return await attempt();
      } catch (retryError) {
        throw toUnauthorized(retryError);
      }
    }
  };
}
