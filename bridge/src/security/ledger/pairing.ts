/*
 * Bridge pairing by link (DESIGN 3.3; contract "Decision 2026-11-09"). The bridge prints `https://<origin>/pair#req=<encodePairLink(link)>`;
 * the secret lives only in the fragment. A passkey holder opens it, compares the 6-digit code, signs an add_bridge built by
 * bridgeFromPairRequest, and seals {requestId, accountId, head, proof} to the bridge's endpoint key, where proof is an HMAC of the
 * secret over accountId, head and requestId. The bridge opens it (openPairApproval), fetches the ledger from the server, and accepts
 * it only through confirmPairedLedger: verified from genesis, of exactly that account, containing the approved head, and adding this
 * request's bridge at or before that head, never revoked since.
 * ES2017 and WebCrypto only: this file is also compiled by the UI.
 */
import { open, parseSecureEnvelope, seal, SecurityError } from '../crypto.js';
import type { EndpointIdentity, EndpointKind, EndpointPublic, EnvelopeHeader, SecureEnvelope } from '../protocol.js';
import { accountIdOf, applyRevocations, ledgerHead, ledgerRevocations, parseLedger, verifyLedger } from './ledger.js';
import { LEDGER_LIMITS } from './protocol.js';
import type { Ledger, LedgerBridge, LedgerCheckpoint } from './protocol.js';

export interface BridgePairRequest {
  version: 2;
  /** 32 random bytes, base64url. */
  requestId: string;
  bridgeId: string;
  /** Raw uncompressed ECDH P-256 point, 65 bytes, base64url. */
  endpointPublicKey: string;
  /** Raw uncompressed ECDSA P-256 point, 65 bytes, base64url. */
  authPublicKey: string;
  label: string;
  expiresAt: number;
}
export interface BridgePairLink {
  request: BridgePairRequest;
  /** 32 random bytes, base64url. Fragment only: it never reaches the server. */
  secret: string;
}
export interface BridgePairRequestInput {
  bridgeId: string;
  endpointPublicKey: string;
  authPublicKey: string;
  label: string;
  now?: number;
  lifetimeMs?: number;
}
/** What the secret holder approved: the account and the ledger head at approval time. */
export interface PairApproval {
  accountId: string;
  head: string;
}
/** Revocations a replica has seen in any verified chain of the account (see ledgerRevocations / applyRevocations). */
export interface PairStickyRevocations {
  deviceIds: string[];
  bridgeIds: string[];
}

/** Default and maximum lifetime of a pairing request. */
export const PAIR_LIFETIME_MS = 600000;
/** Fragment prefix of the pairing URL; parsePairLink accepts the value with or without it. */
export const PAIR_FRAGMENT_PREFIX = '#req=';

const LINK_ERROR = 'invalid_pair_link';
const APPROVAL_ERROR = 'invalid_pair_approval';
const SECURE_CONTEXT_ERROR = 'secure_context_required';
const CODE_DOMAIN = 'ftown-pair-code-v2\n';
const PROOF_DOMAIN = 'ftown-pair-proof-v2\n';
const CHANNEL_PREFIX = 'ftown-pair:';
const MAX_TIME = 253402300799999;
const MAX_LINK_BYTES = 2048;
const MAX_LINK_CHARS = Math.ceil(MAX_LINK_BYTES * 4 / 3);
/** The sealed bundle is a few hundred bytes; the HPKE envelope and sender endpoint stay far below this bound. */
const MAX_SEALED_CHARS = 8192;
const REQUEST_KEYS = ['version', 'requestId', 'bridgeId', 'endpointPublicKey', 'authPublicKey', 'label', 'expiresAt'];
const BUNDLE_KEYS = ['version', 'requestId', 'accountId', 'head', 'proof'];
const ENDPOINT_KINDS: readonly EndpointKind[] = ['bridge', 'browser', 'local-cli'];
const encoder = new TextEncoder();

