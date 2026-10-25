import { expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateEndpoint } from '@security/crypto';
import * as account from '@security/account-crypto';
import * as core from '@security/pending-approval-crypto';
import { PendingApprovalStore, pendingCanonical, PENDING_NORMALIZED_EMAIL_SQL } from './pending-approval-store';
import { accountHead, validateApprovalAgainst } from './account-trust-store';
import type { AccountHistory } from '@security/account-protocol';
import type { PendingApprovalState, PendingReviewerAction } from '@security/pending-approval-protocol';

const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const other = '619f68a6-77c1-49f6-ae2d-c5fa169d284b';
const credential = () => randomBytes(32).toString('base64url');
async function fixture(kind: 'browser' | 'bridge' = 'browser') {
  const now = Date.now();
  const admin = await generateEndpoint(owner, 'browser'); const signing = await account.generateAccountSigningIdentity();
  const history: AccountHistory = { genesis: await account.createAccountGenesis(owner, admin.endpoint, signing, 'Admin', now), transitions: [] };
  const checkpoint = await account.verifyAccountHistory(history, null, now);
  const candidate = kind === 'bridge' ? await account.generateAccountBridgeCandidate('fixture-computer') : await generateEndpoint(owner, 'browser');
  const candidateSigning = kind === 'browser' ? await account.generateAccountSigningIdentity() : null;
  const link = await account.createAccountEnrollment(candidate, 'Phone', candidateSigning, kind === 'bridge' ? 'fixture-computer' : null, now);
  const local = await core.createPendingOffer(link.request, admin, signing, history, now);
  const hello = await core.createPendingHello(candidate, local.offer, now);
  const secret = await core.openPendingHello(admin, local, hello.hello, now);
  const offerHash = await core.pendingOfferHash(local.offer); const reveal = { offerHash, contribution: local.contribution };
  const confirmation = await core.createPendingConfirmation(local.offer, hello.secret, reveal, offerHash);
  const transition = await account.signAccountTransition(checkpoint, admin.endpoint.id, signing, link.request.kind === 'browser' ? { type: 'add_device', device: {
    endpoint: candidate.endpoint, signingPublicKey: link.request.signingPublicKey, label: link.request.label, approvedAt: new Date(now).toISOString() } } : { type: 'add_bridge', bridge: {
    bridgeId: link.request.bridgeId, endpoint: { ...candidate.endpoint, ownerId: owner }, label: link.request.label, approvedAt: new Date(now).toISOString() } }, now);
  const approved: AccountHistory = { ...history, transitions: [transition] };
  const result = await core.createPendingResult(admin, local, secret, confirmation, offerHash, approved, now);
  return { now, admin, signing, history, checkpoint, candidate, link, local, hello, offerHash, reveal, confirmation, transition, approved, result };
}
function database(f: Awaited<ReturnType<typeof fixture>>) {
  let row: Record<string, unknown> | null = null; let history = f.history; let checkpoint = f.checkpoint;
  const query = vi.fn(async (text: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
    if (text.startsWith('WITH owner')) return [{ owner_id: owner, email: 'USER@ftown.test' }];
    if (text.startsWith('SELECT root_id')) return [{ history, root_id: checkpoint.rootId, revision: checkpoint.revision, head: checkpoint.head }];
    if (text.startsWith('SELECT * FROM security_pending')) return row ? [structuredClone(row)] : [];
    if (text.startsWith('DELETE')) return [];
    if (text.startsWith('WITH inserted')) {
      row = { request_id: params[0], target_sub: params[1], owner_id: params[2], candidate_token_hash: params[3], create_digest: params[4],
        request: JSON.parse(params[5] as string), state: JSON.parse(params[6] as string), revision: 0, operations: {}, final_head: null,
        refresh_predecessor: null, pair_device_code: params[8], pair_metadata: params[9] === null ? null : JSON.parse(params[9] as string), credential_snapshot: null, expires_at: params[7] };
      return [structuredClone(row)];
    }
    if (text.startsWith('WITH locked')) {
      if (!row || row.revision !== params[1]) return [{ integrity_guard: 1, state: null }];
      if (params[13]) { history = JSON.parse(params[12] as string); checkpoint = await account.verifyAccountHistory(history, null, f.now); }
      const state = JSON.parse(params[3] as string) as PendingApprovalState;
      row = { ...row, owner_id: row.owner_id ?? params[5], state, revision: state.revision,
        operations: { ...(row.operations as object), [params[4] as string]: true }, final_head: params[16] === null ? null : JSON.parse(params[16] as string) };
      return [{ integrity_guard: 1, state }];
    }
    throw new Error('Unexpected isolated adapter query');
  });
  return { query, get row() { return row; }, set row(value) { row = value; }, get history() { return history; }, get checkpoint() { return checkpoint; } };
}
it('real signatures, HPKE and both confirmations produce prospective atomic final; exact lost final reply survives stale head and expired bundle', async () => {
  const f = await fixture(); const db = database(f); let now = f.now; const store = new PendingApprovalStore(db.query, () => now); const candidateToken = credential();
  let state = await store.createBrowser(owner, { request: f.link.request, candidateToken });
  const review = async (action: PendingReviewerAction) => {
    const command = await core.signPendingAction({ type: 'ftown_pending_action', version: 1, requestId: f.link.request.requestId, ownerId: owner,
      signerId: f.admin.endpoint.id, head: accountHead(db.checkpoint), expectedRevision: state.revision, issuedAt: new Date(now).toISOString(), action }, f.signing);
    state = await store.reviewer(owner, f.link.request.requestId, command); return command;
  };
  await review({ type: 'review', offer: f.local.offer });
  state = await store.candidate(f.link.request.requestId, { candidateToken, action: { type: 'hello', expectedRevision: state.revision, hello: f.hello.hello } });
  await review({ type: 'reveal', offerHash: f.offerHash, helloHash: await core.pendingHelloHash(f.hello.hello), reveal: f.reveal });
  state = await store.candidate(f.link.request.requestId, { candidateToken, action: { type: 'confirm', expectedRevision: state.revision, confirmation: f.confirmation } });
  const beforeFinal = structuredClone(db.row);
  const command = await review({ type: 'finish', offerHash: f.offerHash, transition: f.transition, result: f.result });
  expect(state.status).toBe('approved'); expect(db.history.transitions).toHaveLength(1);
  const finalWrite = db.query.mock.calls.find(([text, params]) => text.startsWith('WITH locked') && params[14] === true)!;
  expect(finalWrite[0]).toContain('integrity_guard'); expect(finalWrite[0]).toContain('FOR UPDATE OF h');
  expect(finalWrite[0]).toContain('refresh_predecessor=CASE WHEN $15::boolean');
  expect(finalWrite[0]).toContain("r.xmin::text || ':' || r.ctid::text AS row_version");
  const writes = db.query.mock.calls.filter(([text]) => text.startsWith('WITH locked')).length;
  now += 120001;
  expect(await store.reviewer(owner, f.link.request.requestId, command)).toEqual(state);
  expect(db.history.transitions).toHaveLength(1); expect(db.query.mock.calls.filter(([text]) => text.startsWith('WITH locked'))).toHaveLength(writes);
  let staleRead = true;
  const interleaved = vi.fn(async (text: string, params: unknown[]) => {
    if (staleRead && text.startsWith('SELECT * FROM security_pending')) { staleRead = false; return [beforeFinal!]; }
    return db.query(text, params);
  });
  expect(await new PendingApprovalStore(interleaved, () => now).reviewer(owner, f.link.request.requestId, command)).toEqual(state);
  expect(interleaved.mock.calls.some(([text]) => text.startsWith('WITH locked'))).toBe(false);

  await expect(core.openPendingResult(f.candidate, f.local.offer, f.hello.secret, f.reveal, f.offerHash, f.result, db.history, now)).resolves.toEqual({ status: 'awaiting-delivery-renewal' });
});
it('candidate credentials are hashed, exact create is idempotent, and collision/foreign owner/secret upload fail before mutation', async () => {
  const f = await fixture(); const db = database(f); const store = new PendingApprovalStore(db.query, () => f.now); const candidateToken = credential();
  const input = { request: f.link.request, candidateToken };
  const state = await store.createBrowser(owner, input);
  expect(await store.createBrowser(owner, input)).toEqual(state);
  expect(JSON.stringify(db.query.mock.calls)).not.toContain(candidateToken); expect(JSON.stringify(db.query.mock.calls)).not.toContain(f.link.secret);
  await expect(store.createBrowser(owner, { ...input, candidateToken: credential() })).rejects.toMatchObject({ code: 'account_trust_conflict' });
  await expect(store.createBrowser(other, input)).rejects.toMatchObject({ status: 403 });
  await expect(store.createBrowser(owner, { ...input, secret: f.link.secret })).rejects.toHaveProperty('code');
  await expect(store.candidate(f.link.request.requestId, { candidateToken: credential(), action: { type: 'read' } })).rejects.toMatchObject({ status: 403 });
});
it('anonymous unknown-account start never queries users and exact retry recovers the same private deviceCode without inbox disclosure', async () => {
  const f = await fixture(); const db = database(f); const store = new PendingApprovalStore(db.query, () => f.now);
  const bridge = await account.generateAccountBridgeCandidate('fixture-bridge'); const link = await account.createAccountEnrollment(bridge, 'Computer', null, 'fixture-bridge', f.now);
  if (link.request.kind !== 'bridge') throw new Error('fixture');
  const input = { approvalMethod: 'pending-v1' as const, accountHint: ' UNKNOWN@ftown.test ', candidateToken: credential(), enrollment: link.request,
    bridgeId: 'fixture-bridge', hostname: 'Computer', platform: 'linux' };
  const first = await store.startBridge(input); const second = await store.startBridge(input);
  expect(second).toEqual(first); expect(db.query.mock.calls.every(([text]) => !text.includes('FROM users'))).toBe(true);
  expect(pendingCanonical(first.state)).not.toContain(first.pair.deviceCode); expect(pendingCanonical(first.state)).not.toContain(input.candidateToken);
});
it('normalized routing rejects ambiguous or foreign immutable UUID and SQL uses ASCII trim/fold, never locale lower', async () => {
  expect(PENDING_NORMALIZED_EMAIL_SQL).toContain('translate(btrim(email'); expect(PENDING_NORMALIZED_EMAIL_SQL).not.toContain('lower(');
  for (const rows of [[], [{ owner_id: other, email: 'user@ftown.test' }], [{ owner_id: owner, email: 'User@ftown.test' }, { owner_id: other, email: 'user@ftown.test' }]]) {
    await expect(new PendingApprovalStore(vi.fn().mockResolvedValue(rows)).ownerTarget(owner)).rejects.toMatchObject({ code: 'account_trust_conflict' });
  }
});
it('unsigned/cross-request/stale competing reviewer messages cannot advance state; cancellation is exact-idempotent and terminal', async () => {
  const f = await fixture(); const db = database(f); const store = new PendingApprovalStore(db.query, () => f.now); const candidateToken = credential();
  await store.createBrowser(owner, { request: f.link.request, candidateToken });
  await expect(store.reviewer(owner, f.link.request.requestId, { action: { type: 'reject' } })).rejects.toHaveProperty('code');
  const command = await core.signPendingAction({ type: 'ftown_pending_action', version: 1, requestId: f.link.request.requestId, ownerId: owner,
    signerId: f.admin.endpoint.id, head: accountHead(f.checkpoint), expectedRevision: 1, issuedAt: new Date(f.now).toISOString(), action: { type: 'review', offer: f.local.offer } }, f.signing);
  await expect(store.reviewer(owner, f.link.request.requestId, command)).rejects.toMatchObject({ code: 'account_trust_conflict' });
  const cancel = { candidateToken, action: { type: 'cancel', expectedRevision: 0 } };
  const cancelled = await store.candidate(f.link.request.requestId, cancel); expect(cancelled.status).toBe('cancelled');
  expect(await store.candidate(f.link.request.requestId, cancel)).toEqual(cancelled);
  await expect(store.candidate(f.link.request.requestId, { candidateToken, action: { type: 'cancel', expectedRevision: 1 } })).rejects.toMatchObject({ code: 'account_trust_conflict' });
});
it('prospective approval validator performs no database read and rejects missing membership or wrong signed owner', async () => {
  const f = await fixture(); const checkpoint = await account.verifyAccountHistory(f.approved, null, f.now);
  await expect(validateApprovalAgainst(owner, f.link.request, f.result.bundle, { history: f.approved, checkpoint }, { now: f.now })).resolves.toMatchObject({ head: accountHead(checkpoint) });
  await expect(validateApprovalAgainst(owner, f.link.request, f.result.bundle, { history: f.history, checkpoint: f.checkpoint }, { now: f.now })).rejects.toMatchObject({ code: 'account_device_revoked' });
  await expect(validateApprovalAgainst(other, f.link.request, f.result.bundle, { history: f.approved, checkpoint }, { now: f.now })).rejects.toMatchObject({ status: 403 });
});

