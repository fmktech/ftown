import { legacyDateTimeSchema } from '../../zod-compat.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ApprovedEndpoint, BridgeInvitation, EndpointPermission, EndpointPublic, EnrollmentMessage, InvitationOptions,
  LocalRecoveryAuthority, VerifiedPrincipal } from '../protocol.js';
import { BridgeSecurityError } from './errors.js';
import { approvedSchema, boundedId, displayLabel, endpointSchema, permissionSchema } from './metadata.js';
import { AtomicSnapshot } from './snapshot.js';
import { LEDGER_LIMITS, type LedgerCheckpoint } from '../ledger/protocol.js';

const FIVE_MINUTES = 300_000;
const MAX_ENDPOINTS = 1000;
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
const invitationSchema = z.object({ id: z.string().guid(), secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().max(100), permissions: z.array(permissionSchema).max(3), expiresAt: legacyDateTimeSchema,
  consumedBy: z.string().nullable(), provenance: z.literal('legacy').default('legacy') }).strict();
/** Pre-removal policy files carry `mcp: []`, mcp devices and mcp provenance; the strict schema would reject them and brick the bridge.
 *  Files written before the ledger carry `account: null` (Solo/local always did): dropped. A non-null v1 account section is kept, so
 *  the strict schema refuses it: v1 account state is never reinterpreted (startup resets such a bridge's identity instead). */
export function migrateLegacyPolicy(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const { mcp: _mcp, ...rest } = raw as Record<string, unknown>;
  if (rest.account === null) delete rest.account;
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
  // 'account': projected from the ledger replica (account mode only). 'legacy': enrolled by invitation. 'local-cli': OS-local CLI.
  provenance: z.record(z.string(), z.enum(['legacy', 'account', 'local-cli'])).default({}),
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

export interface PolicyOptions { now?: () => number; relayUrl?: string; localOrigin?: string }

/** This bridge in its trusted ledger: 'unpaired' = no ledger stored, 'absent' = not listed with exactly its keys (or another
 *  account's ledger), 'revoked' = its bridgeId is revoked (signed in the stored chain, or sticky from a chain the replica adopted;
 *  a refused, diverged chain never counts). */
export type LedgerOwnStatus = 'active' | 'revoked' | 'absent' | 'unpaired';
/** The account-mode authority, held in memory and replaced only by BridgeSecurityService. */
export interface LedgerView {
  /** applyRevocations(checkpoint, sticky) of the stored chain; null while no ledger is stored. Never the raw checkpoint. */
  trusted: LedgerCheckpoint | null;
  own: LedgerOwnStatus;
  /** The ledger store's lastServerReadAt (null = never). Read once, on the first projection; afterwards contacts set it. */
  lastServerReadAt: number | null;
}
const isTime = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;

/** Account-mode authority, in memory. Offline grace is bounded three ways, each failing closed: wall time since the last contact, wall
 *  time never before the last contact or the observed high-water (persisted in `ledger-clock.json`, so a rollback across a restart is
 *  caught), and, after a contact in this process, monotonic time since it. */
interface LedgerGate {
  view: { trusted: LedgerCheckpoint | null; own: LedgerOwnStatus };
  now: () => number;
  monotonic: () => number;
  loaded: boolean;
  lastServerReadAt: number | null;
  /** monotonic() at the last contact in this process. */
  contactAt: number | null;
  /** Latest wall time observed by a contact or a passing grace check; `persisted` is what the file holds. */
  highWater: number;
  persisted: number;
  /** 'untrusted': the high-water file was unreadable, so a contact in this process is required. */
  clock: 'loading' | 'trusted' | 'untrusted';
  clockLoad: Promise<void> | null;
  clockWrite: Promise<void>;
}
const CLOCK_KEYS = ['version', 'observedAt'];
async function readClock(file: string): Promise<number | 'absent' | 'corrupt'> {
  let text: string;
  try {
    const handle = await open(file, 'r');
    try {
      if ((await handle.stat()).size > 4096) return 'corrupt';
      text = await handle.readFile('utf8');
    } finally { await handle.close(); }
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'corrupt'; }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'corrupt';
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const observedAt = record.observedAt;
    if (keys.length !== CLOCK_KEYS.length || keys.some(key => !CLOCK_KEYS.includes(key)) || record.version !== 1
      || typeof observedAt !== 'number' || !isTime(observedAt)) return 'corrupt';
    return observedAt;
  } catch { return 'corrupt'; }
}
async function writeClock(file: string, observedAt: number): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, observedAt })); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new BridgeSecurityError('storage_unavailable');
  }
}

