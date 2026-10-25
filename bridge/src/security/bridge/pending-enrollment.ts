import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createAccountEnrollment, encodeAccountEnrollmentLink, generateAccountBridgeCandidate, importAccountBridgeCandidate,
  parseAccountEnrollmentLink, verifyAccountHistory } from '../account-crypto.js';
import type { AccountEnrollmentLink, VerifiedAccountTrust } from '../account-protocol.js';
import type { EndpointIdentity } from '../protocol.js';
import { AtomicSnapshot } from './snapshot.js';
import { endpointSchema } from './metadata.js';
import { identityRecordSchema } from './identity.js';
import { importEndpoint } from '../crypto.js';
import { BridgeSecurityError } from './errors.js';
import { accountReadUrl } from './account-client.js';

const pendingSchema = z.object({ version: z.literal(1), bridgeId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  endpoint: endpointSchema, privateKey: identityRecordSchema.shape.privateKey,
  link: z.custom<AccountEnrollmentLink>(), verificationUrl: z.string().max(4096).nullable() }).strict();
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
    encodeAccountEnrollmentLink(saved.link);
    return saved;
  }
  catch { throw new BridgeSecurityError('account_storage_unavailable'); }
}
export async function prepareBridgeEnrollment(dataDir: string, bridgeId: string, label: string, now = Date.now()): Promise<PendingBridgeEnrollment> {
  const existing = await readPending(dataDir);
  if (existing && existing.bridgeId !== bridgeId) throw new BridgeSecurityError('wrong_context');
  const unexpired = existing && typeof existing.link?.request?.expiresAt === 'string' && Date.parse(existing.link.request.expiresAt) > now;
  let initial = existing;
  if (!unexpired) {
    // Expiring a request rotates its challenge/secret, never the pending bridge point.
    // Approval may already exist remotely even when its response was lost.
    const identity = existing ? await importAccountBridgeCandidate(existing.endpoint, existing.privateKey, false)
      : await generateAccountBridgeCandidate(bridgeId, true);
    initial = pendingSchema.parse({ version: 1, bridgeId, endpoint: identity.endpoint,
      privateKey: existing?.privateKey ?? await crypto.subtle.exportKey('jwk', identity.keyPair.privateKey),
      link: await createAccountEnrollment(identity, label.slice(0, 200), null, bridgeId, now), verificationUrl: null });
  }
  const store = new AtomicSnapshot(pendingPath(dataDir), pendingSchema, () => initial!);
  const saved = await store.transact(state => {
    if (!unexpired && existing) Object.assign(state, initial);
    return state;
  });
  const link = await parseAccountEnrollmentLink(saved.link, now);
  if (link.request.kind !== 'bridge' || link.request.bridgeId !== bridgeId || link.request.candidate.id !== saved.endpoint.id
    || link.request.candidate.publicKey !== saved.endpoint.publicKey || link.request.candidate.ownerId !== saved.endpoint.ownerId) throw new BridgeSecurityError('account_enrollment_invalid');
  return { identity: await importAccountBridgeCandidate(saved.endpoint, saved.privateKey, false), link };
}
/** URL is constructed from operator configuration, never a service-provided redirect. */
export async function savePairingVerificationUrl(dataDir: string, apiUrl: string, userCode: string): Promise<string> {
  accountReadUrl(apiUrl);
  if (!/^[A-Za-z0-9-]{1,100}$/.test(userCode)) throw new BridgeSecurityError('account_enrollment_invalid');
  const url = new URL('/pair', apiUrl); url.searchParams.set('code', userCode);
  const existing = await readPending(dataDir);
  if (!existing) throw new BridgeSecurityError('account_enrollment_invalid');
  const store = new AtomicSnapshot(pendingPath(dataDir), pendingSchema, () => existing);
  await store.transact(state => { state.verificationUrl = url.href; });
  return url.href;
}
export async function pendingPairingLink(dataDir: string, now = Date.now()): Promise<string> {
  const saved = await readPending(dataDir);
  if (!saved?.verificationUrl) throw new BridgeSecurityError('account_enrollment_invalid');
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
