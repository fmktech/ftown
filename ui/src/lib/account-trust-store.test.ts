import { it, expect, vi } from 'vitest';
import { generateEndpoint } from '@security/crypto';
import { createAccountGenesis, createAccountEnrollment, generateAccountSigningIdentity, sealAccountApproval, signAccountTransition, verifyAccountHistory } from '@security/account-crypto';
import { AccountTrustStore, accountHead } from './account-trust-store';
import type { AccountHistory } from '@security/account-protocol';

const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const other = '619f68a6-77c1-49f6-ae2d-c5fa169d284b';
async function fixture() {
  const now = Date.now();
  const admin = await generateEndpoint(owner, 'browser');
  const signing = await generateAccountSigningIdentity();
  const genesis = await createAccountGenesis(owner, admin.endpoint, signing, 'Admin', now);
  const history: AccountHistory = { genesis, transitions: [] };
  const first = await verifyAccountHistory(history, null, now);
  const candidate = await generateEndpoint(owner, 'browser');
  const candidateSigning = await generateAccountSigningIdentity();
  const link = await createAccountEnrollment(candidate, 'Candidate', candidateSigning, null, now);
  const addition = await signAccountTransition(first, admin.endpoint.id, signing, { type: 'add_device', device: { endpoint: candidate.endpoint, signingPublicKey: candidateSigning.publicKey, label: 'Candidate', approvedAt: new Date(now).toISOString() } }, now);
  const approvedHistory = { genesis, transitions: [addition] };
  const checkpoint = await verifyAccountHistory(approvedHistory, first, now);
  const bundle = await sealAccountApproval(admin, link, approvedHistory, now);
  const dbRow = { root_id: checkpoint.rootId, revision: checkpoint.revision, head: checkpoint.head, history: approvedHistory };
  return { now, admin, signing, genesis, history, first, candidate, link, addition, approvedHistory, checkpoint, bundle, dbRow };
}

it('genesis is verified owner-bound public storage and simultaneous first writers have exactly one CAS winner', async () => {
  const f = await fixture();
  let exists = false;
  const query = vi.fn(async (text: string) => {
    if (text.startsWith('SELECT')) return [];
    if (exists) return [];
    exists = true; return [{ owner_id: owner }];
  });
  const store = new AccountTrustStore(query, () => f.now);
  const outcomes = await Promise.allSettled([store.append(owner, { expectedHead: null, record: f.genesis }), store.append(owner, { expectedHead: null, record: f.genesis })]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const failure = outcomes.find(result => result.status === 'rejected');
  expect(failure?.status === 'rejected' && failure.reason.code).toBe('account_trust_conflict');
  expect(query.mock.calls.some(([text]) => text.includes('ON CONFLICT(owner_id) DO NOTHING'))).toBe(true);
  const foreignQuery = vi.fn().mockResolvedValue([]);
  await expect(new AccountTrustStore(foreignQuery, () => f.now).append(other, { expectedHead: null, record: f.genesis })).rejects.toMatchObject({ code: 'invalid_account_trust' });
  expect(foreignQuery).toHaveBeenCalledTimes(1);
});

it('append verifies prior signatures and conditions write on the exact expected root/revision/head', async () => {
  const f = await fixture();
  const previous = { root_id: f.first.rootId, revision: 0, head: f.first.head, history: f.history };
  const query = vi.fn().mockResolvedValueOnce([previous]).mockResolvedValueOnce([{ owner_id: owner }]);
  const history = await new AccountTrustStore(query, () => f.now).append(owner, { expectedHead: accountHead(f.first), record: f.addition });
  expect(history).toEqual(f.approvedHistory);
  expect(query.mock.calls[1][0]).toContain('AND root_id=$6 AND revision=$7 AND head=$8');
  expect(query.mock.calls[1][1].slice(5)).toEqual([f.first.rootId, 0, f.first.head]);
  const stale = vi.fn().mockResolvedValue([f.dbRow]);
  await expect(new AccountTrustStore(stale, () => f.now).append(owner, { expectedHead: accountHead(f.first), record: f.addition })).rejects.toMatchObject({ code: 'account_trust_conflict' });
  expect(stale).toHaveBeenCalledTimes(1);
  const raced = vi.fn().mockResolvedValueOnce([previous]).mockResolvedValueOnce([]);
  await expect(new AccountTrustStore(raced, () => f.now).append(owner, { expectedHead: accountHead(f.first), record: f.addition })).rejects.toMatchObject({ code: 'account_trust_conflict' });
});

it('reads reject cross-owner, altered signatures and mismatched denormalized metadata', async () => {
  const f = await fixture();
  for (const [id, row] of [[other, f.dbRow], [owner, { ...f.dbRow, head: f.first.head }], [owner, { ...f.dbRow, history: { ...f.approvedHistory, genesis: { ...f.genesis, signature: 'A'.repeat(86) } } }]] as const) {
    const query = vi.fn().mockResolvedValue([row]);
    await expect(new AccountTrustStore(query, () => f.now).read(id)).rejects.toHaveProperty('code');
    expect(query.mock.calls[0][1]).toEqual([id]);
  }
  expect(await new AccountTrustStore(vi.fn().mockResolvedValue([])).read(owner)).toBeNull();
});

it('creation accepts only the authenticated browser public request, excludes secret and uses hard capacity slots', async () => {
  const f = await fixture();
  const query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ request: f.link.request, bundle: null }]);
  await expect(new AccountTrustStore(query, () => f.now).createEnrollment(owner, f.link.request)).resolves.toEqual({ request: f.link.request, status: 'pending', bundle: null });
  expect(query.mock.calls[1][0]).toContain('generate_series(0,127)');
  expect(query.mock.calls[1][0]).toContain('ON CONFLICT DO NOTHING');
  expect(JSON.stringify(query.mock.calls)).not.toContain(f.link.secret);
  await expect(new AccountTrustStore(query, () => f.now).createEnrollment(owner, f.link)).rejects.toMatchObject({ code: 'account_enrollment_invalid' });
  await expect(new AccountTrustStore(query, () => f.now).createEnrollment(other, f.link.request)).rejects.toMatchObject({ code: 'invalid_account_trust', status: 403 });
  expect(query).toHaveBeenCalledTimes(2);
});

