import { exportPublicKey, generateEndpoint, importEndpoint, importPublicKey, open, parseSecureEnvelope, seal } from './crypto.js';
import type { EndpointIdentity, EndpointPublic } from './protocol.js';
import type {
  AccountApprovalPlaintext, AccountBridge, AccountCheckpoint, AccountDevice, AccountEnrollmentBundle,
  AccountEnrollmentLink, AccountEnrollmentRequest, AccountErrorCode, AccountGenesis, AccountHead,
  AccountHistory, AccountOperation, AccountSigningIdentity, AccountTransition, AccountTrustFailure,
  AccountTrustLimits, SignedAccountGenesis, SignedAccountTransition, VerifiedAccountTrust,
} from './account-protocol.js';

export const ACCOUNT_TRUST_LIMITS = Object.freeze({
  maxHistoryBytes: 2097152, maxTransitions: 1024, maxDevices: 128, maxBridges: 128,
  enrollmentLifetimeMs: 300000, refreshIntervalMs: 30000, offlineGraceMs: 86400000,
  maxFutureSkewMs: 30000, maxLabelLength: 200,
} satisfies AccountTrustLimits);

/** No untrusted text, key material or underlying crypto error enters this error. */
export class AccountTrustError extends Error implements AccountTrustFailure {
  readonly retryable: boolean;
  constructor(readonly code: AccountErrorCode) {
    super(code === 'account_last_admin' ? 'Approve another account device before revoking this device.'
      : code === 'account_enrollment_expired' ? 'This approval request expired. Start a new request.'
      : code === 'account_capacity_exceeded' ? 'Account trust history reached its supported capacity.'
      : code === 'account_trust_rollback' ? 'Account trust history does not continue the pinned history.'
      : 'Account trust could not be verified.');
    this.name = 'AccountTrustError';
    this.retryable = code === 'account_trust_conflict' || code === 'account_storage_unavailable';
  }
}
const fail = (code: AccountErrorCode = 'invalid_account_trust'): never => { throw new AccountTrustError(code); };
const encoder = new TextEncoder();
const TRUST_DOMAIN = 'ftown-account-trust-v1\n';
const ENROLL_DOMAIN = 'ftown-account-enrollment-v1\n';
const BOOTSTRAP_DOMAIN = 'ftown-account-bootstrap-v1\n';
const COMPARISON_DOMAIN = 'ftown-account-comparison-v1\n';
const PENDING_OWNER = '00000000-0000-0000-0000-000000000000';
const MAX_LINK_BYTES = 8192;
const utf8 = (value: string) => encoder.encode(value);
const nowValue = (now: number): number => Number.isSafeInteger(now) && now >= 0 && now <= 253402300799999 ? now : fail();
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return fail();
  return value as Record<string, unknown>;
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = object(value);
  const keys = Object.keys(record);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) return fail();
  return record;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) return fail();
  return value;
}
function token(value: unknown): string {
  const parsed = string(value, 200);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(parsed)) return fail();
  return parsed;
}
function owner(value: unknown): string {
  const parsed = string(value, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parsed)) return fail();
  return parsed;
}
function label(value: unknown): string {
  const parsed = string(value, ACCOUNT_TRUST_LIMITS.maxLabelLength);
  // Refuse control characters and unpaired surrogates instead of silently changing signed labels.
  if (/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(parsed)) return fail();
  return parsed;
}
function b64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function bytes(value: unknown, length: number): Uint8Array<ArrayBuffer> {
  const parsed = string(value, Math.ceil(length * 4 / 3));
  if (!/^[A-Za-z0-9_-]+$/.test(parsed)) return fail();
  let binary: string;
  try { binary = atob(parsed.replaceAll('-', '+').replaceAll('_', '/')); } catch { return fail(); }
  if (binary.length !== length) return fail();
  const result = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (b64(result) !== parsed) return fail();
  return result;
}
const fingerprint = (value: unknown): string => { const parsed = string(value, 43); bytes(parsed, 32); return parsed; };
function point(value: unknown): string {
  const parsed = string(value, 87);
  if (bytes(parsed, 65)[0] !== 4) return fail();
  return parsed;
}
function timestamp(value: unknown): string {
  const parsed = string(value, 24);
  const ms = Date.parse(parsed);
  if (!Number.isFinite(ms) || ms < 0 || new Date(ms).toISOString() !== parsed) return fail();
  return parsed;
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > ACCOUNT_TRUST_LIMITS.maxTransitions) return fail();
  return value;
}
function endpoint(value: unknown, kind: 'browser' | 'bridge', pendingBridgeId?: string): EndpointPublic {
  const record = exact(value, ['version', 'id', 'ownerId', 'kind', 'publicKey']);
  if (record.version !== 1 || record.kind !== kind) return fail();
  const ownerId = pendingBridgeId ? record.ownerId === `pending:${pendingBridgeId}` ? record.ownerId : fail() : owner(record.ownerId);
  return { version: 1, id: fingerprint(record.id), ownerId, kind, publicKey: point(record.publicKey) };
}
function device(value: unknown): AccountDevice {
  const record = exact(value, ['endpoint', 'signingPublicKey', 'label', 'approvedAt']);
  const parsed = { endpoint: endpoint(record.endpoint, 'browser'), signingPublicKey: point(record.signingPublicKey), label: label(record.label), approvedAt: timestamp(record.approvedAt) };
  if (parsed.endpoint.publicKey === parsed.signingPublicKey) return fail();
  return parsed;
}
function bridge(value: unknown): AccountBridge {
  const record = exact(value, ['bridgeId', 'endpoint', 'label', 'approvedAt']);
  return { bridgeId: token(record.bridgeId), endpoint: endpoint(record.endpoint, 'bridge'), label: label(record.label), approvedAt: timestamp(record.approvedAt) };
}
function operation(value: unknown): AccountOperation {
  const record = object(value);
  switch (record.type) {
    case 'add_device': exact(record, ['type', 'device']); return { type: 'add_device', device: device(record.device) };
    case 'add_bridge': exact(record, ['type', 'bridge']); return { type: 'add_bridge', bridge: bridge(record.bridge) };
    case 'revoke_device': exact(record, ['type', 'endpointId']); return { type: 'revoke_device', endpointId: fingerprint(record.endpointId) };
    case 'revoke_bridge': exact(record, ['type', 'bridgeId']); return { type: 'revoke_bridge', bridgeId: token(record.bridgeId) };
    default: return fail();
  }
}
function genesis(value: unknown): AccountGenesis {
  const record = exact(value, ['type', 'version', 'ownerId', 'rootId', 'createdAt', 'device']);
  if (record.type !== 'ftown_account_genesis' || record.version !== 1) return fail();
  return { type: record.type, version: 1, ownerId: owner(record.ownerId), rootId: fingerprint(record.rootId), createdAt: timestamp(record.createdAt), device: device(record.device) };
}
function transition(value: unknown): AccountTransition {
  const record = exact(value, ['type', 'version', 'ownerId', 'rootId', 'revision', 'previousHead', 'issuedAt', 'signerId', 'operation']);
  if (record.type !== 'ftown_account_transition' || record.version !== 1 || record.revision === 0) return fail();
  return { type: record.type, version: 1, ownerId: owner(record.ownerId), rootId: fingerprint(record.rootId), revision: revision(record.revision),
    previousHead: fingerprint(record.previousHead), issuedAt: timestamp(record.issuedAt), signerId: fingerprint(record.signerId), operation: operation(record.operation) };
}
function signed<T>(value: unknown, parse: (value: unknown) => T): { payload: T; signature: string } {
  const record = exact(value, ['payload', 'signature']);
  const signature = string(record.signature, 86); bytes(signature, 64);
  return { payload: parse(record.payload), signature };
}
function array<T>(value: unknown, max: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) return fail();
  if (value.length > max) return fail('account_capacity_exceeded');
  return value.map(parse);
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = object(value);
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
const canonicalBytes = (domain: string, value: unknown) => utf8(domain + canonical(value));
async function hash(value: unknown): Promise<string> {
  try { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', canonicalBytes(TRUST_DOMAIN, value)))); }
  catch { return fail(); }
}
const random = (): string => { try { return b64(crypto.getRandomValues(new Uint8Array(32))); } catch { return fail(); } };
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right);
async function publicEndpoint(value: EndpointPublic): Promise<void> {
  try {
    await importPublicKey(value.publicKey);
    const digest = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value.publicKey, 65))));
    if (digest !== value.id) return fail();
  } catch { return fail(); }
}
async function signingKey(publicKey: string): Promise<CryptoKey> {
  try { return await crypto.subtle.importKey('raw', bytes(publicKey, 65), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); }
  catch { return fail(); }
}
async function signingPoint(key: CryptoKey): Promise<string> {
  if (key.type !== 'public' || key.algorithm.name !== 'ECDSA' || !('namedCurve' in key.algorithm) || key.algorithm.namedCurve !== 'P-256') return fail();
  return point(b64(new Uint8Array(await crypto.subtle.exportKey('raw', key))));
}
async function publicDevice(value: AccountDevice): Promise<void> { await publicEndpoint(value.endpoint); await signingKey(value.signingPublicKey); }
async function sign(value: unknown, identity: AccountSigningIdentity, domain: string): Promise<string> {
  try {
    if (identity.keyPair.privateKey.algorithm.name !== 'ECDSA' || !identity.keyPair.privateKey.usages.includes('sign')
      || await signingPoint(identity.keyPair.publicKey) !== identity.publicKey) return fail();
    const data = canonicalBytes(domain, value);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.keyPair.privateKey, data));
    if (signature.length !== 64 || !await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(identity.publicKey), signature, data)) return fail();
    return b64(signature);
  } catch { return fail(); }
}
async function verify(value: unknown, signature: string, publicKey: string, domain: string): Promise<void> {
  try {
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(publicKey), bytes(signature, 64), canonicalBytes(domain, value))) return fail();
  } catch { return fail(); }
}
function head(value: unknown): AccountHead {
  const record = exact(value, ['rootId', 'revision', 'head']);
  return { rootId: fingerprint(record.rootId), revision: revision(record.revision), head: fingerprint(record.head) };
}
function checkpoint(value: unknown): AccountCheckpoint {
  const record = exact(value, ['version', 'ownerId', 'rootId', 'revision', 'head', 'devices', 'bridges', 'revokedDeviceIds', 'revokedBridgeIds']);
  if (record.version !== 1) return fail();
  const parsed = { version: 1 as const, ownerId: owner(record.ownerId), ...head({ rootId: record.rootId, revision: record.revision, head: record.head }),
    devices: array(record.devices, ACCOUNT_TRUST_LIMITS.maxDevices, device), bridges: array(record.bridges, ACCOUNT_TRUST_LIMITS.maxBridges, bridge),
    revokedDeviceIds: array(record.revokedDeviceIds, ACCOUNT_TRUST_LIMITS.maxTransitions, fingerprint), revokedBridgeIds: array(record.revokedBridgeIds, ACCOUNT_TRUST_LIMITS.maxTransitions, token) };
  if (!parsed.devices.length || new Set(parsed.devices.map(item => item.endpoint.id)).size !== parsed.devices.length
    || new Set(parsed.bridges.map(item => item.bridgeId)).size !== parsed.bridges.length
    || new Set(parsed.bridges.map(item => item.endpoint.id)).size !== parsed.bridges.length
    || new Set(parsed.revokedDeviceIds).size !== parsed.revokedDeviceIds.length || new Set(parsed.revokedBridgeIds).size !== parsed.revokedBridgeIds.length
    || parsed.bridges.some(item => parsed.devices.some(device => device.endpoint.id === item.endpoint.id))
    || parsed.devices.some(item => item.endpoint.ownerId !== parsed.ownerId || parsed.revokedDeviceIds.includes(item.endpoint.id))
    || parsed.bridges.some(item => item.endpoint.ownerId !== parsed.ownerId || parsed.revokedBridgeIds.includes(item.bridgeId))) return fail();
  return parsed;
}
function apply(current: AccountCheckpoint, op: AccountOperation, issuedAt: string): AccountCheckpoint {
  const next: AccountCheckpoint = { ...current, devices: [...current.devices], bridges: [...current.bridges], revokedDeviceIds: [...current.revokedDeviceIds], revokedBridgeIds: [...current.revokedBridgeIds] };
  switch (op.type) {
    case 'add_device':
      if (op.device.endpoint.ownerId !== current.ownerId || Date.parse(op.device.approvedAt) > Date.parse(issuedAt)
        || next.devices.some(item => item.endpoint.id === op.device.endpoint.id || item.signingPublicKey === op.device.signingPublicKey)
        || next.bridges.some(item => item.endpoint.id === op.device.endpoint.id)
        || next.revokedDeviceIds.includes(op.device.endpoint.id)) return fail();
      if (next.devices.length >= ACCOUNT_TRUST_LIMITS.maxDevices) return fail('account_capacity_exceeded');
      next.devices.push(op.device); break;
    case 'add_bridge':
      if (op.bridge.endpoint.ownerId !== current.ownerId || Date.parse(op.bridge.approvedAt) > Date.parse(issuedAt)
        || next.bridges.some(item => item.bridgeId === op.bridge.bridgeId || item.endpoint.id === op.bridge.endpoint.id)
        || next.devices.some(item => item.endpoint.id === op.bridge.endpoint.id)
        || next.revokedBridgeIds.includes(op.bridge.bridgeId)) return fail();
      if (next.bridges.length >= ACCOUNT_TRUST_LIMITS.maxBridges) return fail('account_capacity_exceeded');
      next.bridges.push(op.bridge); break;
    case 'revoke_device': {
      const index = next.devices.findIndex(item => item.endpoint.id === op.endpointId);
      if (index === -1) return fail('account_device_revoked');
      if (next.devices.length === 1) return fail('account_last_admin');
      next.devices.splice(index, 1); next.revokedDeviceIds.push(op.endpointId); break;
    }
    case 'revoke_bridge': {
      const index = next.bridges.findIndex(item => item.bridgeId === op.bridgeId);
      if (index === -1) return fail('account_bridge_revoked');
      next.bridges.splice(index, 1); next.revokedBridgeIds.push(op.bridgeId); break;
    }
  }
  next.devices.sort((a, b) => a.endpoint.id < b.endpoint.id ? -1 : a.endpoint.id > b.endpoint.id ? 1 : 0);
  next.bridges.sort((a, b) => a.bridgeId < b.bridgeId ? -1 : a.bridgeId > b.bridgeId ? 1 : 0);
  next.revokedDeviceIds.sort(); next.revokedBridgeIds.sort();
  return next;
}
function historySize(value: AccountHistory): void {
  if (utf8(JSON.stringify(value)).byteLength > ACCOUNT_TRUST_LIMITS.maxHistoryBytes) return fail('account_capacity_exceeded');
}
export function parseAccountHistory(value: unknown): AccountHistory {
  const record = exact(value, ['genesis', 'transitions']);
  const parsed = { genesis: signed(record.genesis, genesis), transitions: array(record.transitions, ACCOUNT_TRUST_LIMITS.maxTransitions, item => signed(item, transition)) };
  historySize(parsed);
  return parsed;
}
export async function generateAccountSigningIdentity(extractable = false): Promise<AccountSigningIdentity> {
  try {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, extractable, ['sign', 'verify']);
    return { keyPair, publicKey: await signingPoint(keyPair.publicKey) };
  } catch { return fail(); }
}
export async function generateAccountBridgeCandidate(bridgeId: string, extractable = false): Promise<EndpointIdentity> {
  const parsedId = token(bridgeId);
  try {
    const identity = await generateEndpoint(PENDING_OWNER, 'bridge', extractable);
    return { ...identity, endpoint: { ...identity.endpoint, ownerId: `pending:${parsedId}` } };
  } catch { return fail('account_enrollment_invalid'); }
}
export async function importAccountBridgeCandidate(value: EndpointPublic, privateKey: JsonWebKey, extractable = false): Promise<EndpointIdentity> {
  try {
    if (typeof value.ownerId !== 'string' || !value.ownerId.startsWith('pending:')) return fail();
    const parsed = endpoint(value, 'bridge', token(value.ownerId.slice(8)));
    const imported = await importEndpoint({ ...parsed, ownerId: PENDING_OWNER }, privateKey, extractable);
    return { ...imported, endpoint: parsed };
  } catch { return fail('account_enrollment_invalid'); }
}
export async function createAccountGenesis(ownerId: string, value: EndpointPublic, signing: AccountSigningIdentity, name: string, now = Date.now()): Promise<SignedAccountGenesis> {
  const createdAt = new Date(nowValue(now)).toISOString();
  const payload = genesis({ type: 'ftown_account_genesis', version: 1, ownerId, rootId: random(), createdAt,
    device: { endpoint: value, signingPublicKey: signing.publicKey, label: name, approvedAt: createdAt } });
  if (payload.device.endpoint.ownerId !== payload.ownerId) return fail();
  await publicDevice(payload.device);
  return { payload, signature: await sign(payload, signing, TRUST_DOMAIN) };
}
export async function signAccountTransition(value: AccountCheckpoint, signerId: string, signing: AccountSigningIdentity, op: AccountOperation, now = Date.now()): Promise<SignedAccountTransition> {
  const current = checkpoint(value);
  const signer = current.devices.find(item => item.endpoint.id === signerId);
  if (!signer || signer.signingPublicKey !== signing.publicKey) return fail('account_device_revoked');
  if (current.revision >= ACCOUNT_TRUST_LIMITS.maxTransitions) return fail('account_capacity_exceeded');
  const payload = transition({ type: 'ftown_account_transition', version: 1, ownerId: current.ownerId, rootId: current.rootId,
    revision: current.revision + 1, previousHead: current.head, issuedAt: new Date(nowValue(now)).toISOString(), signerId, operation: op });
  apply(current, payload.operation, payload.issuedAt);
  if (payload.operation.type === 'add_device') await publicDevice(payload.operation.device);
  if (payload.operation.type === 'add_bridge') await publicEndpoint(payload.operation.bridge.endpoint);
  return { payload, signature: await sign(payload, signing, TRUST_DOMAIN) };
}
interface VerifiedHistory { history: AccountHistory; states: AccountCheckpoint[] }
async function verifyHistory(value: AccountHistory, now: number): Promise<VerifiedHistory> {
  nowValue(now);
  const history = parseAccountHistory(value);
  const initial = history.genesis.payload;
  if (initial.device.endpoint.ownerId !== initial.ownerId || Date.parse(initial.device.approvedAt) !== Date.parse(initial.createdAt)
    || Date.parse(initial.createdAt) > now + ACCOUNT_TRUST_LIMITS.maxFutureSkewMs) return fail();
  await publicDevice(initial.device);
  await verify(initial, history.genesis.signature, initial.device.signingPublicKey, TRUST_DOMAIN);
  let state: AccountCheckpoint = { version: 1, ownerId: initial.ownerId, rootId: initial.rootId, revision: 0,
    head: await hash(initial), devices: [initial.device], bridges: [], revokedDeviceIds: [], revokedBridgeIds: [] };
  const states = [state];
  let previousTime = Date.parse(initial.createdAt);
  for (const record of history.transitions) {
    const next = record.payload;
    const time = Date.parse(next.issuedAt);
    if (next.ownerId !== state.ownerId || next.rootId !== state.rootId || next.revision !== state.revision + 1 || next.previousHead !== state.head
      || time < previousTime || time > now + ACCOUNT_TRUST_LIMITS.maxFutureSkewMs) return fail();
    const signer = state.devices.find(item => item.endpoint.id === next.signerId);
    if (!signer) return fail('account_device_revoked');
    await verify(next, record.signature, signer.signingPublicKey, TRUST_DOMAIN);
    if (next.operation.type === 'add_device') await publicDevice(next.operation.device);
    if (next.operation.type === 'add_bridge') await publicEndpoint(next.operation.bridge.endpoint);
    state = { ...apply(state, next.operation, next.issuedAt), revision: next.revision, head: await hash(next) };
    states.push(state); previousTime = time;
  }
  return { history, states };
}
export async function verifyAccountHistory(history: AccountHistory, pinned: AccountCheckpoint | null, now = Date.now()): Promise<AccountCheckpoint> {
  if (pinned !== null && (history === null || typeof history !== 'object' || !('genesis' in history))) return fail('account_trust_rollback');
  const result = await verifyHistory(history, now);
  if (pinned !== null) {
    const previous = checkpoint(pinned);
    const match = result.states[previous.revision];
    if (!match || !equal(match, previous)) return fail('account_trust_rollback');
  }
  return result.states[result.states.length - 1];
}
function enrollmentShape(value: unknown): AccountEnrollmentRequest {
  const record = object(value);
  const shared = ['version', 'requestId', 'label', 'challenge', 'expiresAt', 'kind', 'candidate'];
  if (record.version !== 1) return fail();
  const common = { version: 1 as const, requestId: fingerprint(record.requestId), label: label(record.label), challenge: fingerprint(record.challenge), expiresAt: timestamp(record.expiresAt) };
  if (record.kind === 'browser') {
    exact(record, [...shared, 'signingPublicKey', 'signingProof']);
    const parsed = { ...common, kind: 'browser' as const, candidate: endpoint(record.candidate, 'browser'), signingPublicKey: point(record.signingPublicKey), signingProof: string(record.signingProof, 86) };
    bytes(parsed.signingProof, 64);
    if (parsed.candidate.publicKey === parsed.signingPublicKey) return fail();
    return parsed;
  }
  if (record.kind === 'bridge') {
    exact(record, [...shared, 'bridgeId']);
    const bridgeId = token(record.bridgeId);
    return { ...common, kind: 'bridge', bridgeId, candidate: endpoint(record.candidate, 'bridge', bridgeId) };
  }
  return fail();
}
function enrollmentTime(request: AccountEnrollmentRequest, now: number): void {
  nowValue(now);
  const expiry = Date.parse(request.expiresAt);
  if (expiry <= now) return fail('account_enrollment_expired');
  if (expiry > now + ACCOUNT_TRUST_LIMITS.enrollmentLifetimeMs) return fail('account_enrollment_invalid');
}
function unsignedRequest(request: Extract<AccountEnrollmentRequest, { kind: 'browser' }>): Omit<typeof request, 'signingProof'> {
  const { signingProof: _proof, ...unsigned } = request;
  return unsigned;
}
export async function parseAccountEnrollmentRequest(value: unknown, now = Date.now()): Promise<AccountEnrollmentRequest> {
  try {
    const parsed = enrollmentShape(value);
    enrollmentTime(parsed, now);
    await publicEndpoint(parsed.candidate);
    if (parsed.kind === 'browser') await verify(unsignedRequest(parsed), parsed.signingProof, parsed.signingPublicKey, ENROLL_DOMAIN);
    return parsed;
  } catch (error) {
    if (error instanceof AccountTrustError && error.code === 'account_enrollment_expired') throw error;
    return fail('account_enrollment_invalid');
  }
}
export async function createAccountEnrollment(identity: EndpointIdentity, name: string, signing: AccountSigningIdentity | null, bridgeId: string | null, now = Date.now()): Promise<AccountEnrollmentLink> {
  try {
    const common = { version: 1 as const, requestId: random(), challenge: random(), label: label(name), expiresAt: new Date(nowValue(now) + ACCOUNT_TRUST_LIMITS.enrollmentLifetimeMs).toISOString() };
    let request: AccountEnrollmentRequest;
    if (bridgeId !== null) {
      if (signing !== null) return fail();
      request = { ...common, kind: 'bridge', candidate: endpoint(identity.endpoint, 'bridge', token(bridgeId)), bridgeId };
    } else {
      if (!signing) return fail();
      const unsigned = { ...common, kind: 'browser' as const, candidate: endpoint(identity.endpoint, 'browser'), signingPublicKey: point(signing.publicKey) };
      request = { ...unsigned, signingProof: await sign(unsigned, signing, ENROLL_DOMAIN) };
    }
    if (await exportPublicKey(identity.keyPair.publicKey) !== request.candidate.publicKey || identity.keyPair.privateKey.algorithm.name !== 'ECDH'
      || !identity.keyPair.privateKey.usages.includes('deriveBits')) return fail();
    return { request: await parseAccountEnrollmentRequest(request, now), secret: random() };
  } catch (error) {
    if (error instanceof AccountTrustError && error.code === 'account_enrollment_expired') throw error;
    return fail('account_enrollment_invalid');
  }
}
function linkShape(value: unknown): AccountEnrollmentLink {
  const record = exact(value, ['request', 'secret']);
  return { request: enrollmentShape(record.request), secret: fingerprint(record.secret) };
}
export function encodeAccountEnrollmentLink(link: AccountEnrollmentLink): string {
  try {
    const data = utf8(JSON.stringify(linkShape(link)));
    if (data.byteLength > MAX_LINK_BYTES) return fail();
    return b64(data);
  } catch { return fail('account_enrollment_invalid'); }
}
export async function parseAccountEnrollmentLink(value: unknown, now = Date.now()): Promise<AccountEnrollmentLink> {
  try {
    let decoded = value;
    if (typeof value === 'string') {
      if (value.length > Math.ceil(MAX_LINK_BYTES * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return fail();
      const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
      if (binary.length > MAX_LINK_BYTES) return fail();
      const data = Uint8Array.from(binary, character => character.charCodeAt(0));
      if (b64(data) !== value) return fail();
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    }
    const link = linkShape(decoded);
    link.request = await parseAccountEnrollmentRequest(link.request, now);
    return link;
  } catch (error) {
    if (error instanceof AccountTrustError && error.code === 'account_enrollment_expired') throw error;
    return fail('account_enrollment_invalid');
  }
}
export async function accountComparisonCode(link: AccountEnrollmentLink): Promise<string> {
  try {
    const parsed = linkShape(link);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', canonicalBytes(COMPARISON_DOMAIN, parsed)));
    const hex = Array.from(digest.slice(0, 6), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
  } catch { return fail('account_enrollment_invalid'); }
}
function normalizedCandidate(request: AccountEnrollmentRequest, ownerId: string): EndpointPublic {
  if (request.kind === 'browser' && request.candidate.ownerId !== ownerId) return fail('account_enrollment_invalid');
  return { ...request.candidate, ownerId };
}
function member(state: AccountCheckpoint, request: AccountEnrollmentRequest): void {
  const candidate = normalizedCandidate(request, state.ownerId);
  if (request.kind === 'browser') {
    const found = state.devices.find(item => item.endpoint.id === candidate.id);
    if (!found || !equal(found.endpoint, candidate) || found.signingPublicKey !== request.signingPublicKey || found.label !== request.label) return fail('account_device_revoked');
  } else {
    const found = state.bridges.find(item => item.bridgeId === request.bridgeId);
    if (!found || !equal(found.endpoint, candidate) || found.label !== request.label) return fail('account_bridge_revoked');
  }
}
type ProofPlaintext = Omit<AccountApprovalPlaintext, 'secretProof'>;
async function secretKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes(secret, 32), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
const proofBytes = (plaintext: ProofPlaintext, approver: EndpointPublic) => canonicalBytes(BOOTSTRAP_DOMAIN, { ...plaintext, approver });
function bundleShape(value: unknown): AccountEnrollmentBundle {
  const record = exact(value, ['version', 'requestId', 'ownerId', 'approver', 'envelope']);
  if (record.version !== 1) return fail();
  return { version: 1, requestId: fingerprint(record.requestId), ownerId: owner(record.ownerId), approver: endpoint(record.approver, 'browser'), envelope: parseSecureEnvelope(record.envelope) };
}
export async function sealAccountApproval(approver: EndpointIdentity, link: AccountEnrollmentLink, history: AccountHistory, now = Date.now()): Promise<AccountEnrollmentBundle> {
  try {
    const parsed = await parseAccountEnrollmentLink(link, now);
    const state = await verifyAccountHistory(history, null, now);
    const activeApprover = state.devices.find(item => item.endpoint.id === approver.endpoint.id);
    if (!activeApprover || !equal(activeApprover.endpoint, approver.endpoint)) return fail();
    member(state, parsed.request);
    const plaintext: ProofPlaintext = { type: 'ftown_account_approval', version: 1, request: parsed.request,
      ownerId: state.ownerId, head: { rootId: state.rootId, revision: state.revision, head: state.head }, approvedAt: new Date(now).toISOString() };
    const secretProof = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await secretKey(parsed.secret, 'sign'), proofBytes(plaintext, approver.endpoint))));
    const request = parsed.request;
    const envelope = await seal(approver, normalizedCandidate(request, state.ownerId), {
      type: 'ftown_encrypted', version: 1, ownerId: state.ownerId, bridgeId: request.kind === 'bridge' ? request.bridgeId : `account_${state.ownerId}`,
      channel: `account-enrollment:${request.requestId}`, purpose: 'enrolled', senderId: approver.endpoint.id, recipientId: request.candidate.id,
      messageId: request.requestId, createdAt: now, expiresAt: Math.min(now + 120000, Date.parse(request.expiresAt)), receiverEpoch: null,
    }, utf8(JSON.stringify({ ...plaintext, secretProof } satisfies AccountApprovalPlaintext)));
    return { version: 1, requestId: request.requestId, ownerId: state.ownerId, approver: { ...approver.endpoint }, envelope };
  } catch (error) {
    if (error instanceof AccountTrustError) throw error;
    return fail('account_enrollment_invalid');
  }
}
export async function openAccountApproval(candidate: EndpointIdentity, link: AccountEnrollmentLink, bundle: AccountEnrollmentBundle, history: AccountHistory, now = Date.now()): Promise<VerifiedAccountTrust> {
  try {
    const parsed = await parseAccountEnrollmentLink(link, now);
    const received = bundleShape(bundle);
    const request = parsed.request;
    if (!equal(candidate.endpoint, request.candidate) || received.requestId !== request.requestId || received.approver.ownerId !== received.ownerId) return fail();
    const wire = received.envelope;
    if (wire.messageId !== request.requestId || wire.receiverEpoch !== null || wire.createdAt > now + ACCOUNT_TRUST_LIMITS.maxFutureSkewMs
      || wire.expiresAt <= now || wire.expiresAt - wire.createdAt > 120000 || wire.expiresAt > Date.parse(request.expiresAt)) return fail();
    const identity = { ...candidate, endpoint: normalizedCandidate(request, received.ownerId) };
    const data = await open(identity, received.approver, wire, { ownerId: received.ownerId, bridgeId: request.kind === 'bridge' ? request.bridgeId : `account_${received.ownerId}`,
      channel: `account-enrollment:${request.requestId}`, purpose: 'enrolled', recipientId: request.candidate.id });
    if (data.byteLength > MAX_LINK_BYTES) return fail();
    const raw = exact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)), ['type', 'version', 'request', 'ownerId', 'head', 'approvedAt', 'secretProof']);
    if (raw.type !== 'ftown_account_approval' || raw.version !== 1) return fail();
    const plaintext: ProofPlaintext = { type: 'ftown_account_approval', version: 1, request: enrollmentShape(raw.request), ownerId: owner(raw.ownerId), head: head(raw.head), approvedAt: timestamp(raw.approvedAt) };
    if (!equal(plaintext.request, request) || plaintext.ownerId !== received.ownerId || Date.parse(plaintext.approvedAt) > now + ACCOUNT_TRUST_LIMITS.maxFutureSkewMs
      || Date.parse(plaintext.approvedAt) > wire.createdAt || Date.parse(plaintext.approvedAt) >= Date.parse(request.expiresAt)) return fail();
    if (!await crypto.subtle.verify('HMAC', await secretKey(parsed.secret, 'verify'), bytes(raw.secretProof, 32), proofBytes(plaintext, received.approver))) return fail();
    const verified = await verifyHistory(history, now);
    const atApproval = verified.states[plaintext.head.revision];
    if (!atApproval || atApproval.ownerId !== received.ownerId || !equal({ rootId: atApproval.rootId, revision: atApproval.revision, head: atApproval.head }, plaintext.head)) return fail('account_trust_rollback');
    const approverAtApproval = atApproval.devices.find(item => item.endpoint.id === received.approver.id);
    if (!approverAtApproval || !equal(approverAtApproval.endpoint, received.approver)) return fail();
    member(atApproval, request);
    const latest = verified.states[verified.states.length - 1];
    member(latest, request);
    return { history: verified.history, checkpoint: latest };
  } catch (error) {
    if (error instanceof AccountTrustError && ['account_enrollment_expired', 'account_trust_rollback', 'account_device_revoked', 'account_bridge_revoked', 'account_capacity_exceeded'].includes(error.code)) throw error;
    return fail('account_enrollment_invalid');
  }
}
