import { legacyDateTimeSchema } from '../../zod-compat.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { ApprovedEndpoint, BridgeInvitation, EndpointPermission, EndpointPublic, EnrollmentMessage, InvitationOptions,
  LocalRecoveryAuthority, VerifiedPrincipal } from '../protocol.js';
import { BridgeSecurityError } from './errors.js';
import { approvedSchema, boundedId, displayLabel, endpointSchema, permissionSchema } from './metadata.js';
import { AtomicSnapshot } from './snapshot.js';
import { verifyAccountHistory } from '../account-crypto.js';
import type { AccountHead, AccountHistory, StoredAccountTrust, VerifiedAccountTrust } from '../account-protocol.js';
import { AccountConnectivity, storedAccountSchema } from './account-state.js';
import type { SecurityErrorCode } from '../protocol.js';

const FIVE_MINUTES = 300_000;
const MAX_ENDPOINTS = 1000;
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
const invitationSchema = z.object({ id: z.string().guid(), secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().max(100), permissions: z.array(permissionSchema).max(3), expiresAt: legacyDateTimeSchema,
  consumedBy: z.string().nullable(), provenance: z.enum(['legacy', 'local-recovery']).default('legacy') }).strict();
/** Pre-removal policy files carry `mcp: []`, mcp devices and mcp provenance; the strict schema would reject them and brick the bridge. */
export function migrateLegacyPolicy(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const { mcp: _mcp, ...rest } = raw as Record<string, unknown>;
  const isMcpDevice = (device: unknown) => typeof device === 'object' && device !== null
    && (device as { endpoint?: { kind?: unknown } }).endpoint?.kind === 'mcp';
  const dropped = new Set<string>();
  if (Array.isArray(rest.devices)) {
    for (const device of rest.devices) {
      if (isMcpDevice(device)) dropped.add(String((device as { endpoint: { id?: unknown } }).endpoint.id));
    }
    rest.devices = rest.devices.filter(device => !isMcpDevice(device));
  }
  const provenance = rest.provenance;
  if (typeof provenance === 'object' && provenance !== null && !Array.isArray(provenance)) {
    rest.provenance = Object.fromEntries(Object.entries(provenance)
      .filter(([id, value]) => !dropped.has(id) && value !== 'mcp'));
  }
  return rest;
}
const policySchema = z.preprocess(migrateLegacyPolicy, z.object({ version: z.literal(1), ownerId: z.string(), bridgeId: z.string(), bridgeEndpointId: z.string(),
  generation: z.number().int().nonnegative(), devices: z.array(approvedSchema).max(MAX_ENDPOINTS),
  invitations: z.array(invitationSchema).max(256),
  // Frozen: earlier releases require this key, so a downgrade must still parse what we write.
  mcp: z.array(z.never()).max(0).default([]),
  account: storedAccountSchema.nullable().default(null),
  provenance: z.record(z.string(), z.enum(['legacy', 'local-recovery', 'account', 'local-cli'])).default({}),
}).strict().superRefine((state, context) => {
  if (new Set(state.devices.map(device => device.endpoint.id)).size !== state.devices.length
    || state.devices.some(device => device.endpoint.ownerId !== state.ownerId
      || device.grantId !== null
      || new Set(device.permissions).size !== device.permissions.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid policy relationship' });
  }
}));
type Policy = z.infer<typeof policySchema>;

/** Identity comparison matters: request JSON cannot manufacture this recovery capability. */
export const LOCAL_RECOVERY_AUTHORITY: LocalRecoveryAuthority = Object.freeze({ source: 'os-local-recovery' });

export interface PolicyOptions { now?: () => number; monotonicNow?: () => number; relayUrl?: string; localOrigin?: string }

/** Bridge-owned authorization. Directory entries and caller-claimed permissions never enter this store. */
export class BridgePolicyStore {
  private readonly snapshot: AtomicSnapshot<Policy>;
  private readonly now: () => number;
  private readonly connectivity: AccountConnectivity;
  constructor(dataDir: string, readonly bridgeId: string, readonly bridge: EndpointPublic, private readonly options: PolicyOptions = {}) {
    endpointSchema.parse(bridge);
    if (bridge.kind !== 'bridge') throw new BridgeSecurityError('wrong_context');
    this.now = options.now ?? Date.now;
    this.connectivity = new AccountConnectivity(this.now, options.monotonicNow ?? (() => performance.now()));
    this.snapshot = new AtomicSnapshot<Policy>(join(dataDir, 'security', 'policy.json'), policySchema, () => ({
      version: 1, ownerId: bridge.ownerId, bridgeId, bridgeEndpointId: bridge.id, generation: 0,
      devices: [], invitations: [], mcp: [], account: null, provenance: {},
    }));
  }
  private check(state: Policy): void {
    if (state.ownerId !== this.bridge.ownerId || state.bridgeId !== this.bridgeId || state.bridgeEndpointId !== this.bridge.id) {
      throw new BridgeSecurityError('wrong_context');
    }
  }
  private active(state: Policy, endpointId: string): ApprovedEndpoint {
    this.check(state);
    const account = state.account;
    const member = account?.checkpoint.devices.find(item => item.endpoint.id === endpointId);
    if (member) {
      this.connectivity.check(account!);
      const own = account!.checkpoint.bridges.find(item => item.bridgeId === this.bridgeId);
      if (!own || own.endpoint.id !== this.bridge.id || own.endpoint.publicKey !== this.bridge.publicKey) throw new BridgeSecurityError('account_bridge_revoked');
    } else if (account?.checkpoint.revokedDeviceIds.includes(endpointId)) throw new BridgeSecurityError('account_device_revoked');
    const record = state.devices.find(device => device.endpoint.id === endpointId);
    if (!record) throw new BridgeSecurityError('approval_required');
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.now()) throw new BridgeSecurityError('expired');
    return record;
  }
  private principalFrom(state: Policy, record: ApprovedEndpoint): VerifiedPrincipal {
    return { endpoint: record.endpoint, bridgeId: this.bridgeId, permissions: record.permissions,
      policyGeneration: state.generation, grantId: record.grantId };
  }
  private authorize(state: Policy, actor: VerifiedPrincipal, permission: EndpointPermission): ApprovedEndpoint {
    if (actor.bridgeId !== this.bridgeId || actor.endpoint.ownerId !== this.bridge.ownerId) throw new BridgeSecurityError('wrong_context');
    if (actor.policyGeneration !== state.generation) throw new BridgeSecurityError('endpoint_revoked');
    const record = this.active(state, actor.endpoint.id);
    if (record.endpoint.publicKey !== actor.endpoint.publicKey || !record.permissions.includes(permission)) {
      throw new BridgeSecurityError('permission_denied');
    }
    return record;
  }
  async principal(endpointId: string): Promise<VerifiedPrincipal> {
    return this.snapshot.read(state => this.principalFrom(state, this.active(state, endpointId)));
  }
  async revalidate(actor: VerifiedPrincipal, permission?: EndpointPermission): Promise<void> {
    await this.snapshot.read(state => {
      if (actor.bridgeId !== this.bridgeId || actor.endpoint.ownerId !== this.bridge.ownerId) throw new BridgeSecurityError('wrong_context');
      if (actor.policyGeneration !== state.generation) throw new BridgeSecurityError('endpoint_revoked');
      const record = this.active(state, actor.endpoint.id);
      if (record.endpoint.publicKey !== actor.endpoint.publicKey || record.grantId !== actor.grantId) throw new BridgeSecurityError('wrong_context');
      if (permission && !record.permissions.includes(permission)) throw new BridgeSecurityError('permission_denied');
    });
  }
  async createInvitation(actor: VerifiedPrincipal | LocalRecoveryAuthority, options: InvitationOptions): Promise<BridgeInvitation> {
    const secret = randomBytes(32).toString('base64url');
    const invitationId = randomUUID();
    const expiresAt = new Date(this.now() + FIVE_MINUTES).toISOString();
    await this.snapshot.transact(state => {
      this.check(state);
      if (actor !== LOCAL_RECOVERY_AUTHORITY) {
        this.authorize(state, actor as VerifiedPrincipal, 'admin');
        if (state.account && (actor as VerifiedPrincipal).endpoint.kind !== 'local-cli') throw new BridgeSecurityError('account_approval_required');
      }
      state.invitations = state.invitations.filter(invitation => Date.parse(invitation.expiresAt) > this.now());
      if (state.invitations.length >= 256) throw new BridgeSecurityError('capacity_exceeded');
      state.invitations.push({ id: invitationId, secretHash: digest(secret), label: displayLabel(options.label),
        permissions: ['read', 'control', 'admin'], expiresAt, consumedBy: null, provenance: state.account ? 'local-recovery' : 'legacy' });
    });
    return { version: 1, invitationId, ownerId: this.bridge.ownerId, bridgeId: this.bridgeId, bridge: this.bridge,
      secret, expiresAt, relayUrl: this.options.relayUrl ?? null, localOrigin: this.options.localOrigin ?? null };
  }
  async consumeInvitation(message: EnrollmentMessage): Promise<ApprovedEndpoint> {
    let candidate: EndpointPublic;
    try { candidate = endpointSchema.parse(message.candidate); }
    catch { throw new BridgeSecurityError('invitation_invalid'); }
    if (candidate.ownerId !== this.bridge.ownerId || candidate.kind !== 'browser'
      || !/^[A-Za-z0-9_-]{43}$/.test(message.invitationSecret)) throw new BridgeSecurityError('invitation_invalid');
    return this.snapshot.transact(state => {
      this.check(state);
      const invitation = state.invitations.find(item => item.id === message.invitationId);
      if (!invitation || !timingSafeEqual(Buffer.from(invitation.secretHash), Buffer.from(digest(message.invitationSecret)))) {
        throw new BridgeSecurityError('invitation_invalid');
      }
      if (Date.parse(invitation.expiresAt) <= this.now()) throw new BridgeSecurityError('invitation_expired');
      if (state.account && invitation.provenance !== 'local-recovery') throw new BridgeSecurityError('invitation_invalid');
      // Independent recovery must never shadow an account membership or revive its tombstone.
      if (state.account && (state.account.checkpoint.devices.some(item => item.endpoint.id === candidate.id)
        || state.account.checkpoint.revokedDeviceIds.includes(candidate.id))) throw new BridgeSecurityError('account_approval_required');
      if (invitation.consumedBy) {
        if (invitation.consumedBy !== candidate.id) throw new BridgeSecurityError('invitation_consumed');
        // Lost enrollment acknowledgements may recover only the already approved exact identity.
        return this.active(state, candidate.id);
      }
      if (state.devices.some(device => device.endpoint.id === candidate.id)) throw new BridgeSecurityError('invitation_invalid');
      if (state.devices.length >= MAX_ENDPOINTS) throw new BridgeSecurityError('capacity_exceeded');
      const approved: ApprovedEndpoint = { endpoint: candidate, label: displayLabel(message.label) || invitation.label,
        permissions: [...invitation.permissions], approvedAt: new Date(this.now()).toISOString(), grantId: null, expiresAt: null };
      invitation.consumedBy = candidate.id;
      state.devices.push(approved);
      state.provenance[candidate.id] = invitation.provenance;
      state.generation++;
      return approved;
    });
  }
  async list(actor: VerifiedPrincipal): Promise<ApprovedEndpoint[]> {
    return this.snapshot.read(state => {
      this.authorize(state, actor, 'admin');
      return state.devices.map(device => {
        const provenance = state.provenance[device.endpoint.id];
        if (provenance === 'account') return { ...device, source: 'account' as const };
        if (provenance === 'local-cli' || provenance === 'local-recovery') return { ...device, source: 'local' as const };
        return { ...device };
      });
    });
  }
  async recipients(): Promise<ApprovedEndpoint[]> {
    return this.snapshot.read(state => {
      this.check(state);
      return state.devices.filter(device => {
        try { return this.active(state, device.endpoint.id).permissions.includes('read'); } catch { return false; }
      });
    });
  }
  async revoke(actor: VerifiedPrincipal, endpointId: string): Promise<void> {
    await this.snapshot.transact(state => {
      this.authorize(state, actor, 'admin');
      if (state.account?.checkpoint.devices.some(item => item.endpoint.id === endpointId)) throw new BridgeSecurityError('account_approval_required');
      state.devices = state.devices.filter(device => device.endpoint.id !== endpointId);
      delete state.provenance[endpointId];
      state.generation++;
    });
  }
  async provisionLocalEndpoint(endpoint: EndpointPublic): Promise<void> {
    const candidate = endpointSchema.parse(endpoint);
    if (candidate.kind !== 'local-cli' || candidate.ownerId !== this.bridge.ownerId) throw new BridgeSecurityError('wrong_context');
    await this.snapshot.transact(state => {
      this.check(state);
      if (state.devices.some(device => device.endpoint.id === candidate.id)) return;
      if (state.devices.length >= MAX_ENDPOINTS) throw new BridgeSecurityError('capacity_exceeded');
      state.devices.push({ endpoint: candidate, label: 'Local CLI', permissions: ['read', 'control', 'admin'],
        approvedAt: new Date(this.now()).toISOString(), grantId: null, expiresAt: null }); state.generation++;
      state.provenance[candidate.id] = 'local-cli';
    });
  }
  async accountTrust(): Promise<StoredAccountTrust | null> {
    return this.snapshot.read(state => { this.check(state); return state.account; });
  }
  async accountEndpointIds(): Promise<string[]> {
    return this.snapshot.read(state => { this.check(state); return state.account?.checkpoint.devices.map(item => item.endpoint.id) ?? []; });
  }
  blockAccount(code: SecurityErrorCode): void { this.connectivity.block(code); }
  async accountAvailable(): Promise<boolean> {
    return this.snapshot.read(state => {
      this.check(state);
      if (!state.account) return true;
      try {
        this.connectivity.check(state.account);
        return state.account.checkpoint.bridges.some(item => item.bridgeId === this.bridgeId && item.endpoint.id === this.bridge.id);
      } catch { return false; }
    });
  }
  /** Trusted startup bootstrap only; no remote endpoint can call this entry point. */
  async pinBootstrap(trust: VerifiedAccountTrust): Promise<void> {
    await this.snapshot.transact(async state => {
      this.check(state);
      if (state.account) {
        if (state.account.checkpoint.rootId !== trust.checkpoint.rootId) throw new BridgeSecurityError('account_trust_rollback');
        return;
      }
      const checkpoint = await verifyAccountHistory(trust.history, trust.checkpoint, this.now());
      this.requireOwnBridge(checkpoint);
      this.projectAccount(state, { ...trust, checkpoint, lastServerReadAt: 0, lastObservedAt: 0 });
    });
  }
  private requireOwnBridge(checkpoint: StoredAccountTrust['checkpoint']): void {
    const own = checkpoint.bridges.find(item => item.bridgeId === this.bridgeId);
    if (checkpoint.ownerId !== this.bridge.ownerId || !own || own.endpoint.id !== this.bridge.id
      || own.endpoint.publicKey !== this.bridge.publicKey || own.endpoint.ownerId !== this.bridge.ownerId) throw new BridgeSecurityError('wrong_context');
  }
  private projectAccount(state: Policy, trust: StoredAccountTrust): string[] {
    const previous = state.devices.filter(item => item.endpoint.kind === 'browser');
    const first = state.account === null;
    const unchanged = state.account?.checkpoint.head === trust.checkpoint.head;
    state.devices = state.devices.filter(item => item.endpoint.kind !== 'browser'
      || (!first && state.provenance[item.endpoint.id] === 'local-recovery'
        && !trust.checkpoint.devices.some(member => member.endpoint.id === item.endpoint.id)
        && !trust.checkpoint.revokedDeviceIds.includes(item.endpoint.id)));
    if (first) state.invitations = [];
    for (const entry of previous) if (!state.devices.some(item => item.endpoint.id === entry.endpoint.id)) delete state.provenance[entry.endpoint.id];
    const own = trust.checkpoint.bridges.find(item => item.bridgeId === this.bridgeId);
    if (own?.endpoint.id === this.bridge.id && own.endpoint.publicKey === this.bridge.publicKey) {
      for (const member of trust.checkpoint.devices) {
        if (state.devices.some(item => item.endpoint.id === member.endpoint.id)) throw new BridgeSecurityError('wrong_context');
        state.devices.push({ endpoint: member.endpoint, label: displayLabel(member.label), permissions: ['read', 'control', 'admin'],
          approvedAt: member.approvedAt, grantId: null, expiresAt: null });
        state.provenance[member.endpoint.id] = 'account';
      }
    }
    state.account = trust;
    if (!unchanged) state.generation++;
    return previous.filter(item => !state.devices.some(next => next.endpoint.id === item.endpoint.id)).map(item => item.endpoint.id);
  }
  /** Only an authenticated API read reaches here; browser-supplied timestamps never do. */
  async applyAccountRead(history: AccountHistory, adoption?: { actor: VerifiedPrincipal; head: AccountHead }): Promise<{ head: AccountHead; revoked: string[] }> {
    const result = await this.snapshot.transact(async state => {
      this.check(state);
      if (!state.account && !adoption) throw new BridgeSecurityError('account_approval_required');
      if (adoption) {
        if (adoption.actor.endpoint.kind !== 'browser') throw new BridgeSecurityError('permission_denied');
        this.authorize(state, adoption.actor, 'admin');
      }
      const checkpoint = await verifyAccountHistory(history, state.account?.checkpoint ?? null, this.now());
      if (checkpoint.ownerId !== this.bridge.ownerId) throw new BridgeSecurityError('wrong_context');
      if (adoption) {
        const head = adoption.head;
        if (head.rootId !== checkpoint.rootId || head.revision !== checkpoint.revision || head.head !== checkpoint.head) throw new BridgeSecurityError('account_trust_conflict');
        this.requireOwnBridge(checkpoint);
        const member = checkpoint.devices.find(item => item.endpoint.id === adoption.actor.endpoint.id);
        if (!member || member.endpoint.publicKey !== adoption.actor.endpoint.publicKey || member.endpoint.ownerId !== adoption.actor.endpoint.ownerId) {
          throw new BridgeSecurityError('account_device_revoked');
        }
        this.authorize(state, adoption.actor, 'admin');
      }
      const initial = state.account ?? { checkpoint, history, lastServerReadAt: 0, lastObservedAt: 0 };
      const now = this.connectivity.observed(initial);
      const trust = { checkpoint, history, lastServerReadAt: Math.max(initial.lastServerReadAt, now),
        lastObservedAt: Math.max(initial.lastObservedAt, now) };
      const revoked = this.projectAccount(state, trust);
      return { head: { rootId: checkpoint.rootId, revision: checkpoint.revision, head: checkpoint.head }, revoked, trust };
    });
    this.connectivity.renew(result.trust);
    return { head: result.head, revoked: result.revoked };
  }
  async close(): Promise<void> {
    await this.snapshot.transact(state => {
      this.check(state);
      if (state.account) state.account.lastObservedAt = Math.max(state.account.lastObservedAt, this.connectivity.highwater());
    });
    await this.snapshot.close();
  }
}
