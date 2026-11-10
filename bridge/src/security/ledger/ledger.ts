import type { EndpointPublic } from '../protocol.js';
import { AUTHORITY_CONSENT_DOMAIN, LEDGER_DOMAIN, LEDGER_LIMITS, SIGNIN_DOMAIN } from './protocol.js';
import type {
  Ledger, LedgerAuthority, LedgerBridge, LedgerCheckpoint, LedgerDevice, LedgerGenesis,
  LedgerOperation, LedgerTransition, PasskeySignature, Signed,
} from './protocol.js';
import { verifyPasskeyAssertion } from './webauthn.js';

export type LedgerErrorCode = 'invalid_ledger' | 'ledger_other_account' | 'ledger_revoked' | 'ledger_limit';
/** 'keep' and 'adopt' imply the candidate's payloads belong to a valid chain, so its ledgerRevocations may be merged; 'reject' does not. */
export interface LedgerChoice { decision: 'adopt' | 'keep' | 'reject'; checkpoint: LedgerCheckpoint; discarded: Signed<LedgerTransition>[] }
/** A checkpoint that verifyLedger or chooseLedger returned for the local chain whose last head is `head`. */
export interface LedgerCache { head: string; checkpoint: LedgerCheckpoint }

const messages: { readonly [code in LedgerErrorCode]: string } = {
  invalid_ledger: 'Account ledger could not be verified.',
  ledger_other_account: 'Account ledger entry belongs to a different account.',
  ledger_revoked: 'Account ledger entry refers to a revoked key.',
  ledger_limit: 'Account ledger reached its supported capacity.',
};

/** No untrusted text, key material or underlying crypto error enters this error. */
export class LedgerError extends Error {
  constructor(readonly code: LedgerErrorCode) {
    super(messages[code]);
    this.name = 'LedgerError';
  }
}

const encoder = new TextEncoder();
const MAX_TIME = 253402300799999;
const MAX_ORIGINS = 16;
const MAX_ORIGIN_LENGTH = 512;
const MAX_CREDENTIAL_ID_BYTES = 1023;
const MAX_AUTHENTICATOR_DATA_BYTES = 4096;
const MAX_CLIENT_DATA_BYTES = 4096;
const MAX_DER_SIGNATURE_BYTES = 72;
const MAX_STICKY_IDS = 8 * LEDGER_LIMITS.maxTransitions;

/** A parsed chain with the head of every record; nothing about it is verified yet. */
interface Indexed { ledger: Ledger; accountId: string; heads: string[]; head: string }

