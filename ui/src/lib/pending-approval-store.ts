import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { genDeviceCode, genUserCode } from '@/lib/pairing';
import { AccountStoreError, AccountTrustStore, accountHead, validateApprovalAgainst, type AccountQuery, type VerifiedAccountRow } from '@/lib/account-trust-store';
import { AccountTrustError, parseAccountEnrollmentRequest, parseAccountHistory, verifyAccountHistory } from '@security/account-crypto';
import { normalizePendingAccountHint, parsePendingState, pendingHelloHash, pendingOfferHash, verifyPendingAction, PENDING_APPROVAL_LIMITS } from '@security/pending-approval-crypto';
import type { AccountEnrollmentRequest, AccountHead, AccountHistory } from '@security/account-protocol';
import type { PendingApprovalInbox, PendingApprovalState, PendingBrowserCreate, PendingCandidateCommand, PendingPairingStart, PendingReviewerCommand } from '@security/pending-approval-protocol';

const invalid = (): never => { throw new AccountTrustError('account_enrollment_invalid'); };
const conflict = (): never => { throw new AccountTrustError('account_trust_conflict'); };
const unavailable = (): never => { throw new AccountTrustError('account_storage_unavailable'); };
export function pendingCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(pendingCanonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + pendingCanonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return invalid();
}
const equal = (a: unknown, b: unknown) => pendingCanonical(a) === pendingCanonical(b);
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('base64url');
const digest = (value: unknown) => hash(pendingCanonical(value));
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) return invalid();
  return value;
}
function wire(value: unknown): void { if (Buffer.byteLength(pendingCanonical(value)) > PENDING_APPROVAL_LIMITS.maxWireBytes) throw new AccountStoreError(413); }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid(); return value as number; }
// Deliberately ASCII only, identical to normalizePendingAccountHint; never use locale lower().
export const PENDING_NORMALIZED_EMAIL_SQL = "translate(btrim(email, E' \\t\\n\\013\\f\\r'),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')";
const normalized = (alias: string) => PENDING_NORMALIZED_EMAIL_SQL.replace('btrim(email,', `btrim(${alias}.email,`);
function eligible(alias: string, owner: string): string {
  return `(SELECT COUNT(*) FROM (SELECT u.id FROM users u WHERE ${normalized('u')}=${alias}.target_sub LIMIT 2) AS routing_matches)=1
    AND EXISTS(SELECT 1 FROM users u WHERE u.id::text=${owner} AND ${normalized('u')}=${alias}.target_sub)
    AND (${alias}.owner_id IS NULL OR ${alias}.owner_id=${owner})`;
}
interface PendingRow extends Record<string, unknown> {
  request_id: string; target_sub: string; owner_id: string | null; candidate_token_hash: string; create_digest: string;
  request: AccountEnrollmentRequest; state: PendingApprovalState; revision: number; operations: Record<string, boolean>;
  final_head: AccountHead | null; pair_device_code: string | null; pair_metadata: PairMetadata | null;
  credential_snapshot: CredentialSnapshot | null; refresh_predecessor: unknown; expires_at: string;
}
interface PairMetadata { deviceCode: string; userCode: string; bridgeId: string; hostname: string | null; platform: string | null }
export interface CredentialSnapshot {
  ownerId: string; sub: string; bridgeId: string; jti: string;
  connection: { sub: string; info: { bridgeId: string; ownerId: string; hostname: string | null; connectedAt: string; localPort: number }; iat: number; exp: number; aud: 'ftown:centrifugo' };
  refresh: { sub: string; bridgeId: string; type: 'bridge_refresh'; jti: string; ownerId: string; iat: number; exp: number; aud: 'ftown:bridge-refresh' };
}
function validatedSnapshot(input: unknown, ownerId: string, sub: string, bridgeId: string, now: number): CredentialSnapshot {
  try {
    const snapshot = object(input, ['ownerId', 'sub', 'bridgeId', 'jti', 'connection', 'refresh']);
    const connection = object(snapshot.connection, ['sub', 'info', 'iat', 'exp', 'aud']);
    const info = object(connection.info, ['bridgeId', 'ownerId', 'hostname', 'connectedAt', 'localPort']);
    const refresh = object(snapshot.refresh, ['sub', 'bridgeId', 'type', 'jti', 'ownerId', 'iat', 'exp', 'aud']);
    if (snapshot.ownerId !== ownerId || snapshot.sub !== sub || snapshot.bridgeId !== bridgeId
      || typeof snapshot.jti !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(snapshot.jti)
      || connection.sub !== sub || info.bridgeId !== bridgeId || info.ownerId !== ownerId || connection.aud !== 'ftown:centrifugo'
      || refresh.sub !== sub || refresh.bridgeId !== bridgeId || refresh.ownerId !== ownerId || refresh.jti !== snapshot.jti
      || refresh.type !== 'bridge_refresh' || refresh.aud !== 'ftown:bridge-refresh'
      || !Number.isSafeInteger(connection.iat) || (connection.iat as number) < 0 || (connection.iat as number) > Math.floor(now / 1000) + 30
      || connection.exp !== (connection.iat as number) + 86400 || refresh.iat !== connection.iat || refresh.exp !== (connection.iat as number) + 30 * 86400
      || (connection.exp as number) <= Math.floor(now / 1000) || (refresh.exp as number) <= Math.floor(now / 1000)
      || !Number.isSafeInteger(info.localPort) || (info.localPort as number) < 1 || (info.localPort as number) > 65535
      || !(info.hostname === null || (typeof info.hostname === 'string' && info.hostname.length <= 200 && !/[\x00-\x1f\x7f]/.test(info.hostname)))
      || typeof info.connectedAt !== 'string' || new Date(info.connectedAt).toISOString() !== info.connectedAt
      || Math.floor(Date.parse(info.connectedAt) / 1000) !== connection.iat) return unavailable();
    return input as CredentialSnapshot;
  } catch { return unavailable(); }
}
/** SQL owns the comparison; JS only rejects malformed stored predecessor data. */
function validRefreshPredecessor(value: unknown, sub: string): boolean {
  try {
    if (value && typeof value === 'object' && 'status' in value && value.status === 'absent') {
      object(value, ['status']); return true;
    }
    const parsed = object(value, ['status', 'sub', 'jti', 'version']);
    return parsed.status === 'present' && parsed.sub === sub && typeof parsed.jti === 'string' && parsed.jti.length > 0 && parsed.jti.length <= 200
      && typeof parsed.version === 'string' && /^[0-9]{1,10}:\([0-9]{1,10},[0-9]{1,5}\)$/.test(parsed.version);
  } catch { return false; }
}
export interface PendingPairDelivery { snapshot: CredentialSnapshot; state: Extract<PendingApprovalState, { status: 'approved' }> }
export interface PendingPairStartInput extends PendingPairingStart { bridgeId: string; hostname: string | null; platform: string | null }