/** Internal only: every public function catches it and throws its own stable Error message instead. */
function malformed(): never {
  throw new Error('malformed');
}
function linkError(): Error {
  return new Error(LINK_ERROR);
}
function approvalError(): Error {
  return new Error(APPROVAL_ERROR);
}
/** WebCrypto's subtle API exists only in secure contexts (HTTPS or localhost); http LAN pages must say so, not "invalid link". */
function requireSecureContext(): void {
  if (typeof crypto === 'undefined' || !crypto || !crypto.subtle) throw new Error(SECURE_CONTEXT_ERROR);
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlain(value)) return malformed();
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some(key => keys.indexOf(key) === -1)) return malformed();
  return value;
}
function b64url(data: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < data.length; index += 1) binary += String.fromCharCode(data[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Canonical unpadded base64url only; the length bound is checked before decoding. */
function decode(value: unknown, min: number, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return malformed();
  let binary: string;
  try { binary = atob(value.replace(/-/g, '+').replace(/_/g, '/')); } catch { return malformed(); }
  if (binary.length < min || binary.length > max) return malformed();
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  if (b64url(result) !== value) return malformed();
  return result;
}
const fingerprint = (value: unknown): string => b64url(decode(value, 32, 32));
function point(value: unknown): string {
  const raw = decode(value, 65, 65);
  return raw[0] === 4 ? b64url(raw) : malformed();
}
function token(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : malformed();
}
/** Same rule as the ledger's labels: at most 200 UTF-16 units; no C0/C1 controls, zero-width or bidi controls, BOM, unpaired surrogates. */
function label(value: unknown): string {
  if (typeof value !== 'string' || value.length > LEDGER_LIMITS.maxLabelLength) return malformed();
  return /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\ud800-\udfff]/u.test(value) ? malformed() : value;
}
function time(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME ? value : malformed();
}
function random(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : malformed();
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return `[${items.map(canonical).join(',')}]`;
  }
  if (!isPlain(value)) return malformed();
  const record = value;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

/** Strict request shape; returns a rebuilt copy that shares nothing with the input. */
function requestShape(value: unknown): BridgePairRequest {
  const record = exact(value, REQUEST_KEYS);
  if (record.version !== 2) return malformed();
  const request: BridgePairRequest = {
    version: 2, requestId: fingerprint(record.requestId), bridgeId: token(record.bridgeId),
    endpointPublicKey: point(record.endpointPublicKey), authPublicKey: point(record.authPublicKey),
    label: label(record.label), expiresAt: time(record.expiresAt),
  };
  // The ledger refuses a member whose two keys are equal; such a request could never be approved.
  return request.endpointPublicKey === request.authPublicKey ? malformed() : request;
}
function linkShape(value: unknown): BridgePairLink {
  const record = exact(value, ['request', 'secret']);
  return { request: requestShape(record.request), secret: fingerprint(record.secret) };
}
function approvalShape(value: unknown): PairApproval {
  const record = exact(value, ['accountId', 'head']);
  return { accountId: fingerprint(record.accountId), head: fingerprint(record.head) };
}

/** The bridge's endpoint once it belongs to `accountId`: the exact value the add_bridge must carry. */
async function bridgeEndpoint(request: BridgePairRequest, accountId: string): Promise<EndpointPublic> {
  const id = b64url(await sha256(decode(request.endpointPublicKey, 65, 65)));
  return { version: 1, id, ownerId: fingerprint(accountId), kind: 'bridge', publicKey: request.endpointPublicKey };
}
function channelOf(request: BridgePairRequest): string {
  return CHANNEL_PREFIX + request.requestId;
}
/** HMAC-SHA256(secret, PROOF_DOMAIN + accountId + '\n' + head + '\n' + requestId). */
async function secretProof(secret: string, accountId: string, head: string, requestId: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', decode(secret, 32, 32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = encoder.encode(PROOF_DOMAIN + accountId + '\n' + head + '\n' + requestId);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
}
/**
 * The ledger checks shared by both sides, on a ledger that already verified into `checkpoint`. Returns the endpoint to seal to.
 * - The ledger is the approved account's (genesis hash equals approval.accountId).
 * - The chain contains approval.head (genesis or any transition); it may have grown since.
 * - This request's bridge (bridgeId, endpoint id = SHA-256(endpointPublicKey), authPublicKey) is a POSITIVE member of the trusted
 *   roster: the final checkpoint minus every sticky revocation, so a bridge revoked in any chain this replica saw never pairs.
 *   (verifyLedger already bound endpoint id to its key, owner to the account and kind to 'bridge'.)
 * - Its add_bridge does not come after approval.head.
 */
async function confirmVerified(
  request: BridgePairRequest, approval: PairApproval, ledger: Ledger, checkpoint: LedgerCheckpoint, sticky: PairStickyRevocations,
): Promise<EndpointPublic> {
  const accountId = await accountIdOf(ledger.genesis.payload);
  if (accountId !== approval.accountId) return malformed();
  // heads[0] is the genesis head; heads[i + 1] is the head of transitions[i]. Heads are unique within one chain.
  const heads = [accountId];
  for (const record of ledger.transitions) heads.push(await ledgerHead(record.payload));
  if (heads.indexOf(approval.head) === -1) return malformed();
  const expected = await bridgeEndpoint(request, accountId);
  const trusted = applyRevocations(checkpoint, sticky).bridges;
  if (!trusted.some(item => item.bridgeId === request.bridgeId && item.endpoint.id === expected.id
    && item.authPublicKey === request.authPublicKey)) return malformed();
  // Index of the add_bridge; a roster member always has one (an absent one would count as after every head).
  let addedAt = ledger.transitions.length;
  for (let index = ledger.transitions.length - 1; index >= 0; index -= 1) {
    const operation = ledger.transitions[index].payload.operation;
    if (operation.type === 'add_bridge' && operation.bridge.bridgeId === request.bridgeId) addedAt = index;
  }
  // The approval must not predate the add_bridge: approval.head is not among the heads up to the record before it.
  if (heads.slice(0, addedAt + 1).indexOf(approval.head) !== -1) return malformed();
  return expected;
}
function senderShape(value: unknown): EndpointPublic {
  const record = exact(value, ['version', 'id', 'ownerId', 'kind', 'publicKey']);
  const kind = ENDPOINT_KINDS.filter(item => item === record.kind)[0];
  if (record.version !== 1 || kind === undefined || typeof record.ownerId !== 'string') return malformed();
  // seal/open re-check the owner syntax and id = SHA-256(publicKey).
  return { version: 1, id: fingerprint(record.id), ownerId: record.ownerId, kind, publicKey: point(record.publicKey) };
}
function sealedShape(value: unknown): { sender: EndpointPublic; envelope: SecureEnvelope } {
  if (typeof value !== 'string' || value.length > MAX_SEALED_CHARS) return malformed();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return malformed(); }
  const record = exact(parsed, ['version', 'sender', 'envelope']);
  if (record.version !== 2) return malformed();
  return { sender: senderShape(record.sender), envelope: parseSecureEnvelope(record.envelope) };
}

