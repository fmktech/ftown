/**
 * Validation for bridge-supplied identity labels (bridgeId, hostname).
 *
 * These values are minted into 24h Centrifugo JWTs and stored in the DB, and
 * hostname is rendered in the devices UI. Without a cap, a holder of a
 * bootstrap/refresh token could submit multi-kilobyte strings (JWT bloat, DB
 * bloat) or control characters / markup-adjacent labels.
 */
const BRIDGE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

export function isValidBridgeLabel(value: unknown): value is string {
  return typeof value === "string" && BRIDGE_LABEL_RE.test(value);
}