function fail(code: LedgerErrorCode = 'invalid_ledger'): never {
  throw new LedgerError(code);
}
function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  // Any realm's Object.prototype or null; class instances and exotic prototypes are refused.
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
function object(value: unknown): Record<string, unknown> {
  return isPlain(value) ? value : fail();
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = object(value);
  const own = Object.keys(record);
  if (own.length !== keys.length || own.some(key => keys.indexOf(key) === -1)) return fail();
  return record;
}
function each<T>(value: unknown, max: number, parse: (item: unknown) => T, code: LedgerErrorCode = 'invalid_ledger'): T[] {
  if (!Array.isArray(value)) return fail();
  const items: readonly unknown[] = value;
  if (items.length > max) return fail(code);
  const result: T[] = [];
  for (let index = 0; index < items.length; index += 1) result.push(parse(items[index]));
  return result;
}
function string(value: unknown, max: number): string {
  return typeof value === 'string' && value.length <= max ? value : fail();
}
function b64url(data: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < data.length; index += 1) binary += String.fromCharCode(data[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Canonical unpadded base64url only; the length bound is checked before decoding. */
function decode(value: unknown, min: number, max: number): Uint8Array<ArrayBuffer> {
  const text = string(value, Math.ceil(max * 4 / 3));
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return fail();
  let binary: string;
  try { binary = atob(text.replace(/-/g, '+').replace(/_/g, '/')); } catch { return fail(); }
  if (binary.length < min || binary.length > max) return fail();
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  if (b64url(result) !== text) return fail();
  return result;
}
const fingerprint = (value: unknown): string => b64url(decode(value, 32, 32));
const credential = (value: unknown): string => b64url(decode(value, 1, MAX_CREDENTIAL_ID_BYTES));
function point(value: unknown): string {
  const raw = decode(value, 65, 65);
  return raw[0] === 4 ? b64url(raw) : fail();
}
function token(value: unknown): string {
  const text = string(value, 200);
  return /^[A-Za-z0-9_-]{1,200}$/.test(text) ? text : fail();
}
function label(value: unknown): string {
  const text = string(value, LEDGER_LIMITS.maxLabelLength);
  // C0/C1 controls, zero-width and bidi controls, BOM, unpaired surrogates: refused, never silently rewritten in a signed label.
  return /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\ud800-\udfff]/u.test(text) ? fail() : text;
}
function time(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME ? value : fail();
}
function count(value: unknown, min: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= LEDGER_LIMITS.maxTransitions ? value : fail();
}
function relyingParty(value: unknown): string {
  const text = string(value, 253);
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(text) ? text : fail();
}
/** A serialized origin exactly as URL.origin prints it: https, or http only for localhost. */
function origin(value: unknown): string {
  const text = string(value, MAX_ORIGIN_LENGTH);
  let url: URL;
  try { url = new URL(text); } catch { return fail(); }
  if (url.origin !== text) return fail();
  return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost') ? text : fail();
}
function parseSignature(value: unknown): PasskeySignature {
  const record = exact(value, ['authenticatorData', 'clientDataJSON', 'signature']);
  return {
    authenticatorData: b64url(decode(record.authenticatorData, 37, MAX_AUTHENTICATOR_DATA_BYTES)),
    clientDataJSON: b64url(decode(record.clientDataJSON, 1, MAX_CLIENT_DATA_BYTES)),
    signature: b64url(decode(record.signature, 8, MAX_DER_SIGNATURE_BYTES)),
  };
}
function parseEndpoint(value: unknown, kind: 'browser' | 'bridge'): EndpointPublic {
  const record = exact(value, ['version', 'id', 'ownerId', 'kind', 'publicKey']);
  if (record.version !== 1 || record.kind !== kind) return fail();
  return { version: 1, id: fingerprint(record.id), ownerId: fingerprint(record.ownerId), kind, publicKey: point(record.publicKey) };
}
function parseAuthority(value: unknown): LedgerAuthority {
  const record = exact(value, ['credentialId', 'publicKey', 'label', 'addedAt']);
  return { credentialId: credential(record.credentialId), publicKey: point(record.publicKey), label: label(record.label), addedAt: time(record.addedAt) };
}
function parseDevice(value: unknown): LedgerDevice {
  const record = exact(value, ['endpoint', 'authPublicKey', 'label', 'approvedAt']);
  const parsed = { endpoint: parseEndpoint(record.endpoint, 'browser'), authPublicKey: point(record.authPublicKey), label: label(record.label), approvedAt: time(record.approvedAt) };
  return parsed.authPublicKey === parsed.endpoint.publicKey ? fail() : parsed;
}
function parseBridge(value: unknown): LedgerBridge {
  const record = exact(value, ['bridgeId', 'endpoint', 'authPublicKey', 'label', 'approvedAt']);
  const parsed = {
    bridgeId: token(record.bridgeId), endpoint: parseEndpoint(record.endpoint, 'bridge'),
    authPublicKey: point(record.authPublicKey), label: label(record.label), approvedAt: time(record.approvedAt),
  };
  return parsed.authPublicKey === parsed.endpoint.publicKey ? fail() : parsed;
}
function parseOperation(value: unknown): LedgerOperation {
  const record = object(value);
  switch (record.type) {
    case 'add_device': return { type: 'add_device', device: parseDevice(exact(record, ['type', 'device']).device) };
    case 'revoke_device': return { type: 'revoke_device', endpointId: fingerprint(exact(record, ['type', 'endpointId']).endpointId) };
    case 'add_bridge': return { type: 'add_bridge', bridge: parseBridge(exact(record, ['type', 'bridge']).bridge) };
    case 'revoke_bridge': return { type: 'revoke_bridge', bridgeId: token(exact(record, ['type', 'bridgeId']).bridgeId) };
    case 'add_authority': {
      const fields = exact(record, ['type', 'authority', 'consent']);
      return { type: 'add_authority', authority: parseAuthority(fields.authority), consent: parseSignature(fields.consent) };
    }
    default: return fail();
  }
}
function parseGenesis(value: unknown): LedgerGenesis {
  const record = exact(value, ['type', 'version', 'rpId', 'origins', 'handle', 'createdAt', 'authority']);
  if (record.type !== 'ftown_account_genesis' || record.version !== 2) return fail();
  const origins = each(record.origins, MAX_ORIGINS, origin);
  if (!origins.length || origins.some((item, index) => origins.indexOf(item) !== index)) return fail();
  return {
    type: 'ftown_account_genesis', version: 2, rpId: relyingParty(record.rpId), origins,
    handle: fingerprint(record.handle), createdAt: time(record.createdAt), authority: parseAuthority(record.authority),
  };
}
function parseTransition(value: unknown): LedgerTransition {
  const record = exact(value, ['type', 'version', 'accountId', 'revision', 'previousHead', 'issuedAt', 'credentialId', 'operation']);
  if (record.type !== 'ftown_account_transition' || record.version !== 2) return fail();
  return {
    type: 'ftown_account_transition', version: 2, accountId: fingerprint(record.accountId), revision: count(record.revision, 1),
    previousHead: fingerprint(record.previousHead), issuedAt: time(record.issuedAt), credentialId: credential(record.credentialId),
    operation: parseOperation(record.operation),
  };
}
function parseSigned<T>(value: unknown, parse: (value: unknown) => T): Signed<T> {
  const record = exact(value, ['payload', 'signature']);
  return { payload: parse(record.payload), signature: parseSignature(record.signature) };
}
function parseCheckpoint(value: unknown): LedgerCheckpoint {
  const record = exact(value, ['version', 'accountId', 'revision', 'head', 'authorities', 'devices', 'bridges', 'revokedDeviceIds', 'revokedBridgeIds']);
  if (record.version !== 2) return fail();
  const authorities = each(record.authorities, LEDGER_LIMITS.maxAuthorities, parseAuthority, 'ledger_limit');
  if (!authorities.length) return fail();
  return {
    version: 2, accountId: fingerprint(record.accountId), revision: count(record.revision, 0), head: fingerprint(record.head), authorities,
    devices: each(record.devices, LEDGER_LIMITS.maxDevices, parseDevice, 'ledger_limit'),
    bridges: each(record.bridges, LEDGER_LIMITS.maxBridges, parseBridge, 'ledger_limit'),
    revokedDeviceIds: each(record.revokedDeviceIds, LEDGER_LIMITS.maxTransitions, fingerprint, 'ledger_limit'),
    revokedBridgeIds: each(record.revokedBridgeIds, LEDGER_LIMITS.maxTransitions, token, 'ledger_limit'),
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : fail();
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return `[${items.map(canonical).join(',')}]`;
  }
  const record = object(value);
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}
async function importable(raw: string, name: 'ECDH' | 'ECDSA'): Promise<void> {
  try {
    await crypto.subtle.importKey('raw', decode(raw, 65, 65), { name, namedCurve: 'P-256' }, false, name === 'ECDSA' ? ['verify'] : []);
  } catch { fail(); }
}
/** The asynchronous checks of new key material: endpoint id = SHA-256(point), every point on P-256. */
async function keyMaterial(operation: LedgerOperation): Promise<void> {
  if (operation.type === 'add_authority') return importable(operation.authority.publicKey, 'ECDSA');
  if (operation.type !== 'add_device' && operation.type !== 'add_bridge') return;
  const member = operation.type === 'add_device' ? operation.device : operation.bridge;
  if (b64url(await sha256(decode(member.endpoint.publicKey, 65, 65))) !== member.endpoint.id) fail();
  await importable(member.endpoint.publicKey, 'ECDH');
  await importable(member.authPublicKey, 'ECDSA');
}

function signerOf(state: LedgerCheckpoint, credentialId: string): LedgerAuthority {
  for (const item of state.authorities) if (item.credentialId === credentialId) return item;
  return fail();
}
/** Shared rules of add_device and add_bridge; keys are never shared between roster members or between a member's two keys. */
function admit(state: LedgerCheckpoint, endpoint: EndpointPublic, authPublicKey: string, approvedAt: number, issuedAt: number): void {
  if (endpoint.ownerId !== state.accountId) fail('ledger_other_account');
  if (approvedAt > issuedAt) fail();
  if (state.revokedDeviceIds.indexOf(endpoint.id) !== -1) fail('ledger_revoked');
  const members: { endpoint: EndpointPublic; authPublicKey: string }[] = [...state.devices, ...state.bridges];
  const keys = [endpoint.publicKey, authPublicKey];
  if (members.some(item => item.endpoint.id === endpoint.id
    || keys.indexOf(item.endpoint.publicKey) !== -1 || keys.indexOf(item.authPublicKey) !== -1)) fail();
}
function apply(current: LedgerCheckpoint, operation: LedgerOperation, issuedAt: number): LedgerCheckpoint {
  const next: LedgerCheckpoint = {
    ...current, authorities: current.authorities.slice(), devices: current.devices.slice(), bridges: current.bridges.slice(),
    revokedDeviceIds: current.revokedDeviceIds.slice(), revokedBridgeIds: current.revokedBridgeIds.slice(),
  };
  switch (operation.type) {
    case 'add_device': {
      const added = operation.device;
      admit(next, added.endpoint, added.authPublicKey, added.approvedAt, issuedAt);
      if (next.devices.length >= LEDGER_LIMITS.maxDevices) fail('ledger_limit');
      next.devices.push(added);
      break;
    }
    case 'add_bridge': {
      const added = operation.bridge;
      admit(next, added.endpoint, added.authPublicKey, added.approvedAt, issuedAt);
      if (next.revokedBridgeIds.indexOf(added.bridgeId) !== -1) fail('ledger_revoked');
      if (next.bridges.some(item => item.bridgeId === added.bridgeId)) fail();
      if (next.bridges.length >= LEDGER_LIMITS.maxBridges) fail('ledger_limit');
      next.bridges.push(added);
      break;
    }
    case 'revoke_device': {
      const index = next.devices.findIndex(item => item.endpoint.id === operation.endpointId);
      if (index === -1) fail(next.revokedDeviceIds.indexOf(operation.endpointId) !== -1 ? 'ledger_revoked' : 'invalid_ledger');
      next.devices.splice(index, 1);
      next.revokedDeviceIds.push(operation.endpointId);
      break;
    }
    case 'revoke_bridge': {
      const index = next.bridges.findIndex(item => item.bridgeId === operation.bridgeId);
      if (index === -1) fail(next.revokedBridgeIds.indexOf(operation.bridgeId) !== -1 ? 'ledger_revoked' : 'invalid_ledger');
      next.bridges.splice(index, 1);
      next.revokedBridgeIds.push(operation.bridgeId);
      break;
    }
    case 'add_authority': {
      const added = operation.authority;
      if (added.addedAt > issuedAt) fail();
      if (next.authorities.some(item => item.credentialId === added.credentialId || item.publicKey === added.publicKey)) fail();
      if (next.authorities.length >= LEDGER_LIMITS.maxAuthorities) fail('ledger_limit');
      next.authorities.push(added);
      break;
    }
    default: return fail();
  }
  return next;
}
function copyOf(state: LedgerCheckpoint): LedgerCheckpoint {
  return {
    version: 2, accountId: state.accountId, revision: state.revision, head: state.head,
    authorities: state.authorities.slice(), devices: state.devices.slice(), bridges: state.bridges.slice(),
    revokedDeviceIds: state.revokedDeviceIds.slice(), revokedBridgeIds: state.revokedBridgeIds.slice(),
  };
}

/** The added passkey's own assertion that it joins THIS account; every path that applies add_authority goes through extend and here. */
async function consented(operation: Extract<LedgerOperation, { type: 'add_authority' }>, accountId: string, root: LedgerGenesis): Promise<void> {
  const challenge = await authorityConsentChallenge(accountId, operation.authority);
  if (!await verifyPasskeyAssertion({ rpId: root.rpId, origins: root.origins, publicKey: operation.authority.publicKey, challenge, signature: operation.consent })) fail();
}
/** Verifies `records` in order on top of a verified `state` whose last record was issued at `previousTime`. */
async function extend(state: LedgerCheckpoint, root: LedgerGenesis, previousTime: number, records: Signed<LedgerTransition>[], at: number): Promise<LedgerCheckpoint> {
  let current = state;
  let lastTime = previousTime;
  for (const record of records) {
    const payload = record.payload;
    if (payload.accountId !== current.accountId) fail('ledger_other_account');
    if (payload.revision !== current.revision + 1) fail();
    if (payload.previousHead !== current.head) fail();
    if (payload.issuedAt < lastTime || payload.issuedAt > at + LEDGER_LIMITS.maxFutureSkewMs) fail();
    const signer = signerOf(current, payload.credentialId);
    const challenge = await ledgerChallenge(payload);
    if (!await verifyPasskeyAssertion({ rpId: root.rpId, origins: root.origins, publicKey: signer.publicKey, challenge, signature: record.signature })) fail();
    await keyMaterial(payload.operation);
    if (payload.operation.type === 'add_authority') await consented(payload.operation, current.accountId, root);
    current = { ...apply(current, payload.operation, payload.issuedAt), revision: payload.revision, head: b64url(challenge) };
    lastTime = payload.issuedAt;
  }
  return current;
}
async function verifyAll(ledger: Ledger, at: number): Promise<LedgerCheckpoint> {
  const root = ledger.genesis.payload;
  if (root.createdAt > at + LEDGER_LIMITS.maxFutureSkewMs || root.authority.addedAt > root.createdAt) fail();
  await importable(root.authority.publicKey, 'ECDSA');
  const challenge = await ledgerChallenge(root);
  if (!await verifyPasskeyAssertion({ rpId: root.rpId, origins: root.origins, publicKey: root.authority.publicKey, challenge, signature: ledger.genesis.signature })) fail();
  const accountId = b64url(challenge);
  const initial: LedgerCheckpoint = {
    version: 2, accountId, revision: 0, head: accountId, authorities: [root.authority], devices: [], bridges: [], revokedDeviceIds: [], revokedBridgeIds: [],
  };
  return extend(initial, root, root.createdAt, ledger.transitions, at);
}
/** Unexpected (non-ledger) failures become invalid_ledger. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    return fail();
  }
}
async function indexed(value: unknown): Promise<Indexed> {
  const ledger = parseLedger(value);
  const accountId = await ledgerHead(ledger.genesis.payload);
  const heads: string[] = [];
  for (const record of ledger.transitions) heads.push(await ledgerHead(record.payload));
  return { ledger, accountId, heads, head: heads.length ? heads[heads.length - 1] : accountId };
}
/** The cache vouches for `chain` only if it names the chain's last head and the chain is hash-linked up to it. */
function vouched(chain: Indexed, cache: LedgerCache | undefined): LedgerCheckpoint | null {
  if (cache === undefined) return null;
  try {
    const record = object(cache);
    const checkpoint = parseCheckpoint(record.checkpoint);
    if (record.head !== chain.head || checkpoint.head !== chain.head || checkpoint.accountId !== chain.accountId
      || checkpoint.revision !== chain.heads.length) return null;
    for (let index = 0; index < chain.heads.length; index += 1) {
      const payload = chain.ledger.transitions[index].payload;
      if (payload.revision !== index + 1 || payload.previousHead !== (index === 0 ? chain.accountId : chain.heads[index - 1])) return null;
    }
    return checkpoint;
  } catch {
    return null;
  }
}
function sameSignature(left: PasskeySignature, right: PasskeySignature): boolean {
  return left.authenticatorData === right.authenticatorData && left.clientDataJSON === right.clientDataJSON && left.signature === right.signature;
}
/** True iff the genesis and the first `length` records carry byte-identical signatures, so the candidate's prefix is the verified local one. */
function sameRecords(local: Ledger, candidate: Ledger, length: number): boolean {
  if (!sameSignature(local.genesis.signature, candidate.genesis.signature)) return false;
  for (let index = 0; index < length; index += 1) {
    if (!sameSignature(local.transitions[index].signature, candidate.transitions[index].signature)) return false;
  }
  return true;
}
function revocationCount(ledger: Ledger): number {
  let total = 0;
  for (const record of ledger.transitions) {
    const type = record.payload.operation.type;
    if (type === 'revoke_device' || type === 'revoke_bridge') total += 1;
  }
  return total;
}
/** The fork order, strict and total on distinct chains of one account: longer, then more revocations in the whole chain, then the smaller head. */
function outranks(candidate: Indexed, local: Indexed): boolean {
  if (candidate.heads.length !== local.heads.length) return candidate.heads.length > local.heads.length;
  const revocations = revocationCount(candidate.ledger) - revocationCount(local.ledger);
  if (revocations !== 0) return revocations > 0;
  return candidate.head < local.head;
}
function choice(decision: LedgerChoice['decision'], checkpoint: LedgerCheckpoint, discarded: Signed<LedgerTransition>[]): LedgerChoice {
  return { decision, checkpoint: copyOf(checkpoint), discarded };
}

/** SHA-256(UTF-8(LEDGER_DOMAIN + canonical(payload))): the WebAuthn challenge, and the record's head. */
export async function ledgerChallenge(payload: LedgerGenesis | LedgerTransition): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(encoder.encode(LEDGER_DOMAIN + canonical(payload)));
}
export async function ledgerHead(payload: LedgerGenesis | LedgerTransition): Promise<string> {
  return b64url(await ledgerChallenge(payload));
}
export function accountIdOf(genesis: LedgerGenesis): Promise<string> {
  return ledgerHead(genesis);
}
/** SHA-256(UTF-8(SIGNIN_DOMAIN + nonce)): the only sign-in challenge. The domain differs from LEDGER_DOMAIN, so a sign-in assertion
 *  can never double as a ledger record signature. The nonce is a base64url token (22-128 chars); anything else throws invalid_ledger. */
