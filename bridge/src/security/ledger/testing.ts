/*
 * TEST-ONLY software WebAuthn authenticator. Never import from production code: it holds an ES256 key in
 * memory and signs whatever it is given, with no user presence or verification behind its flags.
 */
import type { PasskeySignature } from './protocol.js';

export interface SoftPasskeySignOptions {
  origin?: string;
  rpId?: string;
  /** false clears, true sets, the UV bit on top of `flags`. */
  uv?: boolean;
  /** false clears, true sets, the UP bit on top of `flags`. */
  up?: boolean;
  type?: string;
  crossOrigin?: boolean;
  /** authenticatorData flags byte. Defaults to 0x1D (UP|UV|BE|BS), as synced Apple and Google passkeys emit. */
  flags?: number;
  /** Big-endian uint32 signature counter. Defaults to 0. */
  signCount?: number;
}

/** Byte-faithful assertions: authenticatorData = rpIdHash | flags | signCount, browser-style clientDataJSON, DER signature. */
export interface SoftPasskey {
  credentialId: string;
  publicKey: string;
  sign(challenge: Uint8Array, options?: SoftPasskeySignOptions): Promise<PasskeySignature>;
}

const encoder = new TextEncoder();
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const DEFAULT_FLAGS = 0x1d;

function b64url(data: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < data.length; index += 1) binary += String.fromCharCode(data[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function derInteger(value: Uint8Array): number[] {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const body: number[] = [];
  if ((value[start] & 0x80) !== 0) body.push(0);
  for (let index = start; index < value.length; index += 1) body.push(value[index]);
  return [0x02, body.length].concat(body);
}
function withBit(flags: number, bit: number, value: boolean | undefined): number {
  if (value === true) return flags | bit;
  if (value === false) return flags & ~bit & 0xff;
  return flags;
}

/** 64-byte r||s to a minimal DER SEQUENCE of two INTEGERs. */
export function rawToDerSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  if (raw.length !== 64) throw new Error('Raw P-256 signature must be 64 bytes');
  const content = derInteger(raw.subarray(0, 32)).concat(derInteger(raw.subarray(32, 64)));
  return new Uint8Array([0x30, content.length].concat(content));
}

export async function createSoftPasskey(defaults: { rpId: string; origin: string }): Promise<SoftPasskey> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)));
  const credentialId = b64url(crypto.getRandomValues(new Uint8Array(32)));
  async function sign(challenge: Uint8Array, options: SoftPasskeySignOptions = {}): Promise<PasskeySignature> {
    const baseFlags = options.flags ?? DEFAULT_FLAGS;
    const signCount = options.signCount ?? 0;
    if (!Number.isInteger(baseFlags) || baseFlags < 0 || baseFlags > 0xff) throw new Error('flags must be one byte');
    if (!Number.isInteger(signCount) || signCount < 0 || signCount > 0xffffffff) throw new Error('signCount must be a uint32');
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(options.rpId ?? defaults.rpId)));
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(rpIdHash, 0);
    authenticatorData[32] = withBit(withBit(baseFlags, FLAG_UP, options.up), FLAG_UV, options.uv);
    authenticatorData[33] = (signCount >>> 24) & 0xff;
    authenticatorData[34] = (signCount >>> 16) & 0xff;
    authenticatorData[35] = (signCount >>> 8) & 0xff;
    authenticatorData[36] = signCount & 0xff;
    const clientDataJSON = encoder.encode(JSON.stringify({
      type: options.type ?? 'webauthn.get',
      challenge: b64url(challenge),
      origin: options.origin ?? defaults.origin,
      crossOrigin: options.crossOrigin ?? false,
    }));
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
    const signed = new Uint8Array(authenticatorData.length + clientDataHash.length);
    signed.set(authenticatorData, 0);
    signed.set(clientDataHash, authenticatorData.length);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signed));
    return { authenticatorData: b64url(authenticatorData), clientDataJSON: b64url(clientDataJSON), signature: b64url(rawToDerSignature(raw)) };
  }
  return { credentialId, publicKey, sign };
}
