import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { open, seal, parseSecureEnvelope } from '../crypto.js';
import type { ApplicationJson, ApplicationRoute, ApprovedEndpoint, BridgeInvitation, BridgeSecurity, EndpointIdentity, EnrollmentPacket,
  InboundTransportContext, InvitationOptions, LocalRecoveryAuthority,
  SecureApplication, SecureEnvelope, SecurePublication, VerifiedApplication, VerifiedPrincipal } from '../protocol.js';
import { BridgePolicyStore, type PolicyOptions } from './policy.js';
import { BridgeSecurityError } from './errors.js';
import { classifyCommand, classifyHttp, classifyTerminal, type OperationPermission } from './permissions.js';
import { endpointSchema } from './metadata.js';
import { ACCOUNT_TRUST_LIMITS, AccountTrustError } from '../account-crypto.js';
import type { AccountCheckpoint, AccountHead, AccountHistory, VerifiedAccountTrust } from '../account-protocol.js';
import { AccountReadUnavailable } from './account-client.js';
import { AccountBridgeRevoked, confirmOwnRevocation, isOwnBridgeRevoked } from './revocation.js';
import { ACCOUNT_SAFETY_REFRESH_MS, SECURITY_NUDGE_MIN_SPACING_MS, createCoalescedTrigger, type CoalescedTrigger } from '../security-nudge.js';

const token = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const routeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), requestId: token, command: z.string().min(1).max(100), sessionId: token.nullable() }).strict(),
  z.object({ kind: z.literal('http'), requestId: token, method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']), path: z.string().max(16384) }).strict(),
  z.object({ kind: z.literal('terminal'), sessionId: z.string().max(200), frameType: z.string().max(50), pairId: token.nullable() }).strict(),
  z.object({ kind: z.literal('response'), requestId: token }).strict(), z.object({ kind: z.literal('publication') }).strict(),
]);
const object = (value: ApplicationJson): Record<string, ApplicationJson> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeSecurityError('invalid_envelope');
  return value;
};
export const applicationJson = (value: unknown): ApplicationJson => JSON.parse(JSON.stringify(value)) as ApplicationJson;
export interface BridgeSecurityOptions extends PolicyOptions {
  relayUserId: string; browserOrigin?: string;
  readAccountHistory?: (signal?: AbortSignal) => Promise<AccountHistory | null>;
  /** Jitter source for account-read retry backoff; defaults to Math.random. */
  random?: () => number;
}
const ACCOUNT_READ_RETRY_BASE_MS = 60_000;
const ACCOUNT_READ_RETRY_MAX_MS = 1_800_000;

