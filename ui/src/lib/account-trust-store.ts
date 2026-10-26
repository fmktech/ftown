import { getDb } from '@/lib/db';
import { AccountTrustError, ACCOUNT_TRUST_LIMITS, parseAccountEnrollmentRequest, parseAccountHistory, verifyAccountHistory } from '@security/account-crypto';
import { parseSecureEnvelope } from '@security/crypto';
import type { EndpointPublic } from '@security/protocol';
import type { AccountCheckpoint, AccountEnrollmentBundle, AccountEnrollmentRequest, AccountEnrollmentStatus, AccountHead, AccountHistory } from '@security/account-protocol';

export type AccountQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
export interface VerifiedAccountRow { history: AccountHistory; checkpoint: AccountCheckpoint }
export interface ValidatedAccountApproval extends VerifiedAccountRow { request: AccountEnrollmentRequest; bundle: AccountEnrollmentBundle; head: AccountHead }
export class AccountStoreError extends AccountTrustError { constructor(readonly status: number) { super('invalid_account_trust'); } }
const reject = (code: ConstructorParameters<typeof AccountTrustError>[0] = 'invalid_account_trust'): never => { throw new AccountTrustError(code); };
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return reject();
  return value as Record<string, unknown>;
}
const sameEndpoint = (a: EndpointPublic, b: EndpointPublic) => a.version === b.version && a.id === b.id && a.ownerId === b.ownerId && a.kind === b.kind && a.publicKey === b.publicKey;
function sameRequest(a: AccountEnrollmentRequest, b: AccountEnrollmentRequest): boolean {
  return a.version === b.version && a.requestId === b.requestId && a.kind === b.kind && a.label === b.label && a.challenge === b.challenge && a.expiresAt === b.expiresAt
    && sameEndpoint(a.candidate, b.candidate) && (a.kind === 'browser' && b.kind === 'browser' ? a.signingPublicKey === b.signingPublicKey && a.signingProof === b.signingProof
      : a.kind === 'bridge' && b.kind === 'bridge' && a.bridgeId === b.bridgeId);
}
export const accountHead = (checkpoint: AccountCheckpoint): AccountHead => ({ rootId: checkpoint.rootId, revision: checkpoint.revision, head: checkpoint.head });
function parseHead(value: unknown): AccountHead {
  const parsed = record(value, ['rootId', 'revision', 'head']);
  if (typeof parsed.rootId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(parsed.rootId) || typeof parsed.head !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(parsed.head)
    || typeof parsed.revision !== 'number' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || parsed.revision > ACCOUNT_TRUST_LIMITS.maxTransitions) return reject();
  if (Buffer.from(parsed.rootId, 'base64url').toString('base64url') !== parsed.rootId || Buffer.from(parsed.head, 'base64url').toString('base64url') !== parsed.head) return reject();
  return { rootId: parsed.rootId, revision: parsed.revision, head: parsed.head };
}
const sameHead = (a: AccountHead, b: AccountHead) => a.rootId === b.rootId && a.revision === b.revision && a.head === b.head;

