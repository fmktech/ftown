import { LEDGER_LIMITS, type LedgerCheckpoint } from './protocol.js';
import { signDomain, verifyDomain } from './proof.js';

/**
 * A member replica's signed statement "I hold head `head` at revision `revision`", published on the account's ledger channel
 * (accountChannel('bridges:ledger', accountId)). `keyId` is the device's endpoint id or the bridge's bridgeId, the same ids auth proofs use.
 * An announcement is never proof of a chain: it only tells a receiver whether to fetch one and run fork choice on it.
 */
export interface HeadAnnouncement {
  type: 'ledger_head';
  version: 1;
  accountId: string;
  kind: 'device' | 'bridge';
  keyId: string;
  head: string;
  revision: number;
  at: number;
  /** Raw r||s, low S, canonical unpadded base64url (64 bytes). */
  signature: string;
}

/** Signed bytes: UTF-8 of HEAD_ANNOUNCE_DOMAIN + JSON of { accountId, at, head, keyId, kind, revision } in that key order. */
export const HEAD_ANNOUNCE_DOMAIN = 'ftown-head-announce-v1\n';
/** Receivers accept |now - at| <= this. */
export const HEAD_ANNOUNCE_MAX_AGE_MS = 120_000;

type Fields = Omit<HeadAnnouncement, 'type' | 'version' | 'signature'>;

const KEYS = ['type', 'version', 'accountId', 'kind', 'keyId', 'head', 'revision', 'at', 'signature'];
/** Canonical unpadded base64url of exactly 32 bytes: 43 chars, the last one carrying no stray bits. */
const B64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/** Canonical unpadded base64url of exactly 64 bytes. */
const B64URL_64 = /^[A-Za-z0-9_-]{85}[AQgw]$/;
/** A ledger bridgeId (protocol token). */
const BRIDGE_ID = /^[A-Za-z0-9_-]{1,200}$/;

function validFields(record: Record<string, unknown>): boolean {
  const { accountId, kind, keyId, head, revision, at } = record;
  if (typeof accountId !== 'string' || !B64URL_32.test(accountId)) return false;
  if (typeof head !== 'string' || !B64URL_32.test(head)) return false;
  if (kind !== 'device' && kind !== 'bridge') return false;
  if (typeof keyId !== 'string' || !(kind === 'device' ? B64URL_32 : BRIDGE_ID).test(keyId)) return false;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision > LEDGER_LIMITS.maxTransitions) return false;
  return typeof at === 'number' && Number.isSafeInteger(at) && at >= 0;
}

function signedBytes(fields: Fields): Uint8Array {
  const ordered = {
    accountId: fields.accountId,
    at: fields.at,
    head: fields.head,
    keyId: fields.keyId,
    kind: fields.kind,
    revision: fields.revision,
  };
  return new TextEncoder().encode(HEAD_ANNOUNCE_DOMAIN + JSON.stringify(ordered));
}

/** Strict shape: exactly the nine keys, literal type/version, canonical base64url ids, safe integers. Anything else → null; never throws. */
export function parseHeadAnnouncement(value: unknown): HeadAnnouncement | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== KEYS.length || !keys.every(key => KEYS.indexOf(key) !== -1)) return null;
    if (record.type !== 'ledger_head' || record.version !== 1) return null;
    if (!validFields(record)) return null;
    if (typeof record.signature !== 'string' || !B64URL_64.test(record.signature)) return null;
    const { accountId, kind, keyId, head, revision, at, signature } = record as unknown as HeadAnnouncement;
    return { type: 'ledger_head', version: 1, accountId, kind, keyId, head, revision, at, signature };
  } catch { return null; }
}

/** Signs with the member's ECDSA P-256 auth private key. Extra properties of `fields` are ignored; invalid fields throw invalid_head_announcement. */
export async function signHeadAnnouncement(key: CryptoKey, fields: Omit<HeadAnnouncement, 'type' | 'version' | 'signature'>): Promise<HeadAnnouncement> {
  const { accountId, kind, keyId, head, revision, at } = fields;
  const copy: Fields = { accountId, kind, keyId, head, revision, at };
  if (!validFields(copy as unknown as Record<string, unknown>)) throw new Error('invalid_head_announcement');
  const signature = await signDomain(key, signedBytes(copy));
  return { type: 'ledger_head', version: 1, accountId, kind, keyId, head, revision, at, signature };
}

/**
 * True only when `announcement` is well formed, of `checkpoint`'s account, from a member of `checkpoint` (by kind + keyId) that is not
 * revoked there, within HEAD_ANNOUNCE_MAX_AGE_MS of `now` either way, and signed by that member's authPublicKey. `checkpoint` must be the
 * receiver's TRUSTED view of its own chain. Cheap checks run first: at most one signature verification per call. Never throws.
 */
export async function verifyHeadAnnouncement(checkpoint: LedgerCheckpoint, announcement: HeadAnnouncement, now: number): Promise<boolean> {
  try {
    const parsed = parseHeadAnnouncement(announcement);
    if (!parsed || parsed.accountId !== checkpoint.accountId) return false;
    if (typeof now !== 'number' || !Number.isFinite(now) || Math.abs(now - parsed.at) > HEAD_ANNOUNCE_MAX_AGE_MS) return false;
    let authPublicKey: string | undefined;
    if (parsed.kind === 'device') {
      if (checkpoint.revokedDeviceIds.indexOf(parsed.keyId) !== -1) return false;
      authPublicKey = checkpoint.devices.filter(entry => entry.endpoint.id === parsed.keyId)[0]?.authPublicKey;
    } else {
      if (checkpoint.revokedBridgeIds.indexOf(parsed.keyId) !== -1) return false;
      authPublicKey = checkpoint.bridges.filter(entry => entry.bridgeId === parsed.keyId)[0]?.authPublicKey;
    }
    if (!authPublicKey) return false;
    return await verifyDomain(authPublicKey, parsed.signature, signedBytes(parsed));
  } catch { return false; }
}