/** A fresh request for this bridge, with a random requestId and secret. Throws Error('invalid_pair_link') on invalid input. */
export function createBridgePairRequest(input: BridgePairRequestInput): BridgePairLink {
  try {
    const now = input.now === undefined ? Date.now() : time(input.now);
    const lifetime = input.lifetimeMs === undefined ? PAIR_LIFETIME_MS : input.lifetimeMs;
    if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > PAIR_LIFETIME_MS) return malformed();
    return linkShape({
      request: {
        version: 2, requestId: random(), bridgeId: input.bridgeId, endpointPublicKey: input.endpointPublicKey,
        authPublicKey: input.authPublicKey, label: input.label, expiresAt: now + lifetime,
      },
      secret: random(),
    });
  } catch {
    throw linkError();
  }
}

/** The approving browser's add_bridge payload. Throws Error('secure_context_required') without WebCrypto, Error('invalid_pair_link') on invalid input. */
export async function bridgeFromPairRequest(request: BridgePairRequest, accountId: string, approvedAt: number): Promise<LedgerBridge> {
  requireSecureContext();
  try {
    const parsed = requestShape(request);
    return {
      bridgeId: parsed.bridgeId, endpoint: await bridgeEndpoint(parsed, accountId), authPublicKey: parsed.authPublicKey,
      label: parsed.label, approvedAt: time(approvedAt),
    };
  } catch {
    throw linkError();
  }
}