export class BridgeSecurityService implements BridgeSecurity {
  readonly endpoint;
  readonly receiverEpoch = randomUUID();
  readonly policy: BridgePolicyStore;
  private readonly now: () => number;
  private readonly replay = new Map<string, number>();
  private readonly revoked = new Set<(endpointId: string) => void>();
  private readonly bridgeRevokedListeners = new Set<() => void>();
  private readonly bridgeRevokedNotified = new WeakSet<() => void>();
  private bridgeRevokedEmitted = false;
  private readonly verified = new WeakSet<VerifiedApplication>();
  private closed = false;
  private accountTimer: ReturnType<typeof setTimeout> | null = null;
  private accountTimerDue = 0;
  private accountPushHealthy = false;
  private accountReadFailures = 0;
  private accountRefresh: Promise<void> | null = null;
  private accountTrigger: CoalescedTrigger | null = null;
  private readonly accountAbort = new AbortController();
  constructor(readonly identity: EndpointIdentity, readonly bridgeId: string, dataDir: string, readonly options: BridgeSecurityOptions) {
    this.endpoint = identity.endpoint; this.now = options.now ?? Date.now;
    this.policy = new BridgePolicyStore(dataDir, bridgeId, this.endpoint, options);
  }
  private context(route: InboundTransportContext): void {
    if (this.closed || route.bridgeId !== this.bridgeId) throw new BridgeSecurityError('wrong_context');
    const expected = route.transport === 'local-http' ? `local-http:${this.bridgeId}`
      : route.transport === 'local-events' ? `local-events:${this.bridgeId}`
      : route.transport === 'cloud' ? route.channel
      : `direct:${route.transport}:${this.bridgeId}:${route.pairId}`;
    if (expected !== route.channel || ((route.transport === 'webrtc' || route.transport === 'loopback-ws') && !route.pairId)) {
      throw new BridgeSecurityError('wrong_context');
    }
  }
  private freshness(envelope: SecureEnvelope, executable: boolean): void {
    const now = this.now();
    if (envelope.createdAt > now + 30000 || envelope.expiresAt <= now || envelope.expiresAt - envelope.createdAt > 120000) {
      throw new BridgeSecurityError('expired');
    }
    if (executable && envelope.receiverEpoch !== this.receiverEpoch) throw new BridgeSecurityError('epoch_changed');
  }
  private claim(envelope: SecureEnvelope): void {
    const now = this.now();
    for (const [id, expires] of this.replay) if (expires <= now) this.replay.delete(id);
    const id = `${envelope.senderId}:${envelope.messageId}`;
    if (this.replay.has(id)) throw new BridgeSecurityError('replayed');
    if (this.replay.size >= 10000) throw new BridgeSecurityError('capacity_exceeded');
    this.replay.set(id, envelope.expiresAt);
  }
  private async decode(sender: ApprovedEndpoint['endpoint'], envelope: SecureEnvelope, route: InboundTransportContext): Promise<unknown> {
    this.context(route);
    const bytes = await open(this.identity, sender, envelope, { ownerId: this.endpoint.ownerId, bridgeId: this.bridgeId,
      channel: route.channel, recipientId: this.endpoint.id, purpose: envelope.purpose });
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new BridgeSecurityError('invalid_envelope'); }
  }
  private async reply(recipient: ApprovedEndpoint['endpoint'], purpose: SecureEnvelope['purpose'], data: unknown,
    route: InboundTransportContext, messageId: string = randomUUID()): Promise<SecureEnvelope> {
    this.context(route);
    return seal(this.identity, recipient, { type: 'ftown_encrypted', version: 1, senderId: this.endpoint.id, recipientId: recipient.id,
      ownerId: this.endpoint.ownerId, bridgeId: this.bridgeId, channel: route.channel, purpose, messageId,
      createdAt: this.now(), expiresAt: this.now() + 120000, receiverEpoch: null }, new TextEncoder().encode(JSON.stringify(data)));
  }
  async handleHandshake(packet: SecureEnvelope | EnrollmentPacket, route: InboundTransportContext): Promise<SecureEnvelope> {
    this.context(route);
    if (packet.type === 'ftown_enrollment') {
      const wrapper = z.object({ type: z.literal('ftown_enrollment'), version: z.literal(1), candidate: endpointSchema, envelope: z.unknown().optional() }).strict().parse(packet);
      const envelope = parseSecureEnvelope(wrapper.envelope);
      if (envelope.purpose !== 'enroll') throw new BridgeSecurityError('wrong_context');
      this.freshness(envelope, false);
      const message = z.object({ type: z.literal('enroll'), candidate: endpointSchema, invitationId: z.string().guid(),
        invitationSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), label: z.string().max(200) }).strict().parse(await this.decode(wrapper.candidate, envelope, route));
      if (JSON.stringify(message.candidate) !== JSON.stringify(wrapper.candidate)) throw new BridgeSecurityError('wrong_context');
      const approved = await this.policy.consumeInvitation(message);
      return this.reply(approved.endpoint, 'enrolled', { type: 'enrolled', invitationId: message.invitationId, approved, receiverEpoch: this.receiverEpoch }, route, envelope.messageId);
    }
    const envelope = parseSecureEnvelope(packet);
    if (envelope.purpose !== 'hello') throw new BridgeSecurityError('wrong_context');
    this.freshness(envelope, false);
    const principal = await this.policy.principal(envelope.senderId);
    const hello = z.object({ type: z.literal('hello'), challenge: token }).strict().parse(await this.decode(principal.endpoint, envelope, route));
    const welcome = await this.reply(principal.endpoint, 'welcome', { type: 'welcome', challenge: hello.challenge, receiverEpoch: this.receiverEpoch }, route, envelope.messageId);
    const current = await this.policy.principal(principal.endpoint.id);
    if (current.endpoint.publicKey !== principal.endpoint.publicKey) throw new BridgeSecurityError('wrong_context');
    return welcome;
  }
  private parseApplication(value: unknown): SecureApplication {
    const parsed = z.object({ type: z.literal('application'), route: routeSchema, data: z.unknown().optional(), mcp: z.null() }).strict().parse(value);
    return { ...parsed, data: applicationJson(parsed.data) };
  }
  private requirement(application: SecureApplication, transport: InboundTransportContext): OperationPermission {
    const route = application.route;
    if ((transport.transport === 'webrtc' || transport.transport === 'loopback-ws') && route.kind !== 'terminal') {
      throw new BridgeSecurityError('wrong_context');
    }
    if (route.kind === 'command') {
      const data = object(application.data);
      if (['terminal_watch', 'terminal_unwatch', 'webrtc_offer', 'webrtc_answer', 'webrtc_ice', 'webrtc_close'].includes(route.command)) {
        if (data.type !== route.command || (data.bridgeId !== undefined && data.bridgeId !== this.bridgeId)
          || (typeof data.sessionId === 'string' ? data.sessionId : null) !== route.sessionId) throw new BridgeSecurityError('wrong_context');
        return classifyCommand(route.command, data);
      }
      const payload = object(data.payload ?? null);
      if (data.type !== route.command || data.requestId !== route.requestId || payload.bridgeId !== this.bridgeId
        || (typeof payload.sessionId === 'string' ? payload.sessionId : null) !== route.sessionId) throw new BridgeSecurityError('wrong_context');
      return classifyCommand(route.command, payload);
    }
    if (route.kind === 'http') {
      const data = object(application.data);
      if (Object.keys(data).some(key => key !== 'body' && key !== 'timeoutMs' && key !== 'callerSessionId')
        || (data.timeoutMs !== undefined && (typeof data.timeoutMs !== 'number' || !Number.isInteger(data.timeoutMs) || data.timeoutMs < 1 || data.timeoutMs > 60000))) throw new BridgeSecurityError('invalid_envelope');
      return classifyHttp(route.method, route.path);
    }
    if (route.kind === 'terminal') {
      const data = object(application.data);
      if (route.pairId !== transport.pairId || data.kind !== route.frameType
        || (typeof data.sessionId === 'string' ? data.sessionId : '') !== route.sessionId) throw new BridgeSecurityError('wrong_context');
      if (route.sessionId && !/^[A-Za-z0-9_-]+$/.test(route.sessionId)) throw new BridgeSecurityError('invalid_envelope');
      return classifyTerminal(route.frameType);
    }
    throw new BridgeSecurityError('permission_denied');
  }
  async acceptApplication(packet: SecureEnvelope, route: InboundTransportContext): Promise<VerifiedApplication> {
    const envelope = parseSecureEnvelope(packet);
    if (envelope.purpose !== 'application') throw new BridgeSecurityError('wrong_context');
    const principal = await this.policy.principal(envelope.senderId);
    const app = this.parseApplication(await this.decode(principal.endpoint, envelope, route));
    if (app.route.kind === 'http') {
      const data = object(app.data);
      if (data.callerSessionId !== undefined && (principal.endpoint.kind !== 'local-cli'
        || typeof data.callerSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.callerSessionId))) throw new BridgeSecurityError('permission_denied');
    }
    this.freshness(envelope, true); this.claim(envelope);
    const operation = this.requirement(app, route);
    await this.policy.revalidate(principal, operation.permission);
    const message = { principal, envelope, application: app };
    this.verified.add(message); return message;
  }
  async revalidate(principal: VerifiedPrincipal): Promise<void> { await this.policy.revalidate(principal); }
  /** One non-content receipt, prepared while authorized and released only after durable self-removal. */
  async revokeSelfWithReceipt(message: VerifiedApplication, route: InboundTransportContext): Promise<SecureEnvelope | null> {
    const application = message.application;
    if (application.route.kind !== 'command' || application.route.command !== 'security_revoke') return null;
    const data = object(application.data); const payload = object(data.payload ?? null);
    if (payload.endpointId !== message.principal.endpoint.id) return null;
    if (!this.verified.has(message) || message.envelope.senderId !== message.principal.endpoint.id
      || message.envelope.channel !== route.channel || message.envelope.bridgeId !== route.bridgeId
      || message.envelope.messageId !== application.route.requestId || payload.bridgeId !== this.bridgeId) {
      throw new BridgeSecurityError('wrong_context');
    }
    await this.policy.revalidate(message.principal, 'admin');
    const receipt = await this.reply(message.principal.endpoint, 'application', { type: 'application',
      route: { kind: 'response', requestId: application.route.requestId }, mcp: null,
      data: { type: 'command_response', response: { requestId: application.route.requestId, success: true,
        data: { endpointId: message.principal.endpoint.id, revoked: true } } } }, route, application.route.requestId);
    // No sealed value leaves this method before the durable self-removal has succeeded.
    await this.revokeEndpoint(message.principal, message.principal.endpoint.id);
    this.verified.delete(message);
    return receipt;
  }
  async sealTo(recipientId: string, application: SecureApplication, route: InboundTransportContext): Promise<SecureEnvelope> {
    const principal = await this.policy.principal(recipientId);
    const envelope = await this.reply(principal.endpoint, 'application', application, route,
      application.route.kind === 'response' ? application.route.requestId : randomUUID());
    await this.policy.revalidate(principal);
    return envelope;
  }
  async sealPublication(channel: string, application: SecureApplication): Promise<(SecureEnvelope | SecurePublication)[]> {
    const recipients = await this.policy.recipients();
    const packets: SecureEnvelope[] = [];
    for (const recipient of recipients) {
      try { packets.push(await this.sealTo(recipient.endpoint.id, application, { transport: 'cloud', channel, bridgeId: this.bridgeId, pairId: null })); }
      catch (error) { if (!(error instanceof BridgeSecurityError) || (!['endpoint_revoked', 'approval_required', 'expired', 'invalid_account_trust'].includes(error.code)
        && !error.code.startsWith('account_'))) throw error; }
    }
    return packets;
  }
  createInvitation(actor: VerifiedPrincipal | LocalRecoveryAuthority, options: InvitationOptions): Promise<BridgeInvitation> { return this.policy.createInvitation(actor, options); }
  listDevices(actor: VerifiedPrincipal): Promise<ApprovedEndpoint[]> { return this.policy.list(actor); }
  async revokeEndpoint(actor: VerifiedPrincipal, endpointId: string): Promise<void> {
    await this.policy.revoke(actor, endpointId);
    for (const listener of this.revoked) listener(endpointId);
  }
  /** Called once at startup; legacy/Solo stores never adopt an unsigned server directory. */
  async startAccount(trust?: VerifiedAccountTrust): Promise<void> {
    // A pin that already tombstones this bridge is signed proof on its own; no read can undo it.
    if (isOwnBridgeRevoked(await this.pinnedCheckpoint(), this.bridgeId)) { this.emitBridgeRevoked(); return; }
    if (trust) await this.policy.pinBootstrap(trust);
    this.recordAccountRead(await this.refreshAccount().then(() => true, () => false));
    if (!this.closed && !this.accountTimer && this.options.readAccountHistory) this.scheduleAccountRead();
  }
  private recordAccountRead(ok: boolean): void {
    this.accountReadFailures = ok ? 0 : this.accountReadFailures + 1;
  }
  /** After failures the server is the only writer of account state, so retrying fast buys nothing: back off with jitter. */
  private nextAccountReadDelay(): number {
    if (this.accountReadFailures > 0) {
      const base = Math.min(ACCOUNT_READ_RETRY_BASE_MS * 2 ** (this.accountReadFailures - 1), ACCOUNT_READ_RETRY_MAX_MS);
      return base * (0.8 + 0.4 * (this.options.random ?? Math.random)());
    }
    return this.accountPushHealthy ? ACCOUNT_SAFETY_REFRESH_MS : ACCOUNT_TRUST_LIMITS.refreshIntervalMs;
  }
  /** Safety read: 1 h while push is healthy and the last read succeeded, else the 10 min cadence; failed reads back off from 60 s to 30 min. */
  private scheduleAccountRead(delay = this.nextAccountReadDelay()): void {
    if (this.closed || this.bridgeRevokedEmitted || !this.options.readAccountHistory) return;
    if (this.accountTimer) clearTimeout(this.accountTimer);
    this.accountTimerDue = performance.now() + delay; // monotonic: wall-clock steps and sleep must not skew the pull-in
    this.accountTimer = setTimeout(() => { this.accountTimer = null; void this.trackedAccountRead(); }, delay);
    this.accountTimer.unref();
  }
  private async trackedAccountRead(): Promise<void> {
    try { await this.refreshAccount(); this.recordAccountRead(true); } catch { this.recordAccountRead(false); }
    this.scheduleAccountRead();
  }
  /** Push (nudge subscription) health; losing it pulls the next safety read in to the 10 min cadence. */
  setAccountPushHealthy(healthy: boolean): void {
    const lost = this.accountPushHealthy && !healthy;
    this.accountPushHealthy = healthy;
    if (lost && this.accountTimer && this.accountTimerDue - performance.now() > ACCOUNT_TRUST_LIMITS.refreshIntervalMs) {
      this.scheduleAccountRead(ACCOUNT_TRUST_LIMITS.refreshIntervalMs);
    }
  }
  /** Push-driven re-read (account nudge); bursts coalesce into at most one trailing read. */
  requestAccountRefresh(): void {
    if (this.closed || this.bridgeRevokedEmitted || !this.options.readAccountHistory) return;
    this.accountTrigger ??= createCoalescedTrigger(async () => {
      // An in-flight read may predate the change, so it never satisfies a request.
      await this.accountRefresh?.catch(() => undefined);
      if (!this.closed) await this.trackedAccountRead();
    }, SECURITY_NUDGE_MIN_SPACING_MS);
    this.accountTrigger.request();
  }
  private accountFailure(error: unknown): BridgeSecurityError {
    return error instanceof BridgeSecurityError ? error : new BridgeSecurityError(error instanceof AccountTrustError ? error.code : 'invalid_account_trust');
  }
  private emitRevoked(endpointIds: string[]): void {
    for (const id of endpointIds) for (const listener of this.revoked) listener(id);
  }
  private async pinnedCheckpoint(): Promise<AccountCheckpoint | null> {
    try { return (await this.policy.accountTrust())?.checkpoint ?? null; } catch { return null; }
  }
  /** A refused fetched history is still evidence, but only against the pin as it stands now: adoption is not serialized
   *  with reads, and a fork from an older pin must never confirm. Pins only move forward by verified extension. */
  private async adoptFetched<T>(fetched: AccountHistory, adopt: () => Promise<T>): Promise<T> {
    let adopted: T;
    try { adopted = await adopt(); } catch (error) {
      if (!this.bridgeRevokedEmitted) await this.confirmRevocationEvidence(fetched);
      throw error;
    }
    if (!this.bridgeRevokedEmitted && isOwnBridgeRevoked(await this.pinnedCheckpoint(), this.bridgeId)) this.emitBridgeRevoked();
    return adopted;
  }
  async confirmRevocationEvidence(evidence: AccountHistory): Promise<boolean> {
    const confirmed = await confirmOwnRevocation({ evidence, pinned: await this.pinnedCheckpoint(), bridgeId: this.bridgeId, now: this.now() });
    if (confirmed) this.emitBridgeRevoked();
    return confirmed;
  }
  private emitBridgeRevoked(): void {
    if (this.bridgeRevokedEmitted) return;
    this.bridgeRevokedEmitted = true;
    if (this.accountTimer) clearTimeout(this.accountTimer);
    this.accountTimer = null;
    this.accountTrigger?.dispose(); this.accountTrigger = null;
    for (const listener of Array.from(this.bridgeRevokedListeners)) this.notifyBridgeRevoked(listener);
  }
  private notifyBridgeRevoked(listener: () => void): void {
    if (this.bridgeRevokedNotified.has(listener)) return;
    this.bridgeRevokedNotified.add(listener);
    const failed = (error: unknown) => console.error('[Security] bridgeRevoked listener failed:', error);
    try {
      const result: unknown = listener();
      if (result instanceof Promise) result.catch(failed);
    } catch (error) { failed(error); }
  }
  async refreshAccount(): Promise<void> {
    if (this.accountRefresh) return this.accountRefresh;
    const run = async (): Promise<void> => {
      if (this.closed || this.bridgeRevokedEmitted || !await this.policy.accountTrust()) return;
      try {
        if (!this.options.readAccountHistory) throw new AccountReadUnavailable();
        const history = await this.options.readAccountHistory(this.accountAbort.signal);
        if (!history) throw new BridgeSecurityError('account_trust_rollback');
        if (this.closed) return;
        const result = await this.adoptFetched(history, () => this.policy.applyAccountRead(history));
        this.emitRevoked(result.revoked);
      } catch (error) {
        // Unverified revocation evidence is only an unavailable read: a forged refusal must neither reset nor block.
        if (error instanceof AccountBridgeRevoked) await this.confirmRevocationEvidence(error.evidence);
        else if (!(error instanceof AccountReadUnavailable)) this.policy.blockAccount(this.accountFailure(error).code);
        if (!await this.policy.accountAvailable()) this.emitRevoked(await this.policy.accountEndpointIds());
        throw error;
      }
    };
    this.accountRefresh = run().finally(() => { this.accountRefresh = null; });
    return this.accountRefresh;
  }
  async adoptAccount(actor: VerifiedPrincipal, head: AccountHead): Promise<AccountHead> {
    await this.policy.revalidate(actor, 'admin');
    if (actor.endpoint.kind !== 'browser' || !this.options.readAccountHistory) throw new BridgeSecurityError('account_approval_required');
    if (this.bridgeRevokedEmitted) throw new BridgeSecurityError('account_bridge_revoked');
    try {
      const parsedHead = z.object({ rootId: z.string().regex(/^[A-Za-z0-9_-]{43}$/), head: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        revision: z.number().int().min(0).max(ACCOUNT_TRUST_LIMITS.maxTransitions) }).strict().parse(head);
      const history = await this.options.readAccountHistory(this.accountAbort.signal);
      if (!history) throw new BridgeSecurityError('account_approval_required');
      if (this.closed) throw new BridgeSecurityError('account_storage_unavailable');
      const result = await this.adoptFetched(history, () => this.policy.applyAccountRead(history, { actor, head: parsedHead }));
      this.emitRevoked(result.revoked);
      return result.head;
    } catch (error) {
      if (error instanceof AccountReadUnavailable) throw new BridgeSecurityError('account_storage_unavailable');
      if (error instanceof AccountBridgeRevoked) {
        throw new BridgeSecurityError(await this.confirmRevocationEvidence(error.evidence) ? 'account_bridge_revoked' : 'account_storage_unavailable');
      }
      throw this.accountFailure(error);
    }
  }
  onRevoked(listener: (endpointId: string) => void): () => void { this.revoked.add(listener); return () => this.revoked.delete(listener); }
  /** Fires at most once per instance, only on signed proof that this bridge was revoked. */
  onBridgeRevoked(listener: () => void): () => void {
    this.bridgeRevokedListeners.add(listener);
    // Startup may emit before the caller subscribes; a late listener still hears it, asynchronously.
    if (this.bridgeRevokedEmitted) queueMicrotask(() => { if (this.bridgeRevokedListeners.has(listener)) this.notifyBridgeRevoked(listener); });
    return () => { this.bridgeRevokedListeners.delete(listener); };
  }
  async close(): Promise<void> {
    this.closed = true; this.accountAbort.abort();
    this.accountTrigger?.dispose(); this.accountTrigger = null;
    if (this.accountTimer) clearTimeout(this.accountTimer);
    this.accountTimer = null;
    await this.accountRefresh?.catch(() => undefined);
    this.revoked.clear(); this.bridgeRevokedListeners.clear(); this.replay.clear(); await this.policy.close();
  }
}
