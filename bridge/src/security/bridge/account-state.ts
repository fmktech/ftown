import { z } from 'zod';
import { ACCOUNT_TRUST_LIMITS, parseAccountHistory } from '../account-crypto.js';
import type { AccountHistory, StoredAccountTrust } from '../account-protocol.js';
import type { SecurityErrorCode } from '../protocol.js';
import { endpointSchema } from './metadata.js';
import { BridgeSecurityError } from './errors.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestamp = z.number().int().nonnegative().finite();
const device = z.object({ endpoint: endpointSchema, signingPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  label: z.string().max(200), approvedAt: z.string().datetime() }).strict();
const bridge = z.object({ bridgeId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), endpoint: endpointSchema,
  label: z.string().max(200), approvedAt: z.string().datetime() }).strict();
export const accountCheckpointSchema = z.object({ version: z.literal(1), ownerId: z.string().guid(), rootId: id, head: id,
    revision: z.number().int().min(0).max(ACCOUNT_TRUST_LIMITS.maxTransitions),
    devices: z.array(device).max(ACCOUNT_TRUST_LIMITS.maxDevices), bridges: z.array(bridge).max(ACCOUNT_TRUST_LIMITS.maxBridges),
    revokedDeviceIds: z.array(id).max(ACCOUNT_TRUST_LIMITS.maxTransitions),
    revokedBridgeIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)).max(ACCOUNT_TRUST_LIMITS.maxTransitions),
  }).strict();
export const verifiedAccountSchema = z.object({
  history: z.custom<AccountHistory>(value => { try { parseAccountHistory(value); return true; } catch { return false; } }),
  checkpoint: accountCheckpointSchema,
}).strict();
export const storedAccountSchema: z.ZodType<StoredAccountTrust> = verifiedAccountSchema.extend({
  lastServerReadAt: timestamp, lastObservedAt: timestamp,
}).strict();

/** A restart deliberately has no running-process grace until a valid server read. */
export class AccountConnectivity {
  private ready = false;
  private renewedAt = 0;
  private lastMonotonic = 0;
  private observedAt = 0;
  private failure: SecurityErrorCode | null = null;
  constructor(private readonly now: () => number, private readonly monotonic: () => number) {}
  observed(stored: StoredAccountTrust): number {
    const now = this.now();
    const highwater = Math.max(this.observedAt, stored.lastObservedAt, stored.lastServerReadAt);
    if (!Number.isSafeInteger(now) || now < highwater) {
      this.failure = 'account_offline_expired';
      throw new BridgeSecurityError('account_offline_expired');
    }
    this.observedAt = now;
    return now;
  }
  renew(stored: StoredAccountTrust): void {
    this.observed(stored);
    const monotonic = this.monotonic();
    if (!Number.isFinite(monotonic) || monotonic < this.lastMonotonic) throw new BridgeSecurityError('account_offline_expired');
    this.lastMonotonic = monotonic; this.renewedAt = monotonic;
    this.ready = true; this.failure = null;
  }
  check(stored: StoredAccountTrust): void {
    const now = this.observed(stored);
    const monotonic = this.monotonic();
    if (this.failure) throw new BridgeSecurityError(this.failure);
    if (!this.ready || !Number.isFinite(monotonic) || monotonic < this.lastMonotonic
      || monotonic - this.renewedAt >= ACCOUNT_TRUST_LIMITS.offlineGraceMs
      || now - stored.lastServerReadAt >= ACCOUNT_TRUST_LIMITS.offlineGraceMs) {
      throw new BridgeSecurityError('account_offline_expired');
    }
    this.lastMonotonic = monotonic;
  }
  block(code: SecurityErrorCode): void { this.failure = code; }
  highwater(): number { return this.observedAt; }
}