/** Public relay state only. Authority comes from signed history and endpoint verification. */
export class PendingApprovalStore {
  private readonly accounts: AccountTrustStore;
  constructor(private readonly query: AccountQuery = (text, params) => getDb().query(text, params), private readonly now = Date.now) { this.accounts = new AccountTrustStore(query, now); }
  private async row(id: string): Promise<PendingRow> {
    token(id);
    const rows = await this.query('SELECT * FROM security_pending_approvals WHERE request_id=$1', [id]);
    if (rows.length !== 1) return invalid();
    const row = rows[0] as PendingRow;
    if (row.request_id !== id || !row.request || row.request.requestId !== id || row.state?.request?.requestId !== id || !equal(row.request, row.state.request) || row.revision !== row.state.revision
      || !row.operations || typeof row.operations !== 'object' || Array.isArray(row.operations)) return unavailable();
    return row;
  }
  private async state(row: PendingRow): Promise<PendingApprovalState> {
    if (Date.parse(row.expires_at) <= this.now() || Date.parse(row.request.expiresAt) <= this.now()) return parsePendingState({ request: row.request, status: 'expired', revision: row.revision }, this.now());
    return parsePendingState(row.state, this.now());
  }
  private live(state: PendingApprovalState): void { if (state.status === 'expired') throw new AccountTrustError('account_enrollment_expired'); }
  async ownerTarget(ownerId: string): Promise<string> {
    const rows = await this.query(`WITH owner AS (SELECT email FROM users WHERE id::text=$1)
      SELECT id::text AS owner_id,email FROM users WHERE ${PENDING_NORMALIZED_EMAIL_SQL}=(SELECT ${PENDING_NORMALIZED_EMAIL_SQL} FROM owner) LIMIT 2`, [ownerId]);
    if (rows.length !== 1 || rows[0].owner_id !== ownerId || typeof rows[0].email !== 'string') return conflict();
    return normalizePendingAccountHint(rows[0].email);
  }
  private async ownerRow(ownerId: string, id: string): Promise<PendingRow> {
    const target = await this.ownerTarget(ownerId);
    const row = await this.row(id);
    if (row.target_sub !== target || (row.owner_id !== null && row.owner_id !== ownerId)) throw new AccountStoreError(403);
    return row;
  }
  async inbox(ownerId: string): Promise<PendingApprovalInbox> {
    const target = await this.ownerTarget(ownerId);
    const rows = await this.query(`SELECT * FROM security_pending_approvals WHERE target_sub=$1 AND (owner_id IS NULL OR owner_id=$2) AND expires_at>NOW() ORDER BY created_at,request_id LIMIT 128`, [target, ownerId]);
    const requests = [];
    for (const row of rows) { const state = await this.state(row as PendingRow); requests.push({ request: state.request, revision: state.revision, status: state.status }); }
    const inbox = { requests };
    if (Buffer.byteLength(pendingCanonical(inbox)) > PENDING_APPROVAL_LIMITS.maxInboxBytes) throw new AccountStoreError(413);
    return inbox;
  }
  async read(ownerId: string, id: string): Promise<PendingApprovalState> { return this.state(await this.ownerRow(ownerId, id)); }
  async createBrowser(ownerId: string, input: unknown): Promise<PendingApprovalState> {
    wire(input); const body = object(input, ['request', 'candidateToken']);
    const request = await parseAccountEnrollmentRequest(body.request, this.now());
    if (request.kind !== 'browser' || request.candidate.ownerId !== ownerId) throw new AccountStoreError(403);
    const target = await this.ownerTarget(ownerId);
    const created = await this.create(target, ownerId, request, token(body.candidateToken), null);
    return this.state(created);
  }
  async startBridge(input: PendingPairStartInput): Promise<{ state: PendingApprovalState; pair: PairMetadata }> {
    wire(input);
    if (input.approvalMethod !== 'pending-v1') return invalid();
    const request = await parseAccountEnrollmentRequest(input.enrollment, this.now());
    if (request.kind !== 'bridge' || request.bridgeId !== input.bridgeId) return invalid();
    // No users/history lookup: an unknown account hint gets the exact same start semantics.
    const target = normalizePendingAccountHint(input.accountHint);
    const pair: PairMetadata = { deviceCode: genDeviceCode(), userCode: genUserCode(), bridgeId: input.bridgeId, hostname: input.hostname, platform: input.platform };
    const row = await this.create(target, null, request, token(input.candidateToken), pair);
    if (!row.pair_metadata || !row.pair_device_code) return unavailable();
    return { state: await this.state(row), pair: row.pair_metadata };
  }
  private async create(target: string, ownerId: string | null, request: AccountEnrollmentRequest, credential: string, pair: PairMetadata | null): Promise<PendingRow> {
    const credentialHash = hash(credential);
    const createDigest = digest({ target, ownerId, request, candidateTokenHash: credentialHash, pair: pair ? { bridgeId: pair.bridgeId, hostname: pair.hostname, platform: pair.platform } : null });
    const find = async (): Promise<PendingRow | null> => {
      const rows = await this.query('SELECT * FROM security_pending_approvals WHERE request_id=$1', [request.requestId]);
      if (!rows.length) return null;
      const old = rows[0] as PendingRow;
      if (rows.length !== 1 || old.create_digest !== createDigest || old.candidate_token_hash !== credentialHash) return conflict();
      this.live(await this.state(old)); return old;
    };
    const existing = await find(); if (existing) return existing;
    await this.query(`DELETE FROM security_pending_approvals WHERE request_id IN
      (SELECT request_id FROM security_pending_approvals WHERE expires_at<=NOW() ORDER BY expires_at LIMIT 1000)`, []);
    const state: PendingApprovalState = { request, revision: 0, status: 'pending' };
    const ownerGate = ownerId === null ? 'TRUE' : `((SELECT COUNT(*) FROM (SELECT id FROM users WHERE ${PENDING_NORMALIZED_EMAIL_SQL}=$2 LIMIT 2) m)=1
      AND EXISTS(SELECT 1 FROM users WHERE id::text=$3 AND ${PENDING_NORMALIZED_EMAIL_SQL}=$2))`;

    for (let attempt = 0; attempt < 8; attempt++) {
      const rows = await this.query(`WITH inserted AS (
        INSERT INTO security_pending_approvals(request_id,target_sub,owner_id,candidate_token_hash,create_digest,request,state,expires_at,target_slot,global_slot,pair_device_code,pair_metadata)
        SELECT $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,t.s,g.s,$9,$10::jsonb
        FROM (SELECT s FROM generate_series(0,127) s WHERE NOT EXISTS(SELECT 1 FROM security_pending_approvals p WHERE p.target_sub=$2 AND p.target_slot=s) ORDER BY s LIMIT 1) t
        CROSS JOIN (SELECT s FROM generate_series(0,4095) s WHERE NOT EXISTS(SELECT 1 FROM security_pending_approvals p WHERE p.global_slot=s) ORDER BY s LIMIT 1) g
        WHERE ${ownerGate}
        ON CONFLICT DO NOTHING RETURNING *), paired AS (
        INSERT INTO pairing_requests(device_code,user_code,bridge_id,hostname,platform,status,expires_at,enrollment)
        SELECT $9,$11,$12,$13,$14,'pending',$8,$6::jsonb FROM inserted WHERE $9::text IS NOT NULL RETURNING device_code)
        SELECT inserted.*,1 / CASE WHEN (SELECT COUNT(*) FROM paired)=CASE WHEN $9::text IS NULL THEN 0 ELSE 1 END THEN 1 ELSE 0 END AS integrity_guard FROM inserted`,
      [request.requestId, target, ownerId, credentialHash, createDigest, JSON.stringify(request), JSON.stringify(state), request.expiresAt,
        pair?.deviceCode ?? null, pair ? JSON.stringify(pair) : null, pair?.userCode ?? null, pair?.bridgeId ?? null, pair?.hostname ?? null, pair?.platform ?? null]);
      if (rows.length === 1) return rows[0] as PendingRow;
      const replay = await find(); if (replay) return replay;
    }
    throw new AccountTrustError('account_capacity_exceeded');
  }
  async candidate(id: string, input: unknown): Promise<PendingApprovalState> {
    wire(input); const body = object(input, ['candidateToken', 'action']);
    const row = await this.row(id);
    if (row.candidate_token_hash !== hash(token(body.candidateToken))) throw new AccountStoreError(403);
    const raw = body.action as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return invalid();
    const operationDigest = digest({ actor: row.candidate_token_hash, action: raw });
    const current = await this.state(row); this.live(current);
    if (raw.type === 'read') { object(raw, ['type']); return current; }
    if (row.operations[operationDigest]) return current;
    const expected = revision(raw.expectedRevision);
    if (expected !== row.revision) return conflict();
    let next: PendingApprovalState;
    if (raw.type === 'hello') {
      object(raw, ['type', 'expectedRevision', 'hello']); if (current.status !== 'offered') return conflict();
      next = await parsePendingState({ ...current, status: 'submitted', revision: current.revision + 1, hello: raw.hello }, this.now());
      if (!('hello' in next) || next.hello.envelope.expiresAt <= this.now()) return invalid();
    } else if (raw.type === 'confirm') {
      object(raw, ['type', 'expectedRevision', 'confirmation']); if (current.status !== 'comparing') return conflict();
      next = await parsePendingState({ ...current, status: 'confirmed', revision: current.revision + 1, confirmation: raw.confirmation }, this.now());
    } else if (raw.type === 'cancel') {
      object(raw, ['type', 'expectedRevision']); if (['approved', 'rejected', 'cancelled', 'conflict'].includes(current.status)) return conflict();
      next = { request: current.request, revision: current.revision + 1, status: 'cancelled' };
    } else return invalid();
    return this.commit(row, next, operationDigest, null, null);
  }
  async reviewer(ownerId: string, id: string, input: unknown): Promise<PendingApprovalState> {
    try { return await this.reviewAttempt(ownerId, id, input); }
    catch (error) {
      if (!(error instanceof AccountTrustError) || error.code !== 'account_trust_conflict') throw error;
      // A duplicate can commit between the first pending-row read and history read.
      // Re-enter the authenticated receipt path once; never replay new work.
      const latest = await this.ownerRow(ownerId, id);
      if (!latest.operations[digest({ actor: ownerId, command: input })]) throw error;
      return this.reviewAttempt(ownerId, id, input);
    }
  }
  private async reviewAttempt(ownerId: string, id: string, input: unknown): Promise<PendingApprovalState> {

    wire(input);
    const row = await this.ownerRow(ownerId, id);
    const current = await this.state(row); this.live(current);
    const account = await this.accounts.readVerified(ownerId); if (!account) throw new AccountTrustError('account_approval_required');
    const operationDigest = digest({ actor: ownerId, command: input });
    // Re-authenticate an exact committed command against its signed historical head,
    // then require the same signer still active. Supplied stale revision/head cannot
    // turn a lost successful reply into a failed retry.
    if (row.operations[operationDigest]) {
      const raw = input as PendingReviewerCommand;
      const at = raw?.payload?.head?.revision;
      if (!Number.isSafeInteger(at) || at < 0 || at > account.history.transitions.length) return invalid();
      const history = { genesis: account.history.genesis, transitions: account.history.transitions.slice(0, at) };
      const replayTime = (raw.payload.action.type === 'finish' || raw.payload.action.type === 'renew')
        ? Math.min(this.now(), raw.payload.action.result.bundle.envelope.createdAt + 1) : this.now();
      const command = await verifyPendingAction(input, row.request, history, replayTime);
      const then = (await verifyAccountHistory(history, null, this.now())).devices.find(item => item.endpoint.id === command.payload.signerId);
      if (!account.checkpoint.devices.some(item => then && equal(item, then))) throw new AccountTrustError('account_device_revoked');
      return current;
    }
    const command = await verifyPendingAction(input, row.request, account.history, this.now());
    const p = command.payload; const action = p.action;
    if (p.ownerId !== ownerId || p.expectedRevision !== row.revision) return conflict();
    let next: PendingApprovalState;
    let prospective: VerifiedAccountRow | null = null;
    if (action.type === 'review') {
      if (current.status !== 'pending') return conflict();
      next = { request: row.request, revision: row.revision + 1, status: 'offered', offer: action.offer };
    } else if (action.type === 'reject') {
      if (['approved', 'cancelled', 'rejected', 'conflict'].includes(current.status)) return conflict();
      next = { request: row.request, revision: row.revision + 1, status: 'rejected' };
    } else {
      if (!('offer' in current) || current.offer.payload.approver.id !== p.signerId || !equal(current.offer.payload.approver, account.checkpoint.devices.find(item => item.endpoint.id === p.signerId)?.endpoint)
        || action.offerHash !== await pendingOfferHash(current.offer)) return conflict();
      if (action.type === 'reveal') {
        if (current.status !== 'submitted' || action.helloHash !== await pendingHelloHash(current.hello)) return conflict();
        next = await parsePendingState({ ...current, revision: row.revision + 1, status: 'comparing', reveal: action.reveal }, this.now());
      } else if (action.type === 'finish') {
        if (current.status !== 'confirmed' || !equal(p.head, current.offer.payload.anchor)) return conflict();
        const history = parseAccountHistory(action.transition === null ? account.history : { genesis: account.history.genesis, transitions: [...account.history.transitions, action.transition] });
        const checkpoint = await verifyAccountHistory(history, account.checkpoint, this.now());
        prospective = { history, checkpoint };
        await validateApprovalAgainst(ownerId, row.request, action.result.bundle, prospective, { now: this.now() });
        next = await parsePendingState({ ...current, revision: row.revision + 1, status: 'approved', result: action.result }, this.now());
      } else {
        if (current.status !== 'approved' || !row.final_head || !equal(action.result.head, row.final_head) || !equal(action.result.head, current.result.head)) return conflict();
        await validateApprovalAgainst(ownerId, row.request, action.result.bundle, account, { now: this.now() });
        next = await parsePendingState({ ...current, revision: row.revision + 1, result: action.result }, this.now());
      }
    }
    return this.commit(row, next, operationDigest, { ownerId, account, command }, prospective);
  }
  private async commit(row: PendingRow, next: PendingApprovalState, operationDigest: string,
    reviewer: { ownerId: string; account: VerifiedAccountRow; command: PendingReviewerCommand } | null, prospective: VerifiedAccountRow | null): Promise<PendingApprovalState> {
    const action = reviewer?.command.payload.action;
    const finish = action?.type === 'finish'; const renew = action?.type === 'renew';
    const expected = reviewer ? accountHead(reviewer.account.checkpoint) : null;
    const head = prospective ? accountHead(prospective.checkpoint) : null;
    const append = finish && prospective && prospective.checkpoint.revision !== reviewer?.account.checkpoint.revision;
    const ownerId = reviewer?.ownerId ?? null;
    const finalHead = finish && next.status === 'approved' ? next.result.head : row.final_head;
    const bundle = (finish || renew) && next.status === 'approved' ? next.result.bundle : null;
    const params = [row.request_id, row.revision, JSON.stringify(row.state), JSON.stringify(next), operationDigest, ownerId,
      expected?.rootId ?? null, expected?.revision ?? null, expected?.head ?? null,
      head?.rootId ?? null, head?.revision ?? null, head?.head ?? null, prospective ? JSON.stringify(prospective.history) : null,
      !!append, finish, renew, finalHead ? JSON.stringify(finalHead) : null, bundle ? JSON.stringify(bundle) : null, randomUUID()];
    const rows = await this.query(`WITH locked AS MATERIALIZED (SELECT * FROM security_pending_approvals WHERE request_id=$1 FOR UPDATE),
      history AS MATERIALIZED (SELECT h.* FROM security_account_history h,locked p WHERE h.owner_id=$6 AND p.request_id=$1 FOR UPDATE OF h),
      pair AS MATERIALIZED (SELECT b.* FROM pairing_requests b,locked p WHERE b.device_code=p.pair_device_code
        AND (SELECT COUNT(*) FROM history)>=0 FOR UPDATE OF b),
      refresh AS MATERIALIZED (SELECT r.*,r.xmin::text || ':' || r.ctid::text AS row_version FROM bridge_refresh r
        JOIN pair b ON b.bridge_id=r.bridge_id FOR UPDATE OF r),
      ready AS MATERIALIZED (SELECT p.* FROM locked p WHERE p.revision=$2 AND p.state=$3::jsonb AND p.expires_at>NOW()
        AND NOT (p.operations ? $5) AND ($6::text IS NULL OR (${eligible('p', '$6')}
          AND EXISTS(SELECT 1 FROM history h WHERE h.root_id=$7 AND h.revision=$8 AND h.head=$9)))
        AND (NOT $15::boolean OR p.pair_device_code IS NULL OR EXISTS(SELECT 1 FROM pair b WHERE b.status='pending' AND b.expires_at>NOW() AND b.enrollment=p.request
          AND NOT EXISTS(SELECT 1 FROM refresh r WHERE r.sub<>(SELECT email FROM users WHERE id::text=$6))))
        AND (NOT $16::boolean OR p.pair_device_code IS NULL OR EXISTS(SELECT 1 FROM pair b WHERE b.status IN ('approved','consumed') AND b.expires_at>NOW()))),
      hw AS (UPDATE security_account_history h SET root_id=$10,revision=$11,head=$12,history=$13::jsonb,updated_at=NOW()
        FROM ready p WHERE $14::boolean AND h.owner_id=$6 AND h.root_id=$7 AND h.revision=$8 AND h.head=$9 RETURNING h.owner_id),
      pw AS (UPDATE security_pending_approvals p SET state=$4::jsonb,revision=p.revision+1,owner_id=COALESCE(p.owner_id,$6),
        operations=p.operations || jsonb_build_object($5::text,true),final_head=$17::jsonb,
        refresh_predecessor=CASE WHEN $15::boolean AND p.pair_device_code IS NOT NULL THEN
          COALESCE((SELECT jsonb_build_object('status','present','sub',r.sub,'jti',r.current_jti,'version',r.row_version) FROM refresh r),jsonb_build_object('status','absent'))
          ELSE p.refresh_predecessor END,updated_at=NOW()
        FROM ready r WHERE p.request_id=r.request_id AND (SELECT COUNT(*) FROM hw)=CASE WHEN $14::boolean THEN 1 ELSE 0 END RETURNING p.*),
      bw AS (UPDATE pairing_requests b SET status='approved',sub=(SELECT email FROM users WHERE id::text=$6),refresh_jti=COALESCE(b.refresh_jti,$19),
        approved_at=COALESCE(b.approved_at,NOW()),account_approval=$18::jsonb
        FROM pw p WHERE b.device_code=p.pair_device_code AND ($15::boolean OR $16::boolean) AND b.status<>'consumed' RETURNING b.device_code),
      counts AS (SELECT (SELECT COUNT(*) FROM ready) AS r,(SELECT COUNT(*) FROM hw) AS h,(SELECT COUNT(*) FROM pw) AS p,(SELECT COUNT(*) FROM bw) AS b,
        (SELECT COUNT(*) FROM ready r JOIN pair b ON b.device_code=r.pair_device_code WHERE ($15::boolean OR $16::boolean) AND b.status<>'consumed') AS eb)
      SELECT 1 / CASE WHEN (r=0 AND h=0 AND p=0 AND b=0) OR (r=1 AND h=CASE WHEN $14::boolean THEN 1 ELSE 0 END AND p=1 AND b=eb) THEN 1 ELSE 0 END AS integrity_guard,
        (SELECT state FROM pw) AS state FROM counts`, params);
    if (rows.length === 1 && rows[0].state) return parsePendingState(rows[0].state, this.now());
    const latest = await this.row(row.request_id);
    if (latest.operations[operationDigest]) return this.state(latest);
    return conflict();
  }
  async linkedPair(deviceCode: string): Promise<boolean> {
    return (await this.query('SELECT request_id FROM security_pending_approvals WHERE pair_device_code=$1', [deviceCode])).length === 1;
  }
  async deliver(deviceCode: string, localPort: number): Promise<PendingPairDelivery | { status: 'pending' | 'expired' | 'denied' }> {
    if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65535) return invalid();
    const rows = await this.query('SELECT * FROM security_pending_approvals WHERE pair_device_code=$1', [deviceCode]);
    if (rows.length !== 1) return invalid();
    const row = rows[0] as PendingRow; const state = await this.state(row);
    if (state.status === 'expired') return { status: 'expired' };
    if (['rejected', 'cancelled', 'conflict'].includes(state.status)) return { status: 'denied' };
    if (state.status !== 'approved') return { status: 'pending' };
    if (!row.owner_id || state.request.kind !== 'bridge' || !row.pair_metadata) return unavailable();
    const ownerId = row.owner_id;
    await this.ownerTarget(ownerId);
    const verified = await this.accounts.validateApproval(ownerId, state.request, state.result.bundle, true, false);
    const subRows = await this.query('SELECT email FROM users WHERE id::text=$1', [ownerId]);
    if (subRows.length !== 1 || typeof subRows[0].email !== 'string') return unavailable();
    const sub = subRows[0].email;
    if (row.credential_snapshot === null && !validRefreshPredecessor(row.refresh_predecessor, sub)) return { status: 'denied' };
    const deliveryTime = this.now(); const iat = Math.floor(deliveryTime / 1000); const bridgeId = state.request.bridgeId;
    const jti = randomUUID();
    const snapshot: CredentialSnapshot = { ownerId, sub, bridgeId, jti,
      connection: { sub, info: { bridgeId, ownerId, hostname: row.pair_metadata.hostname, connectedAt: new Date(deliveryTime).toISOString(), localPort }, iat, exp: iat + 86400, aud: 'ftown:centrifugo' },
      refresh: { sub, bridgeId, ownerId, jti, type: 'bridge_refresh', iat, exp: iat + 30 * 86400, aud: 'ftown:bridge-refresh' } };
    // Absence cannot lock a missing legacy row. A competing insert loses via the
    // unique index without any update, consumption or snapshot. All nonzero
    // effects still require exactly one refresh + pair + snapshot write.
    const result = await this.query(`WITH locked AS MATERIALIZED (SELECT * FROM security_pending_approvals WHERE request_id=$1 FOR UPDATE),
      history AS MATERIALIZED (SELECT h.* FROM security_account_history h,locked p WHERE h.owner_id=$3 AND p.request_id=$1 FOR UPDATE OF h),
      pair AS MATERIALIZED (SELECT b.* FROM pairing_requests b,locked p WHERE b.device_code=p.pair_device_code AND (SELECT COUNT(*) FROM history)>=0 FOR UPDATE OF b),
      refresh AS MATERIALIZED (SELECT r.*,r.xmin::text || ':' || r.ctid::text AS row_version FROM bridge_refresh r
        JOIN pair b ON b.bridge_id=r.bridge_id FOR UPDATE OF r),
      ready AS MATERIALIZED (SELECT p.* FROM locked p JOIN pair b ON b.device_code=p.pair_device_code
        WHERE p.expires_at>NOW() AND p.state->>'status'='approved' AND p.owner_id=$3 AND ${eligible('p', '$3')}
        AND EXISTS(SELECT 1 FROM history h WHERE h.root_id=$4 AND h.revision=$5 AND h.head=$6)
        AND b.bridge_id=$8 AND b.sub=$7 AND b.enrollment=p.request
        AND ((p.credential_snapshot IS NULL AND b.status='approved' AND b.expires_at>NOW()
          AND ((p.refresh_predecessor=jsonb_build_object('status','absent') AND NOT EXISTS(SELECT 1 FROM refresh))
            OR EXISTS(SELECT 1 FROM refresh r WHERE r.sub=$7 AND p.refresh_predecessor=
              jsonb_build_object('status','present','sub',r.sub,'jti',r.current_jti,'version',r.row_version))))
          OR (p.credential_snapshot IS NOT NULL AND b.status='consumed' AND EXISTS(SELECT 1 FROM refresh r WHERE r.sub=$7 AND r.current_jti=p.credential_snapshot->>'jti')))),
      inserted_refresh AS (INSERT INTO bridge_refresh(bridge_id,sub,current_jti,hostname,last_seen,updated_at)
        SELECT $8,$7,$9,$10,NOW(),NOW() FROM ready WHERE credential_snapshot IS NULL AND refresh_predecessor=jsonb_build_object('status','absent')
        ON CONFLICT(bridge_id) DO NOTHING RETURNING bridge_id),
      updated_refresh AS (UPDATE bridge_refresh r SET current_jti=$9,hostname=$10,last_seen=NOW(),updated_at=NOW()
        FROM ready p WHERE p.credential_snapshot IS NULL AND r.bridge_id=$8 AND r.sub=$7 AND p.refresh_predecessor=
          jsonb_build_object('status','present','sub',r.sub,'jti',r.current_jti,'version',r.xmin::text || ':' || r.ctid::text) RETURNING r.bridge_id),
      refreshed AS (SELECT bridge_id FROM inserted_refresh UNION ALL SELECT bridge_id FROM updated_refresh),
      consumed AS (UPDATE pairing_requests b SET status='consumed',refresh_jti=$9 FROM ready p WHERE p.credential_snapshot IS NULL AND b.device_code=p.pair_device_code
        AND (SELECT COUNT(*) FROM refreshed)=1 RETURNING b.device_code),
      saved AS (UPDATE security_pending_approvals p SET credential_snapshot=$2::jsonb,updated_at=NOW() FROM ready r
        WHERE p.request_id=r.request_id AND r.credential_snapshot IS NULL AND (SELECT COUNT(*) FROM consumed)=1 RETURNING p.credential_snapshot),
      counts AS (SELECT (SELECT COUNT(*) FROM ready WHERE credential_snapshot IS NULL) AS n,(SELECT COUNT(*) FROM refreshed) AS r,
        (SELECT COUNT(*) FROM consumed) AS c,(SELECT COUNT(*) FROM saved) AS s)
      SELECT 1 / CASE WHEN (r=0 AND c=0 AND s=0) OR (n=1 AND r=1 AND c=1 AND s=1) THEN 1 ELSE 0 END AS integrity_guard,
        COALESCE((SELECT credential_snapshot FROM saved),(SELECT credential_snapshot FROM ready)) AS snapshot FROM counts`,
    [row.request_id, JSON.stringify(snapshot), ownerId, verified.head.rootId, verified.head.revision, verified.head.head, sub, bridgeId, jti, row.pair_metadata.hostname]);
    if (result.length !== 1 || !result[0].snapshot) return { status: 'denied' };
    const saved = validatedSnapshot(result[0].snapshot, ownerId, sub, bridgeId, this.now());
    return { snapshot: saved, state };
  }
}