/** Bridge-owned authorization. Directory entries and caller-claimed permissions never enter this store. */
export class BridgePolicyStore {
  private readonly snapshot: AtomicSnapshot<Policy>;
  private readonly now: () => number;
  private readonly clockFile: string;
  /** Account mode (enableLedger): null for Solo and --local, whose devices come only from invitations and the local CLI. */
  private ledger: LedgerGate | null = null;
  constructor(dataDir: string, readonly bridgeId: string, readonly bridge: EndpointPublic, private readonly options: PolicyOptions = {}) {
    endpointSchema.parse(bridge);
    if (bridge.kind !== 'bridge') throw new BridgeSecurityError('wrong_context');
    this.now = options.now ?? Date.now;
    this.clockFile = join(dataDir, 'security', 'ledger-clock.json');
    this.snapshot = new AtomicSnapshot<Policy>(join(dataDir, 'security', 'policy.json'), policySchema, () => ({
      version: 1, ownerId: bridge.ownerId, bridgeId, bridgeEndpointId: bridge.id, generation: 0,
      devices: [], invitations: [], mcp: [], provenance: {},
    }));
  }
  private check(state: Policy): void {
    if (state.ownerId !== this.bridge.ownerId || state.bridgeId !== this.bridgeId || state.bridgeEndpointId !== this.bridge.id) {
      throw new BridgeSecurityError('wrong_context');
    }
  }
  private active(state: Policy, endpointId: string): ApprovedEndpoint {
    this.check(state);
    const record = state.devices.find(device => device.endpoint.id === endpointId);
    if (this.ledger) this.ledgerAccess(state, endpointId, record);
    // Without a ledger nothing vouches for a projected account device: it never authorizes.
    else if (state.provenance[endpointId] === 'account') throw new BridgeSecurityError('approval_required');
    if (!record) throw new BridgeSecurityError('approval_required');
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.now()) throw new BridgeSecurityError('expired');
    return record;
  }
  /** Account mode. A revoked id is never trusted again. The OS-local CLI stays outside the ledger; every other endpoint must be a
   *  projected ledger device that the CURRENT trusted view lists with the same key, while this bridge is active and in offline grace. */
  private ledgerAccess(state: Policy, endpointId: string, record: ApprovedEndpoint | undefined): void {
    const view = this.ledger!.view;
    if (view.trusted?.revokedDeviceIds.includes(endpointId)) throw new BridgeSecurityError('account_device_revoked');
    if (!record || record.endpoint.kind === 'local-cli') return;
    if (state.provenance[endpointId] !== 'account') throw new BridgeSecurityError('approval_required');
    if (view.trusted === null) throw new BridgeSecurityError('account_offline_expired');
    if (view.own !== 'active') throw new BridgeSecurityError('account_bridge_revoked');
    if (!this.withinGrace()) throw new BridgeSecurityError('account_offline_expired');
    const member = view.trusted.devices.find(item => item.endpoint.id === endpointId);
    if (!member || member.endpoint.publicKey !== record.endpoint.publicKey) throw new BridgeSecurityError('account_device_revoked');
  }
  /** Written so that NaN, an unknown contact or an unread clock file fails closed. A passing check raises the high-water. */
  private withinGrace(): boolean {
    const gate = this.ledger!;
    const at = gate.now();
    const monotonic = gate.monotonic();
    const last = gate.lastServerReadAt;
    const { offlineGraceMs: grace, maxFutureSkewMs: skew } = LEDGER_LIMITS;
    const within = gate.clock !== 'loading' && (gate.clock === 'trusted' || gate.contactAt !== null)
      && isTime(last) && Number.isSafeInteger(at)
      // The wall clock went back before the last contact, or before a time this bridge already observed (also across restarts).
      && at >= last - skew && at >= gate.highWater - skew
      && at - last <= grace
      && (gate.contactAt === null || (Number.isFinite(monotonic) && monotonic >= gate.contactAt && monotonic - gate.contactAt <= grace));
    if (within && at > gate.highWater) gate.highWater = at;
    return within;
  }
  /** Loads the persisted high-water once (absent: none; unreadable: a contact in this process is then required). */
  private loadClock(): Promise<void> {
    const gate = this.ledger!;
    gate.clockLoad ??= readClock(this.clockFile).then(stored => {
      if (typeof stored === 'number') {
        gate.highWater = Math.max(gate.highWater, stored);
        gate.persisted = stored;
      }
      gate.clock = stored === 'corrupt' ? 'untrusted' : 'trusted';
    });
    return gate.clockLoad;
  }
  /** Persists the observed high-water (after a contact, and on close). An unreadable file is only replaced after a fresh contact. */
  async persistLedgerClock(): Promise<void> {
    const gate = this.ledger;
    if (!gate) return;
    await this.loadClock();
    if (gate.clock === 'untrusted' && gate.contactAt === null) return;
    const write = gate.clockWrite.then(async () => {
      const observedAt = gate.highWater;
      if (observedAt <= gate.persisted) return;
      await writeClock(this.clockFile, observedAt);
      gate.persisted = Math.max(gate.persisted, observedAt);
    });
    gate.clockWrite = write.catch(() => undefined);
    await write;
  }
  private refuseInAccountMode(): void {
    if (this.ledger) throw new BridgeSecurityError('account_managed');
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
      // Account mode: browsers join only through the ledger, whoever asks.
      this.refuseInAccountMode();
      if (actor !== LOCAL_RECOVERY_AUTHORITY) this.authorize(state, actor as VerifiedPrincipal, 'admin');
      state.invitations = state.invitations.filter(invitation => Date.parse(invitation.expiresAt) > this.now());
      if (state.invitations.length >= 256) throw new BridgeSecurityError('capacity_exceeded');
      state.invitations.push({ id: invitationId, secretHash: digest(secret), label: displayLabel(options.label),
        permissions: ['read', 'control', 'admin'], expiresAt, consumedBy: null, provenance: 'legacy' });
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
      this.refuseInAccountMode();
      const invitation = state.invitations.find(item => item.id === message.invitationId);
      if (!invitation || !timingSafeEqual(Buffer.from(invitation.secretHash), Buffer.from(digest(message.invitationSecret)))) {
        throw new BridgeSecurityError('invitation_invalid');
      }
      if (Date.parse(invitation.expiresAt) <= this.now()) throw new BridgeSecurityError('invitation_expired');
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
        if (provenance === 'local-cli') return { ...device, source: 'local' as const };
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
      // A ledger device leaves only by a passkey-signed revoke_device; the bridge never drops it on request.
      if (this.ledger && (state.provenance[endpointId] === 'account'
        || this.ledger.view.trusted?.devices.some(item => item.endpoint.id === endpointId))) throw new BridgeSecurityError('account_managed');
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
  /** Enters account mode for this instance (irreversible): until projectLedger supplies a view, every non-local endpoint fails closed,
   *  and invitations are refused. Only BridgeSecurityService calls this, with a ledger configured. */
  enableLedger(now: () => number, monotonic: () => number): void {
    this.ledger ??= { view: { trusted: null, own: 'unpaired' }, now, monotonic, loaded: false, lastServerReadAt: null, contactAt: null,
      highWater: 0, persisted: 0, clock: 'loading', clockLoad: null, clockWrite: Promise.resolve() };
  }
  /**
   * Account mode only. Installs `view` synchronously (a revocation never waits for the write below), then makes the provenance-'account'
   * devices exactly `view.trusted.devices` (none when trusted is null or another account's). Devices of any other provenance are never
   * touched, and a ledger device whose id is already held by one is skipped. Returns the endpoint ids that lost account membership.
   * `view.lastServerReadAt` is taken only on the first projection; later contacts come from noteServerRead.
   */
  projectLedger(view: LedgerView): Promise<string[]> {
    const ledger = this.ledger;
    if (!ledger) return Promise.reject(new BridgeSecurityError('wrong_context'));
    const trusted = view.trusted !== null && view.trusted.accountId === this.bridge.ownerId ? view.trusted : null;
    ledger.view = { trusted, own: trusted === null && view.own === 'active' ? 'absent' : view.own };
    if (!ledger.loaded) {
      ledger.loaded = true;
      ledger.lastServerReadAt = isTime(view.lastServerReadAt) ? view.lastServerReadAt : null;
    }
    const clock = this.loadClock();
    const members = trusted === null ? [] : trusted.devices;
    return clock.then(() => this.snapshot.transact(state => {
      this.check(state);
      const removed: string[] = [];
      state.devices = state.devices.filter(device => {
        const id = device.endpoint.id;
        if (state.provenance[id] !== 'account') return true;
        const member = members.find(item => item.endpoint.id === id);
        if (member && member.endpoint.publicKey === device.endpoint.publicKey) return true;
        removed.push(id);
        delete state.provenance[id];
        return false;
      });
      for (const member of members) {
        if (state.devices.some(device => device.endpoint.id === member.endpoint.id)) continue;
        if (state.devices.length >= MAX_ENDPOINTS) throw new BridgeSecurityError('capacity_exceeded');
        state.devices.push({ endpoint: member.endpoint, label: displayLabel(member.label), permissions: ['read', 'control', 'admin'],
          approvedAt: new Date(member.approvedAt).toISOString(), grantId: null, expiresAt: null });
        state.provenance[member.endpoint.id] = 'account';
      }
      // Never the global generation: a ledger change must not disturb the principals it leaves in place. A removed device is
      // invalidated on its own: its record is gone (and the view refuses it), so its next principal/revalidate fails, and the
      // caller emits onRevoked for it.
      return removed;
    }));
  }
  /** Account mode: a successful server contact at wall time `at` re-anchors offline grace (lastServerReadAt = at, even if earlier: a
   *  contact stamped during a forward clock jump never outlives its correction), restarts the monotonic bound and raises the high-water.
   *  Returns `at`, or null (nothing changed) outside account mode or for an invalid time. */
  noteServerRead(at: number): number | null {
    const ledger = this.ledger;
    if (!ledger || !isTime(at)) return null;
    ledger.loaded = true;
    ledger.lastServerReadAt = at;
    ledger.contactAt = ledger.monotonic();
    if (at > ledger.highWater) ledger.highWater = at;
    return at;
  }
  async close(): Promise<void> {
    if (this.ledger) {
      await this.persistLedgerClock().catch((error: unknown) => console.error('[Security] Saving the ledger clock failed:', error instanceof Error ? error.message : String(error)));
    }
    await this.snapshot.close();
  }
}
