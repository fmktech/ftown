import { authorityConsentChallenge, ledgerChallenge, signInChallenge } from '@security/ledger/ledger';
import type { LedgerGenesis, LedgerTransition, PasskeySignature, Signed } from '@security/ledger/protocol';

/*
 * Browser WebAuthn ceremonies for the passkey ledger. There is deliberately no generic "sign these bytes" export:
 * a passkey only ever signs a ledger record (domain ledgerChallenge) or a local identification nonce (domain signInChallenge).
 */

const ES256 = -7;
const CEREMONY_TIMEOUT_MS = 120000;
// SubjectPublicKeyInfo header of an uncompressed P-256 key: SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING }.
const P256_SPKI_PREFIX = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  0x03, 0x42, 0x00,
];
const SPKI_LENGTH = P256_SPKI_PREFIX.length + 65;

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function passkeySupported(): boolean {
  return globalThis.isSecureContext === true
    && typeof globalThis.PublicKeyCredential !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.credentials !== 'undefined';
}

function requireCeremony(): CredentialsContainer {
  if (globalThis.isSecureContext !== true || typeof crypto === 'undefined' || typeof crypto.subtle === 'undefined') {
    throw new Error('secure_context_required');
  }
  if (typeof navigator === 'undefined' || typeof navigator.credentials === 'undefined') throw new Error('passkey_unsupported');
  // Passkey ceremonies never run inside an iframe (clickjacking of the approval prompt).
  if (typeof window !== 'undefined' && window.self !== window.top) throw new Error('passkey_embedded');
  return navigator.credentials;
}

async function ceremony<T>(run: () => Promise<T | null>): Promise<T> {
  let result: T | null;
  try {
    result = await run();
  } catch (error) {
    const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
    if (name === 'NotAllowedError') throw new Error('passkey_cancelled');
    if (name === 'InvalidStateError') throw new Error('passkey_already_registered');
    throw error;
  }
  if (result === null) throw new Error('passkey_cancelled');
  return result;
}