export async function signInChallenge(nonce: string): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) fail();
  return sha256(encoder.encode(SIGNIN_DOMAIN + nonce));
}
/** SHA-256(UTF-8(AUTHORITY_CONSENT_DOMAIN + canonical({accountId, credentialId, publicKey}))): what a passkey signs to consent to
 *  becoming an authority of exactly that account. Throws invalid_ledger on a malformed accountId, credentialId or key. */
export async function authorityConsentChallenge(accountId: string, authority: Pick<LedgerAuthority, 'credentialId' | 'publicKey'>): Promise<Uint8Array<ArrayBuffer>> {
  const bound = { accountId: fingerprint(accountId), credentialId: credential(authority.credentialId), publicKey: point(authority.publicKey) };
  return sha256(encoder.encode(AUTHORITY_CONSENT_DOMAIN + canonical(bound)));
}
/** The issuedAt of the last transition, or the genesis createdAt: the `lastIssuedAt` argument of nextTransition. */
export function ledgerLastIssuedAt(ledger: Ledger): number {
  const last = ledger.transitions[ledger.transitions.length - 1];
  return time(last === undefined ? ledger.genesis.payload.createdAt : last.payload.issuedAt);
}
/** Every device endpoint id and bridgeId revoked anywhere in the chain, in chain order. Only for chains that verified (or that
 *  chooseLedger did not reject): replicas keep the union over all of them and never trust those ids again. Throws on a malformed shape. */
