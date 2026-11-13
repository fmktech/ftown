import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import type {
  EndpointIdentity, EndpointKind, EndpointPublic, EnvelopeHeader, EnvelopePurpose,
  OpenContext, SecureEnvelope, SecurePublication, SecurityErrorCode, SecurityFailure,
} from './protocol.js';

/** Wire limits apply to serialized UTF-8, including headers and base64 expansion. */
export const MAX_ENVELOPE_BYTES = 450_000;
const MAX_RECIPIENTS = 100;
const encoder = new TextEncoder();
const domain = encoder.encode('ftown/e2ee/v1');
const kinds: readonly EndpointKind[] = ['bridge', 'browser', 'local-cli'];
const purposes: readonly EnvelopePurpose[] = ['application', 'hello', 'welcome', 'enroll', 'enrolled'];
const fields = [
  'type', 'version', 'senderId', 'recipientId', 'ownerId', 'bridgeId', 'channel',
  'purpose', 'messageId', 'createdAt', 'expiresAt', 'receiverEpoch', 'enc', 'ciphertext',
];
const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm(),
});
/** Upper bound of validated public keys kept; the least recently used one is dropped first. */
export const PUBLIC_KEY_CACHE_LIMIT = 256;
/**
 * Public keys that passed full validation, by their exact canonical base64url bytes: the SHA-256 fingerprint of those bytes and the
 * imported handle. Public material only. An entry exists only after the digest matched the claimed id AND the import succeeded, and
 * every use still compares the claimed id with the stored fingerprint. It authorizes nothing: whom to seal to or accept from is decided
 * by the caller's policy on every message; this only avoids hashing and importing the same bytes again.
 */
const validatedPublicKeys = new Map<string, { id: string; key: CryptoKey }>();
/** Raw export of an identity's own public CryptoKey (immutable once created), by key identity. Failed exports are not recorded. */
const exportedPublicKeys = new WeakMap<CryptoKey, string>();

/** A safe, stable error: underlying crypto/input details never cross this boundary. */
export class SecurityError extends Error implements SecurityFailure {
  constructor(readonly code: SecurityErrorCode, message: string, readonly retryable = false) {
    super(message);
    this.name = 'SecurityError';
  }
}
const invalid = (): never => { throw new SecurityError('invalid_envelope', 'Invalid encrypted packet'); };
const wrongContext = (): never => { throw new SecurityError('wrong_context', 'Encrypted packet targets a different context'); };
function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new SecurityError('secure_context_required', 'Encryption requires HTTPS or trustworthy localhost');
  return globalThis.crypto.subtle;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function token(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}
