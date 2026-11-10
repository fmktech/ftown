/*
 * OS-local keys of a ledger (v2) bridge: `<dataDir>/security/ledger-identity.json`, version 2.
 * - An ECDH P-256 endpoint key (HPKE) and an ECDSA P-256 auth key (AuthProof), both stored as JWK, file mode 0600.
 * - Before pairing the file has keys but no endpoint; bindLedgerIdentity sets {version:1, id, ownerId: accountId, kind:'bridge',
 *   publicKey} exactly once and never rebinds to another account.
 * - Absence alone creates keys. A corrupted or unreadable file is never replaced: it throws BridgeSecurityError('key_unavailable').
 * - Solo and --local keep their v1 `security/bridge-identity.json` (identity.ts); this module never reads, writes or deletes it, except
 *   for hasLegacyAccountState, which only reads its owner to tell a v1 ACCOUNT identity from a Solo one.
 * - Writers are serialized within this process; across processes the bridge's single-instance guarantee is relied on (creation is
 *   still exclusive via link(2), but two processes binding at once could each believe they won).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { link, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { exportPublicKey, importPublicKey } from '../crypto.js';
import { generateAuthKey } from '../ledger/proof.js';
import type { EndpointPublic } from '../protocol.js';
import { BridgeSecurityError } from './errors.js';
import { endpointSchema } from './metadata.js';

export interface LedgerBridgeIdentity {
  /** ECDH P-256 endpoint key pair for HPKE; the private key is non-extractable. */
  keyPair: CryptoKeyPair;
  /** Raw uncompressed ECDH point, base64url: BridgePairRequest.endpointPublicKey. */
  endpointPublicKey: string;
  /** base64url SHA-256 of the raw endpoint point: EndpointPublic.id. */
  endpointId: string;
  /** Raw uncompressed ECDSA point, base64url: BridgePairRequest/LedgerBridge.authPublicKey. */
  authPublicKey: string;
  /** Non-extractable ECDSA P-256 signing key for signAuthProof. */
  authPrivateKey: CryptoKey;
  /** The bound endpoint, or null before pairing. With `keyPair` it is the bridge's EndpointIdentity. */
  endpoint: EndpointPublic | null;
  /** endpoint.ownerId once bound, else null. */
  accountId: string | null;
}

/** What is on disk, without importing keys. A corrupted file throws BridgeSecurityError('key_unavailable'). */
export type LedgerIdentityFileInfo = { state: 'absent'; accountId: null } | { state: 'ready'; accountId: string | null };

const FILE_NAME = 'ledger-identity.json';
const MAX_FILE_BYTES = 64 * 1024;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;
/** v1 account-mode state (never Solo's): any of these means the data dir still holds a v1 account bridge. */
const LEGACY_ACCOUNT_FILES = [
  ['refresh-token'], ['security', 'account-enrollment.json'], ['security', 'pending-approval-status.json'],
  ['security', 'pending-approval-confirmation.json'],
];
const TEMPORARY = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

const jwkSchema = z.strictObject({
  kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().max(64), y: z.string().max(64), d: z.string().max(64),
  key_ops: z.array(z.string().max(32)).max(8).optional(), ext: z.boolean().optional(),
});
const pointSchema = z.string().regex(/^[A-Za-z0-9_-]{87}$/);
const recordSchema = z.strictObject({
  version: z.literal(2),
  endpoint: endpointSchema.optional(),
  privateKey: jwkSchema,
  endpointPublicKey: pointSchema,
  authPublicKey: pointSchema,
  authPrivateKey: jwkSchema,
}).superRefine((record, context) => {
  if (record.endpointPublicKey === record.authPublicKey) context.addIssue({ code: 'custom', message: 'Shared identity key' });
  const endpoint = record.endpoint;
  if (endpoint !== undefined && (endpoint.kind !== 'bridge' || endpoint.publicKey !== record.endpointPublicKey || !isAccountId(endpoint.ownerId))) {
    context.addIssue({ code: 'custom', message: 'Invalid bound endpoint' });
  }
});
type IdentityRecord = z.infer<typeof recordSchema>;

const queues = new Map<string, Promise<void>>();
const swept = new Set<string>();

/** Canonical unpadded base64url of exactly 32 bytes: the accountId syntax. */
function isAccountId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const raw = Buffer.from(value, 'base64url');
  return raw.length === 32 && raw.toString('base64url') === value;
}
function identityFile(dataDir: string): string {
  return resolve(join(dataDir, 'security', FILE_NAME));
}
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
/** Operations on one file run one at a time within this process. */
function serialized<T>(file: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(run);
  const settled = next.then(() => undefined, () => undefined);
  queues.set(file, settled);
  void settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
  return next;
}
/** Once per process: removes `<file>.<uuid>.tmp` left by a crash mid-write. Runs inside the file's queue, so no own write is in flight. */
async function sweepTemporaries(file: string): Promise<void> {
  if (swept.has(file)) return;
  swept.add(file);
  const prefix = basename(file);
  let names: string[];
  try { names = await readdir(dirname(file)); } catch { return; }
  for (const name of names) {
    if (name.indexOf(prefix) === 0 && TEMPORARY.test(name.slice(prefix.length))) await rm(join(dirname(file), name), { force: true }).catch(() => undefined);
  }
}