export function ledgerRevocations(ledger: Ledger): { deviceIds: string[]; bridgeIds: string[] } {
  const deviceIds: string[] = [];
  const bridgeIds: string[] = [];
  for (const record of parseLedger(ledger).transitions) {
    const operation = record.payload.operation;
    if (operation.type === 'revoke_device' && deviceIds.indexOf(operation.endpointId) === -1) deviceIds.push(operation.endpointId);
    if (operation.type === 'revoke_bridge' && bridgeIds.indexOf(operation.bridgeId) === -1) bridgeIds.push(operation.bridgeId);
  }
  return { deviceIds, bridgeIds };
}
/** Pure: `checkpoint` with every sticky id removed from devices/bridges and added, de-duplicated, to the revoked lists. Inputs are never
 *  mutated. Every trust decision uses this output. NEVER pass it as the chooseLedger cache: it no longer describes the chain itself. */
export function applyRevocations(checkpoint: LedgerCheckpoint, sticky: { deviceIds: string[]; bridgeIds: string[] }): LedgerCheckpoint {
  const current = parseCheckpoint(checkpoint);
  const record = exact(sticky, ['deviceIds', 'bridgeIds']);
  const deviceIds = new Set(each(record.deviceIds, MAX_STICKY_IDS, fingerprint, 'ledger_limit'));
  const bridgeIds = new Set(each(record.bridgeIds, MAX_STICKY_IDS, token, 'ledger_limit'));
  const revokedDeviceIds = current.revokedDeviceIds.slice();
  deviceIds.forEach(id => { if (revokedDeviceIds.indexOf(id) === -1) revokedDeviceIds.push(id); });
  const revokedBridgeIds = current.revokedBridgeIds.slice();
  bridgeIds.forEach(id => { if (revokedBridgeIds.indexOf(id) === -1) revokedBridgeIds.push(id); });
  return {
    ...current, devices: current.devices.filter(item => !deviceIds.has(item.endpoint.id)), bridges: current.bridges.filter(item => !bridgeIds.has(item.bridgeId)),
    revokedDeviceIds, revokedBridgeIds,
  };
}

