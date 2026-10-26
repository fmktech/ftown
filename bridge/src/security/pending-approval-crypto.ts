import { exportPublicKey, importPublicKey, open, parseSecureEnvelope, seal } from './crypto.js';
import {
  AccountTrustError, ACCOUNT_TRUST_LIMITS, openAccountApproval, parseAccountEnrollmentRequest,
  parseAccountHistory, sealAccountApproval, verifyAccountHistory,
} from './account-crypto.js';
import type {
  AccountCheckpoint, AccountEnrollmentBundle, AccountEnrollmentLink, AccountEnrollmentRequest, AccountHead,
  AccountHistory, AccountOperation, AccountSigningIdentity, SignedAccountTransition,
} from './account-protocol.js';
import type { EndpointIdentity, EndpointPublic, SecureEnvelope } from './protocol.js';
import type {
  PendingApprovalLimits, PendingApprovalState, PendingCandidateConfirmation, PendingHello, PendingHelloLocal,
  PendingOffer, PendingOfferCore, PendingOfferLocal, PendingOfferPayload, PendingOpenResult, PendingResult,
  PendingReveal, PendingReviewerAction, PendingReviewerCommand, PendingReviewerPayload, PendingSecret,
} from './pending-approval-protocol.js';

export const PENDING_APPROVAL_LIMITS = Object.freeze({
  lifetimeMs: 300000, pollIntervalMs: 2000, requestTimeoutMs: 15000,
  maxPendingPerTarget: 128, maxPendingGlobal: 4096, maxWireBytes: 65536,
  maxInboxBytes: 524288, maxFutureSkewMs: 30000,
} satisfies PendingApprovalLimits);