/** null when absent; every other read failure is key_unavailable. */
async function readText(file: string): Promise<string | null> {
  let handle;
  try { handle = await open(file, 'r'); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new BridgeSecurityError('key_unavailable');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Unexpected identity file');
    return await handle.readFile('utf8');
  } catch {
    throw new BridgeSecurityError('key_unavailable');
  } finally {
    await handle.close();
  }
}
function parseRecord(text: string): IdentityRecord {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new BridgeSecurityError('key_unavailable'); }
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new BridgeSecurityError('key_unavailable');
  return parsed.data;
}
async function readRecord(file: string): Promise<IdentityRecord | null> {
  const text = await readText(file);
  return text === null ? null : parseRecord(text);
}
async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try { handle = await open(directory, 'r'); } catch { return; }
  try { await handle.sync(); } catch { /* directory fsync is unsupported on some platforms */ } finally { await handle.close(); }
}
/**
 * Writes a complete 0600 file next to the target, then publishes it atomically: `link` when `exclusive` (never replaces an existing
 * identity; returns false if one appeared meanwhile), else `rename` (replace). Throws storage_unavailable on any failure.
 */
async function publish(file: string, record: IdentityRecord, exclusive: boolean): Promise<boolean> {
  const directory = dirname(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(recordSchema.parse(record))); await handle.sync(); }
    finally { await handle.close(); }
    if (exclusive) {
      try { await link(temporary, file); }
      catch (error) {
        if (errorCode(error) === 'EEXIST') return false;
        throw error;
      }
    } else {
      await rename(temporary, file);
    }
  } catch {
    throw new BridgeSecurityError('storage_unavailable');
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  await syncDirectory(directory);
  return true;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}
async function generateRecord(): Promise<IdentityRecord> {
  try {
    const endpoint = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
    const auth = await generateAuthKey(true);
    return recordSchema.parse({
      version: 2,
      privateKey: await crypto.subtle.exportKey('jwk', endpoint.privateKey),
      endpointPublicKey: await exportPublicKey(endpoint.publicKey),
      authPublicKey: auth.publicKey,
      authPrivateKey: await crypto.subtle.exportKey('jwk', auth.privateKey),
    });
  } catch {
    throw new BridgeSecurityError('key_unavailable');
  }
}
/** Imports both keys non-extractable and proves each private key belongs to its pinned public point. */
async function importRecord(record: IdentityRecord): Promise<LedgerBridgeIdentity> {
  try {
    const endpointPublic = await importPublicKey(record.endpointPublicKey);
    const endpointJwk = await crypto.subtle.exportKey('jwk', endpointPublic);
    if (record.privateKey.x !== endpointJwk.x || record.privateKey.y !== endpointJwk.y) throw new Error('Endpoint key mismatch');
    const endpointPrivate = await crypto.subtle.importKey('jwk', record.privateKey, ECDH, false, ['deriveBits']);
    // WebCrypto may trust the supplied public coordinates of a JWK: prove the private scalar by a fresh exchange.
    const probe = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
    const left = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: probe.publicKey }, endpointPrivate, 256));
    const right = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: endpointPublic }, probe.privateKey, 256));
    if (!sameBytes(left, right)) throw new Error('Endpoint key mismatch');

    const authRaw = Buffer.from(record.authPublicKey, 'base64url');
    if (authRaw.length !== 65 || authRaw[0] !== 4 || authRaw.toString('base64url') !== record.authPublicKey) throw new Error('Auth key');
    const authPublic = await crypto.subtle.importKey('raw', new Uint8Array(authRaw), ECDSA, true, ['verify']);
    const authJwk = await crypto.subtle.exportKey('jwk', authPublic);
    if (record.authPrivateKey.x !== authJwk.x || record.authPrivateKey.y !== authJwk.y) throw new Error('Auth key mismatch');
    const authPrivateKey = await crypto.subtle.importKey('jwk', record.authPrivateKey, ECDSA, false, ['sign']);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign(SIGN, authPrivateKey, challenge);
    if (!await crypto.subtle.verify(SIGN, authPublic, signature, challenge)) throw new Error('Auth key mismatch');

    const endpointRaw = new Uint8Array(Buffer.from(record.endpointPublicKey, 'base64url'));
    const endpointId = Buffer.from(await crypto.subtle.digest('SHA-256', endpointRaw)).toString('base64url');
    const endpoint = record.endpoint === undefined ? null : { ...record.endpoint };
    if (endpoint !== null && endpoint.id !== endpointId) throw new Error('Endpoint id mismatch');
    return {
      keyPair: { publicKey: endpointPublic, privateKey: endpointPrivate }, endpointPublicKey: record.endpointPublicKey, endpointId,
      authPublicKey: record.authPublicKey, authPrivateKey, endpoint, accountId: endpoint === null ? null : endpoint.ownerId,
    };
  } catch {
    throw new BridgeSecurityError('key_unavailable');
  }
}

