/** Refresh before expiry so a reconnect does not use a token close to expiry. */
export const CENTRIFUGO_TOKEN_REUSE_MARGIN_MS = 10 * 60_000;

/** Read an expiry only for cache decisions; Centrifugo verifies the token. */
function expiryMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(base64 + "=".repeat((4 - base64.length % 4) % 4))) as { exp?: unknown } | null;
    if (!claims || typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
    const expiry = claims.exp * 1000;
    return Number.isFinite(expiry) ? expiry : null;
  } catch {
    return null;
  }
}

/** Reuse the last token until its refresh window, sharing concurrent mint requests. */
export function createCentrifugoTokenProvider(
  initialToken: string,
  mint: () => Promise<string>,
  now: () => number = Date.now,
): () => Promise<string> {
  let token = initialToken;
  let inFlight: Promise<string> | null = null;

  return () => {
    if (inFlight) return inFlight;
    const expiry = expiryMs(token);
    if (expiry !== null && expiry > now() + CENTRIFUGO_TOKEN_REUSE_MARGIN_MS) return Promise.resolve(token);
    const operation = Promise.resolve().then(mint).then(renewed => {
      token = renewed;
      return renewed;
    }).finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    inFlight = operation;
    return operation;
  };
}