/** Stores public, signed delivery material only; database presence never establishes a trust pin. */
export class AccountTrustStore {
  constructor(private readonly query: AccountQuery = (text, params) => getDb().query(text, params), private readonly now = Date.now) {}
  async readVerified(ownerId: string): Promise<VerifiedAccountRow | null> {
    const rows = await this.query('SELECT root_id,revision,head,history FROM security_account_history WHERE owner_id=$1', [ownerId]);
    if (!rows.length) return null;
    if (rows.length !== 1) return reject('account_storage_unavailable');
    const history = parseAccountHistory(rows[0].history);
    const checkpoint = await verifyAccountHistory(history, null, this.now());
    if (checkpoint.ownerId !== ownerId || checkpoint.rootId !== rows[0].root_id || checkpoint.revision !== rows[0].revision || checkpoint.head !== rows[0].head) return reject('account_storage_unavailable');
    return { history, checkpoint };
  }
  async read(ownerId: string): Promise<AccountHistory | null> { return (await this.readVerified(ownerId))?.history ?? null; }
  async append(ownerId: string, input: unknown): Promise<AccountHistory> {
    const body = record(input, ['expectedHead', 'record']);
    const previous = await this.readVerified(ownerId);
    const expected = body.expectedHead === null ? null : parseHead(body.expectedHead);
    if ((previous === null) !== (expected === null) || (previous && expected && !sameHead(expected, accountHead(previous.checkpoint)))) return reject('account_trust_conflict');
    const history = parseAccountHistory(previous ? { genesis: previous.history.genesis, transitions: [...previous.history.transitions, body.record] } : { genesis: body.record, transitions: [] });
    const checkpoint = await verifyAccountHistory(history, previous?.checkpoint ?? null, this.now());
    if (checkpoint.ownerId !== ownerId) throw new AccountStoreError(403);
    const next = accountHead(checkpoint);
    const rows = previous && expected ? await this.query(`UPDATE security_account_history SET root_id=$2,revision=$3,head=$4,history=$5::jsonb,updated_at=NOW()
      WHERE owner_id=$1 AND root_id=$6 AND revision=$7 AND head=$8 RETURNING owner_id`,
    [ownerId, next.rootId, next.revision, next.head, JSON.stringify(history), expected.rootId, expected.revision, expected.head])
      : await this.query(`INSERT INTO security_account_history(owner_id,root_id,revision,head,history) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(owner_id) DO NOTHING RETURNING owner_id`, [ownerId, next.rootId, next.revision, next.head, JSON.stringify(history)]);
    if (rows.length !== 1) return reject('account_trust_conflict');
    return history;
  }
  async createEnrollment(ownerId: string, input: unknown): Promise<AccountEnrollmentStatus> {
    const request = await parseAccountEnrollmentRequest(input, this.now());
    if (request.kind !== 'browser') return reject('account_enrollment_invalid');
    if (request.candidate.ownerId !== ownerId) throw new AccountStoreError(403);
    // Bounded lazy cleanup. Slots provide a hard per-owner cap even under concurrent inserts.
    await this.query(`DELETE FROM security_account_enrollments WHERE request_id IN
      (SELECT request_id FROM security_account_enrollments WHERE expires_at<=NOW() ORDER BY expires_at LIMIT 1000)`, []);
    const inserted = await this.query(`INSERT INTO security_account_enrollments(owner_id,request_id,request,expires_at,slot)
      SELECT $1,$2,$3::jsonb,$4,s FROM generate_series(0,127) AS s
      WHERE NOT EXISTS(SELECT 1 FROM security_account_enrollments e WHERE e.owner_id=$1 AND e.slot=s)
      ORDER BY s LIMIT 1 ON CONFLICT DO NOTHING RETURNING request,bundle`, [ownerId, request.requestId, JSON.stringify(request), request.expiresAt]);
    if (inserted.length === 1) return { request, status: 'pending', bundle: null };
    const existing = await this.query('SELECT request,bundle FROM security_account_enrollments WHERE owner_id=$1 AND request_id=$2', [ownerId, request.requestId]);
    if (existing.length === 1) {
      const stored = await parseAccountEnrollmentRequest(existing[0].request, this.now());
      if (!sameRequest(stored, request)) return reject('account_trust_conflict');
      return this.enrollment(ownerId, request.requestId);
    }
    const counts = await this.query('SELECT COUNT(*)::int AS count FROM security_account_enrollments WHERE owner_id=$1', [ownerId]);
    return reject(counts[0]?.count === 128 ? 'account_capacity_exceeded' : 'account_trust_conflict');
  }
  async enrollment(ownerId: string, requestId: string): Promise<AccountEnrollmentStatus> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(requestId)) return reject('account_enrollment_invalid');
    const rows = await this.query('SELECT request,bundle FROM security_account_enrollments WHERE owner_id=$1 AND request_id=$2', [ownerId, requestId]);
    if (rows.length !== 1) return reject('account_enrollment_invalid');
    const request = await parseAccountEnrollmentRequest(rows[0].request, this.now());
    if (request.kind !== 'browser' || request.requestId !== requestId || request.candidate.ownerId !== ownerId) return reject('account_storage_unavailable');
    if (rows[0].bundle === null) return { request, status: 'pending', bundle: null };
    const approved = await this.validateApproval(ownerId, request, rows[0].bundle, true, false);
    return { request, status: 'approved', bundle: approved.bundle };
  }
  async approveEnrollment(ownerId: string, requestId: string, input: unknown): Promise<AccountEnrollmentStatus> {
    const body = record(input, ['requestId', 'bundle']);
    if (body.requestId !== requestId) return reject('account_enrollment_invalid');
    const rows = await this.query('SELECT request,bundle FROM security_account_enrollments WHERE owner_id=$1 AND request_id=$2', [ownerId, requestId]);
    if (rows.length !== 1) return reject('account_enrollment_invalid');
    const verified = await this.validateApproval(ownerId, rows[0].request, body.bundle);
    if (verified.request.kind !== 'browser') return reject('account_enrollment_invalid');
    const old = rows[0].bundle;
    if (old !== null) {
      const previous = await this.validateApproval(ownerId, verified.request, old, true, false);
      if (!sameEndpoint(previous.bundle.approver, verified.bundle.approver)) return reject('account_trust_conflict');
    }
    const written = await this.query(`UPDATE security_account_enrollments e SET bundle=$3::jsonb,approved_at=COALESCE(approved_at,NOW())
      WHERE owner_id=$1 AND request_id=$2 AND request=$4::jsonb AND expires_at>NOW()
      AND bundle IS NOT DISTINCT FROM $5::jsonb
      AND EXISTS(SELECT 1 FROM security_account_history h WHERE h.owner_id=$1 AND h.root_id=$6 AND h.revision=$7 AND h.head=$8)
      RETURNING request_id`, [ownerId, requestId, JSON.stringify(verified.bundle), JSON.stringify(verified.request), old === null ? null : JSON.stringify(old), verified.head.rootId, verified.head.revision, verified.head.head]);
    if (written.length !== 1) return reject('account_trust_conflict');
    return { request: verified.request, status: 'approved', bundle: verified.bundle };
  }
  /** Public metadata validation only. The candidate MUST verify encrypted head/HMAC itself. */
  async validateApproval(ownerId: string, inputRequest: unknown, inputBundle: unknown, historicalApprover = false, requireFreshEnvelope = true): Promise<ValidatedAccountApproval> {
    const request = await parseAccountEnrollmentRequest(inputRequest, this.now());
    const current = await this.readVerified(ownerId);
    if (!current) return reject('account_approval_required');
    return validateApprovalAgainst(ownerId, request, inputBundle, current, { historicalApprover, requireFreshEnvelope, now: this.now() });
  }
}

