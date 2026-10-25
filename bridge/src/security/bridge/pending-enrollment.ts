import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createAccountEnrollment, encodeAccountEnrollmentLink, generateAccountBridgeCandidate, importAccountBridgeCandidate,
  parseAccountEnrollmentLink, verifyAccountHistory } from '../account-crypto.js';
import type { AccountEnrollmentLink, VerifiedAccountTrust } from '../account-protocol.js';
import type { AccountEnrollmentRequest } from '../account-protocol.js';
import type { PendingHello, PendingOffer } from '../pending-approval-protocol.js';
import { parsePendingOffer, pendingHelloHash, pendingOfferHash } from '../pending-approval-crypto.js';
import type { EndpointIdentity } from '../protocol.js';
import { AtomicSnapshot } from './snapshot.js';
import { endpointSchema } from './metadata.js';
import { identityRecordSchema } from './identity.js';
import { importEndpoint } from '../crypto.js';
import { BridgeSecurityError } from './errors.js';
import { accountReadUrl } from './account-client.js';

const legacySchema = z.object({ version: z.literal(1), bridgeId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  endpoint: endpointSchema, privateKey: identityRecordSchema.shape.privateKey,
  link: z.custom<AccountEnrollmentLink>(), verificationUrl: z.string().max(4096).nullable() }).strict();
const automaticSchema = z.object({ version: z.literal(2), bridgeId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  endpoint: endpointSchema, privateKey: identityRecordSchema.shape.privateKey,
  request: z.custom<Extract<AccountEnrollmentRequest, { kind: 'bridge' }>>(), candidateToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  offer: z.custom<PendingOffer>().nullable(), hello: z.custom<PendingHello>().nullable() }).strict();
const pendingSchema = z.discriminatedUnion('version', [legacySchema, automaticSchema]);
type PendingRecord = z.infer<typeof pendingSchema>;
export interface PendingBridgeEnrollment { identity: EndpointIdentity; link: AccountEnrollmentLink }
const pendingPath = (dataDir: string) => join(dataDir, 'security', 'account-enrollment.json');