const encoder = new TextEncoder();
const utf8 = (value: string): Uint8Array<ArrayBuffer> => encoder.encode(value);
const invalid = (): never => { throw new AccountTrustError('account_enrollment_invalid'); };
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof AccountTrustError && error.code !== 'invalid_account_trust') throw error;
    return invalid();
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const parsed = object(value);
  const keys = Object.keys(parsed);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) return invalid();
  return parsed;
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) return invalid();
  if (typeof value === 'string') {
    if (value.length > PENDING_APPROVAL_LIMITS.maxWireBytes) throw new AccountTrustError('account_capacity_exceeded');
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new AccountTrustError('account_capacity_exceeded');
    return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  }
  const record = object(value);
  const keys = Object.keys(record).sort();
  if (keys.length > 128) throw new AccountTrustError('account_capacity_exceeded');
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(record[key], depth + 1)).join(',') + '}';
}
function wire(value: unknown): void {
  if (utf8(canonical(value)).byteLength > PENDING_APPROVAL_LIMITS.maxWireBytes) throw new AccountTrustError('account_capacity_exceeded');
}
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const signedBytes = (domain: string, value: unknown): Uint8Array<ArrayBuffer> => utf8(domain + '\n' + canonical(value));
function b64(value: Uint8Array): string {
  let text = '';
  for (const byte of value) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function bytes(value: unknown, size: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
  let decoded: string;
  try { decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/')); } catch { return invalid(); }
  const raw = Uint8Array.from(decoded, character => character.charCodeAt(0));
  if (raw.length !== size || b64(raw) !== value) return invalid();
  return raw;
}
const fingerprint = (value: unknown): string => { bytes(value, 32); return value as string; };
const signature = (value: unknown): string => { bytes(value, 64); return value as string; };
function point(value: unknown): string {
  if (bytes(value, 65)[0] !== 4) return invalid();
  return value as string;
}
function owner(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) return invalid();
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) return invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || Date.parse(value) < 0 || new Date(Date.parse(value)).toISOString() !== value) return invalid();
  return value;
}
function time(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253402300799999) return invalid();
  return now;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid();
  return value;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || value.length > ACCOUNT_TRUST_LIMITS.maxLabelLength
    || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) return invalid();
  return value;
}
function head(value: unknown): AccountHead {
  const r = exact(value, ['rootId', 'revision', 'head']);
  return { rootId: fingerprint(r.rootId), revision: integer(r.revision, ACCOUNT_TRUST_LIMITS.maxTransitions), head: fingerprint(r.head) };
}
const checkpointHead = (state: AccountCheckpoint): AccountHead => ({ rootId: state.rootId, revision: state.revision, head: state.head });
function endpoint(value: unknown, kind: 'browser' | 'bridge'): EndpointPublic {
  const r = exact(value, ['version', 'id', 'ownerId', 'kind', 'publicKey']);
  if (r.version !== 1 || r.kind !== kind) return invalid();
  return { version: 1, id: fingerprint(r.id), ownerId: owner(r.ownerId), kind, publicKey: point(r.publicKey) };
}
async function validateEndpoint(value: EndpointPublic): Promise<void> {
  await importPublicKey(value.publicKey);
  if (b64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value.publicKey, 65)))) !== value.id) return invalid();
}
async function verificationKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes(value, 65), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}
async function verify(domain: string, payload: unknown, sig: string, publicKey: string): Promise<void> {
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await verificationKey(publicKey), bytes(sig, 64), signedBytes(domain, payload))) return invalid();
}
async function sign(domain: string, payload: unknown, signing: AccountSigningIdentity): Promise<string> {
  const key = signing.keyPair;
  if (key.privateKey.type !== 'private' || key.privateKey.algorithm.name !== 'ECDSA' || !key.privateKey.usages.includes('sign')
    || key.publicKey.type !== 'public' || key.publicKey.algorithm.name !== 'ECDSA'
    || point(b64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey)))) !== signing.publicKey) return invalid();
  const result = b64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, signedBytes(domain, payload))));
  signature(result);
  await verify(domain, payload, result, signing.publicKey);
  return result;
}
async function hash(domain: string, value: unknown): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', signedBytes(domain, value))));
}
const random = (): string => b64(crypto.getRandomValues(new Uint8Array(32)));
async function request(value: unknown, now?: number): Promise<AccountEnrollmentRequest> {
  wire(value);
  // Timeless transcript hashing/terminal parsing validates syntax and proof,
  // not liveness. Every operation granting/creating trust supplies a real now.
  const validationTime = now === undefined ? Date.parse(timestamp(object(value).expiresAt)) - 1 : time(now);
  return parseAccountEnrollmentRequest(value, validationTime);
}
function core(payload: PendingOfferPayload): PendingOfferCore {
  const { commitment: _commitment, ...value } = payload;
  return value;
}
async function readOffer(value: unknown, expected?: AccountEnrollmentRequest, now?: number): Promise<PendingOffer> {
  wire(value);
  const r = exact(value, ['payload', 'signature']);
  const p = exact(r.payload, ['type', 'version', 'suite', 'request', 'ownerId', 'anchor', 'approver', 'signingPublicKey', 'offerId', 'expiresAt', 'commitment']);
  if (p.type !== 'ftown_pending_offer' || p.version !== 1 || p.suite !== 'hpke-p256-sha256-commit-v1') return invalid();
  const req = await request(p.request, now);
  if (expected && !same(req, await request(expected, now))) return invalid();
  const payload: PendingOfferPayload = {
    type: 'ftown_pending_offer', version: 1, suite: 'hpke-p256-sha256-commit-v1',
    request: req, ownerId: owner(p.ownerId), anchor: head(p.anchor), approver: endpoint(p.approver, 'browser'),
    signingPublicKey: point(p.signingPublicKey), offerId: fingerprint(p.offerId),
    expiresAt: timestamp(p.expiresAt), commitment: fingerprint(p.commitment),
  };
  if (payload.approver.ownerId !== payload.ownerId || payload.approver.publicKey === payload.signingPublicKey
    || (req.kind === 'browser' && req.candidate.ownerId !== payload.ownerId) || payload.expiresAt !== req.expiresAt) return invalid();
  await validateEndpoint(payload.approver);
  const sig = signature(r.signature);
  await verify('ftown-pending-offer-v1', payload, sig, payload.signingPublicKey);
  return { payload, signature: sig };
}
async function localOffer(value: PendingOfferLocal, now: number): Promise<PendingOfferLocal> {
  const r = exact(value, ['offer', 'contribution']);
  const offer = await readOffer(r.offer, undefined, now);
  const contribution = fingerprint(r.contribution);
  if (await hash('ftown-pending-commit-v1', { core: core(offer.payload), contribution }) !== offer.payload.commitment) return invalid();
  return { offer, contribution };
}
function candidateEndpoint(offer: PendingOffer): EndpointPublic {
  return { ...offer.payload.request.candidate, ownerId: offer.payload.ownerId };
}
function candidateIdentity(candidate: EndpointIdentity, offer: PendingOffer): EndpointIdentity {
  if (!same(candidate.endpoint, offer.payload.request.candidate)) return invalid();
  return { ...candidate, endpoint: candidateEndpoint(offer) };
}
const bridgeContext = (offer: PendingOffer): string => offer.payload.request.kind === 'bridge'
  ? offer.payload.request.bridgeId : 'account_' + offer.payload.ownerId;