/** SPKI to the raw 65-byte uncompressed P-256 point. Anything that is not a valid P-256 key throws. */
async function rawP256FromSpki(spki: ArrayBuffer | null): Promise<Uint8Array> {
  if (spki === null) throw new Error('passkey_key_unavailable');
  const bytes = new Uint8Array(spki);
  if (bytes.length !== SPKI_LENGTH || P256_SPKI_PREFIX.some((byte, index) => bytes[index] !== byte)) throw new Error('passkey_not_p256');
  // Let the platform prove the point is on the curve.
  let raw: Uint8Array;
  try {
    const key = await crypto.subtle.importKey('spki', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  } catch {
    throw new Error('passkey_not_p256');
  }
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('passkey_not_p256');
  return raw;
}

/** Returns only the credential; the caller builds the LedgerAuthority (label, addedAt from the record's own time).
 *  `excludeCredentialIds` must list every known authority: authenticators key passkeys by (rpId, userHandle), so a second
 *  create on the same keychain would otherwise overwrite the first. */
export async function createPasskey(input: {
  rpId: string; rpName: string; handle: Uint8Array; userName: string; excludeCredentialIds?: string[];
}): Promise<{ credentialId: string; publicKey: string }> {
  const credentials = requireCeremony();
  const options: PublicKeyCredentialCreationOptions = {
    rp: { id: input.rpId, name: input.rpName },
    user: { id: input.handle as BufferSource, name: input.userName, displayName: input.userName },
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: (input.excludeCredentialIds ?? []).map(id => ({ type: 'public-key' as const, id: fromB64url(id) })),
    attestation: 'none',
    timeout: CEREMONY_TIMEOUT_MS,
  };
  const credential = await ceremony(() => credentials.create({ publicKey: options })) as PublicKeyCredential;
  const response = credential.response as AuthenticatorAttestationResponse;
  if (typeof response.getPublicKeyAlgorithm === 'function' && response.getPublicKeyAlgorithm() !== ES256) throw new Error('passkey_not_p256');
  if (typeof response.getPublicKey !== 'function') throw new Error('passkey_key_unavailable');
  const publicKey = await rawP256FromSpki(response.getPublicKey());
  return { credentialId: b64url(credential.rawId), publicKey: b64url(publicKey) };
}

function toPasskeySignature(response: AuthenticatorAssertionResponse): PasskeySignature {
  return {
    authenticatorData: b64url(response.authenticatorData),
    clientDataJSON: b64url(response.clientDataJSON),
    signature: b64url(response.signature),
  };
}

export async function signLedgerRecord<T extends LedgerGenesis | LedgerTransition>(
  payload: T, options: { rpId: string; credentialId?: string; allowCredentialIds?: string[] },
): Promise<Signed<T>> {
  const expected = payload.type === 'ftown_account_genesis' ? payload.authority.credentialId : payload.credentialId;
  if (options.credentialId !== undefined && options.credentialId !== expected) throw new Error('passkey_wrong_credential');
  const credentials = requireCeremony();
  const request: PublicKeyCredentialRequestOptions = {
    challenge: await ledgerChallenge(payload),
    rpId: options.rpId,
    allowCredentials: (options.allowCredentialIds ?? [expected]).map(id => ({ type: 'public-key' as const, id: fromB64url(id) })),
    userVerification: 'required',
    timeout: CEREMONY_TIMEOUT_MS,
  };
  const credential = await ceremony(() => credentials.get({ publicKey: request })) as PublicKeyCredential;
  if (b64url(credential.rawId) !== expected) throw new Error('passkey_wrong_credential');
  return { payload, signature: toPasskeySignature(credential.response as AuthenticatorAssertionResponse) };
}

/** Discoverable-credential assertion over a throwaway nonce, only to learn which account's passkey the user picked. */
export async function identifyPasskey(options: { rpId: string; allowCredentialIds?: string[] }): Promise<{ credentialId: string; handle: string }> {
  const credentials = requireCeremony();
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const request: PublicKeyCredentialRequestOptions = {
    challenge: await signInChallenge(nonce),
    rpId: options.rpId,
    userVerification: 'required',
    timeout: CEREMONY_TIMEOUT_MS,
  };
  if (options.allowCredentialIds !== undefined && options.allowCredentialIds.length > 0) {
    request.allowCredentials = options.allowCredentialIds.map(id => ({ type: 'public-key' as const, id: fromB64url(id) }));
  }
  const credential = await ceremony(() => credentials.get({ publicKey: request })) as PublicKeyCredential;
  const { userHandle } = credential.response as AuthenticatorAssertionResponse;
  if (userHandle === null || userHandle === undefined || userHandle.byteLength === 0) throw new Error('passkey_no_handle');
  return { credentialId: b64url(credential.rawId), handle: b64url(userHandle) };
}

/** The consent a passkey gives to being added as an authority of `accountId`: a get() restricted to that credential. */
export async function signAuthorityConsent(input: {
  accountId: string; authority: { credentialId: string; publicKey: string }; rpId: string;
}): Promise<PasskeySignature> {
  const credentials = requireCeremony();
  const request: PublicKeyCredentialRequestOptions = {
    challenge: await authorityConsentChallenge(input.accountId, input.authority),
    rpId: input.rpId,
    allowCredentials: [{ type: 'public-key', id: fromB64url(input.authority.credentialId) }],
    userVerification: 'required',
    timeout: CEREMONY_TIMEOUT_MS,
  };
  const credential = await ceremony(() => credentials.get({ publicKey: request })) as PublicKeyCredential;
  if (b64url(credential.rawId) !== input.authority.credentialId) throw new Error('passkey_wrong_credential');
  return toPasskeySignature(credential.response as AuthenticatorAssertionResponse);
}
