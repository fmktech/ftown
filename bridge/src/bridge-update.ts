import type { VerifiedPrincipal } from './security/protocol.js';
import type { BridgeUpdateAccepted, BridgeUpdateBlock, BridgeUpdateErrorCode, BridgeUpdateOperation, BridgeUpdateStatus } from './update-protocol.js';
import type { PreparedHandoff, PreparedRelease, RestartDescriptor, StableRelease, UpdateReceipt, UpdateReservation } from './update-runtime-contract.js';
import { UpdateAdmission, UpdateResponseTicket } from './update-admission.js';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function compareVersions(a: string, b: string): number {
  if (!versionPattern.test(a) || !versionPattern.test(b)) throw new Error('Invalid version');
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export class BridgeUpdateError extends Error {
  constructor(readonly code: BridgeUpdateErrorCode, message: string) { super(message); }
}
const failure = (code: BridgeUpdateErrorCode, message: string): BridgeUpdateError => new BridgeUpdateError(code, message);

export interface BridgeUpdateDependencies {
  bridgeId: string;
  currentVersion: string;
  stagingRoot: string;
  resuming?: boolean;
  restart: RestartDescriptor;
  /** Null means supported; otherwise a stable, non-secret block reason. */
  support(): 'not_enabled' | 'unsupported_launch' | null;
  busy(): Promise<boolean>;
  authorize(principal: VerifiedPrincipal, permission: 'read' | 'control'): Promise<void>;
  resolve(signal: AbortSignal): Promise<StableRelease>;
  prepare(release: StableRelease, operationId: string, signal: AbortSignal): Promise<PreparedRelease>;
  discard(prepared: PreparedRelease): Promise<void>;
  reserve(operationId: string): Promise<UpdateReservation>;
  prepareHandoff(prepared: PreparedRelease, restart: RestartDescriptor, signal: AbortSignal): Promise<PreparedHandoff>;
  readReceipt(): Promise<UpdateReceipt | null>;
  writeReceipt(receipt: UpdateReceipt): Promise<void>;
  shutdown(): Promise<void>;
  admission: UpdateAdmission;
  now?: () => number;
}

/** Server-owned update state. The transport owns and signals the returned ticket. */
export class BridgeUpdateCoordinator {
  private operation: BridgeUpdateOperation | null = null;
  private initializing: Promise<void> | null = null;
  private latest: StableRelease | null = null;
  private checkedAt: number | null = null;
  private fetchPending: Promise<StableRelease | null> | null = null;
  private acceptance: Promise<BridgeUpdateAccepted> | null = null;
  private readonly now: () => number;
  constructor(private readonly deps: BridgeUpdateDependencies) { this.now = deps.now ?? Date.now; }

  async initialize(): Promise<void> {
    if (!this.initializing) this.initializing = this.deps.readReceipt().then(async receipt => {
      if (receipt?.schema === 1 && receipt.bridgeId === this.deps.bridgeId) {
        this.operation = receipt.operation;
        // A normal start cannot pass the reservation guard while the helper lives.
        // An unfinished receipt here therefore belongs to an interrupted attempt.
        if (!this.deps.resuming && this.active()) await this.transition(this.operation, 'failed', 'Update was interrupted');
      }
    });
    return this.initializing;
  }
  private async latestRelease(refresh: boolean): Promise<StableRelease | null> {
    const elapsed = this.checkedAt === null ? Infinity : this.now() - this.checkedAt;
    if (elapsed < (refresh ? 30_000 : 30 * 60_000)) return this.latest;
    if (!this.fetchPending) this.fetchPending = this.deps.resolve(AbortSignal.timeout(15_000)).then(release => {
      if (!versionPattern.test(release.version)) throw new Error('Invalid release');
      this.latest = release; this.checkedAt = this.now(); return release;
    }).catch(() => { this.latest = null; this.checkedAt = this.now(); return null; }).finally(() => { this.fetchPending = null; });
    return this.fetchPending;
  }
  private active(): boolean { return this.operation !== null && ['staging', 'prepared', 'restarting'].includes(this.operation.phase); }
  async snapshot(principal: VerifiedPrincipal, refresh = false): Promise<BridgeUpdateStatus> {
    await this.deps.authorize(principal, 'read');
    await this.initialize();
    // The helper writes the terminal outcome after the replacement starts.
    // Read it again so a long-lived coordinator observes that durable result.
    const receipt = await this.deps.readReceipt();
    if (receipt?.bridgeId === this.deps.bridgeId && this.operation?.id === receipt.operation.id &&
      this.operation.targetVersion === receipt.operation.targetVersion &&
      ['succeeded', 'failed'].includes(receipt.operation.phase)) this.operation = receipt.operation;
    const [latest, busy] = await Promise.all([this.latestRelease(refresh), this.deps.busy()]);
    let control = true;
    try { await this.deps.authorize(principal, 'control'); } catch { control = false; }
    const available = !!latest && compareVersions(latest.version, this.deps.currentVersion) > 0;
    const blockedReason: BridgeUpdateBlock = !control ? 'permission_denied' : this.deps.support() ??
      (this.active() || this.deps.admission.isFrozen ? 'in_progress' : busy ? 'busy' : !latest ? 'release_unavailable' : null);
    return { schema: 1, bridgeId: this.deps.bridgeId, currentVersion: this.deps.currentVersion,
      latestVersion: latest?.version ?? null, checkedAt: this.checkedAt === null ? null : new Date(this.checkedAt).toISOString(),
      availability: latest ? available ? 'available' : 'current' : 'unknown', canUpdate: available && blockedReason === null,
      blockedReason, operation: this.operation && { ...this.operation }, manualCommand: `npx ftown@${available ? latest!.version : this.deps.currentVersion} setup` };
  }
  async request(principal: VerifiedPrincipal, targetVersion: string, operationId: string): Promise<{ accepted: BridgeUpdateAccepted; ticket: UpdateResponseTicket | null }> {
    if (!versionPattern.test(targetVersion) || !uuidPattern.test(operationId)) throw failure('invalid_update_request', 'Invalid update request');
    await this.deps.authorize(principal, 'control');
    await this.initialize();
    if (this.operation?.id === operationId) {
      if (this.operation.targetVersion !== targetVersion) throw failure('invalid_update_request', 'Operation ID already used');
      if (this.acceptance) await this.acceptance;
      return { accepted: { bridgeId: this.deps.bridgeId, operation: { ...this.operation } }, ticket: null };
    }
    if (this.active() || this.deps.admission.isFrozen) throw failure('update_in_progress', 'An update is already in progress');
    const reason = this.deps.support();
    if (reason) throw failure('updates_disabled', 'Assisted updates are unavailable for this bridge');
    const now = new Date(this.now()).toISOString();
    this.operation = { id: operationId, targetVersion, phase: 'staging', startedAt: now, updatedAt: now, error: null };
    const operation = this.operation;
    this.acceptance = (async () => {
      if (await this.deps.busy()) throw failure('bridge_busy', 'Stop running sessions before updating');
      const release = await this.latestRelease(true);
      if (!release) throw failure('release_unavailable', 'Stable release is unavailable');
      if (release.version !== targetVersion || compareVersions(targetVersion, this.deps.currentVersion) <= 0)
        throw failure('update_target_changed', 'The selected release is no longer available');
      await this.deps.authorize(principal, 'control');
      await this.persist();
      return { bridgeId: this.deps.bridgeId, operation: { ...operation } };
    })();
    try {
      const accepted = await this.acceptance;
      const ticket = new UpdateResponseTicket(() => { void this.run(principal, operation); }, () => { void this.fail(operation, 'Update request was not delivered'); });
      return { accepted, ticket };
    } catch (error) {
      if (this.operation === operation) this.operation = null;
      throw error;
    } finally { this.acceptance = null; }
  }
  private async persist(): Promise<void> {
    if (this.operation) await this.deps.writeReceipt({ schema: 1, bridgeId: this.deps.bridgeId, operation: { ...this.operation } });
  }
  private async transition(operation: BridgeUpdateOperation, phase: BridgeUpdateOperation['phase'], error: string | null = null): Promise<void> {
    if (this.operation !== operation) return;
    operation.phase = phase; operation.error = error; operation.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
  }
  private async fail(operation: BridgeUpdateOperation, message: string): Promise<void> { await this.transition(operation, 'failed', message).catch(() => undefined); }
  private async run(principal: VerifiedPrincipal, operation: BridgeUpdateOperation): Promise<void> {
    let reservation: UpdateReservation | undefined;
    let prepared: PreparedRelease | undefined;
    let handoff: PreparedHandoff | undefined;
    let committed = false;
    let safeToReopen = true;
    try {
      await this.deps.authorize(principal, 'control');
      reservation = await this.deps.reserve(operation.id);
      const release = await this.deps.resolve(AbortSignal.timeout(15_000));
      if (!release || release.version !== operation.targetVersion || compareVersions(release.version, this.deps.currentVersion) <= 0) throw new Error('Release changed');
      prepared = await this.deps.prepare(release, operation.id, AbortSignal.timeout(300_000));
      this.deps.admission.freeze();
      await this.deps.admission.drain(15_000);
      await this.deps.authorize(principal, 'control');
      if (this.deps.support() || await this.deps.busy()) throw new Error('Bridge is unavailable');
      handoff = await this.deps.prepareHandoff(prepared, this.deps.restart, AbortSignal.timeout(15_000));
      await this.transition(operation, 'prepared');
      await this.deps.authorize(principal, 'control');
      if (this.deps.support() || await this.deps.busy()) throw new Error('Bridge is unavailable');
      await this.transition(operation, 'restarting');
      await this.deps.authorize(principal, 'control');
      await handoff.commit();
      // The helper is armed but remains cancellable while this process is alive.
      await this.deps.authorize(principal, 'control');
      committed = true;
      await this.deps.shutdown();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error &&
        (error.code === 'handoff_uncertain' || error.code === 'update_process_uncertain')) {
        // Staging may fail before the ordinary freeze; an unproved child exit
        // can still mutate its stage and must keep every launch fenced.
        this.deps.admission.freeze();
        safeToReopen = false;
      }
      if (!committed && handoff) {
        try { await handoff.cancel(); } catch { safeToReopen = false; }
      }
      if (!committed && safeToReopen) {
        if (prepared) await this.deps.discard(prepared).catch(() => undefined);
        if (reservation) await reservation.release().catch(() => { safeToReopen = false; });
        if (safeToReopen) this.deps.admission.reopen();
      }
      if (!safeToReopen || committed) {
        await this.transition(operation, 'restarting', 'Update handoff outcome is uncertain').catch(() => undefined);
      } else {
        await this.fail(operation, 'Update could not be started');
      }
    }
  }
}