/** Compact base64url JSON of the link: the fragment value after PAIR_FRAGMENT_PREFIX. Throws Error('invalid_pair_link'). */
export function encodePairLink(link: BridgePairLink): string {
  try {
    const data = encoder.encode(JSON.stringify(linkShape(link)));
    return data.byteLength > MAX_LINK_BYTES ? malformed() : b64url(data);
  } catch {
    throw linkError();
  }
}

/** Strict parse of the fragment, with or without the leading '#req='. Does not check expiry. Throws Error('invalid_pair_link'). */
export function parsePairLink(fragment: string): BridgePairLink {
  try {
    if (typeof fragment !== 'string') return malformed();
    const text = fragment.indexOf(PAIR_FRAGMENT_PREFIX) === 0 ? fragment.slice(PAIR_FRAGMENT_PREFIX.length) : fragment;
    if (text.length > MAX_LINK_CHARS) return malformed();
    const data = decode(text, 1, MAX_LINK_BYTES);
    return linkShape(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)));
  } catch {
    throw linkError();
  }
}

/**
 * Six decimal digits, shown by the bridge and by the approving page: SHA-256(UTF-8('ftown-pair-code-v2\n' + canonical(request))),
 * first 4 bytes as a big-endian uint32, mod 10^6, zero-padded. Bias: 2^32 = 4294 * 10^6 + 967296, so codes below 967296 occur with
 * probability 4295/2^32 and the rest 4294/2^32, a relative skew of 1/4294 (about 0.02%), negligible for a human comparison.
 * Throws Error('secure_context_required') without WebCrypto, Error('invalid_pair_link') on a malformed request.
 */
export async function pairComparisonCode(request: BridgePairRequest): Promise<string> {
  requireSecureContext();
  let message: Uint8Array<ArrayBuffer>;
  try {
    message = encoder.encode(CODE_DOMAIN + canonical(requestShape(request)));
  } catch {
    throw linkError();
  }
  const digest = await sha256(message);
  const value = digest[0] * 16777216 + digest[1] * 65536 + digest[2] * 256 + digest[3];
  const code = String(value % 1000000);
  return '000000'.slice(code.length) + code;
}

/**
 * Browser side. Verifies the ledger and runs the same checks as confirmPairedLedger at its last head, then seals
 * {version:2, requestId, accountId, head, proof} (no ledger) to the bridge's endpoint key, authenticated by `sender`.
 * Returns the opaque string stored in the pair mailbox. Throws Error('secure_context_required') without WebCrypto,
 * Error('invalid_pair_link') for a malformed or expired link, SecurityError from crypto.ts as is, else Error('invalid_pair_approval').
 */
export async function sealPairApproval(link: BridgePairLink, ledger: Ledger, sender: EndpointIdentity, now: number = Date.now()): Promise<string> {
  requireSecureContext();
  let parsed: BridgePairLink;
  let at: number;
  try {
    parsed = linkShape(link);
    at = time(now);
    // The envelope expires with the request; a request that is already due cannot be sealed.
    if (at >= parsed.request.expiresAt) return malformed();
  } catch {
    throw linkError();
  }
  try {
    const request = parsed.request;
    const verifiedLedger = parseLedger(ledger);
    const checkpoint = await verifyLedger(verifiedLedger, at);
    const approval: PairApproval = { accountId: checkpoint.accountId, head: checkpoint.head };
    const recipient = await confirmVerified(request, approval, verifiedLedger, checkpoint, ledgerRevocations(verifiedLedger));
    const proof = b64url(await secretProof(parsed.secret, approval.accountId, approval.head, request.requestId));
    // The sender only authenticates the HPKE envelope; it is rebound to the account like the recipient.
    const from: EndpointIdentity = { endpoint: { ...sender.endpoint, ownerId: approval.accountId }, keyPair: sender.keyPair };
    const header: EnvelopeHeader = {
      type: 'ftown_encrypted', version: 1, senderId: from.endpoint.id, recipientId: recipient.id, ownerId: approval.accountId,
      bridgeId: request.bridgeId, channel: channelOf(request), purpose: 'enrolled', messageId: request.requestId,
      createdAt: at, expiresAt: request.expiresAt, receiverEpoch: null,
    };
    const bundle = { version: 2, requestId: request.requestId, accountId: approval.accountId, head: approval.head, proof };
    const envelope = await seal(from, recipient, header, encoder.encode(JSON.stringify(bundle)));
    return JSON.stringify({ version: 2, sender: from.endpoint, envelope });
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw approvalError();
  }
}

