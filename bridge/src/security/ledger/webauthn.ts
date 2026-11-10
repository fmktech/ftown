import type { PasskeySignature } from './protocol.js';

const encoder = new TextEncoder();
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const MIN_CHALLENGE_BYTES = 16;
const MAX_AUTHENTICATOR_DATA_BYTES = 4096;
const MAX_CLIENT_DATA_BYTES = 4096;
const MAX_DER_SIGNATURE_BYTES = 72;

function malformed(): never {
  throw new Error('Malformed DER signature');
}
function isBytes(value: unknown): value is Uint8Array {
  // Tag check instead of instanceof so typed arrays from another realm are accepted.
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function b64url(data: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < data.length; index += 1) binary += String.fromCharCode(data[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Canonical unpadded base64url only; the length bound is checked before decoding. */
function fromB64url(value: unknown, min: number, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url');
  }
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  if (binary.length < min || binary.length > max) throw new Error('Invalid length');
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  if (b64url(result) !== value) throw new Error('Non-canonical base64url');
  return result;
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}
/** Returns [length, offset of the content]. Definite lengths only, minimally encoded. */
function derLength(der: Uint8Array, offset: number): [number, number] {
  if (offset >= der.length) return malformed();
  const first = der[offset];
  if (first < 0x80) return [first, offset + 1];
  const count = first & 0x7f;
  if (count < 1 || count > 2 || offset + 1 + count > der.length) return malformed();
  let length = 0;
  for (let index = 0; index < count; index += 1) length = length * 256 + der[offset + 1 + index];
  if (length < (count === 1 ? 0x80 : 0x100)) return malformed();
  return [length, offset + 1 + count];
}
/** One positive, minimally encoded INTEGER of at most 32 significant bytes, left-padded to 32. */
function derInteger(der: Uint8Array, offset: number, end: number): { value: Uint8Array<ArrayBuffer>; next: number } {
  if (offset >= end || der[offset] !== 0x02) return malformed();
  const [length, start] = derLength(der, offset + 1);
  const next = start + length;
  if (length < 1 || next > end) return malformed();
  let value = der.subarray(start, next);
  if ((value[0] & 0x80) !== 0) return malformed();
  if (value[0] === 0) {
    // A leading zero is only legal as the sign pad of a high-bit byte; a lone zero is r or s = 0.
    if (value.length === 1 || (value[1] & 0x80) === 0) return malformed();
    value = value.subarray(1);
  }
  if (value.length > 32) return malformed();
  const padded = new Uint8Array(32);
  padded.set(value, 32 - value.length);
  return { value: padded, next };
}

export function derToRawSignature(der: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!isBytes(der) || der.length < 8 || der.length > MAX_DER_SIGNATURE_BYTES || der[0] !== 0x30) return malformed();
  const [length, start] = derLength(der, 1);
  if (start + length !== der.length) return malformed();
  const r = derInteger(der, start, der.length);
  const s = derInteger(der, r.next, der.length);
  if (s.next !== der.length) return malformed();
  const raw = new Uint8Array(64);
  raw.set(r.value, 0);
  raw.set(s.value, 32);
  return raw;
}

/** Pure. True iff: clientData.type==='webauthn.get'; clientData.challenge === b64url(challenge); clientData.origin ∈ origins;
 *  authenticatorData[0..32) === SHA-256(rpId); flags UP and UV set; ECDSA P-256/SHA-256 verifies over authenticatorData || SHA-256(clientDataJSON). Never throws.
 *  Also fails closed on crossOrigin other than absent/false and on challenges shorter than 16 bytes. The signature counter is ignored. */
export async function verifyPasskeyAssertion(input: {
  publicKey: string; rpId: string; origins: readonly string[]; challenge: Uint8Array; signature: PasskeySignature;
}): Promise<boolean> {
  try {
    const { publicKey, rpId, origins, challenge, signature } = input;
    if (!isBytes(challenge) || challenge.length < MIN_CHALLENGE_BYTES) return false;
    if (typeof rpId !== 'string' || rpId.length === 0 || !Array.isArray(origins) || !isRecord(signature)) return false;
    const authenticatorData = fromB64url(signature.authenticatorData, 37, MAX_AUTHENTICATOR_DATA_BYTES);
    const clientDataBytes = fromB64url(signature.clientDataJSON, 1, MAX_CLIENT_DATA_BYTES);
    const clientData: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientDataBytes));
    if (!isRecord(clientData)) return false;
    if (clientData.type !== 'webauthn.get') return false;
    if (typeof clientData.challenge !== 'string' || clientData.challenge !== b64url(challenge)) return false;
    if (typeof clientData.origin !== 'string' || !origins.includes(clientData.origin)) return false;
    if (clientData.crossOrigin !== undefined && clientData.crossOrigin !== false) return false;
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(rpId)));
    if (!sameBytes(authenticatorData.subarray(0, 32), rpIdHash)) return false;
    if ((authenticatorData[32] & FLAG_UP) === 0) return false;
    if ((authenticatorData[32] & FLAG_UV) === 0) return false;
    const point = fromB64url(publicKey, 65, 65);
    if (point[0] !== 0x04) return false;
    const key = await crypto.subtle.importKey('raw', point, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const raw = derToRawSignature(fromB64url(signature.signature, 8, MAX_DER_SIGNATURE_BYTES));
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes));
    const signed = new Uint8Array(authenticatorData.length + clientDataHash.length);
    signed.set(authenticatorData, 0);
    signed.set(clientDataHash, authenticatorData.length);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, signed) === true;
  } catch {
    return false;
  }
}
