import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { getRequiredSecret } from '@/lib/secrets';

/*
 * Integrity of the raw checkpoint persisted next to a stored chain. The key is derived from AUTH_SECRET, which the database does not
 * hold, so a database-only writer cannot produce a checkpoint the server will trust:
 *   K   = HKDF-SHA256(ikm = AUTH_SECRET, salt = empty, info = "ftown-checkpoint-v1", 32 bytes)
 *   mac = HMAC-SHA256(K, "ftown-checkpoint-v1" \n account_id \n revision \n head \n hex(SHA-256(canonicalSticky(sticky))) \n checkpoint)
 * Every field before the checkpoint text has a fixed alphabet without newlines, so the message is unambiguous.
 */
const DOMAIN = 'ftown-checkpoint-v1';
const NO_NEWLINE = /^[^\n]*$/;

export interface CheckpointSticky { deviceIds: string[]; bridgeIds: string[] }
export interface CheckpointMacInput { accountId: string; revision: number; head: string; sticky: CheckpointSticky; checkpoint: string }

/** THE serialization of a sticky set for the MAC, used on write and on read alike: exactly these two keys, in this order, arrays as
 *  they are. The column's own text is never used (jsonb reorders keys and whitespace). */
export function canonicalSticky(sticky: CheckpointSticky): string {
  return JSON.stringify({ deviceIds: sticky.deviceIds, bridgeIds: sticky.bridgeIds });
}

let derived: { secret: string; key: Buffer } | null = null;
function macKey(): Buffer {
  const secret = getRequiredSecret('AUTH_SECRET');
  if (derived === null || derived.secret !== secret) derived = { secret, key: Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), DOMAIN, 32)) };
  return derived.key;
}

function wellFormed(input: CheckpointMacInput): boolean {
  return NO_NEWLINE.test(input.accountId) && NO_NEWLINE.test(input.head) && Number.isSafeInteger(input.revision) && input.revision >= 0;
}

/** Lowercase hex HMAC for a row. Throws on a field that would make the message ambiguous, and when AUTH_SECRET is unusable. */
export function checkpointMac(input: CheckpointMacInput): string {
  if (!wellFormed(input)) throw new TypeError('checkpoint MAC input is malformed');
  const sticky = createHash('sha256').update(canonicalSticky(input.sticky)).digest('hex');
  return createHmac('sha256', macKey()).update([DOMAIN, input.accountId, String(input.revision), input.head, sticky, input.checkpoint].join('\n')).digest('hex');
}

/** Constant-time check of a stored MAC. false for anything that is not a well-formed MAC of exactly these inputs. */
export function checkpointMacValid(input: CheckpointMacInput, mac: unknown): boolean {
  if (typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac) || !wellFormed(input)) return false;
  return timingSafeEqual(Buffer.from(checkpointMac(input), 'hex'), Buffer.from(mac, 'hex'));
}
