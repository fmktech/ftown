import { randomBytes } from "node:crypto";

/**
 * Device-pairing constants and code generation.
 *
 * See docs/plans/device-pairing-contract.md for the full flow (P1).
 */

export const PAIR_REQUEST_TTL_MS = 600_000;
export const PAIR_POLL_INTERVAL_MS = 5_000;

/** Crockford base32 alphabet, already excludes ambiguous I/L/O/U. 32 chars == 2^5, so
 *  masking a random byte to 5 bits yields a uniform, unbiased index. */
const USER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * High-entropy poll credential: 32 random bytes, base64url-encoded.
 */
export function genDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Human-entry code: 8 chars from the unambiguous alphabet, formatted "XXXX-XXXX".
 */
export function genUserCode(): string {
  const bytes = randomBytes(8);
  let chars = "";
  for (let i = 0; i < 8; i++) {
    chars += USER_CODE_ALPHABET[bytes[i] & 0x1f];
  }
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}