/** Strict shape: exact keys, canonical base64url, key lengths, canonical origins, labels and limits.
 *  Returns a rebuilt copy that shares nothing with the input. Throws invalid_ledger, or ledger_limit for size and count. */
export function parseLedger(value: unknown): Ledger {
  const record = exact(value, ['genesis', 'transitions']);
  const ledger: Ledger = {
    genesis: parseSigned(record.genesis, parseGenesis),
    transitions: each(record.transitions, LEDGER_LIMITS.maxTransitions, item => parseSigned(item, parseTransition), 'ledger_limit'),
  };
  if (encoder.encode(JSON.stringify(ledger)).byteLength > LEDGER_LIMITS.maxBytes) return fail('ledger_limit');
  return ledger;
}

/** Verifies ONE chain from genesis and returns its last checkpoint. Every record's passkey signature is checked against an authority of the
 *  PREVIOUS state (genesis: its own authority) with genesis.rpId/origins. Throws LedgerError: invalid_ledger, or a more specific code. */
export async function verifyLedger(ledger: Ledger, now: number = Date.now()): Promise<LedgerCheckpoint> {
  const at = time(now);
  return copyOf(await guarded(() => verifyAll(parseLedger(ledger), at)));
}

/** Fork choice, a pure total order on valid chains of one account: longer wins, then more revoke_device/revoke_bridge records in the
 *  whole chain, then the lexicographically smaller head.
 *  - different genesis or invalid candidate -> 'reject'; equal chain or a prefix of local -> 'keep' (decided from record heads alone)
 *  - otherwise the order decides; when a fork wins, `discarded` lists the local records after the common prefix.
 *  `cache` is the checkpoint of the already-verified local chain; when it vouches for `local`, local signatures and timestamps are not
 *  re-checked, and an extension only has its new records verified. Throws only when `local` is invalid (and not vouched for), or when
 *  `local` is null and the candidate is invalid. */