function hello(value: unknown): PendingHello {
  wire(value);
  const r = exact(value, ['version', 'requestId', 'offerHash', 'envelope']);
  if (r.version !== 1) return invalid();
  return { version: 1, requestId: fingerprint(r.requestId), offerHash: fingerprint(r.offerHash), envelope: parseSecureEnvelope(r.envelope) };
}
function context(offer: PendingOffer, envelope: SecureEnvelope, purpose: 'enroll' | 'enrolled', now: number, fresh: boolean): void {
  const req = offer.payload.request;
  const sender = purpose === 'enroll' ? req.candidate.id : offer.payload.approver.id;
  const recipient = purpose === 'enroll' ? offer.payload.approver.id : req.candidate.id;
  const channel = (purpose === 'enroll' ? 'pending-approval:' : 'account-enrollment:') + req.requestId;
  if (envelope.ownerId !== offer.payload.ownerId || envelope.bridgeId !== bridgeContext(offer) || envelope.purpose !== purpose
    || envelope.senderId !== sender || envelope.recipientId !== recipient || envelope.messageId !== req.requestId
    || envelope.channel !== channel || envelope.receiverEpoch !== null
    || envelope.createdAt > time(now) + PENDING_APPROVAL_LIMITS.maxFutureSkewMs
    || envelope.expiresAt > Date.parse(req.expiresAt) || envelope.expiresAt - envelope.createdAt > 120000) return invalid();
  if (fresh && envelope.expiresAt <= now) throw new AccountTrustError('account_enrollment_expired');
}
async function readHello(offer: PendingOffer, value: unknown, now: number, fresh: boolean): Promise<PendingHello> {
  const parsed = hello(value);
  if (parsed.requestId !== offer.payload.request.requestId || parsed.offerHash !== await hash('ftown-pending-offer-hash-v1', offer.payload)) return invalid();
  context(offer, parsed.envelope, 'enroll', now, fresh);
  return parsed;
}
function confirmation(value: unknown): PendingCandidateConfirmation {
  const r = exact(value, ['offerHash', 'mac']);
  return { offerHash: fingerprint(r.offerHash), mac: fingerprint(r.mac) };
}
async function reveal(offer: PendingOffer, value: unknown): Promise<PendingReveal> {
  const r = exact(value, ['offerHash', 'contribution']);
  const parsed = { offerHash: fingerprint(r.offerHash), contribution: fingerprint(r.contribution) };
  if (parsed.offerHash !== await hash('ftown-pending-offer-hash-v1', offer.payload)
    || await hash('ftown-pending-commit-v1', { core: core(offer.payload), contribution: parsed.contribution }) !== offer.payload.commitment) return invalid();
  return parsed;
}
function secret(value: PendingSecret): CryptoKey {
  const r = exact(value, ['key']);
  const key = r.key as CryptoKey;
  if (!key || key.type !== 'secret' || key.extractable !== false || key.algorithm?.name !== 'HKDF' || !key.usages.includes('deriveBits')) return invalid();
  return key;
}
async function importSecret(raw: Uint8Array<ArrayBuffer>): Promise<PendingSecret> {
  return { key: await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']) };
}
type DerivationLabel = 'sas' | 'candidate-confirm' | 'approver-result' | 'bootstrap';
async function derive(offer: PendingOffer, value: PendingSecret, disclosure: PendingReveal, name: DerivationLabel): Promise<Uint8Array<ArrayBuffer>> {
  const parsed = await reveal(offer, disclosure);
  const salt = bytes(await hash('ftown-pending-salt-v1', { offerHash: parsed.offerHash, contribution: parsed.contribution }), 32);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt,
    info: utf8('ftown-pending-v1/' + name) }, secret(value), name === 'sas' ? 48 : 256));
}
function candidateProof(offer: PendingOffer, offerHash: string): Record<string, string> {
  return { role: 'candidate', requestId: offer.payload.request.requestId, offerHash };
}
async function mac(key: Uint8Array<ArrayBuffer>, domain: string, payload: unknown): Promise<string> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', imported, signedBytes(domain, payload))));
}
async function verifyMac(key: Uint8Array<ArrayBuffer>, domain: string, payload: unknown, value: string): Promise<void> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('HMAC', imported, bytes(value, 32), signedBytes(domain, payload))) return invalid();
}
function approvedMember(state: AccountCheckpoint, req: AccountEnrollmentRequest): boolean {
  const expected = { ...req.candidate, ownerId: state.ownerId };
  if (req.kind === 'browser') {
    return state.devices.some(member => same(member.endpoint, expected) && member.label === req.label && member.signingPublicKey === req.signingPublicKey);
  }
  return state.bridges.some(member => member.bridgeId === req.bridgeId && same(member.endpoint, expected) && member.label === req.label);
}
function requireMember(state: AccountCheckpoint, req: AccountEnrollmentRequest): void {
  if (!approvedMember(state, req)) throw new AccountTrustError(req.kind === 'browser' ? 'account_device_revoked' : 'account_bridge_revoked');
}
function requireApprover(state: AccountCheckpoint, offer: PendingOffer): void {
  const found = state.devices.find(member => member.endpoint.id === offer.payload.approver.id);
  if (state.ownerId !== offer.payload.ownerId || !found || !same(found.endpoint, offer.payload.approver)
    || found.signingPublicKey !== offer.payload.signingPublicKey) throw new AccountTrustError('account_device_revoked');
}
function prefix(history: AccountHistory, revision: number): AccountHistory {
  if (history.transitions.length < revision) throw new AccountTrustError('account_trust_rollback');
  return { genesis: history.genesis, transitions: history.transitions.slice(0, revision) };
}
function addedCandidate(operation: AccountOperation, req: AccountEnrollmentRequest, ownerId: string): boolean {
  const normalized = { ...req.candidate, ownerId };
  if (req.kind === 'browser' && operation.type === 'add_device') return same(operation.device.endpoint, normalized)
    && operation.device.signingPublicKey === req.signingPublicKey && operation.device.label === req.label;
  if (req.kind === 'bridge' && operation.type === 'add_bridge') return operation.bridge.bridgeId === req.bridgeId
    && same(operation.bridge.endpoint, normalized) && operation.bridge.label === req.label;
  return false;
}
async function approvalPrefix(offer: PendingOffer, history: AccountHistory, now: number): Promise<{ history: AccountHistory; checkpoint: AccountCheckpoint }> {
  const parsed = parseAccountHistory(history);
  const anchorHistory = prefix(parsed, offer.payload.anchor.revision);
  const anchor = await verifyAccountHistory(anchorHistory, null, now);
  if (!same(checkpointHead(anchor), offer.payload.anchor) || anchor.ownerId !== offer.payload.ownerId) throw new AccountTrustError('account_trust_rollback');
  requireApprover(anchor, offer);
  const existing = approvedMember(anchor, offer.payload.request);
  if (parsed.transitions.length !== anchor.revision + (existing ? 0 : 1)) throw new AccountTrustError('account_trust_conflict');
  if (!existing) {
    const addition = parsed.transitions[anchor.revision];
    if (!addition || addition.payload.signerId !== offer.payload.approver.id
      || !addedCandidate(addition.payload.operation, offer.payload.request, offer.payload.ownerId)) return invalid();
  }
  const current = await verifyAccountHistory(parsed, anchor, now);
  requireMember(current, offer.payload.request);
  return { history: parsed, checkpoint: current };
}
function bundle(value: unknown): AccountEnrollmentBundle {
  const r = exact(value, ['version', 'requestId', 'ownerId', 'approver', 'envelope']);
  if (r.version !== 1) return invalid();
  return { version: 1, requestId: fingerprint(r.requestId), ownerId: owner(r.ownerId),
    approver: endpoint(r.approver, 'browser'), envelope: parseSecureEnvelope(r.envelope) };
}
function result(value: unknown): PendingResult {
  wire(value);
  const r = exact(value, ['version', 'offerHash', 'head', 'bundle', 'mac']);
  if (r.version !== 1) return invalid();
  return { version: 1, offerHash: fingerprint(r.offerHash), head: head(r.head), bundle: bundle(r.bundle), mac: fingerprint(r.mac) };
}
async function readResult(offer: PendingOffer, value: unknown, now: number): Promise<PendingResult> {
  const parsed = result(value);
  if (parsed.offerHash !== await hash('ftown-pending-offer-hash-v1', offer.payload)
    || parsed.bundle.requestId !== offer.payload.request.requestId || parsed.bundle.ownerId !== offer.payload.ownerId
    || !same(parsed.bundle.approver, offer.payload.approver) || parsed.head.rootId !== offer.payload.anchor.rootId
    || (parsed.head.revision !== offer.payload.anchor.revision && parsed.head.revision !== offer.payload.anchor.revision + 1)) return invalid();
  context(offer, parsed.bundle.envelope, 'enrolled', now, false);
  return parsed;
}
async function resultProof(offer: PendingOffer, value: PendingResult): Promise<Record<string, unknown>> {
  return { role: 'approver', requestId: offer.payload.request.requestId, offerHash: value.offerHash,
    head: value.head, bundleHash: await hash('ftown-pending-bundle-v1', value.bundle) };
}
export function normalizePendingAccountHint(value: unknown): string {
  if (typeof value !== 'string' || value.length > PENDING_APPROVAL_LIMITS.maxWireBytes) return invalid();
  const parsed = value.replace(/^[\u0009-\u000d\u0020]+|[\u0009-\u000d\u0020]+$/g, '')
    .replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32));
  const at = parsed.indexOf('@');
  if (parsed.length > 254 || at <= 0 || at !== parsed.lastIndexOf('@') || at === parsed.length - 1
    || /[\s\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(parsed)) return invalid();
  return parsed;
}
export async function createPendingOffer(req: AccountEnrollmentRequest, approver: EndpointIdentity, signing: AccountSigningIdentity, history: AccountHistory, now = Date.now()): Promise<PendingOfferLocal> {
  return safe(async () => {
    const parsed = await request(req, now);
    const current = await verifyAccountHistory(history, null, now);
    const member = current.devices.find(item => item.endpoint.id === approver.endpoint.id);
    if (!member || !same(member.endpoint, approver.endpoint) || member.signingPublicKey !== signing.publicKey
      || (parsed.kind === 'browser' && parsed.candidate.ownerId !== current.ownerId)) return invalid();
    if (await exportPublicKey(approver.keyPair.publicKey) !== approver.endpoint.publicKey) return invalid();
    const contribution = random();
    const payloadCore: PendingOfferCore = { type: 'ftown_pending_offer', version: 1, suite: 'hpke-p256-sha256-commit-v1',
      request: parsed, ownerId: current.ownerId, anchor: checkpointHead(current), approver: { ...approver.endpoint },
      signingPublicKey: signing.publicKey, offerId: random(), expiresAt: parsed.expiresAt };
    const payload = { ...payloadCore, commitment: await hash('ftown-pending-commit-v1', { core: payloadCore, contribution }) };
    const offer = { payload, signature: await sign('ftown-pending-offer-v1', payload, signing) };
    wire(offer);
    return { offer, contribution };
  });
}
export async function parsePendingOffer(value: unknown, req: AccountEnrollmentRequest, now = Date.now()): Promise<PendingOffer> {
  return safe(() => readOffer(value, req, now));
}
export async function pendingOfferHash(value: PendingOffer): Promise<string> {
  return safe(async () => hash('ftown-pending-offer-hash-v1', (await readOffer(value)).payload));
}
export async function pendingHelloHash(value: PendingHello): Promise<string> {
  return safe(async () => hash('ftown-pending-hello-hash-v1', hello(value)));
}
export async function createPendingHello(candidate: EndpointIdentity, value: PendingOffer, now = Date.now()): Promise<PendingHelloLocal> {
  return safe(async () => {
    const offer = await readOffer(value, undefined, now);
    const identity = candidateIdentity(candidate, offer);
    const offerHash = await hash('ftown-pending-offer-hash-v1', offer.payload);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    try {
      const secret = await importSecret(raw);
      const req = offer.payload.request;
      const envelope = await seal(identity, offer.payload.approver, { type: 'ftown_encrypted', version: 1,
        ownerId: offer.payload.ownerId, bridgeId: bridgeContext(offer), channel: 'pending-approval:' + req.requestId,
        purpose: 'enroll', senderId: req.candidate.id, recipientId: offer.payload.approver.id, messageId: req.requestId,
        createdAt: time(now), expiresAt: Math.min(now + 120000, Date.parse(req.expiresAt)), receiverEpoch: null,
      }, utf8(JSON.stringify({ type: 'ftown_pending_secret', version: 1, requestId: req.requestId, offerHash, secret: b64(raw) })));
      const hello: PendingHello = { version: 1, requestId: req.requestId, offerHash, envelope };
      wire(hello);
      return { hello, secret };
    } finally { raw.fill(0); }
  });
}
export async function openPendingHello(approver: EndpointIdentity, value: PendingOfferLocal, packet: PendingHello, now = Date.now()): Promise<PendingSecret> {
  return safe(async () => {
    const local = await localOffer(value, now);
    if (!same(approver.endpoint, local.offer.payload.approver)) return invalid();
    const parsed = await readHello(local.offer, packet, now, true);
    const req = local.offer.payload.request;
    const plaintext = await open(approver, candidateEndpoint(local.offer), parsed.envelope, {
      ownerId: local.offer.payload.ownerId, bridgeId: bridgeContext(local.offer), channel: 'pending-approval:' + req.requestId,
      purpose: 'enroll', recipientId: approver.endpoint.id,
    });
    if (plaintext.byteLength > PENDING_APPROVAL_LIMITS.maxWireBytes) return invalid();
    const r = exact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)), ['type', 'version', 'requestId', 'offerHash', 'secret']);
    if (r.type !== 'ftown_pending_secret' || r.version !== 1 || r.requestId !== req.requestId || r.offerHash !== parsed.offerHash) return invalid();
    const raw = bytes(r.secret, 32);
    try { return await importSecret(raw); } finally { raw.fill(0); plaintext.fill(0); }
  });
}
export async function pendingComparisonCode(value: PendingOffer, key: PendingSecret, disclosure: PendingReveal): Promise<string> {
  return safe(async () => {
    const raw = await derive(await readOffer(value), key, disclosure, 'sas');
    return Array.from(raw, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g)!.join('-');
  });
}
export async function createPendingConfirmation(value: PendingOffer, key: PendingSecret, disclosure: PendingReveal, confirmedOfferHash: string): Promise<PendingCandidateConfirmation> {
  return safe(async () => {
    const offer = await readOffer(value);
    const offerHash = await hash('ftown-pending-offer-hash-v1', offer.payload);
    if (confirmedOfferHash !== offerHash) return invalid();
    return { offerHash, mac: await mac(await derive(offer, key, disclosure, 'candidate-confirm'),
      'ftown-pending-candidate-confirm-v1', candidateProof(offer, offerHash)) };
  });
}
export async function verifyPendingConfirmation(value: PendingOffer, key: PendingSecret, disclosure: PendingReveal, proof: PendingCandidateConfirmation): Promise<void> {
  return safe(async () => {
    const offer = await readOffer(value);
    const parsed = confirmation(proof);
    if (parsed.offerHash !== await hash('ftown-pending-offer-hash-v1', offer.payload)) return invalid();
    await verifyMac(await derive(offer, key, disclosure, 'candidate-confirm'), 'ftown-pending-candidate-confirm-v1',
      candidateProof(offer, parsed.offerHash), parsed.mac);
  });
}
export async function pendingBootstrapLink(value: PendingOffer, key: PendingSecret, disclosure: PendingReveal): Promise<AccountEnrollmentLink> {
  return safe(async () => {
    const offer = await readOffer(value);
    return { request: offer.payload.request, secret: b64(await derive(offer, key, disclosure, 'bootstrap')) };
  });
}
export async function createPendingResult(approver: EndpointIdentity, value: PendingOfferLocal, key: PendingSecret, proof: PendingCandidateConfirmation, confirmedOfferHash: string, history: AccountHistory, now = Date.now()): Promise<PendingResult> {
  return safe(async () => {
    const local = await localOffer(value, now);
    const offerHash = await hash('ftown-pending-offer-hash-v1', local.offer.payload);
    if (confirmedOfferHash !== offerHash || !same(approver.endpoint, local.offer.payload.approver)) return invalid();
    const disclosure = { offerHash, contribution: local.contribution };
    await verifyPendingConfirmation(local.offer, key, disclosure, proof);
    const approved = await approvalPrefix(local.offer, history, now);
    const delivered = await sealAccountApproval(approver, await pendingBootstrapLink(local.offer, key, disclosure), approved.history, now);
    const unsigned = { version: 1 as const, offerHash, head: checkpointHead(approved.checkpoint), bundle: delivered };
    const parsed: PendingResult = { ...unsigned, mac: await mac(await derive(local.offer, key, disclosure, 'approver-result'),
      'ftown-pending-result-v1', await resultProof(local.offer, { ...unsigned, mac: '' })) };
    wire(parsed);
    return parsed;
  });
}
export async function openPendingResult(candidate: EndpointIdentity, value: PendingOffer, key: PendingSecret, disclosure: PendingReveal, confirmedOfferHash: string, received: PendingResult, history: AccountHistory, now = Date.now()): Promise<PendingOpenResult> {
  return safe(async () => {
    const offer = await readOffer(value, undefined, now);
    const identity = candidateIdentity(candidate, offer);
    const parsed = await readResult(offer, received, now);
    if (confirmedOfferHash !== parsed.offerHash) return invalid();
    await verifyMac(await derive(offer, key, disclosure, 'approver-result'), 'ftown-pending-result-v1',
      await resultProof(offer, parsed), parsed.mac);
    const currentHistory = parseAccountHistory(history);
    const approved = await approvalPrefix(offer, prefix(currentHistory, parsed.head.revision), now);
    if (!same(checkpointHead(approved.checkpoint), parsed.head)) throw new AccountTrustError('account_trust_rollback');
    const current = await verifyAccountHistory(currentHistory, approved.checkpoint, now);
    requireMember(current, offer.payload.request);
    if (parsed.bundle.envelope.expiresAt <= now) return { status: 'awaiting-delivery-renewal' };
    // Existing account opening verifies HMAC/membership. Also bind its encrypted
    // approval head to this result, rather than accepting an older valid prefix.
    const plaintext = await open(identity, offer.payload.approver, parsed.bundle.envelope, {
      ownerId: offer.payload.ownerId, bridgeId: bridgeContext(offer),
      channel: 'account-enrollment:' + offer.payload.request.requestId, purpose: 'enrolled', recipientId: candidate.endpoint.id,
    });
    if (plaintext.byteLength > 8192) return invalid();
    if (!same(head(object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))).head), parsed.head)) return invalid();
    await openAccountApproval(candidate, await pendingBootstrapLink(offer, key, disclosure), parsed.bundle, approved.history, now);
    return { status: 'verified', trust: { history: currentHistory, checkpoint: current } };
  });
}
function operation(value: unknown): AccountOperation {
  const r = object(value);
  if (r.type === 'add_device') {
    exact(r, ['type', 'device']);
    const d = exact(r.device, ['endpoint', 'signingPublicKey', 'label', 'approvedAt']);
    const parsed = { endpoint: endpoint(d.endpoint, 'browser'), signingPublicKey: point(d.signingPublicKey), label: label(d.label), approvedAt: timestamp(d.approvedAt) };
    if (parsed.endpoint.publicKey === parsed.signingPublicKey) return invalid();
    return { type: 'add_device', device: parsed };
  }
  if (r.type === 'add_bridge') {
    exact(r, ['type', 'bridge']);
    const b = exact(r.bridge, ['bridgeId', 'endpoint', 'label', 'approvedAt']);
    return { type: 'add_bridge', bridge: { bridgeId: identifier(b.bridgeId), endpoint: endpoint(b.endpoint, 'bridge'), label: label(b.label), approvedAt: timestamp(b.approvedAt) } };
  }
  return invalid();
}
function transition(value: unknown): SignedAccountTransition {
  const r = exact(value, ['payload', 'signature']);
  const p = exact(r.payload, ['type', 'version', 'ownerId', 'rootId', 'revision', 'previousHead', 'issuedAt', 'signerId', 'operation']);
  const rev = integer(p.revision, ACCOUNT_TRUST_LIMITS.maxTransitions);
  if (p.type !== 'ftown_account_transition' || p.version !== 1 || rev === 0) return invalid();
  return { signature: signature(r.signature), payload: { type: 'ftown_account_transition', version: 1,
    ownerId: owner(p.ownerId), rootId: fingerprint(p.rootId), revision: rev, previousHead: fingerprint(p.previousHead),
    issuedAt: timestamp(p.issuedAt), signerId: fingerprint(p.signerId), operation: operation(p.operation) } };
}
async function action(value: unknown): Promise<PendingReviewerAction> {
  const r = object(value);
  switch (r.type) {
    case 'review': exact(r, ['type', 'offer']); return { type: 'review', offer: await readOffer(r.offer) };
    case 'reveal': {
      exact(r, ['type', 'offerHash', 'helloHash', 'reveal']);
      const d = exact(r.reveal, ['offerHash', 'contribution']);
      return { type: 'reveal', offerHash: fingerprint(r.offerHash), helloHash: fingerprint(r.helloHash),
        reveal: { offerHash: fingerprint(d.offerHash), contribution: fingerprint(d.contribution) } };
    }
    case 'reject': exact(r, ['type']); return { type: 'reject' };
    case 'finish': exact(r, ['type', 'offerHash', 'transition', 'result']); return {
      type: 'finish', offerHash: fingerprint(r.offerHash), transition: r.transition === null ? null : transition(r.transition), result: result(r.result),
    };
    case 'renew': exact(r, ['type', 'offerHash', 'result']); return { type: 'renew', offerHash: fingerprint(r.offerHash), result: result(r.result) };
    default: return invalid();
  }
}
async function reviewerPayload(value: unknown): Promise<PendingReviewerPayload> {
  wire(value);
  const r = exact(value, ['type', 'version', 'requestId', 'ownerId', 'signerId', 'head', 'expectedRevision', 'issuedAt', 'action']);
  if (r.type !== 'ftown_pending_action' || r.version !== 1) return invalid();
  const parsed: PendingReviewerPayload = { type: 'ftown_pending_action', version: 1, requestId: fingerprint(r.requestId),
    ownerId: owner(r.ownerId), signerId: fingerprint(r.signerId), head: head(r.head),
    expectedRevision: integer(r.expectedRevision), issuedAt: timestamp(r.issuedAt), action: await action(r.action) };
  const operation = parsed.action;
  if (operation.type === 'review' && (operation.offer.payload.request.requestId !== parsed.requestId
    || operation.offer.payload.ownerId !== parsed.ownerId || operation.offer.payload.approver.id !== parsed.signerId
    || !same(operation.offer.payload.anchor, parsed.head))) return invalid();
  if (operation.type === 'reveal' && operation.reveal.offerHash !== operation.offerHash) return invalid();
  if ((operation.type === 'finish' || operation.type === 'renew') && operation.result.offerHash !== operation.offerHash) return invalid();
  return parsed;
}
export async function signPendingAction(payload: PendingReviewerPayload, signing: AccountSigningIdentity): Promise<PendingReviewerCommand> {
  return safe(async () => {
    const parsed = await reviewerPayload(payload);
    return { payload: parsed, signature: await sign('ftown-pending-action-v1', parsed, signing) };
  });
}
export async function verifyPendingAction(value: unknown, req: AccountEnrollmentRequest, history: AccountHistory, now = Date.now()): Promise<PendingReviewerCommand> {
  return safe(async () => {
    wire(value);
    const raw = exact(value, ['payload', 'signature']);
    const parsed = await reviewerPayload(raw.payload);
    const sig = signature(raw.signature);
    const enrollment = await request(req, now);
    const current = await verifyAccountHistory(history, null, now);
    if (parsed.requestId !== enrollment.requestId || parsed.ownerId !== current.ownerId
      || (enrollment.kind === 'browser' && enrollment.candidate.ownerId !== parsed.ownerId)
      || !same(parsed.head, checkpointHead(current))) throw new AccountTrustError('account_trust_conflict');
    const issued = Date.parse(parsed.issuedAt);
    if (issued > time(now) + PENDING_APPROVAL_LIMITS.maxFutureSkewMs || issued >= Date.parse(enrollment.expiresAt)
      || issued < Date.parse(enrollment.expiresAt) - PENDING_APPROVAL_LIMITS.lifetimeMs) return invalid();
    const signer = current.devices.find(item => item.endpoint.id === parsed.signerId);
    if (!signer) throw new AccountTrustError('account_device_revoked');
    await verify('ftown-pending-action-v1', parsed, sig, signer.signingPublicKey);
    const op = parsed.action;
    if (op.type === 'review') {
      const offer = await readOffer(op.offer, enrollment, now);
      if (!same(offer.payload.approver, signer.endpoint) || offer.payload.signingPublicKey !== signer.signingPublicKey) return invalid();
    } else if (op.type === 'finish' || op.type === 'renew') {
      const receipt = op.result;
      if (receipt.bundle.requestId !== enrollment.requestId || receipt.bundle.ownerId !== current.ownerId
        || !same(receipt.bundle.approver, signer.endpoint)) return invalid();
      let approved = current;
      if (op.type === 'finish') {
        if (op.transition === null) requireMember(current, enrollment);
        else {
          const addition = op.transition;
          if (approvedMember(current, enrollment) || addition.payload.signerId !== parsed.signerId
            || !addedCandidate(addition.payload.operation, enrollment, current.ownerId)) return invalid();
          approved = await verifyAccountHistory({ genesis: history.genesis, transitions: [...history.transitions, addition] }, current, now);
        }
        if (!same(receipt.head, checkpointHead(approved))) return invalid();
      } else {
        const atApproval = await verifyAccountHistory(prefix(parseAccountHistory(history), receipt.head.revision), null, now);
        if (!same(receipt.head, checkpointHead(atApproval))) return invalid();
        requireMember(atApproval, enrollment); requireMember(current, enrollment);
        if (!atApproval.devices.some(member => same(member.endpoint, signer.endpoint))) return invalid();
      }
      // Server checks stored offer/hello/confirmation and immutable renewal head;
      // this method authenticates the actor and prospective membership.
      const packet = receipt.bundle.envelope;
      if (packet.ownerId !== current.ownerId || packet.bridgeId !== (enrollment.kind === 'bridge' ? enrollment.bridgeId : 'account_' + current.ownerId)
        || packet.purpose !== 'enrolled' || packet.channel !== 'account-enrollment:' + enrollment.requestId
        || packet.senderId !== signer.endpoint.id || packet.recipientId !== enrollment.candidate.id
        || packet.messageId !== enrollment.requestId || packet.receiverEpoch !== null
        || packet.createdAt > now + PENDING_APPROVAL_LIMITS.maxFutureSkewMs || packet.expiresAt <= now
        || packet.expiresAt > Date.parse(enrollment.expiresAt) || packet.expiresAt - packet.createdAt > 120000) return invalid();
    }
    return { payload: parsed, signature: sig };
  });
}
export async function parsePendingState(value: unknown, now = Date.now()): Promise<PendingApprovalState> {
  return safe(async () => {
    wire(value);
    const raw = object(value);
    const terminal = ['rejected', 'cancelled', 'expired', 'conflict'].includes(String(raw.status));
    const enrollment = await request(raw.request, terminal ? undefined : now);
    const base = { request: enrollment, revision: integer(raw.revision) };
    const shared = ['request', 'revision', 'status'];
    if (raw.status === 'pending') { exact(raw, shared); return { ...base, status: 'pending' }; }
    if (raw.status === 'rejected' || raw.status === 'cancelled' || raw.status === 'expired' || raw.status === 'conflict') {
      exact(raw, shared); return { ...base, status: raw.status };
    }
    const fields = [...shared, 'offer'];
    if (raw.status !== 'offered') fields.push('hello');
    if (raw.status === 'comparing' || raw.status === 'confirmed' || raw.status === 'approved') fields.push('reveal');
    if (raw.status === 'confirmed' || raw.status === 'approved') fields.push('confirmation');
    if (raw.status === 'approved') fields.push('result');
    exact(raw, fields);
    const offer = await readOffer(raw.offer, enrollment, now);
    if (raw.status === 'offered') return { ...base, status: 'offered', offer };
    const packet = await readHello(offer, raw.hello, now, false);
    if (raw.status === 'submitted') return { ...base, status: 'submitted', offer, hello: packet };
    const disclosure = await reveal(offer, raw.reveal);
    if (raw.status === 'comparing') return { ...base, status: 'comparing', offer, hello: packet, reveal: disclosure };
    const proof = confirmation(raw.confirmation);
    if (proof.offerHash !== packet.offerHash) return invalid();
    if (raw.status === 'confirmed') return { ...base, status: 'confirmed', offer, hello: packet, reveal: disclosure, confirmation: proof };
    if (raw.status === 'approved') return { ...base, status: 'approved', offer, hello: packet, reveal: disclosure, confirmation: proof,
      result: await readResult(offer, raw.result, now) };
    return invalid();
  });
}