/**
 * Bridge side, step 1. `identity` is the bridge's own endpoint identity (any pre-pairing ownerId; it is rebound to the account here).
 * Never trusts the sender endpoint for authorization: it only authenticates the HPKE envelope. The authority is the HMAC proof of the
 * link secret, which the server never sees, binding {accountId, head} to this request; step 2 (confirmPairedLedger) then requires a
 * passkey-signed ledger of that account and head. A server can therefore not bind this bridge to another account.
 * Throws Error('secure_context_required') without WebCrypto; every other failure throws Error('invalid_pair_approval').
 */
export async function openPairApproval(
  sealed: string, link: BridgePairLink, identity: EndpointIdentity, now: number = Date.now(),
): Promise<PairApproval> {
  requireSecureContext();
  try {
    const { request, secret } = linkShape(link);
    const at = time(now);
    if (at > request.expiresAt) return malformed();
    if (identity.endpoint.publicKey !== request.endpointPublicKey) return malformed();
    const wire = sealedShape(sealed);
    const envelope = wire.envelope;
    if (envelope.messageId !== request.requestId || envelope.receiverEpoch !== null) return malformed();
    const recipient = await bridgeEndpoint(request, envelope.ownerId);
    const data = await open({ endpoint: recipient, keyPair: identity.keyPair }, wire.sender, envelope, {
      ownerId: envelope.ownerId, bridgeId: request.bridgeId, channel: channelOf(request), recipientId: recipient.id, purpose: 'enrolled',
    });
    const bundle = exact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)), BUNDLE_KEYS);
    if (bundle.version !== 2) return malformed();
    if (bundle.requestId !== request.requestId) return malformed();
    const accountId = fingerprint(bundle.accountId);
    const head = fingerprint(bundle.head);
    if (accountId !== envelope.ownerId) return malformed();
    const proof = decode(bundle.proof, 32, 32);
    const expected = await secretProof(secret, accountId, head, request.requestId);
    if (!sameBytes(expected, proof)) return malformed();
    return { accountId, head };
  } catch {
    throw approvalError();
  }
}

/**
 * Bridge side, step 2, on the ledger fetched from the server after openPairApproval. Verifies it from genesis and requires: its
 * accountId equals approval.accountId; the chain contains approval.head (it may have grown since); this request's bridge
 * (bridgeId, endpoint id, authPublicKey) is a member of applyRevocations(checkpoint, sticky).bridges, with its add_bridge at or before
 * approval.head. `sticky` is every revocation this replica has seen for the account (default: the chain's own, ledgerRevocations).
 * Returns the RAW checkpoint of the chain (never the sticky-applied one, which must not be used as a chooseLedger cache).
 * The link's expiry is not rechecked: openPairApproval already enforced it.
 * Throws Error('secure_context_required') without WebCrypto; every other failure throws Error('invalid_pair_approval').
 */
export async function confirmPairedLedger(
  link: BridgePairLink, approval: PairApproval, ledger: Ledger, now: number = Date.now(), sticky?: PairStickyRevocations,
): Promise<LedgerCheckpoint> {
  requireSecureContext();
  try {
    const { request } = linkShape(link);
    const approved = approvalShape(approval);
    const verifiedLedger = parseLedger(ledger);
    const checkpoint = await verifyLedger(verifiedLedger, time(now));
    await confirmVerified(request, approved, verifiedLedger, checkpoint, sticky === undefined ? ledgerRevocations(verifiedLedger) : sticky);
    return checkpoint;
  } catch {
    throw approvalError();
  }
}