export async function chooseLedger(local: Ledger | null, candidate: Ledger, now: number = Date.now(), cache?: LedgerCache): Promise<LedgerChoice> {
  const at = time(now);
  if (local === null) return choice('adopt', await guarded(() => verifyAll(parseLedger(candidate), at)), []);
  const mine = await guarded(() => indexed(local));
  const base = vouched(mine, cache) ?? await guarded(() => verifyAll(mine.ledger, at));
  let theirs: Indexed;
  try {
    theirs = await indexed(candidate);
  } catch {
    return choice('reject', base, []);
  }
  if (theirs.accountId !== mine.accountId) return choice('reject', base, []);
  const localLength = mine.heads.length;
  const candidateLength = theirs.heads.length;
  let common = 0;
  while (common < localLength && common < candidateLength && mine.heads[common] === theirs.heads[common]) common += 1;
  if (common === candidateLength) return choice('keep', base, []);
  if (common === localLength && sameRecords(mine.ledger, theirs.ledger, localLength)) {
    try {
      const fresh = theirs.ledger.transitions.slice(localLength);
      return choice('adopt', await extend(base, mine.ledger.genesis.payload, ledgerLastIssuedAt(mine.ledger), fresh, at), []);
    } catch {
      return choice('reject', base, []);
    }
  }
  let winner: LedgerCheckpoint;
  try {
    winner = await verifyAll(theirs.ledger, at);
  } catch {
    return choice('reject', base, []);
  }
  return outranks(theirs, mine) ? choice('adopt', winner, mine.ledger.transitions.slice(common)) : choice('keep', base, []);
}