/** Pure prospective validation; the supplied history must already be signature-verified. */
export async function validateApprovalAgainst(ownerId: string, inputRequest: unknown, inputBundle: unknown,
  current: VerifiedAccountRow, options: { historicalApprover?: boolean; requireFreshEnvelope?: boolean; now?: number } = {}): Promise<ValidatedAccountApproval> {
  const now = options.now ?? Date.now();
  if (current.checkpoint.ownerId !== ownerId) throw new AccountStoreError(403);
  const request = await parseAccountEnrollmentRequest(inputRequest, now);
  const value = record(inputBundle, ['version', 'requestId', 'ownerId', 'approver', 'envelope']);
  const approver = record(value.approver, ['version', 'id', 'ownerId', 'kind', 'publicKey']);
  if (value.ownerId !== ownerId) throw new AccountStoreError(403);
  if (value.version !== 1 || value.requestId !== request.requestId) return reject('account_enrollment_invalid');
  const candidates = options.historicalApprover ? [current.history.genesis.payload.device, ...current.history.transitions.flatMap(item => item.payload.operation.type === 'add_device' ? [item.payload.operation.device] : [])] : current.checkpoint.devices;
  const signer = candidates.find(item => item.endpoint.id === approver.id);
  if (!signer || Object.entries(signer.endpoint).some(([key, field]) => approver[key] !== field)) return reject('account_enrollment_invalid');
  const expectedCandidate = { ...request.candidate, ownerId };
  if (request.kind === 'browser') {
    const member = current.checkpoint.devices.find(item => item.endpoint.id === request.candidate.id);
    if (request.candidate.ownerId !== ownerId || !member || !sameEndpoint(member.endpoint, expectedCandidate) || member.signingPublicKey !== request.signingPublicKey || member.label !== request.label) return reject('account_device_revoked');
  } else {
    const member = current.checkpoint.bridges.find(item => item.bridgeId === request.bridgeId);
    if (!member || !sameEndpoint(member.endpoint, expectedCandidate) || member.label !== request.label) return reject('account_bridge_revoked');
  }
  let envelope;
  try { envelope = parseSecureEnvelope(value.envelope); } catch { return reject('account_enrollment_invalid'); }
  if (envelope.ownerId !== ownerId || envelope.senderId !== signer.endpoint.id || envelope.recipientId !== request.candidate.id || envelope.purpose !== 'enrolled'
    || envelope.messageId !== request.requestId || envelope.receiverEpoch !== null || envelope.channel !== `account-enrollment:${request.requestId}`
    || envelope.bridgeId !== (request.kind === 'bridge' ? request.bridgeId : `account_${ownerId}`)
    || envelope.createdAt > now + ACCOUNT_TRUST_LIMITS.maxFutureSkewMs || envelope.expiresAt > Date.parse(request.expiresAt)
    || envelope.expiresAt - envelope.createdAt > 120000 || (options.requireFreshEnvelope !== false && envelope.expiresAt <= now)) return reject('account_enrollment_invalid');
  const bundle: AccountEnrollmentBundle = { version: 1, ownerId, requestId: request.requestId, approver: signer.endpoint, envelope };
  return { ...current, request, bundle, head: accountHead(current.checkpoint) };
}
