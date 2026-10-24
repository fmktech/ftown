import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { open, seal, parseSecureEnvelope } from '../crypto.js';
import type { ApplicationJson, ApplicationRoute, ApprovedEndpoint, BridgeInvitation, BridgeSecurity, EndpointIdentity, EnrollmentPacket,
  InboundTransportContext, InvitationOptions, LocalRecoveryAuthority, McpActionContext, McpApproval, McpBridgeApproval,
  SecureApplication, SecureEnvelope, SecurePublication, VerifiedApplication, VerifiedPrincipal } from '../protocol.js';
import { BridgePolicyStore, type PolicyOptions } from './policy.js';
import { BridgeAuditStore } from './audit.js';
import { BridgeSecurityError } from './errors.js';
import { classifyCommand, classifyHttp, classifyTerminal, type OperationPermission } from './permissions.js';
import { endpointSchema } from './metadata.js';

const token = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const actionSchema = z.object({ actionId: token, parentActionId: token.nullable(), clientId: token, grantId: token,
  tool: z.string().max(200), operation: z.string().max(200).nullable() }).strict();
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
export interface BridgeSecurityOptions extends PolicyOptions { relayUserId: string; browserOrigin?: string }

export class BridgeSecurityService implements BridgeSecurity {
  readonly endpoint;
  readonly receiverEpoch = randomUUID();
  readonly policy: BridgePolicyStore;
  readonly audit: BridgeAuditStore;
  private readonly now: () => number;
  private readonly replay = new Map<string, number>();
  private readonly revoked = new Set<(endpointId: string) => void>();
  private readonly admissions = new Map<string, string>();
  private readonly verified = new WeakSet<VerifiedApplication>();
  private closed = false;
  constructor(readonly identity: EndpointIdentity, readonly bridgeId: string, dataDir: string, readonly options: BridgeSecurityOptions) {
    this.endpoint = identity.endpoint; this.now = options.now ?? Date.now;
    this.policy = new BridgePolicyStore(dataDir, bridgeId, this.endpoint, options);
    this.audit = new BridgeAuditStore(dataDir, this.endpoint.ownerId, bridgeId, options);
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
      const wrapper = z.object({ type: z.literal('ftown_enrollment'), version: z.literal(1), candidate: endpointSchema, envelope: z.unknown() }).strict().parse(packet);
      const envelope = parseSecureEnvelope(wrapper.envelope);
      if (envelope.purpose !== 'enroll') throw new BridgeSecurityError('wrong_context');
      this.freshness(envelope, false);
      const message = z.object({ type: z.literal('enroll'), candidate: endpointSchema, invitationId: z.string().uuid(),
        invitationSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), label: z.string().max(200) }).strict().parse(await this.decode(wrapper.candidate, envelope, route));
      if (JSON.stringify(message.candidate) !== JSON.stringify(wrapper.candidate)) throw new BridgeSecurityError('wrong_context');
      const approved = await this.policy.consumeInvitation(message);
      return this.reply(approved.endpoint, 'enrolled', { type: 'enrolled', invitationId: message.invitationId, approved, receiverEpoch: this.receiverEpoch }, route, envelope.messageId);
    }
    const envelope = parseSecureEnvelope(packet);
    if (envelope.purpose !== 'hello') throw new BridgeSecurityError('wrong_context');
    this.freshness(envelope, false);
    const principal = await this.policy.principal(envelope.senderId, true);
    const hello = z.object({ type: z.literal('hello'), challenge: token }).strict().parse(await this.decode(principal.endpoint, envelope, route));
    return this.reply(principal.endpoint, 'welcome', { type: 'welcome', challenge: hello.challenge, receiverEpoch: this.receiverEpoch }, route, envelope.messageId);
  }
  private parseApplication(value: unknown): SecureApplication {
    const parsed = z.object({ type: z.literal('application'), route: routeSchema, data: z.unknown(), mcp: actionSchema.nullable() }).strict().parse(value);
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
  private async admission(envelope: SecureEnvelope, principal: VerifiedPrincipal, app: SecureApplication, operation: OperationPermission): Promise<void> {
    if (principal.endpoint.kind !== 'mcp') {
      if (app.mcp !== null) throw new BridgeSecurityError('permission_denied');
      return;
    }
    const context: McpActionContext | null = app.mcp;
    if (!context || context.grantId !== principal.grantId) throw new BridgeSecurityError('wrong_context');
    const admitted = await this.audit.admit({ admissionId: envelope.messageId, ...context, endpointId: principal.endpoint.id,
      operation: operation.operation, sessionId: operation.sessionId, mutating: operation.mutating });
    if (!admitted.isNew) throw new BridgeSecurityError('replayed');
    this.admissions.set(`${envelope.senderId}:${envelope.messageId}`, admitted.event.id);
  }
  async acceptApplication(packet: SecureEnvelope, route: InboundTransportContext): Promise<VerifiedApplication> {
    const envelope = parseSecureEnvelope(packet);
    if (envelope.purpose !== 'application') throw new BridgeSecurityError('wrong_context');
    const principal = await this.policy.principal(envelope.senderId, true);
    const app = this.parseApplication(await this.decode(principal.endpoint, envelope, route));
    if (app.route.kind === 'http') {
      const data = object(app.data);
      if (data.callerSessionId !== undefined && (principal.endpoint.kind !== 'local-cli'
        || typeof data.callerSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.callerSessionId))) throw new BridgeSecurityError('permission_denied');
    }
    this.freshness(envelope, true); this.claim(envelope);
    // Pending identities can do precisely this one bound operation; never generic application work.
    if (app.route.kind === 'command' && app.route.command === 'security_activate_mcp') {
      const data = object(app.data); const payload = object(data.payload ?? null);
      if (data.type !== app.route.command || data.requestId !== app.route.requestId || payload.bridgeId !== this.bridgeId
        || payload.grantId !== principal.grantId || principal.endpoint.kind !== 'mcp') throw new BridgeSecurityError('permission_denied');
      const message = { principal, envelope, application: app };
      this.verified.add(message); return message;
    }
    let operation: OperationPermission;
    try { operation = this.requirement(app, route); }
    catch (error) {
      if (principal.endpoint.kind === 'mcp' && app.mcp) {
        await this.admission(envelope, principal, app, { permission: 'control', mutating: true, operation: 'invalid_operation', sessionId: null });
        await this.complete({ principal, envelope, application: app }, 'rejected', 'permission_denied');
      }
      throw error;
    }
    await this.admission(envelope, principal, app, operation);
    try { await this.policy.revalidate(principal, operation.permission); }
    catch (error) { await this.complete({ principal, envelope, application: app }, 'rejected', 'permission_denied'); throw error; }
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
    // No sealed value leaves this method before both persistence steps have succeeded.
    await this.revokeEndpoint(message.principal, message.principal.endpoint.id);
    await this.complete(message, 'succeeded');
    this.verified.delete(message);
    return receipt;
  }
  async complete(message: VerifiedApplication, status: 'succeeded' | 'rejected' | 'failed' | 'unknown', errorCode: string | null = null): Promise<void> {
    const key = `${message.envelope.senderId}:${message.envelope.messageId}`;
    const admission = this.admissions.get(key);
    if (!admission) return;
    try { await this.audit.finish(admission, status, errorCode); this.admissions.delete(key); }
    catch { throw new BridgeSecurityError('outcome_unknown'); }
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
      catch (error) { if (!(error instanceof BridgeSecurityError) || !['endpoint_revoked', 'approval_required', 'expired'].includes(error.code)) throw error; }
    }
    return packets;
  }
  createInvitation(actor: VerifiedPrincipal | LocalRecoveryAuthority, options: InvitationOptions): Promise<BridgeInvitation> { return this.policy.createInvitation(actor, options); }
  listDevices(actor: VerifiedPrincipal): Promise<ApprovedEndpoint[]> { return this.policy.list(actor); }
  async approveMcp(actor: VerifiedPrincipal, approval: McpApproval): Promise<McpBridgeApproval> {
    const receipt = await this.policy.approveMcp(actor, approval);
    const envelope = await this.reply(approval.endpoint, 'mcp-approval', receipt, { transport: 'cloud', channel: `mcp-approval:${this.bridgeId}:${approval.requestId}`,
      bridgeId: this.bridgeId, pairId: null });
    return { bridgeId: this.bridgeId, bridge: this.endpoint, receipt: envelope };
  }
  activateMcp(actor: VerifiedPrincipal, grantId: string): Promise<{ grantId: string; expiresAt: string }> { return this.policy.activateMcp(actor, grantId); }
  async revokeEndpoint(actor: VerifiedPrincipal, endpointId: string): Promise<void> {
    await this.policy.revoke(actor, endpointId);
    for (const listener of this.revoked) listener(endpointId);
  }
  onRevoked(listener: (endpointId: string) => void): () => void { this.revoked.add(listener); return () => this.revoked.delete(listener); }
  async close(): Promise<void> { this.closed = true; this.revoked.clear(); this.replay.clear(); await this.audit.close(); await this.policy.close(); }
}