it('request collisions never replace a request and full slots fail with explicit capacity', async () => {
  const f = await fixture();
  const altered = { ...f.link.request, label: 'Tampered' };
  const query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ request: altered, bundle: null }]);
  await expect(new AccountTrustStore(query, () => f.now).createEnrollment(owner, f.link.request)).rejects.toMatchObject({ code: 'account_enrollment_invalid' });
  const full = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 128 }]);
  await expect(new AccountTrustStore(full, () => f.now).createEnrollment(owner, f.link.request)).rejects.toMatchObject({ code: 'account_capacity_exceeded' });
});

it('approval rejects public owner/request/candidate/sender/context substitution before storage', async () => {
  const f = await fixture();
  for (const bundle of [
    { ...f.bundle, ownerId: other }, { ...f.bundle, requestId: 'A'.repeat(43) }, { ...f.bundle, secret: f.link.secret },
    { ...f.bundle, approver: f.candidate.endpoint },
    { ...f.bundle, envelope: { ...f.bundle.envelope, recipientId: f.admin.endpoint.id } },
    { ...f.bundle, envelope: { ...f.bundle.envelope, bridgeId: 'other' } },
  ]) {
    const query = vi.fn().mockResolvedValue([f.dbRow]);
    await expect(new AccountTrustStore(query, () => f.now).validateApproval(owner, f.link.request, bundle)).rejects.toHaveProperty('code');
  }
  const result = await new AccountTrustStore(vi.fn().mockResolvedValue([f.dbRow]), () => f.now).validateApproval(owner, f.link.request, f.bundle);
  expect(result.bundle).toEqual(f.bundle);
});

it('approval writes are conditioned on request, previous bundle and the current verified policy head', async () => {
  const f = await fixture();
  const query = vi.fn().mockResolvedValueOnce([{ request: f.link.request, bundle: null }]).mockResolvedValueOnce([f.dbRow]).mockResolvedValueOnce([{ request_id: f.link.request.requestId }]);
  const result = await new AccountTrustStore(query, () => f.now).approveEnrollment(owner, f.link.request.requestId, { requestId: f.link.request.requestId, bundle: f.bundle });
  expect(result.status).toBe('approved');
  expect(query.mock.calls[2][0]).toContain('bundle IS NOT DISTINCT FROM $5::jsonb');
  expect(query.mock.calls[2][1].slice(5)).toEqual([f.checkpoint.rootId, f.checkpoint.revision, f.checkpoint.head]);
  expect(query.mock.calls[2][1][4]).toBeNull();
});

it('same-approver resealing works after response expiry within request TTL; owner lookup never enumerates foreign requests', async () => {
  const f = await fixture();
  const next = await sealAccountApproval(f.admin, f.link, f.approvedHistory, f.now + 120001);
  const query = vi.fn().mockResolvedValueOnce([{ request: f.link.request, bundle: f.bundle }]).mockResolvedValueOnce([f.dbRow]).mockResolvedValueOnce([f.dbRow]).mockResolvedValueOnce([{ request_id: f.link.request.requestId }]);
  await expect(new AccountTrustStore(query, () => f.now + 120001).approveEnrollment(owner, f.link.request.requestId, { requestId: f.link.request.requestId, bundle: next })).resolves.toMatchObject({ status: 'approved', bundle: next });
  const missing = vi.fn().mockResolvedValue([]);
  await expect(new AccountTrustStore(missing, () => f.now).enrollment(other, f.link.request.requestId)).rejects.toMatchObject({ code: 'account_enrollment_invalid' });
  expect(missing.mock.calls[0][1]).toEqual([other, f.link.request.requestId]);
  const expired = vi.fn().mockResolvedValue([{ request: f.link.request, bundle: null }]);
  await expect(new AccountTrustStore(expired, () => f.now + 300000).enrollment(owner, f.link.request.requestId)).rejects.toMatchObject({ code: 'account_enrollment_expired' });
});