/** Pure next-payload builder for the signer. Applies the operation to a copy of the checkpoint with the verifier's rules and throws the
 *  same errors. Not checked here (they need async crypto): endpoint id = SHA-256(point), points on the curve, and the add_authority
 *  consent signature (only its shape is checked); verifyLedger enforces all three.
 *  `lastIssuedAt` is the issuedAt of the ledger's last record (see ledgerLastIssuedAt); the result's issuedAt is max(now, lastIssuedAt). */
export function nextTransition(
  checkpoint: LedgerCheckpoint, credentialId: string, operation: LedgerOperation, now: number = Date.now(), lastIssuedAt?: number,
): LedgerTransition {
  const current = parseCheckpoint(checkpoint);
  const signer = signerOf(current, credential(credentialId));
  if (current.revision >= LEDGER_LIMITS.maxTransitions) fail('ledger_limit');
  const at = time(now);
  const issuedAt = lastIssuedAt === undefined ? at : Math.max(at, time(lastIssuedAt));
  if (issuedAt > at + LEDGER_LIMITS.maxFutureSkewMs) fail();
  const parsed = parseOperation(operation);
  apply(current, parsed, issuedAt);
  return {
    type: 'ftown_account_transition', version: 2, accountId: current.accountId, revision: current.revision + 1,
    previousHead: current.head, issuedAt, credentialId: signer.credentialId, operation: parsed,
  };
}
