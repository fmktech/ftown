import { hostname as osHostname } from 'node:os';
import { UnauthorizedError } from 'centrifuge';

/** Loopback advert embedded in the Centrifugo connection JWT `info` claim (L2). */
export interface BridgeLocalAdvert {
  localPort: number;
  localNonce: string;
}

export interface BridgeAuthResponse {
  token: string;
  refreshToken: string;
  centrifugoUrl: string;
  userId: string;
}

export async function fetchBridgeToken(
  apiUrl: string,
  authToken: string,
  bridgeId: string,
  local: BridgeLocalAdvert,
): Promise<BridgeAuthResponse> {
  const res = await fetch(`${apiUrl}/api/auth/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: authToken,
      bridgeId,
      hostname: osHostname(),
      // Embedded in the Centrifugo connection JWT `info` claim so the owning
      // user's clients discover the loopback WS rung via presence (L2).
      localPort: local.localPort,
      localNonce: local.localNonce,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge auth failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<BridgeAuthResponse>;
}

/**
 * Exchange a (rotating) refresh token for a fresh Centrifugo connect token.
 *
 * The server rotates the refresh token on every use (audit finding F3): the
 * response carries a NEW refreshToken that supersedes the one just sent, so the
 * caller must persist it and send the newest value next time. Reusing an old
 * refresh token is rejected.
 */
export async function refreshBridgeToken(
  apiUrl: string,
  refreshToken: string,
  bridgeId: string,
  local: BridgeLocalAdvert,
): Promise<BridgeAuthResponse> {
  const res = await fetch(`${apiUrl}/api/auth/bridge/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refreshToken,
      bridgeId,
      hostname: osHostname(),
      localPort: local.localPort,
      localNonce: local.localNonce,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const message = `Token refresh failed (${res.status}): ${body}`;
    // A rejected bridge credential cannot become valid through retrying.
    // centrifuge-js only stops its token retry loop for UnauthorizedError;
    // ordinary errors are treated as transient and retried indefinitely.
    if (res.status === 401) {
      throw new UnauthorizedError(message);
    }
    throw new Error(message);
  }

  return res.json() as Promise<BridgeAuthResponse>;
}