async function readPending(dataDir: string): Promise<PendingRecord | null> {
  let raw: string;
  try { raw = await readFile(pendingPath(dataDir), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new BridgeSecurityError('account_storage_unavailable');
  }
  try {
    const saved = pendingSchema.parse(JSON.parse(raw));
    if (saved.version === 1) encodeAccountEnrollmentLink(saved.link);
    else {
      const parsed = await parseAccountEnrollmentLink({ request: saved.request, secret: saved.candidateToken }, Date.parse(saved.request.expiresAt) - 1);
      if (parsed.request.kind !== 'bridge' || parsed.request.bridgeId !== saved.bridgeId) throw new Error('Wrong pending context');
    }
    return saved;
  }
  catch { throw new BridgeSecurityError('account_storage_unavailable'); }
}
export async function previousPendingBridgeAttempt(dataDir: string): Promise<{ requestId: string; candidateToken: string } | null> {
  const existing = await readPending(dataDir);
  return existing?.version === 2 ? { requestId: existing.request.requestId, candidateToken: existing.candidateToken } : null;
}
export async function prepareBridgeEnrollment(dataDir: string, bridgeId: string, label: string, now = Date.now(), fresh = false): Promise<PendingBridgeEnrollment> {
  const existing = await readPending(dataDir);
  if (existing && existing.bridgeId !== bridgeId) throw new BridgeSecurityError('wrong_context');
  const unexpired = !fresh && existing?.version === 1 && Date.parse(existing.link.request.expiresAt) > now;
  let initial = existing;
  if (!unexpired) {
    // Expiring a request rotates its challenge/secret, never the pending bridge point.
    // Approval may already exist remotely even when its response was lost.
    const identity = existing ? await importAccountBridgeCandidate(existing.endpoint, existing.privateKey, false)
      : await generateAccountBridgeCandidate(bridgeId, true);
    initial = legacySchema.parse({ version: 1, bridgeId, endpoint: identity.endpoint,
      privateKey: existing?.privateKey ?? await crypto.subtle.exportKey('jwk', identity.keyPair.privateKey),
      link: await createAccountEnrollment(identity, label.slice(0, 200), null, bridgeId, now), verificationUrl: null });
  }
  const store = new AtomicSnapshot(pendingPath(dataDir), pendingSchema, () => initial!);
  const saved = await store.transact(state => {
    if (!unexpired && existing) {
      for (const key of Object.keys(state)) delete (state as unknown as Record<string, unknown>)[key];
      Object.assign(state, initial);
    }
    return state;
  });
  if (saved.version !== 1) throw new BridgeSecurityError('account_enrollment_invalid');
  const link = await parseAccountEnrollmentLink(saved.link, now);
  if (link.request.kind !== 'bridge' || link.request.bridgeId !== bridgeId || link.request.candidate.id !== saved.endpoint.id
    || link.request.candidate.publicKey !== saved.endpoint.publicKey || link.request.candidate.ownerId !== saved.endpoint.ownerId) throw new BridgeSecurityError('account_enrollment_invalid');
  return { identity: await importAccountBridgeCandidate(saved.endpoint, saved.privateKey, false), link };
}
export interface PendingAutomaticEnrollment {
  identity: EndpointIdentity; request: Extract<AccountEnrollmentRequest, { kind: 'bridge' }>; candidateToken: string;
  previous: { requestId: string; candidateToken: string } | null;
  pinOffer(offer: PendingOffer): Promise<void>;
  pinHello(hello: PendingHello): Promise<void>;
}
/** One fresh process attempt, retaining the long-term point even after cancellation/restart. */
export async function preparePendingBridgeEnrollment(dataDir: string, bridgeId: string, label: string, now = Date.now()): Promise<PendingAutomaticEnrollment> {
  const existing = await readPending(dataDir);
  if (existing && existing.bridgeId !== bridgeId) throw new BridgeSecurityError('wrong_context');
  const identity = existing ? await importAccountBridgeCandidate(existing.endpoint, existing.privateKey, false)
    : await generateAccountBridgeCandidate(bridgeId, true);
  const generated = await createAccountEnrollment(identity, label.slice(0, 200), null, bridgeId, now);
  const record = automaticSchema.parse({ version: 2, bridgeId, endpoint: identity.endpoint,
    privateKey: existing?.privateKey ?? await crypto.subtle.exportKey('jwk', identity.keyPair.privateKey),
    request: generated.request, candidateToken: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), offer: null, hello: null });
  // transact replaces fields in place; its initial state must not alias the source record.
  const store = new AtomicSnapshot(pendingPath(dataDir), pendingSchema, () => structuredClone(record));
  await store.transact(state => {
    for (const key of Object.keys(state)) delete (state as unknown as Record<string, unknown>)[key];
    Object.assign(state, record);
  });
  const current = async (update: (state: z.infer<typeof automaticSchema>) => Promise<void>) => store.transact(async state => {
    if (state.version !== 2 || state.request.requestId !== record.request.requestId || state.candidateToken !== record.candidateToken) throw new BridgeSecurityError('account_trust_conflict');
    await update(state);
  });
  return {
    identity: await importAccountBridgeCandidate(record.endpoint, record.privateKey, false),
    request: record.request, candidateToken: record.candidateToken,
    previous: existing?.version === 2 ? { requestId: existing.request.requestId, candidateToken: existing.candidateToken } : null,
    pinOffer: offer => current(async state => {
      await parsePendingOffer(offer, state.request);
      if (state.offer && await pendingOfferHash(state.offer) !== await pendingOfferHash(offer)) throw new BridgeSecurityError('account_trust_conflict');
      state.offer ??= offer;
    }),
    pinHello: hello => current(async state => {
      if (!state.offer || hello.requestId !== state.request.requestId || hello.offerHash !== await pendingOfferHash(state.offer)) throw new BridgeSecurityError('wrong_context');
      if (state.hello && await pendingHelloHash(state.hello) !== await pendingHelloHash(hello)) throw new BridgeSecurityError('account_trust_conflict');
      state.hello ??= hello;
    }),
  };
}
/** URL is constructed from operator configuration, never a service-provided redirect. */
export async function savePairingVerificationUrl(dataDir: string, apiUrl: string, userCode: string): Promise<string> {
  accountReadUrl(apiUrl);
  if (!/^[A-Za-z0-9-]{1,100}$/.test(userCode)) throw new BridgeSecurityError('account_enrollment_invalid');
  const url = new URL('/pair', apiUrl); url.searchParams.set('code', userCode);
  const existing = await readPending(dataDir);
  if (!existing || existing.version !== 1) throw new BridgeSecurityError('account_enrollment_invalid');
  const store = new AtomicSnapshot(pendingPath(dataDir), pendingSchema, () => existing);
  await store.transact(state => { if (state.version !== 1) throw new BridgeSecurityError('account_trust_conflict'); state.verificationUrl = url.href; });
  return url.href;
}
export async function pendingPairingLink(dataDir: string, now = Date.now()): Promise<string> {
  const saved = await readPending(dataDir);
  if (!saved || saved.version !== 1 || !saved.verificationUrl) throw new BridgeSecurityError('account_enrollment_invalid');
  const link = await parseAccountEnrollmentLink(saved.link, now);
  const url = new URL(saved.verificationUrl);
  accountReadUrl(url.origin);
  if (url.pathname !== '/pair' || url.hash || url.username || url.password || [...url.searchParams.keys()].some(key => key !== 'code')) {
    throw new BridgeSecurityError('account_enrollment_invalid');
  }
  url.hash = `account=${encodeAccountEnrollmentLink(link)}`;
  return url.href;
}
/** Save the normalized SAME private/public key and trusted bootstrap in one durable identity record. */
export async function bindPendingBridgeIdentity(dataDir: string, trust: VerifiedAccountTrust): Promise<EndpointIdentity> {
  const pending = await readPending(dataDir);
  if (!pending) throw new BridgeSecurityError('account_enrollment_invalid');
  const checkpoint = await verifyAccountHistory(trust.history, trust.checkpoint);
  const own = checkpoint.bridges.find(item => item.bridgeId === pending.bridgeId);
  if (!own || own.endpoint.id !== pending.endpoint.id || own.endpoint.publicKey !== pending.endpoint.publicKey) throw new BridgeSecurityError('wrong_context');
  await importAccountBridgeCandidate(pending.endpoint, pending.privateKey, false);
  const record = identityRecordSchema.parse({ version: 1, endpoint: own.endpoint, privateKey: pending.privateKey,
    accountBootstrap: { checkpoint, history: trust.history } });
  const store = new AtomicSnapshot(join(dataDir, 'security', 'bridge-identity.json'), identityRecordSchema, () => record);
  const saved = await store.transact(state => {
    if (state.endpoint.id !== record.endpoint.id || state.endpoint.ownerId !== record.endpoint.ownerId
      || state.endpoint.publicKey !== record.endpoint.publicKey) throw new BridgeSecurityError('wrong_context');
    // A pre-existing bound identity is never repinned by repeating bootstrap.
    if (state.accountBootstrap && state.accountBootstrap.checkpoint.rootId !== checkpoint.rootId) throw new BridgeSecurityError('account_trust_rollback');
    state.accountBootstrap ??= record.accountBootstrap;
    return state;
  });
  return importEndpoint(saved.endpoint, saved.privateKey, false);
}