it('first delivery rejects absent/malformed predecessor metadata before credential writes and never exposes the private baseline', async () => {
  const f = await fixture('bridge');
  const checkpoint = await account.verifyAccountHistory(f.approved, null, f.now);
  const base = { request_id: f.link.request.requestId, request: f.link.request, owner_id: owner, target_sub: 'user@ftown.test',
    pair_device_code: credential(), pair_metadata: { hostname: 'Computer' }, credential_snapshot: null,
    state: { request: f.link.request, revision: 5, status: 'approved', offer: f.local.offer, hello: f.hello.hello, reveal: f.reveal, confirmation: f.confirmation, result: f.result },
    expires_at: f.link.request.expiresAt, revision: 5, operations: {} };
  const malformed = [null, undefined, {}, { status: 'absent', extra: true }, { status: 'present', sub: 'other@ftown.test', jti: 'revoked', version: '123:(0,1)' },
    { status: 'present', sub: 'user@ftown.test', jti: 'revoked', version: new Date() }, { status: 'present', sub: 'user@ftown.test', jti: 'revoked', version: 'invalid' }];
  for (const predecessor of malformed) {
    const query = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT * FROM security_pending')) return [{ ...base, refresh_predecessor: predecessor }];
      if (text.startsWith('WITH owner')) return [{ owner_id: owner, email: 'user@ftown.test' }];
      if (text.startsWith('SELECT root_id')) return [{ history: f.approved, root_id: checkpoint.rootId, revision: checkpoint.revision, head: checkpoint.head }];
      if (text.startsWith('SELECT email')) return [{ email: 'user@ftown.test' }];
      throw new Error('Malformed predecessor reached mutation');
    });
    expect(await new PendingApprovalStore(query, () => f.now).deliver(base.pair_device_code, 23456)).toEqual({ status: 'denied' });
    expect(query.mock.calls.some(([text]) => text.startsWith('WITH locked'))).toBe(false);
  }
});
it('credential query distinguishes missing-row insertion from exact predecessor version update; no unconditional upsert can revive a later JTI', async () => {
  const f = await fixture('bridge');
  const checkpoint = await account.verifyAccountHistory(f.approved, null, f.now);
  const approved = { request: f.link.request, revision: 5, status: 'approved', offer: f.local.offer, hello: f.hello.hello, reveal: f.reveal, confirmation: f.confirmation, result: f.result };
  const predecessor = { status: 'present', sub: 'user@ftown.test', jti: 'revoked', version: '123:(0,1)' };
  const query = vi.fn(async (text: string, params: unknown[]) => {
    if (text.startsWith('SELECT * FROM security_pending')) return [{ request: f.link.request, state: approved, owner_id: owner, request_id: f.link.request.requestId,
      pair_metadata: { hostname: 'Computer' }, expires_at: f.link.request.expiresAt, credential_snapshot: null, refresh_predecessor: predecessor }];
    if (text.startsWith('WITH owner')) return [{ owner_id: owner, email: 'user@ftown.test' }];
    if (text.startsWith('SELECT root_id')) return [{ history: f.approved, root_id: checkpoint.rootId, revision: checkpoint.revision, head: checkpoint.head }];
    if (text.startsWith('SELECT email')) return [{ email: 'user@ftown.test' }];
    if (text.startsWith('WITH locked')) return [{ snapshot: JSON.parse(params[1] as string) }];
    throw new Error('Unexpected query');
  });
  const delivered = await new PendingApprovalStore(query, () => f.now).deliver('private-code', 23456);
  expect('snapshot' in delivered).toBe(true);
  const [sql] = query.mock.calls.find(([text]) => text.startsWith('WITH locked'))!;
  expect(sql).toContain('ON CONFLICT(bridge_id) DO NOTHING');
  expect(sql).not.toContain('DO UPDATE');
  expect(sql).toContain("'version',r.xmin::text || ':' || r.ctid::text");
  expect(sql).toContain("p.refresh_predecessor=jsonb_build_object('status','absent') AND NOT EXISTS(SELECT 1 FROM refresh)");
  expect(sql).toContain('(r=0 AND c=0 AND s=0) OR (n=1 AND r=1 AND c=1 AND s=1)');
  expect(pendingCanonical(approved)).not.toContain(predecessor.version);
});
