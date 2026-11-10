/*
 * The account ledger, shared by the server, every browser and every bridge (type-checked by the UI build at ES2017).
 * What is written is never rewritten: each record names the head it extends (previousHead) and is signed by an authority of the state before it.
 * A replica adopts another chain of its account only if that chain is valid and strictly extends its own ('ahead'); only the new records are verified.
 * A chain that is the same or behind is kept, and a chain that diverges is never adopted, whatever its length or content.
 * The one way a replica replaces what it holds is the owner's choice: a valid chain carrying a resolve_fork for exactly the fork point, signed by a
 * passkey that was already an authority there, naming a record of the replica's own branch; revocations on the discarded branch are returned to stay enforced.
 * relate, forkPoint and relateHead classify two chains from record heads alone (ledgerHeads), with no signature work.
 */
import type { EndpointPublic } from '../protocol.js';
import { AUTHORITY_CONSENT_DOMAIN, LEDGER_DOMAIN, LEDGER_LIMITS, SIGNIN_DOMAIN } from './protocol.js';
import type {
  Ledger, LedgerAuthority, LedgerBridge, LedgerCheckpoint, LedgerDevice, LedgerGenesis,
  LedgerOperation, LedgerTransition, PasskeySignature, Signed,
} from './protocol.js';
import { verifyPasskeyAssertion } from './webauthn.js';

export type LedgerErrorCode = 'invalid_ledger' | 'ledger_other_account' | 'ledger_revoked' | 'ledger_limit';
/** How a candidate chain relates to the local one, from record heads alone (see relate). */
export type LedgerRelation = 'same' | 'ahead' | 'behind' | 'diverged';
/** relateHead: what a bare `{ revision, head }` of another replica says about it. 'unknown' (ahead, diverged or another account) needs its chain. */
export type LedgerHeadRelation = 'same' | 'behind' | 'unknown';
/** The last record two chains share. Revision 0 is the genesis, whose head is the accountId. */
export interface LedgerForkPoint { revision: number; head: string }
/** What an adopted resolve_fork discarded from the local chain: its records after the fork point, in chain order, and the device endpoint ids /
 *  bridgeIds those records revoke that the adopted chain does not. The caller adds the ids to its sticky set. Empty unless a diverged chain was adopted. */
export interface LedgerDiscarded { records: Signed<LedgerTransition>[]; deviceIds: string[]; bridgeIds: string[] }
/** chooseLedger's verdict. `checkpoint` is the RAW checkpoint of the chain to hold afterwards: the candidate's on 'adopt', local's otherwise.
 *  `relation` is null only when there is none: no local chain (first bind), or a candidate that is malformed or of another account.
 *  'keep' + 'diverged' = a VALID different history (alert the owner); 'reject' = an invalid candidate (ignore it). */
export interface LedgerChoice { decision: 'adopt' | 'keep' | 'reject'; relation: LedgerRelation | null; checkpoint: LedgerCheckpoint; discarded: LedgerDiscarded }
/** A checkpoint that verifyLedger or chooseLedger returned for the local chain whose last head is `head`. */
export interface LedgerCache { head: string; checkpoint: LedgerCheckpoint }
/** describeFork: the last shared record and each side's payloads after it, in chain order (payloads only, no signatures). */
export interface LedgerFork { relation: LedgerRelation; fork: LedgerForkPoint; mine: LedgerTransition[]; theirs: LedgerTransition[] }
type ResolveFork = Extract<LedgerOperation, { type: 'resolve_fork' }>;

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

/** A parsed chain with the head of every record, index = revision (heads[0] is the genesis head = accountId); nothing is verified yet. */
interface Indexed { ledger: Ledger; accountId: string; heads: string[] }
/** What the history rules of resolve_fork need from the chain before a record: every earlier head (index = revision) and the revision at which
 *  each authority joined (authorities are add-only, so "an authority at revision r" is "joined at or before r"). */