function owner(value: unknown): value is string {
  return typeof value === 'string' && (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    || /^solo:[A-Za-z0-9_-]{1,200}$/.test(value) || /^[A-Za-z0-9_-]{43}$/.test(value));
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function bytes(value: unknown, min: number, max = min): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
  let binary: string;
  try { binary = atob(value.replaceAll('-', '+').replaceAll('_', '/')); } catch { return invalid(); }
  if (binary.length < min || binary.length > max) return invalid();
  const result = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (base64(result) !== value) return invalid();
  return result;
}
function fingerprintSyntax(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 43) return false;
  try { bytes(value, 32); return true; } catch { return false; }
}
function header(value: unknown): EnvelopeHeader {
  if (!object(value)) return invalid();
  if (value.type !== 'ftown_encrypted' || value.version !== 1
    || !fingerprintSyntax(value.senderId) || !fingerprintSyntax(value.recipientId)
    || !owner(value.ownerId) || !token(value.bridgeId)
    || typeof value.channel !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(value.channel)
    || typeof value.purpose !== 'string' || !purposes.some(purpose => purpose === value.purpose)
    || !token(value.messageId, 128) || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)
    || typeof value.createdAt !== 'number' || typeof value.expiresAt !== 'number'
    || value.createdAt < 0 || value.expiresAt <= value.createdAt
    || (value.receiverEpoch !== null && !token(value.receiverEpoch, 128))) return invalid();
  // Avoid coercing untrusted values or retaining attacker-owned objects.
  const purpose = purposes.find(candidate => candidate === value.purpose);
  if (!purpose) return invalid();
  return {
    type: 'ftown_encrypted', version: 1, senderId: value.senderId, recipientId: value.recipientId,
    ownerId: value.ownerId, bridgeId: value.bridgeId, channel: value.channel, purpose,
    messageId: value.messageId, createdAt: value.createdAt, expiresAt: value.expiresAt,
    receiverEpoch: value.receiverEpoch,
  };
}
/** One ordered tuple; property insertion order on received objects is irrelevant. */
function aad(value: EnvelopeHeader): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify([
    'ftown/e2ee/v1', value.type, value.version, value.senderId, value.recipientId,
    value.ownerId, value.bridgeId, value.channel, value.purpose, value.messageId,
    value.createdAt, value.expiresAt, value.receiverEpoch,
  ]));
}
function serializedSize(value: unknown): number {
  try { return encoder.encode(JSON.stringify(value)).byteLength; } catch { return invalid(); }
}
export function parseSecureEnvelope(value: unknown): SecureEnvelope {
  if (!object(value)) return invalid();
  exact(value, fields);
  const parsed = header(value);
  // Reject oversized strings before decoding/allocating their binary contents.
  const enc = bytes(value.enc, 65);
  if (enc[0] !== 4) return invalid();
  bytes(value.ciphertext, 16, MAX_ENVELOPE_BYTES);
  if (serializedSize(value) > MAX_ENVELOPE_BYTES || typeof value.enc !== 'string' || typeof value.ciphertext !== 'string') return invalid();
  return { ...parsed, enc: value.enc, ciphertext: value.ciphertext };
}
export function parseSecurePublication(value: unknown): SecurePublication {
  if (!object(value)) return invalid();
  exact(value, ['type', 'version', 'envelopes']);
  if (value.type !== 'ftown_encrypted_batch' || value.version !== 1 || !Array.isArray(value.envelopes)
    || value.envelopes.length < 1 || value.envelopes.length > MAX_RECIPIENTS
    || serializedSize(value) > MAX_ENVELOPE_BYTES) return invalid();
  return { type: 'ftown_encrypted_batch', version: 1, envelopes: value.envelopes.map(parseSecureEnvelope) };
}
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  try {
    if (key.type !== 'public' || key.algorithm.name !== 'ECDH' || !('namedCurve' in key.algorithm) || key.algorithm.namedCurve !== 'P-256') return invalid();
    const raw = new Uint8Array(await subtle().exportKey('raw', key));
    if (raw.length !== 65 || raw[0] !== 4) return invalid();
    return base64(raw);
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw new SecurityError('key_unavailable', 'Encryption public key is unavailable');
  }
}
export async function importPublicKey(raw: string): Promise<CryptoKey> {
  const decoded = bytes(raw, 65);
  if (decoded[0] !== 4) return invalid();
  try { return await subtle().importKey('raw', decoded, { name: 'ECDH', namedCurve: 'P-256' }, true, []); }
  catch (error) {
    if (error instanceof SecurityError) throw error;
    return invalid();
  }
}
async function endpointKey(endpoint: EndpointPublic): Promise<CryptoKey> {
  if (!object(endpoint)) return invalid();
  exact(endpoint, ['version', 'id', 'ownerId', 'kind', 'publicKey']);
  if (endpoint.version !== 1 || !owner(endpoint.ownerId) || !kinds.includes(endpoint.kind) || !fingerprintSyntax(endpoint.id)) return invalid();
  const raw = bytes(endpoint.publicKey, 65);
  const known = validatedPublicKeys.get(endpoint.publicKey);
  if (known) {
    if (known.id !== endpoint.id) return invalid();
    validatedPublicKeys.delete(endpoint.publicKey);
    validatedPublicKeys.set(endpoint.publicKey, known);
    return known.key;
  }
  const digest = base64(new Uint8Array(await subtle().digest('SHA-256', raw)));
  if (digest !== endpoint.id) return invalid();
  const key = await importPublicKey(endpoint.publicKey);
  validatedPublicKeys.set(endpoint.publicKey, { id: digest, key });
  for (const oldest of validatedPublicKeys.keys()) {
    if (validatedPublicKeys.size <= PUBLIC_KEY_CACHE_LIMIT) break;
    validatedPublicKeys.delete(oldest);
  }
  return key;
}
async function ownPublicKey(key: CryptoKey): Promise<string> {
  const known = exportedPublicKeys.get(key);
  if (known !== undefined) return known;
  const exported = await exportPublicKey(key);
  exportedPublicKeys.set(key, exported);
  return exported;
}
async function validateIdentity(identity: EndpointIdentity): Promise<void> {
  await endpointKey(identity.endpoint);
  if (await ownPublicKey(identity.keyPair.publicKey) !== identity.endpoint.publicKey
    || identity.keyPair.privateKey.type !== 'private' || identity.keyPair.privateKey.algorithm.name !== 'ECDH'
    || !('namedCurve' in identity.keyPair.privateKey.algorithm) || identity.keyPair.privateKey.algorithm.namedCurve !== 'P-256'
    || !identity.keyPair.privateKey.usages.includes('deriveBits')) return invalid();
}
export async function generateEndpoint(ownerId: string, kind: EndpointKind, extractable = false): Promise<EndpointIdentity> {
  if (!owner(ownerId) || !kinds.includes(kind)) return invalid();
  try {
    const keyPair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveBits']);
    const publicKey = await exportPublicKey(keyPair.publicKey);
    const id = base64(new Uint8Array(await subtle().digest('SHA-256', bytes(publicKey, 65))));
    return { endpoint: { version: 1, id, ownerId, kind, publicKey }, keyPair };
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw new SecurityError('key_unavailable', 'Encryption identity could not be created');
  }
}
export async function importEndpoint(endpoint: EndpointPublic, privateKey: JsonWebKey, extractable = false): Promise<EndpointIdentity> {
  const publicKey = await endpointKey(endpoint);
  try {
    // Check the JWK's public coordinates against the independently pinned point.
    const publicJwk = await subtle().exportKey('jwk', publicKey);
    if (privateKey.kty !== 'EC' || privateKey.crv !== 'P-256' || !privateKey.d
      || privateKey.x !== publicJwk.x || privateKey.y !== publicJwk.y) return invalid();
    const imported = await subtle().importKey('jwk', privateKey, { name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveBits']);
    const identity = { endpoint: { ...endpoint }, keyPair: { publicKey, privateKey: imported } };
    // WebCrypto imports may trust supplied public coordinates. Prove private/public correspondence.
    const challenge = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const left = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: challenge.publicKey }, imported, 256));
    const right = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: publicKey }, challenge.privateKey, 256));
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
    if (difference !== 0) return invalid();
    return identity;
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw new SecurityError('key_unavailable', 'Encryption identity could not be loaded');
  }
}
function contextMatches(value: EnvelopeHeader, expected: OpenContext): void {
  if (value.ownerId !== expected.ownerId || value.bridgeId !== expected.bridgeId || value.channel !== expected.channel
    || value.recipientId !== expected.recipientId || value.purpose !== expected.purpose) return wrongContext();
}
export async function seal(identity: EndpointIdentity, recipient: EndpointPublic, input: EnvelopeHeader, plaintext: Uint8Array): Promise<SecureEnvelope> {
  const parsed = header(input);
  await validateIdentity(identity);
  const recipientPublicKey = await endpointKey(recipient);
  if (parsed.senderId !== identity.endpoint.id || parsed.recipientId !== recipient.id
    || parsed.ownerId !== identity.endpoint.ownerId || parsed.ownerId !== recipient.ownerId) return wrongContext();
  // Base64 expands the AEAD tag and plaintext; account for exact header overhead before encrypting.
  const overhead = serializedSize({ ...parsed, enc: 'A'.repeat(87), ciphertext: '' });
  if (overhead + Math.ceil((plaintext.byteLength + 16) * 4 / 3) > MAX_ENVELOPE_BYTES) throw new SecurityError('capacity_exceeded', 'Encrypted packet exceeds the transport limit');
  try {
    const sender = await suite.createSenderContext({ recipientPublicKey, senderKey: identity.keyPair, info: domain });
    const enc = new Uint8Array(sender.enc);
    const ciphertext = new Uint8Array(await sender.seal(plaintext, aad(parsed)));
    // The header was validated above and the size bounded before encrypting, so the only parts of this envelope not yet checked are
    // the two HPKE outputs. These are the properties parseSecureEnvelope requires of them, without decoding the envelope again.
    if (enc.length !== 65 || enc[0] !== 4 || ciphertext.length !== plaintext.byteLength + 16) return invalid();
    return { ...parsed, enc: base64(enc), ciphertext: base64(ciphertext) };
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw new SecurityError('authentication_failed', 'Encrypted packet could not be sealed');
  }
}
export async function open(identity: EndpointIdentity, sender: EndpointPublic, value: SecureEnvelope, expected: OpenContext): Promise<Uint8Array> {
  const envelope = parseSecureEnvelope(value);
  contextMatches(envelope, expected);
  await validateIdentity(identity);
  const senderPublicKey = await endpointKey(sender);
  if (envelope.recipientId !== identity.endpoint.id || envelope.senderId !== sender.id
    || envelope.ownerId !== identity.endpoint.ownerId || envelope.ownerId !== sender.ownerId) return wrongContext();
  try {
    const recipient = await suite.createRecipientContext({ recipientKey: identity.keyPair, senderPublicKey, enc: bytes(envelope.enc, 65), info: domain });
    return new Uint8Array(await recipient.open(bytes(envelope.ciphertext, 16, MAX_ENVELOPE_BYTES), aad(envelope)));
  } catch {
    throw new SecurityError('authentication_failed', 'Encrypted packet authentication failed');
  }
}