/** Reports the v2 identity file's state without importing keys. Throws BridgeSecurityError('key_unavailable') for a corrupted file. */
export async function inspectIdentityFile(dataDir: string): Promise<LedgerIdentityFileInfo> {
  const record = await readRecord(identityFile(dataDir));
  if (record === null) return { state: 'absent', accountId: null };
  return { state: 'ready', accountId: record.endpoint === undefined ? null : record.endpoint.ownerId };
}

/**
 * True iff the data dir holds v1 ACCOUNT state: `refresh-token`, `security/account-enrollment.json`,
 * `security/pending-approval-status.json` or `security/pending-approval-confirmation.json` exists, or `security/bridge-identity.json`
 * has a readable endpoint owner that is not `solo:` (Solo's identity is never reported). An unreadable bridge-identity.json is not
 * reported: its owner cannot be told apart from Solo's. Reads only; never modifies anything.
 */
export function hasLegacyAccountState(dataDir: string): boolean {
  if (LEGACY_ACCOUNT_FILES.some(parts => existsSync(join(dataDir, ...parts)))) return true;
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(dataDir, 'security', 'bridge-identity.json'), 'utf8')); } catch { return false; }
  if (typeof value !== 'object' || value === null || !('endpoint' in value)) return false;
  const endpoint = value.endpoint;
  if (typeof endpoint !== 'object' || endpoint === null || !('ownerId' in endpoint) || typeof endpoint.ownerId !== 'string') return false;
  return endpoint.ownerId.length > 0 && endpoint.ownerId.indexOf('solo:') !== 0;
}

/** Loads the identity without creating one: null when absent. Throws BridgeSecurityError('key_unavailable') for a corrupted file. */
export function readLedgerIdentity(dataDir: string): Promise<LedgerBridgeIdentity | null> {
  const file = identityFile(dataDir);
  return serialized(file, async () => {
    await sweepTemporaries(file);
    const record = await readRecord(file);
    return record === null ? null : importRecord(record);
  });
}

/**
 * Loads the identity, creating fresh keys only when the file is absent. Throws BridgeSecurityError: key_unavailable for an unreadable
 * or corrupted file (never replaced), storage_unavailable when the new file cannot be written.
 */
export function loadOrCreateLedgerIdentity(dataDir: string): Promise<LedgerBridgeIdentity> {
  const file = identityFile(dataDir);
  return serialized(file, async () => {
    await sweepTemporaries(file);
    const existing = await readRecord(file);
    if (existing !== null) return importRecord(existing);
    const created = await generateRecord();
    if (await publish(file, created, true)) return importRecord(created);
    // Another process created it between the read and the link: use theirs.
    const raced = await readRecord(file);
    if (raced === null) throw new BridgeSecurityError('key_unavailable');
    return importRecord(raced);
  });
}

/**
 * Binds the identity to `accountId` once: sets endpoint {version:1, id, ownerId: accountId, kind:'bridge', publicKey}. Idempotent for
 * the same account. Throws BridgeSecurityError: wrong_context for a different (or malformed) accountId, key_unavailable when there is
 * no valid identity to bind, storage_unavailable when the file cannot be written. Binds are serialized within this process only: the
 * bridge's single-instance guarantee keeps a second process from binding concurrently.
 */
export function bindLedgerIdentity(dataDir: string, accountId: string): Promise<LedgerBridgeIdentity> {
  if (!isAccountId(accountId)) return Promise.reject(new BridgeSecurityError('wrong_context'));
  const file = identityFile(dataDir);
  return serialized(file, async () => {
    await sweepTemporaries(file);
    const record = await readRecord(file);
    if (record === null) throw new BridgeSecurityError('key_unavailable');
    const identity = await importRecord(record);
    if (identity.accountId !== null) {
      if (identity.accountId !== accountId) throw new BridgeSecurityError('wrong_context');
      return identity;
    }
    const endpoint: EndpointPublic = { version: 1, id: identity.endpointId, ownerId: accountId, kind: 'bridge', publicKey: identity.endpointPublicKey };
    await publish(file, { ...record, endpoint }, false);
    return { ...identity, endpoint: { ...endpoint }, accountId };
  });
}