interface Trail { heads: string[]; joined: { credentialId: string; revision: number }[] }

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
    case 'resolve_fork': {
      const fields = exact(record, ['type', 'forkHead', 'discardedHead', 'discardedRevision']);
      return {
        type: 'resolve_fork', forkHead: fingerprint(fields.forkHead), discardedHead: fingerprint(fields.discardedHead),
        discardedRevision: count(fields.discardedRevision, 1),
      };
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
    case 'resolve_fork':
      // Membership is unchanged. Only the rules that need no history are here; settle() checks forkHead against the chain itself.
      if (operation.discardedHead === operation.forkHead || operation.discardedHead === next.head || operation.discardedHead === next.accountId) fail();
      break;
    default: return fail();
  }
  return next;
}
function joinedAt(trail: Trail, credentialId: string): number {
  for (const item of trail.joined) if (item.credentialId === credentialId) return item.revision;
  return -1;
}
/** History rules of resolve_fork, against the chain before the record: forkHead is one of its heads, the signer was an authority at it,
 *  the discarded record comes after it, and the discarded record is not part of this chain. */
function settle(trail: Trail, operation: LedgerOperation, credentialId: string): void {
  if (operation.type !== 'resolve_fork') return;
  const fork = trail.heads.indexOf(operation.forkHead);
  if (fork === -1 || operation.discardedRevision <= fork || trail.heads.indexOf(operation.discardedHead) !== -1) fail();
  const joined = joinedAt(trail, credentialId);
  if (joined === -1 || joined > fork) fail();
}
function note(trail: Trail, payload: LedgerTransition, head: string): void {
  trail.heads.push(head);
  if (payload.operation.type === 'add_authority') trail.joined.push({ credentialId: payload.operation.authority.credentialId, revision: payload.revision });
}
function initialState(root: LedgerGenesis, accountId: string): LedgerCheckpoint {
  return { version: 2, accountId, revision: 0, head: accountId, authorities: [root.authority], devices: [], bridges: [], revokedDeviceIds: [], revokedBridgeIds: [] };
}
function initialTrail(root: LedgerGenesis, accountId: string): Trail {
  return { heads: [accountId], joined: [{ credentialId: root.authority.credentialId, revision: 0 }] };
}
/** The trail of the first `length` records of a chain already verified or vouched for; no signature work. */
function trailOf(chain: Indexed, length: number): Trail {
  const trail = initialTrail(chain.ledger.genesis.payload, chain.accountId);
  for (let index = 0; index < length; index += 1) note(trail, chain.ledger.transitions[index].payload, chain.heads[index + 1]);
  return trail;
}
/** The checkpoint after the first `length` records of a chain already verified or vouched for: the verifier's state rules, no signature work. */
function replay(chain: Indexed, length: number): LedgerCheckpoint {
  let state = initialState(chain.ledger.genesis.payload, chain.accountId);
  for (let index = 0; index < length; index += 1) {
    const payload = chain.ledger.transitions[index].payload;
    state = { ...apply(state, payload.operation, payload.issuedAt), revision: payload.revision, head: chain.heads[index + 1] };
  }
  return state;
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
/** Verifies `records` in order on top of a verified `state` whose last record was issued at `previousTime`; `trail` describes the chain up
 *  to `state` and is extended in place. */
async function extend(
  state: LedgerCheckpoint, root: LedgerGenesis, previousTime: number, records: Signed<LedgerTransition>[], at: number, trail: Trail,
): Promise<LedgerCheckpoint> {
  let current = state;
  let lastTime = previousTime;
  for (const record of records) {
    const payload = record.payload;
    if (payload.accountId !== current.accountId) fail('ledger_other_account');
    if (payload.revision !== current.revision + 1) fail();
    if (payload.previousHead !== current.head) fail();
    if (payload.issuedAt < lastTime || payload.issuedAt > at + LEDGER_LIMITS.maxFutureSkewMs) fail();
    const signer = signerOf(current, payload.credentialId);
    settle(trail, payload.operation, signer.credentialId);
    const challenge = await ledgerChallenge(payload);
    if (!await verifyPasskeyAssertion({ rpId: root.rpId, origins: root.origins, publicKey: signer.publicKey, challenge, signature: record.signature })) fail();
    await keyMaterial(payload.operation);
    if (payload.operation.type === 'add_authority') await consented(payload.operation, current.accountId, root);
    const head = b64url(challenge);
    current = { ...apply(current, payload.operation, payload.issuedAt), revision: payload.revision, head };
    note(trail, payload, head);
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
  return extend(initialState(root, accountId), root, root.createdAt, ledger.transitions, at, initialTrail(root, accountId));
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
  const heads = [await ledgerHead(ledger.genesis.payload)];
  for (const record of ledger.transitions) heads.push(await ledgerHead(record.payload));
  return { ledger, accountId: heads[0], heads };
}
/** The cache vouches for `chain` only if it names the chain's last head and the chain is hash-linked up to it. */
function vouched(chain: Indexed, cache: LedgerCache | undefined): LedgerCheckpoint | null {
  if (cache === undefined) return null;
  try {
    const record = object(cache);
    const checkpoint = parseCheckpoint(record.checkpoint);
    const head = chain.heads[chain.heads.length - 1];
    if (record.head !== head || checkpoint.head !== head || checkpoint.accountId !== chain.accountId
      || checkpoint.revision !== chain.heads.length - 1) return null;
    for (let index = 0; index < chain.ledger.transitions.length; index += 1) {
      const payload = chain.ledger.transitions[index].payload;
      if (payload.revision !== index + 1 || payload.previousHead !== chain.heads[index]) return null;
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
/** Index of the first revision whose heads differ, or the shorter length when one list is a prefix of the other. String compares only. */
function firstDifference(local: readonly string[], candidate: readonly string[]): number {
  const length = Math.min(local.length, candidate.length);
  let index = 0;
  while (index < length && local[index] === candidate[index]) index += 1;
  return index;
}
/** null when even the genesis differs (another account). */
function classify(local: readonly string[], candidate: readonly string[]): LedgerRelation | null {
  const index = firstDifference(local, candidate);
  if (index === 0) return null;
  if (index < local.length && index < candidate.length) return 'diverged';
  if (local.length === candidate.length) return 'same';
  return candidate.length > local.length ? 'ahead' : 'behind';
}
function headList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return fail();
  const heads: readonly unknown[] = value;
  if (heads.length < 1 || heads.length > LEDGER_LIMITS.maxTransitions + 1 || heads.some(item => typeof item !== 'string')) return fail();
  return value;
}
/** True iff `operation`, found in one chain, discards the branch of `chain` after `fork`: it names exactly the fork point and a record of that branch. */
function against(operation: ResolveFork, chain: Indexed, fork: number): boolean {
  return operation.forkHead === chain.heads[fork] && operation.discardedRevision > fork && operation.discardedRevision < chain.heads.length
    && chain.heads[operation.discardedRevision] === operation.discardedHead;
}
/** True iff the (verified) diverged candidate carries a resolve_fork after the fork point that discards local's branch. When local's branch holds
 *  its own resolve_fork against the candidate, the candidate's must discard a record at or after the latest one: its signer saw that choice and
 *  overrode it. Two resolutions cannot each have seen the other (hash chaining), so replicas never flip back and forth between them. */
function resolves(mine: Indexed, theirs: Indexed, fork: number): boolean {
  let seen = 0;
  for (let index = fork; index < mine.ledger.transitions.length; index += 1) {
    const payload = mine.ledger.transitions[index].payload;
    if (payload.operation.type === 'resolve_fork' && against(payload.operation, theirs, fork)) seen = payload.revision;
  }
  for (let index = fork; index < theirs.ledger.transitions.length; index += 1) {
    const operation = theirs.ledger.transitions[index].payload.operation;
    if (operation.type === 'resolve_fork' && against(operation, mine, fork) && operation.discardedRevision >= seen) return true;
  }
  return false;
}
/** Local's records after the fork, and the revocations among them that the adopted chain lacks. */
function discardedBy(mine: Indexed, fork: number, adopted: LedgerCheckpoint): LedgerDiscarded {
  const records = mine.ledger.transitions.slice(fork);
  const deviceIds: string[] = [];
  const bridgeIds: string[] = [];
  for (const record of records) {
    const operation = record.payload.operation;
    if (operation.type === 'revoke_device' && adopted.revokedDeviceIds.indexOf(operation.endpointId) === -1) deviceIds.push(operation.endpointId);
    if (operation.type === 'revoke_bridge' && adopted.revokedBridgeIds.indexOf(operation.bridgeId) === -1) bridgeIds.push(operation.bridgeId);
  }
  return { records, deviceIds, bridgeIds };
}
function choice(decision: LedgerChoice['decision'], relation: LedgerRelation | null, checkpoint: LedgerCheckpoint, discarded?: LedgerDiscarded): LedgerChoice {
  return { decision, relation, checkpoint: copyOf(checkpoint), discarded: discarded ?? { records: [], deviceIds: [], bridgeIds: [] } };
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
/** Every device endpoint id and bridgeId revoked anywhere in the chain, in chain order. Only for chains that verified: replicas keep the
 *  union over the chains they held (plus chooseLedger's `discarded` ids) and never trust those ids again. Throws on a malformed shape. */
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

/** The head of every record, index = revision: [accountId, head of revision 1, ..., head of the tip]. O(n) SHA-256 over the parsed chain and no
 *  signature work; compute it once per chain and keep it for relate/forkPoint/relateHead. Throws like parseLedger. */
export async function ledgerHeads(ledger: Ledger): Promise<string[]> {
  return (await guarded(() => indexed(ledger))).heads;
}
/** How `candidate` relates to `local` (both ledgerHeads lists of chains of ONE account): 'same' (identical heads), 'ahead' (candidate strictly
 *  extends local), 'behind' (local strictly extends candidate), 'diverged' (they differ at some revision both have). Pure, O(min(n, m)) string
 *  compares, no hashing. Another account is not a relation: throws ledger_other_account (genesis heads differ); a malformed list throws
 *  invalid_ledger. Every head of the shorter list is compared, so a list whose tip matches but whose middle differs is 'diverged'. */
export function relate(local: readonly string[], candidate: readonly string[]): LedgerRelation {
  const relation = classify(headList(local), headList(candidate));
  return relation === null ? fail('ledger_other_account') : relation;
}
/** The last record `local` and `candidate` (ledgerHeads lists) share, or null when even the genesis differs. Same cost as relate. */
export function forkPoint(local: readonly string[], candidate: readonly string[]): LedgerForkPoint | null {
  const mine = headList(local);
  const index = firstDifference(mine, headList(candidate));
  return index === 0 ? null : { revision: index - 1, head: mine[index - 1] };
}
/** What another replica's bare `{ revision, head }` (an RPC answer or head announcement; other fields ignored) says relative to `local`
 *  (a ledgerHeads list): 'same', 'behind' (local holds that head at that revision and more), or 'unknown' (ahead, diverged or another
 *  account: fetch its chain and run chooseLedger). O(1). Throws invalid_ledger on a malformed head or revision. */
export function relateHead(local: readonly string[], other: { revision: number; head: string }): LedgerHeadRelation {
  const mine = headList(local);
  const record = object(other);
  const revision = count(record.revision, 0);
  const head = fingerprint(record.head);
  if (revision >= mine.length || mine[revision] !== head) return 'unknown';
  return revision === mine.length - 1 ? 'same' : 'behind';
}

/**
 * The append-only acceptance rule, the same on every replica (server, browser, bridge). The candidate's relation decides:
 * - no local chain (first bind): verified from genesis and adopted, relation null; an invalid candidate throws.
 * - malformed or another account: 'reject', relation null.
 * - 'same' / 'behind': 'keep', decided from record heads alone (no candidate signature is checked).
 * - 'ahead': only the records after local's head are verified, on top of local's state -> 'adopt', or 'reject' if any is invalid.
 * - 'diverged': the candidate's records after the fork point are verified on top of the shared prefix -> 'reject' if invalid. It is
 *   'adopt'ed only if it carries a resolve_fork, after the fork point, whose forkHead is exactly this fork point and whose discardedHead is
 *   local's record at discardedRevision (local's tip or an earlier record of its branch), and which saw any resolve_fork of local's branch
 *   against it (see resolves); `discarded` then lists local's records after the fork and the revocations the adopted chain lacks.
 *   Otherwise 'keep': a valid different history is never adopted, whatever its length or content.
 * The shared prefix is not re-verified when the candidate's copy is byte-identical to local's; a copy with other signature bytes is verified
 * with the whole candidate from genesis. `cache` is the checkpoint of the already-verified local chain: when it vouches for `local` (same last
 * head, hash-linked) local is not re-verified, else local is verified from genesis. Throws only when `local` is invalid (and not vouched for),
 * or when `local` is null and the candidate is invalid.
 */
export async function chooseLedger(local: Ledger | null, candidate: Ledger, now: number = Date.now(), cache?: LedgerCache): Promise<LedgerChoice> {
  const at = time(now);
  if (local === null) return choice('adopt', null, await guarded(() => verifyAll(parseLedger(candidate), at)));
  const mine = await guarded(() => indexed(local));
  const base = vouched(mine, cache) ?? await guarded(() => verifyAll(mine.ledger, at));
  let theirs: Indexed;
  try {
    theirs = await indexed(candidate);
  } catch {
    return choice('reject', null, base);
  }
  const relation = classify(mine.heads, theirs.heads);
  if (relation === null) return choice('reject', null, base);
  if (relation === 'same' || relation === 'behind') return choice('keep', relation, base);
  // Revision of the last shared record: local's tip when 'ahead'.
  const fork = firstDifference(mine.heads, theirs.heads) - 1;
  const shared = sameRecords(mine.ledger, theirs.ledger, fork);
  // Local is verified or vouched for, so replaying its prefix can only fail on corrupt local state, which throws like an invalid local.
  const start = !shared ? null : relation === 'ahead' ? base : await guarded(async () => replay(mine, fork));
  let verified: LedgerCheckpoint;
  try {
    const root = mine.ledger.genesis.payload;
    const previousTime = fork === 0 ? root.createdAt : mine.ledger.transitions[fork - 1].payload.issuedAt;
    verified = start === null
      ? await verifyAll(theirs.ledger, at)
      : await extend(start, root, previousTime, theirs.ledger.transitions.slice(fork), at, trailOf(mine, fork));
  } catch {
    return choice('reject', relation, base);
  }
  if (relation === 'ahead') return choice('adopt', relation, verified);
  return resolves(mine, theirs, fork) ? choice('adopt', relation, verified, discardedBy(mine, fork, verified)) : choice('keep', relation, base);
}

/** describeFork(local, other): where the two chains part and each side's payloads after that point, for showing two histories side by side.
 *  Works for any relation of one account (for 'same' both lists are empty). Throws ledger_other_account for another account, else like parseLedger. */
export async function describeFork(local: Ledger, other: Ledger): Promise<LedgerFork> {
  const mine = await guarded(() => indexed(local));
  const theirs = await guarded(() => indexed(other));
  const relation = classify(mine.heads, theirs.heads);
  if (relation === null) return fail('ledger_other_account');
  const revision = firstDifference(mine.heads, theirs.heads) - 1;
  return {
    relation, fork: { revision, head: mine.heads[revision] },
    mine: mine.ledger.transitions.slice(revision).map(record => record.payload),
    theirs: theirs.ledger.transitions.slice(revision).map(record => record.payload),
  };
}

/** The unsigned resolve_fork that keeps `chosen` and discards `other` from their fork point: appended to `chosen`, forkHead = the last shared
 *  record, discardedHead/discardedRevision = other's tip. Verifies `chosen` (skipped when `cache` vouches for it, as in chooseLedger) and
 *  throws invalid_ledger when the chains do not diverge or `credentialId` was not an authority at the fork point (one added on chosen's own
 *  branch cannot discard the other), ledger_other_account for another account, else nextTransition's errors. `other` is not verified. */
export async function resolveForkTransition(
  chosen: Ledger, other: Ledger, credentialId: string, now: number = Date.now(), cache?: LedgerCache,
): Promise<LedgerTransition> {
  const at = time(now);
  const mine = await guarded(() => indexed(chosen));
  const theirs = await guarded(() => indexed(other));
  const relation = classify(mine.heads, theirs.heads);
  if (relation === null) fail('ledger_other_account');
  if (relation !== 'diverged') fail();
  const checkpoint = vouched(mine, cache) ?? await guarded(() => verifyAll(mine.ledger, at));
  const fork = firstDifference(mine.heads, theirs.heads) - 1;
  const signer = credential(credentialId);
  if (joinedAt(trailOf(mine, fork), signer) === -1) fail();
  const operation: LedgerOperation = {
    type: 'resolve_fork', forkHead: mine.heads[fork], discardedHead: theirs.heads[theirs.heads.length - 1], discardedRevision: theirs.heads.length - 1,
  };
  return nextTransition(checkpoint, signer, operation, at, ledgerLastIssuedAt(mine.ledger));
}

/** Pure next-payload builder for the signer. Applies the operation to a copy of the checkpoint with the verifier's rules and throws the
 *  same errors. Not checked here (they need async crypto or the chain): endpoint id = SHA-256(point), points on the curve, the add_authority
 *  consent signature (only its shape is checked) and resolve_fork's forkHead and signer rules (build it with resolveForkTransition);
 *  verifyLedger enforces all of them.
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
