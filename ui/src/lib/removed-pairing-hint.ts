export const REMOVED_PAIRING_HINT = "This computer was removed from your account. It replaces its identity by itself the next time it reaches the server and then shows a new pairing link. If it keeps showing this, run `ftown start --new-identity` on that computer.";

/** Pairing/approval of a computer only: a revoked bridgeId gets the removal hint; every other error keeps the generic mapping. */
export function pairingErrorMessage(error: unknown, generic: (error: unknown) => string, isComputer = true): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return isComputer && code === "account_bridge_revoked" ? REMOVED_PAIRING_HINT : generic(error);
}
