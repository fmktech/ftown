import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ACCESS_KEY_BYTES,
  HUB_JWT_AUDIENCE,
  HUB_JWT_TTL_SECONDS,
  SOLO_USER_ID,
} from './contract.js';

const SHA256_HEX_LENGTH = 64;

export interface GeneratedAccessKey {
  /** Raw hex access key — returned ONCE, never persisted (S1). */
  raw: string;
  /** sha256 hex of the raw key — the only persisted form. */
  hash: string;
}

export interface MintHubJwtOptions {
  secret: string;
  ttlSeconds?: number;
  nowMs?: number;
}

export interface VerifyHubJwtOptions {
  secret: string;
  nowMs?: number;
}

export type HubJwtFailureReason =
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'bad-algorithm'
  | 'bad-audience'
  | 'wrong-subject';

export interface HubJwtVerification {
  valid: boolean;
  reason?: HubJwtFailureReason;
}

interface JwtHeader {
  alg: 'HS256';
  typ: 'JWT';
}

interface JwtPayload {
  sub: typeof SOLO_USER_ID;
  aud: typeof HUB_JWT_AUDIENCE;
  iat: number;
  exp: number;
}

export function generateAccessKey(): GeneratedAccessKey {
  const raw = randomBytes(ACCESS_KEY_BYTES).toString('hex');
  return { raw, hash: sha256Hex(raw) };
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function verifyAccessKey(presented: string, expectedHash: string): boolean {
  const presentedDigest = Buffer.from(sha256Hex(presented), 'utf8');
  const expected = Buffer.alloc(SHA256_HEX_LENGTH);
  Buffer.from(expectedHash, 'utf8').subarray(0, SHA256_HEX_LENGTH).copy(expected);
  return timingSafeEqual(presentedDigest, expected);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function hmacSha256(secret: string, signingInput: string): Buffer {
  return createHmac('sha256', secret).update(signingInput, 'utf8').digest();
}

function failure(reason: HubJwtFailureReason): HubJwtVerification {
  return { valid: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mintHubJwt(options: MintHubJwtOptions): string {
  const iat = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const header: JwtHeader = { alg: 'HS256', typ: 'JWT' };
  const payload: JwtPayload = {
    sub: SOLO_USER_ID,
    aud: HUB_JWT_AUDIENCE,
    iat,
    exp: iat + (options.ttlSeconds ?? HUB_JWT_TTL_SECONDS),
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  return `${signingInput}.${hmacSha256(options.secret, signingInput).toString('base64url')}`;
}

export function verifyHubJwt(token: string, options: VerifyHubJwtOptions): HubJwtVerification {
  const segments = token.split('.');
  if (segments.length !== 3) return failure('malformed');

  let header: unknown;
  try {
    header = JSON.parse(base64UrlDecode(segments[0]).toString('utf8')) as unknown;
  } catch {
    return failure('malformed');
  }
  if (!isRecord(header) || header['alg'] !== 'HS256') return failure('bad-algorithm');

  const expectedSignature = hmacSha256(options.secret, `${segments[0]}.${segments[1]}`);
  const provided = Buffer.alloc(expectedSignature.length);
  base64UrlDecode(segments[2]).subarray(0, expectedSignature.length).copy(provided);
  if (!timingSafeEqual(provided, expectedSignature)) return failure('bad-signature');

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(segments[1]).toString('utf8')) as unknown;
  } catch {
    return failure('malformed');
  }
  if (!isRecord(payload)) return failure('malformed');

  const exp = payload['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return failure('malformed');
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (exp <= nowSeconds) return failure('expired');

  if (payload['sub'] !== SOLO_USER_ID) return failure('wrong-subject');
  if (payload['aud'] !== HUB_JWT_AUDIENCE) return failure('bad-audience');

  return { valid: true };
}
