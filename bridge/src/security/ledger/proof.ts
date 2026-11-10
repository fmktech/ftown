import type { LedgerCheckpoint } from './protocol.js';

export interface AuthProof {
  accountId: string;
  kind: 'device' | 'bridge';
  /** endpoint.id for a device, bridgeId for a bridge. */
  keyId: string;
  nonce: string;
  purpose: 'session' | 'relay';
  /** Exact server origin. */
  audience: string;
  /** Raw r||s, base64url. */
  signature: string;
}

export type AuthProofFields = Omit<AuthProof, 'signature'>;

const PROOF_DOMAIN = 'ftown-auth-proof-v1\n';
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;
const MAX_NONCE = 128;
const B64URL = /^[A-Za-z0-9_-]+$/;
const KEYS = ['accountId', 'kind', 'keyId', 'nonce', 'purpose', 'audience', 'signature'];
const MAX_ACCOUNT = 64;
const MAX_KEY_ID = 128;
const MAX_AUDIENCE = 256;
const SIGNATURE_LENGTH = 86;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const ORDER = hexBytes('FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
const HALF_ORDER = hexBytes('7FFFFFFF800000007FFFFFFFFFFFFFFFDE737D56D38BCF4279DCE5617E3192A8');

function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function isHighS(s: ArrayLike<number>): boolean {
  for (let i = 0; i < 32; i++) {
    if (s[i] !== HALF_ORDER[i]) return s[i] > HALF_ORDER[i];
  }
  return false;
}

function lowS(signature: Uint8Array): Uint8Array {
  if (!isHighS(signature.subarray(32))) return signature;
  const out = new Uint8Array(signature);
  let borrow = 0;
  for (let i = 31; i >= 0; i--) {
    let value = ORDER[i] - signature[32 + i] - borrow;
    borrow = value < 0 ? 1 : 0;
    if (value < 0) value += 256;
    out[32 + i] = value;
  }
  return out;
}

function validAudience(value: string): boolean {
  if (value.length === 0 || value.length > MAX_AUDIENCE) return false;
  try {
    const url = new URL(value);
    if (url.origin !== value) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.indexOf(url.hostname) !== -1);
  } catch { return false; }
}

function encode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL.test(value) || value.length % 4 === 1) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch { return null; }
}

function canonicalBytes(fields: AuthProofFields): Uint8Array<ArrayBuffer> {
  const ordered = {
    accountId: fields.accountId,
    audience: fields.audience,
    keyId: fields.keyId,
    kind: fields.kind,
    nonce: fields.nonce,
    purpose: fields.purpose,
  };
  const text = PROOF_DOMAIN + JSON.stringify(ordered);
  const out = new Uint8Array(new ArrayBuffer(text.length * 3));
  const { written } = new TextEncoder().encodeInto(text, out);
  return out.slice(0, written);
}

export async function generateAuthKey(extractable: boolean): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(ECDSA, extractable, ['sign', 'verify']);
  const publicKey = encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { publicKey, privateKey: pair.privateKey };
}

export async function signAuthProof(privateKey: CryptoKey, fields: AuthProofFields): Promise<AuthProof> {
  const { accountId, kind, keyId, nonce, purpose, audience } = fields;
  const signature = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, canonicalBytes({ accountId, kind, keyId, nonce, purpose, audience })));
  return { accountId, kind, keyId, nonce, purpose, audience, signature: encode(lowS(signature)) };
}

export function parseAuthProof(value: unknown): AuthProof | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== KEYS.length || !keys.every(key => KEYS.indexOf(key) !== -1)) return null;
    const { accountId, kind, keyId, nonce, purpose, audience, signature } = record;
    if (typeof accountId !== 'string' || !accountId || accountId.length > MAX_ACCOUNT) return null;
    if (typeof keyId !== 'string' || !keyId || keyId.length > MAX_KEY_ID) return null;
    if (kind !== 'device' && kind !== 'bridge') return null;
    if (purpose !== 'session' && purpose !== 'relay') return null;
    if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > MAX_NONCE || !B64URL.test(nonce)) return null;
    if (typeof audience !== 'string' || !validAudience(audience)) return null;
    if (typeof signature !== 'string' || signature.length !== SIGNATURE_LENGTH || !B64URL.test(signature)) return null;
    return { accountId, kind, keyId, nonce, purpose, audience, signature };
  } catch { return null; }
}

// Nonce freshness and single use are enforced by the server, not here.
export async function verifyAuthProof(
  checkpoint: LedgerCheckpoint,
  proof: AuthProof,
  expect: { audience: string; purpose: 'session' | 'relay' },
): Promise<boolean> {
  try {
    const parsed = parseAuthProof(proof);
    if (!parsed || parsed.accountId !== checkpoint.accountId) return false;
    if (parsed.audience !== expect.audience || parsed.purpose !== expect.purpose) return false;
    if (parsed.kind === 'bridge' && parsed.purpose === 'session') return false;
    let authPublicKey: string | undefined;
    if (parsed.kind === 'device') {
      if (checkpoint.revokedDeviceIds.indexOf(parsed.keyId) !== -1) return false;
      authPublicKey = checkpoint.devices.filter(entry => entry.endpoint.id === parsed.keyId)[0]?.authPublicKey;
    } else {
      if (checkpoint.revokedBridgeIds.indexOf(parsed.keyId) !== -1) return false;
      authPublicKey = checkpoint.bridges.filter(entry => entry.bridgeId === parsed.keyId)[0]?.authPublicKey;
    }
    if (!authPublicKey) return false;
    const raw = decode(authPublicKey);
    const signature = decode(parsed.signature);
    if (!raw || raw.length !== 65 || !signature || signature.length !== 64 || encode(signature) !== parsed.signature || isHighS(signature.subarray(32))) return false;
    const key = await crypto.subtle.importKey('raw', raw, ECDSA, false, ['verify']);
    return await crypto.subtle.verify(SIGN, key, signature, canonicalBytes(parsed));
  } catch { return false; }
}
